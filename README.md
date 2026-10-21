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
- **Summarise.** When folding is not enough, older history is replaced by one summary, written in the background while you work or are away. It quotes your first and newest requests word for word and indexes earlier outputs by handle; recall can still search every one of them.
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

Every decision is also written as one JSON line per event, in a file per Pi session: `~/.pi/agent/pi-zip/logs/<session>.log` (`PI_ZIP_CACHE_STATS` and `PI_CODING_AGENT_DIR` move it like the learned cache data). This is the only place a failure that never reaches the terminal shows up: the `error` of a `judge` record (a refused call, a reply that does not parse), a `summary` call that failed, a fold that refused, an edit another extension made. Nothing reads it back; pi-zip never depends on it.

- `PI_ZIP_LEDGER=/path/to/file` writes that file instead, and `PI_ZIP_LEDGER=off` (or `0`) writes nothing.
- A session file that grew past 8 MB is rotated at the next session start: the old one stays as `<name>.1`.

## Lookup cue

When a new request names an earlier output by its handle, or by the same full path or URL that a call used, its first request ends with one short note. The note names at most three of those outputs and asks the model to recall them with `zip_recall` instead of repeating the call. The match is exact and needs no model call. Outputs that a compaction took out of the view count too. An output shown in full, or a path whose newest call was an `edit` or `write`, gets no note. The note is not saved in the session. Each note writes a `lookup_hint` ledger record. `PI_ZIP_LOOKUP=0` turns it off.

## Optional background judge

  Set `PI_ZIP_JUDGE=1` to enable a background model that ranks tool outputs. It is off by default. The planner still decides what may be folded. The judge only changes the order inside that set.

  - `PI_ZIP_JUDGE_MODEL=provider/id` selects an available model. Add `:level` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to request a thinking level, for example `github-copilot/gpt-6-luna:low`; an id that itself ends in such a suffix matches whole first. The level is sent only when the model advertises it. With no capability metadata, the request sends no thinking level and Pi keeps the provider default. With no explicit level, no level is sent either, except to a model whose provider picks the effort when none is named: GitHub Copilot models on the Responses API, and models whose thinking-level map has `off: null`. Such a model gets its lowest supported level above `off`. At Copilot's default effort, a 13K-token `gpt-6-luna` judge call took 34-43 s and hit the 30 s timeout; at `low` it took 7-9 s. Otherwise, pi-zip chooses the lowest input-price model on the current provider with at least a 32K context window. If none is available, the judge stays off for that session.
  - `PI_ZIP_JUDGE_MAX_TOKENS=16384` caps the judge output, thinking included. The cap also stays within the model output limit and the context room left after the input. Each `judge` ledger record logs `maxTokens`, `stopReason`, `outputTokens` and `reasoningTokens` for tuning. It also logs why the call ran: `reqCount`, `superseded`, `eligible`, `foldedHit` and `scopeChanged`. It logs the input size: `known`, `folded`, `evidence` and `inputTokens`. A parsed reply adds `diag`: code-derived C/H/N/U counts, malformed, foreign, missing, duplicate and bad-evidence lines, and up to 10 lookup decisions with their outcome (`need`, `live`, `uncited`). The code selects matching references; the model does not return citations. A reply that does not parse keeps its first 300 characters as `replyHead`. A `judge_hint` record shows each distinct hint outcome: a note sent (`shown`, `skipped`), a note dropped for lack of room, or valid N handles that were blocked as `old`, `notFolded`, `recalled`, `hinted` or `uncited`.
  - `PI_ZIP_JUDGE_AGE=10` is an additional minimum age before a live output is scored. The output must also pass the planner's fold eligibility and placeholder-saving checks. With the default protected-turn rule, that means age 60, not 10. `PI_ZIP_INTURN_AGE=0` still disables age-based folding.
  - The model reports three independent facts: `<handle> <active> <finished> <lookup>`. Each answer is `Y/N/U`. `N` means false or not applicable. `U` means the supplied context cannot establish the answer. No citations, confidence scores or priorities are requested. `active` and `finished` can both be `Y`: a finished step can still supply information needed by current work.
  - Code decides priority. `lookup=Y` with a matching user/assistant handle or full path/URL becomes need if folded, or hot if live. Otherwise `active=Y` makes the output hot, even if `finished=Y` or a lookup reference fails validation. An output becomes cold only for `N Y N`. Other combinations stay warm. Age, silence, unrelated passing checks, complementary read ranges and mere same-path calls do not establish `finished=Y`. Labels never change rent, summary production or cache prices.
  - Code, not the model, labels a superseded output cold: the same tool ran again with the same arguments, or a successful `edit` or `write` changed the file at the output's full path. A failed later call supersedes nothing. A read of another range of the same file is not a repeat. Superseded outputs are labelled at every boundary, below the pressure and cadence gates, and are never submitted. A model reply cannot replace this label. The `judge` ledger record counts them as `superseded`.
  - Recent work shows assistant prose and thinking text plus one `call <tool> <args>` line per tool call. Signatures, ids and other provider fields are left out. An assistant row holds at most 2,000 characters and a tool-result row 1,200. A row cut by the window keeps its start.
  - Only new, invalidated or expired candidates are submitted. Unsubmitted verdicts keep their original expiry. The ledger records `protocol: facts-v1`, `reused` and `addedTokens`. Recent work remains available as evidence even when its output is not a classification candidate.
  - A valid `N` can add one short lookup note to a request that is already going out, naming at most three handles. It does not restore the original, start a run, or send a steer. The note requires `zip_recall`. Each handle is noted at most once per session.

  The judge receives the task prompt, candidate labels and key lines, plus bounded recent work. Recall calls and earlier lookup notes are not evidence. Choosing a different provider explicitly sends this data to that provider. Calls use Pi's existing model credentials and can consume quota or incur charges. Only one judge call runs at a time. Errors retain still-valid verdicts. Verdicts expire after 20 requests. A changed user request invalidates the previous scope. New explicit references and live/folded transitions invalidate affected verdicts before the boundary's planner reads them. Invalidated in-flight results cannot restore old advice. Two consecutive provider/parse failures stop calls for the current run.

  This remains a chat judge, not an independent-logit System One classifier. The current transport uses validated Y/N/U fact lines. Provider-enforced JSON schemas are not enabled because enforcement through the configured endpoint is not verified. There is no corrective second call or generated confidence score. See [judge replay](docs/judge-replay.md) for offline measurement. Tests of the parser and policy do not establish model accuracy.

  `/zip` adds judge call cost, unknown-label and error counts for this process. Judge verdicts and counters do not survive a restart. Hint dedup is stored in the session and is not sent to the model.

## Recall

A folded output becomes a placeholder that tells the model what it was and how to get it back, rather than guess or re-run it:

```
[folded by pi-zip · bash bun test test/api.test.ts · 10-11 02:31 · exit 1, 79 passed, 2 failed · 5637 chars, 109 lines · handle k3f9a0x1qz]
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
