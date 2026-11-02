// Small live contrastive check of the answer selector, not an estimate of production precision.
// Usage: bun bench/retrieval-relevance.ts provider/model /tmp/relevance-results.json
// Sends only the synthetic fixtures; uses the configured model runtime and makes billed calls.
import { writeFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fixtures from "../test/fixtures/retrieval-relevance.json";
import { RetrievalConversation } from "../src/retrieval/assistant.ts";
import { handleFor } from "../src/fold-format.ts";
import type { Evidence } from "../src/retrieval/search.ts";

const [ref, output] = process.argv.slice(2);
if (!ref || !output) throw new Error("Usage: bun bench/retrieval-relevance.ts provider/model output.json");
const runtime = await ModelRuntime.create();
const model = (await runtime.getAvailable()).find((m) => `${m.provider}/${m.id}` === ref);
if (!model) throw new Error(`Unavailable model: ${ref}`);
process.env.PI_ZIP_JUDGE_MODEL = ref;
const rows = [];
for (const f of fixtures) {
	const evidence: Evidence[] = f.evidence.map((e, i) => ({
		ref: e.ref, handle: handleFor(`${f.id}-${e.ref}`), entryId: `${f.id}-${e.ref}`,
		hidden: "folded", kind: "tool_result", tool: "bash", title: "earlier recorded output", excerpt: e.text,
		outcome: "", isError: false, folded: true, matched: 1, exact: false, context: [], seq: i, at: 0,
	}));
	const conv = new RetrievalConversation({ model, modelRegistry: runtime });
	const packet = await conv.answer(f.prompt, f.recent, evidence, f.id, "fixture");
	const selected = conv.decisions.filter((d) => d.need === "Y").map((d) => d.ref).sort();
	const cited = new Set([...(packet?.findings.flatMap((x) => x.sourceHandles) ?? []), ...(packet?.foldedCandidates.map((x) => x.handle) ?? [])]);
	const delivered = evidence.filter((e) => cited.has(e.handle)).map((e) => e.ref).sort();
	const expected = [...f.expected].sort();
	const passed = packet !== null && JSON.stringify(selected) === JSON.stringify(expected) && JSON.stringify(delivered) === JSON.stringify(expected);
	rows.push({ id: f.id, expected, selected, delivered, passed, decisions: conv.decisions, packet, calls: conv.calls });
	console.log(`${passed ? "PASS" : "FAIL"} ${f.id}: expected=${expected.join(",") || "none"} selected=${selected.join(",") || "none"}`);
}
const result = { model: ref, at: new Date().toISOString(), passed: rows.filter((r) => r.passed).length, total: rows.length,
	costUsd: rows.reduce((n, r) => n + r.calls.reduce((m, c) => m + c.costUsd, 0), 0),
	limits: "Eight agent-authored synthetic contrasts, single sample each; no production accuracy claim.", rows };
writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ passed: result.passed, total: result.total, costUsd: result.costUsd, output }));
if (result.passed !== result.total) process.exitCode = 1;
