# Changelog

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
- RPC mode (which binds a UI on Pi 1.1) gets these rules too; `-p` and `--mode json` behave as in 0.3.0, session and requests byte
  for byte.
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
- Fix: the ledger's and `/zip` stats' `waitedMs` for a summary computed during the prompt of a session with a prepared plan was 0;
  it is now the time waited. Ledgers of the same session can differ from 0.3.0 there; sessions and requests do not.
- Fix: the warm plan that carries a summary Pi's compaction just put in no longer falls back to a plan on the compacted session
  (`native_mismatch`) when the real prompt comes out smaller than announced.
