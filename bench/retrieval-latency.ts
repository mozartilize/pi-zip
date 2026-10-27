// Offline, warm-cache latency probe. Usage: bun bench/retrieval-latency.ts <session.jsonl> [...]
// Uses actual session text, but treats the active branch as fully hidden (a stress scope, not retrieval-quality labels).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ftsSearchScoped, matchExpr, setSearchScope } from "../src/ledger/fts.ts";
import { Ledger } from "../src/ledger/projector.ts";
import { conclusionsOf, queryOf, retrieve, type Scope } from "../src/retrieval/search.ts";

const files = process.argv.slice(2);
assert(files.length, "Pass explicit session JSONL paths; no session discovery is performed.");
const repeats = 15, warmup = 3;
const samples: Record<string, number[]> = {};
const sessions: object[] = [];
const record = (name: string, elapsed: number) => (samples[name] ??= []).push(elapsed);
const summary = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return { n: values.length, p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};

for (const file of files) {
	const bytes = readFileSync(file);
	const rows = bytes.toString().trim().split("\n").map((line) => JSON.parse(line));
	const header = rows.find((r) => r.type === "session");
	assert(header?.id, "session header missing");
	const entries = rows.filter((r) => typeof r.id === "string" && r.type !== "session");
	const byId = new Map(entries.map((e) => [e.id, e]));
	const branch = [];
	for (let e = entries.at(-1); e; e = byId.get(e.parentId)) branch.unshift(e);
	const scope: Scope = {
		branch: new Set(branch.map((e) => e.id)), visible: new Set(), folded: new Set(), compacted: true,
		hidden: new Map(branch.map((e) => [e.id, "compacted" as const])), conclusions: conclusionsOf(branch), entry: (id) => byId.get(id),
	};
	const ledger = Ledger.open({ file, sessionId: header.id, header, entries }, ":memory:");
	try {
		ledger.reconcile({ file, sessionId: header.id, header, entries });
		const db = ledger.db;
		const eligible = branch.filter((e) => e.message?.role === "toolResult" || scope.conclusions.has(e.id)).map((e) => e.id);
		setSearchScope(db, eligible);
		const kinds = ["assistant", "tool_result"];
		// The pre-fix query: carries all text fields through the window sort, before the outer LIMIT.
		const oldCap = (match: string) => db.prepare(`
		 SELECT * FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.entry_id ORDER BY x.rank) AS per_entry FROM (
		  SELECT d.id, d.object_type, d.object_id, d.entry_id, d.block_index, d.chunk_index, d.char_start, d.segment_id, d.kind, d.tool, d.is_error,
		   d.title, d.body, d.identifiers, d.seq, bm25(search_fts, 10.0, 3.0, 1.0, 12.0) AS rank
		  FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid JOIN search_scope s ON s.entry_id = d.entry_id
		  WHERE search_fts MATCH ? AND d.object_type = 'chunk' AND d.kind IN ('assistant', 'tool_result')
		 ) x) WHERE per_entry <= 3 ORDER BY rank LIMIT 400`).all(match);
		const matching: Record<string, unknown> = {};
		for (const term of ["test", "error"]) {
			const match = matchExpr([term])!;
			matching[term] = db.prepare(`SELECT count(*) AS n FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid
			 JOIN search_scope s ON s.entry_id = d.entry_id WHERE search_fts MATCH ? AND d.object_type = 'chunk'
			 AND d.kind IN ('assistant', 'tool_result')`).get(match)!.n;
			const modes = [
				["direct-limit", () => ftsSearchScoped(db, match, 400, kinds)],
				["old-wide-cap", () => oldCap(match)],
				["narrow-cap", () => ftsSearchScoped(db, match, 400, kinds, 3)],
			] as const;
			for (let i = -warmup; i < repeats; i++) {
				// Rotate execution order to avoid consistently giving one mode the warmest cache.
				for (let offset = 0; offset < modes.length; offset++) {
					const [mode, run] = modes[(i + warmup + offset) % modes.length];
					const start = performance.now();
					const hits = run();
					if (i >= 0) record(`fts/${term}/${mode}`, performance.now() - start);
					assert(hits.length <= 400);
					if (mode !== "direct-limit") {
						const perEntry = new Map();
						for (const h of hits) perEntry.set(h.entry_id, (perEntry.get(h.entry_id) ?? 0) + 1);
						assert([...perEntry.values()].every((n) => n <= 3));
					}
				}
			}
		}
		const path = String(db.prepare("SELECT canonical_key FROM nodes WHERE kind = 'file' ORDER BY first_seen_seq LIMIT 1").get()?.canonical_key ?? "src/missing.ts");
		for (const size of [100, 1000]) {
			const code = Array.from({ length: size }, (_, i) => `const noise_symbol_${i} = ${i};`).join("\n");
			for (const fenced of [false, true]) {
				const prompt = (fenced ? `\`\`\`ts\n${code}\n\`\`\`` : code) + `\nCheck @${path} and getUserId again.`;
				for (let i = -warmup; i < repeats; i++) {
					const start = performance.now();
					const found = retrieve(db, queryOf(prompt), scope);
					if (i >= 0) record(`retrieve/${size}-identifiers/${fenced ? "fenced" : "plain"}`, performance.now() - start);
					assert(found.evidence.length <= 8);
				}
			}
		}
		sessions.push({ sha256: createHash("sha256").update(bytes).digest("hex"), counts: ledger.counts(entries.length), eligible_entries: eligible.length, matching });
	} finally {
		ledger.close();
	}
}
console.log(JSON.stringify({ runtime: process.version, repeats, warmup, scope: "active branch fully hidden; warm in-memory ledger; no LLM/network", sessions,
	timings: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summary(values)])) }, null, 2));
