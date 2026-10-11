# Triage: every failing property on the v0.3.0 candidate (rc030)

Source: `/tmp/pz-rc/src`, branch rc030 at fa3a467 (affine review fixes d398f04 + coldwarm 1fe03c2 + the /zip command change;
F1 WARM_SUMMARY_GATE on, F3 NARRATIVE_PRICE on, F2 LOOKAHEAD off). "+F2" is the same src with `--plan-opts '{"lookahead":true}'`.
Coldwarm 1fe03c2 is the reference column. Every number is **traces out of 24,744** (21,744 exhaustive + 3,000 random, seed 1;
239,402 requests), from `run-all.sh`. Line numbers are rc030's.

Classes: **(a)** a real code bug (file:line, the condition that fires wrongly); **(b)** a property that was too strict or
mis-stated (the corrected statement is now the spec); **(c)** an artefact of the checker or the bridge (now fixed). Every (b) and
(c) correction below is already applied, so the **current counts are the (a) counts**. "Before" is the first run of the
uncorrected spec and bridge. It was taken on coldwarm, which plans identically to rc030: after correction the two agree on
every property, within 0.1% for RD.

> **Second round (review fixes).** The counts in the sections below are the first round's, on its 24,744-trace suite and its
> first spec. The review found A1, A2 and A3 partly vacuous and the trace alphabet too small; the spec, the bridge and the suite
> are revised (README "The axioms", "Limits"), and the current counts on 33,340 traces are in the README's results table.
> What the revision found that the first round could not see is in "Second round: new findings" at the end of this file. One
> (b) correction of the first round is **withdrawn**: A3 no longer excuses a warm return's run plan (see the (b) table).

## Summary

| property | before (coldwarm) | rc030 now | rc030 +F2 now | coldwarm now | verdict | rc-fixed (rc030 + the fixes below) |
|---|---|---|---|---|---|---|
| A1 nothing is lost | 0 | **0** | 0 | 0 | pass | **0** |
| A2 edit only when gone or it pays | 24 | **24** | 24 | 24 | (a) ×1 | **3** |
| A3 never in the way | 241 (+F2: 679) | **104** | 540 | 104 | (b) ×2 corrected; (a) ×1, +F2 (a) ×1 | **23** (see the review round) |
| I1 run stability | 0 | **0** | 0 | 0 | pass (2 bridge artefacts fixed earlier, see (c)) | **0** |
| RD restart determinism | 8,815 | **8,712** | 8,717 | 8,712 | (a) ×1 root cause (3 fields); (c) ×2 fixed | **0** |
| RC recall never refolded | 0 | **0** | 0 | 0 | pass | **0** |
| PW protection windows | 0 (+F2: 441) | **0** | 0 | 0 | +F2: (b) corrected | **0** |
| B2B no back-to-back warm rewrites | 7 | **7** | 7 | 7 | (a), same root cause as RD | **0** |
| MP monotone in P(warm) | 14 (+F2: 25) | **14** | 25 | 14 | (a) ×3 planner paths; +F2 (a) ×1 | **1** |
| NR no regret | 191 (+F2: 190) | **191** | 190 | 191 | (a) ×2 (B2 for folds, smallest cut); 1 not isolated | **142** (hold reverted; residual) |
| NT no thrash | 3 | **1** | 1 | 1 | (b) corrected; (a), same root cause as RD | **0** on the suite; 2 of 15,000 random (N6) |
| TR target reachability | 9 | **9** | 9 | 9 | (a) ×2 calibration | **2** |
| LW / G / W (law as specified, harness fidelity) | 0 | **0** | 0 | 0 | pass | **0** |

B1 is gone from rc030: no MP, A2 or NR trace is in a B1 class any more (0.2.8: 12,073 MP traces in the B1 class). The B2 summary
class is down from 951 traces (0.2.8) to 1, with or without F2. Its fold analogue (181) remains.

## (a) Real code bugs, by root cause

Each item lists every property it breaks, so one fix clears several rows.

### 1. Planner state that lives only in memory (RD 8,712, B2B 7, NT 1, NR 1 of 9 smallest-cut traces is after a restart)
`run.ts:111 private g = G0`, `run.ts:118 private justEdited = false`, `run.ts:150 summarizedWarm = false`.
* **g**: the EWMA of real growth per request (`run.ts:1269`, `this.g = 0.9 * this.g + ...`) is learned from responses in
  this process and never rebuilt from the branch. A fresh process plans with G0 = 2500 where the live one has learned, for
  example, 8,317. The law's gain r·D²/(2g) changes, and so does the plan. The transplant probe names g alone in 8,564 of the
  rc030 RD traces, g with justEdited or summarizedWarm in 122, and justEdited alone in 26.
  Condition that fires wrongly: `lawTerms(..., law.g, ...)` with `law.g` = `this.g` (run.ts:394) differing between a live and a
  restarted process on the same session.
* **justEdited** (set at run.ts:1254 from the in-memory `pending`): after a restart the b2b rule (`run.ts:841` run plan, `run.ts:1104` valve, both guarded by `justEdited`)
  does not know the newest response first carried an edit, so a warm edit lands right after one (B2B, 7 traces).
* **summarizedWarm** (run.ts:729, :1166): after a restart a second summary in the same warm stretch is allowed (NT, 1 trace).
* Fix direction: derive all three from the session on `session_start`: g from the usage of consecutive responses, as
  `calibrate` already reads them; justEdited from whether the newest response is the first to carry a pi-zip context_edit or
  compaction; summarizedWarm from a pi-zip summary entry since the last cold return.

### 2. The summary call is not in the plan gate (A2, 24)
`plan.ts:716`: `gate("plan", B, A, room, 0, ...)`, where the call argument is always 0, even when `cutIdx !== null`. The call is
priced only by the summary gate (`plan.ts:666`), against the summary's own B = X, A = Sr. A warm plan with a cut passes both
gates separately, yet with the call added to the whole plan's K the law's own model says it costs more than not editing. Minimal
case: a turn_end valve at P = 1, B = 51.6K, A = 19.7K, summary of 35.4K into 3.5K: K = 65.4K including the 49.6K call, gain
52.8K. Fix direction: pass the summary call into the plan gate when a cut is planned (`call` instead of `0` at :716), or make it
one gate.

### 3. The planner's candidate plan depends on the mode and has no fallback (MP 14; NR 9)
The law is monotone in P (README, lemma M). These breaches come from which plan the law is asked about:
* **Smallest cut only** (MP 7, NR 9). `plan.ts:658-659` picks the first, smallest cut that brings the context under the cap, and
  `plan.ts:666` gates only that cut. At a lower P the cold plan has relax folds (`plan.ts:605`, cold or pastTtl only), so it
  needs a smaller cut, whose summary does not pay (call > gain) and is refused. At a higher P the warm plan has no relax folds,
  picks a deeper cut, and that one pays. In NR form: the cold return refuses a small summary, then the warm valve summarises a
  bigger prefix a few requests later. Fix direction: when the minimal cut fails the gate, try the deeper cuts (the gain grows
  as D²).
* **The summary voids better folds, then everything is refused** (MP 6). The summary passes `plan.ts:666`, folds before the cut
  are dropped (`plan.ts:675`, "the prefix is replaced: its folds are void"), the whole plan fails `plan.ts:716` and the function
  returns null. A folds-only plan exists that the law accepts (the higher-P plan makes it, e.g. 25 folds leaving 262K where the
  summary plan would leave 488K). Fix direction: on refusal at :716, fall back to the folds-only plan.
* **Cold mode at 0 < P < 0.5** (MP 1). Relax folds bring the context under the target, so `plan.ts:638` sets no summary
  trigger. The plan gate at P = 0.49 then refuses the folds (K > 0, small D), and `plan.ts:716` returns null. At P = 0.51 the
  warm plan's summary pays. Reachable when learned survival gives a P strictly between 0 and 0.5. Fix: same fallback.

### 4. Calibration (TR 9)
* **`carried` misjudged** (TR 6, plus 1 at 39K believed vs 46K sent). `plan.ts:294`: `carried = ... (!P || N.real < P.real ||
  (N.read > 0 && N.read < 0.8 * P.real))`. A cold run plan whose request also grew (the previous turn added more than the folds
  removed) and missed the cache (read = 0) is judged not carried. The fold savings are then added back to the estimate
  (estN 110K against a real 65K), c drops to 0.56, the next cold plan believes 35K against a 40K target, and does nothing to a
  65K context. Fix direction: decide "carried" from the entries (the run plan was persisted at that run's turn_end, so the
  request that preceded the context_edit entries sent them), not from size and read heuristics.
* **O after a model switch** (TR 2). `plan.ts:268-269`: `opening(cur)` is evaluated on `cur.est`, the projection's estimate
  before the new model's first response. The projection counts the placeholders of later folds, not the originals that request
  carried. A mid-session first request then looks like an opening one, so O = real − C0·est is overestimated (50.1K against a
  real ~30.4K; c clamps to 0.5). The believed target becomes about 70K, and a 58K context gets neither enough folds nor a summary.
  Fix direction: add back the `orig` deltas of later edits to `cur.est` (as `estN` does), or skip `cur` when edits after it exist.

### 5. B2 for folds: the window slides (NR 181; +F2 180)
`plan.ts:601` (`protectedTurn`) and `plan.ts:605` (relax: only re-readable outputs of the previous turn). At a cold return the
previous turn's mutating outputs (`npm test`, 2 × 20K in the minimal 8-event trace) are protected and stay. One prompt later the
window slides, they are no longer protected, and the warm run plan folds them (2 folds, 44K → 4.4K) at a warm cache. By NR's
definition the slide is not new information, so the free cold rewrite was dominated. F2 covers summaries only, so this remains
with F2 on. It needs a decision, since the obvious fixes conflict with PW. Either a fold lookahead at the cold plan (fold the
previous turn's outputs the next warm plan would fold; PW must then admit it, as it now admits F2's cut), or the warm plan does not
fold blocks that were protected at the last cold plan within K requests with no new information.

### 6. With F2 on only
* **A3 +433: the lookahead summary is not prepared while away.** The settle plan (`run.ts:926-927`, `opts(ctx, true, "cold",
  ...)`: the plan the away timer prepares) predicts no summary, and no timer is armed. The run plan at the return (`run.ts:612-614`)
  makes the F2 summary, and the user waits (minimal: 7 events, a 60K turn, return after 1 h). The input that makes the two plans
  disagree is not isolated. Candidates are the options that differ between the two calls (`pastTtl` is set only at the run start;
  `promptPending` / `slide` accounting inside F2, `plan.ts:688`).
* **MP +11: F2 runs only when the regular summary did not happen.** `plan.ts:684`: `if (f2 && cutIdx === null && ...)`. At P = 0
  the protected-limit summary passes and F2 is skipped, though it leaves 62.6K, above the target. At P = 0.49 that summary fails
  the gate, F2 fires, and reaches 34.9K. So the lower P plans worse. Fix direction: also try F2 when the regular cut leaves
  ctxAfter above the cap, and keep the better plan.

### 7. A3: a resumed process never prepares the away summary (A3 104; +F2 106)
`armAway` is reached only from the settle path (`run.ts:963`, `:967`), never from `sessionStart` (`run.ts:449`). In the bridge a
`restart` happens right after a run, and the new process then sits through the whole gap without arming the timer. At the cold
return the user waits for the summary. Fix direction: on `session_start` (resume), arm the away timer from the branch's last
request time, as settle would have. Note: a restart that happens *at* the return cannot be helped. The bridge only models
restarts at the start of the gap.

### Not isolated
* **NR, B2 summary residue** (1 trace, with or without F2; 29 events, a 30K system prompt, c = 1.7): a cold return folds 3
  outputs and keeps 170K. Two requests later the warm run plan folds 5 and summarises. F2, when on, does not fire there. Needs a
  look at the F2 preconditions at `plan.ts:684` (`ctxAfterFolds > coldCap`, `!o.noSummary || atRoom`) for a large O.

## (b) Properties that were too strict, with the corrected statement now in the spec

| property | original statement | corrected statement | traces removed |
|---|---|---|---|
| A3 | the user waits for a summary call only at Pi's compaction room | ... only at Pi's compaction room, **in the warm valve at a turn_end** (mid-run: the user already waits for the agent; A2 checks it pays), or **at a return a model switch made cold** (the cache dies at the prompt: nothing to prepare while away). *Round 2:* the first round excused every decision at P ≥ 0.5, a warm return's run plan included, citing README rule 3's "at a cold return and in the warm valve alike". That sentence is about how the call is priced, not about letting the user wait; the excuse hid B2 (A3 passed on `traces/b2.trace`). It is withdrawn, and the narrower rule is stated in the README as a product decision | 20 valve + 117 switch (coldwarm); round 2 puts back 3,455 (affine) and 11 (coldwarm) B2 waits |
| PW (+F2) | a summary never cuts into the latest two user turns | ... except an F2 lookahead cut at a cold plan (`ahead`), which may reach the previous turn's **final answer** (the guard's own rule) | 441 (+F2) |
| NT | at most one summary per warm stretch of the real cache | ... per warm stretch **as pi-zip believes it**: a stretch ends at a return planned cold. Learning that a cache outlives its declared TTL is outside the spec | 2 |
| NR (growth window) | a warm edit within K_REGRET requests of a cold plan with no new information (growth > DELTA = 10K real tokens *before* the edit's request) was dominated by the cold plan | ... growth counted **through the edit's own request**: the plan made for request i has seen what i appended (a run plan: the prompt and the previous response; a turn_end valve: the response it follows). *Why this is not just making the checker pass:* the old window excluded exactly the part of the growth the decision reacts to, so a 17K answer that arrives with the follow-up prompt did not count as news although the plan is made after reading it; "no new information" is about what the decision can know. It only widens "news" by one request, and only for growth above DELTA (a 10K answer still does not excuse). Measured on the unchanged rc030 source (6bcef19): NR 164 -> 142 (22 traces); on the B2 hold: 39 -> 24. Any property that is not NR is untouched. If the reviewer rejects it, the 15 B2 hold traces it removes become residual, all of the form "a big answer arrived with the very prompt that follows a cold return" | 22 (6bcef19) |
| NR (room) | same | a warm edit is also excused when the context its plan saw (the previous view plus what the request appended) is **at or above Pi's compaction room**. *Why this is not just making the checker pass:* there the edit is forced: otherwise Pi compacts, lossily and at its own price, so "the cold plan was dominated by doing it then" does not follow; the cold plan, at a smaller context, could not have made an edit that only the later growth made necessary. The growth rule alone does not cover it when the growth is spread over many requests. It does hide real regrets of rc030 too: on 6bcef19 NR 142 -> 121 (21 traces), so the reviewer can weigh it: the 21 are warm summaries or folds at a small window (128K) with a 30K system prompt, where the room is reached within a turn or two of a cold return. On the B2 hold: 24 -> 2. The hold itself is released at the room (plan.ts), which is the design reason for this relaxation | 21 (6bcef19) |
| B2B | no edit on a warm cache right after an edit | no edit **planned warm** right after an edit (same reason as NT) | 0.2.8: 5 |
| A2 | the summary call priced as w·X + out·S (0.2.8's own formula) | priced as what `narrative()` costs: an uncached read (input price) of the prefix without the carried previous summary, plus the summary written. Both code formulas over-approximate it. LW now backs each version's call term out of K instead of assuming one | (pricing, not a count) |
| MP | the lower-P plan must cover the higher-P plan or leave a context no larger | ... or reach the cold target (a cold plan that gets there with fewer, lossless edits is the better plan) | (0.2.8: 397 "summary only at higher P") |
| TR | the cold plan reaches the target ±10% | ±15% (the README's own estimate error), and the legacy rule (class unknown) excuses it | 0.2.8: 2 |

## (c) Checker and bridge artefacts, all fixed

| where | artefact | effect before the fix |
|---|---|---|
| bridge, A1 | lossless was checked at the next prompt against the view of the previous request, so a valve summary persisted at turn_end was judged against a request that never carried it | 0.2.8: 703 false A1 failures |
| bridge, I1 | "persisted equals sent" was asserted also for a new valve plan at turn_end, which by design changes the *next* request; now only for the run plan the run already sent | 0.2.8: 1,343 false I1 failures |
| bridge, RD | the fresh-process probe ran after the live request had finished (5 s later, its latency), so near the TTL it saw a longer gap | coldwarm: 175 RD traces |
| bridge, RD | the fresh-process probe read the learned-survival file after the live response had recorded its own observation (it learned from the future) | coldwarm: 58 RD traces |
| spec, attribution | an edit first carried by a run's first request was attributed to that run's plan even when the previous turn_end's valve had persisted it ("a warm edit without a law evaluation") | 0.2.8: 125 false A2 traces |
| bridge, MP | the P-grid kept a live reference to the recalled set (which grows when zip_recall runs later) and read pastTtl before run.ts set it | property G (probe reproduces the real decision) now guards this; G fails 0 on every source |
| bridge, ids | sent messages were matched to entries by object identity only; Pi's projection may hand out new objects after edits; now also by content | no count change measured (fixed while investigating TR) |

## How to reproduce one row

```sh
cd formal && cargo build --release
./target/release/pz-formal check --src /tmp/pz-rc/src --only MP --random 3000   # counts and minimal traces per class
./target/release/pz-formal run --src /tmp/pz-rc/src traces/b2.trace              # one trace, every request and verdict
```
The minimal counterexample of every class is in `out/rc030.json` / `out/rc030-lookahead.json` after `run-all.sh` (not
committed; about 70 minutes on 28 cores under `pi-durable-subagents hold machine`).

## Second round: new findings

The revised checker (positional A1 with the real `zip_recall` and recall-file round trips, a real provider payload through the
guard, A2 at the class ratios and the requests' real sizes with no blanket excuse below P = 0.5, A3 without the warm-return
excuse, and the new properties GC, WB, MH and the residuals RDr, MPr, A2r) on the extended alphabet (steering, failed and aborted
requests, Pi's own compaction and another extension's edit mid-run and between runs, restarts and switches at the return, the
1-hour tier, both allowlist modes, Pi's idle cache warming). Counts are traces out of 33,340 (`run-all.sh`, seed 1), affine /
coldwarm 1fe03c2 (0.2.8 where it shares the cause). Every item is (a), a code behaviour, unless marked.

### N1. Calibration after a compaction pi-zip did not write (WB 4/0, MH 13/13, A2 and A2r 1/1)
After Pi's own compaction (or another extension's), `calibrate` (`plan.ts`) takes c from the newest reply, whose real size is the
*pre-compaction* request (78K in the minimal trace), against the estimate of the *post-compaction* projection (19K): c = 3.9
instead of 1.0, and O falls back to its default. Until the next reply the planner believes the context is about four times its
size: a warm return 7 s after Pi's compaction summarises a 21K context it believes is 60K (WB: the user waits for a summary
below the target), a cold return folds a 4K request inside the automatic cache's 8K head (MH), and a cold summary whose call
does not pay goes out (A2r). Fix direction: in `calibrate`, skip a reply whose request predates the newest compaction entry, or
add back what that compaction removed. The other A2r trace on each source is a turn_end valve whose folds pay by the planner's
estimate but leave more than it planned (affine 4% more, within noise; coldwarm 32% more, after a model switch: the O of (a) 4). (0.2.8, with its single ratio, has the same failure after another extension's edit: WB 38,
A2r 135 by the planner's estimate.)

### N2. A refused request counts as a cache touch (GC 16/16, 0.2.8 16)
`cache.ts lastMessageMs` takes the newest message of the branch, including an assistant message with `stopReason: "error"`
(the provider refused it: overloaded, rate limit). A return 302 s after the last *successful* response, 296 s after the refused
one, is planned warm and not past the TTL (`detectCold`); the cache is dead. The return then pays the full rewrite of an
unfolded context, and the learned survival records a dead sample at a gap that is shorter than the real one. Fix direction: skip
errored (and aborted-before-send) assistant messages in `lastMessageMs`, as `lastPrompt` already does. The checker models an
error as refused before the provider read the prompt; an error after it (mid-stream) would touch the cache, so the fix should
keep messages that report usage.

### N3. Pi's compaction or another extension's edit between runs voids the away summary (A3 6/16, RDr 3/6)
The away timer prepares the plan made at settle (`armAway(delay, () => runAway(p, ctx))`, `run.ts`). A compaction or context
edit that lands after settle (Pi's threshold compaction runs exactly then) is not seen by that plan: either the prepared summary
no longer matches and the user waits for a new one at the return (A3), or it is used and differs from what a fresh process
plans at the same instant (RDr: its handle table still counts the output the other extension pruned). Fix direction: re-plan
when the away timer fires (or when the branch's leaf changed since settle) instead of reusing `p`.

### N4. The learned survival's last bin is open-ended (GC 3/3)
`learn.ts GAP_EDGES` ends at 5,400 s: every longer gap shares that bin. A cache seen alive once at 110 minutes is believed warm
(P 0.80) at 156 minutes, after it died; the return pays a full rewrite of an unfolded context. Only reachable with a cache that
outlives 90 minutes (in the checker: the 1-hour tier on a provider that keeps twice its declared TTL). Fix direction: an upper
edge at a multiple of the longest declared TTL, beyond which the declared TTL's prior decides.

### N5. B2 is back in A3 (A3 3,455/11)
Not new code behaviour: the first round's A3 excused it (see the (b) table). On coldwarm, F1 gates the warm summary, but 11
warm returns still summarise in the run plan while the user waits (minimal: 22 events, reread-only mode). The fix direction of
(a) 5 and F2 applies.

### Not code bugs (0.2.8 only, the README of the current version)
0.2.8 fails A1 (177) and RC (60) only in the allowlist worlds: it has no recall through files, so with `--tools read,bash` an
output it summarised away cannot be read back (the model has neither `zip_recall` nor a recall file), and it refolds an output
the model read back. rc030 fails exactly what coldwarm fails, on every property, with and without F2. It fails MH (169) because it
has no automatic-cache head, and NT (197) with summaries that remove almost nothing. These are features the current README
describes and 0.2.8 predates.

### Checker corrections made while triaging (c)
| where | artefact | fix |
|---|---|---|
| bridge, reread mode | the model's "re-run" of a folded command returned the original bytes for any command | a re-run of `cat` returns the file, of anything else new output (`npm test` is not re-readable) |
| bridge, A1 | the in-memory session reported no session file, so rc030 (which needs one for recall files) fell back to reread-only placeholders, and A1 demanded a recall file in every allowlist placeholder (rc030: 390 false A1 traces) | the session reports a file (nothing is written); A1 accepts the way back each placeholder names, a re-read only for an output that can be re-read |
| spec, MH | the first request to a new model was held to the head rule | excluded: learn.ts takes no sample there |
| spec, A2 | the summary call priced the whole summary as model output | the narrative call's own tokens (the skeleton and handle table are deterministic); the bridge's narrative model writes as many words as summary.ts asks for |
| spec, A2 | the 10% tolerance was taken of K, a difference of large terms | 10% of the gross terms of K (rewrite, reads saved, call) |

## rc fixes (v0.3.0 release candidate)

### B2 for folds: the decision (a) 6 (REVERSED in the review round: the hold is out, see "Review round" below)

Two designs were built behind one switch and measured against 6bcef19 (the rc030 source plus the first five fixes):

* **A, fold ahead.** The cold plan also folds, at the cold return, the previous turn's outputs (any class) that the warm plan at the next
  prompt would fold. It changes a product promise: the previous turn's outputs, protected until now, are folded at the very prompt that
  usually asks about that work. PW needs a new exemption (`ahead_ok`).
* **B, hold.** The warm plan leaves alone the blocks the last cold return protected until the next cold return, or until the session grew
  by more than 11.5K real tokens since that return's prompt (counted before the newest response), or until Pi's compaction room; where the
  plan without the hold would summarise, it is that plan. The protection of the latest two turns stays as it is.

Measurements (aggregates only; the sessions are the user's and the repo's bench runs):

| measure | base 6bcef19 | A fold ahead | B hold |
|---|---|---|---|
| `live_replay.ts`, user's 3 sessions (24 cold returns, 32 summaries, valve rewrite 417K, waits 130 s) | same | same | same |
| fold replay (real planner, user's 3 sessions, 277 prompts, 73 cold returns): estimated cost | 181.71M | 180.62M (-0.6%) | 181.71M (0) |
| ... warm edits / warm rewrite tokens | 75 / 1,730K | 49 / 1,475K | 75 / 1,730K |
| ... recalls of folded outputs (the model needed it) | 2 | 2 | 2 |
| fold replay, 398 bench sessions (1,221 cold returns): estimated cost | 281.76M | 229.64M (-18.5%) | 288.33M (+2.3%) |
| ... warm edits / warm rewrite tokens | 104 / 11,306K | 11 / 1,564K | 39 / 5,010K |
| ... recalls of folded outputs (same turn as the fold) | 75 (35) | 77 (2) | 55 (15) |
| ... folds made ahead of the window | 0 | 7,641 of 14,252 cold folds | 0 |
| `cw_sim.py` F1F3 arm, 626 sessions per cell, Anthropic 300 s: cost / lost items / waits / summaries | 1709.2 / 488 / 2061 s / 127 | 1708.4 / 496 / 2061 s / 127 | 1709.2 / 488 / 2061 s / 127 |
| ... GLM 300 s | 1023.3 / 492 / 5024 s / 157 | 1021.2 / 504 / 4833 s / 155 | 1023.3 / 492 / 5024 s / 157 |
| ... Anthropic 3600 s | 1757.7 / 366 / 2565 s / 88 | 1757.1 / 374 / 2565 s / 88 | 1757.7 / 366 / 2565 s / 88 |
| ... GLM 3600 s | 972.7 / 458 / 6364 s / 150 | 971.8 / 472 / 6448 s / 150 | 972.7 / 458 / 6364 s / 150 |
| checker PW, spec as in 6bcef19 | 0 | **2,833** | 0 |
| checker PW, with A's exemption | - | 0 | - |
| checker NR, spec as in 6bcef19 | 164 | 24 | 39 |
| checker NR, + growth through the request (b) / + room (b) | 142 / 121 | (24) / 16 | 24 / 2 |
| checker MP | 1 | 1 | 1 |

How to read it. `live_replay.ts` cannot tell the designs apart: it plans summaries at the recorded cold returns and valve events and reads
rewrites and waits from the transcript, and neither design changes a summary decision (B cannot even be expressed there, its state is the
session); its lines are identical for all three. The fold-level replay and the simulator arms (`/tmp` scripts built on the real planner
and on the repo's `cw_sim.py`, not committed) are the measurements that move.

* **On the user's own sessions A saves 0.6% and 26 warm rewrites; B changes nothing.** On the simulator the cost differences are 0.1%
  or less either way. A's 18.5% on the bench sessions is not the B2 fix: 54% of its cold folds are folds ahead of the window, at every cold
  return, i.e. the protection of the previous turn given up wholesale; a warm plan would have folded far fewer of them.
* **A's lost items are not lower: 496 vs 488 and 504 vs 492 (simulator), 77 vs 75 recalls (bench).** Its waits are lower on one cell
  (GLM 300 s, -191 s) and higher on another (GLM 3600 s, +84 s). There is no clear cost or wait win.
* B costs 2.3% on the bench sessions (the held outputs stay in context a little longer) and is neutral on the user's sessions and in the
  simulator (there the 10K-growth release comes before a hold would bite). It has fewer recalls (55 vs 75) and fewer warm rewrites.
* A earns its NR count (24) by a changed promise and needs a PW exemption; B reaches 39 on the unchanged spec with no other property
  moving (MP 1, PW 0, A3 not worse).

**Decision: B. (Reversed in the review round, 62a77a2: see "Review round" below; the numbers of this table are kept as the record, and cannot be reproduced from the repo.)** The numbers are close, and A gives up "the latest two user turns are protected". An earlier B that only skipped the
held blocks (without the hand-back to a summary) raised MP to 26 and A3 by 4 traces, because the held plan summarised where the fold
would have done; the committed B returns the plan the code made before when that plan summarises. Option A is not in the source.
A fold-ahead patch and both measurement scripts are kept outside the repo (`/tmp/pzrc-tools`) and described here only.

NR after B: 39 on the unchanged spec, 2 with the two (b) relaxations below; the 37 that depend on the relaxations are warm edits made
when a large answer arrived with the follow-up prompt (15) or when the context reached Pi's compaction room at a small window (22).


## rc results: the fixes, the residuals, what is still open

Final run, `pz-formal check --src ../src --suite standard --random 3000 --seed 1` on rc030 at **75c7a6c** (33,340 traces, 285,363 requests, 26 workers,
run under `pi-durable-subagents hold machine`). "Before" is the same command on the rc030 source (7182b25), taken in the earlier round with the
spec as it then was (the final spec's two changes, the NR room excuse and the stricter LW, were not re-measured on 7182b25: one run of this
source only). The review's own run on 7182b25 (`--random 2000`) agrees in direction: A2 2, A3 234, MP 16, NR 111, TR 11, GC 13, MH 6, RDr 4, A2r 1.

| property | before (7182b25) | after (75c7a6c) | what cleared it / what is left |
|---|---|---|---|
| A1 nothing is lost | 0 | **0** | |
| A2 edit only when gone or it pays | 4 | **3** | summary call in the plan gate; fallback plans; calibration. Residual: size-estimate error (below) |
| A3 never in the way | 266 | **23** | away timer re-planned when the context changed. **+14 are the cost of the review's P1-1 fix** (below); 7 are B2 summaries, 2 a return before the timer |
| I1 run stability | 0 | **0** | |
| RD restart determinism | 9,223 | **0** | g, justEdited, summarizedWarm rebuilt from the branch; the away summary re-planned |
| RC recall never refolded | 0 | **0** | |
| PW protection windows | 0 | **0** | |
| B2B no back-to-back warm rewrites | 4 | **0** | justEdited rebuilt from the branch |
| MP monotone in P(warm) | 23 | **1** | deeper cuts, folds-only fallback, cold 0 < P < 0.5 fallback. Residual below |
| NR time consistency | 173 | **142** | **residual, by decision**: the hold (B2 for folds) is reverted; 138 of the 142 are "window slide, folds" (outputs protected at the cold plan folded warm a prompt later), 2 "smallest cut only", 1 "window slide, summary", 1 a warm summary after a restart (the checker's class label; RD is 0) |
| NT no thrash | 0 | **0 on the suite; 2 of 15,000 on `--suite none --random 15000 --seed 7`** | N6 below. Not a clean 0: the suite does not reach it |
| TR target reachability | 15 | **2** | `carried` from the commit entries. Residual below |
| GC a gone cache gets a cold plan | 19 | **0** | refused request is no touch; a last bin that ends at 2 h |
| WB warm does nothing below the target | 0 | **0** | |
| MH an automatic cache keeps its head | 13 | **2** | calibration after a foreign compaction; the away summary re-planned. Residual below |
| RDr | 6 | **0** | |
| MPr | 0 | **1** | the MP residual |
| A2r | 2 | **3** | the A2 residuals |
| LW, G, W | 0 | **0** | LW is stricter than before (the plan step's call is pinned both ways) and still 0 |

Test counts at the final sha: `bun test` 437 pass, 0 fail; tsc clean; `bun run build-check` clean; `cargo test --release` in `formal/` 10 unit + 1 bridge + 22 mutants
pass, 1 ignored (`nt_no_thrash`, see N6).

Commits (rc030, in order): 5bcbf82 state rebuilt from the branch; f9a1458 calibration; 5866627 plan gate; 420205f refused request and 2 h bin; 6bcef19 away timer;
7dd902c B2 for folds (hold) **(reverted in 62a77a2)**; 7d470da spec: NR growth through the request; 85ec187 spec: NR room (**narrowed in 62a77a2**); 7ab2bb8 the B2
decision; 3dd97be the cold why-line; fcdd3f8 formal tests; e9af128 the dot chart; 437dd68 TRIAGE; then the review round: 79f599d resume timer only for a future
moment (P1-1); e4ff70d LW pinned both ways (P1-3); 62a77a2 hold reverted and the NR room excuse narrowed (P1-2, P2-1); 3d12aea README and `summarizedSince`;
75c7a6c resume timer while the cache is alive, and `formal/replay/replay.ts`.

## Review round: what was done with each finding

| finding | result |
|---|---|
| **P1-1** a restart starts a paid summary at once for any stale session | **Fixed** (79f599d, 75c7a6c). `resumeAway` arms only while the cache the session left is alive (`now < last + TTL`; from `last + 0.8 TTL` on that is a call at once, as the live process's timer would already have fired); a session left longer is a cold return and its next prompt's run plan handles it. Test `opening an old session starts no summary call` (sessions 5 s, 4 h and 5 days old, TTL 1 s) fails on the old code (1 call within ms) and passes. **A refinement of the review's rule**: it said arm only when `last + 0.8 TTL > now`; between 0.8 TTL and TTL the live process would already have started the call, so a restart there does too (second test). **Cost, now visible in the table: A3 +14.** A restart after the cache is dead (minimal: 330 s of 300 s, restart, prompt 60 s later) used to prepare the summary at the restart; now the user waits for it at the return. That is the trade the review asked for (no paid call for a session you only browse) against a wait for one you continue at once. Not hidden; if the other side is preferred it is the single `alive` check in `scheduleSummary`. |
| **P1-2** the hold: a measured net cost, no measured benefit | **Reverted** (62a77a2): the hold, `pi-zip/cold`, `HOLD_RELEASE`, the README sentence and the tests are out. Pricing the recalls that the replay counted: B avoids 20 recalls on the 398 bench sessions (75 -> 55), each re-entering one folded output of about 2.15K real tokens on average (mean saved per cold fold in the same replay: 25.7M / 11,975), written at the explicit write price 1.25: 20 x 2.15K x 1.25 = about 54K token-equivalents against the +6.56M (+2.3%) it costs, about 120 times less. NR stays a residual (142). **The measurement scripts are not committed and the +2.3% cannot be reproduced from the repo**: they ran on the 398 bench sessions and on private sessions and hooked a design that is no longer in the source. The numbers in the "Decision: B" table above are kept as the record of why, marked as unreproducible. |
| **P1-3** LW weaker for plan steps | **Fixed** (e4ff70d). The planner records on each whole-plan step whether it judges a cut (`plan.ts gate`, `cut`); `formal/src/spec.rs law_mismatch`: a cut's step must carry exactly the call of the summary step just before it; a folds-only plan's step carries none, so its K is checked exactly as before; a planned cut must end in an accepted whole-plan step for a cut, and a plan with no cut must not (a source that does not report the flag is checked as before). Mutants `lw1` (a cut reaches the plan gate with no call: the old LW passes it, the new fails it) and `lw2` (a folds-only plan carries a call) are in `tests/mutants.rs`; `lw1` fails on the old spec for the right reason (checked). |
| P2-1 NR room relaxation circular | **Narrowed** (62a77a2): a warm edit at Pi's room is excused only when the cold plan's own request sent a context below the room (growth pushed it there). A cold plan that left the room unmet is visible again. The growth relaxation `quiet_through_i` is kept (argued in the (b) table above, and removes 15 traces on the hold; with the hold gone its effect on the final source is not separately measured). |
| P2-2 NT not clean | **Reported, not fixed.** NT is listed as 0 only on the suite; 2 of 15,000 on seed 7 (both "a summary that removes (almost) nothing"), as N6. `nt_no_thrash` stays `#[ignore]`: I tried two mutants (the floor of the plan target; the `2 S` guard) and a restart one (`summarizedWarm = false`) against the unmutated source on the N6 and the restart traces, and on 15,000 random traces (seed 7) the mutant fails no trace that the original passes. |
| P2-3 A2 / A2r did not improve | **Not fixed; the attribution was checked against the three minimal traces and is only half right.** Two run-plan traces: the planner's A is 6% under the real size (A=14,712 against 15,601; K=11,769 against 12,481 with the real sizes, gain 11,208, 1,273 or 10% short), so a size-estimate error of the size the README states. The turn_end trace is **not** that: B and A are within 0.2% and 0.7% of the real sizes (B=103,432 against 103,221, A=72,128 against 72,651), yet the gain is 15.2K against the planner's K of 57.7K. The law adds the compaction-room term η only when `B >= room` (`plan.ts lawTerms`; the window is 128K, so the room is about 103.3K): the planner's B is just above it, the real B just below, and η jumps from 0 to enough to carry the edit. A 0.2% error crosses a step in the law. Neither is fixable by a cheap, safe change: the first needs a better estimate of what a fold leaves, the second a smoother law, which is a spec decision. |
| P2-4 F1 test inverted | **README**: the warm-summary refusal is now stated (rule 3: a warm summary that pays alone but not with the folds it replaces is refused more often than in 0.2.x). |
| P2-5 `quiet_through_i` | Left as argued; recorded in the (b) table. |
| Minor: "30 s to 90 min" | README now says 2 h and that a gap of 2 h or more is not recorded. |
| Minor: `loadStats` bin 16 | Harmless, as the review says; no change. |
| Minor: `summarizedSince` | **Fixed** (3d12aea): it re-ran `detectCold` on a copy of the whole prefix per prompt, 1.8 s at 8,000 prompts / 16,000 entries; it now passes the 256 entries before the prompt (detectCold reads the newest messages; the whole prefix when the window has no response) and scans for the answering response in place: 60 ms. `replayGrowth` is 20 ms at 64,000 entries. Timed on a synthetic session, no private content. |
| Minor: README custom entries, resume timer | **Fixed** (3d12aea): FAQ lists `pi-zip/state`, `steer`, `plan`, `commit`, `unused-summary` and `notice`; rule 3 describes the resume timer. (`pi-zip/cold` was removed with the hold.) |
| Minor: `planContext` hold plans twice | Gone with the hold. |

## Replay comparison: rc030 at 7182b25 against HEAD, over the 3 recorded sessions

Two tools, both on the same three sessions (277 user turns, 6,160 requests, 76 cold returns), the planner of each source run with `PZ_SRC`:

**1. `formal/replay/replay.ts`** (new, committed, takes any session files; rows carry no names or content). The real planner at every request on the pristine conversation
(pi-zip's own edits removed), the source's own folds and synthetic summaries applied as it chose them. An estimate of what the policy would do on the same work, not a rerun.
`warm rewrites`: warm requests that carry an edit; `rewritten K`: tokens rewritten by them (real, thousands); `wait s`: the user waits for warm summary calls at the bench latency fit
(a cold return's summary is taken as prepared while away; a restart is not modelled); `cost M`: millions of input-token equivalents at the class prices including the summary calls;
`lost`: outputs a summary replaced that the transcript later asks for again (same call); `recalls`: the same for outputs that were folded.

| session | requests | cold returns | summaries | cold | warm | warm rewrites | rewritten K | wait s | cost M | lost | recalls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 7182b25 | 4618 | 42 | 30 | 17 | 13 | 15 | 4403 | 1007 | 281.73 | 10 | 0 |
| 1 HEAD | | 42 | 33 | 20 | 13 | 15 | 4392 | 1007 | 279.50 | 10 | 0 |
| 2 7182b25 | 678 | 21 | 9 | 9 | 0 | 0 | 0 | 0 | 9.28 | 2 | 0 |
| 2 HEAD | | 21 | 10 | 9 | 1 | 1 | 50 | 23 | 8.89 | 3 | 0 |
| 3 7182b25 | 864 | 13 | 9 | 8 | 1 | 2 | 249 | 24 | 12.41 | 0 | 0 |
| 3 HEAD | | 13 | 11 | 9 | 2 | 3 | 287 | 47 | 12.02 | 0 | 0 |
| **total 7182b25** | 6160 | 76 | 48 | 34 | 14 | 17 | 4652 | 1032 | 303.42 | 12 | 0 |
| **total HEAD** | | 76 | 54 | 38 | 16 | 19 | 4729 | 1077 | 300.41 | 13 | 0 |

Estimated cost is down 0.99% (sessions 1 / 2 / 3: -0.79% / -4.22% / -3.15%); the price is 6 more summaries (4 cold, 2 warm), 2 more warm rewrites, +45 s of modelled user wait,
and 1 more output lost (session 2: 2 -> 3). The summaries are what the plan gate now buys: deeper cuts and a fallback to folds where the whole plan with its call is refused.
The cost gain is the folds-only fallback and the cuts the old plan did not find, not fewer rewrites: warm rewrites go up, not down. The sample is three sessions: it does not
show that the cost gain is real (no interval; the bench's sessions are not in this comparison, and the cw simulator does not run the source, so `cw_report.py` does not fit and was not run).

**2. `bench/tier0/coldwarm/live_replay.ts`**, run unchanged on both sources. Its recorded-event lines are identical (24 cold returns, 32 recorded summaries,
417K valve rewrite at the 8 events, 130 s of wait, 1,231K total valve rewrite): the transcript does not depend on the source. What it replays differs:

| line | 7182b25 | HEAD |
|---|---|---|
| (b) valve summaries replayed with the same cut | 8 / 27 | 4 / 27 |
| warm plan, F1F3 (the shipped arm) summarises at | 7 / 8 | 4 / 4 |
| cold gate rejects a replayed valve summary (P = 0, call w X + out S) | 3 / 8 | 0 / 4 |
| cold plan F1F3 summarises at | 14 / 24 cold returns | 14 / 24 |
| (a) events resolved by F1F3 | 5 / 8 (unknown 2) | 5 / 8 (unknown 2) |
| mean planned summary share that is the carried previous summary | 0.72 | 0.45 |

The warm valve replays a smaller share of the recorded summaries (the plan gate prices the call into the whole plan: the recorded warm summaries it now refuses are the ones the
review's P2-4 expected), and the cold plan is unchanged at 14 / 24.

## Deferred, with the reason

* **A2 3 / A2r 3**: needs a better estimate of what a fold leaves (and, for the turn_end trace, a look at K), not a planner change. Not cheap, not safe to change blind.
* **A3 23** (14 of them the P1-1 trade, 7 B2 summaries at a warm return, 2 a return before the timer): the 14 are a decision, not a defect; the 7 and 2 have no cheap fix (the valve at turn_end cannot know the growth the next prompt brings).
* **MP 1 / MPr 1**: P = 0 would have to look at the deeper cuts too; each plan is right by its own law.
* **NR 142**: by decision (P1-2). 138 are the hold's class ("window slide, folds"); the other 4 are "smallest cut only" (2), "window slide, summary" (1) and a warm summary after a restart (1).
* **TR 2, MH 2**: not analysed further (unchanged from the earlier round).
* **NT / N6** (below): the planner prices what it leaves; the fix needs the plan gate's answer for a cut whose protected turns are 98% of the context, not a guard.
* **`nt_no_thrash` mutant guard**: no mutant found that the unmutated source survives (see P2-2).
* **Item 11** (wait in `before_agent_start`): reverted earlier, unchanged.

### N6. NT: a cold summary that removes (almost) nothing (unchanged)

A cold return after a model switch, 126K of context of which 123K is the two protected turns, plans a summary of the 10K before them: the call is paid and the context goes from
126.7K to 119.2K (the floor, the protected turns, is 123.8K). On the final source NT fails 2 of 15,000 random traces (`--suite none --random 15000 --seed 7`), both "a summary that
removes (almost) nothing" (one: "context 543,918 is within a minimal summary of the floor 594,783"); 7182b25 failed the same class and "restart loses `summarizedWarm`"
on that seed. It is not purely a regression, but the "NT 0" row holds for the fixed suite only. The user-visible effect: a cold return after a model switch can pay one summary
call to remove about 7K of 126K.

## Remaining risks

* A restart after the cache is dead makes the user wait for a summary the old code prepared at the restart (A3 +14); a session opened only to browse no longer costs a call.
* Warm summaries are refused more often (documented in the README); on the three sessions the replay shows 2 more warm summaries, so the effect is not large there, but it is
  one sample.
* NR is a visible residual (142): outputs the cold return had to protect are folded by a warm rewrite one prompt later. On the 398 bench sessions the old hold would have
  avoided about 6.3M warm-rewrite tokens at a higher total cost; the replay above does not measure that class on the final source.
* The replay's cost and wait are estimates (a model of latency, class prices, synthetic summaries); no confidence interval.

## Round 3: N6, restart speed, driven runs, the native path (3d96bee, 2cda8e1, 007d1d1)

### Results

`pz-formal check --src SRC --suite standard --random 3000 --seed 1 --workers 26 --shrink 40` (33,340 traces, 285,363 requests) and
`--suite none --random 15000 --seed 7` (15,000 traces, 553,441 requests). "Before" is a2885b1 (its src is 75c7a6c's: the suite column is the
run of the table above, whose per-trace verdicts were kept; seed 7 was run again on a2885b1 this round). 2cda8e1 and HEAD (007d1d1) give
identical counts on both runs.

| property | suite before | suite after | seed 7 before | seed 7 after |
|---|---|---|---|---|
| A1, I1, PW, B2B, WB, LW, G, W | 0 | 0 | 0 | 0 |
| A2 / A2r | 3 / 3 | **4 / 4** | 20 / 20 | **22 / 22** |
| A3 | 23 | 23 | 94 | 94 |
| RD / RDr | 0 / 0 | 0 / 0 | 5 / 5 | **2 / 2** |
| RC | 0 | 0 | 1 | 1 |
| MP / MPr | 1 / 1 | **0 / 0** | 11 / 4 | **0 / 0** |
| NR | 142 | 141 | 336 | 338 |
| NT | 0 | 0 | **2** | **0** |
| TR | 2 | **1** | 11 | **5** |
| GC | 0 | 0 | 1 | 1 |
| MH | 2 | 2 | 7 | 7 |

The new A2 traces (1 on the suite, 2 on seed 7; per-trace verdicts compared) all have a model switch, and the runs split exactly there:
before, the cold return after the switch wrote a summary the planner believed paid (the N6 class); after, it folds only (example: 36.7K +
a paid summary before, 49.7K with folds alone after). Later in the same trace, a warm decision in that now-larger context lands in the
existing class "pays by the planner's estimate of B and A, not by the request's real size (calibration)" (P2-3, deferred above: planner A
92.5K vs a real 97.3K). They are not decisions made with the carried-over scale. NR +2 on seed 7 is the same kind of shift: the trace
continues differently after a switch.

Tests at 007d1d1: `bun test` 455 pass, 0 fail; tsc clean; `bun run build-check` clean; `cargo test --release` in `formal/`: 10 unit + 1 bridge +
**23 mutants pass, 0 ignored** (`nt_no_thrash` is a real test now).

### N6: root cause and fix (3d96bee)

Neither of the two candidates the review named. **The plan gate is not skipped**: both gates run (summary step and whole-plan step with the
call, K < 0 at P = 0). **The call is priced correctly**: summary.ts `narrative` sends Pi's `serializeConversation`, which cuts every tool result
to 2,000 chars. The bridge's narrative read 17.3K real tokens where the planner priced 15K. Pricing the unfolded originals, which I tried
first, would overcharge by about 10x. The defect was **the sizes after the switch**. The first cold return to a new model is planned with
O = R0 x system and c = C0 = 1.5 until that model's first response, although the session has measured c (1.7 in the worlds where N6
appears). Every believed size was 10-13% low: believed context 376K for a real 416K, and the planner's believed context sat below the real
floor of the protected turns. So the summary decision was made on wrong sizes, and NT compares exactly that believed context to the real
floor. On the real sizes, the shrunk N6 summary removes 41K of 417K (not "almost nothing") and pays by about 18% over its call.

Fix: `calibrate` carries over the newest same-provider model's O and c until the new model's first response. Same provider means the same
tokenizer (opus to sonnet, say). Another provider keeps the defaults as before. NT is 0 on both runs, MP 0, TR down.

The N6 rule ("never start a summary that cannot pay for its own call") was already in place as the summary gate plus the whole-plan gate on
every trigger (cold, valve, lookahead through `summarise`). The fix makes the sizes they judge real ones. I did not add a safety margin to
the gates: it would move MP and the warm valve, and the margin seen on the N6 traces (5-18%) is within the estimate error the README states.

Tests:
* `test/calibration.test.ts`, "a switch to a model of the SAME provider ...": on a2885b1, c is 1.5 where the session measured 1.9.
* `formal/tests/mutants.rs nt_no_thrash` on `traces/n6-switch.trace`, the shrunk counterexample of the seed-7 run. The mutant
  (`sameProviderScale` disabled) is a2885b1's behaviour and fails NT; the src passes.
* `pz-formal gen --seed S --index N` prints one random trace (to replay a verdict's `n` without the shrinker).

### Restart speed (2cda8e1)

A reopened session whose cache is dead (`resumeAway` gets -1) and whose cold plan would summarise listens with `ctx.ui.onTerminalInput`
(only with a UI that has it). The handler never consumes or alters the data. Terminal reports are ignored: focus, CPR, cell size, DA, kitty
flags, DECRPM, SGR mouse, OSC/DCS/APC (`util.ts isKeystroke`). At the first real key it unsubscribes, plans the cold return again on the
session as it is, and starts the summary through the away timer's `startBg`. The prompt adopts it through `takeBg` (no second call; the
notice shows the remaining wait). The listener is also removed at shutdown and at any prompt; without a UI it is never armed.

Real TUI check: pi 1.1.0 in tmux, a mock Anthropic provider whose summary call takes 40 s, the session reopened 70 min after its last
response, the first key typed, the prompt entered after a delay. Typing was not disturbed: the editor showed "hello" and the working line
read "finishing the summary it started while you were away".

| first key -> Enter | wait before the first request, a2885b1 | 2cda8e1 | removed |
|---|---|---|---|
| 10 s | 40.0 s | 30.0 s ("waited 30.0 s") | 10 s (25%) |
| 30 s | 40.1 s | 10.0 s ("waited 10.0 s") | 30 s (75%) |

One summary call in every run. The head start removes exactly the typing time, up to the call's length. The formal bridge has no keystrokes,
so A3 does not move; the gap A3 shows for restarts after the cache died (+14, P1-1) is what this closes in a live TUI.

### Item 3 (cut inside the protected last turn): not shipped, design note

Judged unsafe for 0.3.0, for these reasons:
* It breaks a stated promise in four places at once: the guard (`guard.ts validateEdits`: a cut inside the last 2 user turns is refused
  except F2's `ahead`), PW in the spec, README rule 3 ("the current user turn and the previous one are protected"), and the summary itself.
  `skeleton` quotes users and lists the commands of the prefix, but a split turn's open work (tool calls still referenced by the tail,
  todos of this very run) would move into a 300-4,000-token narrative written by a separate call while the model is mid-task.
* The quality cost is unmeasured. The nearest measured precedent, F2 (a cut inside the previous turn, up to its final answer), cost +1-4
  lost items for 1-2% of cost in the simulator and is shipped off.
* The checker would need PW and NT restated, LW's `ahead` path extended, and a full rerun. Item 3 also asked for kept sizes on the user's
  3 sessions through `formal/replay/replay.ts`. TRIAGE does not name those files, I did not pick private sessions by guess, and with no
  implementation there is no "after" to report.

Item 5's turn boundary (below) already removes the case the 518K -> 273K session showed on 0.3.0's input: there the "last user turn" was
every run since 16:19, driven by extension messages. With driven runs ending the protected tail, the tail is the latest run.

Design, for after 0.3.0, reusing F2's machinery:
1. Trigger: a cold plan whose floor (the protected turns after folds) alone exceeds K x the cold target (K about 3).
2. Cut: `summarise(maxCut)` with maxCut up to the newest cut point such that:
   * the latest user message (or run starter) and everything after it stay verbatim;
   * the kept tail stays within the cold target;
   * the cut is at an assistant message whose tool calls are all answered after it (so no `orphanResult` / unanswered `toolUse` across
     the boundary; an unfinished tool call at the end of the branch stays in the tail);
   * it is marked like `ahead` (`split`) for the guard and PW.
3. Summary: Pi's split-turn form (`isSplitTurn`, turn prefix summary). The skeleton quotes the turn's prompt verbatim even though the prompt
   is in the kept tail, and the narrative is asked for the open work of the turn.
4. Gate: unchanged. The summary gate and the whole-plan gate with the call are the floor.
5. Tests: a 250K single-turn tail (cut lands in the turn, tail <= target, prompt verbatim); a tail ending in an unfinished tool call (the
   call and its missing result stay, the guard accepts it); the guard rejects a split that orphans a result. Then replay kept sizes before
   and after on named sessions.

### Item 4: the native outcome, and why the 518K summary went the draft path (007d1d1)

(a) Every summary notice's data records `native` ("ok", or the skip/off reason: "not idle", "no ctx.compact", "nothing to compact", "Pi's
compaction failed: ...", "... another handler at work", "summary not finished when the prompt came", "run started by an extension's
message ...") plus `nativeMs` and `nativeAskMs` when `compact()` ran. Only for run-plan summaries, not valve summaries. No new UI text.
Test: `invariants.test.ts` "item 4(a)".

(b) "Another handler at work" is now measured as askMs (handlers before ours) plus the time from our answer to the entry's own append
(`Date.parse(entry.timestamp)`), never Pi's work after the append. Test "item 4(b)": with 600 ms of post-append work, the old measure ended
the native path ("took 608 ms") and the new one keeps it. A handler that is really slow (400 ms before ours) still ends it.

**The suspected cause is not confirmed by measurement.** Pi's post-append work is small even on large branches:
* `buildSessionProjection` + token estimate: 16 / 28 ms on a 47 MB, 12,680-entry private session (read-only, aggregates only).
* The whole `ctx.compact()` in a real pi 1.1.0 TUI on a 747K-token, 6 MB synthetic branch: 8 ms, `askMs` 3 ms.

So on the user's 518K session the 250 ms was most likely spent in a handler. Item 6's `compaction-refusal-fallback.ts` fits that
(it runs Pi's own compact()). The fix is still right, but on the evidence it is not what turned native off there.

(c) "The summary does not fit this plan" now says which: "the plan at the prompt has no cut" or "... cuts elsewhere". I did not reproduce it
on this case. The draft path adopted the same prepared summary (one call), which needs the same cut key, so a key mismatch was not the
reason there.

### Item 5: runs an extension's message starts (P0, 007d1d1)

Pi's `sendCustomMessage(triggerTurn)` -> `_runAgentPrompt` emits `agent_start` but never `before_agent_start`.
* pi-zip now handles `agent_start`. When no `before_agent_start` preceded it, it runs the same start of run (`beginRun`): cancel the away
  timer and the key listener, `detectCold`, `runChecked = false`, retention, settle targets, adopt the prepared summary through the run plan.
* It never calls `ctx.compact()` there (it would abort the run); the notice records that reason.
* The run's first `context_with_system` awaits that start.
* There is no `COLD_CUSTOM` entry in rc030 (it went with the hold in 62a77a2), so nothing to write.

Protected tail: `TURN_START_ROLES` already had "custom", but only `piCanCompact` uses it. The planner counts turns in `buildBlocks`, which
counted user messages only, so every driven run belonged to the last typed prompt's turn. Now a custom message that follows a final answer
starts a turn. One that arrives mid-run (after a tool result) does not, and a prompt that directly follows its own starter is the same turn.

The formal bridge now fires `agent_start` after `before_agent_start`, as Pi does; the counts above include it.

Tests (all fail on 2cda8e1 except the double-start guard):
* `pi-integration.test.ts` "item 5": a driven run after > TTL gets the cold plan; a prepared summary is adopted with `compactCalls` 0; a
  prompt followed by `agent_start` starts once; a warm driven run plans as a warm prompt does.
* `plan.test.ts` "driven runs": turn numbering; six driven runs after one prompt are summarised up to the latest run (old: no cut at all).

### Item 6: a marker for other compaction handlers (007d1d1)

pi-zip's `ctx.compact()` passes `customInstructions: NATIVE_MARKER` ("[pi-zip native compaction: ...]"). A compaction carrying it is answered
while pi-zip's ask is open and cancelled otherwise, so Pi's default summariser never receives it as an instruction. Other instructions (a
user's `/compact focus`) are left alone. The README tells handler authors to return undefined when `event.customInstructions` starts with
`[pi-zip native compaction`. Test: `invariants.test.ts` "item 6".

### Deferred

* Item 3, as above.
* The A2 calibration class (now 4 / 22). It is P2-3; the new members are traces whose path moved at a switch.
* The cause of the 250 ms on the user's session (item 4b) is inferred, not observed. The notice now records it on the next occurrence.

## Round 4: the review of 4795af3 (P0-1, P0-2, P1-1..3, P2) and the model's blind spots

Branch rc030, on top of 4795af3. "Before" is 4795af3's `src`, "after" is this commit's, both under this round's checker (the same
bridge, spec and suites for both columns: the before column is re-run, not copied from round 3).

### What was fixed

| finding | fix | regression test (fails on 4795af3, checked by running the new tests against 4795af3's `src` in a worktree) |
|---|---|---|
| **P0-1** restart forgets driven cold wakes | `run.ts summarizedSince`: a custom message that follows a run's end is a return, judged by `detectCold` at its timestamp; a prompt and the custom messages Pi stores next to it are one return (the same rule as `buildBlocks`). | `restart.test.ts` "a run an extension's message started after a cold gap is a cold return" (4795af3: flag true); "... after a refused request is a return too"; "a prompt and the nextTurn message ... are one return" (a guard against counting the message twice; 4795af3 passes it because it ignores custom messages) |
| **P0-1, design** "one summary per warm stretch" never expires | The flag lapses once the context (after folds) has grown back to the size the stretch's summary started from (`regrowAt`, `plan.ts`; `summaryRegrow`, `run.ts`, stored as `details.regrow` on pi-zip's compaction entries and restored on resume; older entries have no size and keep the old rule). Growth since the summary is then at least what it removed, so a second summary gains what the first did; the law alone decides. `justEdited` (b2b) is unchanged. | `plan.test.ts` "noSummary lapses at regrowAt"; `restart.test.ts` "the size the summary started from is restored with the flag"; `pi-integration.test.ts` checks `details.regrow` on the entry |
| **P0-2** a prompt plus a custom message Pi appends counts as two turns | `buildBlocks`: a user message and a custom message that starts a turn clear `afterAnswer`. | `plan.test.ts` "a prompt followed by the custom messages Pi stores after it is ONE turn" (4795af3: 1 1 2 3 3 4 5 5), "the protected tail with a nextTurn message after each prompt" |
| **P1-1** keys that do not type a prompt start a paid call | The key listener no longer starts on a key: after each key (off the input path, `setImmediate`) it reads `ctx.ui.getEditorText()`; non-empty text that does not start with `/` starts the summary. Ctrl+C, Ctrl+D, Esc, arrows, `/quit`, `/resume` start nothing. Without `getEditorText` nothing is armed. | `pi-integration.test.ts` "keys that do not type a prompt start nothing" (4795af3: 1 call at Ctrl+D), "a command typed and erased, then a prompt" |
| **P1-2** key path and prompt disagree about a dead cache | Arming and the key's plan use `detectCold` with the learned survival (`coldNow`), and plan with that P(warm) and pastTtl. | `pi-integration.test.ts` "a cache learned to outlive its declared TTL" (4795af3: armed, 1 call) |
| **P1-3** same provider is not same tokenizer | `plan.ts sameTokenizer`: the same provider and either a vendor's own API (anthropic, openai, google, xai, zai, deepseek, moonshot, minimax, xiaomi; not azure or mistral, whose catalogs list other vendors' models) or the same recognised model family (Claude, GPT, Gemini, ...); unrecognised ids on a multi-vendor provider get the defaults. README sentence corrected. The formal bridge's two models are now `claude-m1`/`claude-m2` (one tokenizer, as its world has one c). | `calibration.test.ts` "a multi-vendor provider: ... GPT -> Claude falls back to the defaults" (4795af3 with a same-provider rule: c 0.9) |
| P2 first-key latency | Planning runs in `setImmediate`, never inside the input listener. | the first-keystroke test counts projections built inside the listener (4795af3: 1) |
| P2 swallowed driven run | An `agent_start` taken for a prompt's run checks the run's first `message_end`: a custom message there means the prompt failed before its run (no `agent_start` came for it) and this is a driven run; its start of run runs then, before the first request. | `pi-integration.test.ts` "a prompt that fails before its run starts does not swallow the next driven run's start" (4795af3: the warm plan of the stale start) |
| P2 flaky timing test | The remainder test now uses a 2 s call and bounds 200-1,800 ms (about 0.8 s of slack each way). | (not a behaviour) |
| P2 checks that do not discriminate | The two item-5 tests stay as they are (they document behaviour); the discriminating checks are the new ones above and the formal `drive` events below. | |

Found by this round's checker over the new events, fixed (both are part of "GC, TR, RD and protection must hold over them"):

* **A driven run after a failed request joined the failed run's turn.** `buildBlocks` ended a run only at a final
  answer; a refused or aborted request ends it too. The turn stayed protected and kept a 20K output from folding (cold return at
  52.6K against 40K). `traces/tr-drive-after-error.trace`; tests: `plan.test.ts` "a custom message after a failed or aborted request
  starts a turn", `restart.test.ts` (the same rule in `summarizedSince`).
* **A summary could not keep from a driven run's custom message.** pi-zip cut only at user
  and assistant messages, so the kept tail in front of a driven run began at the previous turn's final answer (60.6K left of a 40K
  target, 29K of it that answer). Pi's own cut points include custom messages (`compaction.js isCutPointMessage`); `plan.ts isCutBlock`
  and the guard now accept a custom message that starts a turn. `traces/tr-cut-at-drive.trace`; test: `plan.test.ts` "a summary before
  a driven run keeps from the custom message that started it" (4795af3: no cut).

Together: TR 4 -> 0 on the suite and 13 -> 6 on seed 7, against HEAD before these two fixes (the 6 left fail with every drive turned
into a prompt as well; see below).

### Replay of the regrowth rule (the review's acceptance condition)

`formal/replay/replay.ts` on the 3 recorded sessions (the `zipnotice` set: 6,160 requests, 277 user turns, 76 cold returns). The replay
now keeps `summarizedWarm` as run.ts does (every summary sets it, a cold one too; round 3's replay set it only for warm summaries), so
every column below was re-run with it. `PZ_NO_REGROW=1` runs the same source with the flag never lapsing. 0.2.8 cannot be replayed
(it lacks `wireTokensOf` and other exports the tool needs), so the comparison is 4795af3 against HEAD.

| source | summaries (cold / warm) | warm rewrites | rewritten K | wait s | cost M | lost |
|---|---|---|---|---|---|---|
| 4795af3 | 95 (42 / 53) | 43 | 5,314 | 4,014 | 139.74 | 21 |
| HEAD, flag never lapses | 95 (42 / 53) | 43 | 5,444 | 4,024 | 140.98 | 20 |
| **HEAD** | 95 (40 / 55) | 44 | 5,502 | 4,070 | **140.16** | 21 |

The regrowth rule lowers the estimated cost by 0.58% against the same source without it (2 more warm summaries, 2 fewer cold ones),
so it is accepted. HEAD is 0.30% above 4795af3: that is the turn-boundary fixes (P0-2 and the two TR fixes), which protect more of
session 1 (its prompts carry before_agent_start custom messages): one output fewer is lost there (18 -> 17), and the warm rewrites
of what the cold return now has to protect cost a little more (the NR "window slide" class, below). Three sessions, no interval.

### The model's blind spots, closed

**(a) Environment.** `model.rs` has two new events. `drive +gap` starts a run the way Pi 1.1.0 `sendCustomMessage(triggerTurn)` ->
`_runAgentPrompt` does (the bridge fires `agent_start`, appends the custom message, fires its `message_end`, then the first request;
never `before_agent_start`); it is a new user turn. `nextturn` is a custom message stored right after a prompt (the prompt's turn).
The bridge's fresh-process probe (RD) replays drives as drives and nextTurn messages with their prompt; A1 holds custom messages to
"never rewritten, never dropped by position". A new exhaustive family (3,584 traces: explicit and 128K-window worlds, depth 3, bodies
`q p b n` with `n` = a nextTurn message, specials `drive` (after 1 h), `drive-warm` (after 60 s), `drive-restart` (a cold wake, then a
restart)), and the random generator turns 12% of the runs after the first into drives and adds a nextTurn message to 10% of the
prompts (from a second stream seeded from the first, so the rest of each trace is what the seed drew before; about 69% of the seed-7
traces now contain one or the other). The suite is 33,924 exhaustive + 3,000 random = 36,924 traces.

**(b) Completeness.** New property **WL, a warm summary that pays is not withheld**: (a) every warm turn_end of a request that did
not fail asks the valve (a decision point exists), unless the request carried a fresh edit (b2b skip) or the run plan is persisted
there; (b) at a warm decision the one-summary flag constrained, the bridge re-plans with the flag lifted (`free`); if that plan has a
cut whose summary step and whole-plan step (the call priced) pass with Φ >= 1.25 and the real decision has no cut, the flag is
excused only while a pi-zip summary (or another extension's compaction) was made since the last cold plan and the context has not
grown back past the size it started from (10%). NT is restated to match: a second summary in one warm stretch is excused at the
room or once the context has regrown to the first one's starting size.

*Limit of WL:* its oracle is the real planner with the flag lifted. A pi-zip whose planner never proposes a summary (a broken
`planContext`) has the same oracle, so (b) cannot see it; (a) sees a valve that is never asked; LW, MP and TR see a broken law or
candidate search. A planner-independent oracle (the spec computing the best cut from the blocks and pricing it with `law.rs`) is
the next step and is not built.

**(c) Mutants** (`tests/mutants.rs`, each passes on this `src` and fails on the mutant; 29 mutant tests, all pass):

| test | property | mutant | trace |
|---|---|---|---|
| `wl_the_one_summary_flag_lapses` | WL | the flag never lapses (4795af3's rule) | `traces/wl-regrow.trace`: at request 80 the context is back at 100K, the summary started from 75K, a summary with Φ 5.3 is withheld |
| `wl_a_restart_knows_a_driven_cold_wake` | WL | 4795af3's restore (prompts only, no regrowth rule) | `traces/wl-drive-restart.trace` |
| `gc_a_driven_run_after_the_ttl_is_cold` | GC | the `agent_start` handler dropped (2cda8e1 and earlier) | `traces/gc-drive.trace` |
| `pw_a_nexturn_message_is_not_a_turn` | PW | P0-2 reverted | `traces/pw-nextturn.trace` |
| `tr_a_driven_run_after_a_failed_request_is_a_turn` | TR | a failed request does not end the run's turn | `traces/tr-drive-after-error.trace` |
| `tr_a_summary_may_keep_from_a_driven_runs_message` | TR | cut only at user/assistant messages | `traces/tr-cut-at-drive.trace` |

Counterexamples 4795af3 gives:

* **WL**, `traces/wl-drive-restart.trace` (P0-1): a warm summary at request 27, a drive after 1 h (planned cold: the live process
  clears the flag), a restart, then growth. The resumed process restores the flag; at request 81 "the one-summary flag is set, but pi-zip
  made no summary since the last cold plan (request 53); it withholds a summary that pays (Phi 5.30, context 100,509)". On seed 7 it
  also fails WL once in the "never lapses" class (shrunk to 59 events: at request 38 the context is 79.2K, the stretch's summary started
  from 71.9K, a summary with Φ 1.26 is withheld). The standard suite does not reach WL on 4795af3 (it needs a warm summary and then
  long low-growth stretches); the two regression traces do.
* **PW / NT / A3** (P0-2), shrunk to 7 events: `prompt; say 100; prompt +60s; say 60K; prompt +60s; nextturn; say 100`: the warm run
  plan at request 2 summarises the previous turn's 60K answer ("run summary keeps from ..., after the start of protected turn 2"); NT
  calls it a summary of 217 tokens of conversation into 10K, and the user waits for it (A3). PW fails in 1,579 suite traces and 3,194 of
  15,000 on seed 7.
* **TR** over drives: the two traces above (52.6K and 60.6K against 40K).

### Checker table

`pz-formal check --src SRC --suite standard --random 3000 --seed 1 --workers 26 --shrink 40` (36,924 traces, 307,635 requests) and
`--suite none --random 15000 --seed 7` (15,000 traces, 553,441 requests), both sources under this round's checker:

| property | suite 4795af3 | suite HEAD | seed 7 4795af3 | seed 7 HEAD |
|---|---|---|---|---|
| A1, I1, B2B, MP, WB, MPr, LW, G, W | 0 | 0 | 0 | 0 |
| A2 / A2r | 5 / 5 | 4 / 4 | 23 / 23 | 24 / 24 |
| A3 | 185 | **24** | 230 | **96** |
| RD / RDr | 0 / 0 | 0 / 0 | 1 / 1 | 2 / 2 |
| RC | 0 | 0 | 1 | 1 |
| PW | 1,579 | **0** | 3,194 | **0** |
| NR | 139 | 141 | 309 | 338 |
| NT | 73 | **0** | 6 | **0** |
| **WL** (new) | 0 | 0 | 1 | **0** |
| TR | 2 | **0** | 22 | **6** |
| GC | 0 | 0 | 1 | 1 |
| MH | 2 | 2 | 7 | 7 |

How to read the rest:
* A3 24 on the suite: 14 "cold return after a restart" (the P1-1 trade of round 3), 7 B2 warm returns, 2 returns before the timer, 1
  prepared summary not used; all classes from round 3. Compared trace by trace with HEAD before the two TR fixes, the fixes add 2 (a B2
  warm summary and a restart return whose path moved).
* NR +2 / +29: more is protected now (the turn fixes), and outputs the cold return protected are folded warm a prompt later: the
  deferred "window slide, folds" class (137 of 141).
* Seed 7, compared trace by trace: RD +1 (trace 589) and A2 +1 net are path shifts into existing classes. The RD class ("clock") also
  fails on 4795af3 on its shrunk form (`prompt; call npm 1K; say 100; switch; prompt +60s; fail error; prompt +60s; say 100`): after a
  switch whose first request was refused, the live process remembers the new model as the last one asked, a fresh one reads the branch
  (refused requests skipped) and sees the switch. TR 6, GC 1, RC 1, RD 2 on seed 7 were each re-run with every `drive` turned into a
  `prompt` and every `nextturn` removed: all still fail, so none is caused by the new events.

Tests at this commit: `bun test` 469 pass, 0 fail; `bunx tsc --noEmit` clean; `bun run build-check` clean; `cargo test --release` in
`formal/`: 10 unit + 1 bridge + 29 mutants pass, 0 ignored; `cargo clippy --release --all-targets` clean.

### (d) Coverage against recorded sessions

`bun formal/coverage/coverage.ts <dir of Pi session files>` reads every Pi session file under the directory
(read-only; counts only, no names) and maps each entry of the newest branch onto the model: 305 sessions, 49,408 entries.

| kind | model event | entries | sessions |
|---|---|---|---|
| tool result / request with one tool call | Call | 20,076 / 17,264 | 302 / 299 |
| request that answers | Say | 2,247 | 296 |
| run start: custom message answered before any prompt | **Drive** | 1,271 | 16 |
| run start: user prompt | Prompt | 703 | 23 |
| model_change entry / switch between requests | Switch | 362 / 44 | 305 / 26 |
| request failed / aborted | Fail error / abort | 205 / 26 | 29 / 8 |
| another extension's context_edit | Edit | 172 | 26 |
| steering | Steer | 141 | 12 |
| Pi's idle cache warming | World warming | 66 | 2 |
| another extension's compaction | Foreign | 9 | 2 |
| zip_recall result | Call recall | 7 | 3 |
| pi-zip's own folds / summaries, extension state entries | (pi-zip's decisions; not in the context) | 94 / 32, 2,037 | |

**Not expressible** (every kind the recorded sessions contain that the model cannot say):

| kind | entries | sessions | why it may matter |
|---|---|---|---|
| thinking blocks in a response | 13,748 | 285 | sizes only (the model's tokens are text); pi-zip never edits thinking |
| several tool calls in one request | 1,264 | 229 | a turn_end follows several results at once: the valve sees a bigger step than the model's one-call requests |
| custom message followed directly by another (several stored between runs or before one) | 1,573 | 4 | the turn rule (the first starts the turn) is unit-tested, not model-checked |
| custom message delivered mid-run (an extension's steer / followUp) | 518 | 40 | `Steer` is a user message; a custom one is the same turn by the same rule, but not in the model |
| system prompt or tool set changed mid-session | 407 | 290 | calibration's O moves with the system state (calibrate's `S`); the model has one system prompt |
| thinking level change | 340 | 305 | no effect on the planner |
| the session's first run started by a custom message (a subagent's task) | 284 | 284 | the model's first run is a prompt; every subagent session starts this way |
| custom message stored before the prompt that follows it | 5 | 2 | the model's `nextturn` follows its prompt (Pi 1.1.0's order); the other order is unit-tested |
| more than two models | 4 sessions | 4 | the model has two |
| entries on other branches (/tree, fork, rewind) | 1 | 1 | one linear branch |

Not visible in session files at all, so not counted: restarts and resumes (no entry), and the gaps a cache warmer bridges (only its
`usage` entries). No recorded session has the Pi 1.1.0 order "prompt, then its nextTurn message" (0 entries): the recordings are from
older Pi versions or from extensions that do not use nextTurn; P0-2 rests on Pi 1.1.0's source (`agent-session.js` prompt), not on a
recording.

### Deferred, with the reason

* **The refused request after a switch (RD "clock", 1-2 traces on seed 7, also on 4795af3).** The fix is one line (restore
  `lastModelKey` on a refused request, as `lastReqMs` already is), but it is outside this review and every source change costs another
  full checker run; listed for the next round.
* **A planner-independent oracle for WL**: see the limit above.
* **Item 3, A2 calibration class, NR window slide (B2 for folds), MH 2, A3 restart trade**: unchanged from rounds 2 and 3, for the
  reasons given there.
* **The two item-5 tests the review calls non-discriminating** are kept: they still state behaviour (one start per prompt; a warm
  driven run plans like a warm prompt). The discriminating tests are the new ones.
