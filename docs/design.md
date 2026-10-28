# How pi-zip decides, and why

The theory behind pi-zip: its rules, the decision it computes, what is proved about that decision and what is not. The
[README](../README.md) has the short version.


pi-zip follows five rules. Its decisions come from one inequality and one guard. Each claim below names the model in which it is
proved and what it beats; the proof sketches below state the assumptions. Machine-checked cost-model statements are in [proofs/](../proofs/README.md); the implementation also has separate bounded conformance checks in [formal/](../formal/README.md).

## The axioms

1. **Nothing is lost.** Original session entries are never deleted or overwritten. Edits and summaries are appended, and anything pi-zip hides comes back word for word when asked. Only tool outputs are folded: user messages, tool-call arguments and thinking go out unchanged unless a summary replaces older history, and the system prompt and tool definitions are never changed.
2. **Recent work stays.** Your current and previous prompt, and the model's work on them, are never summarised. Their tool
   outputs stay in full, with two exceptions: outputs 60 or more model requests old and, after a pause, the previous prompt's
   outputs that can simply be re-read (files, read-only commands). Those are folded, and come back word for word when asked.
3. **Pay only for what pays.** pi-zip changes the view only when that saves more than it costs, counting the cache rewrite and
   the summary call.
4. **You never wait for pi-zip.** Slow work runs in the background and is used only when it is ready. The only wait left comes
   when the conversation is within 8,192 tokens of Pi's own compaction point, a few requests before Pi itself would stop to
   compact.
5. **Learn, don't ask.** Cache lifetime, price class, growth and call time are measured as you work. Decisions read the session branch, learned measurements and the clock; finished summaries survive restarts. A call still running at exit is lost and counted as unused.

## Notation

All prices are in *read units*: reading one cached token costs 1, and writing one costs $1+\kappa$. The class premium $\kappa$ is
11.5 for a 5-minute explicit cache, 19 for a 1-hour one, and 4 for an automatic cache. Summary output is priced at 50 read units per token for explicit caches and 20 for automatic caches. These are class ratios, not a model price table.

| symbol | meaning |
|---|---|
| $B$ | the request without an edit |
| $A$ | the request with the edit |
| $D = B - A$ | what the edit removes |
| $n$ | the new tokens this request carries (claim 2) |
| $p$ | the learned probability that the cache is still alive at this gap |
| $g$ | the context growth per request |
| $\eta$ | Pi's price per token of room (0 below the room) |
| $B_\text{eff}$ | $p\kappa A - (1-p)\kappa D - \eta D$: the expected rewrite price, net of the room credit |
| $R$ | rent on the plan's removable tokens since the last rewrite, including this request; reset on an applied edit or a request with $p<1/2$ |
| $W$ | the working view: $\min(\max(40\text{K},\ O + 20\text{K}),\ \text{room})$, where $O$ is system + tools |
| room | window − reserve − 8,192, with a 4,096-token minimum when the window is known; reserve follows Pi's model override or setting |
| $L^\circ$ | $\sqrt{2B/g}$: the law's cycle, in requests, under steady growth (claims 3 and 6) |

In claims 3-6, $B$ is the rewrite price $\kappa A$ of the one-stream model, not a request size.

**Words.**
* A *run* is one agent loop, from your prompt until the model stops. *Settle* is its end, when Pi goes idle.
* A *turn_end* is the end of one model turn inside a run. There Pi accepts *drafts*: entries pi-zip asks Pi to write into the
  session (a compaction, or folds).
* A *door* is the way an edit enters the session. Summaries have two doors: a typed idle prompt and a turn_end. Folds can also ride the first request before being saved at its turn_end.
* A *cut* is a point before which everything can be replaced by one summary. $c_W$ is the first cut that brings the view to $W$.
* A summary is *READY* when its call has finished, it was never applied, and its range is still the start of the conversation.
* *b2b* (back to back): no warm edit on the request right after an edited one.

## The decision in plain words

pi-zip plans the same eligible outputs at every cache probability. It folds the biggest outputs in each protection class until the working view is reached. Summary compaction is gated separately from folding with two thresholds (`PI_ZIP_SUMMARY_AT` overrides both): background preparation starts once the calibrated context after folds reaches `min(0.8 * room, 140,339)` (`140,339` is the 80% threshold of a 200K-window model), while summary application requires `min(0.8 * room, 400,000)` for the active model. On a 1M-window model, a checkpoint summary is prepared from `140.3K` upward without compacting the live context until `400K` (about 40% of its window). A 500K model applies from `~380.3K`, while 200K/272K models keep their `~140.3K`/`~197.9K` thresholds. A newer checkpoint is prepared only when the context after the existing one is again at the preparation threshold and the new cut covers at least a quarter of that threshold (`~35K`) more; a new cut ID alone does not re-read the prefix. Pi checks its compaction threshold before each request, before extension context hooks. After a switch to a smaller window, pi-zip answers that threshold compaction least loss first: (1) if folds alone fit 90% of the new room, it cancels Pi's compaction and this run's next request carries the folds; (2) a READY checkpoint whose summary plus the kept turns (after their folds) stays below the room compacts only its prefix; (3) a checkpoint still being written is waited for; (4) otherwise the cut the window needs is summarised at once, its narrative read by the previous model when its window is larger (the new model reads it when that call fails and the prefix fits); (5) when the two protected turns alone are too big, the cut may go up to the current user message, and only as many of the kept outputs fold, biggest first, as the window needs (each stays recallable). The economic law never refuses these cuts: the alternative is Pi's own summary or an overflow. Only when the summary retention contract plus the current request cannot fit the room does pi-zip cancel the compaction and abort the run, with the history intact. A switch that lands after Pi's check is caught in the context hook and aborted the same way. A cold cache or model switch makes an already eligible rewrite cheap; it does not authorize summarizing a context that still has room. A completed summary's call is already paid; application uses its actual size and the rent guard. Otherwise, the decision tries folds alone and asks the background producer for the missing summary.

The guard applies an edit when accumulated rent pays its expected rewrite price, or when the plain law pays and at least a tenth of that price has already been paid in rent. Production and the room wait use the plain law with the full call price. That price is charged even if the call goes unused; the product has no fixed unused-call budget and does not estimate a separate per-call probability of use. A warm decision immediately after an edited request takes no new edit, except for the room wait. This back-to-back rule does not block production.

## The algorithm

This pseudo-code describes the shipped defaults; sizes are calibrated tokens, prices are read units, and $g$ is bounded below by 1 in the law. A summary's planned size is $S(X)=\max(\min(\max(X/10,1{,}000),8{,}000),\text{previous summary size})$. The planner estimates its call price as $(1+\kappa)\max(X-\text{previous summary size},0)+\text{out}\min(S(X),4{,}000)$: an uncached read excluding the carried previous summary, plus the narrative's output at its 4,000-token budget. The budget is what the call is asked for and priced at, not the call's cap: real replies overshoot it (a merge on a long CJK session wrote 5,716-7,399 tokens, reasoning included), so the call may write up to 16,000 tokens or the model's own output limit, whichever is lower. Lists from the previous summary are carried by code; the narrative call merges the previous narrative with the new conversation.

```
law(B → A | p, call, η): D = B − A > 0
                        D²/(2g) + (η + (1−p)·κ)·D ≥ p·κ·A + call
guard(B → A | p, η):     Beff = p·κ·A − (1−p)·κ·D − η·D
                        fire iff D > 0 and
                          (Beff ≤ 0 or R ≥ Beff or (D²/(2g) ≥ Beff and R ≥ Beff/10))

plan(view, p, pause, Y):
  F = eligible outputs, class by class, biggest output first, until view after F ≤ W:
      older turns · previous turn's re-readables if pause · protected outputs ≥ 60 requests old
  if view after F ≤ W or view after F < min(0.8·room, 140,339.2): return (F, none, none)
  cW = first cut before the previous turn that brings the view to W (else deepest cut)
  c  = first cut from cW with X ≥ 2S(X) whose summary AND whole edit pass law WITH the call
  a  = none if view after F < min(0.8·room, 400,000) else deepest artifact in Y no deeper than c (or cW without c), still a prefix, with X ≥ 2S
  return (F, c, a)

decide(at):  # typed prompt, first request of a driven run, or turn_end
  p = learned survival since the last cache touch (0 after a model switch or without a touch)
  pause = return after absence ≥ requested TTL, or a model switch; never inside a run
  (F, c, a) = plan(view, p, pause, READY)
  E = none
  unless p ≥ ½ and the previous request carried an edit:
    E = first of F ∪ a, F that passes guard; first requests defer a to turn_end
  at a successful turn_end, judge view after E once:
    if still ≥ room:
      c′ = plan's own call-priced cut with pause=false and Y=empty
      if c′ exists:
        await running call if it is c′; else abort it and await its end, start c′, await it
        if the call succeeds and the decision is still valid: E = that plan's folds ∪ c′
  apply E through its door; do not reset rent until the rewrite actually goes out
  finalize this request's rent after checking cancellation:
    reset on an applied rewrite or p < ½; otherwise add the plan's removable tokens
    count carried folds once; never count an unproduced cut
  if no summary was applied, c was never produced, and no call is running: produce c

at settle (every mode):
  if no call is running: produce now what a return in 30 s would use
  unless the plan after a pause takes a ready or running summary:
    arm THE timer at lastTouch + t* − 1.5·L
    t* = first paying gap among TTL, TTL+1 s, survival edges and +1 s, and 7,200 s
    L = learned call time (0 until measured)
on timer: re-plan on the current branch at that gap; produce only if no call is running
on session open: rebuild state; arm only a future timer; never start a call
on Pi's cache-warming decision: observe the touch and re-arm; never answer the decision
on run start: clear the timer
on call completion: record pi-zip/summary; a narrative that failed, timed out or was aborted by the provider still makes a READY summary (the fallback); a call pi-zip aborted (replaced, switched off, shutdown) is not READY
on shutdown: abort the running call and record one estimated unused charge

doors: idle typed prompt (Pi's input event) → ctx.compact() with the ready answer and Pi's before-size
       idle (TUI, after a run of the process) → the same decision and compaction while Pi is idle; the next run carries it
       turn_end → compaction draft first, then folds and artifact records
       first request → folds only, persisted at its first turn_end
```

Outside the room, an aborted call must finish before its replacement starts; that handover stays in the background. A call pi-zip aborted, or one that threw, may be retried. A call whose narrative failed has produced its summary (the fallback), and a summary is never produced again for the same valid cut.

Eligibility also requires an output larger than 500 chars/4 tokens and a placeholder smaller than 90% of it. Recalled outputs stay unfolded. On automatic prefix caches, folds leave the first 8,192 calibrated tokens alone to preserve a cache-survival sample; summaries replace that prefix and are exempt. Folds inside a summary prefix are absorbed by the summary; folds already carried by a request keep their exact placeholders when saved. Structural guards preserve tool-call/result pairs. A failed turn saves folds its request already carried but makes no new edit. No-UI sessions use the same background production, at settle and on session open too; in a process that exits right after settle, a call settle started is aborted at exit and counted once as unused at its estimated input charge.

The room credit is zero below room. At or above it, $\eta=[(1+\kappa)X+\text{out}\,S+\kappa(B-X+S)]/(X-S)$ when $X>S$, otherwise zero. Here $X=\max(0,B-\text{keep})$, $S=\min(\max(X/10,1{,}000),8{,}000)$ without the previous-summary floor, and keep is the complete message tail covering Pi's 20K recent tokens. This estimates Pi's own compaction price for the room it would free. A ready summary passed over today stays available while its range is still the prefix; finished summaries are persisted, and each compaction consumes one produced call.

## Lookup cue

A new user request can name an earlier tool output by its exact handle, or by the same full path or URL that a call used. Then the first request of that user request carries one short request-local note before the model can repeat the call. The note names at most three outputs and asks for `zip_recall` instead of a repeated call. The match is exact and uses no model call. It reads the session branch, so it also finds outputs that a compaction took out of the view. It has no context-pressure gate and does not need the judge. A path counts only through the newest call on it. That call must not be an `edit` or `write` and must have returned a recallable output (no error, at least 1,000 chars), so an `edit` or `write` after a read gives no cue for the stale read or for a long diff report. A basename, a parent directory or a longer path does not count. An output shown in full in that request, and a `zip_recall` result, never count. The branch is scanned once per user request. A reference that does not fit is kept for the next request. The note requires `zip_recall` (tool recall mode). It is not persisted, is not a steer and does not mark a recall. `PI_ZIP_LOOKUP=0` turns it off.

## Optional judge

With `PI_ZIP_JUDGE=1`, a background chat call answers three independent factual questions per candidate: `<handle> <active> <finished> <lookup>`, with `Y`, `N` or `U` in each field and no citations. Code calculates priority: `lookup=Y` with an exact handle or full locator in recent user/assistant work becomes need if folded or hot if live; otherwise `active=Y` becomes hot (even when `finished=Y` or when a lookup reference is uncited); `N Y N` becomes cold; all other combinations and missing or duplicate rows stay warm. Switching files, age, silence and mere same-path calls do not establish `finished=Y`. The default planner still computes rent, summary cuts, production and rewrite permission without these labels. Only after selection passes the existing law does the planner substitute ranked folds: cold, warm, hot, then need. The replacement must save at least as many tokens as the original folds, including the last fold's overshoot. Carried placeholders stay byte-identical. Summary cuts and their prefix accounting stay unchanged. A cold label does not lower the protected-turn age.

The judge uses Pi's model registry, with at most one call in flight and a 30-second timeout. Planning never waits for it. An explicit thinking level is sent only when the model advertises support; otherwise the provider default is kept. With no explicit level, a model whose provider picks the effort when none is named (GitHub Copilot on the Responses API, or a thinking-level map with `off: null`) is asked for its lowest supported level above `off`. At the provider default the call can outlast the 30-second timeout. Session changes discard verdicts. Run end, model changes, shutdown and `/zip off` abort the call. Failed calls retain still-valid verdicts until their 20-request expiry. The latest user request changing invalidates the whole scope. A new explicit handle/path reference, a live/folded transition, or recall invalidates the affected verdict. Removed handles are pruned. Invalidation runs before boundary planning, including below pressure and cooldown gates. It also aborts an affected in-flight call and rejects its late answer. Two consecutive provider/parse failures stop calls for the rest of the run.

Supersession is exact and needs no model: an output is cold when the same tool later ran again with the same arguments (key order ignored), or when a later successful `edit` or `write` changed the file at its full path. A failed later call, or a read of another range of the same file, supersedes nothing. These labels are set at every boundary, below every gate, are not submitted, and a model reply cannot replace them; they go when the superseding output leaves the view. Evidence rows carry assistant prose, thinking text and `call <tool> <args>` lines, never signatures or raw provider JSON; a row cut by the window keeps its start, because a row cut at its start cannot be cited.

The judge and planner share fold candidate and placeholder-saving checks. Only new, invalidated or expired actionable candidates are submitted. Valid unsubmitted verdicts retain their original timestamps. Submitted omissions replace old advice with warm. Reuse bounds cost and staleness, but does not establish semantic correctness.

Retained catalogue rows keep their bytes and insertion order. Rows without a live or folded original are removed. Catalogue rows and their changing state share a hard 12K chars/4-token budget. Submitted candidates take priority over retained rows not needed by this call. Within that set, exact references take priority, then folded originals, then newest live outputs. Only selected rows are serialized. Eviction can change the cached prefix. The latest user request and a bounded recent-work tail follow. Candidate filtering does not filter that evidence tail.

Calls still require 80% context pressure. They need at least five stale eligible live outputs or a stale, explicitly cited folded original. The cooldown is eight requests unless selected output growth reaches 10K chars/4 tokens. Growth sums positive differences against per-handle submitted sizes, not a catalogue total that eviction can shrink. No candidates means no prompt serialization or call. Recall traffic is not evidence. A valid `N` may add a lookup note with at most three handles to a request already going out. Only handles actually shown are remembered in the session; unshown handles remain eligible within the verdict's 20-request lifetime. A note never starts a run or replaces an original output in place.

The transport uses validated `Y/N/U` fact lines (`protocol: facts-v1`). No schema-enforcement capability is verified for the configured chat endpoint, so no provider-specific schema parameter is sent. This is not independent-logit classification. The ledger reports submitted handles, reused verdicts, input size, growth, usage, latency and failures. [Offline replay](judge-replay.md) separates fresh-call consistency, annotated correctness and cost. Unit tests use mocked answers and make no model-quality claim.

## Narrative continuity and production cost

Durable epochs are appended from each new slice and merged only when over budget. The narrative call also receives at most 500 chars/4 tokens of previous active state, not the durable epochs. It must retain open work unless the new slice shows completion or supersession, and writes each open item as its own `- [ ] ` line. If it omits the active section, the previous state is retained. The active state is bounded by whole lines, both as call input and in the summary: open-work lines (`- [ ]` items, or lines that name a todo, blocker, pending item or next step) are kept before other lines, kept lines stay in order, and one closing marker counts the open items and other lines that did not fit. An open item can still be dropped when open items alone exceed the bound; the marker then says how many. This reconciliation is model-written, not a deterministic guarantee of semantic fidelity.

Format v2 (`PI_ZIP_SUMMARY_V2=1`) makes each epoch own its part of the conversation. An epoch holds the user requests made in it (numbered from the raw branch; verbatim except for skill references and emergency excerpts), the model's findings, the assistant's stated commitments and the tool evidence of its slice, with a count of what was left out. The next summary parses the previous one and carries every old epoch as written. Only prose is merged by a model call; requests, evidence and omission counts of merged epochs are joined by code. Each execution record names the request it was made under (`R<n>`, the raw-branch number). A result that arrives after its call was summarised belongs to that call: the call is found in the raw branch, not in the summary text. If the call's record is still in the summary, the result is added to it, so one execution never shows up twice. If that record was dropped for budget, the new epoch's row carries the result, still under the call's execution id. A tool result belongs to the newest call issued before it with its id; one message issuing an id twice leaves the association unresolved. Every consumer (fold placeholders, recoverability, summary rows, recall) uses that rule.

Format v3 (the default) replaces the epoch history with a state digest of numbered items: architecture, settled decisions, discarded approaches, test health and open work. Each narrative call only adds, edits, moves or drops items by number, a drop needs a reason, and the code carries every item the call does not name, so a fact the model forgets is not lost. Intent quotes name the item they are about. Evidence is limited to outputs the model selected or the digest names. Only the newest substantive requests stay verbatim; a request leaves the resident view only when the raw branch can return its exact text. Go-ahead-only requests are folded on the model's judgement alone, never on keywords, and only when they are short. Details: [details](details.md#format-v3-a-state-digest).

Skill command expansions in v2 request rows and narrative input are represented as `/skill:name`, with the user's trailing text unchanged. Only the complete Pi user-message envelope is abbreviated; quoted examples and malformed blocks are not. Such request rows are labelled `skill references`, not `verbatim`. Normalization happens before budgeting, including for old expanded requests carried from previous summaries. Raw session requests and recall remain unchanged. `skillReferenceCount` counts these rows; request character diagnostics measure the skill-reference representation rather than expanded skill bodies.

The same narrative call proposes assistant commitments as JSON lines in `COMMITMENTS`, each with `sourceHandle` and an exact visible assistant quote. Code validates the source role and NFC quote span, deduplicates and bounds the records, but does not prove that a selected quote is semantically a commitment. No language keyword fallback creates commitments when proposals are absent, malformed or the model call fails. Historical commitment rows are still carried unchanged.

The v2 narrative call also proposes up to eight `EVIDENCE` source/quote pairs: outputs supporting retained findings, final verification results for distinct scopes, or still-open blockers. Code accepts only exact NFC spans from tool results in that slice. Selected quotes replace generic hints and persist with their execution rows across compactions; selection does not prove the model's judgement of relevance. Missing or invalid proposals create no selected evidence.

A verified routine read is left out of the catalogue unless it is an error, selected evidence, or the findings, current state, commitment or intent names it by handle, path or whole file name. Selected evidence and references from the final text of every kept epoch pin rows under the soft budget; an error status alone does not. A file-name mention alone does not pin a successful edit/write acknowledgement, though an explicit handle, execution id or model selection can. The narrative must name the outputs its findings rest on, by tool and path or command. Current intent lists the user's own words, proposed by the narrative call and accepted only as an exact NFC substring of a user request. When the call fails, the previous quotes are kept. The plan's summary size is a soft target. Unselected, unreferenced evidence is dropped in priority order: successful edit/write acknowledgements, ordinary observations, then historical errors. Within each tier, oldest records go first; records are never partially cut. An old failure is not automatically an unresolved blocker. The hard bound is the compaction room: the largest summary that keeps the compacted view below the model's room. Above it, unselected evidence goes before selected evidence, then commitments, then the intent quotes (the requests keep those words), then old prose, then the current state. An epoch whose prose no longer fits at all keeps its requests and evidence.

If the user requests still exceed the room, internal overflow triggers deterministic emergency request compaction (E1): the emergency floor (active state, validated intents, newest epoch prose) is restored in priority order if minimal request excerpts still fit alongside it. Remaining room is distributed among requests via water-filling: short requests remain verbatim, while long requests keep head (2/3) and tail (1/3) of raw text with the standard middle omission marker and handle (`emergency excerpt · original <n> chars`). The summary header notes `Requests: emergency excerpts — N of M requests shortened to fit the window; recall by R<n>/handle returns exact text.` Later compactions rebuild verbatim requests from the raw session branch. Only when the minimal emergency representation + mandatory summary structure exceeds the room does the summary fail closed as `request-budget-overflow`, and no checkpoint or model switch uses it.

Bash execution rows retain test counts alongside exit status. Exit 1 is labelled `differences (exit 1)`, not an error, for direct `diff` commands and direct `git diff --exit-code/--quiet/--no-index` commands without `--check`, `--ext-diff` or `--textconv`. Compound shell commands and unsupported syntax remain conservative: a nonzero exit is still an error because it may come from another operation.

The production gate reserves tier-merge cost as well as the narrative call and bounded active-state input. It simulates tier selection with maximum-sized merged replies, at the smallest possible narrative budget, for at most three calls. Each merge has its own word-sized output cap (normally 1024–3000 tokens), bounded by the model limit. Reasoning counts toward that cap. So a reasoning model that reasons even when no effort is asked for gets `PI_ZIP_SUM_MERGE_REASONING_TOKENS` (default 4,096) more on each merge call, and the reserve prices it. These are models whose thinking-level map has `off: null`, GitHub Copilot models, and a model whose provider refused a request without reasoning. A ready summary's calls remain sunk cost and are not priced again. The ledger's `summary_merge_cost` record reports `predicted_merge_cost` and `actual_merge_cost` in USD; predictions use the model's listed input/output prices and actuals use provider-reported charges.

The proofs and measurements below describe the default policy, not judge classification quality or its additional API cost.

## What is proved

The numbered claims correspond to T1-T10. Lean 4 + Mathlib machine-checks **T2, T3, T4 (i)(ii)(iv), and T5 (i)(ii)(iv)(v)**. **T5(v) as first stated was refuted; the corrected form with persistence through the first guarded edit was proved.** The recorded gate is:

```text
CHECK: statements 23, proved 22, refuted 1, missing 0, gate PASS
```

See [proofs/README.md](../proofs/README.md) for the exact statements, model assumptions, recorded gate and trusted base. Re-run with the pinned Lean toolchain and Mathlib cache by running `cd proofs && ./check.sh` ([proofs/check.sh](../proofs/check.sh)). This release uses the recorded gate; it does not rebuild the large Mathlib cache. **T1, T6-T10 and the cited results 4(iii), 5(iii), 5(vi) remain paper proofs.** Some T2 lemmas overlap T6's stationary hazard calculation, but there is no separately audited T6 statement. A machine check proves the Lean statements; their match with the English was reviewed by hand. Neither that review nor the kernel proves summary quality or the whole product's optimality.


**1. When the cache is gone, folding is free, and so is a ready summary that spoils no later one.** A request after the cache
died writes the whole view anyway. Removing $D$ more tokens makes it cheaper by $(1+\kappa)D$. It makes no later request dearer,
*provided the addition cancels none of the later edits*. Folds never do. A summary does when a different summary, for example a
deeper one still being written, was going to be used later: applying one makes the others unusable. At $p=0$ the law's right side
is only the call price, so it always fires for folds and ready summaries, whose call is already paid.

<details><summary>Proof</summary>

Model: persistent edits; whether the cache is alive depends only on the gaps; the added edit cancels none of σ's later edits. Let
σ⁺ be σ plus one more edit at a dead request $n$. At every request $k$, σ⁺ hides at least what σ hides, which is where the
proviso is needed. So its view is no larger: $V_k(\sigma^+) = V_k(\sigma) - X_k$ with $X_k \ge 0$. At $n$ both schedules write
their whole view, $(1+\kappa)V_n$. Later, a dead request writes the view, an edited request writes its post-edit view, and a warm
request reads the previous view and writes the same new tokens. Each of these costs is non-decreasing in the view, so
$c_k(\sigma^+) \le c_k(\sigma)$. Among persistent-edit schedules with exogenous cache liveness and the stated no-cancellation proviso, applying the step at every dead request gives an optimal schedule that folds everything
available there.

*Without the proviso it fails.* A shallow ready summary applied at a cold return can cancel a deeper one still being written.
In an exact case the later requests then cost more at 39 of 41 requests. On the recorded sessions this never happened at a cold
return. ∎
</details>

**2. The inequality is a conservative form of the Bayes decision between "rewrite now" and "wait".** The Bayes rule is linear
in $p$ in the one-decision model: one fixed candidate, nonnegative call and room prices, $0\le n\le A$, $D>0$, $g>0$, and a continuation value independent of the current cache state. It fires below a threshold:

$$\Delta(p) = p\kappa (A-n) - (1-p)\kappa D - \eta D + \text{call} - \frac{D^2}{2g}\ \le 0
\iff p \le p^* = \frac{D^2/2g + (\eta+\kappa)D - \text{call}}{\kappa (B-n)}.$$

pi-zip's law is the $n = 0$ form: its right side is $p\kappa A$. It fires only where this rule fires, and slightly later: at
$A = 40$K, $n = 2.4$K and $D = 23.5$K its threshold is $p^* = 0.528$ instead of 0.548.

<details><summary>Proof</summary>

Firing costs $(1+\kappa)A$ + call whether the cache is alive or not. Holding costs $p(A+D+\kappa n) + (1-p)(1+\kappa)(A+D) +
\eta D$: alive, the request reads its cached part and writes its $n$ new tokens. The difference is
$p\kappa (A-n) - D - (1-p)\kappa D - \eta D + \text{call}$, minus the future reads the removal saves. Write the total saved-read value as $V(D)=D+F(D)$, where $F$ covers only future reads. Substituting the
EOQ cycle surrogate $V(D)=D^2/2g$ (one regrowth from 0 to $D$) gives $\Delta$. This substitution does not assert that $V-D$ is a nonnegative future saving for every $D$. With call and room prices zero, the warm fluid threshold is $D^*=\sqrt{2g\kappa(A-n)}$. It attains a positive-cycle optimum among fluid edit cycles when $n<A$; at $n=A$ the infimum is zero and no positive cycle attains it. Claim 3 treats integer requests separately. $\Delta$ has slope $\kappa (B-n) > 0$ in $p$. A wrong $p$
costs at most $\kappa B\,|\hat p - p|$. $V$ is a surrogate, with no general identification as the true continuation value across
cache probabilities. In the warm-forever fluid continuation model, the exact relative value on $0<D\le D^*$ is $(D^*D-D^2/2)/g$, at least the surrogate, with equality only at $D=D^*$. With positive end-of-stretch hazard, the discounted relative value is smaller than that warm-forever value on the same continuation region; this does not establish a surrogate upper bound. The decision the surrogate gives is exact, at two corners: $p = 0$ with no call (claim 1), and $p = 1$ with no call and
$\eta = 0$ (claim 3). ∎
</details>

**3. Under steady growth no schedule can do better (EOQ).** With growth $g$ per request and rewrite price $B=\kappa A$, every
schedule of persistent edits, even one that knows the future, has long-run average rent plus rewrite cost per request at least

$$\sqrt{2gB} - \frac{g}{2}.$$

The best cycle is the smallest $L$ with $L(L+1) \ge 2B/g$, which is exactly when break-even fires. The law fires at
$\lceil L^\circ\rceil$, $L^\circ = \sqrt{2B/g}$, which is optimal among integer edit cycles in this model or one request late (excess above the fluid lower bound, divided by the optimal integer rate, below
$1/(L^\circ(2L^\circ-1))$ for $L^\circ > 1/2$).

<details><summary>Proof</summary>

A cycle of $L$ requests costs $B + gL(L-1)/2 = L\,c(L)$ with $c(L) = B/L + g(L-1)/2$. Every schedule is a sequence of cycles,
so it costs at least $N \min_L c(L) - B$. By AM-GM, $c(m) \ge \sqrt{2gB} - g/2$. From
$c(L) - c(L+1) = B/(L(L+1)) - g/2$, the minimiser is the first $L$ with $L(L+1) \ge 2B/g$. Break-even's rent after $j$ requests
is $gj(j+1)/2$, so it fires there. The law fires at $j \ge \sqrt{2B/g}$. ∎
</details>

**4. Against an unknown future, no deterministic rule beats 2, and break-even reaches 2.** The model has one stream of removable
tokens, a fixed rewrite price $B$, a live cache, and a future chosen by an adversary. The comparator is the best hindsight edit schedule on the same arrivals. Break-even fires when the rent paid reaches
the rewrite price. It never pays more than twice the hindsight optimum. For every deterministic rule there is a
future that makes it pay $(2-\varepsilon)$ times the optimum. The plain law has no bound. For a fixed positive growth estimate
$G$, one burst $D = \lceil\sqrt{2GB}\rceil < B$ followed by the end costs LAW $B/D$ times the optimum, asymptotic to
$\sqrt{B/(2G)}$ as $B$ grows. An upper bound on the estimate alone gives no upper bound on the ratio. A law whose growth estimate stays high may never fire at all. Randomized rules reach $e/(e-1)$
(Karlin, Kenyon, Randall 2001; cited).

<details><summary>Proof</summary>

*Upper bound.* Split time into break-even's cycles. In each cycle break-even pays its rent ρ < B plus B. The optimum either
rewrites inside the cycle (≥ B) or carries at least break-even's pending tokens there, which is ≥ the cycle's rent ≥ B. So
break-even pays < 2·OPT on completed cycles. On the final segment it pays at most OPT. The total is at most 2·OPT, and strictly
below if break-even edits at least once.

*Lower bound.* Let one token of size δ arrive, then nothing. A deterministic rule is just "rewrite after waiting t requests".
End the stretch at that rewrite. The ratio is $(t\delta + B)/\min(B, (t+1)\delta) \ge 2 - \delta/B$.

*Checked* on small trees by exhaustive search over every deterministic rule: the game value is exactly $2 - 1/B$. ∎
</details>

**5. The guard bounds the law's worst case, at no measurable cost.** The model is the same as in claim 4: one stream of removable
tokens, a fixed rewrite price $B$, and a live cache. pi-zip fires when the rent reaches the rewrite price, or when the law holds
and the rent reaches a tenth of it ($\alpha = 1/10$). Whatever the growth estimate, this costs at most the bound below on every
instance, and strictly less if it edits at least once:

$$\Big(1 + \frac{1}{\alpha}\Big)\cdot \text{OPT} = 11\cdot\text{OPT}.$$

This is an upper bound for every estimate in the fixed-price model. Substituting a positive $B_\text{eff}$ into the local guard does not prove a competitive bound for varying rewrite prices.

* The bound is approached only by contrived futures: one burst at the law's threshold and then the end, with a rewrite price far
  above the growth estimate ($B > 2\hat g/\alpha^2$, about 480K tokens at $\hat g = 2{,}400$).
* It is approached for the law with a fixed growth estimate, and for the EWMA of removable arrivals with update weight 0.1 used
  in the proof.
* With an estimate under which the law never fires, the guard is plain break-even, with cost at most twice OPT on every
  instance and ratio below 2 whenever OPT is positive.
* Under steady growth, with a growth estimate at least the true growth, the law clause never fires before the break-even clause.
  So the guard has exactly the optimal integer cycle among edit schedules in claim 3's steady-growth, fixed-price model. It is no worse than true-growth LAW, allowing equality; LAW's cycle is optimal or one request later.
* On a burst where LAW fires immediately and remains true through the first guarded edit, with a stretch long enough to contain
  that edit, the first guarded cycle costs less than $(1+\alpha)$ times LAW's immediate cycle cost. Fixed or non-increasing burst
  estimates suffice.

Under that persistence qualification, this gives the stated burst consistency guarantee together with the robustness bound,
corresponding to the cited ski-rental robustness-consistency trade-off of Purohit, Svitkina and Kumar (2018); Wei and Zhang (2020)
show that the trade-off is optimal among ski-rental algorithms in their model (both cited). This cited optimal trade-off is outside the Lean scope.

<details><summary>Proof</summary>

The rule never fires while $R < \alpha B$, and always fires once $R \ge B$. In each of its cycles it pays $\rho + B$ with
$\rho < R$. The optimum pays at least $\min(B, R)$ there. So the ratio per cycle is $(\rho+B)/B < 2$ if $R \ge B$, and
$(\rho + B)/R < 1 + 1/\alpha$ if $\alpha B \le R < B$. The final segment costs at most OPT, so the total bound is non-strict on
every instance and strict when the rule edits at least once.

*Tightness.* For the law with a fixed estimate $\hat g$: one burst at its threshold, then nothing, ending at the rewrite, gives
$\to 1 + 1/\alpha$ as $B/\hat g \to \infty$. The same paper lower-bound construction uses the EWMA of removable arrivals with
update weight 0.1.

*Persistent burst.* Let the first burst have size $D$ and no further arrivals. If LAW holds through the first guarded edit, that edit occurs at the first request $s$ with $sD\ge\alpha B$, within the stated horizon. Earlier rent is $(s-1)D<\alpha B$, so the first cycle costs $B+(s-1)D<(1+\alpha)B$. LAW's immediate cycle costs $B$. If the estimate later rises enough for LAW to stop holding, this conclusion need not hold: the original unqualified statement was refuted.

*Steady growth.* $R = D^2/2g + D/2 \ge D^2/2g \ge D^2/2\hat g$ for $\hat g \ge g$, so the law clause never fires before the
break-even clause. ∎
</details>

**6. If the warm stretch can end any moment, wait a little longer.** If the stretch ends at rate $h$ per request, the optimal
cycle among renewal schedules in the fluid steady-growth model solves

$$\frac{g}{h^2}\big(hT - 1 + e^{-hT}\big) = B,\qquad T_h = L^\circ\Big(1 + \frac{hL^\circ}{6} + \dots\Big),\quad L^\circ = \sqrt{2B/g}.$$

The law's extra cost is $\varepsilon^2/72 + O(\varepsilon^3)$ with $\varepsilon = hL^\circ$.

* On the sampled grid of step 0.1 in $\varepsilon \in (0,40]$, the computed excess is at most 8.40 %; this is numerical evidence,
  not a universal bound for every $h$.

* At the hazards measured on the long recorded sessions it is 0.04-2.6 %.
* On short live tasks with a 5-minute cache ($h \approx 0.19$) it is about 8 %. There editing warm hardly pays anyway.

<details><summary>Proof</summary>

By renewal, a cycle of length $T$ costs $C(T) = \int_0^T g t e^{-ht}dt + Be^{-hT}$, and the expected total is
$J = C/(1-e^{-hT})$. Every policy is a sequence of cycle lengths; its cost telescopes to at least $\min_T J$. The sign of $J'$ is
the sign of $\frac{g}{h}(hT-1+e^{-hT}) - hB$, which is increasing, so the root is unique. Expanding in $\varepsilon$ around
$T = L^\circ$ gives the excess $\varepsilon^2/72$. ∎
</details>

**7. Lower $p$, bigger edit? For the plan, yes; for the applied edit, not always.** Each candidate fires on an interval of $p$.
If the plan has a summary cut at $p$, a lower $p$ has a shallower or equal cut; its planned view is at most the larger of $W$ and
the planned view at $p$. The applied edit can shrink, however. A summary produced earlier for a deep cut is passed over when, at a cold return, the plan's own cut moves shallower. A concrete case:
137K tokens are removed at $p=1$ and 30K at $p=0$. The variant "use the deepest ready summary before the protected turns" is
monotone only as long as the room wait does not fire at the higher $p$. When it does, the variant is not monotone either. The
variant is measured at −0.1 to −0.3 % cost and is not part of the default.

<details><summary>Proof</summary>

The law's slack $D^2/2g + (\eta + (1-p)\kappa)D - p\kappa A - \text{call}$ falls in $p$ with slope $-\kappa B$. So more cuts pass
as $p$ falls, and the first passing cut from $c_W$ moves shallower or stays equal. If $c_W$ reaches $W$, every cut past $c_W$ still
reaches $W$, because $X - S(X)$ grows with $X$; if no cut reaches $W$, $c_W$ is the deepest cut and the only candidate. A ready
summary deeper than the new cut is excluded by "no deeper than c". With the variant's rule, the candidates no longer depend on $p$, so the applied edit is monotone, except through the room wait. At the higher $p$ the room wait can replace
a small edit by a deep cut. At the lower $p$ the cheaper folds pass, keep the view below the room, and no wait happens: 82K
against 25K tokens in an exact case. ∎
</details>

**8. The fold plan hides the least.** The fold model assigns each item a saving $d_i>0$ and a need probability $q_i$, and minimises the sum of need probabilities subject to a required reduction. Within a class whose outputs have equal need probability, folding the biggest savings $d_i$ (output minus placeholder)
first needs the fewest folds, and so has the fewest expected needs. pi-zip sorts by output size. That is the same order when a
class's placeholders are equal, and on the recorded sessions the size order never folded more. This holds across classes too,
within one item's need probability, *assuming* the classes are ordered by need and well separated:

$$q_c/\min_{i \in c} d_i \le q_{c+1}/\max_{i \in c+1} d_i.$$

Each decision's budget $W$ corresponds to a price on a lost item (LP duality). That price depends on how far the view exceeds
$W$, so a fixed $W$ is a budget, not one fixed price.

<details><summary>Proof</summary>

The $k$ largest savings cover at least what any $k$ items cover. Under separation, the class order is the order of $q_i/d_i$,
which solves the fractional problem. The integer plan exceeds it only by its last fold. The dual price of the budget is the ratio
of the marginal item, which moves with the budget's excess. ∎
</details>

**9. Nobody waits for pi-zip except near Pi's own compaction point.** The only decision path that awaits a model call is the turn_end
clause "still ≥ the room". The room lies 8,192 tokens below Pi's own threshold.

* Above the threshold, Pi would run its own compaction call if pi-zip did nothing.
* In the band below it, the wait comes a few requests early. On the recorded 128K-window sessions every such wait fell in that
  band.

A ready summary goes in through Pi's compaction with pi-zip's own answer, which needs no model call (milliseconds).

<details><summary>Proof</summary>

By inspection of every handler: decisions are pure functions; production starts a call without awaiting it; the timer only
starts calls and never writes; opening a session and Pi's cache-warming hook only arm the timer. ∎
</details>

**10. At most one summary call runs, and at most one production timer is set.** Every start checks that nothing is running. The room wait
awaits the running call when it is the one needed, and otherwise stops it before starting its own. The timer is a single slot,
cleared when a run starts. The native-compaction deadline and deferred notice rendering use separate short timers; neither schedules a summary call.

<details><summary>Proof</summary>

By induction over events. Decision, settle and timer starts are guarded, and the room wait awaits or stops the running call before it starts
one. Only the end of a run, opening a session and Pi's cache-warming hook arm the timer, each replacing the slot. ∎
</details>

## Measured inputs and offline results

The economic measurements are cache survival, cache class and tier, growth, token scale, summary size and call time. Growth starts at 2,500 tokens per request and uses an EWMA with weight 0.1 of unedited prompt deltas, each capped at the p90 of the last 20 deltas; a restart rebuilds it from the branch. Three quality inputs have a different status:

| input | evidence and how it enters |
|---|---|
| Summary quality | A hidden-item detector and a small re-summary chain test estimate losses; neither proves narrative fidelity. The planner uses summary size, protected cuts and the $X\ge2S$ rule. |
| Price of a lost item | Never measured: it is a value judgement replaced by the working-view budget $W$. Its implied marginal price varies with the decision. |
| Per-item need rates | Not observable before use: protection classes, 60-request age and the 500-token minimum stand in for them. Claim 8 assumes ordered, separated classes; that separation is not tested per item. |

This is the policy above on 297 recorded sessions, with paired session bootstrap (2,000 resamples pooled, 1,000 per stratum), against the corrected v0.3.0 model. It describes the guarded policy shipped in 0.4.0. It is a
simulation; no API was called.

| prices, cache life | cost × corrected v0.3.0 [95% CI] | lost-item difference [95% CI] | waiting for summaries |
|---|---|---|---|
| Anthropic, 5 min | 0.972 [0.954, 0.990] | -1.8 [-7.5, +2.0] | 0 (reference: 18.1 min) |
| Anthropic, 1 h | 0.991 [0.970, 1.012] | +2.5 [-1.2, +8.4] | 0 (reference: 21.6 min) |
| GLM, 5 min | 0.986 [0.974, 0.999] | -1.2 [-3.5, +0.5] | 0 (reference: 28.9 min) |
| GLM, 1 h | 0.962 [0.932, 0.996] | +2.5 [-1.3, +8.8] | 0 (reference: 32.0 min) |

No cell of 4 price/cache regimes × 8 session strata has a cost-ratio confidence interval wholly above 1 or a lost-item-difference interval wholly above 0. These detector estimates do not measure summary fidelity. The guard of claim 5 changes the cost by
−0.31 % to +0.21 % per regime and leaves lost items unchanged.

## Honest limits

- **Optimal means optimal in a model.**
  - Claim 3 holds under steady growth.
  - Claims 4-5 hold for one stream of removable tokens at a fixed rewrite price, with a live cache.
  - Claim 6 holds for a memoryless end of the stretch.

  No optimality is claimed for the whole product: planner, producer and quality together.
- **The worst-case bound is 11 times.** That is weak; it guards against a burst-then-stop pattern and a stalled law, not against
  ordinary sessions.
- **The law's value of a removal, $D^2/2g$, is a surrogate.** Only the decision it gives is exact, and only at two corners: a
  surely dead cache with no call to pay, and a surely live one with no call and below the room.
- **The law counts this request's new tokens as if they were read** (claim 2). The exact rule fires a little earlier; pi-zip's
  errs on the side of waiting.
- **A dead cache makes folds free, not every summary** (claim 1). A ready summary can spoil a deeper one still being written. On
  the recorded sessions this never happened at a cold return.
- **The applied edit is not monotone in $p$** (claim 7). On the recorded data pi-zip applies the smaller edit at 3-17 of 11,214
  decisions per regime. The monotone variant is monotone only away from the room wait.
- **Summary quality is not proved.** What a summary keeps, and what is lost when a summary is summarised again, are measured only
  by a hidden-item detector and a small chain test.
- **The price of a lost item is never measured.** Folding uses the working view $W = 40\text{K}$, while summary compaction waits until the calibrated post-fold context reaches `min(80% of Pi's compaction room, 400K tokens)` (`summaryGate` in the session ledger records `before`, `afterFolds`, `target`, `threshold`, `prepareThreshold`, `room`, `eligible`, `prepareEligible`, `reason` and, for an unapplied checkpoint, `checkpoint: { key, after, advance, refresh }` for tuning; switches log `model_switch` with its `stage` (`folds`, `ready`, `waited`, `summary`, `rescue-cut`, `rescue-folds`, `too-big`) and `model_switch_blocked`).
- **Per-item need rates are not observable.** They enter as classes (the protection window, 60 requests, 500 tokens) and as
  claim 8's ordering assumption.
- **κ is a class ratio, not your price table.** A factor-2 error costs at most 6 % in the EOQ model.
- **The typed-prompt door depends on Pi's `input` event.** pi-zip asks for the native compaction in its `input` handler, where
  Pi 1.1.0 and 1.2.0 are both idle and wait for the handler before they start the run (1.2.0 counts the run as busy from
  `before_agent_start` on, so 0.4.0's door there stayed closed). A prompt typed while a run streams (a steer or follow-up) never
  opens it, and an input that comes while pi-zip still handles an earlier one is skipped. A steer or follow-up queued while Pi is
  idle (RPC, Pi's queue after a compaction) reaches extensions exactly like a prompt, so it can open the door too. A prompt that
  starts with `/` is priced from its raw text before Pi expands the template or skill (so is a prompt another extension rewrites
  after pi-zip): that decision, and the first request's plan it hands to the run unchanged, are off by the size of the
  expansion; later decisions read the real sizes. If another compaction goes in or another model is chosen before the run
  starts, the run reads its own start instead. If no run follows (another extension handles the input, or Pi refuses the
  model), a summary that went in stays in the session (pi-zip's own, with its exact size before) and nothing else of that
  prompt is kept. All three doors are checked in a real TUI on Pi 1.1.0 and 1.2.0.
- **The idle door.** A run an extension's message starts (`sendMessage` with `triggerTurn`) has
  no `input` event, so without it a summary ready for that return waits for the run's first turn_end. By then the first request
  has rewritten the whole folded context, and at the next turn_end the cache is warm again, so the law usually declines the
  summary. The idle door asks the typed door's decision, unchanged (decideEdits "native" at the return's P(warm), no prompt yet),
  while Pi is idle: when a summary finishes, then at each later moment that P(warm) changes (the learned curve's bin edges and
  the TTL after the newest touch). What it takes, the next run carries from its first request, whoever starts it. Research round
  5 had dropped this variant (pi-tricks §1b, variant 4) because the simulator only models typed returns, where it equals the
  typed door. On the recorded sessions of 10-12 to 10-14 it would have applied 30 summaries that cold extension-driven runs
  wrote around (about 1 % of the spend at list prices). It runs only in the TUI, which queues what is typed while Pi compacts
  (RPC refuses such a prompt), and only after a run of the process: opening old history never compacts it. It keeps the typed
  door's deadline, so a slow foreign handler's own summary call is cancelled, but only while no run is announced: Pi's abort
  would end such a run as well, so a run pi-zip has seen start waits for the compaction instead (a run Pi has begun whose
  announcement an earlier extension's handler still delays at the deadline is the one left exposed). pi-zip makes no extra
  call for it, so it has no setting; `PI_ZIP_IDLE_DOOR=0` is an emergency off switch.
- **Offline is not live.** The model's behaviour after a fold comes from a calibrated simulator, and the cells to watch live are
  one-hour-cache main sessions.
