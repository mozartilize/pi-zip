import PiZip.Statements.R1

namespace PiZip

namespace T2

/-- Collect the alive, dead, room and future cost terms. -/
theorem cost_difference (x : ModelC.Instance ℝ) (p F : ℝ) :
    ModelC.fireCost x - ModelC.holdCost x p F = ModelC.delta x p (x.D + F) := by
  unfold ModelC.fireCost ModelC.holdCost ModelC.delta ModelC.view
  ring

/-- The new tokens are excluded from the rewritten cached prefix. -/
theorem positive_slope (x : ModelC.Instance ℝ) (hx : ModelC.Valid x) :
    0 < x.k * (ModelC.view x - x.n) :=
  mul_pos hx.2.2.2.2.2.1 (sub_pos.mpr hx.2.2.2.2.1)

theorem affine_difference (x : ModelC.Instance ℝ) (p q V : ℝ) :
    ModelC.delta x p V - ModelC.delta x q V =
      x.k * (ModelC.view x - x.n) * (p - q) := by
  unfold ModelC.delta ModelC.view
  ring

/-- Solve the positive-slope affine inequality without clipping the threshold. -/
theorem delta_threshold (x : ModelC.Instance ℝ) (V p : ℝ) (hx : ModelC.Valid x) :
    ModelC.delta x p V ≤ 0 ↔ p ≤ ModelC.threshold x V := by
  rw [ModelC.threshold, le_div_iff₀ (positive_slope x hx)]
  unfold ModelC.delta ModelC.view
  constructor <;> intro h <;> nlinarith

theorem threshold_zero (x : ModelC.Instance ℝ) (V : ℝ) (hx : ModelC.Valid x) :
    ModelC.delta x (ModelC.threshold x V) V = 0 := by
  have hs := ne_of_gt (positive_slope x hx)
  have form (p : ℝ) : ModelC.delta x p V =
      x.k * (ModelC.view x - x.n) * p - (V + (x.eta + x.k) * x.D - x.call) := by
    unfold ModelC.delta ModelC.view
    ring
  rw [form, ModelC.threshold, mul_div_cancel₀ _ hs, sub_self]

/-- The cycle surrogate is substituted only into the decision inequality. -/
theorem delta_law (x : ModelC.Instance ℝ) (p g : ℝ) :
    ModelC.delta x p (ModelC.cycleValue x.D g) ≤ 0 ↔
      ModelC.law x p g (x.A - x.n) := by
  unfold ModelC.delta ModelC.law
  constructor <;> intro h <;> linarith

/-- The rent integral for arbitrary endpoints also covers a zero-length cycle. -/
theorem rent_integral (g t : ℝ) :
    (∫ s in (0 : ℝ)..t, g * s) = g * t ^ 2 / 2 := by
  rw [intervalIntegral.integral_const_mul, integral_id]
  ring

/-- Square both sides of the nonnegative warm threshold. -/
theorem warm_threshold (D g B : ℝ) (hD : 0 ≤ D) (hg : 0 < g) (_hB : 0 ≤ B) :
    D ^ 2 / (2 * g) ≥ B ↔ Real.sqrt (2 * g * B) ≤ D := by
  rw [Real.sqrt_le_iff]
  have hden : 0 < 2 * g := by positivity
  change B ≤ D ^ 2 / (2 * g) ↔ _
  rw [le_div_iff₀ hden]
  constructor
  · intro h
    exact ⟨hD, by nlinarith⟩
  · rintro ⟨_, h⟩
    nlinarith

/-- Complete the square in the fluid cycle's average cost. -/
theorem fluid_minimum (B g d : ℝ) (hB : 0 ≤ B) (hg : 0 < g) (hd : 0 < d) :
    Real.sqrt (2 * g * B) ≤ B * g / d + d / 2 := by
  have hs := Real.sq_sqrt (show 0 ≤ 2 * g * B by positivity)
  have form : B * g / d + d / 2 = (2 * B * g + d ^ 2) / (2 * d) := by
    field_simp
  rw [form, le_div_iff₀ (show 0 < 2 * d by positivity)]
  nlinarith [sq_nonneg (d - Real.sqrt (2 * g * B))]

end T2

theorem T2_i_proof : PiZip.T2_i := by
  intro x p F _ _ _
  exact T2.cost_difference x p F

theorem T2_ii_proof : PiZip.T2_ii := by
  intro x F hx _
  refine ⟨T2.positive_slope x hx, ?_, T2.threshold_zero x (x.D + F) hx, ?_⟩
  · intro p q
    exact T2.affine_difference x p q (x.D + F)
  · intro p _
    rw [← sub_nonpos, T2.cost_difference]
    exact T2.delta_threshold x (x.D + F) p hx

theorem T2_iii_proof : PiZip.T2_iii := by
  constructor
  · intro x p g hx _ _
    exact ⟨T2.delta_law x p g,
      (T2.delta_law x p g).symm.trans (T2.delta_threshold x _ p hx)⟩
  · intro x p g hx hp _
    have hnew : 0 ≤ p * x.k * x.n := mul_nonneg (mul_nonneg hp.1 hx.2.2.2.2.2.1.le) hx.2.2.1
    refine ⟨by ring, ?_, ?_⟩
    · unfold ModelC.law
      intro h
      nlinarith
    · intro hn
      simp [hn]

theorem T2_iv_a_proof : PiZip.T2_iv_a := by
  intro D g _ hg
  rw [T2.rent_integral]
  unfold ModelC.cycleValue
  field_simp

theorem T2_iv_b_proof : PiZip.T2_iv_b := by
  intro x g hx hg hc he
  dsimp only
  have hB : 0 ≤ x.k * (x.A - x.n) :=
    mul_nonneg hx.2.2.2.2.2.1.le (sub_nonneg.mpr hx.2.2.2.1)
  have hs := Real.sq_sqrt (show 0 ≤ 2 * g * (x.k * (x.A - x.n)) by positivity)
  refine ⟨?_, ?_, ?_, ?_⟩
  · simpa [ModelC.law, ModelC.cycleValue, hc, he, mul_assoc] using
      T2.warm_threshold x.D g (x.k * (x.A - x.n)) hx.2.1.le hg hB
  · intro d hd
    simpa [mul_assoc] using T2.fluid_minimum (x.k * (x.A - x.n)) g d hB hg hd
  · intro hn
    have hk := hx.2.2.2.2.2.1
    have hAn := sub_pos.mpr hn
    have hpos : 0 < Real.sqrt (2 * g * x.k * (x.A - x.n)) :=
      Real.sqrt_pos.mpr (by positivity)
    have hs' : Real.sqrt (2 * g * x.k * (x.A - x.n)) ^ 2 =
        2 * g * x.k * (x.A - x.n) := Real.sq_sqrt (by positivity)
    apply (div_add_div _ _ (ne_of_gt hpos) (by norm_num : (2 : ℝ) ≠ 0)).trans
    apply (div_eq_iff (ne_of_gt (mul_pos hpos (by norm_num)))).mpr
    nlinarith
  · intro hn
    constructor
    · intro d hd
      simp only [hn, sub_self, mul_zero, zero_mul, zero_div, zero_add]
      positivity
    · intro ε hε
      refine ⟨ε, hε, ?_⟩
      simp only [hn, sub_self, mul_zero, zero_mul, zero_div, zero_add]
      linarith

theorem T2_iv_c_proof : PiZip.T2_iv_c := by
  intro g s hg
  have ledger : (∑ j ∈ Finset.range (s + 1), g * (j : ℝ)) = g * s * (s + 1) / 2 := by
    induction s with
    | zero => simp
    | succ s ih =>
      rw [Finset.sum_range_succ, ih]
      push_cast
      ring
  rw [ledger]
  unfold ModelC.cycleValue
  field_simp

theorem T2_v_proof : PiZip.T2_v := by
  intro x g hx hg
  have hk := hx.2.2.2.2.2.1
  have hD := hx.2.1
  have heta := hx.2.2.2.2.2.2.2
  have hcycle : 0 < ModelC.cycleValue x.D g := by
    unfold ModelC.cycleValue
    positivity
  constructor
  · intro hc
    refine ⟨?_, ?_, ?_⟩
    · simp only [ModelC.law, hc, zero_mul, sub_zero, zero_add]
      positivity
    · simp only [ModelC.law, hc, zero_mul, sub_zero, zero_add]
      positivity
    · intro F hF
      rw [← sub_neg, T2.cost_difference]
      simp only [ModelC.delta, hc, zero_mul, sub_zero]
      have : 0 < x.k * x.D := mul_pos hk hD
      have : 0 ≤ x.eta * x.D := mul_nonneg heta hD.le
      linarith
  · intro hc he
    constructor
    · exact (T2_iv_b_proof x g hx hg hc he).1
    · simpa [ModelC.law, ModelC.cycleValue, hc, he, mul_assoc] using
        T2.warm_threshold x.D g (x.k * x.A) hD.le hg (mul_nonneg hk.le hx.1)

theorem T2_vi_proof : PiZip.T2_vi := by
  intro x p phat F hx _ _ _
  have hs := (T2.positive_slope x hx).le
  have ha := abs_nonneg (phat - p)
  have hab := neg_abs_le (phat - p)
  have hba := le_abs_self (phat - p)
  have hlow := mul_le_mul_of_nonneg_left hab hs
  have hupp := mul_le_mul_of_nonneg_left hba hs
  have affine := T2.affine_difference x phat p (x.D + F)
  have costs := T2.cost_difference x p F
  constructor
  · unfold ModelC.chosenCost
    split_ifs with hhat
    · by_cases htrue : ModelC.fireCost x ≤ ModelC.holdCost x p F
      · rw [min_eq_left htrue]
        simp only [sub_self]
        positivity
      · rw [min_eq_right (le_of_not_ge htrue)]
        linarith
    · by_cases htrue : ModelC.fireCost x ≤ ModelC.holdCost x p F
      · rw [min_eq_left htrue]
        linarith
      · rw [min_eq_right (le_of_not_ge htrue)]
        simp only [sub_self]
        positivity
  · have hkn := mul_nonneg hx.2.2.2.2.2.1.le hx.2.2.1
    have hprod := mul_nonneg hkn ha
    nlinarith

namespace T2

/-- Strictly positive exponential remainder away from zero. -/
theorem root_remainder (a : ℝ) (ha : 0 < a) : 0 < a - 1 + Real.exp (-a) := by
  have he := Real.add_one_lt_exp (show -a ≠ 0 by linarith)
  linarith

/-- The negative exponential lies strictly below its quadratic truncation. -/
theorem exp_quadratic (a : ℝ) (ha : 0 < a) :
    Real.exp (-a) < 1 - a + a ^ 2 / 2 := by
  let Q : ℝ → ℝ := fun t => t ^ 2 / 2 - t + 1 - Real.exp (-t)
  have derivQ (t : ℝ) : HasDerivAt Q (t - 1 + Real.exp (-t)) t := by
    convert ((((hasDerivAt_id t).pow 2).div_const 2).sub (hasDerivAt_id t)).add_const 1
      |>.sub ((hasDerivAt_id t).neg.exp) using 1
    · ext z; rfl
    · dsimp; ring
  obtain ⟨c, hc, hm⟩ := exists_hasDerivAt_eq_slope Q
    (fun t => t - 1 + Real.exp (-t)) ha (by fun_prop)
    (fun t _ => derivQ t)
  have hpos := root_remainder c hc.1
  have hQ : Q 0 = 0 := by simp [Q]
  rw [hQ, sub_zero, sub_zero] at hm
  have : 0 < Q a := (div_pos_iff_of_pos_right ha).mp (hm.symm ▸ hpos)
  dsimp [Q] at this
  linarith

/-- Dimensionless comparison. The difference is concave with a positive
right endpoint, so its chord is strictly positive away from zero. -/
theorem hazard_comparison_scaled (a s y : ℝ) (ha : 0 < a) (hs : 0 < s)
    (hy : 0 < y) (hys : y ≤ s)
    (hroot : s ^ 2 = 2 * (a - 1 + Real.exp (-a))) :
    y - Real.exp (-a) * (Real.exp y - 1) < s * y - y ^ 2 / 2 := by
  have hquad := exp_quadratic a ha
  have hsa : s < a := by nlinarith
  let f : ℝ → ℝ := fun t => s * t - t ^ 2 / 2 - t + Real.exp (-a) * (Real.exp t - 1)
  let f' : ℝ → ℝ := fun t => s - t - 1 + Real.exp (-a) * Real.exp t
  let f'' : ℝ → ℝ := fun t => -1 + Real.exp (-a) * Real.exp t
  have df (t : ℝ) : HasDerivAt f (f' t) t := by
    convert (((((hasDerivAt_id t).const_mul s).sub
      (((hasDerivAt_id t).pow 2).div_const 2)).sub (hasDerivAt_id t)).add
      (((Real.hasDerivAt_exp t).sub_const 1).const_mul (Real.exp (-a)))) using 1
    · ext z; rfl
    · dsimp [f']; ring
  have ddf (t : ℝ) : HasDerivAt f' (f'' t) t := by
    convert ((((hasDerivAt_const t s).sub (hasDerivAt_id t)).sub_const 1).add
      ((Real.hasDerivAt_exp t).const_mul (Real.exp (-a)))) using 1
    · ext z; rfl
    · dsimp [f'']; ring
  have hconcave : ConcaveOn ℝ (Set.Icc 0 s) f := by
    apply concaveOn_of_hasDerivWithinAt2_nonpos (convex_Icc 0 s) (by fun_prop)
      (fun t _ => (df t).hasDerivWithinAt) (fun t _ => (ddf t).hasDerivWithinAt)
    intro t ht
    have ht' : t ∈ Set.Icc 0 s := interior_subset ht
    dsimp [f'']
    rw [← Real.exp_add]
    have he : Real.exp (-a + t) < 1 := Real.exp_lt_one_iff.mpr (by linarith [ht'.2])
    linarith
  have hf0 : f 0 = 0 := by simp [f]
  have hfs : 0 < f s := by
    have he := root_remainder (a - s) (by linarith)
    have hex : Real.exp (-a) * Real.exp s = Real.exp (-(a - s)) := by
      rw [← Real.exp_add]
      congr 1
      ring
    dsimp [f]
    nlinarith
  have hchord := hconcave.2 (show (0 : ℝ) ∈ Set.Icc 0 s from ⟨le_rfl, hs.le⟩)
    (show s ∈ Set.Icc 0 s from ⟨hs.le, le_rfl⟩)
    (show 0 ≤ 1 - y / s by rw [sub_nonneg, div_le_one hs]; exact hys)
    (show 0 ≤ y / s by positivity) (show (1 - y / s) + y / s = 1 by ring)
  simp only [smul_eq_mul, hf0, mul_zero, zero_add, div_mul_cancel₀ _ (ne_of_gt hs)] at hchord
  have hchordpos : 0 < y / s * f s := mul_pos (div_pos hy hs) hfs
  dsimp [f] at hchord hchordpos
  linarith

end T2

theorem T2_vii_proof : PiZip.T2_vii := by
  constructor
  · intro x p g hx hg _ _
    dsimp only
    intro hDstar
    have hD := hx.2.1
    have difference : ModelC.warmValue x.D (Real.sqrt (2 * g * x.k * (x.A - x.n))) g -
        ModelC.cycleValue x.D g =
        x.D * (Real.sqrt (2 * g * x.k * (x.A - x.n)) - x.D) / g := by
      unfold ModelC.warmValue ModelC.cycleValue
      ring
    have hdiff : 0 ≤ x.D * (Real.sqrt (2 * g * x.k * (x.A - x.n)) - x.D) / g :=
      div_nonneg (mul_nonneg hD.le (sub_nonneg.mpr hDstar)) hg.le
    have hle : ModelC.cycleValue x.D g ≤
        ModelC.warmValue x.D (Real.sqrt (2 * g * x.k * (x.A - x.n))) g := by linarith
    refine ⟨hle, ?_, ?_⟩
    · constructor
      · intro heq
        have hz : x.D * (Real.sqrt (2 * g * x.k * (x.A - x.n)) - x.D) = 0 := by
          apply (div_eq_zero_iff).mp ?_ |>.resolve_right (ne_of_gt hg)
          linarith
        have := (mul_eq_zero.mp hz).resolve_left (ne_of_gt hD)
        linarith
      · intro heq
        rw [heq] at difference ⊢
        simp only [sub_self, mul_zero, zero_div] at difference
        linarith
    · intro hlaw
      have hdelta := (T2.delta_law x p g).mpr hlaw
      unfold ModelC.delta at *
      linarith
  · intro B g h D dH hB hg hh hD hDs hdH hroot
    let a := h * dH / g
    let s := h * Real.sqrt (2 * g * B) / g
    let y := h * D / g
    have hstar : 0 < Real.sqrt (2 * g * B) := Real.sqrt_pos.mpr (by positivity)
    have ha : 0 < a := by dsimp [a]; positivity
    have hs : 0 < s := by dsimp [s]; positivity
    have hy : 0 < y := by dsimp [y]; positivity
    have hys : y ≤ s := by dsimp [y, s]; gcongr
    have hroot' : s ^ 2 = 2 * (a - 1 + Real.exp (-a)) := by
      have hsq := Real.sq_sqrt (show 0 ≤ 2 * g * B by positivity)
      have hroot'' : a - 1 + Real.exp (-a) = B * h ^ 2 / g := by
        apply (eq_div_iff (ne_of_gt hg)).mpr
        dsimp [a] at *
        field_simp at hroot ⊢
        nlinarith [hroot]
      rw [hroot'']
      dsimp [s]
      field_simp
      nlinarith
    have hc := T2.hazard_comparison_scaled a s y ha hs hy hys hroot'
    have hscale : 0 < g / h ^ 2 := by positivity
    have hc' := mul_lt_mul_of_pos_left hc hscale
    dsimp [a, s, y] at hc'
    unfold ModelC.hazardValue ModelC.warmValue
    convert hc' using 1 <;> field_simp

namespace T2

/-- Average cost is derived from the actual rent integral. -/
theorem fluid_average_formula (B g T : ℝ) :
    ModelC.fluidAverageCost B g T = (B + g * T ^ 2 / 2) / T := by
  rw [ModelC.fluidAverageCost, rent_integral]

theorem warm_derivative (d g D : ℝ) :
    HasDerivAt (fun x => ModelC.warmValue x d g) ((d - D) / g) D := by
  convert (((hasDerivAt_id D).const_mul d).sub
    (((hasDerivAt_id D).pow 2).div_const 2)).div_const g using 1
  · ext x; rfl
  · simp only [id_eq]; ring

/-- The zero-normalized value matches the edit price at the optimal cycle. -/
theorem warm_terminal (B g d : ℝ) (hg : 0 < g) (hsq : d ^ 2 = 2 * g * B) :
    ModelC.warmValue d d g = B := by
  unfold ModelC.warmValue
  apply (div_eq_iff (ne_of_gt hg)).mpr
  nlinarith

theorem warm_obstacle (B g d D : ℝ) (hg : 0 < g) (hsq : d ^ 2 = 2 * g * B) :
    ModelC.warmValue D d g ≤ B := by
  unfold ModelC.warmValue
  rw [div_le_iff₀ hg]
  nlinarith [sq_nonneg (d - D)]

end T2

theorem T2_vii_warm_exact_proof : PiZip.T2_vii_warm_exact := by
  intro B g hB hg
  dsimp only
  let d := Real.sqrt (2 * g * B)
  have hd : 0 < d := Real.sqrt_pos.mpr (by positivity)
  have hsq : d ^ 2 = 2 * g * B := Real.sq_sqrt (by positivity)
  have attained : ModelC.fluidAverageCost B g (d / g) = d := by
    rw [T2.fluid_average_formula]
    field_simp
    nlinarith
  have optimum : ModelC.OptimalFluidAverage B g d d := by
    refine ⟨attained, ?_⟩
    intro T hT
    rw [T2.fluid_average_formula, le_div_iff₀ hT]
    have hsquare := sq_nonneg (g * T - d)
    nlinarith
  have bellman : ModelC.WarmBellman B g d d (fun D => ModelC.warmValue D d g) := by
    refine ⟨optimum, ?_, T2.warm_terminal B g d hg hsq, ?_, ?_, ?_⟩
    · simp [ModelC.warmValue]
    · unfold ModelC.warmValue
      fun_prop
    · intro D _
      exact T2.warm_derivative d g D
    · intro D _
      exact T2.warm_obstacle B g d D hg hsq
  refine ⟨optimum, bellman, ?_⟩
  intro rate V hV
  have hrate : rate = d := by linarith [hV.1.1]
  refine ⟨hrate, ?_⟩
  intro D hD
  by_cases hzero : D = 0
  · simp [hzero, ModelC.warmValue]
  have hDpos : 0 < D := lt_of_le_of_ne hD.1 (Ne.symm hzero)
  let difference : ℝ → ℝ := fun x => V x - ModelC.warmValue x d g
  have hcontinuous : ContinuousOn difference (Set.Icc 0 D) := by
    apply (hV.2.2.2.1.mono ?_).sub
    · unfold ModelC.warmValue
      fun_prop
    · intro x hx
      exact ⟨hx.1, hx.2.trans hD.2⟩
  have hderivative : ∀ x ∈ Set.Ioo 0 D, HasDerivAt difference 0 x := by
    intro x hx
    have hx' : x ∈ Set.Ioo 0 d := ⟨hx.1, hx.2.trans_le hD.2⟩
    have hder := hV.2.2.2.2.1 x hx'
    rw [hrate] at hder
    convert hder.sub (T2.warm_derivative d g x) using 1
    simp
  obtain ⟨c, _, hc⟩ := exists_hasDerivAt_eq_slope difference (fun _ => 0)
    hDpos hcontinuous hderivative
  have hconst : difference D - difference 0 = 0 := by
    apply (div_eq_zero_iff.mp hc.symm).resolve_right
    simpa using ne_of_gt hDpos
  dsimp [difference] at hconst
  simp only [ModelC.warmValue, mul_zero, zero_pow (by decide : 2 ≠ 0),
    zero_div, sub_zero] at hconst
  unfold ModelC.warmValue
  linarith

namespace T2

/-- Dimensionless hazard root function. -/
noncomputable def hazardRoot (a : ℝ) : ℝ := a - 1 + Real.exp (-a)

theorem hazardRoot_derivative (a : ℝ) :
    HasDerivAt hazardRoot (1 - Real.exp (-a)) a := by
  convert ((hasDerivAt_id a).sub_const 1).add ((hasDerivAt_id a).neg.exp) using 1
  · ext x; rfl
  · dsimp; ring

theorem hazardRoot_strictMono : StrictMonoOn hazardRoot (Set.Ici 0) := by
  apply strictMonoOn_of_deriv_pos (convex_Ici 0) (by unfold hazardRoot; fun_prop)
  intro a ha
  rw [(hazardRoot_derivative a).deriv]
  have ha' : 0 < a := by simpa only [interior_Ici, Set.mem_Ioi] using ha
  have he : Real.exp (-a) < 1 := Real.exp_lt_one_iff.mpr (by linarith)
  linarith

/-- A finite bracket proves existence; monotonicity proves uniqueness. -/
theorem hazardRoot_exists (b : ℝ) (hb : 0 < b) :
    ∃ a : ℝ, 0 < a ∧ hazardRoot a = b ∧
      ∀ c : ℝ, 0 < c → hazardRoot c = b → c = a := by
  have hr0 : hazardRoot 0 = 0 := by simp [hazardRoot]
  have hrb : b ≤ hazardRoot (b + 1) := by
    unfold hazardRoot
    linarith [Real.exp_pos (-(b + 1))]
  have hmem : b ∈ Set.Icc (hazardRoot 0) (hazardRoot (b + 1)) := ⟨by linarith, hrb⟩
  obtain ⟨a, ha, heq⟩ := intermediate_value_Icc (show (0 : ℝ) ≤ b + 1 by linarith)
    (show ContinuousOn hazardRoot (Set.Icc 0 (b + 1)) by unfold hazardRoot; fun_prop) hmem
  have hapos : 0 < a := by
    by_contra hn
    have haz : a = 0 := by linarith [ha.1]
    rw [haz, hr0] at heq
    linarith
  refine ⟨a, hapos, heq, ?_⟩
  intro c hc hec
  exact hazardRoot_strictMono.injOn hc.le hapos.le (hec.trans heq.symm)

/-- Integrating the survival-weighted rent gives this first-wait cost. -/
theorem hazard_wait_formula (B g h J0 D T : ℝ) (hh : 0 < h) :
    ModelC.hazardWaitCost B g h J0 D T =
      D / h + g / h ^ 2 + Real.exp (-h * T) *
        (B + J0 - D / h - g * T / h - g / h ^ 2) := by
  let primitive : ℝ → ℝ := fun t =>
    -Real.exp (-h * t) * (D / h + g * t / h + g / h ^ 2)
  have hder (t : ℝ) : HasDerivAt primitive (Real.exp (-h * t) * (D + g * t)) t := by
    have hdexp := ((hasDerivAt_id t).const_mul (-h)).exp.neg
    have hdlin := ((hasDerivAt_const t (D / h)).add
      (((hasDerivAt_id t).const_mul g).div_const h)).add_const (g / h ^ 2)
    convert hdexp.mul hdlin using 1
    · ext x; rfl
    · dsimp
      field_simp
      ring
  have hint : IntervalIntegrable (fun t => Real.exp (-h * t) * (D + g * t))
      MeasureTheory.volume 0 T := (show Continuous _ by fun_prop).intervalIntegrable _ _
  rw [ModelC.hazardWaitCost, intervalIntegral.integral_eq_sub_of_hasDerivAt
    (fun t _ => hder t) hint]
  simp only [primitive, mul_zero, zero_div, add_zero, Real.exp_zero]
  ring

/-- Normalize pending mass and waiting time in units g/h and 1/h. -/
noncomputable def hazardWaitScaled (a y t : ℝ) : ℝ :=
  y + 1 + Real.exp (-t) * (a - y - t - 1)

noncomputable def hazardPolicyScaled (a y : ℝ) : ℝ :=
  if y ≤ a then y + 1 - Real.exp (y - a) else a

/-- Every first wait is at least the threshold policy's cost. -/
theorem hazard_scaled_wait_bound (a y t : ℝ) (_hy : 0 ≤ y) (ht : 0 ≤ t) :
    hazardPolicyScaled a y ≤ hazardWaitScaled a y t := by
  unfold hazardPolicyScaled hazardWaitScaled
  split_ifs with hya
  · have he := Real.add_one_le_exp (t + y - a)
    have hmul := mul_le_mul_of_nonneg_left he (Real.exp_pos (-t)).le
    have hex : Real.exp (-t) * Real.exp (t + y - a) = Real.exp (y - a) := by
      rw [← Real.exp_add]
      congr 1
      ring
    rw [hex] at hmul
    nlinarith
  · have hya' : 0 ≤ y - a := by linarith
    have he := Real.add_one_le_exp t
    have hmul := mul_le_mul_of_nonneg_left he (show 0 ≤ y - a + 1 by linarith)
    have hprod : 0 ≤ (y - a) * t := mul_nonneg hya' ht
    have hbound : y - a + t + 1 ≤ (y - a + 1) * Real.exp t := by nlinarith
    have hmul' := mul_le_mul_of_nonneg_left hbound (Real.exp_pos (-t)).le
    have hex : Real.exp (-t) * Real.exp t = 1 := by rw [← Real.exp_add]; simp
    nlinarith

theorem hazard_scaled_obstacles (a y : ℝ) :
    hazardPolicyScaled a y ≤ a ∧ hazardPolicyScaled a y ≤ y + 1 := by
  unfold hazardPolicyScaled
  split_ifs with hya
  · have he := Real.add_one_le_exp (y - a)
    have hpos := Real.exp_pos (y - a)
    constructor <;> linarith
  · constructor
    · rfl
    · linarith

/-- Restoring physical units in the first-wait formula. -/
theorem hazard_wait_normalized (B g h a D T : ℝ) (hg : 0 < g) (hh : 0 < h)
    (hroot : B = g / h ^ 2 * hazardRoot a) :
    ModelC.hazardWaitCost B g h (g / h ^ 2 * (1 - Real.exp (-a))) D T =
      g / h ^ 2 * hazardWaitScaled a (h * D / g) (h * T) := by
  rw [hazard_wait_formula _ _ _ _ _ _ hh, hroot]
  unfold hazardWaitScaled hazardRoot
  have hex : -h * T = -(h * T) := by ring
  rw [hex]
  field_simp
  ring

/-- Adding the continuation price adds exactly its survival-discounted value. -/
theorem hazard_wait_restart (B g h J0 D T : ℝ) :
    ModelC.hazardWaitCost B g h J0 D T =
      ModelC.hazardWaitCost B g h 0 D T + Real.exp (-h * T) * J0 := by
  unfold ModelC.hazardWaitCost
  ring

/-- The root makes the resetting renewal price g/h^2*(1-exp(-a)). -/
theorem hazard_renewal_root (B g h a : ℝ) (hg : 0 < g) (hh : 0 < h)
    (ha : 0 < a) (hroot : B = g / h ^ 2 * hazardRoot a) :
    ModelC.hazardRenewalCost B g h ((g * a / h) / g) =
      g / h ^ 2 * (1 - Real.exp (-a)) := by
  have htime : h * ((g * a / h) / g) = a := by field_simp
  have hex : -h * ((g * a / h) / g) = -a := by linarith
  have hden : 0 < 1 - Real.exp (-h * ((g * a / h) / g)) := by
    rw [hex]
    have he : Real.exp (-a) < 1 := Real.exp_lt_one_iff.mpr (by linarith)
    linarith
  have hw := hazard_wait_normalized B g h a 0 ((g * a / h) / g) hg hh hroot
  rw [htime] at hw
  simp only [mul_zero, zero_div] at hw
  have hs : hazardWaitScaled a 0 a = 1 - Real.exp (-a) := by
    unfold hazardWaitScaled
    ring
  rw [hs, hazard_wait_restart] at hw
  unfold ModelC.hazardRenewalCost
  apply (div_eq_iff (ne_of_gt hden)).mpr
  linarith

/-- At continuation mass D, waiting to the root threshold gives the scaled policy value. -/
theorem hazard_state_root (B g h a D : ℝ) (hg : 0 < g) (hh : 0 < h)
    (ha : 0 < a) (hroot : B = g / h ^ 2 * hazardRoot a) :
    ModelC.hazardStateCost B g h (g * a / h) D =
      g / h ^ 2 * (h * D / g + 1 - Real.exp (h * D / g - a)) := by
  rw [ModelC.hazardStateCost, hazard_renewal_root B g h a hg hh ha hroot,
    hazard_wait_normalized B g h a D _ hg hh hroot]
  have htime : h * ((g * a / h - D) / g) = a - h * D / g := by
    field_simp
  rw [htime]
  unfold hazardWaitScaled
  rw [neg_sub]
  ring

end T2

theorem T2_vii_hazard_exact_proof : PiZip.T2_vii_hazard_exact := by
  intro B g h hB hg hh
  have hb : 0 < B * h ^ 2 / g := by positivity
  obtain ⟨a, ha, haroot, haunique⟩ := T2.hazardRoot_exists (B * h ^ 2 / g) hb
  have hroot : B = g / h ^ 2 * T2.hazardRoot a := by
    rw [haroot]
    field_simp
  let d := g * a / h
  have hd : 0 < d := by dsimp [d]; positivity
  have hscale : 0 < g / h ^ 2 := by positivity
  have hdim : h * d / g = a := by dsimp [d]; field_simp
  have hrenewal : ModelC.hazardRenewalCost B g h (d / g) =
      g / h ^ 2 * (1 - Real.exp (-a)) :=
    T2.hazard_renewal_root B g h a hg hh ha hroot
  have hstate (D : ℝ) : ModelC.hazardStateCost B g h d D =
      g / h ^ 2 * (h * D / g + 1 - Real.exp (h * D / g - a)) :=
    T2.hazard_state_root B g h a D hg hh ha hroot
  have hterminal : B + ModelC.hazardRenewalCost B g h (d / g) = g / h ^ 2 * a := by
    rw [hrenewal, hroot]
    unfold T2.hazardRoot
    ring
  refine ⟨d, hd, ?_, ?_, ?_, ?_, ?_⟩
  · have hneg : -h * d / g = -a := by
      calc -h * d / g = -(h * d / g) := by ring
           _ = -a := by rw [hdim]
    rw [hdim, hneg]
    change g / h ^ 2 * T2.hazardRoot a = B
    exact hroot.symm
  · intro c hc hcr
    have hca : h * c / g = a := by
      apply haunique _ (by positivity)
      change h * c / g - 1 + Real.exp (-(h * c / g)) = B * h ^ 2 / g
      have hneg : -h * c / g = -(h * c / g) := by ring
      rw [hneg] at hcr
      field_simp at hcr ⊢
      nlinarith
    dsimp [d]
    field_simp at hca ⊢
    nlinarith
  · intro T hT
    have hwait := T2.hazard_scaled_wait_bound a 0 (h * T) (by norm_num) (by positivity)
    have hp0 : T2.hazardPolicyScaled a 0 = 1 - Real.exp (-a) := by
      simp [T2.hazardPolicyScaled, ha.le]
    rw [hp0] at hwait
    have hw := mul_le_mul_of_nonneg_left hwait hscale.le
    have hnormalize := T2.hazard_wait_normalized B g h a 0 T hg hh hroot
    simp only [mul_zero, zero_div] at hnormalize
    rw [← hnormalize, ← hrenewal, T2.hazard_wait_restart] at hw
    change ModelC.hazardRenewalCost B g h (d / g) ≤
      ModelC.hazardWaitCost B g h 0 0 T / (1 - Real.exp (-h * T))
    rw [le_div_iff₀ (show 0 < 1 - Real.exp (-h * T) by
      have he : Real.exp (-h * T) < 1 := Real.exp_lt_one_iff.mpr (by nlinarith)
      linarith)]
    linarith
  · intro D _
    rw [hstate, hrenewal]
    unfold ModelC.hazardValue
    have hex : Real.exp (h * D / g - a) = Real.exp (-a) * Real.exp (h * D / g) := by
      rw [← Real.exp_add]
      congr 1
      ring
    have hneg : -h * d / g = -a := by
      calc -h * d / g = -(h * d / g) := by ring
           _ = -a := by rw [hdim]
    rw [hneg, hex]
    field_simp
    ring
  · dsimp only
    have hJ (D : ℝ) :
        (if D ≤ d then ModelC.hazardStateCost B g h d D
          else B + ModelC.hazardRenewalCost B g h (d / g)) =
        g / h ^ 2 * T2.hazardPolicyScaled a (h * D / g) := by
      have hiff : D ≤ d ↔ h * D / g ≤ a := by
        rw [← hdim, div_le_div_iff_of_pos_right hg]
        exact (mul_le_mul_iff_right₀ hh).symm
      unfold T2.hazardPolicyScaled
      by_cases hD : D ≤ d
      · simp only [ite_eq_left hD, ite_eq_left (hiff.mp hD)]
        exact hstate D
      · simp only [ite_eq_right hD, ite_eq_right (mt hiff.mpr hD)]
        exact hterminal
    constructor
    · rw [hJ, hrenewal]
      simp [T2.hazardPolicyScaled, ha.le]
    · intro D hD
      rw [hJ]
      have hobstacles := T2.hazard_scaled_obstacles a (h * D / g)
      refine ⟨?_, ?_, ?_⟩
      · rw [hterminal]
        exact mul_le_mul_of_nonneg_left hobstacles.1 hscale.le
      · have hbound := mul_le_mul_of_nonneg_left hobstacles.2 hscale.le
        have hunits : g / h ^ 2 * (h * D / g + 1) = D / h + g / h ^ 2 := by
          field_simp
        rwa [hunits] at hbound
      · intro T hT
        rw [hrenewal, T2.hazard_wait_normalized B g h a D T hg hh hroot]
        exact mul_le_mul_of_nonneg_left
          (T2.hazard_scaled_wait_bound a (h * D / g) (h * T) (by positivity) (by positivity))
          hscale.le

end PiZip
