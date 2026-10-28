// Offline scoring of captured calls. No provider requests and no inferred ground truth.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFacts, parseEvidence, parseVerdict, type EvidenceSpan } from "../src/judge.ts";
import { type Verdict } from "../src/plan-fork.ts";

export interface JudgeCapture {
	// Keep the exact model, system prompt, task and candidate subset: different inputs are not repeat trials.
	model: string;
	protocol: "facts-v1" | "evidence-v1" | "labels-v1";
	system: string;
	text: string;
	known: string[];
	evidence: EvidenceSpan[];
	meta: [string, { folded: boolean; locator: string | null }][];
	reply: string;
	// Annotate independently of the model. Omit when only repeatability is being measured.
	expected?: Record<string, Verdict[]>;
	ms?: number;
	costUsd?: number;
	usage?: { input?: number; output?: number; cacheRead?: number };
}

export function replayJudge(records: JudgeCapture[]) {
	const groups = new Map<string, { runs: Map<string, Verdict>[]; annotated: string }>();
	let annotated = 0, correct = 0, decisive = 0, falseCold = 0, cold = 0, failures = 0;
	let handles = 0, input = 0, output = 0, cacheRead = 0, costUsd = 0;
	const times: number[] = [];
	let usageReportedCalls = 0, costReportedCalls = 0;
	for (const r of records) {
		if (r.protocol !== "facts-v1" && r.protocol !== "evidence-v1" && r.protocol !== "labels-v1") throw new Error("Unknown judge capture protocol");
		const known = new Set(r.known);
		if (!known.size || known.size !== r.known.length) throw new Error("Capture must contain distinct submitted handles");
		if (Object.entries(r.expected ?? {}).some(([h, v]) => !known.has(h) || !v.length || v.some((x) => !["cold", "warm", "hot", "need"].includes(x)))) {
			throw new Error("Expected verdicts must label submitted handles with nonempty accepted sets");
		}
		const key = createHash("sha256").update(JSON.stringify([r.model, r.protocol, r.system, r.text, r.known, r.evidence, r.meta])).digest("hex");
		const annotation = JSON.stringify(Object.entries(r.expected ?? {}).sort(([a], [b]) => a.localeCompare(b)));
		const group = groups.get(key) ?? { runs: [], annotated: annotation };
		if (group.annotated !== annotation) throw new Error("Repeated input has inconsistent annotations");
		let verdicts: Map<string, Verdict>;
		try {
			const parse = r.protocol === "facts-v1" ? parseFacts : r.protocol === "evidence-v1" ? parseEvidence : parseVerdict;
			verdicts = parse(r.reply, known, r.evidence, new Map(r.meta)).verdicts;
		} catch {
			failures++;
			// Report the no-advice baseline separately from successful model output.
			verdicts = new Map([...known].map((h) => [h, "warm"]));
		}
		group.runs.push(verdicts); groups.set(key, group);
		for (const [h, accepted] of Object.entries(r.expected ?? {})) {
			const v = verdicts.get(h)!;
			annotated++; if (accepted.includes(v)) correct++;
			if (v !== "warm") decisive++;
			if (v === "cold") { cold++; if (!accepted.includes("cold")) falseCold++; }
		}
		handles += known.size;
		input += r.usage?.input ?? 0; output += r.usage?.output ?? 0; cacheRead += r.usage?.cacheRead ?? 0;
		costUsd += r.costUsd ?? 0;
		if (r.usage !== undefined) usageReportedCalls++;
		if (r.costUsd !== undefined) costReportedCalls++;
		if (r.ms !== undefined) times.push(r.ms);
	}
	let agreements = 0, pairs = 0;
	for (const { runs } of groups.values()) for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
		for (const [h, v] of runs[i]) { pairs++; if (runs[j].get(h) === v) agreements++; }
	}
	times.sort((a, b) => a - b);
	const quantile = (p: number) => times.length ? times[Math.ceil(p * times.length) - 1] : null;
	return {
		calls: records.length, snapshots: groups.size, submittedHandles: handles, failures,
		annotated, accuracy: annotated ? correct / annotated : null,
		decisiveCoverage: annotated ? decisive / annotated : null,
		falseCold, coldPredictions: cold, falseColdRate: cold ? falseCold / cold : null,
		pairwiseAgreement: pairs ? agreements / pairs : null, comparedHandlePairs: pairs,
		inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, costUsd,
		usageReportedCalls, costReportedCalls, latencyReportedCalls: times.length,
		p50Ms: quantile(0.5), p95Ms: quantile(0.95),
	};
}

if (import.meta.main) {
	if (!process.argv[2]) throw new Error("Usage: bun bench/judge-replay.ts captures.jsonl");
	const records = readFileSync(process.argv[2], "utf8").split("\n").filter((s) => s.trim()).map((s) => JSON.parse(s));
	console.log(JSON.stringify(replayJudge(records), null, 2));
}
