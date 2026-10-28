# pi-zip

Keeps long [Pi](https://github.com/earendil-works/pi) sessions cheap without losing anything.

pi-zip keeps recent work in full, folds older tool output and summarises older history when the savings pay for the cache rewrite. Summaries are prepared in the background, and hidden originals can be fetched back byte for byte. No configuration, no proxy process, no footer.

## Install

```bash
pi install npm:pi-zip
# or
pi install git:github.com/purboo/pi-zip
```

Try it for one run without installing: `pi -e npm:pi-zip`.

## How it works

- **Fold.** An old tool output (a test run, a file read, a command) is replaced by a short placeholder: what produced it, its size, its key lines and a handle. The original stays in the session file, and the model gets it back byte for byte with `zip_recall`.
- **Summarise.** When folding still leaves the context near the active model's compaction limit (`min(80% of Pi's safe room, 400K tokens)` by default; on larger windows a background checkpoint is prepared from `min(80% of room, ~140K)` without being applied, so a switch to a 200K/272K model can replace only that prefix; when no checkpoint fits, pi-zip folds what is needed or writes the needed summary at the switch, and stops the run if the summary retention contract plus kept suffix still cannot fit the new window), older history is replaced by one summary, written in the background while you work or are away. It quotes your first and newest requests word for word and indexes earlier outputs by handle; recall can still search every one of them.
- **Only when it pays.** Every edit makes the provider rewrite its prompt cache. pi-zip edits only when the expected savings beat that rewrite plus the summary call: freely once the cache has expired (you were away), rarely while it is warm.
- **Learned, not configured.** How long your provider really keeps its cache, how fast the context grows, the real token count and how long a summary takes are all measured from the session as you work.
- **Recent work stays.** Your current and previous prompt are never summarised, and their outputs stay in full unless they are 60 or more requests old, or can simply be re-read after a pause.
- **Nothing is lost, nobody waits.** Session entries are only appended, never deleted. Only tool outputs are folded: your messages, tool-call arguments and thinking change only when a summary replaces older history, and the system prompt and tool definitions never change. The only wait left is near Pi's own compaction point, a few requests before Pi itself would stop to compact.

The rules, the decision formula, what is proved about it (partly machine-checked in Lean) and its known limits are in [docs/design.md](https://github.com/purboo/pi-zip/blob/master/docs/design.md).

## Results

Live A/B runs on the same coding tasks (4 task templates × 4 seeds, the user away between prompts as stated), paired by task, 95% bootstrap intervals. BC = [billion-context](https://github.com/ranxianglei/billion-context) with its defaults. These are the versions named in the table, not a live evaluation of 0.4.x.

| Model (pi-zip version) | Cost vs BC | Speed | Quality (task done / planted facts recalled) |
|---|---|---|---|
| Claude Sonnet 5.5, away 6 min (v0.3.0) | **0.77×** [0.67, 0.89] | median task 142 s vs 203 s | 16/16 and 1.00, same as BC |
| Claude Sonnet 5.5, away 2 or 6 min (v0.3.0) | **0.91×** [0.85, 0.97] | median task 143 s vs 209 s | 16/16 and 1.00, same as BC |
| GPT-6.1-sol, away 6 min (v0.2.0) | 1.00× [0.92, 1.08] | median task 209 s vs 305 s | 16/16 and 1.00 vs 15/16 |
| GPT-6.1-sol, away 2 or 6 min (v0.2.0) | 1.07× [0.91, 1.22] | median task 271 s vs 389 s | 16/16 and 1.00 vs 14/16 |

- Against plain Pi on the same Claude runs (v0.2.0): same speed, 0.45× the cost.
- Runs another extension starts after you were away (sub-agent results, scheduled follow-ups): 0.38× the cost of v0.2.8 on 4 such tasks.
- Questions whose answer had been folded, on real long sessions: 45–52% answered from the original via `zip_recall`, against 5% from BC's reconstruction, with the same number of wrong answers.
- Offline (simulated, no API calls) on 297 recorded sessions, the 0.4 decision rule costs 0.96–0.99× of a corrected v0.3.0 model, with no measurable difference in lost items ([details](https://github.com/purboo/pi-zip/blob/master/docs/design.md#measured-inputs-and-offline-results)).

Known limits:

- **GLM** (an automatic prefix cache that outlives its declared 5 minutes): v0.1 cost about 1.2× BC live. v0.2 learns the real cache lifetime (offline 0.95–0.97× v0.1); not yet verified live.
- **Long autonomous runs** (one prompt, hundreds of tool calls, e.g. sub-agents): roughly on par with BC, not better. By default, an output inside a running turn is only folded once it is 60 requests old. The optional judge only reorders folds the planner already allows; it does not fold a younger protected output.
- **Tool allowlists** (`pi --tools read,bash`, sub-agent launchers): Pi then hides `zip_recall`. With `read`, `grep` or `bash` allowed, pi-zip folds as usual and points the model at a recall file instead. With none of them, it folds only outputs the model can re-read. Add `zip_recall` to the list to get the tool itself.
- **Short sessions** with small contexts have little to save.

## What you see

One mark, ƶ, and three words: **zipped**, **unzip**, **summarized**. At most one line per turn, only when the context changed:

```
ƶ zipped 12 old outputs   74K → 43K   6 ms
  originals are kept · the model can unzip any of them
ƶ summarized 64 requests   182K → 41K   38.2 s · ready while you were away
```

Click the line (or press ctrl+o) to see what was zipped and why now, for example `cache cold · away 47 min` or `cache warm · worth it at this size`. A zipped output keeps its place in the transcript with a dim mark, and the model fetching one back shows as its own row:

```
 $ npm test  ƶ zipped
 ƶ unzip bash npm test  /Expected/
 3 of 812 lines
```

These lines are saved in the session but never sent to the model. `/zip` prints a card:

```
ƶ pi-zip  on
  model    zhipu/glm-5.3
  cache    each dot is one time you came back
                      6     5
               ●      ●     ●   ●
               ●      ●     ●   ●  ●
               ●      ●     ●   ●  ●   ● still there  19
           ━━━━━━━━━━━━━━━━┅┅┅┅┅┅┅┅┅┅───────────────────────────────────
                      ○         ○  ○ ○   ○    ○   ○   ○   ○   ○   ○  ○   ○ gone  74
                                   ○     ○    ○   ○   ○   ○   ○   ○  ○
                                         ○    ○   ○   ○   ○   ○   ○  ○
                                         ○    12  7   9   15  6   11 5
  away     30s     1m     2m        5m      10m         30m    1h     2h
           under 2 min: usually still there  ·  2–5 min: not sure yet  ·  over 5 min: gone
  session  30 zipped ~310K  ·  8 summaries $1.75  ·  2 unzips
  last     15:22  zipped 1 old output in 4 ms · cache cold · away 13 min
```

The chart is your own history with this model. Each dot is one time you came back after that long: filled above the axis if the cache was still there, empty below it if it was gone. The axis is solid while returns are (nearly) always warm, dashed while it is not sure, thin once the cache is mostly gone. That chance is what prices every edit. If a summary call failed, the card adds an `errors` row with how many and why the newest one failed.

Every notice, the chart's rules and the size scale are described in [docs/details.md](https://github.com/purboo/pi-zip/blob/master/docs/details.md#what-you-see).

## Commands

| Command | Effect |
|---|---|
| `/zip` | the card above: state, how long the cache survives your absences, this session's folds, summaries, recalls and failed summary calls |
| `/zip off` | strict no-op: no folds, no summaries, requests left untouched (earlier folds stay recallable) |
| `/zip on` | resume |
| `/zip quiet` | toggle the per-turn notice (folding continues) |

`off` and `quiet` are remembered per session. In `-p` / json mode `/zip` prints plain text to stderr.

## Ledger

Every decision is also written as one JSON line per event, in a file per Pi session: `~/.pi/agent/pi-zip/logs/<session>.log` (`PI_ZIP_CACHE_STATS` and `PI_CODING_AGENT_DIR` move it like the learned cache data). This is the only place a failure that never reaches the terminal shows up: the `error` of a `judge` record (a refused call, a reply that does not parse), a `summary` call that failed, a fold that refused, an edit another extension made. A parsed `judge` record also lists `verdicts`: per output its handle, tool, answer triple (`f`, active/finished/lookup, `-` when the reply had no valid line), resulting verdict and folded state, so a later fold can be traced to the facts behind it. Nothing reads it back; pi-zip never depends on it.

The folding trace has three stages:

- `judge_skip`: why no call was started (`pending`, `below-pressure`, `batch-too-small`, `cadence`, `failure-limit`, or insufficient candidates). It includes request count and eligible handles where available. Repeated identical skips are suppressed.
- `judge`: each `verdicts` row has `applied`, so a parsed answer can be distinguished from a verdict stored for planning. `streamChars`, `partial`, `applied` (count), `cancelReason`, and `resultDisposition` show what survived an interruption. `partial-applied` means some received rows were retained; `stale` means they were logged but not applied.
- `law.foldDecision`: per output, handle `h`, request-age, current verdict (`unscored` if none), eligibility `group` (`0`: older turns, `1`: pause-readable, `2`: aged protected-turn output; `null`: ineligible), `planned` (proposed by an application plan), and `selected` (accepted for application). Its overall reason distinguishes `guard-rejected`, `back-to-back`, `no-plan`, and `selected`. The existing `law.steps` explain the cache cost; the later `fold` record confirms persistence. Trigger names `cold` and `valve` describe cache probability, not who classified an output.

Judge calls consume text stream events when available. On settle/run end they retain complete newline-terminated fact rows before aborting. Timeout, error, and length stops can retain such rows too. Missing, malformed, duplicate, and unfinished rows do not replace existing verdicts; fixed rule-based verdicts remain protected. Scope/dependency changes, session/model changes, shutdown, and disabling pi-zip invalidate the snapshot instead. The provider is still cancelled; this does not wait for the remainder of its response.

- `PI_ZIP_LEDGER=/path/to/file` writes that file instead, and `PI_ZIP_LEDGER=off` (or `0`) writes nothing.
- A session file that grew past 8 MB is rotated at the next session start: the old one stays as `<name>.1`.

## Lookup cue

When a new request names an earlier output by its handle, or by the same full path or URL that a call used, its first request ends with one short note. The note names at most three of those outputs and asks the model to recall them with `zip_recall` instead of repeating the call. The match is exact and needs no model call. Outputs that a compaction took out of the view count too. An output shown in full, or a path whose newest call was an `edit` or `write`, gets no note. The note is not saved in the session. Each note writes a `lookup_hint` ledger record. `PI_ZIP_LOOKUP=0` turns it off.

## Session memory

pi-zip keeps a derived SQLite database of the open session next to its file (`<session>.memory.sqlite`; `PI_ZIP_MEMORY_DIR` moves it), and at a new user prompt it asks a retrieval model what earlier work is worth bringing back.

**Nothing is injected while the model still sees every output.** Retrieval starts only once earlier output is out of the model's view: a folded tool output, or a compaction. Until then the database is filled and no model is called.

**Storage is deterministic.** The database holds a row per session entry, one segment per request or per model step (a tool call and its result always share a segment), a small graph (call -> result, request -> step, file/URL/command references) and an FTS5 index over every user, assistant, thinking, tool-call and tool-result text block. No model decides what is stored, and the judge is not involved. The session file stays the source of truth and is only read.

**Only the open session is indexed**, in full the first time and then only new entries after each turn; other sessions are untouched until they are opened. A changed source entry rebuilds that one database. Large initial backfills project at most 500 entries per tick. Each queued tick belongs to a ledger generation; leaving the session or closing the ledger cancels and invalidates it. A failed batch rolls back and sets `error`, not `ready`. A later retry reconciles the committed prefix and resumes in bounded batches; three failed attempts stop retries until the session is reopened. Only catching up with the current source sets `ready` and clears the error. Retrieval searches the active branch only.

**Retrieval, on read only.** Every hidden text block of the active branch can be found: earlier user requests, assistant text (completed final answers are labelled conclusions; other assistant text is mid-turn text), reasoning (labelled unverified), tool calls and tool outputs. Searchable are the entries of the active branch before the latest compaction record, including the part the compaction kept in view (the note is advisory, and the model may have lost track of retained text too), plus outputs folded by pi-zip. Branch order defines "before", not timestamps. An absent entry alone is not proof of hiding. Entries whose handle the prompt names are resolved directly and kept first, each on its own.

**Planner call (awaited).** At a new prompt a first, tool-less model call reads the request (without `<skill>` blocks; a request over 4000 characters as its first 1000 and last 3000) and a bounded tail of the model view: user and assistant text of the last 3 user turns, each tool call as one line, no tool output bodies, at most 2,000 words (oldest dropped); right after a compaction, when that conversation is under 300 words, the first 500 words of the compaction summary are added. It decides only whether the request is a bare continuation or acknowledgement (then nothing is searched); it does not judge whether the visible context already suffices. Otherwise it splits the request into its distinct sub-questions (aspects) and writes keyword queries for each of them along four facets (what, why, how, when) in every language of the request and the visible context, with identifiers, paths and error codes verbatim (at most 16 queries). It runs at the lowest thinking level the model supports. A failed or invalid plan falls back to the request's own words (every distinct word up to 128; a longer request gives its first 32 and last 96). The main model waits for this call and the local search.

**Search.** One FTS5 search per keyword query (its words, plus each multi-word keyword as a phrase), matched in text and identifiers, not in kind labels. The searches are merged round-robin in two levels: within one aspect, the first entry of each of its queries, then the second of each, and so on (its "why" query first, since requirements and decisions are why a question about behavior is asked); then across aspects, so every sub-question of the request gets its own candidate slots instead of one verbose aspect taking them all. File paths and code symbols in the prompt also traverse the referential graph to hidden tool outputs, as one more merged list. A matched tool call brings its hidden result (one hop over the call -> result edge) right after it.

**Candidates.** The default cap is `min(32, ceil(8 × sqrt(T)))`, where `T` is the number of distinct topics (aspects) in valid keyword searches, at least 1. Thus 1/2/3/4 topics get 8/12/14/16 candidates; more facets or languages for the same topic and the graph stream do not increase the cap. This sublinear growth is a cost/coverage heuristic, not a measured optimum. An unplanned search counts as one topic. Candidates keep their merged order; explicitly handle-named entries come first and are additional to this cap. Separate executions keep their own handles, timestamps and whole-output outcomes even when their excerpts are identical; only repeated passages within the same entry are deduplicated. Conclusions are titled by the request they answered and quoted from their winning passage (up to 1500 characters); tool outputs are titled by their issuing call (when hidden); an entry may merge up to 3 matching chunk passages. Up to two hidden thinking excerpts from the same step may be attached as unverified context.

**Bounded graph lookup.** At most 6 distinct paths and 6 distinct code symbols are queried per prompt, with explicit inline references and the end of the request outside fenced code preferred over pasted code. Traversal stops when its 30-chunk pool is full. Symbols may match the output body or identifiers without occurring in the call title. Both path separators are accepted, including Windows keys in existing databases; no rebuild is needed. FTS keeps at most 3 chunks per entry before its row limit, and carries only IDs and scores through the ranking sort before fetching the selected text.

**Input packing.** The answer call gets at most 48,000 characters of quoted evidence (source headers, passages and optional thinking). This budget is separate from its instructions, the bounded 4,000-character request view and at most 1,800 characters of recent context; **total input can exceed 48,000 characters**. Packing first admits one complete passage per source, then extra passages in rounds, then thinking. A passage that does not fit is skipped, not a reason to stop considering later sources. Exactly identical passage text is quoted once with all its source IDs. Each execution still has its own handle, timestamp, outcome and independent need/citation decision; sharing text never grants need to another source. The candidate pool/ranking is unchanged. See [packing measurements](docs/retrieval-packing.md) for the input-size trade-off.

**Time.** Every evidence item carries when it was recorded and how long before the request; the model is told that a later conclusion, the recent context or the request supersedes it, and that a question about the current state is not answered by an older item. Each handle in the note shows its age, and statuses read `earlier conclusion`, `earlier user request` (only user requests cited), `seen in output` (a named tool output showed it then) or `uncertain`. The status follows what a finding cites; the model can lower it to `uncertain` but not raise it. A named tool result also carries the outcome of its whole output (`exit 1, 21 passed, 1 failed`), since the excerpt alone may miss it.

**The answer call selects and summarizes.** Like the fold judge, the model evaluates each item independently: the new request must depend on what the item concluded (a decision, a result, an explanation), not just share keywords or a file. To keep the reply short it lists only the needed items, each with the dependency as its reason; an unlisted item is not needed. Only listed items can supply findings or recall suggestions. A listed item without a reason, listed twice, or listed with a need other than `Y` is excluded. The log still records a decision for every item (`Y`, `N` for not listed, `U` for an invalid listing). A finding with any rejected citation is dropped in full. Recent context is used to judge need, not as a summary source. Thinking is unverified supporting context, not a result. No eligible candidates means no call. No needed items means no note.

**The answer call runs in the background.** When the search found candidates, the main model starts at once and its requests carry a pending note right after the prompt: a historical retrieval is running, its findings come in a later message, and `zip_recall` with no arguments waits for them. When the findings are ready they are appended at the end of the next request of the run (never inserted earlier, which would change what was already sent), or placed right after the prompt if they were ready before the first request; when nothing relevant was found and the pending note was shown, a one-line "nothing relevant" note closes it. Findings returned by `zip_recall` are not repeated. Later requests repeat each note in the same place, so the run keeps one cacheable prefix. The answer call has its own hard timeout (20 seconds by default). New prompts, run end, session changes, branch changes, compaction, and disabling pi-zip (`/zip off`) cancel pending retrieval; `/zip off` stops retrieval calls entirely while deterministic indexing continues. Notes are never written to the session file. Errors skip retrieval without changing folding or compaction.

The note carries one line per finding with the handles it came from, plus folded outputs worth reopening with `zip_recall`. It runs on the same model as the judge: `PI_ZIP_JUDGE_MODEL=provider/id`, optionally with `:level`, which then also sets the thinking level of these calls. Without that setting it takes the lowest input-price model on the current provider with a 32K window. `PI_ZIP_RETRIEVAL_TIMEOUT_MS` sets the timeout of each call (default 20000). `/zip-memory` shows the open session's ledger status.

The log is made to be traced and tuned later. One JSON line per event: `memory_config` (the knobs this session runs with), `memory_backfill` (reconcile, entries, ms, done), `memory_ingest` (entries added), `memory_retrieval` (one per prompt, joined by `requestId`), `memory_inject` (`kind`: pending or final), `memory_wait` (a `zip_recall` with no arguments waited for the findings), `memory_usage` (at run end, for a run whose request carried a note: which cited handles the model recalled with `zip_recall` or named in its own text; `used` counts recalls only, since naming a handle may mean disputing it), `memory_dropped` (the findings never reached the model: the run ended before the answer finished or before another request) and `error`. A `memory_retrieval` record carries `stage` (where a skipped run stopped, or `prepared`; actual insertion emits `memory_inject`), `latency` per step (plan, search, foreground, answer), `queries` (the planner's keyword queries, or `terms` when it failed), `calls` (model, level, ms, tokens, cost, stop reason, reply length), `input` sizes (`inputChars` for the full user message, `evidenceChars` for the serialized quoted evidence including source headers), `sentRefs`, physical `passages` and `sharedPassages` inside `input`, `terms`, `hits`/`inBranch`/`candidates`, `drops` (what validation removed and why) and an `evidence` table with the hiding reason, attached thinking count, and citation use (`cited`). `decisions` records each item's `need` and reason, including when all items are rejected. `drops.notNeeded` counts rejected citations. The evidence table is retained even when no note is produced. Trace is on by default during tuning; `PI_ZIP_MEMORY_TRACE=0` disables raw reply logging. `calls[].reply` includes up to 4000 characters of returned text even when the response ends with `length` or an error. `thinkingChars` records the size of any returned thinking, not its contents. Raw replies can contain session data. With trace on, `memory_retrieval.note` holds the exact note text.

`npm run index <session.jsonl>... [-- --out <dir>]` builds or updates the same database for any session file outside Pi, reading the session file only and printing one JSON line of counts per file. `bun bench/memory-bench.ts` measures indexing and summarises retrieval from the logs.

## Optional background judge

  Set `PI_ZIP_JUDGE=1` to enable a background model that ranks tool outputs. It is off by default. The planner still decides what may be folded. The judge only changes the order inside that set.

  - `PI_ZIP_JUDGE_MODEL=provider/id` selects an available model. Add `:level` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to request a thinking level, for example `github-copilot/gpt-6-luna:low`; an id that itself ends in such a suffix matches whole first. The level is sent only when the model advertises it. With no capability metadata, the request sends no thinking level and Pi keeps the provider default. With no explicit level, no level is sent either, except to a model whose provider picks the effort when none is named: GitHub Copilot models on the Responses API, and models whose thinking-level map has `off: null`. Such a model gets its lowest supported level above `off`. At Copilot's default effort, a 13K-token `gpt-6-luna` judge call took 34-43 s and hit the 30 s timeout; at `low` it took 7-9 s. Otherwise, pi-zip chooses the lowest input-price model on the current provider with at least a 32K context window. If none is available, the judge stays off for that session.
  - `PI_ZIP_JUDGE_MAX_TOKENS=16384` caps the judge output, thinking included. The cap also stays within the model output limit and the context room left after the input. Each `judge` ledger record logs `maxTokens`, `stopReason`, `outputTokens` and `reasoningTokens` for tuning. It also logs why the call ran: `reqCount`, `superseded`, `eligible`, `foldedHit` and `scopeChanged`. It logs the input size: `known`, `folded`, `evidence` and `inputTokens`. A parsed reply adds `diag`: code-derived C/H/N/U counts, malformed, foreign, missing, duplicate and bad-evidence lines, `facts` (the histogram of accepted answer triples, counted after the malformed, foreign, missing and duplicate guards, so a decisive `NNN` row is distinguishable from a row where the context left a fact unknown; lookup validation runs later, so an uncited `N` keeps its fact), and up to 10 lookup decisions with their outcome (`need`, `live`, `uncited`). The code selects matching references; the model does not return citations. A reply that does not parse keeps its first 300 characters as `replyHead`. A `judge_hint` record shows each distinct hint outcome: a note sent (`shown`, `skipped`), a note dropped for lack of room, or valid N handles that were blocked as `old`, `notFolded`, `recalled`, `hinted` or `uncited`.
  - `PI_ZIP_JUDGE_AGE=10` is an additional minimum age before a live output is scored. The output must also pass the planner's fold eligibility and placeholder-saving checks. With the default protected-turn rule, that means age 60, not 10. `PI_ZIP_INTURN_AGE=0` still disables age-based folding.
  - The model reports three independent facts: `<handle> <active> <finished> <lookup>`. Each answer is `Y/N/U`. `N` means false or not applicable. `U` means the supplied context cannot establish the answer. No citations, confidence scores or priorities are requested. `active` and `finished` can both be `Y`: a finished step can still supply information needed by current work.
  - Code decides priority. `lookup=Y` with a matching user/assistant handle or full path/URL becomes need if folded, or hot if live. Otherwise `active=Y` makes the output hot, even if `finished=Y` or a lookup reference fails validation. An output becomes cold only for `N Y N`. Other combinations stay warm. Age, silence, unrelated passing checks, complementary read ranges and mere same-path calls do not establish `finished=Y`. Labels never change rent, summary production or cache prices.
  - Code, not the model, labels a superseded output cold: the same tool ran again with the same arguments, or a successful `edit` or `write` changed the file at the output's full path. A failed later call supersedes nothing. A read of another range of the same file is not a repeat. Superseded outputs are labelled at every boundary, below the pressure and cadence gates, and are never submitted. A model reply cannot replace this label. The `judge` ledger record counts them as `superseded`.
  - Recent work reserves up to 35% of the 24,000-character evidence window for recent user prompts and assistant milestone replies, then fills the remaining budget with the newest assistant tool-call steps (visible prose and one `call <tool> <args>` line per tool call ahead of thinking) and deduplicated tool-result digests (up to 560 characters with outcome hints, key lines, and head+tail preserved; older identical head+tail tool outputs collapse to a short repeat line). Signatures, ids and other provider fields are left out. The canonical 24,000-character `workReferences` window for `lookup` verification remains unchanged.
  - Current state gives each output's age, live/folded status, and local causal trace (`turn=t/T`, caller intent `why=...`, same-turn edits `turnEdits=...`, and closing milestone `closed=t_c/T (...)` or `closed=open`). Catalogue rows stay immutable so the prefix caches across runs.
  - Only new, invalidated or expired candidates are submitted. Unsubmitted verdicts keep their original expiry. The ledger records `protocol: facts-v1`, `reused` and `addedTokens`. Recent work remains available as evidence even when its output is not a classification candidate.
  - A valid `N` can add one short lookup note to a request that is already going out, naming at most three handles. It does not restore the original, start a run, or send a steer. The note requires `zip_recall`. Each handle is noted at most once per session.

  The judge receives the task prompt, candidate labels and key lines, plus bounded recent work. Recall calls and earlier lookup notes are not evidence. Choosing a different provider explicitly sends this data to that provider. Calls use Pi's existing model credentials and can consume quota or incur charges. Only one judge call runs at a time. Errors retain still-valid verdicts. Verdicts expire after 20 requests. A changed user request invalidates the previous scope. New explicit references and live/folded transitions invalidate affected verdicts before the boundary's planner reads them. Invalidated in-flight results cannot restore old advice. Two consecutive provider/parse failures stop calls for the current run.

  This remains a chat judge, not an independent-logit System One classifier. The current transport uses validated Y/N/U fact lines. Provider-enforced JSON schemas are not enabled because enforcement through the configured endpoint is not verified. There is no corrective second call or generated confidence score. See [judge replay](docs/judge-replay.md) for offline measurement. Tests of the parser and policy do not establish model accuracy.

  `/zip` adds judge call cost, partly-unknown-verdict and error counts for this process. A verdict counts as unknown when at least one of its three facts came back U, so the count is taken from the reply: it can overlap the cold, hot and need counts, and it includes handles a fixed verdict kept. Records written before `diag.facts` existed used the narrower policy-code-U count. Judge verdicts and counters do not survive a restart. Hint dedup is stored in the session and is not sent to the model.

## Recall

A folded output becomes a placeholder that tells the model what it was and how to get it back, rather than guess or re-run it:

```
[folded by pi-zip at 10-11 02:44 UTC · bash bun test test/api.test.ts · 10-11 02:31 UTC · exit 1, 79 passed, 2 failed · 5637 chars, 109 lines · handle k3f9a0x1qz]
key lines kept (original line numbers; up to 8):
1: (pass) suite 0 > case parse config ...
106: 2 fail
109: Command exited with code 1
Original kept byte for byte, recallable even after summaries or compaction: zip_recall("k3f9a0x1qz") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.
```

The model recalls by itself when it needs the content:

```
zip_recall({ handles: ["k3f9a0x1qz", "m2b7c4d8ww"] })
zip_recall({ handle: "k3f9a0x1qz", grep: "ERROR|FAIL" })
zip_recall({ handle: "k3f9a0x1qz", range: "120-240" })
zip_recall({ grep: "ECONNREFUSED" })     // no handle: searches every earlier tool output
```

Recall is exact, paged and also reaches outputs from before a summary or compaction. When a tool allowlist hides `zip_recall`, the same originals are written on demand to files under `~/.cache/pi-zip/recall/` for `read`, `grep` or `bash`. Paging, search rules, recall files and their privacy are in [docs/details.md](https://github.com/purboo/pi-zip/blob/master/docs/details.md#recall).

## With other extensions

If another extension that manages context is loaded (billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune, …), pi-zip pauses folding, says so once and keeps only its request guard: two writers on the same view give unpredictable results. `/zip` shows `paused`.

An extension that only writes Pi's compaction summaries (a `session_before_compact` handler) does not pause pi-zip. **If your extension handles every `session_before_compact`, return `undefined` when `event.customInstructions` starts with `[pi-zip native compaction`.** pi-zip answers its own ask.

The request guard also repairs a tool result that lost its tool call before the request is sent, instead of letting the provider reject it. Details: [docs/details.md](https://github.com/purboo/pi-zip/blob/master/docs/details.md#coexistence).

## FAQ

**Will it save money?** Mostly on cold returns, where a long session pays for a full cache rewrite anyway. `/zip` shows what this session folded, what its summaries cost and how often the model recalled.

**Does it cost extra?** Planning is local. A summary is one extra model call with no tools; its price is weighed before the call is made, and every call, used or not, is counted in `/zip`.

**Can the model lose information?** Folded outputs keep their key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your first and newest requests word for word and never paraphrase the model's reasoning. A model that ignores the handle and guesses anyway is a failure pi-zip cannot catch, which is why recent turns are protected.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries that Pi projects per branch; the originals stay in the session file, and a restart rebuilds pi-zip's state from it.

**Which providers?** Anything Pi supports. The cache lifetime starts from what the requests ask for (5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`) and is then learned. Providers that do not report cache usage still work; the stats are then estimates. Relays that rewrite `cache_control` are detected where the provider reports it. For relays that pool accounts (sub2api, say), Anthropic requests name their session in `metadata.user_id`, as Claude Code does, so a typed prompt stays on the account that holds its cache. See [docs/details.md](https://github.com/purboo/pi-zip/blob/master/docs/details.md#faq).

## Testing

```bash
bun test                                                     # unit + invariant tests + integration with Pi itself
bun run build-check                                          # bundles src/index.ts with Pi's packages external
bun run mutants                                              # each mutant of a past bug must be caught by the integration checks
formal/live/narrative.sh <session.jsonl> [provider/model]    # release check with a real model (costs tokens)
```

The tests run the extension inside Pi's real session manager and extension loader with local fake providers; they make no LLM API calls. `formal/live/narrative.sh` is the one check that calls a real model, because fake providers never write long replies. The bounded model checker is in [formal/](https://github.com/purboo/pi-zip/blob/master/formal/README.md) and the Lean proofs in [proofs/](https://github.com/purboo/pi-zip/blob/master/proofs/README.md).

## More

- [docs/design.md](https://github.com/purboo/pi-zip/blob/master/docs/design.md): axioms, notation, the algorithm in pseudo-code, claims 1-10 with proofs, measured inputs, offline results, honest limits
- [docs/details.md](https://github.com/purboo/pi-zip/blob/master/docs/details.md): every notice, cache learning and token calibration, recall in full, coexistence, what pi-zip writes into the session
- [CHANGELOG.md](https://github.com/purboo/pi-zip/blob/master/CHANGELOG.md)

## License

MIT
