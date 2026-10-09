# pz-formal: a specification and a bounded model checker for pi-zip

pi-zip's README states three rules. This crate turns them into a small formal specification, derives the finer properties from
them, and checks all of them on the **real** implementation: a bun bridge drives pi-zip's own `index.ts` / `run.ts` / `plan.ts`
through abstract traces (Pi's real `SessionManager` and draft application, a simulated provider cache, a virtual clock) and reports
every decision; the Rust checker evaluates the properties over those decisions, exhaustively on small discretised traces and
randomly at realistic sizes, and shrinks every counterexample to a minimal readable trace.

It rediscovers both bugs found live on 0.2.8 (B1, B2) as 6-event counterexamples, and found the others listed in `TRIAGE.md`.

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
| `TRIAGE.md` | every failing property on the v0.3.0 candidate (rc030), classified, with the code site |
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
formulas plus words, in the order of the README's rules. `pz-formal spec` prints every property in mathematical notation.

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
  `ctx.compact` available, interactive or print mode.
* **Events**: `prompt +gap` (user prompt after a gap), `call npm|cat|recall SIZE` (an assistant request whose tool returns SIZE
  tokens: `npm` mutates, so it cannot be re-read; `cat` can; `recall` is `zip_recall` of the newest folded output), `say SIZE`
  (the request that answers and ends the run), `switch` (model), `restart` (a fresh pi process), `foreign SIZE` (a compaction
  someone else wrote). The away timer is not an event: the clock fires it.
* **Blocks** (session entries): kind, size, user turn, recoverability (re-readable, not re-readable, a recall result), the
  request that issued them; at each request each block is visible, folded or summarised, and recalled or not.
* **Cache**: per model, a response at t keeps the prefix until t + true TTL. Warm/cold at a request is a fact of this clock;
  what pi-zip *believed* (P(warm), cold, past TTL) is observed separately.
* **Costs**: the law's own units (`law.rs`): read r, rewrite w, output, the summary call; growth g.

## The axioms

| | axiom | formula |
|---|---|---|
| A1 | nothing is lost | □ nothing_lost: every message except a folded output or a summary goes out byte for byte (user text, tool args, system prompt, thinking); every output the model does not see verbatim comes back byte for byte from `zip_recall`; a user request summarised away is quoted verbatim |
| A2 | edit only when the cache is gone or the edit pays | □ (zip_edit → pays_or_cold): a new edit was planned at a cache believed gone, or the law's own model, **with the summary call priced as what it is** (uncached read of the conversation since the previous summary plus the summary written), says it costs no more than not editing |
| A3 | never in the way | □ (user_waits → at_room ∨ valve_summary ∨ switched): the user waits for a summary call only at Pi's compaction room, in the warm valve (rule 3 allows it; A2 prices it), or at a return a model switch made cold |

## Derived properties

| | property | from | formula (abridged) | why it follows |
|---|---|---|---|---|
| I1 | run stability | A2 | □(¬run_start ∧ ¬zip_edit ∧ ¬env → prefix_kept) ∧ □ persisted_as_sent | a byte change no priced edit explains is an unpriced rewrite; persisting something other than what was sent rewrites at the next request |
| RD | restart determinism | A2, A3 | □(run_start → fresh_plans_alike) | the law, b2b and one-summary rules must be functions of the session, or a restart re-decides on different state |
| RC | recall is never refolded | A1, A2 | □ recall_kept | refolding what the model asked for hides it again and invites the same recall: a rewrite each time |
| PW | protection windows | A1 | □ protection_respected | the latest two user turns stay: their outputs fold only if re-readable in the previous turn at a cold return or past the declared TTL, or ≥ 60 requests old; a summary never cuts into them, except coldwarm's F2 lookahead cut, which may reach the previous turn's final answer |
| B2B | no back-to-back warm rewrites | A2 | □(zip_edit → ¬○(zip_edit ∧ cache_warm ∧ planned_warm)) | the second rewrite pays the write twice for one saving |
| MP | monotone in P(warm) | A2 | □ monotone_in_p | an edit is never cheaper at a warm cache than at a cold one: at every decision point, re-planned on a grid of P with everything else fixed, the plan at a lower P covers or beats (smaller context, or the cold target reached) the plan at a higher P |
| NR | time consistency (no regret) | A2, A3 | □(cold_plan → [i0:=i] ¬(quiet U≤10 (i > i0 ∧ zip_edit ∧ planned_warm))) | an edit is free cold and paid warm: a warm edit within 10 requests of a cold plan with no new information means the cold plan was dominated |
| NT | no thrash | A2, A3 | □(zip_summary → ¬○(¬cold_plan U (zip_summary ∧ ¬cold_plan ∧ ¬at_room))) ∧ □(zip_summary → summary_worth_it) | two summaries in one warm stretch are two uncached calls for one saving; a summary that removes less than it writes, or works within a minimal summary of the floor (system prompt + previous summary + protected turns), is a summary for nothing |
| TR | target reachability | A2 | □(cold_plan → target_reached_or_excused) | the cold return is the one free rewrite: it reaches the cold target (±15%) unless the floor fills it, the law refused the summary, or the class is not known yet |
| LW | the law as specified | A2 | □ law_as_specified | every law evaluation of the real planner equals `law.rs` on the same inputs (the summary step's call term is backed out of K and must be ≥ 0), so the lemmas below apply to the code |
| G, W | harness fidelity | | | the P-grid re-plan at the actual P reproduces the decision run.ts acted on; the bridge's provider keeps the cache exactly as the spec's clock says |

**New information** (NR) is exactly: a model switch, a foreign compaction, a `zip_recall`, the cache class learned from the first
response, a new cold return, or growth of more than DELTA = 10K real tokens since the cold plan. Everything else, in particular
**the protection window sliding by one user turn** and the passage of time below the TTL, is not new information. B2 is the
first, so a cold plan that could not summarise only because the window had not slid yet is dominated by the warm summary one
prompt later.

**Monotonicity** is checked at every decision point of every trace by re-planning with the real `planContext` and the captured
options (entries, scale, prices, g, recalled set, pastTtl), varying only P over {0, .25, .49, .51, .75, 1} plus the actual P, with
the mode derived from P exactly as run.ts derives it (cold iff P < 0.5). Property G checks that this probe reproduces the actual decision.

## What is proven, what is checked

**Proven** (lemmas about `plan.ts lawTerms`, the same function in 0.2.8, affine, coldwarm and rc030; `pz-formal lemmas --src DIR`
re-checks M, C and S on the real code over 226,800 points and finds the port identical at every one; property LW checks at every
decision of every trace that the code calls it as specified):

Let D = B − A, T' = min(T, A), K(P) = (w − r)(P·T' − (1 − P)·D) + call, gain = r·D²/(2·max(g, 1)) + η·D, ok = (K ≤ 0 ∨ gain ≥ K).

* **M (monotone in P).** dK/dP = (w − r)(T' + D). The code guarantees D > 0 (`if (!(A < B)) return none`, the first line of
  lawTerms), T' ≥ 0 (A ≥ 0: A is a context size, at least O), and w ≥ r (`learn.ts CLASS_RATIOS`: 1.25 > 0.1, 2 > 0.1 on the
  long tier, 1 > 0.2; and `pr.r > 0` is required, else the P-free legacy rule applies). So T' + D > 0 and K is non-decreasing
  in P, while gain does not depend on P. Both disjuncts of ok are preserved when P decreases: ok is antitone in P. ∎
* **G (gain ≥ 0).** r > 0, D > 0 make the read term ≥ 0. η > 0 only when B ≥ room; its numerator is
  w(B − keep) + out·s + (w − r)(keep + s) = w·B + (w − r)·s − r·keep with s ≥ 1000; since the room is ≥ 4096 (`MIN_TARGET`), w ≥ 1
  and r ≤ 0.2 (CLASS_RATIOS), w·B ≥ 4096 > 0.2·20000 = r·keep, so η ≥ 0. ∎
* **E (economic sanity: an edit chosen under the law never costs more than not editing, in expectation, in the law's model).**
  The law's model says E[cost | edit] − E[cost | no edit] = K − gain. If gain ≥ K this is ≤ 0. If K ≤ 0, K − gain ≤ −gain ≤ 0 by G. ∎
* **C (a dead cache always edits).** P = 0, call = 0: K = −(w − r)·D < 0. ∎
* **S (a model call only makes an edit harder).** call ≥ 0 adds to K and nothing else. ∎

The lemmas are about the law, so they say where non-monotonicity in the *implementation* can come from: not the law, but the
**candidate plan** the law is asked about, which may change with the mode. B1 is exactly that. In 0.2.8 the warm plan asked the
summary gate nothing (`mode === "warm" || gate("summary", ...)`), so its call term was 0, while the cold plan's call term was
positive. By S the warm summary then passed where the cold one failed. coldwarm's F1 removes that difference; the MP breaches left
in rc030 are other candidate-set effects (TRIAGE.md).

**Bounded-checked, as conformance on the real code**: every other property, over:

* **exhaustive families** (`pz-formal count`): depth-4 runs over gaps {60 s, 330 s, 1 h} × bodies {quick answer, 60K prose,
  30K command output, 30K re-readable output} in an explicit and a GLM-like world (13,824 traces); depth 5 over {60 s, 1 h} ×
  {quick, prose, command} (3,888); depth 3 over {60 s, 270 s, 1 h} × {quick, prose, two 25K outputs, recall} with one switch,
  restart or foreign compaction placed before any run (4,032);
* **3,000 random traces** at realistic sizes (3 to 10 runs, 0 to 6 tool calls a run, 4% long autonomous runs of 20 to 70 calls,
  outputs 100 to 40K log-uniform, gaps from seconds to hours across the TTL, random worlds);
* 24,744 traces and 239,402 requests per source; one minimal counterexample is kept per (property, mechanism) and shrunk greedily
  (drop runs, events, specials; round sizes and gaps to canonical values; move the world to the default).

## Limits

* **Bounds.** Depth ≤ 5 runs exhaustively, sizes in a few buckets; random traces are not exhaustive. K_REGRET = 10 requests,
  DELTA = 10K, size tolerances 10% (15% for the cold target, the README's own estimate error).
* **Abstractions.** Tool outputs are synthetic text; real tokens = c × chars/4 exactly (no tokenizer noise, so every size error
  the checker sees comes from pi-zip's calibration, not the text); one tool call per request; no images, thinking, steering,
  errors or aborts; the provider cache is an exact prefix cache with a hard TTL; two models; no Pi idle cache warming; the
  narrative model returns a fixed text instantly (summary *content* quality is not checked, only what A1 requires of it).
* **Mirrored, not called.** Pi's agent loop and its event order (`session_start`, `before_agent_start`, prompt appended, per
  request `context_with_system` → `before_provider_request` → assistant `message_end` → tool result → `turn_end`, then
  `agent_before_settle`); the provider and its usage reports; Pi's `AgentSession.compact()` around the real `prepareCompaction`
  (as in pi-zip's own integration test rig); the clock and timers (virtual `Date` and `setTimeout`). Called for real: pi-zip's
  `index.ts` wiring and everything below it (run.ts cold detection, run plan, valve, b2b skip, summarizedWarm, pastTtl, away timer,
  native compaction, persistence at turn_end, learning), Pi's `SessionManager` and `AgentSession._applyBoundaryDrafts`,
  `convertToLlm`.
* **Probes.** MP re-plans with `planContext` and the options run.ts passed (captured by wrapping `Zip.prototype.opts`); RD runs a
  second pi-zip instance on a snapshot of the session and of the learned-survival file, at the instant the live request was sent,
  and to name the cause transplants the live in-memory fields into it (g, justEdited, summarizedWarm, clock, learned class).
* **Options.** `--plan-opts '{"lookahead":true}'` merges planner options into every `planContext` call (how coldwarm's F2 is
  turned on without editing src).
* The checker never writes outside a per-worker temp dir (stats, recall files, flags); the session under test is in memory.

## Results (last acceptance run)

Traces failing, out of 24,744 per source (0 = pass). Sources: 0.2.8 = `/tmp/pz-replay/src`; affine = this worktree's `src`
(f5deda1); coldwarm = `/tmp/pz-coldwarm/src` 1fe03c2; rc030 = `/tmp/pz-rc/src` fa3a467 (the v0.3.0 candidate); +F2 = with
`--plan-opts '{"lookahead":true}'`. Every failing class, its code site and its fix direction are in `TRIAGE.md`.

| property | evidence | 0.2.8 | affine | coldwarm | coldwarm +F2 | rc030 | rc030 +F2 |
|---|---|---|---|---|---|---|---|
| A1 nothing is lost | conformance | 0 | 0 | 0 | 0 | 0 | 0 |
| A2 edit only when gone or it pays | conformance | 4,305 | 3,978 | 24 | 24 | 24 | 24 |
| A3 never in the way | conformance | 83 | 85 | 104 | 540 | 104 | 540 |
| I1 run stability | conformance | 0 | 0 | 0 | 0 | 0 | 0 |
| RD restart determinism | conformance | 10,622 | 10,279 | 8,712 | 8,717 | 8,712 | 8,717 |
| RC recall never refolded | conformance | 0 | 0 | 0 | 0 | 0 | 0 |
| PW protection windows | conformance | 0 | 0 | 0 | 0 | 0 | 0 |
| B2B no back-to-back warm rewrites | conformance | 6 | 5 | 7 | 7 | 7 | 7 |
| MP monotone in P(warm) | proven (law) + conformance (planner) | 14,055 | 13,585 | 14 | 25 | 14 | 25 |
| NR time consistency / no regret | conformance | 1,559 | 1,534 | 191 | 190 | 191 | 190 |
| NT no thrash | conformance | 221 | 3 | 1 | 1 | 1 | 1 |
| TR target reachability | conformance | 0 | 9 | 9 | 9 | 9 | 9 |
| LW law as specified (lemmas M, E, G, C, S) | proven + conformance | 0 | 0 | 0 | 0 | 0 | 0 |
| G, W harness fidelity | conformance | 0 | 0 | 0 | 0 | 0 | 0 |

The two live bugs, rediscovered on 0.2.8 as minimal counterexamples (`traces/b1.trace`, `traces/b2.trace`):

* **B1**: MP fails at the third request of `prompt; say 60K; prompt +60s; say 100; prompt +60s; say 100`. The warm run plan
  summarises (P >= 0.51) what the cold plan's summary gate refuses at P = 0. Class "B1, the warm summary skips the summary gate the
  cold one fails": 12,073 traces.
* **B2**: NR fails at `prompt; say 60K; prompt +1h; say 100; prompt +60s; say 100`. The cold return cannot cut into the protected
  60K turn, the window slides at the next prompt, and the warm run plan summarises while the user waits. 951 traces.

0.2.8's lower A3 count is not a better score. Its waits are mostly in the warm valve, which rule 3 allows; A2 counts them as
unpriced (4,305). In rc030 B1 is gone and the B2 summary class is down to one trace. What is left is the (a) list in `TRIAGE.md`.

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
pi-durable-subagents hold machine -- ./run-all.sh             # the acceptance run: every source (about 70 min on 28 cores)
cargo test && cargo clippy --all-targets
```

`check` options: `--suite standard|quick|none`, `--family 'worlds=explicit,glm depth=4 gaps=60,330,3600 bodies=q,p,b,c
specials=switch,restart,foreign'`, `--random N --seed S`, `--only A2,MP`, `--shrink ROUNDS` (0 = no shrinking), `--workers W`,
`--plan-opts JSON`, `--pi DIR` (another pi-coding-agent). A standard check without shrinking takes about 75 s for 24,744 traces.
