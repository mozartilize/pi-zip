# Fork features

This fork extends upstream pi-zip.
Upstream documentation describes base behavior.
This document describes the fork's additions, overrides, and configurations.
See [UPSTREAM.md](../UPSTREAM.md) for module boundaries and sync procedures.

## Summary formats

The fork generates only format v2 and format v3 summaries.
Format v3 is the default format.
Set `PI_ZIP_SUMMARY_V2=1` to select format v2 instead.
Existing upstream summaries, fork-v1, v2, v3, and native Pi summaries remain readable.

`src/summary-engine.ts` dispatches summaries and extends the parser.
Shared parsing, serialization, and provider calls come from `src/summary.ts`.
The runtime class is `ZipFork` in `src/run-fork.ts`, extending upstream `Zip`.

### Format v3: State digest (Default)

Format v3 maintains a bounded state digest instead of appending growing histories.
It organises information into five numbered sections:
1. Architecture
2. Settled decisions
3. Discarded approaches
4. Test health
5. Open work

Items use stable numbers (`- [i12]`).
One narrative model call reads the previous digest, intent quotes, and the new conversation slice.
The call returns delta operations only:
- `ADD iN: text`
- `EDIT iN: text`
- `MOVE iN: section`
- `DROP iN: reason`

Code retains any item that the model does not name.
This rule ensures that items are not lost if the model forgets them.
A drop operation without a reason has no effect.

Section size limits:
- Decisions: 6,000 characters
- Tests: 800 characters
- Other sections: 2,000 characters

When a section exceeds its limit, the prompt adds an `OVER BUDGET` warning.
The model then attempts to merge items.
Code drops nothing for size until context reaches the hard room limit.
A failed call keeps the previous digest and marks it `possibly stale`.

#### Requests in format v3

- At least 8 recent substantive requests remain verbatim (`PI_ZIP_SUM_V3_RECENT_REQUESTS`).
- Older requests return newest-first if room remains.
- Requests exceeding available room become `digested` ranges when verified against the raw branch.
- Short requests containing only approvals or acknowledgements become `go-ahead only` ranges based on model judgment.
  Requests over 200 characters never fold into go-ahead ranges.
- All ranges remain recallable using `zip_recall({ requests: "M-N" })`.

#### Intent, evidence, and room limits

- **Intent:** Quotes must match exact NFC spans from raw branch requests.
  Each quote can link to a digest item (`- R183 · source … · about i37`).
- **Evidence:** The summary lists up to 20 outputs that the model selected (`PI_ZIP_SUM_V3_SELECT_EVIDENCE`), or outputs named in the digest.
  Other outputs remain recallable by grep.
- **Room target:** The summary targets at most 8,000 tokens (`PI_ZIP_SUM_V3_TARGET`).
- **Hard room:** When context reaches the limit, code drops items in order:
  evidence, oldest resident requests, intent quotes, digest sections, then request excerpts.
  Format v3 never fails with `request-budget-overflow`.
  It logs `overRoom` if the minimal summary exceeds the target limit.

### Format v2: Verbatim requests and epochs

Format v2 appends one epoch per compaction and keeps user requests verbatim by default.
Requests use 1-based raw branch numbers (`R<n>`).
Pi skill expansions compress to `/skill:name` plus user text in summary rows.
The narrative call still reads the full expanded skill text.

When context exceeds the room limit, request text compresses in two deterministic steps:
1. **E1 (Excerpts):** Long requests keep head (2/3) and tail (1/3) excerpts of at least 200 characters.
   Short requests remain whole.
2. **E2 (Archived ranges):** If excerpts do not fit, older verified epochs convert to compact ranges (`R1–R15 archived, not resident`).
   The newest request-bearing epoch always stays resident.
   The next compaction restores raw requests if available.

If minimal representations still exceed room, the cut fails with `request-budget-overflow`.

## Folding and recovery policy

- The working target remains 40K tokens.
- Summary preparation starts at `min(0.8 * room, 140,339.2)`.
- Summary application starts at `min(0.8 * room, 400,000)`.
- `PI_ZIP_SUMMARY_AT` overrides both thresholds.
- When switching to a smaller window, pi-zip tries folds, then checkpoints, then an immediate cut.
  If the current request cannot fit, pi-zip stops the run without deleting history.
- Placeholders include a UTC timestamp of the newest message in their planned view.
- Directory paths in commands use stable aliases.

See [fork-design.md](fork-design.md) for complete planning formulas.

## Extended recall

The fork adds extended parameters to the `zip_recall` tool:

```ts
zip_recall({ requests: "20-41" })                 // Read raw request range
zip_recall({ grep: "pattern", scope: "all" })       // Search all history
zip_recall({ grep: "decision", scope: "assistant" }) // Search visible assistant prose
zip_recall({})                                     // Wait for pending retrieval findings
```

- Request numbers use 1-based raw branch indexing.
- Assistant recall returns visible text only, not private thinking.
- Calling `zip_recall` without arguments waits for background retrieval results.
- In file-only mode, `requests.txt` supplies the request ledger.
- A failed or unanswered recall does not mark an output as recalled.

## Structured session ledger

The fork writes detailed event records to `~/.pi/agent/pi-zip/logs/<session>.log`.
Set `PI_ZIP_LEDGER=/path/to/file` to change the file path, or `PI_ZIP_LEDGER=off` to disable it.
Files larger than 8 MB rotate to `<name>.1` on session startup.

Ledger record types:
- `judge_skip`: Explains why a judge call did not run (pressure, cadence, or small batch).
- `judge`: Records submitted handles, age gates, stream chunks, and fact verdicts.
- `law.foldDecision`: Records candidate groups, eligibility reasons, and cost-benefit decisions.
- `fold`: Confirms committed folds with savings and verdict metadata.

## Lookup cues

When a prompt references an earlier output handle, file path, or URL, pi-zip injects a short note.
The note names up to three matching outputs.
It reminds the model to call `zip_recall` instead of re-running the tool.
The match requires no model calls.
Set `PI_ZIP_LOOKUP=0` to disable lookup cues.

## Session memory and retrieval

The fork maintains a SQLite database (`<session>.memory.sqlite`) next to the session file.
`PI_ZIP_MEMORY_DIR` changes the storage directory.
The database provides historical retrieval when context leaves the active window.

Key memory properties:
- **Zero injection during full view:** Retrieval runs only after outputs fold or compact out of view.
- **Deterministic storage:** FTS5 indexes text from user, assistant, thinking, and tool blocks.
  Graph edges connect calls to results and requests to steps.
- **Session-local:** The indexer processes only the active session, up to 500 entries per batch.
- **Background planning:** A background call splits new prompts into sub-questions across four facets (what, why, how, when).
- **Fast local search:** While the planner runs, local keyword search runs immediately as a fallback.
- **Graph traversal:** Prompts with paths or symbols query up to 6 paths and 6 symbols across the referential graph.
- **Candidate pool:** The candidate count scales as `min(32, ceil(8 * sqrt(T)))` for `T` topics.
- **Input packing:** The answer call receives at most 48,000 characters of evidence.
- **Background delivery:** An initial pending note alerts the model that retrieval is running.
  Findings append to the next message once ready, or return immediately via `zip_recall({})`.

Configuration:
- `PI_ZIP_JUDGE_MODEL`: Model used for memory planner and answer calls.
- `PI_ZIP_RETRIEVAL_TIMEOUT_MS`: Call timeout in milliseconds (default: 20000).
- `PI_ZIP_RETRIEVAL_MIN_HITS`: Minimum FTS hits needed to run answer calls (default: 11).
- `PI_ZIP_MEMORY_TRACE=0`: Disables raw reply logging in the ledger.

Run `npm run index <session.jsonl>...` to build or inspect the memory database offline.

## Optional background judge

Set `PI_ZIP_JUDGE=1` to enable the background output classifier (disabled by default).
The judge classifies tool outputs to optimize folding order.

- **Model selection:** Set `PI_ZIP_JUDGE_MODEL=provider/id:level` (e.g. `github-copilot/gpt-6-luna:low`).
  If unset, pi-zip selects the cheapest model on the current provider with a 32K window.
- **Output tokens:** `PI_ZIP_JUDGE_MAX_TOKENS=16384` caps output tokens, including thinking.
- **Age gate:** `PI_ZIP_JUDGE_AGE=10` sets the minimum age for scoring live outputs.
- **Facts protocol:** The model answers `<handle> <active> <finished> <lookup>` with `Y`, `N`, or `U`.
- **Priority calculation:**
  - `lookup=Y` sets `need` (if folded) or `hot` (if live).
  - `active=Y` sets `hot`.
  - `N Y N` sets `cold`.
  - Other combinations set `warm`.
- **Early folding:** Valid `cold` verdicts allow non-error outputs to fold at age 10 instead of 60.
- **Deterministic supersession:** Outputs superseded by identical calls or later file edits become `cold` without model calls.
- **Failure handling:** Two consecutive failures disable the judge for the rest of the run.
  Verdicts expire after 20 requests.

Run offline evaluation using `bun bench/judge-replay.ts /path/to/captures.jsonl`.
See [judge-replay.md](judge-replay.md) for details.
