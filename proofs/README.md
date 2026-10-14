# Lean verification of the pi-zip cost models

The full gate checks **23 frozen statement parts: 22 PROVED, one REFUTED,
zero missing**, with concrete nonvacuity witnesses for all 23 parts. This covers
the assigned T2-T5 parts, including corrected T5(v). It does not certify every
theorem in the paper or the implementation's behavior.

The English theorems and their model qualifications are in the
[design document](../docs/design.md). The
`theory.md` line numbers quoted below and in the statement doc comments refer
to the corrected snapshot of unpublished research notes; those notes are not
part of this repository. The English and Lean statements were reviewed by
hand for fidelity. A machine check proves the Lean statements as written,
not their correspondence to the English or to the implementation.

The statement fidelity review and the T2, T3, and T45 proof reviews reported
PASS. [FROZEN.sha256](FROZEN.sha256) is non-empty: the three models and
Statements/R1 are frozen, and all four hashes were verified by the full gate.
The recorded full run is [verification/full-gate.txt](verification/full-gate.txt):

```text
CHECK: statements 23, proved 22, refuted 1, missing 0, gate PASS
```

## Statement coverage

T2 uses the one-decision Model C (and its explicitly stated fluid continuation
comparisons); T3 uses the steady-growth EOQ model and compares all edit
schedules. T4 and T5 use Model T: one stream, fixed positive rewrite price,
and a live cache, with the best hindsight edit schedule as comparator.
Optimality in the table below is restricted to those models and classes.

[PiZip/Statements/R1.lean](PiZip/Statements/R1.lean) contains every exact
proposition, source quotation, and inventory of added hypotheses. PROVED means
a theorem named `<statement>_proof` has exactly that proposition; REFUTED means
`<statement>_false` proves its negation. All results are in namespace PiZip.
Nonvacuity witnesses in [PiZip/Sanity1.lean](PiZip/Sanity1.lean) show the
hypotheses can hold; the universal conclusions are established by the proofs.
Source line numbers refer to that unpublished snapshot, not the main README.

| Lean statement | English theorem part | Status | Checked content |
| --- | --- | --- | --- |
| `T2_i` | T2(i), line 523 | PROVED | Fire-minus-hold cost identity, including new tokens. |
| `T2_ii` | T2(ii), lines 524-526 | PROVED | Positive affine slope, zero crossing, and Bayes probability threshold. |
| `T2_iii` | T2(iii), lines 527-530 | PROVED | Audited A-n law and conservative shipped A law. |
| `T2_iv_a` | T2(iv)(a), line 535 | PROVED | Fluid rent integral equals the cycle surrogate. |
| `T2_iv_b` | T2(iv)(b), lines 536-539 | PROVED | Zero-price fluid threshold, positive-price attainment, and zero-price unattained infimum. |
| `T2_iv_c` | T2(iv)(c), lines 540-541 | PROVED | Discrete rent ledger includes the current request. |
| `T2_v` | T2(v), lines 542-547 | PROVED | Cold-cache and zero-price warm-cache corner decisions. |
| `T2_vi` | T2(vi), line 548 | PROVED | Estimated-probability regret and shipped upper bound. |
| `T2_vii` | T2(vii), lines 549-555 | PROVED | Warm-value comparison, equality condition, firing inclusion, and strict hazard comparison. |
| `T2_vii_warm_exact` | T2(vii), lines 550-552; proof 599-604 | PROVED | Optimal fluid average cost, normalized Bellman solution, and relative-value uniqueness. |
| `T2_vii_hazard_exact` | T2(vii), lines 553-554; overlap with T6(i)-(ii) | PROVED | Unique positive hazard root, stationary renewal minimum, relative-value identification, and every first-wait Bellman alternative. |
| `T3_i` | T3(i), lines 629-630 | PROVED | Finite lower bound for every schedule, including the terminal segment. |
| `T3_ii` | T3(ii), lines 631-632 | PROVED | Optimal integer cycle and finite bounds establishing the long-run rate. |
| `T3_iii` | T3(iii), line 633 | PROVED | BAL equals the optimal periodic schedule on every actual request. |
| `T3_iv` | T3(iv), lines 634-635 | PROVED | LAW ceiling cycle, rounding range, and strict absolute/relative excess bounds. |
| `T4_i` | T4(i), line 683 | PROVED | BAL cost at most twice every comparator; strict whenever BAL edits. |
| `T4_ii` | T4(ii), lines 684-685 | PROVED | Prefix-only deterministic adversary with positive, attained hindsight optimum. |
| `T4_iv` | T4(iv), lines 693-697 | PROVED | Quantitative early adversary and unbounded late adversary. |
| `T5_i` | T5(i), lines 767-768 | PROVED | Arbitrary-predicate guard bound; strict whenever the guard edits. |
| `T5_ii` | T5(ii), lines 769-780 | PROVED | Fixed/EWMA lower bounds, local price condition, and false-predicate BAL; strict for positive comparator cost. |
| `T5_iv` | T5(iv), lines 784-786 | PROVED | Steady-growth guard equals BAL and its optimal periodic cycle. |
| `T5_v` | Historical T5(v), preserved original; corrected source lines 787-789 | REFUTED | Immediate LAW alone does not imply the first-cycle consistency bound. |
| `T5_v_persistent` | Corrected T5(v), lines 787-789 | PROVED | Persistence through the first guarded edit restores the strict first-cycle bound. |

The proof modules are [T2](PiZip/Proofs/T2.lean), [T3](PiZip/Proofs/T3.lean),
and [T45](PiZip/Proofs/T45.lean). The gate checks every module through
[PiZip.lean](PiZip.lean) and audits each result against its frozen definition.
The finite bounds in T3 imply the long-run rates without introducing limits.
The relative excess in T3(iv) is measured above the fluid lower bound and
normalized by the optimal integer rate, as stated in the English proof.

## Refutation and true statement

`T5_v_false : ¬ PiZip.T5_v` preserves and refutes the original, unqualified
T5(v). Take B=10, D=1, alpha=1/2, with estimate 1/100 on the first request
and 100 thereafter, followed by zero arrivals. LAW fires immediately but
stops holding. The guard first edits at request 10 and its first cycle costs
19, exceeding the proposed bound 15.

`T5_v_persistent_proof : PiZip.T5_v_persistent` proves the corrected sentence:
LAW holds at every decision through the first guarded edit, and the horizon
contains that edit. Its first cycle costs strictly less than (1+alpha)B.
The exact sufficient horizon is alpha*B <= (m+1)*D, since `burst D m` has m+1
requests. A fixed or non-increasing burst estimate suffices when LAW holds
initially. No restriction is imposed after the first edit. A shorter concrete
witness has B=10, D=1, alpha=1/2, m=4 and cost 14 < 15.

Other pass-one findings were applied to the English before the proof passes:

- T2(iv)(b) requires zero call and room prices, names the fluid optimum, and
  distinguishes positive-price attainment from the n=A unattained infimum.
  Checked positive-call and positive-room counterexamples establish why the
  omitted-price reading fails.
- T2(v)/(vii) treats the cycle surrogate as lacking general model identification.
  The warm and hazard identifications are now separately proved. The strict
  hazard comparison is with the warm-forever value on 0 < D <= Dstar.
- T4(iv) has a quantitative ratio lower bound and an estimate-independent burst
  D=sqrt(2*Ghat*B)+1. An estimate upper bound alone gives no ratio upper bound;
  the numerical upper-bound illustration requires a fixed positive actual
  estimate and its rounded threshold burst.
- T5(ii) uses removable-arrival EWMA with weight 0.1. Its positive-effective-price
  substitution proves a local necessary condition, with no varying-price
  competitive theorem. Universal cost bounds are non-strict on zero-cost
  instances; false-predicate BAL has strict ratio below 2 on positive OPT.
- T5(iv) is no worse than LAW, allowing equality. At g=G=1, B=50 both cycles
  are 10 and both rates are 9.5. Persistence qualifies T5(v) and the cited
  consistency discussion.
- README claims about the T6 grid and T7 planner were restricted to their paper
  evidence. Neither supplies a universal numerical bound or a Lean planner proof.

The [design document](../docs/design.md#what-is-proved) incorporates these qualifications.

## Paper-only and deferred scope

| English theorem part | Status | Scope and reason |
| --- | --- | --- |
| T4(iii) | paper | Cited randomized TCP/ski-rental bound; no randomized-policy model or proof in this round. |
| T5(iii) | paper | Endpoint/limit assertions outside the assigned theorem groups; alpha=0 in T5(iv) does not prove the general limit claim. |
| T5(vi) | paper | Cited optimal consistency/robustness trade-off; the burst consistency implication is proved only with persistence. |
| T6(i) | paper | T2_vii_hazard_exact proves the positive-parameter stationary renewal minimum and root; helpers evaluate survival-weighted costs. There is no separately audited T6 statement. |
| T6(ii) | paper | The unique stationary minimizer and every first-wait Bellman alternative are checked. The infinite-sequence, finite-total-time and randomized-mixture argument is not formalized. |
| T6(iii) | paper | Small-hazard asymptotic expansion not formalized. |
| T6(iv) | paper | Dimensionless excess and its asymptotic expansion not formalized. |
| T6(v) | paper | Grid, numerical maximizer, and large-hazard limit not checked here; finite sampling does not establish a universal analytic bound. |
| T7(i) | paper | Candidate monotonicity needs the planner model; Model C affine results cover only its algebraic ingredient. |
| T7(ii) | paper | Applied-edit counterexample needs synthesis/adoption states absent here. |
| T7(iii) | paper | Weak planner monotonicity and planned-view bound need the planner model. |
| T7(iv) | paper | Adoption variant and room-wait qualification need the handler/planner model. |
| T7(v) | paper | b2b behavior needs the synthesis model absent here. |
| T1 | paper | Persistent-edit schedule model absent from the Lean scope. |
| T8 | paper | Fold model absent from the Lean scope. |
| T9 | paper | Handler inspection, with separate bounded checks of the implementation. |
| T10 | paper | Event induction, with separate bounded checks of the implementation. |

T1, T6-T10 and the cited results T4(iii), T5(iii), T5(vi) remain paper proofs.
This project supplies no separately audited Lean statements for them.

## Trusted base and additional kernel checks

The primary proof boundary is the Lean kernel (Lean 4 v4.35.0-rc4), the pinned
Mathlib dependency (051bc08), and the gate's source coverage, exact-type and
axiom checks. Mathlib results are checked Lean declarations. The only accepted
logical axioms are `propext`, `Classical.choice`, and `Quot.sound`; all 23 audited
results use only these. The build/import tools and check.sh determine what gets
checked. PASS alone permits missing parts; the explicit zero-missing count and
verified non-empty manifest matter here. leanchecker rechecked every module.

A human must review fidelity to the English. Compare the quotations and added
hypotheses in [Statements/R1](PiZip/Statements/R1.lean) with
[ModelC](PiZip/ModelC.lean), [ModelT](PiZip/ModelT.lean), and
[ModelEOQ](PiZip/ModelEOQ.lean). A kernel proves the propositions as written;
it does not certify correspondence to provider pricing, measured product
behavior, or the English. Frozen comments that say “unproved” record the
statement-design snapshot and do not describe the current proof coverage.

The supplementary Nanoda check exports all 231 named source roots and their
recursive dependencies, including every proof, refutation, statement, helper,
and named witness. Nanoda 0.4.19 exited zero after checking 43,722 declarations with no typechecker
errors and one pretty-printer diagnostic (“Unable to print axioms”). The export
contained only the three permitted axioms and covered every recorded root. The
bundled lean4lean rejects the current .olean headers and provides no validation. Exact supplementary results, versions and
limitations are recorded in
[verification/independent-check.txt](verification/independent-check.txt).
The large export remains an ignored artifact in audit/.

## Reproducing the checks

With the pinned toolchain and cached Mathlib installed, run from proofs/:

```sh
export PATH="$HOME/.elan/bin:$PATH"
./check.sh
```

`./check.sh --quick` omits the kernel recheck. Do not run lake update or lake
clean, alter the dependency/toolchain configuration, or delete .lake.
The gate writes transient artifacts to audit/.

To reproduce the scoped supplementary check:

```sh
lake env leanexport PiZip -- $(cat verification/export-roots.txt) > audit/pizip-export.ndjson
lake env nanoda_bin verification/nanoda-config.json
```

Require a successful export with no missing-root diagnostics. The recorded
root list covers this integration snapshot; review it again if declarations
change. The Nanoda configuration rejects other axioms and enables Nat and
String kernel extensions. Python screening assists proof design and is never
verification evidence. Future T6/T7 work needs explicitly scoped models and
statements. The main README records the current public proof coverage.
