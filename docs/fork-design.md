# Fork planning and summary policy

These rules override the upstream rules in [design.md](design.md).

## Summary pressure and thresholds

The fork plans folding with the upstream 40K working target.
It folds the largest outputs in each protection class until context reaches that target.
Summary compaction uses two distinct pressure thresholds.
`PI_ZIP_SUMMARY_AT` overrides both gates when set.

1. **Preparation gate:** `min(0.8 * room, 140,339)`.
   The background worker starts preparing a checkpoint when context after folds reaches this value.
   On a 200K window, this value is 140,339 tokens (80% of window).
2. **Application gate:** `min(0.8 * room, 400,000)`.
   The active run applies the summary only after context reaches this value.
   On a 1M window, preparation starts at 140.3K, while application waits until 400K.
   A 500K model applies at ~380.3K.
   Models with 200K or 272K windows keep ~140.3K and ~197.9K thresholds.

A new checkpoint starts only when post-checkpoint context reaches the preparation gate again.
The new cut must also cover at least 35K additional tokens (one-quarter of the threshold).
A new cut identifier alone does not cause a prefix re-read.

## Model switches and rescue compaction

Pi checks its compaction threshold before each request, ahead of extension hooks.
When you switch to a smaller window, pi-zip resolves the pressure with minimal information loss:

1. **Folds only:** If folds alone fit within 90% of the new window, pi-zip cancels compaction.
   The next request carries the folded view.
2. **Ready checkpoint:** If a ready summary plus kept turns fits the window, pi-zip compacts only that prefix.
3. **Pending checkpoint:** If a checkpoint is currently running, pi-zip waits for it to finish.
4. **Immediate summary:** Otherwise, pi-zip summarizes the required cut immediately.
   The previous model reads the narrative when it has a larger window.
   If that call fails and the prefix fits, the new model reads the narrative.
5. **Rescue fold:** If the two protected turns exceed the window, the cut can extend to the current user message.
   Kept outputs fold largest-first.
   All folded originals remain recallable.
6. **Hard limit abort:** If the minimal summary and current request cannot fit the window, pi-zip aborts the run without deleting history.

A switch after Pi's check triggers the same abort sequence in the context hook.
A cold cache or model switch reduces rewrite cost, but does not trigger compaction when room remains.

## Lookup cue

Users can name an earlier output by its exact handle, full file path, or URL.
When this occurs, the first outgoing request carries a short note.
The note names up to three matching outputs.
It tells the model to call `zip_recall` instead of repeating the tool call.

- Matching is exact and requires no model calls.
- The check searches the session branch, including outputs removed by compaction.
- It runs without context pressure requirements and without the judge.
- Paths match only through their newest tool call.
- That call must not be an `edit` or `write`.
- The call must have returned at least 1,000 characters without errors.
- Edits or writes after a read disable cues for that path.
- Basenames, parent directories, and full outputs in view receive no note.
- The note does not persist in session history.
- Set `PI_ZIP_LOOKUP=0` to disable lookup cues.

## Background judge (`PI_ZIP_JUDGE=1`)

Enable the background judge by setting `PI_ZIP_JUDGE=1`.
The judge runs a background chat call to score candidate tool outputs.
It reports three factual values per candidate: `<handle> <active> <finished> <lookup>`.
Each value must be `Y`, `N`, or `U`.
The call includes no citations.

Code determines output priority from these facts:
- `lookup=Y` with an exact handle or path in recent work assigns `need` (if folded) or `hot` (if live).
- `active=Y` assigns `hot`, even if `finished=Y` or lookup validation fails.
- `N Y N` assigns `cold`.
- All other combinations, missing lines, and duplicates assign `warm`.
- Switching files, silence, or same-path calls do not prove `finished=Y`.

### Early cold eligibility

A valid `cold` label lowers protected-turn eligibility for non-error outputs to 10 assistant requests (from 60).
This policy is always active in the fork when you set `PI_ZIP_JUDGE=1`.
The ordinary in-turn age gate must also remain active.
All other safety rules stay intact:
- Recalls and recall outputs stay protected.
- The automatic-cache prefix remains unchanged.
- Re-read-only mode stays enforced.
- Minimum useful token savings still apply.

The planner ranks candidate folds: cold, warm, hot, then need.
The new plan must save at least as many tokens as the default plan.
Placeholders remain byte-identical.
Model thinking after a tool output never triggers early folding on its own.

### Judge runtime limits

- The judge uses models from Pi's registry with at most one concurrent call.
- The call has a 30-second timeout.
- Planning never waits for judge results.
- The call sends an explicit thinking level only when the model supports it.
- Copilot models on Responses API, or models with `off: null`, run at their lowest level above `off`.
- Changing the session discards verdicts.
- Ending a run, switching models, shutting down, or running `/zip off` cancels active calls.
- Failed calls keep existing valid verdicts until their 20-request expiration.
- A new user prompt invalidates the entire scope.
- Two consecutive provider or parse failures disable the judge for the rest of the run.

### Exact supersession

Code marks outputs `cold` through deterministic rules without model calls:
- A tool ran again with identical arguments.
- A later successful `edit` or `write` modified the target file.

Failed tool calls and reads of different file offsets do not supersede earlier outputs.
Deterministic supersession runs at every boundary and overrides model replies.

### Judge scheduling and gates

The judge scores candidates at `min(ordinary age, max(early age, judge age))`.
Calls require:
- Context pressure of at least 80%.
- At least five stale live candidates, or one stale cited folded output.
- A cooldown of eight requests, unless selected candidate growth reaches 10,000 characters.

The transport uses the `facts-v1` line protocol.
The system does not send provider-enforced schemas to chat endpoints.

## Narrative continuity and summary formats

The summary pipeline updates narrative state across compactions.
A narrative call receives at most 500 characters of previous active state.
It must keep open work unless the slice shows completion.
The call outputs open tasks as `- [ ]` lines.
If the call omits the active section, the system keeps the previous state.

### Format v2 (`PI_ZIP_SUMMARY_V2=1`)

Format v2 appends conversation slices into durable epochs.
Each epoch stores user requests (`R<n>`), findings, assistant commitments, and tool evidence.
- The model merges prose sections.
- Code joins requests, evidence records, and omission counts.
- Late tool results bind to their originating call via execution identifiers.
- Pi skill expansions show as `/skill:name` plus trailing user text.
  The narrative call reads the expanded skill body.
- Code saves assistant commitments in `COMMITMENTS` lines with exact quotes.
- Code keeps up to eight tool outputs as `EVIDENCE` quotes.
- Soft budgeting drops evidence in order: file write confirmations, ordinary observations, then old errors.
- Hard room limits drop unselected evidence, selected evidence, commitments, intent quotes, old prose, then active state.
- If requests exceed room, emergency water-filling (E1) shortens long requests to head and tail excerpts.
- If minimal excerpts still exceed room, the summary fails with `request-budget-overflow`.

### Format v3 (default)

Format v3 replaces growing epoch history with a bounded five-section digest:
1. Architecture
2. Settled decisions
3. Discarded approaches
4. Test health
5. Open work

Items use stable numbers (`- [i12]`).
The narrative call emits delta operations only: `ADD`, `EDIT`, `MOVE`, and `DROP iN: reason`.
Code retains any item not named in the model response.
Intent quotes link directly to digest items (`about i37`).
Evidence includes only items selected by the model or named in the digest.
The newest substantive requests remain verbatim.
Older requests become digested ranges once verified in the raw branch.
Short go-ahead requests fold into compact ranges based on model judgment.
Summaries exceeding target room emit a minimal summary and log `overRoom`.
Format v3 never fails with `request-budget-overflow`.

## Shell commands and production costs

Code marks direct `diff` and `git diff` commands that exit with code 1 as `differences (exit 1)` instead of errors.
Compound commands with nonzero exits remain classified as errors.

The production cost gate reserves funds for:
- Tier merges.
- The narrative call.
- Active-state input.

Reasoning models receive `PI_ZIP_SUM_MERGE_REASONING_TOKENS` (default 4,096) extra tokens per merge call.
The system logs predicted and actual costs in `summary_merge_cost` records.
