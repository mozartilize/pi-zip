# Changelog

## 0.4.0

Compared with 0.3.1:

- Five axioms now explain one shared decision: keep originals and recent work, price each edit, prepare slow work in the background, and learn from use. Warm edits use a rent guard: apply when rent pays the rewrite, or when the read savings pay and at least a tenth of the rewrite price has been paid in rent.
- Summaries run in the background in terminal sessions and sub-agents alike. A missing summary leaves the agent free to continue with eligible folds. Only a turn end at the compaction room can wait, 8,192 tokens below Pi's own threshold.
- Finished summaries are saved in the session and survive a restart. Every call stays in the totals, including unused calls and a call still running at exit. The one-unused-call budget and one-summary limit per warm stretch are removed; successive summaries must pay their prices.
- Summaries enter only through Pi's native compaction at a typed idle prompt or as the first draft at a turn end. Driven runs defer them to that boundary. Pi's displayed “Compacted from” number exactly matches the saved before-size at both doors.
- One producer and one production timer replace the separate warm-return path, fixed timer at 80% of the cache lifetime, warming fallback timers and first-key listener. The timer uses learned survival and call time, re-plans on the current branch, and never starts a call merely because an old session was opened.
- Protection and recall remain: the latest two user turns stay out of summaries; eligible previous-turn re-readable outputs may fold after a pause, and outputs at least 60 requests old may fold during long runs. Recalled originals are never folded again.
- The README gives the decision, model-qualified theorems, proof sketches and measured limits. Lean 4 + Mathlib checks the stated T2-T5 parts: 22 proved, one original statement refuted and corrected, zero missing. The remaining claims are paper proofs, supported separately by offline implementation checks. Proof files are excluded from the npm package.
- Known limit on Pi 1.2.0: Pi now counts a starting run as busy during `before_agent_start`, so the typed-prompt door stays closed and a summary ready at a typed prompt enters at the first turn end instead (same summary and exact number; the first requests still carry the old history). 0.3.1 behaves the same on 1.2.0. Pi 1.1.0 keeps both doors.

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
