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

pi-zip plans the same eligible outputs at every cache probability. It folds the biggest outputs in each protection class until the working view is reached. If that is not enough, it looks for a summary cut before the two protected turns, pricing both the summary itself and the whole edit with its call. A completed summary's call is already paid; application uses its actual size and the rent guard. Otherwise, the decision tries folds alone and asks the background producer for the missing summary.

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
  if view after F ≤ W: return (F, none, none)
  cW = first cut before the previous turn that brings the view to W (else deepest cut)
  c  = first cut from cW with X ≥ 2S(X) whose summary AND whole edit pass law WITH the call
  a  = deepest artifact in Y no deeper than c (or cW without c), still a prefix, with X ≥ 2S
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
       turn_end → compaction draft first, then folds and artifact records
       first request → folds only, persisted at its first turn_end
```

Outside the room, an aborted call must finish before its replacement starts; that handover stays in the background. A call pi-zip aborted, or one that threw, may be retried. A call whose narrative failed has produced its summary (the fallback), and a summary is never produced again for the same valid cut.

Eligibility also requires an output larger than 500 chars/4 tokens and a placeholder smaller than 90% of it. Recalled outputs stay unfolded. On automatic prefix caches, folds leave the first 8,192 calibrated tokens alone to preserve a cache-survival sample; summaries replace that prefix and are exempt. Folds inside a summary prefix are absorbed by the summary; folds already carried by a request keep their exact placeholders when saved. Structural guards preserve tool-call/result pairs. A failed turn saves folds its request already carried but makes no new edit. No-UI sessions use the same background production, at settle and on session open too; in a process that exits right after settle, a call settle started is aborted at exit and counted once as unused at its estimated input charge.

The room credit is zero below room. At or above it, $\eta=[(1+\kappa)X+\text{out}\,S+\kappa(B-X+S)]/(X-S)$ when $X>S$, otherwise zero. Here $X=\max(0,B-\text{keep})$, $S=\min(\max(X/10,1{,}000),8{,}000)$ without the previous-summary floor, and keep is the complete message tail covering Pi's 20K recent tokens. This estimates Pi's own compaction price for the room it would free. A ready summary passed over today stays available while its range is still the prefix; finished summaries are persisted, and each compaction consumes one produced call.

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
- **The price of a lost item is never measured.** It is replaced by the working view $W = 40\text{K}$, calibrated on recorded
  sessions.
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
- **Offline is not live.** The model's behaviour after a fold comes from a calibrated simulator, and the cells to watch live are
  one-hour-cache main sessions.
