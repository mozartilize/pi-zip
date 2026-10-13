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

## Earlier live results

These results describe the versions named in the table, not a live evaluation of 0.4.0. Live A/B runs on the same coding tasks (4 task templates × 4 seeds, the user away between prompts as stated), paired by task, 95% bootstrap intervals. BC = [billion-context](https://github.com/ranxianglei/billion-context) with its defaults.

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
- Short sessions with small contexts have little to save. A warm cache can still benefit from a large edit when its future read savings pay for the rewrite.

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

These lines are saved in the session, so they are still there after a restart, but they are never sent to the model. On narrow terminals the time goes first, then the words; the numbers always stay. A summary still shows up as Pi's own `[compaction]` block as well; the ƶ line next to it tells you who made it. The ƶ sizes use calibrated provider tokens, the same scale as Pi's context meter (which adds the newest reply's output). Pi's `Compacted from N tokens` is exact for Pi's own before-size at either summary door: a native compaction while Pi is idle at a typed prompt, or the first compaction draft at a turn end. pi-zip records that same before-size. Its calibrated planning estimate can differ from Pi's meter; exact agreement between the displayed number and the saved compaction does not make the token estimate exact.

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
ƶ pi-zip  on  older context gets zipped when the savings pay for the rewrite · /zip
ƶ pi-zip  on  a tool allowlist hides zip_recall · zipped outputs are read back from files in ~/.cache/pi-zip/recall
ƶ pi-zip  reread-only  a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more
ƶ pi-zip  paused  billion-context also manages context, so pi-zip only guards requests · to use pi-zip: pi remove the other one
```

The first one appears once per machine. At the compaction room, Pi's working line explains that the context is close to the window while the summary finishes. Everywhere else the agent continues while production runs in the background. `/zip` prints a small card into the transcript:

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

The chart shows how likely the cache is to survive a return. That probability prices the rewrite: edits need larger savings while the cache is warm; when it is certainly gone, eligible folds add no rewrite cost. Across (`away`) is how long you were gone, from 30 s to 2 h on a log scale. Every dot is one time you came back after that long: a filled dot above the axis is a time the cache was still there, an empty one below it a time it was gone, so the picture is your own history with this model, and a few gone samples take only a row or two. A column shows at most 4 dots a side; beyond that it shows 3 dots and the number at the far end of the stack (`12` = twelve times in that gap range). The axis is solid up to the longest gap that was (nearly) always safe, dashed while it is not sure, thin after it is mostly gone; the sentence under it says the same in words (`usually still there` when even the safe part had some misses). The counts are the learned ones, kept with older evidence halved after 16 newer observations of the same gap range, so they can be a little below the number of times you actually came back. Until something is learned there is no chart, one line only (`expires after ~5 min idle · a chart appears once you come back after a break`, from the cache lifetime the requests ask for). The chart needs 72 columns; where the legend does not fit beside it, it moves to one line under it, and in a narrower terminal only the sentence is shown. Notices state facts (how long you were away), not guesses: whether the cache really had expired is read from the provider's reply afterwards, so a wrong guess is not repeated.

## How pi-zip decides, and why

pi-zip follows five rules. Its decisions come from one inequality and one guard. Each claim below names the model in which it is
proved and what it beats; the proof sketches below state the assumptions. Machine-checked cost-model statements are in [proofs/](proofs/README.md); the implementation also has separate bounded conformance checks in [formal/](formal/README.md).

### The axioms

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

### Notation

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

### The decision in plain words

pi-zip plans the same eligible outputs at every cache probability. It folds the biggest outputs in each protection class until the working view is reached. If that is not enough, it looks for a summary cut before the two protected turns, pricing both the summary itself and the whole edit with its call. A completed summary's call is already paid; application uses its actual size and the rent guard. Otherwise, the decision tries folds alone and asks the background producer for the missing summary.

The guard applies an edit when accumulated rent pays its expected rewrite price, or when the plain law pays and at least a tenth of that price has already been paid in rent. Production and the room wait use the plain law with the full call price. That price is charged even if the call goes unused; the product has no fixed unused-call budget and does not estimate a separate per-call probability of use. A warm decision immediately after an edited request takes no new edit, except for the room wait. This back-to-back rule does not block production.

### The algorithm

This pseudo-code describes the shipped defaults; sizes are calibrated tokens, prices are read units, and $g$ is bounded below by 1 in the law. A summary's planned size is $S(X)=\max(\min(\max(X/10,1{,}000),8{,}000),\text{previous summary size})$. The planner estimates its call price as $(1+\kappa)\max(X-\text{previous summary size},0)+\text{out}\min(S(X),4{,}000)$: an uncached read excluding the carried previous summary, plus at most 4,000 narrative output tokens. Lists from the previous summary are carried by code; the narrative call merges the previous narrative with the new conversation.

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
on call completion: record pi-zip/summary; failed/aborted calls are not READY
on shutdown: abort the running call and record one estimated unused charge

doors: idle typed prompt (Pi's input event) → ctx.compact() with the ready answer and Pi's before-size
       turn_end → compaction draft first, then folds and artifact records
       first request → folds only, persisted at its first turn_end
```

Outside the room, an aborted call must finish before its replacement starts; that handover stays in the background. A failed or aborted call may be retried, while a successful artifact is never produced again for the same valid cut.

Eligibility also requires an output larger than 500 chars/4 tokens and a placeholder smaller than 90% of it. Recalled outputs stay unfolded. On automatic prefix caches, folds leave the first 8,192 calibrated tokens alone to preserve a cache-survival sample; summaries replace that prefix and are exempt. Folds inside a summary prefix are absorbed by the summary; folds already carried by a request keep their exact placeholders when saved. Structural guards preserve tool-call/result pairs. A failed turn saves folds its request already carried but makes no new edit. No-UI sessions use the same background production, at settle and on session open too; in a process that exits right after settle, a call settle started is aborted at exit and counted once as unused at its estimated input charge.

The room credit is zero below room. At or above it, $\eta=[(1+\kappa)X+\text{out}\,S+\kappa(B-X+S)]/(X-S)$ when $X>S$, otherwise zero. Here $X=\max(0,B-\text{keep})$, $S=\min(\max(X/10,1{,}000),8{,}000)$ without the previous-summary floor, and keep is the complete message tail covering Pi's 20K recent tokens. This estimates Pi's own compaction price for the room it would free. A ready summary passed over today stays available while its range is still the prefix; finished summaries are persisted, and each compaction consumes one produced call.

### What is proved

The numbered claims correspond to T1-T10. Lean 4 + Mathlib machine-checks **T2, T3, T4 (i)(ii)(iv), and T5 (i)(ii)(iv)(v)**. **T5(v) as first stated was refuted; the corrected form with persistence through the first guarded edit was proved.** The recorded gate is:

```text
CHECK: statements 23, proved 22, refuted 1, missing 0, gate PASS
```

See [proofs/README.md](proofs/README.md) for the exact statements, model assumptions, recorded gate and trusted base. Re-run with the pinned Lean toolchain and Mathlib cache by running `cd proofs && ./check.sh` ([proofs/check.sh](proofs/check.sh)). This release uses the recorded gate; it does not rebuild the large Mathlib cache. **T1, T6-T10 and the cited results 4(iii), 5(iii), 5(vi) remain paper proofs.** Some T2 lemmas overlap T6's stationary hazard calculation, but there is no separately audited T6 statement. A machine check proves the Lean statements; their match with the English was reviewed by hand. Neither that review nor the kernel proves summary quality or the whole product's optimality.


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

### Measured inputs and offline results

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

### Honest limits

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

## Learning and token counts

**The cache lifetime is learned, not configured.** Every response says how much of the prompt came from the cache. pi-zip compares that read with what the request re-sent unchanged (the previous prompt, or the untouched prefix before one of its own edits: on an automatic prefix cache every edit leaves the first 8K tokens alone, so even the response right after a fold says whether the cache survived) and so learns, per provider and model, whether the cache survived a gap of that length: a few counts per gap bin (30 s to 2 h, with bin edges on the 5-minute and 1-hour tiers), monotone in the gap; a gap of 2 h or more is not recorded and falls back to the requested cache lifetime, older evidence halved after 16 newer observations of the same bin, stored without any content in `~/.pi/agent/pi-zip/cache-survival.json`. Before any evidence the cache lifetime the requests ask for decides (5 minutes, or 1 hour with `PI_CACHE_RETENTION=long`; too short a guess is cheaper than too long); beyond it one clean read overrides it, inside it a lone miss counts as noise (warm caches do miss now and then) and only repeated misses do. A GLM cache read in full after 365 s makes the next 365 s return warm; a Claude 5-minute cache that read nothing after 360 s stays dead. Whether the provider bills cache writes (explicit cache) or not (automatic prefix cache) is read from the first response too. `/zip` draws what it has learned as the dot chart above.

Protected from folding: the current user turn and the previous one. When the context is above the target, re-readable outputs of the previous turn (an unchanged file, a read-only command) can still be folded at a return after a pause (an absence at least as long as the requested cache lifetime) or a model switch (never at a return inside it, whatever the cache), and any output in either turn can be folded once it is 60 assistant requests old (so a long agent run that is a single user turn with hundreds of tool calls is not exempt from folding; the newest 59 requests' outputs always stay, and every fold stays recallable). Messages you type while the agent is running (steering, follow-up) belong to that turn and do not start a new one. Outputs you have already recalled, and `zip_recall` results themselves (or reads of a recall file), are never folded again. "Read-only" is a conservative whitelist: `find -delete` or `-exec`, command substitution, redirects, background jobs, `git diff --output` and the like are not.

**Token counts are calibrated, not guessed.** Sizes are estimated as chars/4 (Pi's rule), and real tokens are not proportional to that: every request carries a fixed prefix O (system prompt, tool definitions, the provider's own framing: 2-4K on a bare Pi, 30-55K with a large tool set) that no edit shrinks, and the conversation costs c real tokens per estimated one (about 0.7-1.1 on GLM and GPT, 1.5-2.2 on Claude, more on CJK-heavy text). So a size is O + c x the chars/4 estimate of the conversation. O is read from the session: what the provider still read from its cache on the request that first carried the newest summary (everything after the system prompt and tools had changed there), else the session's first request minus its small opening prompt, else 2 x the chars/4 of the system prompt and the tool definitions; a tool set that changed since moves it by the same factor. c = (real - O) / estimate for the newest reply that reports usage (input + cache read + cache write; clamped to 0.5-4, 1.5 before the first reply). Both depend on the provider's tokenizer, so only replies from the model the next request goes to count: right after a model switch to a model of another provider O and c fall back to the defaults until its first reply, while a switch between two models of one vendor on that vendor's own API (opus to sonnet on `anthropic`, say) keeps the scale the session measured (the defaults put the first cold return's sizes 10-20% off). A provider that serves several vendors (`github-copilot`, `openrouter`, a gateway) carries the scale only between models of one recognised family (Claude to Claude, GPT to GPT): a GPT-to-Claude switch there falls back to the defaults, since the two tokenizers differ by about 2x; and when that model has no O of its own, the previous model's O carries over in conversation units (O / c). Both are read from the session itself on every decision, so a restart, `pi -p` or a resumed session calibrates exactly like a long-lived one, and nothing extra is stored. The conversation estimate also counts what every tool call puts on the wire besides its arguments and output (the call id, twice, and the tool-use markup), since that does not shrink when an output is folded. On recorded sessions the next request's size comes out within 2.8% (p90; 31% with the single ratio of 0.2.9). The size a plan predicts for the request that carries it is a few percent off in the median after a fold that removed over half of the context, 12-15% at worst one time in ten (what is left has not been measured yet); from the next reply on it is measured again (within 4%). The cold cap counts the whole context and leaves at least half of it to the conversation; the compaction room is the whole context too (it is Pi's trigger); sizes in the notices, `/zip` and the ledger use the same scale.

The working view is capped at pi-zip's room when the window is known. A protected tail or fixed prefix can still make that target unreachable; the planner does not summarise protected work to force it.

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

An extension that only writes Pi's compaction summaries (a `session_before_compact` handler, like Pi's own `custom-compaction` example) does not pause pi-zip. If it supplies another summary in response to pi-zip's native ask, pi-zip discards the artifact whose prefix was replaced, keeps its cost in the totals, and sends folds only. If the native door is unavailable or cancelled, the ready summary waits for a turn_end; it never rides request-locally. A slow foreign handler is cancelled after 2 s by default, and foreign participation or a failure disables native insertion for the process. A handler that cancels manual compactions can show Pi's red "Compaction cancelled" line once.

**If your extension handles every `session_before_compact`, return `undefined` when `event.customInstructions` starts with `[pi-zip native compaction`.** pi-zip answers its own ask; the marker never reaches Pi's default summariser. The 250 ms slow-handler threshold counts only time other handlers occupy, excluding Pi's own work rebuilding the context after the entry is saved. Every summary notice records its door (`native: "ok"`, or the reason it waited for a draft) in session metadata (`native`, `nativeMs`, `nativeAskMs`).

**Runs an extension starts.** A run triggered by `sendMessage` has no `input` event; it begins at `agent_start` (Pi 1.1.0) or at a `before_agent_start` whose `messageType` is `"custom"` (Pi 1.2.0), once either way. Its first request gets the same priced fold decision, and a ready summary waits for the first turn_end, where its compaction draft goes first. Calling `ctx.compact()` at that start would abort the starting run, so the idle door is unavailable. A custom message that starts a run after the previous final answer ends the protected tail like a user prompt. Messages that steer an active run stay part of its current turn.

The guard has two parts. Before saving a fold or a summary it checks that the edit itself would not leave a tool result without its tool call (failed or aborted assistant turns, which the provider layer drops anyway, are ignored, as is any oddity the session already had). And before a request is sent it repairs a tool result that lost its tool call, instead of letting the provider reject the request and brick the session. The repair understands the request shapes of Pi's Anthropic, OpenAI chat completions (and Mistral), OpenAI Responses (Azure, Codex), Google Gemini/Vertex and Bedrock Converse providers; a request of any other shape is passed through untouched.

## FAQ

**Will it save money?** Mostly on cold returns, which is where a long session pays for a full cache rewrite. While the cache is warm an edit must pass the rent guard above (large contexts, near Pi's compaction trigger, outputs 60+ requests old). `/zip` shows what this session has folded (and roughly how many tokens that removed), its summaries with what their model calls cost, and its recalls. The numbers live in the session file, so a restart does not reset them.

**Does it cost extra?** Planning is local. A summary is one extra uncached model call with no tools, shown in `/zip`. The law prices the full call before production, and every unused or failed call stays in the totals. There is no one-unused-call or one-summary budget per warm stretch. Finished summaries are saved as `pi-zip/summary` entries and can be used after a restart while their range is still the prefix. A call running at exit is aborted and counted once as unused at its estimated input charge; a call that fails or ends partially on its own keeps its actual charge when the provider reports one. Recalled content re-enters the context at normal prices.

**Can the model lose information?** Folded outputs are replaced by a placeholder with key lines and a handle, and the placeholder tells the model not to guess. Summaries quote your first and most recent requests verbatim (the ones between are shortened, then counted) and never paraphrase the model's reasoning. If the model ignores the handle and guesses, that is a model failure pi-zip cannot catch; this is why only re-readable outputs of the previous turn are folded after a pause; other outputs of the protected turns wait until they are 60 requests old.

**Does it work with `/tree`, fork, resume and model switches?** Yes. Folds are ordinary `context_edit` entries, projected per branch by Pi; the originals stay in the session file.

**What does pi-zip write into the session file?** It appends `context_edit` entries and compactions for the view, plus custom entries that never reach the model: `pi-zip/state` (off, quiet), `pi-zip/steer` (steering messages), `pi-zip/summary` (produced artifacts or lost calls, with their charges), `pi-zip/rent` (the accumulated rent), `pi-zip/commit` (the request that first carried edits), and `pi-zip/notice` (the line you see). A resumed process rebuilds growth, the last edited request, the cache clock and artifacts from its branch; it also reads learned survival and latency. Old `pi-zip/plan` and `pi-zip/unused-summary` entries remain readable for historical totals. Only a call still running at exit belongs solely to the old process.

**Which providers?** Anything Pi supports. The cache TTL is the lifetime the requests ask for: 5 minutes, or 1 hour when `PI_CACHE_RETENTION=long` (or the request itself asks for the 1-hour tier); no per-model table is read, and how long a provider really keeps its cache is learned. Pi's own idle cache refreshes count as a cache touch, and a different provider or model than the last request counts as cold. Providers that do not report cache usage still work; the stats are then estimates only.

Some relays rewrite `cache_control`, so the TTL actually written can differ from the one requested. pi-zip checks `usage.cacheWrite1h` (reported by the Anthropic messages API and Bedrock) on the newest few assistant messages of the current model: if you requested 1h but the provider wrote 5m, it uses the 5m TTL (and the reverse), and says so once per session unless `/zip quiet` is on. Without that field it keeps the requested TTL. Test-only TTL overrides take precedence; they are not user settings.

Some relays reject `PI_CACHE_RETENTION=long` with 400 `a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`, because they inject their own 5m `cache_control`. That is a provider issue: unset the variable.

## Testing

```bash
bun test                                                                   # unit + invariant tests + integration with Pi itself
bun run build-check                                                        # bundles src/index.ts with Pi's packages external
```

`test/pi-integration.test.ts` runs the extension through Pi's real session manager, extension loader and `emitContext`, with a mid-conversation system update and an aborted tool-call turn in the session, and checks that the request is byte-identical before and after turn_end persists the edits.

The tests use isolated settings, learned-cache files and local fake providers; they make no LLM API calls. Type checking uses `bunx -p typescript@5 tsc --noEmit -p .`. The Rust checker in [formal/README.md](formal/README.md) runs the real extension against bounded synthetic traces and compares it with independent economic and event-order properties. It checks one call, one production timer, the room-only wait and both exact compaction doors. Its remaining findings concern calibrated sizes at the room credit, the automatic-cache head, protection-window slides, growth and target reachability; it is not a proof that every possible session is correct.

The cost-model proofs have a separate gate described in [proofs/README.md](proofs/README.md). Test environment overrides are internal harness controls, not product parameters.

## License

MIT
