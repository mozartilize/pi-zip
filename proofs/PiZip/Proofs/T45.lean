import PiZip.Sanity1

namespace PiZip

/-- Immediate LAW firing can disappear before the guarded edit. -/
theorem T5_v_false : ¬ PiZip.T5_v := by
  intro h
  obtain ⟨k, hk, hedit, hfirst, hcost⟩ := h 10 1 (1 / 2) changingEstimate 10
    (by norm_num) (by norm_num) (by norm_num) (by norm_num)
    (by intro a _; dsimp [changingEstimate]; split <;> norm_num)
    (by norm_num [changingEstimate]) (by norm_num)
  have hk' : k < 11 := by simpa [ModelT.burst] using hk
  clear h hfirst
  interval_cases k <;>
    solve
    | norm_num [ModelT.onlineSchedule, ModelT.guarded, ModelT.lawPredicate,
        ModelT.controller, ModelT.decisions, ModelT.step, ModelT.initial,
        ModelT.burst, changingEstimate] at hedit
    | norm_num [ModelT.onlineSchedule, ModelT.guarded, ModelT.lawPredicate,
        ModelT.controller, ModelT.decisions, ModelT.step, ModelT.initial,
        ModelT.burst, changingEstimate, ModelT.algCost, ModelT.cost, ModelT.run,
        List.zipIdx] at hcost

/-- The early LAW adversary has the quantitative ratio promised by T4(iv). -/
theorem law_early_quantitative (estimate : ModelT.Estimate ℝ) (Ghat B : ℝ)
    (hG : 0 < Ghat) (hB : 0 < B)
    (hbound : ∀ D : ℝ, 0 ≤ D → estimate B [D] ≤ Ghat)
    (hprice : Real.sqrt (2 * Ghat * B) + 1 < B) :
    ∃ D : ℝ, 0 < D ∧ D ≤ Real.sqrt (2 * Ghat * B) + 1 ∧ D < B ∧
      ModelT.Optimal B [D] (fun _ => false) ∧
      ModelT.cost B [D] (fun _ => false) = D ∧
      ModelT.algCost B [D] (ModelT.law estimate) = B ∧
      B / (Real.sqrt (2 * Ghat * B) + 1) ≤
        ModelT.algCost B [D] (ModelT.law estimate) /
          ModelT.cost B [D] (fun _ => false) := by
  let D := Real.sqrt (2 * Ghat * B) + 1
  have hD : 0 < D := by dsimp [D]; positivity
  have hs := Real.sq_sqrt (show 0 ≤ 2 * Ghat * B by positivity)
  have hfire : 2 * estimate B [D] * B ≤ D ^ 2 := by
    have hest := mul_le_mul_of_nonneg_right (hbound D hD.le) hB.le
    have hroot := Real.sqrt_nonneg (2 * Ghat * B)
    dsimp [D]
    nlinarith
  have hhold : ModelT.cost B [D] (fun _ => false) = D := by
    simp [ModelT.cost, ModelT.run, List.zipIdx, ModelT.initial, ModelT.step]
  have hlaw : ModelT.algCost B [D] (ModelT.law estimate) = B := by
    simp [ModelT.algCost, ModelT.cost, ModelT.run, List.zipIdx, ModelT.onlineSchedule,
      ModelT.law, ModelT.controller, ModelT.decisions, ModelT.initial, ModelT.step, hfire]
  refine ⟨D, hD, le_rfl, hprice, ?_, hhold, hlaw, ?_⟩
  · intro sigma
    rw [hhold]
    simp only [ModelT.cost, ModelT.run, List.zipIdx, List.foldl_cons,
      List.foldl_nil, ModelT.initial, ModelT.step]
    cases sigma 0 <;> simp
    exact hprice.le
  · rw [hlaw, hhold]

/-- Append to an execution whose earlier decisions all held. -/
theorem decisions_hold_append (B : ℝ) (ctrl : ModelT.Predicate ℝ)
    (a tail history : List ℝ) (q : ModelT.State ℝ)
    (h : ModelT.decisions B ctrl a history q = List.replicate a.length false) :
    ModelT.decisions B ctrl (a ++ tail) history q =
      List.replicate a.length false ++
        ModelT.decisions B ctrl tail (history ++ a)
          (a.foldl (fun q x => ModelT.step B x false q) q) := by
  induction a generalizing history q with
  | nil => simp
  | cons x xs ih =>
    simp only [ModelT.decisions, List.length_cons, List.replicate_succ] at h
    have hedit := (List.cons.inj h).1
    have hrest := (List.cons.inj h).2
    rw [hedit] at hrest
    simp only [List.cons_append, ModelT.decisions, hedit, List.length_cons,
      List.replicate_succ, List.foldl_cons]
    rw [ih (history ++ [x]) (ModelT.step B x false q) hrest]
    simp [List.append_assoc]

/-- Reconstruct the next controller decision after a prefix of holds. -/
theorem controller_hold_append (B : ℝ) (ctrl : ModelT.Predicate ℝ)
    (a : List ℝ) (x : ℝ)
    (h : ModelT.decisions B ctrl a [] ModelT.initial = List.replicate a.length false) :
    ModelT.controller ctrl B (a ++ [x]) =
      let q := a.foldl (fun q y => ModelT.step B y false q) ModelT.initial
      ctrl B (a ++ [x]) (q.pending + x) (q.rent + q.pending + x) := by
  unfold ModelT.controller
  rw [decisions_hold_append B ctrl a [x] [] ModelT.initial h]
  simp [ModelT.decisions]

/-- Observed holds imply that reconstructed decisions are all holds. -/
theorem decisions_of_controller_holds (B : ℝ) (ctrl : ModelT.Predicate ℝ)
    (a : List ℝ)
    (h : ∀ i : ℕ, i < a.length → ModelT.controller ctrl B (a.take (i + 1)) = false) :
    ModelT.decisions B ctrl a [] ModelT.initial = List.replicate a.length false := by
  induction a using List.reverseRecOn with
  | nil => simp [ModelT.decisions]
  | append_singleton a x ih =>
    have ha : ModelT.decisions B ctrl a [] ModelT.initial = List.replicate a.length false := by
      apply ih
      intro i hi
      simpa only [List.take_append_of_le_length (by omega : i + 1 ≤ a.length)] using
        h i (by simp; omega)
    have hx := h a.length (by simp)
    have htake : (a ++ [x]).take (a.length + 1) = a ++ [x] := by
      apply List.take_of_length_le
      simp
    rw [htake] at hx
    rw [controller_hold_append B ctrl a x ha] at hx
    rw [decisions_hold_append B ctrl a [x] [] ModelT.initial ha]
    simp only [List.nil_append, ModelT.decisions, hx,
      List.length_append, List.length_singleton, List.replicate_add,
      List.replicate_one]

/-- Cost state for a prefix that holds at every request. -/
theorem run_hold (B : ℝ) (a : List ℝ) (sigma : ModelT.Schedule)
    (h : ∀ i : ℕ, i < a.length → sigma i = false) :
    ModelT.run B a sigma =
      a.foldl (fun q x => ModelT.step B x false q) ModelT.initial := by
  unfold ModelT.run
  calc
    _ = (a.zipIdx).foldl (fun q ai => ModelT.step B ai.1 false q) ModelT.initial := by
      apply List.foldl_ext
      intro q ai hai
      rw [h ai.2 (by simpa using List.snd_lt_of_mem_zipIdx hai)]
    _ = _ := by
      simpa only [List.zipIdx_map_fst] using
        (List.foldl_map (f := Prod.fst) (g := fun q x => ModelT.step B x false q)
          (l := a.zipIdx) (init := ModelT.initial)).symm

/-- Zero arrivals preserve pending mass and add it once per held request. -/
theorem fold_hold_zeros (B D R C : ℝ) (n : ℕ) :
    (List.replicate n (0 : ℝ)).foldl (fun q x => ModelT.step B x false q)
      (⟨D, R, C⟩ : ModelT.State ℝ) = ⟨D, R + n * D, C + n * D⟩ := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [List.replicate_add, List.foldl_append, ih]
    simp only [List.replicate_one, List.foldl_cons, List.foldl_nil, ModelT.step]
    simp [Nat.cast_add, Nat.cast_one, add_mul, add_assoc]

/-- A held burst prefix has constant pending mass and linear accumulated rent. -/
theorem fold_hold_burst (B D : ℝ) (n : ℕ) :
    (ModelT.burst D n).foldl (fun q x => ModelT.step B x false q) ModelT.initial =
      ⟨D, (n + 1 : ℕ) * D, (n + 1 : ℕ) * D⟩ := by
  simp only [ModelT.burst, List.foldl_cons]
  have hstep : ModelT.step B D false ModelT.initial =
      (⟨D, D, D⟩ : ModelT.State ℝ) := by simp [ModelT.step, ModelT.initial]
  rw [hstep, fold_hold_zeros]
  simp [Nat.cast_add, Nat.cast_one, add_mul, add_comm]

/-- Before the first edit, a burst supplies exactly (j+1)*D prospective rent. -/
theorem guarded_burst_decision (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ)
    (m j : ℕ) (hj : j ≤ m) (hD : 0 < D)
    (hfirst : ∀ i : ℕ, i < j → ModelT.onlineSchedule B
      (ModelT.guarded alpha (ModelT.lawPredicate estimate)) (ModelT.burst D m) i = false) :
    ModelT.onlineSchedule B (ModelT.guarded alpha (ModelT.lawPredicate estimate))
      (ModelT.burst D m) j =
      decide (B ≤ (j + 1 : ℕ) * D ∨
        (D ^ 2 ≥ 2 * estimate B ((ModelT.burst D m).take (j + 1)) * B ∧
          alpha * B ≤ (j + 1 : ℕ) * D)) := by
  have htake : (ModelT.burst D m).take (j + 1) = ModelT.burst D j := by
    simp [ModelT.burst, List.take_succ_cons, Nat.min_eq_left hj]
  unfold ModelT.onlineSchedule
  rw [htake]
  cases j with
  | zero =>
    simp [ModelT.guarded, ModelT.controller, ModelT.decisions, ModelT.initial,
      ModelT.burst, ModelT.lawPredicate, hD]
  | succ n =>
    have hprefix : ∀ i : ℕ, i < (ModelT.burst D n).length →
        ModelT.guarded alpha (ModelT.lawPredicate estimate) B
          ((ModelT.burst D n).take (i + 1)) = false := by
      intro i hi
      have him : i ≤ m := by simp [ModelT.burst] at hi; omega
      have hin : i ≤ n := by simp [ModelT.burst] at hi; omega
      simpa [ModelT.onlineSchedule, ModelT.burst, List.take_succ_cons,
        Nat.min_eq_left him, Nat.min_eq_left hin] using hfirst i (by simpa [ModelT.burst] using hi)
    have hholds := decisions_of_controller_holds B
      (fun B history P R => decide (0 < P ∧ (B ≤ R ∨
        (ModelT.lawPredicate estimate B history P R = true ∧ alpha * B ≤ R))))
      (ModelT.burst D n) hprefix
    have hburst : ModelT.burst D (n + 1) = ModelT.burst D n ++ [0] := by
      simp [ModelT.burst, List.replicate_add]
    change ModelT.controller _ B _ = _
    rw [hburst, controller_hold_append B _ _ 0 hholds, fold_hold_burst]
    simp [ModelT.lawPredicate, hD, Nat.cast_add, Nat.cast_one, add_mul]

/-- A first edit adds B to exactly the rent paid on the held prefix. -/
theorem cost_first_edit (B : ℝ) (a : List ℝ) (x : ℝ) (sigma : ModelT.Schedule)
    (hhold : ∀ i : ℕ, i < a.length → sigma i = false)
    (hedit : sigma a.length = true) :
    ModelT.cost B (a ++ [x]) sigma =
      (a.foldl (fun q y => ModelT.step B y false q) ModelT.initial).cost + B := by
  unfold ModelT.cost ModelT.run
  rw [List.zipIdx_append, List.foldl_append]
  simp only [List.zipIdx_cons, List.zipIdx_nil, Nat.zero_add, List.foldl_cons, List.foldl_nil]
  change (ModelT.step B x (sigma a.length) (ModelT.run B a sigma)).cost = _
  rw [hedit, run_hold B a sigma hhold]
  simp [ModelT.step]

/-- A finite prefix reconstructs the same online decisions on its actual requests. -/
theorem onlineSchedule_take (B : ℝ) (rule : ModelT.Online ℝ) (a : List ℝ)
    (n i : ℕ) (hi : i < n) :
    ModelT.onlineSchedule B rule (a.take n) i = ModelT.onlineSchedule B rule a i := by
  simp [ModelT.onlineSchedule, List.take_take, Nat.min_eq_left (show i + 1 ≤ n by omega)]

/-- The first burst cycle costs k*D+B when its first edit is at index k. -/
theorem algCost_first_burst_edit (B D : ℝ) (rule : ModelT.Online ℝ)
    (m k : ℕ) (hk : k ≤ m)
    (hfirst : ∀ i : ℕ, i < k → ModelT.onlineSchedule B rule (ModelT.burst D m) i = false)
    (hedit : ModelT.onlineSchedule B rule (ModelT.burst D m) k = true) :
    ModelT.algCost B ((ModelT.burst D m).take (k + 1)) rule = k * D + B := by
  have htake : (ModelT.burst D m).take (k + 1) = ModelT.burst D k := by
    simp [ModelT.burst, List.take_succ_cons, Nat.min_eq_left hk]
  have hedit' : ModelT.onlineSchedule B rule (ModelT.burst D k) k = true := by
    rw [← htake, onlineSchedule_take B rule _ (k + 1) k (by omega)]
    exact hedit
  rw [htake]
  unfold ModelT.algCost
  cases k with
  | zero =>
    simpa [ModelT.burst, ModelT.initial] using
      cost_first_edit B [] D (ModelT.onlineSchedule B rule (ModelT.burst D 0))
        (by simp) hedit'
  | succ n =>
    have hburst : ModelT.burst D (n + 1) = ModelT.burst D n ++ [0] := by
      simp [ModelT.burst, List.replicate_add]
    conv_lhs => arg 2; rw [hburst]
    have hheld : ∀ i : ℕ, i < (ModelT.burst D n).length →
        ModelT.onlineSchedule B rule (ModelT.burst D (n + 1)) i = false := by
      intro i hi
      rw [← htake, onlineSchedule_take B rule _ (n + 1 + 1) i (by simp [ModelT.burst] at hi; omega)]
      exact hfirst i (by simpa [ModelT.burst] using hi)
    rw [cost_first_edit B (ModelT.burst D n) 0
      (ModelT.onlineSchedule B rule (ModelT.burst D (n + 1))) hheld
      (by simpa [ModelT.burst] using hedit'), fold_hold_burst]

/-- LAW persistence repairs the unqualified burst consistency claim. -/
theorem T5_v_persistent_proof : PiZip.T5_v_persistent := by
  classical
  intro B D alpha estimate m hB hD halpha hle _hnonneg _hlaw hlong
  dsimp only
  intro hpersist
  let rule := ModelT.guarded alpha (ModelT.lawPredicate estimate)
  let a := ModelT.burst D m
  have hdecision (j : ℕ) (hj : j ≤ m)
      (hfirst : ∀ i : ℕ, i < j → ModelT.onlineSchedule B rule a i = false) :
      ModelT.onlineSchedule B rule a j = decide (alpha * B ≤ (j + 1 : ℕ) * D) := by
    have hlaw := hpersist j (by dsimp [a, ModelT.burst]; simp; omega) hfirst
    rw [guarded_burst_decision B D alpha estimate m j hj hD hfirst]
    simp only [hlaw, true_and]
    congr 1
    apply propext
    constructor
    · intro h
      rcases h with h | h
      · exact (mul_le_of_le_one_left hB.le hle).trans h
      · exact h
    · exact Or.inr
  have hex : ∃ k : ℕ, k < a.length ∧ ModelT.onlineSchedule B rule a k = true := by
    by_contra h
    have hfalse : ∀ k : ℕ, k < a.length → ModelT.onlineSchedule B rule a k = false := by
      intro k hk
      cases hval : ModelT.onlineSchedule B rule a k with
      | false => rfl
      | true => exact (h ⟨k, hk, hval⟩).elim
    have hlast := hfalse m (by simp [a, ModelT.burst])
    rw [hdecision m le_rfl (by intro i hi; exact hfalse i (by simp [a, ModelT.burst]; omega))] at hlast
    have hthreshold : alpha * B ≤ (m + 1 : ℕ) * D := hlong
    have hlt : (m + 1 : ℕ) * D < alpha * B := by simpa only [decide_eq_false_iff_not, not_le] using hlast
    linarith
  let k := Nat.find hex
  have hk : k < a.length ∧ ModelT.onlineSchedule B rule a k = true := Nat.find_spec hex
  have hfirst : ∀ j : ℕ, j < k → ModelT.onlineSchedule B rule a j = false := by
    intro j hj
    have hnot := Nat.find_min hex hj
    cases hedit : ModelT.onlineSchedule B rule a j with
    | false => rfl
    | true => exact (hnot ⟨by have := hk.1; omega, hedit⟩).elim
  have hkm : k ≤ m := by have := hk.1; simp [a, ModelT.burst] at this; omega
  have hrent : (k : ℝ) * D < alpha * B := by
    by_cases hk0 : k = 0
    · rw [hk0]
      simpa using mul_pos halpha hB
    · let n := k - 1
      have hnk : n + 1 = k := by dsimp [n]; omega
      have hn := hfirst n (by omega)
      rw [hdecision n (by omega) (by intro i hi; exact hfirst i (by omega))] at hn
      simpa only [hnk, decide_eq_false_iff_not, not_le] using hn
  refine ⟨k, hk.1, hk.2, hfirst, ?_⟩
  rw [algCost_first_burst_edit B D rule m k hkm hfirst hk.2]
  nlinarith

end PiZip
