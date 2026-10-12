# pi-zip

Keeps long [Pi](https://github.com/earendil-works/pi) sessions cheap without losing anything.

pi-zip folds old tool output out of the context **only when the prompt cache has already gone cold**, so the edit costs nothing extra, and every folded output can be fetched back byte for byte. No configuration, no proxy process, no footer.

## Install

```bash
pi install npm:pi-zip
# or
pi install git:github.com/purboo/pi-zip
```

Try it for one run without installing: `pi -e npm:pi-zip`.

## Measured results

Live A/B runs on the same coding tasks (4 task templates × 4 seeds, the user away between prompts as stated), paired by task, 95% bootstrap intervals. BC = [billion-context](https://github.com/ranxianglei/billion-context) with its defaults.

| Model (pi-zip version) | Cost vs BC | Speed | Quality (task done / planted facts recalled) |
|---|---|---|---|
| Claude Sonnet 5.5, away 6 min (v0.3.0) | **0.77×** [0.67, 0.89] | median task 142 s vs 203 s | 16/16 and 1.00, same as BC |
| Claude Sonnet 5.5, away 2 or 6 min (v0.3.0) | **0.91×** [0.85, 0.97] | median task 143 s vs 209 s | 16/16 and 1.00, same as BC |
| GPT-6.1-sol, away 6 min (v0.2.0) | 1.00× [0.92, 1.08] | median task 209 s vs 305 s | 16/16 and 1.00 vs 15/16 |
| GPT-6.1-sol, away 2 or 6 min (v0.2.0) | 1.07× [0.91, 1.22] | median task 271 s vs 389 s | 16/16 and 1.00 vs 14/16 |

Runs started by another extension's message after you were away (sub-agent results, scheduled follow-ups) get the same cold-cache handling as a prompt you type, new in v0.3.0: on 4 such tasks, 0.38× the cost of v0.2.8, which left them untouched (context 31K vs 253K at the end). Against plain Pi on the same Claude runs (v0.2.0): same speed, 0.45× the cost. Hidden-question probes on real long sessions (questions whose answer had been folded): 45–52% answered from the original via `zip_recall` vs 5% for BC's reconstruction, same number of wrong answers.

Known limits:

- **GLM** (automatic prefix cache that outlives its declared 5 minutes): v0.1 cost about 1.2× BC live. v0.2 learns the real cache lifetime and folds the previous turn after the declared TTL (offline 0.95–0.97× v0.1), but this was not verified live.
- **Long autonomous runs** (one prompt, hundreds of tool calls, e.g. sub-agents): roughly on par with BC, not better. Outputs are only folded inside a running turn once they are 60 requests old.
- **Tool allowlists** (`pi --tools read,bash`, and sub-agent launchers that pass one): Pi then hides `zip_recall`. If `read`, `grep` or `bash` is on the list, pi-zip still folds as usual and the placeholder names a file the model reads or greps instead (see [Recall through files](#recall-through-files)). Only when none of them is allowed does it fold just the outputs the model can re-read (files, read-only commands), with a placeholder that says to re-read. Add `zip_recall` to the list to get the tool itself.
- If you always answer within the cache lifetime, there is little to save, by design.

## What you see

One mark, ƶ, and three words: **zipped**, **unzip**, **summarized**. Only the new context size is bright. At most one line per turn, at the top of the turn, only when the context was zipped or summarized:

```
ƶ zipped 12 old outputs   74K → 43K   6 ms
  originals are kept · the model can unzip any of them
ƶ summarized 64 requests   182K → 41K   38.2 s · ready while you were away
```

The second line appears once per session. A summary that made you wait (only at Pi's compaction room) says so (`waited 8.4 s`, highlighted from 2 s on); one written in the background while the agent kept working says `written while you worked`. Click the line (or expand tool output with ctrl+o) to see what was zipped and why now (a cold return says `cache cold · away 47 min` or `cache cold · model switched`, a warm edit `cache warm · worth it at this size`):

```
ƶ zipped 12 old outputs   74K → 43K   6 ms
  bash npm test         14K   k3x9q2m7ab
  read src/payment.ts  9.1K   p8d2x1qa0m
  … 10 more
  cache cold · away 47 min
```

These lines are saved in the session, so they are still there after a restart, but they are never sent to the model. On narrow terminals the time goes first, then the words; the numbers always stay. A summary still shows up as Pi's own `[compaction]` block as well; the ƶ line next to it tells you who made it. The pi-zip numbers are real tokens, the same scale as Pi's context meter (the meter adds the newest reply's output on top); the `Compacted from N tokens` figure in Pi's block is pi-zip's own size before for a summary prepared before your prompt (cold return or warm: it goes in through Pi's compaction, before your prompt); for a summary written in the background during a run it is Pi's own estimate of the size before, read from the reply before it, so it may differ from the ƶ line's by a few percent; for a summary you waited for it is Pi's estimate taken when the entry is saved, so it may not match.

A zipped output keeps its place in the transcript; its tool row gets a dim mark, so you can see what the model no longer sees in full:

```
 $ npm test  ƶ zipped
 read src/payment.ts  ƶ zipped
```

When the model fetches an original back, it looks like any other tool row and names what came back (ctrl+o shows the text):

```
 ƶ unzip bash npm test  /Expected/
 3 of 812 lines
```

Everything else uses the same grammar, and only when something changed:

```
ƶ pi-zip  on  old tool output gets zipped once the prompt cache expires (5 min here) · /zip
ƶ pi-zip  on  a tool allowlist hides zip_recall · zipped outputs are read back from files in ~/.cache/pi-zip/recall
ƶ pi-zip  reread-only  a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more
ƶ pi-zip  paused  billion-context also manages context, so pi-zip only guards requests · to use pi-zip: pi remove the other one
```

The first one appears once per machine. While a summary started in the background is being finished, Pi's working line says so (Esc there cancels the prompt, as it does whenever Pi is working; the summary goes on for your next try). `/zip` prints a small card into the transcript:

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


ƶ (U+01B6) is a plain Latin letter, one column wide everywhere, CJK terminals included. Most coding fonts have it; where one does not (Hack, Source Code Pro), the terminal draws it from a fallback font.

The chart is the one thing worth knowing: come back sooner than the solid part of the axis and pi-zip touches nothing; come back later and the old outputs get zipped, at no extra cost. Across (`away`) is how long you were gone, from 30 s to 2 h on a log scale. Every dot is one time you came back after that long: a filled dot above the axis is a time the cache was still there, an empty one below it a time it was gone, so the picture is your own history with this model, and a few gone samples take only a row or two. A column shows at most 4 dots a side; beyond that it shows 3 dots and the number at the far end of the stack (`12` = twelve times in that gap range). The axis is solid up to the longest gap that was (nearly) always safe, dashed while it is not sure, thin after it is mostly gone; the sentence under it says the same in words (`usually still there` when even the safe part had some misses). The counts are the learned ones, kept with older evidence halved after 16 newer observations of the same gap range, so they can be a little below the number of times you actually came back. Until something is learned there is no chart, one line only (`expires after ~5 min idle · a chart appears once you come back after a break`, from the cache lifetime the requests ask for). The chart needs 72 columns; where the legend does not fit beside it, it moves to one line under it, and in a narrower terminal only the sentence is shown. Notices state facts (how long you were away), not guesses: whether the cache really had expired is read from the provider's reply afterwards, so a wrong guess is not repeated.

## The three rules

1. **Nothing is lost.** The session file stays the single source of truth. pi-zip only changes the view sent to the model, never deletes anything. User messages, tool-call arguments, the system prompt, tool definitions and thinking are never rewritten. Every folded block carries a handle and shows its key lines (errors, ids, first and last line; for a JSON document on one line, its key fields).
2. **Edit only when the cache is already gone.** Provider prompt caches expire (the model's declared TTL, usually minutes). Changing the context while the cache is warm means paying to rewrite it; changing it after it expired is free, because the whole context is rewritten anyway, and a smaller context makes that rewrite cheaper. So when you come back after the TTL (or after switching model, or when the session was last touched longer ago than the TTL), pi-zip folds old outputs down to about 40K real tokens of context in one step, system prompt and tool definitions included, and every request of that turn sends the same bytes. No edit can shrink the system prompt and the tools, so once they take more than half of the 40K (a large tool set) the target becomes them plus 20K of conversation: with a 50K tool set the context lands near 70K. It is never a 40K that no edit can reach (that folds everything and summarises at every return), and it does not keep a full 40K of conversation on top either (on a live bench with a 36K prefix that cost 13% more, with no quality difference measured). There is one plan, whatever the cache is believed to be: below that target nothing is planned; above it the biggest eligible outputs fold until the context is at the target (the turn you just finished is eligible only after a pause, an absence at least as long as the cache lifetime the requests ask for, or after a model switch). Whether the cache is believed warm changes only the price of the edit: it is applied when it pays for the rewrite it causes, and while the cache is believed warm never on the request right after an edited one (no back-to-back warm rewrites). That is one inequality, r Δ²/(2g) + η Δ ≥ K with K = (w − r)(P T − (1 − P) Δ): the reads the removed Δ tokens would cost while the context grows back at g tokens per request (measured in the session), plus, near Pi's compaction trigger, what Pi would charge for the same room (η), against the rewrite of the T = A tokens left after the edit (pricing only the suffix after the earliest edit fires warm edits earlier and lost quality in the offline evaluation; the suffix is logged as `Tsuf` for measurement). r and w are the read and rewrite price ratios of the cache class, never the model's price table: explicit write premium 0.1 / 1.25 x input (2 x on the 1-hour tier), automatic prefix cache 0.2 / 1 x input; the class is read from the provider's usage reports, and until the first response the explicit ratios apply (the first request to a model is cold anyway). P is the probability that the cache is still warm, learned from the provider's own usage reports, inside a run too (a tool call that ran longer than the cache lives is an absence like any other). A cold return is P = 0, so K < 0 and it always fires; a single small fold never pays at a warm cache, a large one does.
3. **Never in the way.** Planning is local and takes milliseconds. Anything that needs a model call (a summary, only when folding is not enough and the same inequality prices the extra model call in, at a cold return and in the warm valve alike; the call is priced as what it is: an uncached read of the conversation since the previous summary and of that summary's narrative, which it merges (the lists are carried forward by code; the model never rewrites them), plus the narrative it writes) is prepared while you are away, with a separate, uncached call. When even a warm return (your next prompt while the cache is still alive) would summarise, that summary is started as soon as the run ends: it is needed whether you come back in a minute or after the cache expired, so starting early costs nothing extra (it is wasted only if you never come back, or the plan at your return cuts elsewhere). Otherwise, if the cache is about to expire (0.8 x its lifetime after your last request) and you have not come back, a background timer writes the summary the cold return will need. The timer is cancelled the moment you send a prompt. **You never wait for a summary**, warm or cold, unless the context is at Pi's compaction room (Pi would otherwise run its own, lossy compaction): if no finished summary is there for the cut a decision wants, that decision goes with its folds alone (when the law says they pay; otherwise nothing changes), the summary is written in the background, and the first decision after it is ready puts it in (at a turn end, saved before the next request; Pi's block then shows the size before), or your next prompt does, through Pi's compaction. A summary call already running is never started twice: if you return before it finishes, your prompt goes out without it and a later step takes it. At a turn end still at Pi's compaction room after its edit, the plan's own summary is written (or the one already running for it finished) while the turn waits: the one wait. The cut a warm plan wants can move later as the run grows: pi-zip then keeps the cut the running summary was written for when that still pays, and at most one summary started this way goes unused per warm stretch (from one cold return to the next; pi-zip's own away timer replacing one does not count); after that, a warm plan whose cut moved changes nothing (no call, no wait), and the context grows until Pi's compaction room. A summary that finished while you were away goes into the session through Pi's own compaction before your prompt (Pi's `[compaction]` block then shows pi-zip's size before), in milliseconds; when Pi cannot take it there (busy, nothing it would compact, an older Pi, another extension taking part in Pi's compaction: see Coexistence), it rides along with the first request as before. If you return while the cache is still warm and the valve does not fire (or cuts elsewhere), the prepared summary is discarded (its cost is still counted). With Pi's own idle cache warming on (`"cacheWarming": "idle"` in the global settings, the only place Pi reads it), the summary waits for Pi's decision instead of the 0.8 mark: while Pi keeps refreshing the cache, nothing is prepared (you would come back to a warm cache and not need it); once Pi stops, or no refresh follows its decision, or the next decision (due one warming delay after the refresh finished) does not come, the summary is prepared as usual. pi-zip only watches those decisions, it never answers them. The same timer is armed when a session is resumed, restarted, reloaded or forked, from the last response of its branch, but only for a moment that is still ahead: opening an old session you left hours ago starts no call on open (its return is a cold return, and the plan of your next prompt handles it). If that plan would summarise, judged cold or warm by the same rule your prompt will use (the learned cache survival included: a cache seen to outlive its declared lifetime gets a warm plan), the summary starts once you are typing a prompt in the reopened session; so a session restarted while its cache is still alive, whose warm plan would summarise, starts that summary at the first key, as the process before the restart would have when the run ended: pi-zip listens to raw terminal input (never consumes or changes it) and, after each key, looks at the editor: text that is not a command (`/...`) starts the summary and ends the listening. Ctrl+C, Ctrl+D, Esc, arrows, `/quit` or `/resume` start nothing, nor do terminal reports such as focus changes. So the time you spend typing the prompt is used: the prompt takes the summary if it is ready, else goes with its folds alone and a later step takes it. Open and close the session without typing a prompt and nothing is called. Not in `-p` or JSON mode, nor in a sub-agent (no terminal to listen to). The plan the timer prepares is made again when it fires if Pi's own compaction or another extension's edit changed the context in between. A summary's call is part of the price of the whole edit, so a warm summary that pays on its own but not together with the folds it replaces is refused more often than in 0.2.x, and the plan then falls back to deeper cuts or to folds alone. In `-p` and `--mode json` (no UI, sub-agents) pi-zip decides as with a UI: nobody waits for a summary there either, it is written in the background and the next decision takes it; only the preparation for a later return (settle's timer, the first key) is left out, since the process exits after the run. RPC mode binds a UI on Pi 1.1, so there pi-zip behaves as in the terminal, except that the first-key start needs Pi's editor and so does not happen.

**The cache lifetime is learned, not configured.** Every response says how much of the prompt came from the cache. pi-zip compares that read with what the request re-sent unchanged (the previous prompt, or the untouched prefix before one of its own edits: on an automatic prefix cache every edit leaves the first 8K tokens alone, so even the response right after a fold says whether the cache survived) and so learns, per provider and model, whether the cache survived a gap of that length: a few counts per gap bin (30 s to 2 h, with bin edges on the 5-minute and 1-hour tiers), monotone in the gap; a gap of 2 h or more is not recorded and falls back to the requested cache lifetime, older evidence halved after 16 newer observations of the same bin, stored without any content in `~/.pi/agent/pi-zip/cache-survival.json`. Before any evidence the cache lifetime the requests ask for decides (5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`; too short a guess is cheaper than too long); beyond it one clean read overrides it, inside it a lone miss counts as noise (warm caches do miss now and then) and only repeated misses do. A GLM cache read in full after 365 s makes the next 365 s return warm; a Claude 5-minute cache that read nothing after 360 s stays dead. Whether the provider bills cache writes (explicit cache) or not (automatic prefix cache) is read from the first response too. `/zip` draws what it has learned as the dot chart above.

Protected from folding: the current user turn and the previous one. When the context is above the target, re-readable outputs of the previous turn (an unchanged file, a read-only command) can still be folded at a return after a pause (an absence at least as long as the requested cache lifetime) or a model switch (never at a return inside it, whatever the cache), and any output in either turn can be folded once it is 60 assistant requests old (so a long agent run that is a single user turn with hundreds of tool calls is not exempt from folding; the newest 59 requests' outputs always stay, and every fold stays recallable). Messages you type while the agent is running (steering, follow-up) belong to that turn and do not start a new one. Outputs you have already recalled, and `zip_recall` results themselves (or reads of a recall file), are never folded again. "Read-only" is a conservative whitelist: `find -delete` or `-exec`, command substitution, redirects, background jobs, `git diff --output` and the like are not.

**Token counts are calibrated, not guessed.** Sizes are estimated as chars/4 (Pi's rule), and real tokens are not proportional to that: every request carries a fixed prefix O (system prompt, tool definitions, the provider's own framing: 2-4K on a bare Pi, 30-55K with a large tool set) that no edit shrinks, and the conversation costs c real tokens per estimated one (about 0.7-1.1 on GLM and GPT, 1.5-2.2 on Claude, more on CJK-heavy text). So a size is O + c x the chars/4 estimate of the conversation. O is read from the session: what the provider still read from its cache on the request that first carried the newest summary (everything after the system prompt and tools had changed there), else the session's first request minus its small opening prompt, else 2 x the chars/4 of the system prompt and the tool definitions; a tool set that changed since moves it by the same factor. c = (real - O) / estimate for the newest reply that reports usage (input + cache read + cache write; clamped to 0.5-4, 1.5 before the first reply). Both depend on the provider's tokenizer, so only replies from the model the next request goes to count: right after a model switch to a model of another provider O and c fall back to the defaults until its first reply, while a switch between two models of one vendor on that vendor's own API (opus to sonnet on `anthropic`, say) keeps the scale the session measured (the defaults put the first cold return's sizes 10-20% off). A provider that serves several vendors (`github-copilot`, `openrouter`, a gateway) carries the scale only between models of one recognised family (Claude to Claude, GPT to GPT): a GPT-to-Claude switch there falls back to the defaults, since the two tokenizers differ by about 2x; and when that model has no O of its own, the previous model's O carries over in conversation units (O / c). Both are read from the session itself on every decision, so a restart, `pi -p` or a resumed session calibrates exactly like a long-lived one, and nothing extra is stored. The conversation estimate also counts what every tool call puts on the wire besides its arguments and output (the call id, twice, and the tool-use markup), since that does not shrink when an output is folded. On recorded sessions the next request's size comes out within 2.8% (p90; 31% with the single ratio of 0.2.9). The size a plan predicts for the request that carries it is a few percent off in the median after a fold that removed over half of the context, 12-15% at worst one time in ten (what is left has not been measured yet); from the next reply on it is measured again (within 4%). The cold cap counts the whole context and leaves at least half of it to the conversation; the compaction room is the whole context too (it is Pi's trigger); sizes in the notices, `/zip` and the ledger use the same scale.

The cold cap is kept below Pi's own compaction trigger (window minus `compaction.reserveTokens`), so on small windows Pi's lossy compaction does not get there first.

## Commands

| Command | Effect |
|---|---|
| `/zip` | the card above: state, how long the cache survives you being away (a dot chart of your own returns), this session's folds, summaries and recalls (counted from the session, so a restart does not reset them) |
| `/zip off` | strict no-op: no folds, no summaries, requests left untouched (earlier folds stay recallable) |
| `/zip on` | resume |
| `/zip quiet` | toggle the per-turn notice (folding continues) |

`off` and `quiet` are remembered per session; each change is one line in the transcript. In `-p` / json mode `/zip` prints plain text to stderr.

## Recall

A folded block says what produced it (tool, command or path with offset/limit, the local time of the output, exit status and test counts for commands), its size, a handle and its key lines, so look-alike runs stay apart. A JSON document on one line (a status call, an API response) shows key fields instead: error and status fields first, the newest record's identity, and the end of the last long string, not its first 160 characters. It also tells the model to prefer `zip_recall` (original bytes, instant, free, no side effects) over re-running or re-reading, because a re-run may give a different result:

```
[folded by pi-zip · bash bun test test/api.test.ts · 10-11 02:31 · exit 1, 79 passed, 2 failed · 5637 chars, 109 lines · handle k3f9a0x1qz]
key lines kept (original line numbers; up to 8):
1: (pass) suite 0 > case parse config ...
106: 2 fail
109: Command exited with code 1
Original kept byte for byte, recallable even after summaries or compaction: zip_recall("k3f9a0x1qz") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.
```

Placeholders are written once, when the fold is saved: sessions folded by an earlier version keep their old placeholder text unchanged. Summaries list each folded output with its handle, time (`MM-DD HH:MM`, local; a turn count would restart at every compaction) and outcome in the same way, and say at the top that the 10-character code next to a command, file or call is its handle and that what an output said is to be recalled rather than re-run or re-read. Rows that would read alike show the first line of their output that differs, and when every command runs after the same `cd <dir> &&`, that prefix is named once in the heading instead of on every row (with commands in several directories, every row keeps its own). A summary of an earlier summary merges it section by section (requests, files, commands, other calls, errors, handle table, handle index) instead of clipping its text: items are deduplicated, the oldest are dropped first under a per-section budget with a count of what was left out (zip_recall's grep without a handle searches every earlier output, so the lists are kept short: a summary is about a third smaller than in 0.3.0), user requests keep the session's first ones (they define the task) and the newest verbatim, shorten the ones between to their start (marked `≈`) and count the rest, and there is one narrative: the summary call reads the previous summary's narrative (not its lists) next to the new conversation and writes one updated narrative, newer values replacing older ones, finished todos dropped, durable facts kept (bounded: a longer previous narrative is sent as its head and tail). If that call fails, the previous narrative is carried as it was, marked as possibly stale with the time it was written. Pi's own free-text compaction summaries are merged the same way.

The model recalls by itself when it needs the content:

```
zip_recall({ handles: ["k3f9a0x1qz", "m2b7c4d8ww"] })
zip_recall({ handle: "k3f9a0x1qz", grep: "ERROR|FAIL" })
zip_recall({ handle: "k3f9a0x1qz", range: "120-240" })
zip_recall({ grep: "ECONNREFUSED" })     // no handle: searches every earlier tool output
```

Recall is batched, exact, and also works for outputs from before a compaction or a pi-zip summary (summaries carry a handle table and a budgeted index of older handles). Each recalled section is headed by the handle and the command or path that produced it, so a look-alike output (the same command run again, another slice of the same file) is easy to spot. Without a handle, `grep` searches every earlier tool output of the session (zip_recall results excepted, outputs from before a compaction included), newest output first, each match under its output's handle and command: this also reaches an output whose handle a long summary no longer lists. Output comes back in pages of 20,000 characters (8,000 for a search without a handle; a later page of a search covers the same outputs as its first page, so new output arriving in between does not shift it); the page says how to continue:

```
zip_recall({ handle: "k3f9a0x1qz", offset: 20000 })               // next page, by characters
zip_recall({ handle: "k3f9a0x1qz", offset: 20000, limit: 50000 }) // up to 50,000 characters per page
```

Paging is by characters, so even one 45,000-character line can be read in full, and the pages add up to the original byte for byte. `offset` and `limit` also page a `grep` or `range` selection. `grep` is a case-insensitive regular expression; patterns that could backtrack badly (nested quantifiers, quantified alternation, back-references, very long patterns) are searched as literal text instead.

### Recall through files

When a tool allowlist hides `zip_recall` (`pi --tools read,grep,bash`, sub-agent launchers) but `read`, `grep` or `bash` is active, pi-zip folds exactly as in full mode and points the model at a file instead of the tool:

```
Original kept byte for byte, even after summaries or compaction, in ~/.cache/pi-zip/recall/01a120cb-3d40-75a6-aeac-320e71967606/k3f9a0x1qz.txt: read it (offset/limit for pages) or grep it; prefer that to re-running or re-reading the source (output may differ). Do not guess its content.
```

The sentence names only the tools that are active (with bash alone: `sed -n` to page, `grep -n` to search), and summaries name the same files. A file does not exist until a tool asks for it: when `read`, `grep`, `find` or `ls` gets such a path (whatever comes before `pi-zip/recall/`: another machine, another user, a forked session), or a `bash` command contains one, pi-zip writes the original from the session (the current branch) and points the call at this machine's copy. A `grep`, `ls` or `find` of the session's directory writes every output the model no longer sees in full (folded or summarized away), so a grep over the directory searches them all. A read of a recall file is a recall: it is never folded and counts as an unzip, and the transcript draws it like zip_recall's row (`ƶ unzip …`). `/zip` says `on` (it is a full mode) and has one more row: `unzip    from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)`, naming where the copies really are (see below; a narrow terminal drops the part in brackets). In a bash command the path is recognised as its own word, also after `X=`, `--file=` or inside `{a,b}`.

The copies live in `$XDG_CACHE_HOME/pi-zip/recall/<session id>/` (by default `~/.cache/pi-zip/recall/`, a place backups and dotfile sync conventionally skip; a relative `XDG_CACHE_HOME` is ignored, as the XDG spec says, since it would put them in the project folder): directories 0700, files 0600. The state line and `/zip` show the place in use. The same text is already in the session file, which Pi writes 0644. Only what the model asks for is copied, and every copy can be written again from the session at any time, so copies older than 14 days are deleted at the next session start; that cleanup touches nothing but pi-zip's own copies (`<handle>.txt` files in session-id directories, never through a symlink). A copy that no longer holds the original byte for byte (a bash command appended to it or edited it) is written again the next time a tool names it. If you delete a session file to get rid of a secret it contained, delete `<that place>/<its session id>/` too, or it stays until then. Without a session file (`pi --no-session`) nothing is copied: the outputs are in no file, so pi-zip keeps them off the disk too, folds only re-readable outputs and says so (`reread-only`). Without pi-zip loaded nothing is written, just as zip_recall would be missing.

## Coexistence

If another extension that manages context is loaded (for example billion-context, magic-context, pi-smart-compact, pi-hot-compact, pi-context-prune), pi-zip pauses folding, says so once, and keeps only its request guard. Two writers on the same view give unpredictable results. `/zip` shows `paused`.

An extension that only writes Pi's compaction summaries (a `session_before_compact` handler, like Pi's own `custom-compaction` example) does not pause pi-zip, but Pi runs its handler for every compaction, the one that puts pi-zip's prepared summary in at a cold return included. So pi-zip watches that compaction: if another extension's summary went in instead of pi-zip's, pi-zip adds none of its own on top (its prepared summary is discarded, its cost still counted); if the compaction is not done within 2 s (that handler is writing a summary of its own), pi-zip cancels it before your prompt goes on, so nothing can land in the middle of the run, and sends its summary with the first request instead; and if it was cancelled, or took longer than pi-zip's own part ever does (250 ms), pi-zip stops going through Pi's compaction for the rest of the process, so that handler's work is not paid for and waited for at every return. When such an extension's summary is already in the session, pi-zip does not go through Pi's compaction at all. Either way, summaries then ride along with the first request, as on an older Pi. A handler that cancels manual compactions shows Pi's red "Compaction cancelled" line at most once per process. The 250 ms counts only the time other handlers can occupy (before pi-zip's own, and from its answer to the compaction entry being written); Pi's own work after the entry is written (rebuilding its context and the chat, which grows with the session) is not counted. **If your extension handles `session_before_compact` for every compaction (to write its own summary with a model call, say), return `undefined` when `event.customInstructions` starts with `[pi-zip native compaction`**: pi-zip's own compaction carries that text, pi-zip answers it itself, and a handler that starts a summary for it only has it cancelled after 2 s (and turns the native path off for the process). The text is a marker, not an instruction: pi-zip answers or cancels every compaction that carries it, so Pi's default summariser never receives it. Every summary notice records how the summary went in (`native: "ok"`, or the reason it went with the first request) in the notice entry of the session file (`native`, `nativeMs`, `nativeAskMs`); no extra line is shown.

**Runs an extension starts.** Pi starts a run for an extension's message (`sendMessage` with `triggerTurn`, as pi-runway's owed-drive and durable-subagents' attention do) without `before_agent_start`. pi-zip treats such a run's start like a prompt's (cold detection, the prepared summary, the cold plan), except that it never goes through Pi's compaction there (that call would abort the run that is starting): the summary rides along with the first request. A custom message that starts a run after the previous run's final answer ends the protected tail like a user prompt, so a session driven by such messages protects the latest run, not everything since your last typed prompt.

The guard has two parts. Before saving a fold or a summary it checks that the edit itself would not leave a tool result without its tool call (failed or aborted assistant turns, which the provider layer drops anyway, are ignored, as is any oddity the session already had). And before a request is sent it repairs a tool result that lost its tool call, instead of letting the provider reject the request and brick the session. The repair understands the request shapes of Pi's Anthropic, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and Bedrock Converse providers; a request of any other shape is passed through untouched.

## FAQ

**Will it save money?** Mostly on cold returns, which is where a long session pays for a full cache rewrite. While the cache is warm it edits only when the inequality above says the rewrite pays back (large contexts, near Pi's compaction trigger, outputs 60+ requests old). `/zip` shows what this session has folded (and roughly how many tokens that removed), its summaries with what their model calls cost, and its recalls. The numbers live in the session file, so a restart does not reset them.

**Does it cost extra?** Planning is free. A summary is one extra model call (the current model, no tools, no prompt cache), shown in `/zip`. A background summary you never use (you came back while the cache was warm and the plan did not need it, or it cut elsewhere, or you never came back, or pi exited before you did) is counted there too. Of the summaries started early for a warm return or instead of a warm wait, at most one per warm stretch goes unused while pi runs; one that finished but is lost when pi exits is counted as well. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your first and most recent requests verbatim (the ones between are shortened, then counted) and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why only re-readable outputs of the previous turn are folded after a pause; other outputs of the protected turns wait until they are 60 requests old.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**What does pi-zip write into the session file?** Besides `context_edit` entries and compactions (the edits themselves), five small custom entries that never reach the model: `pi-zip/state` (off, quiet), `pi-zip/steer` (which prompts were steering messages), `pi-zip/plan` (the plan prepared at the end of a run; ids only) `pi-zip/commit` (which request first carried a batch of edits: the planner's size calibration and a restarted process read it) and `pi-zip/unused-summary` (the cost of a background summary nobody used; `ab` marks one started early for a warm return, which counts against the one-per-warm-stretch bound), plus `pi-zip/notice` for the line you see. A resumed process rebuilds its growth estimate, "the last response carried an edit", how many early summaries went unused in this warm stretch and "a summary was made in this warm stretch" (no second warm summary until the context has grown back to the size that summary started from, or the cache goes cold; Pi's compaction room always allows one) from the branch, so it plans as the live one would have.

**Which providers?** Anything Pi supports. The cache TTL is the lifetime the requests ask for: 5 minutes, or 1 hour when `PI_CACHE_RETENTION=long` (or the request itself asks for the 1-hour tier); no per-model table is read, and how long a provider really keeps its cache is learned. Pi's own idle cache refreshes count as a cache touch, and a different provider or model than the last request counts as cold. Providers that do not report cache usage still work; the stats are then estimates only.

Some relays rewrite `cache_control`, so the TTL actually written can differ from the one requested. pi-zip checks `usage.cacheWrite1h` (reported by the Anthropic messages API and Bedrock) on the newest few assistant messages of the current model: if you requested 1h but the provider wrote 5m, it uses the 5m TTL (and the reverse), and says so once per session unless `/zip quiet` is on. Without that field it keeps the requested TTL. `PI_ZIP_TTL_SECS` still wins.

Some relays reject `PI_CACHE_RETENTION=long` with 400 `a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`, because they inject their own 5m `cache_control`. That is a provider issue: unset the variable.

## Testing

```bash
bun test                                                                   # unit + invariant tests + integration with Pi itself
bun run build-check                                                        # bundles src/index.ts with Pi's packages external
```

`test/pi-integration.test.ts` runs the extension through Pi's real session manager, extension loader and `emitContext`, with a mid-conversation system update and an aborted tool-call turn in the session, and checks that the request is byte-identical before and after turn_end persists the edits.

Environment overrides exist for tests only and are not part of the product surface: `PI_ZIP_TTL_SECS` (cache TTL), `PI_ZIP_COLD_CAP` (fold target in real tokens of the whole context, default 40000; at least half of it is always left to the conversation above the system prompt and tools), `PI_ZIP_FOLD_MIN` (smallest output worth folding, default 500 tokens), `PI_ZIP_KEEP_LINES`, `PI_ZIP_SUM_*` (the summary's section budgets: `USERS`, `USERS_FIRST`, `USERS_SHORT`, `FILES`, `CMDS`, `CMD_CHARS`, `OTHERS`, `ERRORS`, `LINES`, `ERROR_LINES`, `TABLE_ROWS`, `INDEX_TOKENS`; for budget sweeps), `PI_ZIP_INTURN_AGE` (age in assistant requests from which any output of the protected turns may fold, default 60; 0 = never), `PI_ZIP_CACHE_STATS=<path>` (where the learned cache survival lives; benches isolate it), `PI_ZIP_OFF=1` (register nothing), `PI_ZIP_NATIVE_MS` (how long pi-zip's own compaction may take before it is cancelled, default 2000), `PI_ZIP_LEDGER=<path>` (append a JSON line per decision; `prompt` records `ttlMs` and `ttlSource`, `declared` or `observed`; including the summary call's token usage; `cold_plan` records the calibration as `O`, `c`, `oSource`, `calReal`, `calEst`, `calSource`, next to the real `ctxBefore` and `ctxAfter`; `prompt` also records `gapS`, `pWarm`, `survSrc` and `cls`; `law` records every evaluation with `g`, `wr` (w/r), `pWarm`, `survSrc`, `prSrc` (`class`, or `default` before the class is learned) and per step `B`, `A`, `T` (= A), `Tsuf` (the suffix after the earliest edit, measurement only), `phi`, `K`, `eta`; `b2b_skip` marks a warm edit skipped right after an edited request; a summary's `waitedMs` (ledger and `/zip` stats) is the time the user actually waited for it (0.3.0 wrote 0 for a summary computed during the prompt of a session that already had a prepared plan, a fix, so ledgers of the same session differ there); `produce` a summary call started (or already running) in the background for a plan's cut, `take` a ready summary applied (its call is spent), `room_wait` the one wait, at Pi's compaction room, `pin` a plan moved back to the cut of a summary already produced or being produced that cuts no deeper, `unused_summary` a background summary dropped unused; `cache_sample` records each learned survival observation).

## License

MIT
