# Changelog

## 0.4.2

- Summaries work again on long sessions. 0.4.0 and 0.4.1 capped the narrative call at its 4,000-token budget. A real model writes
  more than that when it merges a long previous narrative, CJK text needs about twice the tokens of the chars/4 estimate, and
  reasoning counts against the cap. On one real session every call hit the cap (59 in 3 hours, no compaction) while the context grew
  from 161K to 437K. The call may now write up to 16,000 tokens or the model's own output limit; the budget still sets what it is asked
  for and how it is priced.
- A failed narrative still makes a summary, as in 0.3.1: the deterministic sections, with the previous narrative carried and marked
  as possibly stale. 0.4.0 and 0.4.1 dropped it and called again at every trigger, so a narrative that kept failing kept the session
  from ever compacting. A reply cut at the cap is no longer retried as an identical call. The fallback is final for its cut, as in
  0.3.1: a transient error (overload, network, or a reply slower than the 240 s limit) no longer gets a new call at a later trigger.
- `/zip` shows how many narrative calls failed in this session and why the newest did. A call that threw records its error.
- New checks: integration tests with a provider that cuts a long reply at the cap, three mutants that reintroduce this bug, and a
  release check with a real model on a real session (`formal/live/narrative.sh`). The mutant runner now fails when a mutation site is
  missing; one existing mutant had silently stopped testing anything and is fixed.

## 0.4.1

- The typed-prompt door works again on Pi 1.2.0. A summary that is ready when you type a prompt goes in through Pi's own compaction
  from Pi's `input` event, where Pi 1.1.0 and 1.2.0 are both idle and wait for pi-zip before the run starts. 0.4.0 asked at
  `before_agent_start`, which Pi 1.2.0 counts as busy, so there the first requests of the run carried the whole old history (a cold
  return measured in a real TUI: 147,039 tokens instead of 28,278).
- What the prompt's input decided goes to that prompt's run only. A prompt that starts no run (another extension handles it, the model
  or its credentials are refused) leaves pi-zip as it was; a summary that already went in stays, with its exact "Compacted from" number.
  If another compaction goes in or another model is chosen between the prompt and its run, the run decides afresh. Two inputs that
  overlap ask for at most one compaction.
- A run an extension's message starts on Pi 1.2.0 (which now fires `before_agent_start` for it) begins once, as a driven run.
- All three doors (typed prompt, driven run, mid-run) are checked in a real TUI on Pi 1.1.0 and on Pi 1.2.0, each with Pi's exact
  "Compacted from" number.
- Correction to the 0.4.0 notes: 0.3.1 does not behave the same on Pi 1.2.0; with the door closed it carries the summary in the
  run's own requests.

## 0.4.0

Compared with 0.3.1:

- Five axioms now explain one shared decision: keep originals and recent work, price each edit, prepare slow work in the background, and learn from use. Warm edits use a rent guard: apply when rent pays the rewrite, or when the read savings pay and at least a tenth of the rewrite price has been paid in rent.
- Summaries run in the background in terminal sessions and sub-agents alike. A missing summary leaves the agent free to continue with eligible folds. Only a turn end at the compaction room can wait, 8,192 tokens below Pi's own threshold.
- Finished summaries are saved in the session and survive a restart. Every call stays in the totals, including unused calls and a call still running at exit. The one-unused-call budget and one-summary limit per warm stretch are removed; successive summaries must pay their prices.
- Summaries enter only through Pi's native compaction at a typed idle prompt or as the first draft at a turn end. Driven runs defer them to that boundary. Pi's displayed “Compacted from” number exactly matches the saved before-size at both doors.
- One producer and one production timer replace the separate warm-return path, fixed timer at 80% of the cache lifetime, warming fallback timers and first-key listener. The timer uses learned survival and call time, re-plans on the current branch, and never starts a call merely because an old session was opened.
- Protection and recall remain: the latest two user turns stay out of summaries; eligible previous-turn re-readable outputs may fold after a pause, and outputs at least 60 requests old may fold during long runs. Recalled originals are never folded again.
- The README gives the decision, model-qualified theorems, proof sketches and measured limits. Lean 4 + Mathlib checks the stated T2-T5 parts: 22 proved, one original statement refuted and corrected, zero missing. The remaining claims are paper proofs, supported separately by offline implementation checks. Proof files are excluded from the npm package.
- Known limit on Pi 1.2.0: Pi now counts a starting run as busy during `before_agent_start`, so the typed-prompt door stays closed and a summary ready at a typed prompt enters at the first turn end instead (same summary and exact number; the first requests still carry the old history). Pi 1.1.0 keeps both doors. (Fixed in 0.4.1; the claim that 0.3.1 behaves the same was wrong, see 0.4.1.)

## 0.3.1

- **A warm return's summary starts when the run ends** (rule A). When even a warm return (your next prompt while the cache is
  alive) would summarise, its summary is written in the background as soon as the run ends, not at 0.8 x TTL. A session restarted
  while its cache is alive starts it on the first key of a prompt.
- **No wait for a summary while the cache is warm** (rule B), unless the context is at Pi's compaction room. A finished summary goes
  in through Pi's compaction before the prompt (`Compacted from N` is pi-zip's size before); otherwise the request goes out
  unchanged, the summary is written in the background and a later turn end puts it in.
- At most one background summary started this way goes unused per warm stretch; the away timer replacing one does not count. Once
  it is spent, a warm plan whose cut moved changes nothing until the context reaches Pi's compaction room (no call, no wait).
  Every discarded or lost summary is booked when it is discarded (`pi-zip/unused-summary`), a running one at its estimated input.
- RPC mode (which binds a UI on Pi 1.1) gets these rules too; `-p` and `--mode json` decide as in 0.3.0: session and requests are byte
  for byte those of 0.3.0 with the new summary and placeholder format below.
- **Summaries: one merged narrative.** A summary of an earlier summary reads that summary's narrative next to the new
  conversation and writes one updated narrative (newer values replace older ones, finished todos are dropped), instead of
  carrying the old one as a clipped tail. On a 22-summary session, contradictions fell from 11 to 6 and superseded facts carried
  from 40 to 10. If the call fails, the previous narrative is carried, marked as possibly stale.
- **Summaries: about a third smaller,** with per-section budgets. User requests keep the first ones and the newest verbatim;
  the ones between are shortened (`≈`) and then counted. Recall questions on held-out sessions: 74% → 77% answered directly
  (paired +2.5 pts, 95% CI [−3.7, +8.6]).
- **Rows that can be told apart:** times as local `MM-DD HH:MM` instead of `turn N`; a `cd <dir> &&` prefix shared by every
  command is named once in the heading; look-alike rows show their first differing output line; a JSON document on one line shows
  its key fields (errors and status first).
- Learned cache-survival classes with no samples are dropped unless they were set explicitly.
- Fix: a display-only message an extension posts after the final answer (durable-subagents' "1 workflow was paused" at startup)
  made the plans made before your prompt (first key after a restart, the away timer) cut one turn later than the prompt's own plan,
  so the summary started early was thrown away and you waited for a second one in full. Your prompt joins that message's turn, and
  the early plans now count it so.
- Fix: the ledger's and `/zip` stats' `waitedMs` for a summary computed during the prompt of a session with a prepared plan was 0;
  it is now the time waited. Ledgers of the same session can differ from 0.3.0 there; sessions and requests do not.
- Fix: the warm plan that carries a summary Pi's compaction just put in no longer falls back to a plan on the compacted session
  (`native_mismatch`) when the real prompt comes out smaller than announced.
