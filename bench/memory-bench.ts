// Session-memory measurements (POC).
//
//   bun bench/memory-bench.ts index <session.jsonl>...
//     Per session: initial backfill time, DB size, counts and indexed coverage, and incremental-vs-rebuild equivalence (the session
//     projected in four batches must equal one clean rebuild). Works on copies in a temp dir; the session files are only read.
//
//   bun bench/memory-bench.ts report <pi-zip log>...
//     Retrieval summary from pi-zip's per-session logs (~/.pi/agent/pi-zip/logs/<session>.log by default): retrieval decisions and
//     skips, model calls, latency and cost, injected notes, and zip_recall use. Compare runs with the same tasks on the same histories
//     with folding on (memory active) and with pi-zip off (baseline).
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, logicalDump } from "../src/ledger/projector.ts";

const [cmd, ...files] = process.argv.slice(2);

function readJsonl(file: string) {
	const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
	const parsed: unknown[] = [];
	let bad = 0;
	for (const l of lines) {
		try { parsed.push(JSON.parse(l)); } catch { bad++; } // a partial trailing line is reported, never repaired
	}
	const header = parsed[0] as { type?: string; id?: string } | undefined;
	if (header?.type !== "session") throw new Error(`${file}: no session header`);
	return { header, entries: parsed.slice(1) as Array<{ id?: string }>, bad };
}

function index(file: string) {
	const { header, entries, bad } = readJsonl(file);
	if (entries.some((e) => typeof e.id !== "string")) throw new Error(`${file}: entries without ids (an older session format; open it in Pi once to migrate)`);
	const dir = mkdtempSync(join(tmpdir(), "pi-zip-bench-"));
	const src = { sessionId: String(header.id), file, header, entries };
	const clean = Ledger.open(src, join(dir, "clean.sqlite"));
	const r = clean.reconcile(src);
	const counts = clean.counts(entries.length);
	const inc = Ledger.open(src, join(dir, "inc.sqlite"));
	const cuts = [0.25, 0.5, 0.75, 1].map((f) => Math.round(entries.length * f));
	const t0 = performance.now();
	inc.reconcile({ ...src, entries: entries.slice(0, cuts[0]) });
	for (const c of cuts.slice(1)) inc.catchUp({ ...src, entries: entries.slice(0, c) });
	const incMs = performance.now() - t0;
	const equal = JSON.stringify(logicalDump(inc.db)) === JSON.stringify(logicalDump(clean.db));
	clean.close(); // the last connection checkpoints the WAL into the file
	inc.close();
	const size = statSync(join(dir, "clean.sqlite")).size;
	console.log(JSON.stringify({ file, entries: entries.length, badLines: bad, backfillMs: Math.round(r.ms), incrementalMs: Math.round(incMs), dbBytes: size, ...counts,
		coverage: counts.rawChars ? +(counts.indexedChars / counts.rawChars).toFixed(4) : 1, incrementalEqualsRebuild: equal }));
}

function report(file: string) {
	const recs = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
	const ret = recs.filter((r) => r.type === "memory_retrieval");
	const calls = ret.flatMap((r) => r.calls ?? []);
	const by = (k: string) => ret.reduce((m: Record<string, number>, r) => ((m[String(r[k] ?? "-")] = (m[String(r[k] ?? "-")] ?? 0) + 1), m), {});
	const stage = (xs: number[]) => median(xs.filter((x) => typeof x === "number"));
	const ev = ret.flatMap((r) => r.evidence ?? []);
	const ranked = ev.filter((e) => e.cited).length;
	const found = ev.length;
	console.log(JSON.stringify({
		file,
		prompts: ret.length,
		stages: by("stage"),
		notes: ret.filter((r) => r.chars).length,
		injectedRuns: recs.filter((r) => r.type === "memory_inject").length,
		answerCalls: calls.filter((c: { step: string }) => c.step === "answer").length,
		callErrors: calls.filter((c: { error?: string }) => c.error).length,
		retrievalMsMedian: stage(ret.map((r) => r.ms)),
		searchMsMedian: stage(ret.map((r) => r.latency?.search)),
		answerMsMedian: stage(ret.map((r) => r.latency?.answer)),
		evidenceCharsMedian: stage(ret.map((r) => (r.input?.evidenceChars ? r.input.evidenceChars : undefined))),
		citedPerFinding: found ? +(ev.filter((e) => e.cited).length / Math.max(1, ret.filter((r) => r.findings).length)).toFixed(2) : null,
		candidateUseRate: found ? +(ranked / found).toFixed(2) : null,
		drops: ret.reduce((m: Record<string, number>, r) => {
			for (const [k, v] of Object.entries(r.drops ?? {})) if (typeof v === "number" && v) m[k] = (m[k] ?? 0) + v;
			return m;
		}, {}),
		retrievalCostUsd: +calls.reduce((n: number, c: { costUsd?: number }) => n + (c.costUsd ?? 0), 0).toFixed(4),
		backfills: recs.filter((r) => r.type === "memory_backfill").map((r) => ({ reconcile: r.reconcile, entries: r.entries, ms: r.ms, done: r.done })),
		recallCalls: recs.filter((r) => r.type === "recall").length,
		memoryErrors: recs.filter((r) => r.type === "error" && String(r.where).startsWith("memory")).length,
	}));
}

function median(xs: number[]) {
	const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
}

if (cmd === "index" && files.length) files.forEach(index);
else if (cmd === "report" && files.length) files.forEach(report);
else console.error("usage: bun bench/memory-bench.ts index <session.jsonl>... | report <pi-zip log>...");
