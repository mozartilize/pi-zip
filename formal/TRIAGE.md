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

## Summary

| property | before (coldwarm) | rc030 now | rc030 +F2 now | coldwarm now | verdict |
|---|---|---|---|---|---|
| A1 nothing is lost | 0 | **0** | 0 | 0 | pass |
| A2 edit only when gone or it pays | 24 | **24** | 24 | 24 | (a) ×1 |
| A3 never in the way | 241 (+F2: 679) | **104** | 540 | 104 | (b) ×2 corrected; (a) ×1, +F2 (a) ×1 |
| I1 run stability | 0 | **0** | 0 | 0 | pass (2 bridge artefacts fixed earlier, see (c)) |
| RD restart determinism | 8,815 | **8,712** | 8,717 | 8,712 | (a) ×1 root cause (3 fields); (c) ×2 fixed |
| RC recall never refolded | 0 | **0** | 0 | 0 | pass |
| PW protection windows | 0 (+F2: 441) | **0** | 0 | 0 | +F2: (b) corrected |
| B2B no back-to-back warm rewrites | 7 | **7** | 7 | 7 | (a), same root cause as RD |
| MP monotone in P(warm) | 14 (+F2: 25) | **14** | 25 | 14 | (a) ×3 planner paths; +F2 (a) ×1 |
| NR no regret | 191 (+F2: 190) | **191** | 190 | 191 | (a) ×2 (B2 for folds, smallest cut); 1 not isolated |
| NT no thrash | 3 | **1** | 1 | 1 | (b) corrected; (a), same root cause as RD |
| TR target reachability | 9 | **9** | 9 | 9 | (a) ×2 calibration |
| LW / G / W (law as specified, harness fidelity) | 0 | **0** | 0 | 0 | pass |

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
| A3 | the user waits for a summary call only at Pi's compaction room | ... only at Pi's compaction room, **in the warm valve** (README rule 3: "at a cold return and in the warm valve alike"; A2 checks it pays), or **at a return a model switch made cold** (the cache dies at the prompt: nothing to prepare while away) | 20 valve + 117 switch (coldwarm) |
| PW (+F2) | a summary never cuts into the latest two user turns | ... except an F2 lookahead cut at a cold plan (`ahead`), which may reach the previous turn's **final answer** (the guard's own rule) | 441 (+F2) |
| NT | at most one summary per warm stretch of the real cache | ... per warm stretch **as pi-zip believes it**: a stretch ends at a return planned cold. Learning that a cache outlives its declared TTL is outside the spec | 2 |
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
