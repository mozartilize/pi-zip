# pz-formal: a specification and a bounded model checker for pi-zip

pi-zip's [design document](../docs/design.md) states five axioms. This crate turns them into a small formal specification, derives the finer properties from
them, and checks all of them on the **real** implementation: a bun bridge drives pi-zip's own `index.ts` / `run.ts` / `plan.ts`
through abstract traces (Pi's real `SessionManager` and draft application, a simulated provider cache, a virtual clock) and reports
every decision; the Rust checker evaluates the properties over those decisions, exhaustively on small discretised traces and
randomly at realistic sizes, and shrinks every counterexample to a minimal readable trace.

It rediscovers both bugs found live on 0.2.8 (B1, B2) as 6-event counterexamples, and found the others listed in `TRIAGE.md`.
Every property is shown to be able to fail: `tests/mutants.rs` injects one bug per property into a copy of `src` and asserts the
property passes on the original and fails on the mutant (see "Mutation score").

## Layout

| file | what |
|---|---|
| `src/spec.rs` | **the specification**: three axioms, the derived properties, one line of formula each, with the reason |
| `src/logic.rs` | the bounded temporal logic (□, ○, ◇≤k, U, U≤k, →, frozen variables, cost terms), finite-trace semantics |
| `src/model.rs` | the abstract state machine: world, events, blocks, cache, clock; the observed run and the state at each request |
| `src/law.rs` | the economic law (`plan.ts lawTerms`), ported line for line, and its lemmas |
| `src/gen.rs` | exhaustive enumeration, random traces, shrinking |
| `src/check.rs`, `src/bridge.rs`, `src/main.rs` | the checker, the bun process pool, the CLI |
| `bridge/bridge.ts` | the conformance bridge: drives a pi-zip `src` dir through a trace, answers JSON |
| `TRIAGE.md` | every failing property on the v0.3.0 candidate (rc030), classified, with the code site; the second round's new findings |
| `tests/mutants.rs` | every property can fail: one injected bug per property, passes on `src`, fails on the mutant |
| `out/` | the last acceptance run (reports and JSON), not committed |

## The spec language, and why this one

Properties are an **embedded DSL in Rust**: formulas are values built from typed combinators (`always`, `next`, `within(k, ..)`,
`a.until(b)`, `a.until_within(k, b)`, `freeze(x, term, ..)`, `le/lt/ge/gt` on cost terms, `&`, `|`, `!`, and `a >> b` for
"a implies b"). Each atom is a named one-line predicate over a request. A property reads like this:

```rust
// B2B: a rewrite planned at a warm cache right after a rewrite pays the cache write twice for one saving.
always(zip_edit() >> !next(zip_edit() & cache_warm() & planned_warm()))
// NR: no warm edit within K requests of a cold plan unless new information arrived.
always(cold_plan() >> freeze("i0", index(), !quiet_since_i0().until_within(K_REGRET, after_i0() & zip_edit() & planned_warm())))
```

Why embedded rather than parsed: the atoms are computations over the real decisions (the law's terms, protection windows, plan
dominance, byte hashes of requests). A parsed language would need its own expression language and type checker to say them; Rust
already is one, the compiler checks the spec, and there is no parser to maintain. What a reader needs is `spec.rs`, which is
formulas plus words, in the order of the README's axioms. `pz-formal spec` prints every property in mathematical notation.

**Traces** are data, so they get a **tiny parsed syntax** (one line per event). Counterexamples are printed in it and replay
with `pz-formal run`:

```
world explicit known ttl=300 true=300 survival=none c=1 sys=3000 window=200000 native interactive
prompt
say 60K          # the assistant answers in 60K tokens of prose (only a summary can remove it)
prompt +1h       # the user returns after an hour: cold
say 100
prompt +60s
say 100
```

## The state machine (spec part a)

* **World**: cache class (explicit / automatic, known or still to learn), declared TTL and the TTL the provider really keeps,
  learned survival, real tokens per chars/4 token, system prompt size, context window (→ Pi's compaction room), Pi's
  `ctx.compact` available, interactive or print mode; the cache tier (`long`: `PI_CACHE_RETENTION=long`, a 1-hour
  `cache_control` in every payload, declared 3600 s); the tool selection (`tools=file`: an allowlist `read,bash` that hides
  `zip_recall`, recall through files and the `tool_call` hook; `tools=reread`: an allowlist without read, grep, bash or
  `zip_recall`, only re-readable outputs may fold); `warming`: Pi's idle cache warming on (Pi's real `CacheWarmer`, its own
  economics and timers, asking pi-zip's `cache_warming_decision` handler). `slow` (trace files only, never drawn at random): a background summary call takes 2 minutes of the clock, so a restart or a return can come while one runs (a wait for it ends it at once).
* **Events**: `prompt +gap` (user prompt after a gap), `call npm|cat|recall SIZE` (an assistant request whose tool returns SIZE
  tokens: `npm` mutates, so it cannot be re-read, and its output has one failing-test line; `cat` can; `recall` is how the model
  gets the newest folded output back in the world's tool selection: `zip_recall`, a `read` of the recall file, or a re-run),
  `say SIZE` (the request that answers and ends the run), `fail error|abort` (the request fails: the provider refuses it and its
  cache is untouched, or the user presses Esc after the provider read the prompt; the run ends), `steer` (a message typed while
  the agent runs, delivered before the next request: not a new user turn), `wait +gap` (the run ends and time passes without a
  prompt, so what follows happens at the return), `switch` (model), `restart` (a fresh pi process), `foreign SIZE` (another
  extension's compaction, between runs), `compact` (Pi's own compaction: its `prepareCompaction` cut, `fromHook` false; between
  runs or mid-run), `edit` (another extension's `context_edit` of the oldest output the model still sees; anywhere), `boundaryedit` (the same edit
  drafted by a preceding turn_end handler; applied to Pi's preview before pi-zip runs), `drive +gap`
  (a run an extension's message starts, as Pi 1.1.0 `sendCustomMessage(..., { triggerTurn: true })` -> `_runAgentPrompt` does:
  `agent_start`, the custom message appended, the first request, **no** `before_agent_start`; a new user turn), `nextturn` (a
  custom message Pi stores right after a prompt: a nextTurn message or a `before_agent_start` handler's message; the prompt's turn),
  `aside` (0.4.12: a side question between runs, as pi-aside 0.3.0 asks it: one request that re-sends the newest main prefix on
  the current model, reads what the provider still holds and refreshes it, persisted only as Pi's own
  `sessionManager.appendUsage("aside", provider, model, usage, note)` entry; no message, no hook).
  The away timer and Pi's cache refreshes are not events: the clock fires them. `formal/coverage/coverage.ts` maps recorded
  sessions onto these events and lists what they cannot express (TRIAGE.md, round 4).
* **Blocks** (session entries): kind, size, user turn, recoverability (re-readable, not re-readable, a recall result), the
  request that issued them; at each request each block is visible, folded or summarised, and recalled or not.
* **Cache**: per model, a response (not a refused request) or a refresh at t keeps the prefix until t + the kept TTL; a refresh is
  Pi's warmer's or a side question's (`aside`), which reads the prefix if it is still held and rewrites it otherwise. Warm/cold at
  a request is a fact of this clock; what pi-zip *believed* (P(warm), cold, past TTL) is observed separately. No property asks
  that a warm cache be believed warm (survival the provider has not shown may be priced cold): `traces/gc-aside.trace` and
  `tests/bridge.rs` pin that a side question which read the whole prefix is a touch for pi-zip (0.4.12), one at a gone cache not.
  `traces/producer-touch.trace` pins a touch shortly before the old producer deadline: no call at that deadline, then eventual
  production after the refreshed clock expires. Narrative observations include `at` (seconds since trace start) so the bridge
  test checks when the call began. Long tool calls with usage appended during the call are not expressible by this alphabet:
  `call` includes its tool result and `wait` ends the run. Unit and real-Pi integration regressions cover that case.
* **Requests**: each goes to the provider as a real Anthropic-shaped payload (system blocks, tools, `tool_use` / `tool_result`
  pairs, errored and aborted messages dropped as pi-ai does, the tier's `cache_control`), through pi-zip's
  `before_provider_request` (its request repair, `guard.ts`, and its payload-tier reading run on it).
* **Costs**: the law's own units (`law.rs`): read r, rewrite w, output, the summary call; growth g.

## The axioms

| | axiom | formula |
|---|---|---|
| A1 | nothing is lost | □ nothing_lost: the request carries the session's conversation **by position**, one to one and in order from its first kept message to the newest (a summary may stand for a prefix, nothing in between may go missing); every message except a folded output or a summary goes out byte for byte (user text, tool args, system prompt, thinking); pi-zip's request guard does not have to rewrite the payload (an edit that broke a tool_use / tool_result pair); **every folded block names its handle and shows its key lines** (first, last, the error line, as the README's Recall section describes); every output the model does not see verbatim comes back byte for byte **the way the model gets it back**: `zip_recall(handle)` as the tool executes it, all pages, or a `read` of the recall file the placeholder names (through pi-zip's `tool_call` hook), and in reread-only mode only re-readable outputs fold; a user request pi-zip summarised away is quoted verbatim |
| A2 | edit only when the cache is gone or the edit pays | □ (zip_edit → pays): the law's own model, **at the class ratios of the true cache class and tier** (not the planner's prices) and **at the request's real sizes** (B: what the request would have sent without the edit; A: what it sent), with the summary call priced as what it is (uncached read of the conversation the cut replaces, without the carried previous summary, plus the summary written), says the edit costs no more than not editing (10% tolerance: the planner's calibrated estimate). At P < 0.5 folds are free (lemma C), and a summary must also pay its call at its own margin (what the cut removes beyond the folds): no decision is excused for being cold |
| A3 | never in the way | □ (user_waits → at_room): nobody waits for a summary call except at Pi's compaction room, with a UI or without (sub-agents too). A summary is written in the background (away, at the end of a run, or produced when a decision wants one that is not ready) and taken at the first decision after it is ready; that decision goes with its folds alone meanwhile (0.4.0 step 4: 0.3.1's excuses, a no-UI session and a return a model switch made cold, are gone) |

**A3 is a product decision** (axiom IV: you never wait for pi-zip). Round 5 (rules A and B) narrowed it to warm plans; 0.4.0 removes
every synchronous summary: the run-plan summary at a return, the valve summary at a turn_end, the wait for the remainder of a call
already running, and rule B. A plan whose summary is not ready goes with its folds alone, judged by the law, and the summary is
produced in the background. The one wait left is the room's: a turn_end whose view after its edit is still at Pi's compaction room
waits for the plan's own cut (the call already running for it, or a new one), since Pi would stop for its own, lossy compaction
otherwise. The round-2 excuses (a turn_end valve mid-run, a return a switch made cold, a print-mode session) are gone.

## Derived properties

| | property | from | formula (abridged) | why it follows |
|---|---|---|---|---|
| EN | exact compaction number | I1 | □ exact_number | every summary enters natively at an idle typed prompt or as the first turn_end draft; Pi's appended tokensBefore equals pi-zip's before; every notice and fold ledger after-size is non-negative and matches the resulting Pi projection/request within 10%, counted independently of the reported savings |
| OC | one call and one timer | A3 | □(active_calls ≤ 1 ∧ production_timers ≤ 1 ∧ direct_timer_writes = 0) | provider calls and producer-owned timer handles are observed independently of ledger wording; a timer only starts production, whose completion records its artifact |
| I1 | run stability | A2 | □(¬run_start ∧ ¬zip_edit ∧ ¬env → prefix_kept) ∧ □ persisted_as_sent | a byte change no priced edit explains is an unpriced rewrite; persisting something other than what was sent rewrites at the next request |
| RD | restart determinism | A2, A3 | □(run_start → fresh_plans_alike) | the law and b2b must be functions of the session, or a restart re-decides on different state; produced summaries are pi-zip/summary entries (0.4.0), so only a call in flight at the restart is the process's own |
| RC | recall is never refolded | A1, A2 | □ recall_kept | refolding what the model asked for hides it again and invites the same recall: a rewrite each time |
| PW | protection windows | A1 | □ protection_respected | the latest two user turns stay: their outputs fold only if re-readable in the previous turn after a pause (an absence ≥ the requested TTL τ) or a model switch, whatever P (0.4.0), or ≥ 60 requests old; a summary never cuts into them |
| B2B | no back-to-back warm rewrites | A2 | □(zip_edit → ¬○(zip_edit ∧ cache_warm ∧ planned_warm ∧ ¬room_wait)) | the second rewrite pays the write twice for one saving; 0.4.0: a rewrite the room wait makes is excused (b2b does not block it, theory 1.3 R6) |
| MP | monotone in P(warm) | A2 | □ monotone_in_p | an edit is never cheaper at a warm cache than at a cold one: at every decision point, re-planned on a grid of P with everything else fixed, the plan at a lower P covers or beats (smaller context, or the cold target reached) the plan at a higher P; structural since 0.4.0 (one planner: P enters only the law) |
| NR | time consistency (no regret) | A2, A3 | □(cold_plan → [i0:=i] ¬(quiet U≤10 (i > i0 ∧ zip_edit ∧ planned_warm))) | an edit is free cold and paid warm: a warm edit within 10 requests of a cold plan with no new information means the cold plan was dominated; a later decision taking the summary that cold return produced because it was not ready is excused |
| NT | no thrash | A2, A3 | □(zip_summary → summary_worth_it) | a summary must remove at least what it writes, above the irreducible floor (system prompt, previous summary, protected turns); successive summaries are priced by the law without a warm-stretch budget or regrowth exception (0.4.0 step 7) |
| WL | a warm summary that pays is not withheld | A2, A3 | □ warm_summary_not_withheld | every warm turn_end decides unless b2b or a run plan is being persisted; a wanted summary is produced at once and taken at the first decision after it is ready, so a returned call whose range is still the prefix is never produced again |
| NA | the open native door takes a ready summary that pays | A2, A3 | □ native_ready_applied | at a typed idle prompt, outside b2b, the deepest guarded ready artifact no deeper than c (or cW without c) that passes both laws with call price zero must enter through the native door before the first request; readiness comes from session artifacts, prices and law verdicts from the Rust spec, and application from the compaction actually appended, independently of `take` or `native_skip` ledger wording |
| PC | Pi's own compaction is not left to happen | A1, A3 | □ room_wait_kept | 0.4.0: a request of a run at Pi's own threshold (window − reserve, 8,192 above pi-zip's room) follows a turn_end that waited at the room or wrote a summary, unless that turn_end failed, decided and planned no cut (the room plan's cut must pass the law with its call), or the protected turns fill the room; the run plan's turn_end and a b2b skip are not excused (theory 1.4 R6, R9) |
| TR | target reachability | A2 | □(cold_plan → target_reached_or_excused) | the cold return is the one free rewrite: it reaches the cold target (±15%) unless the floor fills it, the law refused the summary (or, at P > 0, the plan: then the rewrite is priced, not free), or (0.4.0) it took a summary produced earlier that cuts short of its own cut (never deeper: the paid call is used; the target is reached once the deeper one is ready) |
| GC | a gone cache gets a cold plan | A2 | □ gone_is_cold | README decision: survival is priced at the gap, and a model switch sets P = 0: a run after a model switch is planned at P = 0; a run whose cache was last touched (a response that reached the provider, or Pi's refresh) longer ago than the requested TTL τ, or a switch, is marked a pause, and longer ago than both τ and the kept TTL is planned cold |
| WB | warm does nothing below the target | A2 | □(zip_edit ∧ planned_warm → warm_above_target) | README working-view rule: nothing is planned below W: a new edit planned at P ≥ 0.5 comes from a request (real size) above the cold target (15% tolerance) |
| MH | an automatic cache keeps its head | A2 | □ head_kept | README: on an automatic prefix cache every edit leaves the first 8K tokens alone, so the response right after a fold still says whether the cache survived (folds only; a cut replaces the prefix, and the first request to a new model is no sample) |
| RDr, MPr, A2r | residuals | RD, MP, A2 | the property, minus the known root causes | RD after transplanting growth and edit state together (g, justEdited), or where the live process took a summary call still in flight (0.4.0: a finished one is a pi-zip/summary entry the fresh process reads too); MP outside the mechanisms TRIAGE (a) 3 and 6 name; A2 outside B1 and the plan gate without the call (TRIAGE (a) 2). RD, MP and A2 fail in thousands of traces on 0.2.8 and affine; a new bug of their kind shows up only here (and in the per-trace verdicts) |
| LW | the law as specified | A2 | □ law_as_specified | every law evaluation of the real planner equals `law.rs` on the same inputs **at the class ratios** of the true class and tier (learn.ts `CLASS_RATIOS`, which satisfy the lemmas' premise w ≥ r > 0, a unit test); a summary step's call term, backed out of K, is at least half the uncached read of what it summarises; the whole plan's step is pinned both ways by the planner's own cut flag: a cut's step carries exactly the call of the summary step before it, a folds-only plan's step none, and a planned cut ends in an accepted step that carries one; so the lemmas below apply to the code |
| G, W | harness fidelity | | | the P-grid re-plan at the actual P reproduces the decision run.ts acted on; the bridge's provider keeps the cache exactly as the spec's clock says |

**New information** (NR) is exactly: a model switch, a foreign compaction (another extension's or Pi's own), another extension's
context edit, a `zip_recall` (counted from the request after the one whose response called it: that request is the first to carry
the recalled output), the cache class learned from the first response, a new cold return, or growth of more than DELTA = 10K real
tokens since the cold plan (counted through the witness request itself: the plan made for it has seen what that request appended), or growth that pushed a context the cold plan had left below Pi's compaction room up to it (where the warm edit is forced). Everything else, in particular
**the protection window sliding by one user turn** and the passage of time below the TTL, is not new information. B2 is the
first, so a cold plan that could not summarise only because the window had not slid yet is dominated by the warm summary one
prompt later.

**Monotonicity** is checked at every decision point of every trace by re-planning with the real `planContext` and the captured
options (entries, scale, prices, g, recalled set, pause), varying only P over {0, .25, .49, .51, .75, 1} plus the actual P (since
0.4.0 P enters only the law; b2b still reads P ≥ 0.5). At an actual cold return, a warm probe keeps the b2b rule:
a warm return right after an edited request plans nothing. Property G checks that the probe reproduces the actual decision.

The NA probe snapshots the session before `before_agent_start`, including ready artifacts, eligible cut sizes and b2b state,
and whether Pi can compact while idle. It shares the source's folding and structural guard mechanics, but supplies no ready keys
to that folds-only probe and consumes no native planner verdict. Rust computes cW, c, the allowed ready cut and both economic laws
with its own class prices. The bridge supplies Pi's idle `abort()` capability as well as `compact()` so native worlds exercise that
door. A native artifact's application call price is zero even though native application emits no `take` ledger record. Native decisions and ledger records are captured before the first request; its jointly priced folds carry their entry IDs into the projection after compaction without another law decision. The room grid is observed separately from ready-summary selection, so PC checks the plan that priced the wait.

## What is proven, what is checked

**Proven** (lemmas about `plan.ts lawTerms`, the same function in 0.2.8, affine, coldwarm and rc030; `pz-formal lemmas --src DIR`
re-checks M, C and S on the real code over 226,800 points and finds the port identical at every one; property LW checks at every
decision of every trace that the code calls it as specified):

Let D = B − A, T' = min(T, A), K(P) = (w − r)(P·T' − (1 − P)·D) + call, gain = r·D²/(2·max(g, 1)) + η·D, ok = (K ≤ 0 ∨ gain ≥ K).

* **M (monotone in P).** dK/dP = (w − r)(T' + D). The code guarantees D > 0 (`if (!(A < B)) return none`, the first line of
  lawTerms), T' ≥ 0 (T ≥ 0 and A ≥ 0: every call site passes T = A, the post-edit context size, at least O; lawTerms itself does
  not check T, so a call site with T < 0 would void M), and w ≥ r (`learn.ts CLASS_RATIOS`: 1.25 > 0.1, 2 > 0.1 on the
  long tier, 1 > 0.2; and `pr.r > 0` is required, else nothing is allowed at any P). So T' + D > 0 and K is non-decreasing
  in P, while gain does not depend on P. Both disjuncts of ok are preserved when P decreases: ok is antitone in P. ∎
* **G (gain ≥ 0).** r > 0, D > 0 make the read term ≥ 0. η > 0 only when B ≥ room; its numerator is
  w(B − keep) + out·s + (w − r)(keep + s) = w·B + out·s + (w − r)·s − r·keep with s ≥ 1000. The out·s term is ≥ 0 (out > 0), so
  it suffices that w·B ≥ r·keep: the room is ≥ 4096 (`MIN_TARGET`), w ≥ 1 and r ≤ 0.2 (CLASS_RATIOS), so w·B ≥ 4096 >
  0.2·20000 = r·keep, and η ≥ 0. ∎ (The first round dropped the out·s term from the algebra; the bound held regardless.)
* **E (economic sanity: an edit chosen under the law never costs more than not editing, in expectation, in the law's model).**
  The law's model says E[cost | edit] − E[cost | no edit] = K − gain. If gain ≥ K this is ≤ 0. If K ≤ 0, K − gain ≤ −gain ≤ 0 by G. ∎
* **C (a dead cache always edits).** P = 0, call = 0: K = −(w − r)·D < 0. ∎
* **S (a model call only makes an edit harder).** call ≥ 0 adds to K and nothing else. ∎

The premise **w ≥ r > 0** is checked against the code, not assumed: the unit test `lemmas_hold_on_the_port` asserts it for every
class ratio, and LW asserts at every decision that the planner's prices *are* those class ratios (a planner that priced with
the model's price table, a wrong tier or a changed ratio fails LW). LW's summary-step check is no longer a tautology: the call
term it backs out of K must cost at least half the uncached read of the prefix it summarises, so a summary call priced at 0
fails it.

The lemmas are about the law, so they say where non-monotonicity in the *implementation* can come from: not the law, but the
**candidate plan** the law is asked about, which may change with the mode. B1 is exactly that. In 0.2.8 the warm plan asked the
summary gate nothing (`mode === "warm" || gate("summary", ...)`), so its call term was 0, while the cold plan's call term was
positive. By S the warm summary then passed where the cold one failed. coldwarm's F1 removes that difference; the MP breaches left
in rc030 are other candidate-set effects (TRIAGE.md).

**Bounded-checked, as conformance on the real code**: every other property, over:

* **exhaustive families** (`pz-formal count`): depth-4 runs over gaps {60 s, 330 s, 1 h} × bodies {quick answer, 60K prose,
  30K command output, 30K re-readable output} in an explicit and a GLM-like world (13,824 traces); depth 5 over {60 s, 1 h} ×
  {quick, prose, command} (3,888); depth 3 over {60 s, 270 s, 1 h} × {quick, prose, two 25K outputs, recall} with one switch,
  restart or foreign compaction, or a side question 270 s or an hour after the previous run, placed before any run (6,336); depth 3 over {60 s, 1 h} × {quick, prose, command, a steered run,
  a run whose last request fails} with a restart after an hour away, a switch after 4 minutes away, Pi's own compaction or
  another extension's edit before any run (4,500); depth 3 over {60 s, 330 s, 1 h, 2 h} × {quick, prose, re-readable, recall}
  on the 1-hour tier, with recall through files, in reread-only mode and with Pi's idle cache warming (4,096); depth 3 over
  {60 s, 1 h} × {quick, prose, command, a prompt with a nextTurn message} in an explicit and a 128K-window world, with a run an
  extension's message starts after an hour, after a minute, or after an hour followed by a restart (3,584);
* **3,000 random traces** at realistic sizes (3 to 10 runs, 0 to 6 tool calls a run, 4% long autonomous runs of 20 to 70 calls,
  outputs 100 to 40K log-uniform, gaps from seconds to hours across the TTL; steering, failed and aborted requests, Pi's
  compaction and other extensions' edits mid-run and between runs, restarts and switches at the return; random worlds including
  the 1-hour tier, both allowlist modes and idle cache warming; 12% of the runs after the first started by an extension's message,
  10% of the prompts with a nextTurn message, drawn from a second stream so the rest of each trace is what the seed drew before;
  8% of the runs after the first preceded by a side question 30 s to 30 min after the previous run, from a third stream);
* 39,228 traces per source (36,924 before 0.4.12's side questions, 33,340 before round 4); one minimal counterexample is kept per (property, mechanism) and shrunk
  greedily (drop runs, events, specials; round sizes and gaps to canonical values; move the world to the default);
* **per-trace verdicts** (`--verdicts FILE`): one JSON line per trace with the class of every property it fails, so two runs
  (two sources, or a source and a mutant) can be compared trace by trace where the counts would hide a change.

## Limits

* **Bounds.** Depth ≤ 5 runs exhaustively, sizes in a few buckets; random traces are not exhaustive. K_REGRET = 10 requests,
  DELTA = 10K, size tolerances 10% (15% for the cold target, the README's own estimate error; 10% of K for A2).
* **Abstractions.** Tool outputs are synthetic text; real tokens = c × chars/4 exactly (no tokenizer noise, so every size error
  the checker sees comes from pi-zip's calibration, not the text); one tool call per request; no images or thinking; the
  provider cache is an exact prefix cache with a hard TTL; a failed request (`fail error`) is one the provider refused before
  reading the prompt (an error after the provider read it is not modelled), an abort is one it read; two models; the narrative
  model answers instantly with as many words as summary.ts asks for (summary *content* quality is not checked, only what A1
  requires of it); Pi's compaction uses `keepRecentTokens` 20,000 and a fixed summary text; another extension's edit always prunes
  the oldest visible output; the cache warmer's refresh is a 1-token request that re-sends the newest prefix. The idle door
  (0.4.6, on by default) is switched off in the bridge: its compaction while Pi is idle is outside EN's two doors, and it is
  checked by the integration suite (its own describe and mutants) and by the `idle` and `race` paths of the real-TUI doors run.
* **WL's bounds.** The observer checks decision points and reuse of finished calls; NA separately supplies an independent oracle
  for taking a ready summary at the native door. An independent oracle for every possible production cut is not built.
* **Taken from the code, not derived.** A2 reads g (the growth per request in the law's read term) from the planner's own trace:
  how the session's growth should be measured is pi-zip's choice (README "measured in the session"), and RD already shows that g
  is lost on a restart. The protection window (2 user turns, 60 requests) is restated in the spec, not read from the code.
* **Mirrored, not called.** Pi's agent loop and its event order (`session_start`, `before_agent_start`, prompt appended, per
  request `context_with_system` → `before_provider_request` → assistant `message_end` → `tool_call` → tool result → `turn_end`,
  then `agent_before_settle`); the provider and its usage reports; Pi's `AgentSession.compact()` around the real
  `prepareCompaction`; the clock and timers (virtual `Date` and `setTimeout`); the payload pi-ai would build (Anthropic shape
  only: the guard's OpenAI, Responses, Google and Bedrock paths do not run). Called for real: pi-zip's `index.ts` wiring and
  everything below it (run.ts cold detection, run plan, turn_end decision, b2b skip, pause, producer timer, native
  compaction, persistence at turn_end, learning, steering marks, the `tool_call` hook, the payload tier, `guard.ts`
  `repairPayload`, the `zip_recall` tool's `execute`), Pi's `SessionManager`, `AgentSession._applyBoundaryDrafts`,
  `prepareCompaction`, `convertToLlm` and `CacheWarmer`.
* **Probes.** MP re-plans with `planContext` and the options run.ts passed (captured by wrapping `Zip.prototype.opts`); RD runs a
  second pi-zip instance on a snapshot of the session and of the learned-survival file, at the instant the live request was sent,
  and to name the cause transplants the live in-memory fields into it (g, justEdited, clock; the learned class
  and survival are not transplanted: `beforeAgentStart` reloads them from disk). A1's recall round trips run on a third pi-zip
  instance on the live session, so they never touch the live instance's state.
* **Options.** `--plan-opts '{"inturnAge":20}'` merges planner options into every `planContext` call (an ablation without
  editing src; coldwarm's F2 lookahead was turned on this way until 0.4.0 removed it).
* The checker never writes outside a per-worker temp dir (stats, recall files, flags); the session under test is in memory but
  reports a session file, as every session started without `--no-session` does (rc030 turns recall through files off without
  one). `--no-session` itself is not modelled.

## Results (last acceptance run)

The table below is the second round's. The current counts (round 4: the `drive` / `nextturn` events, WL, 36,924 traces) are in
TRIAGE.md, "Round 4", next to 4795af3 run under the same checker.


Traces failing, out of 33,340 per source (0 = pass), about 285,000 requests each, 0 bridge errors. Sources: 0.2.8 =
`/tmp/pz-replay/src`; affine = this worktree's `src` (f5deda1); coldwarm = `/tmp/pz-coldwarm/src` 1fe03c2; rc030 =
`/tmp/pz-rc/src` fa3a467 (the v0.3.0 candidate); +F2 = with `--plan-opts '{"lookahead":true}'`. Every failing class, its code
site and its fix direction are in `TRIAGE.md` (the second round's new ones at its end). The first round's numbers (24,744
traces, the first spec) are not comparable: A1 now checks by position and through the real recall paths, A2 has no blanket
excuse below P = 0.5 and prices from the class, A3 no longer excuses a warm return, and the alphabet is larger.

| property | 0.2.8 | affine | coldwarm | coldwarm +F2 | rc030 | rc030 +F2 |
|---|---|---|---|---|---|---|
| A1 nothing is lost | 177 | 0 | 0 | 0 | 0 | 0 |
| A2 edit only when the cache is gone or the edit pays | 3,359 | 2,915 | 4 | 4 | 4 | 4 |
| A3 never in the way | 3,576 | 3,647 | 266 | 705 | 266 | 705 |
| I1 run stability | 0 | 0 | 0 | 0 | 0 | 0 |
| RD restart determinism | 11,667 | 11,392 | 9,223 | 9,234 | 9,223 | 9,234 |
| RC recall is never refolded | 60 | 0 | 0 | 0 | 0 | 0 |
| PW protection windows | 0 | 0 | 0 | 0 | 0 | 0 |
| B2B no back-to-back warm rewrites | 5 | 3 | 4 | 3 | 4 | 3 |
| MP monotone in P(warm) | 15,627 | 15,137 | 23 | 36 | 23 | 36 |
| NR time consistency (no regret) | 1,596 | 1,547 | 173 | 170 | 173 | 170 |
| NT no thrash | 199 | 4 | 0 | 0 | 0 | 0 |
| TR target reachability | 0 | 14 | 15 | 15 | 15 | 15 |
| GC a gone cache gets a cold plan | 19 | 19 | 19 | 19 | 19 | 19 |
| WB warm does nothing below the target | 45 | 4 | 0 | 0 | 0 | 0 |
| MH an automatic cache keeps its head | 169 | 13 | 13 | 12 | 13 | 12 |
| RDr restart determinism, residual | 4 | 3 | 6 | 7 | 6 | 7 |
| MPr monotone in P(warm), residual | 0 | 0 | 0 | 0 | 0 | 0 |
| A2r edit only when gone or it pays, residual | 136 | 2 | 2 | 2 | 2 | 2 |
| LW the law as specified | 0 | 0 | 0 | 0 | 0 | 0 |
| G the P-grid probe reproduces the real decision | 0 | 0 | 0 | 0 | 0 | 0 |
| W the bridge's world is the spec's world | 0 | 0 | 0 | 0 | 0 | 0 |

The two live bugs, rediscovered on 0.2.8 as minimal counterexamples (`traces/b1.trace`, `traces/b2.trace`):

* **B1**: MP fails at the third request of `prompt; say 60K; prompt +60s; say 100; prompt +60s; say 100`. The warm run plan
  summarises (P >= 0.51) what the cold plan's summary gate refuses at P = 0. A2 now fails there too: the warm summary's call
  is priced by no gate.
* **B2**: NR fails at `prompt; say 60K; prompt +1h; say 100; prompt +60s; say 100`, and now A3 as well: the user waits for the
  warm run plan's summary at request 2.

## Mutation score

The review's 29 mutants of this worktree's `src` (`/tmp/pz-review-mut/m*`, one change each; 27 real, 2 equivalent), each
checked on the standard suite plus 3,000 random traces (seed 1, no shrinking) with per-trace verdicts
(`mutation/run.sh`, then `python3 mutation/cmp.py`; the mutant copies are the review's, in `/tmp/pz-review-mut/m*`). The unmutated copy, run twice, gives identical
counts, classes and verdicts. A mutant is **caught** when a property that names the injected bug goes from 0 to failing or gains
a counterexample class (the review's criterion), or, with per-trace verdicts, newly fails on traces where it passed.

| | first round (review) | now |
|---|---|---|
| caught by a property that names the bug | 16 of 27 (59%) | 25 of 27 (93%) |
| ... counting per-trace verdicts | (not available) | 27 of 27 (100%) |
| caught only as a side effect | 4 (m06, m18b, m25, m26) | 0 (2 by the review's criterion alone: m15, m20) |
| survived | 7 (m01, m02, m18, m19, m20, m21, m22) | 0 |
| equivalent | 2 (m16, m24) | 2 (m16, m24: no property changes) |

The seven survivors and the four side-effect catches, now (named property, base → mutant, traces): m01 `zip_recall` returns
truncated bytes, A1 0 → 15,780; m02 placeholder without a handle, A1 0 → 14,447; m18 past-TTL at 4 × TTL, GC 19 → 13,656 (new
class); m18b cold only after 20 min, GC 19 → 7,896 (new class); m19 a switch not cold, GC 19 → 1,682 (new class); m20 no
`MIN_EXPECT` head, MH 13 → 3,351 (same class: per-trace verdicts); m21 1-hour tier ignored, LW 0 → 1,332; m22 steering counted
as turns, PW 0 → 1,932; m06 explicit w 1.25 → 0.3, LW 0 → 25,449; m25 summary call free, LW 0 → 18,517 and A2r (new class);
m26 warm below the cap, WB 4 → 692 (new class). m15 (`summarizedWarm` ignored) moves NT 4 → 28 in its existing class: caught
by the per-trace verdicts only. m03 and m04 are now caught by A1 itself (0 → 5,523 and 0 → 5,218; m04 before only by I1).

`tests/mutants.rs` keeps one mutant per property as a regression test (A1 ×5, A2/LW, A3 ×4, I1, RC ×3, PW ×4, B2B, TR ×3, GC ×4,
WB, MH, LW ×2, MPr, RDr, WL, PC; round 4 added WL, PW over `nextturn`, GC over `drive` and two TR over `drive`; round 5 two A3 over rule B, see TRIAGE.md) and shows that W, G, LW arithmetic and NT summary value fail on a tampered observation. Step 7 removes
`wl_the_one_summary_flag_lapses` and `wl_a_restart_knows_a_driven_cold_wake` because Q2 and its restore walk are deleted.

## Checks in real Pi integration

Calibration and notices have two additional invariants in `test/pi-integration.test.ts`, where Pi's real extension runner,
session projection and boundary draft application run. The formal bridge does not observe transcript notices, and its token
calibration properties allow a tolerance rather than checking carry metadata directly.

* **Request carry metadata:** `sent`, applied fold IDs, compaction `carried` and fold commit `carried` must agree with the summary
  text and tool-result replacements actually present in the last emitted Pi request, matched by content and source tool-call ID.
  The expectation comes from request messages, independently of the metadata being checked.
* **One notice per turn (K7):** count actual fold/summary `pi-zip/notice` entries appended between a turn's first request or prompt
  and its boundary; the count must be at most one. State cards and command responses are separate entry kinds.

Every integration rig checks these invariants after requests, after boundaries and at test teardown. The mixed room regression
also checks calibration, live and restarted edit bookkeeping, exact Pi `tokensBefore`, combined notice sizes and wait information,
and an aborted turn. Run `bun run test/pi-integration-mutants.ts` to restore the inherited summary carry flag and duplicate room
notice independently in disposable source copies; each must fail its corresponding invariant through the real Pi rig.

## How to run

Prerequisites: Rust (offline is fine: serde and serde_json only), bun, and a pi-zip checkout whose `node_modules` resolves
`@earendil-works/pi-coding-agent`.

```sh
cd formal
cargo build --release
./target/release/pz-formal spec                                   # the properties
./target/release/pz-formal count                                  # traces per exhaustive family
./target/release/pz-formal lemmas --src ../src                    # the law's lemmas, on the port and on the real lawTerms
./target/release/pz-formal run --src /tmp/pz-replay/src traces/b2.trace   # replay one trace, every request and verdict
pi-durable-subagents hold machine -- ./target/release/pz-formal check --src ../src --random 3000 --json out/affine.json
pi-durable-subagents hold machine -- ./run-all.sh             # the acceptance run: every source (about 90 min on 28 cores)
cargo test && cargo clippy --all-targets
```

`check` options: `--suite standard|quick|none`, `--family 'worlds=explicit,glm depth=4 gaps=60,330,3600 bodies=q,p,b,c
specials=switch,restart,foreign'` (worlds: explicit glm fresh tools small claude print long file reread warming slow; bodies: q p b c
bb r s f n; specials: switch restart foreign late-restart late-switch compact edit drive drive-warm drive-restart aside aside-late), `--random N --seed S`, `--only A2,MP`,
`--shrink ROUNDS` (0 = no shrinking), `--workers W`, `--verdicts FILE` (per-trace verdicts, JSON lines), `--plan-opts JSON`,
`--pi DIR` (another pi-coding-agent). A standard check without shrinking takes about 3 minutes for 33,340 traces on 28 cores.

Step 5 producer checks also run `bash formal/tui/r7-producer.sh` under the machine lease. The real Pi TUI uses a local fake
provider, isolated settings and session storage under `formal/out`, and no network. It checks that opening and typing in old
history starts no call, while a completed run prepares its next return in the background and persists the finished summary.

Step 6 checks run `bash formal/tui/r7-doors.sh` under the machine lease. The real TUI and local fake provider exercise a typed
prompt, a driven run, a mid-run boundary, the idle door, and a run an extension starts while another handler holds the idle
door's compaction past the typed door's deadline. Each checks the displayed “Compacted from” against the appended compaction and
pi-zip's recorded before size. Histories, settings, cache and captured output stay isolated under `formal/out`.

Step 7 drops Q2 and checks the shipped plain-law policy with `formal/simulator/r7_q2.py`. Run separate `b1` and `b2` processes,
then `report`, passing `--bench "$BENCH_DIR" --out formal/out/s7/simulator` from the repository root, under the machine lease.
Each invocation checks the source for the deleted fields and runs the Pi restart regression before evaluating the policy. The
report requires 0 of 32 failing cells against V3g and prints the edge cells to watch live. This is a simulation of the shipped
policy; the formal bridge and Pi integration tests cover TypeScript event order, persistence and restart behavior independently.
