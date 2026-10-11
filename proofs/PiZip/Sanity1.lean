import PiZip.Statements.R1

namespace PiZip

/- Exact rational check rows from T3: discrete cycle lengths and costs. -/
#guard EOQ.rate (1000 : ℚ) 3 26 = 1975 / 26
#guard EOQ.rate (4600 : ℚ) 24 20 = 458
#guard EOQ.rate (7600 : ℚ) 24 25 = 592
#guard EOQ.rate (7600 : ℚ) 24 26 = 7700 / 13
#guard EOQ.rate (50 : ℚ) 1 10 = 19 / 2

#guard (ModelT.decisions (1000 : ℚ)
  (fun B _ P R => decide (0 < P ∧ B ≤ R)) (EOQ.arrivals 3 26) [] ModelT.initial).getLast? = some true
#guard ModelT.algCost (4600 : ℚ) (EOQ.arrivals 24 20) ModelT.bal = 9160
#guard ModelT.algCost (7600 : ℚ) (EOQ.arrivals 24 25) ModelT.bal = 14800
#guard ModelT.algCost (7600 : ℚ) (EOQ.arrivals 24 26) (ModelT.law (ModelT.fixed 24)) = 15400
#guard ModelT.algCost (50 : ℚ) (EOQ.arrivals 1 10) ModelT.bal = 95

/- A hand-computable model-T instance: rent 2, then edit, then rent 1. -/
#guard ModelT.cost (5 : ℚ) [2, 3, 1] (fun i => decide (i = 1)) = 8
#guard ModelT.algCost (5 : ℚ) [2, 3, 1] ModelT.bal = 8
#guard ModelT.algCost (5 : ℚ) [2, 3, 1]
  (ModelT.guarded (1 / 2) (fun _ _ _ _ => false)) = 8
#guard ModelT.algCost (5 : ℚ) [2, 3, 1]
  (ModelT.guarded (1 / 2) (fun _ _ _ _ => true)) = 8
#guard ModelT.ewma (2500 : ℚ) 10 [1, 0] = 202509 / 100

/-- T5(v) fails for an online estimate that stops satisfying LAW after request 1. -/
def changingEstimate [Field K] : ModelT.Estimate K :=
  fun _ history => if history.length ≤ 1 then 1 / 100 else 100

#guard ModelT.law (changingEstimate (K := ℚ)) 10 [1] = true
#guard ModelT.onlineSchedule (10 : ℚ)
  (ModelT.guarded (1 / 2) (ModelT.lawPredicate changingEstimate)) (ModelT.burst 1 10) 9 = true
#guard ModelT.algCost (10 : ℚ) (ModelT.burst 1 9)
  (ModelT.guarded (1 / 2) (ModelT.lawPredicate changingEstimate)) = 19
#guard (19 : ℚ) > (1 + 1 / 2) * 10

/- T2's audited new-token example and the shipped conservative threshold. -/
def cTable (n : ℚ) : ModelC.Instance ℚ := ⟨40000, 23500, n, 23 / 2, 0, 0⟩

#guard (5275 / 10000 : ℚ) < ModelC.threshold (cTable 0) (ModelC.cycleValue 23500 2400)
#guard ModelC.threshold (cTable 0) (ModelC.cycleValue 23500 2400) < (5285 / 10000 : ℚ)
#guard (5475 / 10000 : ℚ) < ModelC.threshold (cTable 2400) (ModelC.cycleValue 23500 2400)
#guard ModelC.threshold (cTable 2400) (ModelC.cycleValue 23500 2400) < (5485 / 10000 : ℚ)
#guard (46989 : ℚ)^2 < 2 * 2400 * (23 / 2) * 40000
#guard 2 * 2400 * (23 / 2) * 40000 < (46990 : ℚ)^2
#guard (455575 / 10 : ℚ)^2 < 2 * 2400 * (23 / 2) * (40000 - 2400)
#guard 2 * 2400 * (23 / 2) * (40000 - 2400) < (455585 / 10 : ℚ)^2

/- Minimal discrete and fluid cycle lengths from all four T3 rows. -/
def tableCycle (B g : ℚ) (L : ℕ) (fluid : Bool) : Bool :=
  let threshold := fun j : ℕ =>
    if fluid then g * (j : ℚ)^2 else g * (j : ℚ) * ((j : ℚ) + 1)
  decide (0 < L ∧ 2 * B ≤ threshold L) &&
    (List.range L).all (fun j => decide (j = 0 ∨ threshold j < 2 * B))

#guard tableCycle 1000 3 26 false && tableCycle 1000 3 26 true
#guard tableCycle 4600 24 20 false && tableCycle 4600 24 20 true
#guard tableCycle 7600 24 25 false && tableCycle 7600 24 26 true
#guard tableCycle 50 1 10 false && tableCycle 50 1 10 true

#guard ModelT.decisions (10 : ℚ)
  (fun B history P R => decide (0 < P ∧
    (B ≤ R ∨ (P^2 ≥ 2 * changingEstimate B history * B ∧ (1 / 2) * B ≤ R))))
  (ModelT.burst 1 9) [] ModelT.initial = List.replicate 9 false ++ [true]

/-- A concrete legal one-decision state, with positive post-edit cached prefix. -/
def cWitness : ModelC.Instance ℝ := ⟨2, 1, 1, 1, 0, 0⟩

theorem cWitness_valid : ModelC.Valid cWitness := by
  norm_num [ModelC.Valid, cWitness, ModelC.view]

/-- A concrete integer-optimal EOQ cycle; growth 2 and rewrite price 1. -/
theorem eoqWitness : EOQ.OptimalCycle (1 : ℝ) 2 1 := by
  refine ⟨by decide, by norm_num, ?_⟩
  intro j hj hlt
  omega

/-- Each named witness realizes all antecedents, rather than proving the implication. -/
theorem T2_i_nonvacuous : ∃ (x : ModelC.Instance ℝ) (p F : ℝ),
    ModelC.Valid x ∧ ModelC.probability p ∧ 0 ≤ F := by
  exact ⟨cWitness, 1 / 2, 0, cWitness_valid, by norm_num [ModelC.probability], le_rfl⟩

theorem T2_ii_nonvacuous : ∃ (x : ModelC.Instance ℝ) (p F : ℝ),
    ModelC.Valid x ∧ 0 ≤ F ∧ ModelC.probability p := by
  exact ⟨cWitness, 1 / 2, 0, cWitness_valid, le_rfl, by norm_num [ModelC.probability]⟩

theorem T2_iii_nonvacuous : ∃ (x : ModelC.Instance ℝ) (p g : ℝ),
    ModelC.Valid x ∧ ModelC.probability p ∧ 0 < g ∧ x.n = 0 := by
  refine ⟨⟨2, 1, 0, 1, 0, 0⟩, 1 / 2, 1, ?_⟩
  norm_num [ModelC.Valid, ModelC.view, ModelC.probability]

theorem T2_iv_a_nonvacuous : ∃ D g : ℝ, 0 < D ∧ 0 < g := by
  exact ⟨1, 1, by norm_num⟩

theorem T2_iv_b_nonvacuous : ∃ (x : ModelC.Instance ℝ) (g : ℝ),
    ModelC.Valid x ∧ 0 < g ∧ x.n < x.A ∧ x.call = 0 ∧ x.eta = 0 := by
  exact ⟨cWitness, 1, cWitness_valid, by norm_num [cWitness]⟩

theorem T2_iv_c_nonvacuous : ∃ (g : ℝ) (s : ℕ), 0 < g ∧ 0 < s := by
  exact ⟨1, 1, by norm_num⟩

theorem T2_v_nonvacuous : ∃ (x : ModelC.Instance ℝ) (g F : ℝ),
    ModelC.Valid x ∧ 0 < g ∧ x.call = 0 ∧ x.eta = 0 ∧ 0 ≤ F := by
  exact ⟨cWitness, 1, 0, cWitness_valid, by norm_num [cWitness]⟩

theorem T2_vi_nonvacuous : ∃ (x : ModelC.Instance ℝ) (p phat F : ℝ),
    ModelC.Valid x ∧ ModelC.probability p ∧ ModelC.probability phat ∧ 0 ≤ F := by
  exact ⟨cWitness, 1 / 2, 1 / 4, 0, cWitness_valid, by norm_num [ModelC.probability]⟩

theorem T2_vii_nonvacuous :
    (∃ (x : ModelC.Instance ℝ) (p g : ℝ), ModelC.Valid x ∧ 0 < g ∧ 0 < p ∧ p < 1 ∧
      x.D ≤ Real.sqrt (2 * g * x.k * (x.A - x.n))) ∧
    (∃ B g h D dH : ℝ, 0 < B ∧ 0 < g ∧ 0 < h ∧ 0 < D ∧
      D ≤ Real.sqrt (2 * g * B) ∧ 0 < dH ∧
      g / h ^ 2 * (h * dH / g - 1 + Real.exp (-h * dH / g)) = B) := by
  constructor
  · refine ⟨cWitness, 1 / 2, 1 / 2, cWitness_valid, ?_⟩
    norm_num [cWitness]
  · refine ⟨1 + Real.exp (-2), 1, 1, 1, 2, ?_, by norm_num, by norm_num,
      by norm_num, ?_, by norm_num, ?_⟩
    · positivity
    · apply (Real.le_sqrt (by norm_num) (by positivity)).2
      have he := Real.exp_pos (-2)
      nlinarith
    · norm_num

theorem T3_i_nonvacuous : ∃ (B g : ℝ) (N : ℕ), 0 < B ∧ 0 < g ∧ 0 < N := by
  exact ⟨1, 2, 1, by norm_num⟩

theorem T3_ii_nonvacuous : ∃ B g : ℝ, 0 < B ∧ 0 < g := by
  exact ⟨1, 2, by norm_num⟩

theorem T3_iii_nonvacuous : ∃ (B g : ℝ) (L : ℕ),
    0 < B ∧ 0 < g ∧ EOQ.OptimalCycle B g L := by
  exact ⟨1, 2, 1, by norm_num, by norm_num, eoqWitness⟩

theorem T3_iv_nonvacuous : ∃ (B g : ℝ) (Lstar : ℕ),
    0 < B ∧ 0 < g ∧ EOQ.OptimalCycle B g Lstar ∧ 1 / 2 < EOQ.fluidLength B g := by
  exact ⟨1, 2, 1, by norm_num, by norm_num, eoqWitness, by norm_num [EOQ.fluidLength]⟩

theorem T4_i_nonvacuous : ∃ (B : ℝ) (a : List ℝ),
    0 < B ∧ ModelT.arrivalsValid a ∧ ModelT.edits B a ModelT.bal := by
  refine ⟨1, [2], by norm_num, ?_, ?_⟩
  · simp [ModelT.arrivalsValid]
  · refine ⟨0, by simp, ?_⟩
    norm_num [ModelT.onlineSchedule, ModelT.bal, ModelT.controller, ModelT.decisions,
      ModelT.initial]

theorem T4_ii_nonvacuous : ∃ (_ALG : ModelT.Online ℝ) (B eps : ℝ), 0 < B ∧ 0 < eps := by
  exact ⟨ModelT.bal, 1, 1 / 10, by norm_num⟩

theorem T4_iv_nonvacuous :
    (∃ (estimate : ModelT.Estimate ℝ) (Ghat B : ℝ), 0 < Ghat ∧
      (∀ B : ℝ, 0 < B → ∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) ∧
      (∀ B D : ℝ, 0 < B → 0 ≤ D → estimate B [D] ≤ Ghat) ∧
      0 < B ∧ Real.sqrt (2 * Ghat * B) + 1 < B) ∧
    (∃ (estimate : ModelT.Estimate ℝ) (B G' : ℝ), 0 < B ∧ 0 < G' ∧
      ∀ a : List ℝ, a ≠ [] → ModelT.arrivalsValid a → G' ≤ estimate B a) := by
  constructor
  · exact ⟨ModelT.fixed 1, 1, 8, by norm_num, by intros; norm_num [ModelT.fixed],
      by intros; simp [ModelT.fixed], by norm_num, by norm_num⟩
  · exact ⟨ModelT.fixed 1, 1, 1, by norm_num, by norm_num, by intros; simp [ModelT.fixed]⟩

theorem T5_i_nonvacuous : ∃ (B alpha : ℝ) (pred : ModelT.Predicate ℝ) (a : List ℝ),
    0 < B ∧ 0 < alpha ∧ alpha ≤ 1 ∧ ModelT.arrivalsValid a ∧
      ModelT.edits B a (ModelT.guarded alpha pred) := by
  refine ⟨1, 1 / 2, (fun _ _ _ _ => true), [2], by norm_num, by norm_num,
    by norm_num, ?_, ?_⟩
  · simp [ModelT.arrivalsValid]
  · refine ⟨0, by simp, ?_⟩
    norm_num [ModelT.onlineSchedule, ModelT.guarded, ModelT.controller, ModelT.decisions,
      ModelT.initial]

theorem T5_ii_nonvacuous :
    (∃ alpha G eps M : ℝ, 0 < alpha ∧ alpha ≤ 1 ∧ 0 < G ∧ 0 < eps ∧ 0 < M) ∧
    (∃ alpha g0 eps M : ℝ, 0 < alpha ∧ alpha ≤ 1 ∧ 0 ≤ g0 ∧ 0 < eps ∧ 0 < M) ∧
    (∃ B G P R alpha : ℝ, 0 < B ∧ 0 ≤ G ∧ 0 ≤ P ∧ 0 < alpha ∧ alpha ≤ 1 ∧
      P ≤ R ∧ P ^ 2 ≥ 2 * G * B ∧ R < alpha * B) ∧
    (∃ (B alpha : ℝ) (a : List ℝ), 0 < B ∧ 0 < alpha ∧ alpha ≤ 1 ∧
      ModelT.arrivalsValid a) := by
  exact ⟨⟨1 / 2, 1, 1 / 10, 1, by norm_num⟩,
    ⟨1 / 2, 2500, 1 / 10, 1, by norm_num⟩,
    ⟨100, 1, 15, 15, 1 / 2, by norm_num⟩,
    ⟨1, 1 / 2, [2], by norm_num, by norm_num, by norm_num, by simp [ModelT.arrivalsValid]⟩⟩

theorem T5_iv_nonvacuous : ∃ B g G alpha : ℝ,
    0 < B ∧ 0 < g ∧ g ≤ G ∧ 0 ≤ alpha ∧ alpha ≤ 1 := by
  exact ⟨1, 2, 2, 1 / 2, by norm_num⟩

theorem T5_v_nonvacuous : ∃ (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ) (m : ℕ),
    0 < B ∧ 0 < D ∧ 0 < alpha ∧ alpha ≤ 1 ∧
    (∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) ∧
    D ^ 2 ≥ 2 * estimate B [D] * B ∧ B ≤ (m : ℝ) * D := by
  refine ⟨10, 1, 1 / 2, changingEstimate, 10, by norm_num, by norm_num,
    by norm_num, by norm_num, ?_, ?_, by norm_num⟩
  · intro a _
    dsimp [changingEstimate]
    split <;> norm_num
  · norm_num [changingEstimate]

/- The zero-price qualification in T2(iv)(b) is necessary in both directions.
Automatic cache premium kappa=4, A=1, n=0, g=2 gives Dstar=4. -/
theorem law_positive_call_counterexample :
    let x : ModelC.Instance ℝ := ⟨1, 4, 0, 4, 1, 0⟩
    ModelC.Valid x ∧ Real.sqrt (2 * 2 * x.k * (x.A - x.n)) = x.D ∧
      ¬ ModelC.law x 1 2 (x.A - x.n) := by
  norm_num [ModelC.Valid, ModelC.view, ModelC.law, ModelC.cycleValue]
theorem law_positive_room_counterexample :
    let x : ModelC.Instance ℝ := ⟨1, 2, 0, 4, 0, 2⟩
    ModelC.Valid x ∧ x.D < Real.sqrt (2 * 2 * x.k * (x.A - x.n)) ∧
      ModelC.law x 1 2 (x.A - x.n) := by
  norm_num [ModelC.Valid, ModelC.view, ModelC.law, ModelC.cycleValue]
#guard (2 : ℚ) ^ 2 < 2 * 2 * 4 * 1

/-- The added exact-value statements have positive model parameters. -/
theorem T2_vii_warm_exact_nonvacuous : ∃ B g : ℝ, 0 < B ∧ 0 < g := by
  exact ⟨1, 1, by norm_num⟩

theorem T2_vii_hazard_exact_nonvacuous : ∃ B g h : ℝ, 0 < B ∧ 0 < g ∧ 0 < h := by
  exact ⟨1, 1, 1, by norm_num⟩

/-- A fixed zero estimate satisfies LAW throughout the first burst cycle. -/
theorem T5_v_persistent_nonvacuous :
    ∃ (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ) (m : ℕ),
      0 < B ∧ 0 < D ∧ 0 < alpha ∧ alpha ≤ 1 ∧
      (∀ a : List ℝ, ModelT.arrivalsValid a → 0 ≤ estimate B a) ∧
      D ^ 2 ≥ 2 * estimate B [D] * B ∧ B ≤ (m : ℝ) * D ∧
      (∀ j : ℕ, j < (ModelT.burst D m).length →
        (∀ i : ℕ, i < j → ModelT.onlineSchedule B
          (ModelT.guarded alpha (ModelT.lawPredicate estimate)) (ModelT.burst D m) i = false) →
        D ^ 2 ≥ 2 * estimate B ((ModelT.burst D m).take (j + 1)) * B) := by
  refine ⟨1, 1, 1 / 2, ModelT.fixed 0, 1, by norm_num, by norm_num,
    by norm_num, by norm_num, ?_, ?_, by norm_num, ?_⟩
  · intro a _
    norm_num [ModelT.fixed]
  · norm_num [ModelT.fixed]
  · intro j _ _
    norm_num [ModelT.fixed]

/-- The quantitative price condition and both exact costs hold simultaneously. -/
theorem law_early_quantitative_witness :
    Real.sqrt (2 * (1 : ℝ) * 8) + 1 = 5 ∧
    (0 : ℝ) < 5 ∧ (5 : ℝ) < 8 ∧
    ModelT.Optimal (8 : ℝ) [5] (fun _ => false) ∧
    ModelT.cost (8 : ℝ) [5] (fun _ => false) = 5 ∧
    ModelT.algCost (8 : ℝ) [5] (ModelT.law (ModelT.fixed 1)) = 8 ∧
    ModelT.algCost (8 : ℝ) [5] (ModelT.law (ModelT.fixed 1)) /
      ModelT.cost (8 : ℝ) [5] (fun _ => false) = 8 / 5 := by
  have hopt : ModelT.Optimal (8 : ℝ) [5] (fun _ => false) := by
    intro sigma
    simp only [ModelT.cost, ModelT.run, List.zipIdx, List.foldl_cons,
      List.foldl_nil, ModelT.initial, ModelT.step]
    cases sigma 0 <;> norm_num
  norm_num [hopt, ModelT.algCost, ModelT.cost, ModelT.run, List.zipIdx,
    ModelT.onlineSchedule, ModelT.law, ModelT.fixed, ModelT.controller,
    ModelT.decisions, ModelT.initial, ModelT.step]

/-- A uniform upper estimate bound does not give the source's ratio upper bound. -/
theorem law_bounded_estimate_no_ratio_upper :
    (∀ B : ℝ, ∀ a : List ℝ, ModelT.fixed 0 B a ≤ (1 : ℝ)) ∧
    ModelT.Optimal (100 : ℝ) [1] (fun _ => false) ∧
    ModelT.algCost (100 : ℝ) [1] (ModelT.law (ModelT.fixed 0)) /
      ModelT.cost (100 : ℝ) [1] (fun _ => false) = 100 ∧
    Real.sqrt ((100 : ℝ) / (2 * 1)) < 100 := by
  have hopt : ModelT.Optimal (100 : ℝ) [1] (fun _ => false) := by
    intro sigma
    simp only [ModelT.cost, ModelT.run, List.zipIdx, List.foldl_cons,
      List.foldl_nil, ModelT.initial, ModelT.step]
    cases sigma 0 <;> norm_num
  have hsquare : (Real.sqrt (50 : ℝ)) ^ 2 = 50 := Real.sq_sqrt (by norm_num)
  have hsqrt : Real.sqrt (50 : ℝ) < 100 := by nlinarith
  norm_num [ModelT.fixed, hopt, ModelT.algCost, ModelT.cost, ModelT.run,
    List.zipIdx, ModelT.onlineSchedule, ModelT.law, ModelT.controller,
    ModelT.decisions, ModelT.initial, ModelT.step, hsqrt]

end PiZip
