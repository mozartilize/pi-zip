# Lean verification of the pi-zip cost models

The full gate currently checks **23 statement definitions, one general proof,
one general refutation, and 23 concrete nonvacuity witnesses**. The remaining
21 statements have no general proof or refutation. This is an incomplete proof
project: a passing gate does not mean all the paper's theorems are proved.

The source specification is `research/round6/theory.md`, especially sections
2.3-2.4 and T2-T5. The source README is `research/round6/readme-math.md`.
The round-one fidelity workflow stopped after two correction rounds without a
PASS verdict. `FROZEN.sha256` is empty; the audited definitions are the current
source definitions, and their hashes have not been frozen. No source theory or
source README was edited during integration.

The recorded full run is [verification/full-gate.txt](verification/full-gate.txt):

```text
CHECK: statements 23, proved 1, refuted 1, missing 21, gate PASS
```

Every module built and was rechecked by `leanchecker`. The two audited results
use only `propext`, `Classical.choice`, and `Quot.sound`.

## Statement coverage

All definitions and their source quotations and hypothesis inventories are in
[PiZip/Statements/R1.lean](PiZip/Statements/R1.lean). `BLOCKED` below means
`MISSING` in the gate: the workflow stopped before the scheduled prover passes.
It does not mean a prover exhausted a proof attempt. Witnesses establish that
the hypotheses can hold; they do not prove the universal conclusions.

| Lean statement | English theorem part | Status | Content |
| --- | --- | --- | --- |
| `T2_i` | T2(i), line 523 | BLOCKED | Expected fire-minus-hold cost, including new-token writes. |
| `T2_ii` | T2(ii), lines 524-526 | BLOCKED | Positive affine slope, sufficient probability statistic, and Bayes threshold. |
| `T2_iii` | T2(iii), lines 527-530 | BLOCKED | Audited A-n law and conservative shipped A law. |
| `T2_iv_a` | T2(iv)(a), line 535 | BLOCKED | Real interval integral for fluid regrowth rent. |
| `T2_iv_b` | T2(iv)(b), lines 536-537 | BLOCKED | Zero-price warm threshold and fluid EOQ minimum, with conditional attainment. |
| `T2_iv_c` | T2(iv)(c), lines 538-539 | BLOCKED | Discrete steady-growth rent ledger including the current request. |
| `T2_v` | T2(v), lines 540-545 | BLOCKED | Exact dead-cache and zero-price warm-cache corner decisions. |
| `T2_vi` | T2(vi), line 546 | BLOCKED | Regret from an estimated cache probability. |
| `T2_vii` | T2(vii), lines 547-552 | BLOCKED | Candidate warm/hazard formulas, value comparison, and firing-region inclusion. |
| `T2_vii_warm_exact` | T2(vii), lines 548-550; proof 593-598 | BLOCKED | Optimal fluid average cost, normalized Bellman solution, and relative-value uniqueness. |
| `T2_vii_hazard_exact` | T2(vii), line 551; T6(i)-(ii) | BLOCKED | Hazard root, stationary renewal minimum, relative-value identification, and Bellman alternatives. |
| `T3_i` | T3(i), lines 623-624 | BLOCKED | Finite-horizon lower bound against every schedule. |
| `T3_ii` | T3(ii), lines 625-626 | BLOCKED | Integer-optimal cycle and finite bounds establishing its long-run rate. |
| `T3_iii` | T3(iii), line 627 | BLOCKED | BAL equals the integer-optimal periodic schedule. |
| `T3_iv` | T3(iv), lines 628-629 | BLOCKED | True-growth LAW cycle, rounding range, and absolute/relative excess. |
| `T4_i` | T4(i), line 677 | BLOCKED | BAL factor-two bound, strict when BAL edits. |
| `T4_ii` | T4(ii), lines 678-679 | BLOCKED | Deterministic online lower bound with a positive hindsight optimum. |
| `T4_iv` | T4(iv), lines 686-690 | BLOCKED | Early and late LAW adversaries; quantitative early ratio lower bound. |
| `T5_i` | T5(i), lines 758-759 | BLOCKED | Arbitrary-predicate guard bound, strict when it edits. |
| `T5_ii` | T5(ii), lines 760-767 | BLOCKED | Fixed-estimate/EWMA lower bounds, local price condition, and false-predicate BAL. |
| `T5_iv` | T5(iv), lines 771-773 | BLOCKED | Steady-growth guard equals BAL and its integer-optimal cycle. |
| `T5_v` | T5(v), lines 774-775 | REFUTED | Unqualified immediate-LAW burst consistency claim. |
| `T5_v_persistent` | Corrected T5(v), lines 774-775 | PROVED | First guarded cycle costs less than (1+alpha)B when LAW persists through its edit. |

There is additional checked content in [PiZip/Proofs/T45.lean](PiZip/Proofs/T45.lean):
`law_early_quantitative` proves the quantitative early clause of T4(iv), with
burst `D = sqrt(2*Ghat*B)+1`, LAW cost `B`, optimal hold cost `D`, and ratio at
least `B/(sqrt(2*Ghat*B)+1)` whenever this burst is smaller than `B`. The entire
combined `T4_iv` remains unproved. The T2 and T3 proof modules contain no general
proofs. [PiZip/Sanity1.lean](PiZip/Sanity1.lean) checks concrete model instances,
source table rows, nonvacuity witnesses, and the counterexamples below. Python
screening in `screen_r1.py` assists proof design and supplies no proof evidence.

## Refutation and source corrections

`T5_v_false : ¬ PiZip.T5_v` refutes the original T5(v). Set `B=10`, `D=1`,
`alpha=1/2`; let the online estimate be `1/100` on the first request and `100`
afterwards, followed by zero arrivals. LAW holds immediately but then stops
holding. The guard edits at request 10 and pays `9+10=19` on its first cycle,
which exceeds `(1+alpha)B=15`.

`T5_v_persistent_proof : PiZip.T5_v_persistent` proves the corrected version:
LAW must remain true at every decision through the first guarded edit. The
horizon condition ensures that an edit occurs. Fixed estimates and estimates
non-increasing along the burst satisfy this qualification if LAW holds on the
burst. The proof requires no restriction on later cycles. Update T5(v), its
proof, the dependent cited consistency discussion, and source README claim 5.

Other checked findings require changes to the English:

- T2(iv)(b) needs `call=eta=0` and must name the **fluid** EOQ optimum. Positive
  call and positive room-price counterexamples are proved in
  `law_positive_call_counterexample` and `law_positive_room_counterexample`.
  Attainment at a positive optimum also needs `n<A`; at `n=A` the positive-cycle
  objective has infimum zero without an attained positive minimum.
- T4(iv)'s estimate upper bound supplies a ratio lower bound, not the claimed
  uniform upper bound. `law_bounded_estimate_no_ratio_upper` exhibits a zero
  estimate bounded by `Ghat=1` with `B=100`, `D=1`, and ratio `100>sqrt(50)`.
  The upper-bound illustration is valid for a fixed positive actual estimate
  and its rounded threshold burst. The general construction should avoid
  choosing the burst through its own arrival-dependent estimate.
- T5(iv)'s optimal BAL cycle is **no worse than** LAW; strict superiority fails
  at `g=G=1`, `B=50`, where both use cycle 10 and cost 9.5 per request. This row
  is an exact rational check, not a proof of general steady-growth optimality.
- T2(vii)'s closed-form comparisons alone do not identify true model values.
  `T2_vii_warm_exact` and `T2_vii_hazard_exact` separately state the missing
  optimality/Bellman identifications; both remain unproved. “Not the true
  continuation value at any p” should mean no general exact-value claim: the
  source itself gives equality at `D=Dstar`. The hazard comparison is with the
  warm-forever value, rather than a claimed bound by the surrogate.
- Strict competitive bounds require an edit (zero-cost instances defeat a
  blanket strict inequality). The EWMA lower bound concerns the stream of
  removable arrivals with weight 0.1, not an arbitrary context-growth estimator.
  Substitution of positive `Beff` establishes the local price condition, not
  a competitive guarantee when the rewrite price varies over time.

Exact proposed line replacements and their evidence are in the integration
notes `research/round8/theory-corrections.md`.

## Paper-only and deferred scope

T6 remains paper-only: full all-policy hazard optimality, mixtures of policies,
asymptotic expansions, and the numerical excess grid have no general Lean
proof here. The model-C hazard definitions and pending `T2_vii_hazard_exact`
are only partial overlap. T6(v)'s grid is numerical evidence, not a universal
analytic bound. T7 remains paper-only because its planner, adoption, room-wait,
and b2b behavior needs a separate model of the synthesis. Model-C affine
statements cover only a small part of its candidate-level reasoning.

T4(iii)'s randomized TCP/ski-rental bound and T5(vi)'s cited prediction trade-off
are paper citations outside this proof round. T5(iii)'s endpoint/limit claims
were also outside the assigned groups and remain paper-only.

T1, T8, T9, and T10 were deferred by coordinator decision: no public claim was
assigned to them for this round's Lean evidence, and T9/T10 overlap the separate
code-level formal model. The source README still contains corresponding paper
claims; this scope decision does not establish them in Lean. WM, fold model F,
and the handler state machine are absent from this project.

## Trusted base and independent checks

The main proof boundary is the Lean kernel (Lean 4 v4.35.0-rc4), the pinned
Mathlib dependency (`051bc08`), and the gate's coverage/type/axiom checks.
Mathlib's imported results are checked Lean declarations; the accepted logical
axioms are exactly `propext`, `Classical.choice`, and `Quot.sound`. The build,
import/export tooling and the gate scripts also mediate which declarations
are checked and reported. The gate permits missing proofs and an empty frozen
manifest, so neither completeness nor approved freezing follows from PASS.

A human must review the models' fidelity to the English. Read the statement
quotations and added hypotheses in `PiZip/Statements/R1.lean` together with
`PiZip/ModelC.lean`, `PiZip/ModelT.lean`, and `PiZip/ModelEOQ.lean`. Kernel checks
establish the mathematical propositions as written, not their correspondence
to provider pricing, product behavior, or the source prose.

Nanoda supplied an additional kernel check of a dependency-closed export of all
119 named source declaration roots, including the audited proof/refutation,
helpers, statements, and witnesses. Export coverage was verified, with only the
three allowed axioms. `nanoda_bin` 0.4.19 exited zero and reported 34,395 checked
declarations with no typechecker errors and one pretty-printing diagnostic
(“Unable to print axioms”). The bundled `lean4lean` exited one because its
reader rejected the current `.olean` headers; it provides no validation.
Details are in [verification/independent-check.txt](verification/independent-check.txt).
The approximately 170 MiB export stays in ignored `audit/` and is reproducible.

## Running the checks

With the pinned toolchain and existing Mathlib cache installed:

```sh
export PATH="$HOME/.elan/bin:$PATH"
./check.sh
```

`./check.sh --quick` omits the kernel recheck. Do not update or clean Lake or
alter the toolchain/dependency configuration when reproducing this run.
The gate writes its transient build/audit files into `audit/`.

To reproduce the supplementary Nanoda check using the recorded roots:

```sh
lake env leanexport PiZip -- $(cat verification/export-roots.txt) > audit/pizip-export.ndjson
lake env nanoda_bin verification/nanoda-config.json
```

Confirm the exporter succeeds with no missing-root diagnostic before trusting
the checker; the root list records this integration snapshot. The Nanoda
configuration rejects other axioms and enables its Nat and String extensions.
Changes to source declarations require updating and reviewing the export roots.
The next dependency is a successful fidelity review, approved freezing, and the
missing prover passes before claiming complete T2-T5 theorem coverage.
