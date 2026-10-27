# Retrieval latency probe

Run offline against explicit Pi session snapshots:

```sh
bun bench/retrieval-latency.ts /path/to/session.jsonl [more-session.jsonl ...] > latency.json
```

The script projects each session into a fresh in-memory ledger, uses its active branch as fully hidden, and measures warm-cache calls with no LLM or network. This is a latency stress scope, not historical-need labels or an answer-quality evaluation. It does not modify the source sessions.

## Recorded local run

Command:

```sh
bun bench/retrieval-latency.ts .local-probe/run-007/sources/*.jsonl > .local-probe/round2-retrieval/latency.json
```

Bun 1.4.2; `process.version` reports v26.3.0. Twenty real session snapshots, 8,181 source entries, 14,401 indexed documents total (33–1,712 documents per session). The JSON records input SHA-256 hashes, projection counts, eligible-entry counts and matching chunks. Fifteen measured calls per session/mode after three warmups; execution order rotates for the FTS comparison. Percentiles below pool 300 calls per mode, using nearest rank.

### Common-term FTS (p95, milliseconds)

| Query | Direct LIMIT, no diversity | Previous cap, text carried through sort | ID/score-only sort, same per-entry cap |
|---|---:|---:|---:|
| `test` | 1.37 | 1.93 | 1.28 |
| `error` | 0.80 | 1.10 | 0.74 |

The capped variants keep at most three chunks per entry before LIMIT 400. The direct-LIMIT control does not prevent chunk starvation and is not a replacement for the cap. The new query ranks IDs and scores, applies the per-entry cap and global limit, then fetches the selected text. This reduces work per matching row without limiting the input rows before diversity is applied.

### Full `queryOf` + `retrieve` (p95, milliseconds)

Each prompt contains generated code identifiers plus an explicit file reference from that session and a final symbol request. Both fenced code and unfenced pasted code are measured.

| Identifiers | Unfenced | Fenced |
|---|---:|---:|
| 100 | 14.67 | 14.76 |
| 1,000 | 16.13 | 15.07 |

The hard lookup budget is six distinct paths plus six distinct symbols, also enforced for manually constructed Query objects. Traversal stops at 30 distinct graph chunks. Runtime still includes linear prompt parsing, source-scope construction and the ordinary FTS query.

## Verification limits

These results are local warm-cache measurements, not production latency guarantees. The largest sample has 1,712 indexed documents, not 10,000 matching chunks in one session; the measured common-term matches range up to 217 chunks. Cold disk I/O, native Windows execution, provider latency and much larger individual sessions are not measured. Windows separator compatibility is tested using legacy Windows canonical keys in SQLite on Linux.
