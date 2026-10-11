import PiZip.ModelC
import PiZip.ModelEOQ

namespace PiZip

/-- "E[cost | fire] − E[cost | hold] = Δ(p) := p·κ·(A − n) − (1 − p)·κ·D − η·D + c − V(D), with V(D) := D + F(D)."
Added hypotheses: ModelC.Valid makes explicit positive removal and premium, nonnegative
view, call, room price and new tokens, n <= A (new tokens are part of A), and n < B.
The premium is positive for every price class in section 2.3. The probability lies in
[0,1], and F >= 0, as required by Model C. A common Future(0) cancels from both costs. -/
def T2_i : Prop :=
  ∀ (x : ModelC.Instance ℝ) (p F : ℝ), ModelC.Valid x → ModelC.probability p → 0 ≤ F →
    ModelC.fireCost x - ModelC.holdCost x p F = ModelC.delta x p (x.D + F)

/-- "Δ is affine in p with slope κ·(B − n) > 0."
"The Bayes action therefore depends on the prior over the cache state only through p, which is a sufficient statistic."
"It is a threshold rule: fire iff p ≤ p*, where Δ(p*) = 0."
Added hypotheses: ModelC.Valid and nonnegative F as in (i). Both action costs are
functions of the posterior only through p; the affine identity holds even outside
[0,1]. The Bayes rule breaks equal-cost ties in favor of fire, matching "iff".
No assumption that p* lies in [0,1] is made. -/
def T2_ii : Prop :=
  ∀ (x : ModelC.Instance ℝ) (F : ℝ), ModelC.Valid x → 0 ≤ F →
    0 < x.k * (ModelC.view x - x.n) ∧
    (∀ p q : ℝ, ModelC.delta x p (x.D + F) - ModelC.delta x q (x.D + F) =
      x.k * (ModelC.view x - x.n) * (p - q)) ∧
    ModelC.delta x (ModelC.threshold x (x.D + F)) (x.D + F) = 0 ∧
    (∀ p : ℝ, ModelC.probability p →
      (ModelC.fireCost x ≤ ModelC.holdCost x p F ↔ p ≤ ModelC.threshold x (x.D + F)))

/-- "With the EOQ cycle value V(D) = D²/(2g), the Bayes rule is the law with T = A − n:
D²/(2g) + (η + (1 − p)·κ)·D ≥ p·κ·(A − n) + c, with p* = (D²/(2g) + (η + κ)·D − c)/(κ·(B − n))."
Added hypotheses: ModelC.Valid, p in [0,1], g > 0 (a regrowth cycle needs positive
growth). This is substitution of a surrogate V into Delta, not an assertion that
V-D is a nonnegative future saving for every D.

"The shipped law is the n = 0 form, with T = A. It is *conservative*: its right side is larger by p·κ·n, so it fires only where
the Bayes rule fires."
Added hypotheses: ModelC.Valid, p in [0,1], g > 0, as in (iii). -/
def T2_iii : Prop :=
  (∀ (x : ModelC.Instance ℝ) (p g : ℝ), ModelC.Valid x → ModelC.probability p → 0 < g →
    (ModelC.delta x p (ModelC.cycleValue x.D g) ≤ 0 ↔ ModelC.law x p g (x.A - x.n)) ∧
    (ModelC.law x p g (x.A - x.n) ↔ p ≤ ModelC.threshold x (ModelC.cycleValue x.D g))) ∧
  (∀ (x : ModelC.Instance ℝ) (p g : ℝ), ModelC.Valid x → ModelC.probability p → 0 < g →
    (p * x.k * x.A + x.call) - (p * x.k * (x.A - x.n) + x.call) = p * x.k * x.n ∧
    (ModelC.law x p g x.A → ModelC.law x p g (x.A - x.n)) ∧
    (x.n = 0 → (ModelC.law x p g x.A ↔ ModelC.law x p g (x.A - x.n))))

/-- "it is the rent of one linear regrowth cycle from 0 to D, ∫₀^{D/g} g·t dt;"
Added hypotheses: g > 0 and D > 0, the growth and removal of the cycle in Model C.
The integral is the ordinary real interval integral, not a discretized sum. -/
def T2_iv_a : Prop :=
  ∀ D g : ℝ, 0 < D → 0 < g →
    (∫ t in (0 : ℝ)..(D / g), g * t) = ModelC.cycleValue D g

/-- "with it and n = 0, the threshold at p = 1 is exactly the EOQ optimum D* = √(2gκA) of Theorem 3. With n it is the EOQ optimum
for the rewrite price κ(A − n);"
Added hypotheses: ModelC.Valid, g > 0, call = eta = 0; the zero prices are required
by the source proof (line 586) but omitted from its statement (line 536).
The needed English correction is recorded in the round-eight notes. The attainment clause is conditional
on n < A for a positive rewrite price and positive fluid optimum. The objective is fluid average cost
rewrite*g/d + d/2; discrete EOQ rounding is separately stated in T3. -/
def T2_iv_b : Prop :=
  ∀ (x : ModelC.Instance ℝ) (g : ℝ), ModelC.Valid x → 0 < g →
    x.call = 0 → x.eta = 0 →
    let dstar := Real.sqrt (2 * g * x.k * (x.A - x.n))
    (ModelC.law x 1 g (x.A - x.n) ↔ dstar ≤ x.D) ∧
    (∀ d : ℝ, 0 < d → dstar ≤ x.k * (x.A - x.n) * g / d + d / 2) ∧
    (x.n < x.A → x.k * (x.A - x.n) * g / dstar + dstar / 2 = dstar)

/-- "under steady growth it equals the rent already paid since the last rewrite (fluid; discretely D²/2g + D/2). This is the
break-even ledger of Theorem 4."
Added hypotheses: g > 0; s is a natural number of requests and D = g*s is substituted.
The fluid identity is T2_iv_a; this part states the discrete ledger including request s. -/
def T2_iv_c : Prop :=
  ∀ (g : ℝ) (s : ℕ), 0 < g →
    (∑ j ∈ Finset.range (s + 1), g * (j : ℝ)) =
      ModelC.cycleValue (g * s) g + (g * s) / 2

/-- "at p = 0 with c = 0 the rule fires for every D > 0, which is right by Theorem 1 whatever the true value;
at p = 1 with c = η = 0 it fires iff D ≥ D*, the fluid EOQ-optimal threshold (Theorem 3)."
Added hypotheses: ModelC.Valid, g > 0; F >= 0 is the unspecified true future saving.
The warm threshold uses A-n from the audited law, and also gives the shipped A
threshold. The n = A boundary is permitted (threshold zero). -/
def T2_v : Prop :=
  ∀ (x : ModelC.Instance ℝ) (g : ℝ), ModelC.Valid x → 0 < g →
    (x.call = 0 → ModelC.law x 0 g (x.A - x.n) ∧ ModelC.law x 0 g x.A ∧
      ∀ F : ℝ, 0 ≤ F → ModelC.fireCost x < ModelC.holdCost x 0 F) ∧
    (x.call = 0 → x.eta = 0 →
      (ModelC.law x 1 g (x.A - x.n) ↔ Real.sqrt (2 * g * x.k * (x.A - x.n)) ≤ x.D) ∧
      (ModelC.law x 1 g x.A ↔ Real.sqrt (2 * g * x.k * x.A) ≤ x.D))

/-- "Deciding with p̂ instead of p costs at most κ·(B − n)·|p̂ − p| ≤ κ·B·|p̂ − p| more than the Bayes action at that decision."
Added hypotheses: ModelC.Valid, p and p-hat in [0,1], F >= 0 as in (i).
Regret compares the estimated action's cost under the true p to the minimum true
cost; ties fire. This is the exact continuation value F, not an EOQ substitution. -/
def T2_vi : Prop :=
  ∀ (x : ModelC.Instance ℝ) (p phat F : ℝ), ModelC.Valid x →
    ModelC.probability p → ModelC.probability phat → 0 ≤ F →
    ModelC.chosenCost x p phat F - min (ModelC.fireCost x) (ModelC.holdCost x p F) ≤
      x.k * (ModelC.view x - x.n) * |phat - p| ∧
    x.k * (ModelC.view x - x.n) * |phat - p| ≤ x.k * ModelC.view x * |phat - p|

/-- "In the warm-forever fluid model (after this request the EOQ policy runs forever), the exact value is
V_ex(D) = (D*·D − D²/2)/g for D ≤ D*. This is ≥ D²/(2g), with equality only at D = D*. So the law fires later there than that
model's Bayes rule."
Added hypotheses: ModelC.Valid (in particular D > 0), g > 0,
0 < p < 1, and D <= the fluid threshold for rewrite price kappa(A-n).
This part compares candidate closed formulas; their identification with model
values is separately required by T2_vii_warm_exact and T2_vii_hazard_exact.
Inclusion of firing regions formalizes "later". D=0 is excluded by Model C, and would also give equality
if the comparison were extended to nonnegative removal.

"With an end-of-stretch hazard the exact value is smaller."
Added hypotheses: positive rewrite price B, g, hazard h, and 0 < D <= sqrt(2gB).
The optimal hazard threshold dH > 0 satisfies T6(ii)'s root equation in tokens;
the discounted value solves g*J' = h*J - pending on that continuation region.
These candidate model-H formulas specify which value "smaller" compares:
the warm-forever value, not the surrogate (which need not bound hazard values). -/
def T2_vii : Prop :=
  (∀ (x : ModelC.Instance ℝ) (p g : ℝ), ModelC.Valid x → 0 < g → 0 < p → p < 1 →
    let dstar := Real.sqrt (2 * g * x.k * (x.A - x.n))
    x.D ≤ dstar →
    ModelC.cycleValue x.D g ≤ ModelC.warmValue x.D dstar g ∧
    (ModelC.cycleValue x.D g = ModelC.warmValue x.D dstar g ↔ x.D = dstar) ∧
    (ModelC.law x p g (x.A - x.n) → ModelC.delta x p (ModelC.warmValue x.D dstar g) ≤ 0)) ∧
  (∀ B g h D dH : ℝ, 0 < B → 0 < g → 0 < h → 0 < D →
    D ≤ Real.sqrt (2 * g * B) → 0 < dH →
    g / h ^ 2 * (h * dH / g - 1 + Real.exp (-h * dH / g)) = B →
    ModelC.hazardValue D dH g h < ModelC.warmValue D (Real.sqrt (2 * g * B)) g)

/-- "In the warm-forever fluid model (after this request the EOQ policy runs forever), the exact value is
V_ex(D) = (D*·D − D²/2)/g for D ≤ D*."
Added hypotheses: positive rewrite price B and growth g, implicit in a positive
EOQ cycle. B here is kappa(A-n) from Model C. The relative value is normalized
at zero; this removes the arbitrary additive constant in the source Bellman
proof (lines 593-598). Continuity at the endpoints and differentiability in the
interior express that proof's fluid Bellman equation. They are properties of the
characterization, not antecedents assuming the desired formula or optimal rate.
The statement establishes the optimal average cost, a Bellman solution, and
uniqueness of its relative value on the entire continuation region. -/
def T2_vii_warm_exact : Prop :=
  ∀ B g : ℝ, 0 < B → 0 < g →
    let dstar := Real.sqrt (2 * g * B)
    ModelC.OptimalFluidAverage B g dstar dstar ∧
    ModelC.WarmBellman B g dstar dstar (fun D => ModelC.warmValue D dstar g) ∧
    (∀ (rate : ℝ) (V : ℝ → ℝ), ModelC.WarmBellman B g dstar rate V →
      rate = dstar ∧ ∀ D ∈ Set.Icc 0 dstar, V D - V 0 = ModelC.warmValue D dstar g)

/-- "With an end-of-stretch hazard the exact value is smaller."
Added hypotheses: positive rewrite price B, growth g and hazard h, implicit in
model H. This part supplies the missing model identification for T2_vii's
comparison: a unique positive optimal root, its minimum discounted renewal cost,
and the relative cost from pending D, derived from survival-weighted rent and a
resetting edit. The root equation is proved as a conclusion, not assumed.
D in [0,dH] is the continuation region; beyond dH an immediate edit costs B
relative to the reset state. The wait inequality includes every first waiting
time, not just stationary competitors; waiting forever has cost D/h+g/h^2.
These are the discounted Bellman alternatives used to certify optimality. -/
def T2_vii_hazard_exact : Prop :=
  ∀ B g h : ℝ, 0 < B → 0 < g → 0 < h →
    ∃ dH : ℝ, 0 < dH ∧
      g / h ^ 2 * (h * dH / g - 1 + Real.exp (-h * dH / g)) = B ∧
      (∀ d : ℝ, 0 < d →
        g / h ^ 2 * (h * d / g - 1 + Real.exp (-h * d / g)) = B → d = dH) ∧
      (∀ T : ℝ, 0 < T →
        ModelC.hazardRenewalCost B g h (dH / g) ≤ ModelC.hazardRenewalCost B g h T) ∧
      (∀ D ∈ Set.Icc 0 dH,
        ModelC.hazardStateCost B g h dH D - ModelC.hazardRenewalCost B g h (dH / g) =
          ModelC.hazardValue D dH g h) ∧
      (let J0 := ModelC.hazardRenewalCost B g h (dH / g)
       let J := fun D => if D ≤ dH then ModelC.hazardStateCost B g h dH D else B + J0
       J 0 = J0 ∧ ∀ D : ℝ, 0 ≤ D →
         J D ≤ B + J0 ∧ J D ≤ D / h + g / h ^ 2 ∧
         ∀ T : ℝ, 0 ≤ T → J D ≤ ModelC.hazardWaitCost B g h J0 D T)

/-- "Every schedule of N requests costs ≥ N·(√(2gB) − g/2) − B. So its long-run cost per request is ≥ √(2gB) − g/2. This holds for
every schedule, online or offline."
Added hypotheses: B > 0 (rewrite price), g > 0 (EOQ model), N is natural and
sigma is any Boolean schedule, including offline schedules. No terminal edit is
required; initial pending mass is zero. This finite bound implies the stated
long-run lower bound after division by N as N grows. -/
def T3_i : Prop :=
  ∀ (B g : ℝ), 0 < B → 0 < g → ∀ (N : ℕ) (sigma : ModelT.Schedule),
    (N : ℝ) * EOQ.fluidBound B g - B ≤ ModelT.cost B (EOQ.arrivals g N) sigma

/-- "The optimal long-run cost per request is c* = min_{L∈ℕ} c(L). It is attained by the periodic schedule with cycle
L* = min{L : L(L + 1) ≥ L°²}, and c* ≥ √(2gB) − g/2."
Added hypotheses: B > 0, g > 0; cycle lengths are positive naturals (L=0 has no
cycle). OptimalCycle expresses the stated minimum without a choice operator.
For all N every schedule costs >= N*c*-B, and the periodic schedule costs
<= N*c*+C for one nonnegative C independent of N. Together these bounds express
exactly the optimal long-run rate without introducing limits. -/
def T3_ii : Prop :=
  ∀ B g : ℝ, 0 < B → 0 < g → ∃ L : ℕ, EOQ.OptimalCycle B g L ∧
    (∀ j : ℕ, 0 < j → EOQ.rate B g L ≤ EOQ.rate B g j) ∧
    EOQ.fluidBound B g ≤ EOQ.rate B g L ∧
    (∀ (N : ℕ) (sigma : ModelT.Schedule),
      (N : ℝ) * EOQ.rate B g L - B ≤ ModelT.cost B (EOQ.arrivals g N) sigma) ∧
    ∃ C : ℝ, 0 ≤ C ∧ ∀ N : ℕ,
      ModelT.cost B (EOQ.arrivals g N) (ModelT.periodic L) ≤ (N : ℝ) * EOQ.rate B g L + C

/-- "Break-even (fire when the rent since the last edit reaches B) is periodic with cycle exactly L*, so it is optimal."
Added hypotheses: B > 0, g > 0 and OptimalCycle B g L, the minimum in (ii).
Equality holds at every actual request on every horizon, so it includes phase
and finite truncation. Optimality is stated by the same integer rate minimum. -/
def T3_iii : Prop :=
  ∀ (B g : ℝ) (L : ℕ), 0 < B → 0 < g → EOQ.OptimalCycle B g L →
    (∀ (N i : ℕ), i < N →
      ModelT.onlineSchedule B ModelT.bal (EOQ.arrivals g N) i = ModelT.periodic L i) ∧
    (∀ j : ℕ, 0 < j → EOQ.rate B g L ≤ EOQ.rate B g j)

/-- "The law with the true g is periodic with cycle ⌈L°⌉ ∈ {L*, L* + 1}. Its excess is c(⌈L°⌉) − (√(2gB) − g/2) < g/(2L°),
which relative to c* is < 1/(L°·(2L° − 1)) when L° > ½."
Added hypotheses: B > 0, g > 0 and OptimalCycle B g Lstar. The relative excess
is (c(law)-fluidBound)/c*, as in the English proof; it is not (c(law)-c*)/c*.
The conditional L-degree > 1/2 appears explicitly. -/
def T3_iv : Prop :=
  ∀ (B g : ℝ) (Lstar : ℕ), 0 < B → 0 < g → EOQ.OptimalCycle B g Lstar →
    let ell := EOQ.fluidLength B g
    let L := Nat.ceil ell
    (∀ (N i : ℕ), i < N →
      ModelT.onlineSchedule B (ModelT.law (ModelT.fixed g)) (EOQ.arrivals g N) i =
        ModelT.periodic L i) ∧
    (L = Lstar ∨ L = Lstar + 1) ∧
    EOQ.rate B g L - EOQ.fluidBound B g < g / (2 * ell) ∧
    (1 / 2 < ell → (EOQ.rate B g L - EOQ.fluidBound B g) / EOQ.rate B g Lstar <
      1 / (ell * (2 * ell - 1)))

/-- "BAL ≤ 2·OPT on every instance, and BAL < 2·OPT if BAL edits at least once."
Added hypotheses: B > 0; finite arrivals are nonnegative, as in Model T.
OPT is expressed as comparison with every schedule on the same arrivals; strictness
also compares with every schedule. Empty and all-zero instances are allowed. -/
def T4_i : Prop :=
  ∀ (B : ℝ) (a : List ℝ), 0 < B → ModelT.arrivalsValid a →
    ∀ sigma : ModelT.Schedule,
      ModelT.algCost B a ModelT.bal ≤ 2 * ModelT.cost B a sigma ∧
      (ModelT.edits B a ModelT.bal → ModelT.algCost B a ModelT.bal < 2 * ModelT.cost B a sigma)

/-- "For every deterministic online algorithm ALG and every ε > 0, some instance has ALG ≥ (2 − ε)·OPT. So BAL is optimal among
deterministic online algorithms."
Added hypotheses: B > 0 and epsilon > 0. ALG is a function of B and the observed
arrival prefix, so it cannot see the stopping horizon. The witness instance has
strictly positive optimum; this excludes a vacuous all-zero lower-bound witness.
Optimal identifies an actual hindsight-minimizing comparator schedule. -/
def T4_ii : Prop :=
  ∀ (ALG : ModelT.Online ℝ) (B eps : ℝ), 0 < B → 0 < eps →
    ∃ (a : List ℝ) (sigma : ModelT.Schedule), ModelT.arrivalsValid a ∧
      ModelT.Optimal B a sigma ∧ 0 < ModelT.cost B a sigma ∧
      (2 - eps) * ModelT.cost B a sigma ≤ ModelT.algCost B a ALG

/-- "If its estimate at a stretch's first request is bounded by Ĝ, then for every c there is an instance with LAW > c·OPT. The
instance includes the rewrite price B: the ratio grows like √(B/Ĝ)."
Added hypotheses: Ghat > 0, estimates nonnegative on positive-price nonnegative
prefixes, and a uniform first-request bound for every B and arrival. The growth
estimate is online. c > 0 suffices for unbounded ratios. The instance is one
positive burst with D < B, so the hold schedule is a positive hindsight optimum.
The quantitative clause uses B > 0 and sqrt(2*Ghat*B)+1 < B, precisely the
source proof's condition for that optimum (line 727). It exhibits a burst of
size at most sqrt(2*Ghat*B)+1, exact costs LAW=B and OPT=D, and the stated
ratio lower bound. For arbitrary bounded estimates this is a lower growth
bound; the source's "grows like" needs "grows at least on the order of".

"If its estimate stays ≥ G′ > 0 whatever the removable arrivals are, as the product's context-growth estimate does, LAW can
also never fire while the rent grows without bound."
Added hypotheses: B > 0 and G' > 0; the estimate bound holds on every nonempty
nonnegative prefix at that B. A positive burst D below the threshold witnesses
no edits on every finite horizon and arbitrarily large ratios to hindsight OPT. -/
def T4_iv : Prop :=
  (∀ (estimate : ModelT.Estimate ℝ) (Ghat : ℝ), 0 < Ghat →
    (∀ B : ℝ, 0 < B → ∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) →
    (∀ B D : ℝ, 0 < B → 0 ≤ D → estimate B [D] ≤ Ghat) →
    (∀ B : ℝ, 0 < B → Real.sqrt (2 * Ghat * B) + 1 < B →
      ∃ D : ℝ, 0 < D ∧ D ≤ Real.sqrt (2 * Ghat * B) + 1 ∧ D < B ∧
        ModelT.Optimal B [D] (fun _ => false) ∧
        ModelT.cost B [D] (fun _ => false) = D ∧
        ModelT.algCost B [D] (ModelT.law estimate) = B ∧
        B / (Real.sqrt (2 * Ghat * B) + 1) ≤
          ModelT.algCost B [D] (ModelT.law estimate) /
            ModelT.cost B [D] (fun _ => false)) ∧
    (∀ c : ℝ, 0 < c → ∃ B D : ℝ, 0 < B ∧ 0 < D ∧ D < B ∧
      ModelT.Optimal B [D] (fun _ => false) ∧
      c * ModelT.cost B [D] (fun _ => false) < ModelT.algCost B [D] (ModelT.law estimate))) ∧
  (∀ (estimate : ModelT.Estimate ℝ) (B G' : ℝ), 0 < B → 0 < G' →
    (∀ a : List ℝ, a ≠ [] → ModelT.arrivalsValid a → G' ≤ estimate B a) →
    ∃ D : ℝ, 0 < D ∧ D ^ 2 < 2 * G' * B ∧
      (∀ m : ℕ, ¬ ModelT.edits B (ModelT.burst D m) (ModelT.law estimate)) ∧
      (∀ c : ℝ, 0 < c → ∃ (m : ℕ) (sigma : ModelT.Schedule),
        ModelT.Optimal B (ModelT.burst D m) sigma ∧ 0 < ModelT.cost B (ModelT.burst D m) sigma ∧
        c * ModelT.cost B (ModelT.burst D m) sigma <
          ModelT.algCost B (ModelT.burst D m) (ModelT.law estimate)))

/-- "G_α ≤ (1 + 1/α)·OPT on every instance, whatever Π is, and strictly below if G_α edits at least once. This is an upper
bound for every growth estimate."
Added hypotheses: B > 0, 0 < alpha <= 1, nonnegative finite arrivals. Pi is any
deterministic online Boolean predicate of the observed prefix and reconstructed
pending mass/rent. The bound is against every comparator schedule on this instance. -/
def T5_i : Prop :=
  ∀ (B alpha : ℝ) (pred : ModelT.Predicate ℝ) (a : List ℝ),
    0 < B → 0 < alpha → alpha ≤ 1 → ModelT.arrivalsValid a →
    ∀ sigma : ModelT.Schedule,
      ModelT.algCost B a (ModelT.guarded alpha pred) ≤ (1 + 1 / alpha) * ModelT.cost B a sigma ∧
      (ModelT.edits B a (ModelT.guarded alpha pred) →
        ModelT.algCost B a (ModelT.guarded alpha pred) < (1 + 1 / alpha) * ModelT.cost B a sigma)

/-- "For Π = LAW with a fixed estimate G, as B/G → ∞, or with the EWMA estimate, and every ε > 0, some instance
has G_α ≥ (1 + 1/α − ε)·OPT. So for these estimates the competitive ratio of the guarded law is exactly 1 + 1/α."
"It is not exact for every predicate. Π ≡ false gives G_α = BAL, with ratio < 2 (Theorem 4(i))."
"The bound is approached only where the early clause binds. LAW holds at s only if P_s ≥ √(2ĝB), and R_s ≥ P_s, so the clause
"R_s < α·B while LAW holds" needs √(2ĝB) < α·B, i.e. B > 2ĝ/α²."
"The same bound holds with Beff in place of B at p < 1 (section 1.4's guard): the law holds only if D ≥ √(2ĝ·Beff), and R ≥ D."
Added hypotheses: 0 < alpha <= 1, G > 0, epsilon > 0 and an arbitrary M > 0.
The witness has B > M*G, expressing arbitrarily large B/G, a positive burst and a
positive hindsight optimum. This is the fixed-estimate claim, not an arbitrary
predicate claim; the latter has only T5_i's upper bound.

Added hypotheses: 0 < alpha <= 1, initial EWMA g0 >= 0, epsilon > 0, M > 0.
The proof's EWMA uses removable arrivals and update weight 0.1; on a unit burst it
is 0.9^(s-1)*(0.9*g0+0.1). This is the EWMA in T5's proof, not a claim about the
product's capped context-growth estimator. A positive optimum excludes vacuity.

Added hypotheses: B > 0, G >= 0, P >= 0, 0 < alpha <= 1, R >= P, and LAW holds.
B denotes either the fixed rewrite price or a positive effective price; this is
only the local necessary condition, not a competitive theorem with varying Beff.
The false-predicate clause uses B > 0, 0 < alpha <= 1 and nonnegative arrivals.
The English's "ratio < 2" is strict when BAL edits, as its cited T4(i) requires;
empty or all-zero instances cannot have a defined positive ratio. -/
def T5_ii : Prop :=
  (∀ alpha G eps M : ℝ, 0 < alpha → alpha ≤ 1 → 0 < G → 0 < eps → 0 < M →
    ∃ (B D : ℝ) (m : ℕ) (sigma : ModelT.Schedule), 0 < B ∧ M * G < B ∧ 0 < D ∧
      ModelT.Optimal B (ModelT.burst D m) sigma ∧ 0 < ModelT.cost B (ModelT.burst D m) sigma ∧
      (1 + 1 / alpha - eps) * ModelT.cost B (ModelT.burst D m) sigma ≤
        ModelT.algCost B (ModelT.burst D m)
          (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.fixed G)))) ∧
  (∀ alpha g0 eps M : ℝ, 0 < alpha → alpha ≤ 1 → 0 ≤ g0 → 0 < eps → 0 < M →
    ∃ (B : ℝ) (m : ℕ) (sigma : ModelT.Schedule), 0 < B ∧ M < B ∧
      ModelT.Optimal B (ModelT.burst 1 m) sigma ∧ 0 < ModelT.cost B (ModelT.burst 1 m) sigma ∧
      (1 + 1 / alpha - eps) * ModelT.cost B (ModelT.burst 1 m) sigma ≤
        ModelT.algCost B (ModelT.burst 1 m)
          (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.ewma g0)))) ∧
  (∀ B G P R alpha : ℝ, 0 < B → 0 ≤ G → 0 ≤ P → 0 < alpha → alpha ≤ 1 →
    P ≤ R → P ^ 2 ≥ 2 * G * B → R < alpha * B → 2 * G / alpha ^ 2 < B) ∧
  (∀ (B alpha : ℝ) (a : List ℝ), 0 < B → 0 < alpha → alpha ≤ 1 →
    ModelT.arrivalsValid a →
    (∀ i : ℕ, i < a.length →
      ModelT.onlineSchedule B (ModelT.guarded alpha (fun _ _ _ _ => false)) a i =
        ModelT.onlineSchedule B ModelT.bal a i) ∧
    (∀ sigma : ModelT.Schedule,
      ModelT.algCost B a (ModelT.guarded alpha (fun _ _ _ _ => false)) ≤ 2 * ModelT.cost B a sigma ∧
      (ModelT.edits B a ModelT.bal →
        ModelT.algCost B a (ModelT.guarded alpha (fun _ _ _ _ => false)) < 2 * ModelT.cost B a sigma)))

/-- "Steady growth (a_s = g, Π = LAW with any constant ĝ ≥ g, for instance the true g, or the context's growth, which includes
the removable tokens): G_α = BAL for every α ∈ [0, 1]. It is periodic with the integer-optimal cycle L* of Theorem 3, which is
better than LAW's ⌈L°⌉."
Added hypotheses: B > 0, g > 0, G >= g and 0 <= alpha <= 1. Each request adds g
removable tokens; no assumptions about unrelated context growth are needed.
The witness cycle and equality hold on every finite horizon at every request. -/
def T5_iv : Prop :=
  ∀ B g G alpha : ℝ, 0 < B → 0 < g → g ≤ G → 0 ≤ alpha → alpha ≤ 1 →
    ∃ L : ℕ, EOQ.OptimalCycle B g L ∧
      (∀ j : ℕ, 0 < j → EOQ.rate B g L ≤ EOQ.rate B g j) ∧
      ∀ (N i : ℕ), i < N →
        ModelT.onlineSchedule B
          (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.fixed G))) (EOQ.arrivals g N) i =
          ModelT.onlineSchedule B ModelT.bal (EOQ.arrivals g N) i ∧
        ModelT.onlineSchedule B ModelT.bal (EOQ.arrivals g N) i = ModelT.periodic L i

/-- "After a rewrite, take a burst D on which LAW fires at once (cost B for that cycle), followed by a long stretch.
G_α's cycle costs < (1 + α)·B."
Added hypotheses: B > 0, D > 0, 0 < alpha <= 1, a nonnegative online estimate,
and D^2 >= 2*estimate(B,[D])*B, expressing immediate LAW firing.
"A long stretch" means m*D >= B, which ensures BAL forces an edit even if the
estimate changes. The first guarded edit k defines the cycle whose cost is bounded.
No hypothesis that LAW remains true is added: the English does not state one.
Screening finds this version false; the proof assumes LAW holds after the burst.
A fixed estimate (or LAW persisting until the edit) makes the bound true. -/
def T5_v : Prop :=
  ∀ (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ) (m : ℕ),
    0 < B → 0 < D → 0 < alpha → alpha ≤ 1 →
    (∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) →
    D ^ 2 ≥ 2 * estimate B [D] * B → B ≤ (m : ℝ) * D →
    let a := ModelT.burst D m
    let rule := ModelT.guarded alpha (ModelT.lawPredicate estimate)
    ∃ k : ℕ, k < a.length ∧ ModelT.onlineSchedule B rule a k = true ∧
      (∀ j : ℕ, j < k → ModelT.onlineSchedule B rule a j = false) ∧
      ModelT.algCost B (a.take (k + 1)) rule < (1 + alpha) * B

/-- "After a rewrite, take a burst D on which LAW fires at once (cost B for that cycle), followed by a long stretch.
G_α's cycle costs < (1 + α)·B."
Corrected version of T5_v: LAW must remain true until the first guarded edit.
Added hypotheses: the same positive B, D, alpha in (0,1], nonnegative online
estimate, immediate LAW firing and long horizon as T5_v. The extra persistence
hypothesis repairs the unsupported step "P_s = D after the burst, and LAW holds"
in the source proof (line 819). It is imposed only before the first edit,
including its decision request; it makes no restriction on later cycles.
Fixed estimates and non-increasing burst estimates satisfy this qualification.
The unqualified source statement is retained as T5_v for refutation. -/
def T5_v_persistent : Prop :=
  ∀ (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ) (m : ℕ),
    0 < B → 0 < D → 0 < alpha → alpha ≤ 1 →
    (∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) →
    D ^ 2 ≥ 2 * estimate B [D] * B → B ≤ (m : ℝ) * D →
    let a := ModelT.burst D m
    let rule := ModelT.guarded alpha (ModelT.lawPredicate estimate)
    (∀ j : ℕ, j < a.length →
      (∀ i : ℕ, i < j → ModelT.onlineSchedule B rule a i = false) →
      D ^ 2 ≥ 2 * estimate B (a.take (j + 1)) * B) →
    ∃ k : ℕ, k < a.length ∧ ModelT.onlineSchedule B rule a k = true ∧
      (∀ j : ℕ, j < k → ModelT.onlineSchedule B rule a j = false) ∧
      ModelT.algCost B (a.take (k + 1)) rule < (1 + alpha) * B

end PiZip
