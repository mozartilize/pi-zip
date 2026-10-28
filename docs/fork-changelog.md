# Fork changelog

Upstream releases remain in [CHANGELOG.md](../CHANGELOG.md).

## Unreleased

- Rebased the fork onto upstream 0.4.15, isolated fork policy in dedicated modules, restored the upstream summary implementation and removed the fork-v1 emitter. Only v2/v3 are emitted; existing summaries remain readable.

- Format v3 is the new default summary format (`PI_ZIP_SUMMARY_V2=1` selects format v2): a state digest instead of a
  growing history. One narrative call per
  compaction updates five sections from the new slice: architecture, settled decisions,
  discarded approaches, test health and open work, as numbered items (`- [i12] …`). The call replies with operations only
  (`ADD`/`EDIT`/`MOVE`/`DROP iN: reason`); every item it does not name is carried word for word, and a drop without a
  reason changes nothing. Intent quotes come only from the slice's requests or the previous intents, never from a
  request judged go-ahead only, and each names the digest item it is about (`about i37`). Evidence lists only outputs
  the model selected (up to 20 a call) or the digest names. The room after the digest is filled up to the plan's target, at
  most 8,000 tokens (`PI_ZIP_SUM_V3_TARGET`): the newest requests verbatim (at least 8, `PI_ZIP_SUM_V3_RECENT_REQUESTS`;
  more requests take up to half of the free room first), then evidence carried from earlier summaries, newest first. Older requests become `digested`
  ranges, and only when the raw branch can return their exact text. Requests the model judges to be go-ahead only
  become `go-ahead only` ranges. The judgement is by meaning and has no keyword fallback; requests over 200 characters
  are never folded. A previous v2, v1 or Pi summary migrates: its prose is split into numbered items. A failed call
  carries the previous digest, marked possibly stale. A summary over the room is still used (diagnostics `overRoom`), never
  failed as `request-budget-overflow`. On a forked 184-request session (previous v2 summary 95,576
  characters) one call wrote a 7,997-token v3 summary: 60 digest items (the migrated v2 prose kept, 16 added, 2 edited,
  1 dropped with a reason), 43 verbatim requests and 34 evidence records.
- New placeholders say when they were folded: `[folded by pi-zip at 10-11 02:44 UTC · …]`, the newest message time of the view the
  fold was planned from (session time, not the clock, so a re-plan of the same view renders the same bytes). Every earlier request
  showed the output in full. Existing placeholders keep their bytes; the label is fixed-width, so fold pricing is unchanged.
- Format v2 activity hints no longer pick identifiers that merely contain "error" (`isError?: boolean;`), separators (`===`) or
  source lines from code listings; a source listing has no `Evidence:` line (its call head and handle identify it), while
  outcomes, located hits (`src/a.ts:12: …`), commit lines and test counts stay. On one real session summary this removed 24 of
  88 hints, all code or separators. Placeholder key lines and format v1 rows are unchanged.
- Format v2 omits the redundant `verbatim` qualifier on ordinary request rows; existing summaries with the qualifier
  remain readable. Excerpts must shrink the complete rendered row, including qualifiers and quote prefixes, not just
  its body. Original lengths are measured before resident-view compression when that source text is available.
- Format v2 gains E2: eligible old epochs become compact archived ranges when minimal excerpts cannot fit. The newest
  request-bearing epoch stays resident. Only branch-verified identities may be newly archived; legacy and unverified
  text is not discarded. Ranges preserve gaps and all ordinals, including spans above 512 requests, and restore available
  raw text on the next compaction. Missing spans stay archived, never reported as verbatim. Invalid range bounds and
  counts are rejected without expansion. Recall instructions respect file-only mode.
- An empty active state no longer suppresses validated intents or newest prose under emergency budgeting. Terminal
  failures keep `request-budget-overflow`, with section-level token diagnostics for both successful and failed cuts.
- The narrative call reads a Pi `<skill>` expansion in full again, so constraints a skill carries can reach the durable
  prose and the state; summary request rows keep the `/skill:name` short form and remain recallable.
