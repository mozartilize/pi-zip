import PiZip.Sanity1
import PiZip.Proofs.T3

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

namespace T45

/-- Execute the controller directly, retaining the prefix needed by its predicate. -/
def trace (B : ℝ) (ctrl : ModelT.Predicate ℝ) :
    List ℝ → List ℝ → ModelT.State ℝ → ModelT.State ℝ
  | [], _, q => q
  | x :: xs, history, q =>
    let seen := history ++ [x]
    let edit := ctrl B seen (q.pending + x) (q.rent + q.pending + x)
    trace B ctrl xs seen (ModelT.step B x edit q)

theorem trace_append (B : ℝ) (ctrl : ModelT.Predicate ℝ)
    (a tail history : List ℝ) (q : ModelT.State ℝ) :
    trace B ctrl (a ++ tail) history q =
      trace B ctrl tail (history ++ a) (trace B ctrl a history q) := by
  induction a generalizing history q with
  | nil => simp [trace]
  | cons x xs ih => simp [trace, ih, List.append_assoc]

theorem decisions_append (B : ℝ) (ctrl : ModelT.Predicate ℝ)
    (a tail history : List ℝ) (q : ModelT.State ℝ) :
    ModelT.decisions B ctrl (a ++ tail) history q =
      ModelT.decisions B ctrl a history q ++
        ModelT.decisions B ctrl tail (history ++ a) (trace B ctrl a history q) := by
  induction a generalizing history q with
  | nil => simp [ModelT.decisions, trace]
  | cons x xs ih => simp [ModelT.decisions, trace, ih, List.append_assoc]

theorem controller_append (B : ℝ) (ctrl : ModelT.Predicate ℝ) (a : List ℝ) (x : ℝ) :
    ModelT.controller ctrl B (a ++ [x]) =
      ctrl B (a ++ [x]) ((trace B ctrl a [] ModelT.initial).pending + x)
        ((trace B ctrl a [] ModelT.initial).rent +
          (trace B ctrl a [] ModelT.initial).pending + x) := by
  simp [ModelT.controller, decisions_append, ModelT.decisions]

theorem run_append (B : ℝ) (a : List ℝ) (x : ℝ) (sigma : ModelT.Schedule) :
    ModelT.run B (a ++ [x]) sigma =
      ModelT.step B x (sigma a.length) (ModelT.run B a sigma) := by
  simp [ModelT.run, List.zipIdx_append, List.foldl_append]

theorem run_congr (B : ℝ) (a : List ℝ) (sigma tau : ModelT.Schedule)
    (h : ∀ i, i < a.length → sigma i = tau i) :
    ModelT.run B a sigma = ModelT.run B a tau := by
  unfold ModelT.run
  apply List.foldl_ext
  intro q ai hai
  rw [h ai.2 (by simpa using List.snd_lt_of_mem_zipIdx hai)]

theorem trace_run (B : ℝ) (ctrl : ModelT.Predicate ℝ) (a : List ℝ) :
    trace B ctrl a [] ModelT.initial =
      ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a) := by
  induction a using List.reverseRecOn with
  | nil => simp [trace, ModelT.run]
  | append_singleton a x ih =>
    rw [trace_append, run_append]
    have hp : ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) (a ++ [x])) =
        ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a) := by
      apply run_congr
      intro i hi
      simp [ModelT.onlineSchedule, List.take_append_of_le_length (by omega : i + 1 ≤ a.length)]
    rw [hp, ← ih]
    have ht : (a ++ [x]).take (a.length + 1) = a ++ [x] :=
      List.take_of_length_le (by simp)
    simp [trace, ModelT.onlineSchedule, ht, controller_append]

theorem online_next (B : ℝ) (ctrl : ModelT.Predicate ℝ) (a : List ℝ) (x : ℝ) :
    ModelT.onlineSchedule B (ModelT.controller ctrl) (a ++ [x]) a.length =
      ctrl B (a ++ [x])
        ((ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a)).pending + x)
        ((ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a)).rent +
          (ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a)).pending + x) := by
  have ht : (a ++ [x]).take (a.length + 1) = a ++ [x] :=
    List.take_of_length_le (by simp)
  simp [ModelT.onlineSchedule, ht, controller_append, trace_run]

/-- An edit cycle costs strictly less than its competitive credit. -/
theorem cycle_credit (B alpha rho P E : ℝ)
    (hB : 0 < B) (ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (hrho : rho < B) (hP : 0 < P) (hR : alpha * B ≤ rho + P)
    (hE : B ≤ E ∨ rho + P ≤ E) :
    rho + B < (1 + 1 / alpha) * E := by
  have hinv : 1 ≤ 1 / alpha := (le_div_iff₀ ha).2 (by simpa using ha1)
  rcases hE with hE | hE
  · have hEB : 0 < E := hB.trans_le hE
    have hprod := mul_le_mul_of_nonneg_right hinv hEB.le
    nlinarith
  · have hAE : alpha * B ≤ E := hR.trans hE
    have hdiv : B ≤ E / alpha := (le_div_iff₀ ha).2 (by nlinarith)
    have heq : (1 + 1 / alpha) * E = E + E / alpha := by ring
    rw [heq]
    linarith

theorem edits_append (B : ℝ) (rule : ModelT.Online ℝ) (a : List ℝ) (x : ℝ) :
    ModelT.edits B (a ++ [x]) rule ↔
      ModelT.edits B a rule ∨ ModelT.onlineSchedule B rule (a ++ [x]) a.length = true := by
  constructor
  · rintro ⟨i, hi, he⟩
    by_cases hia : i < a.length
    · left
      refine ⟨i, hia, ?_⟩
      simpa [ModelT.onlineSchedule,
        List.take_append_of_le_length (by omega : i + 1 ≤ a.length)] using he
    · right
      have : i = a.length := by simp at hi; omega
      simpa [this] using he
  · rintro (⟨i, hi, he⟩ | he)
    · refine ⟨i, by simp; omega, ?_⟩
      simpa [ModelT.onlineSchedule,
        List.take_append_of_le_length (by omega : i + 1 ≤ a.length)] using he
    · exact ⟨a.length, by simp, he⟩

/-- The segment credit is comparator expenditure since the last guarded edit.
If the comparator has edited, it is at least B. Otherwise its pending mass
and expenditure dominate the guarded segment's pending mass and rent. -/
def Credit (B alpha : ℝ) (q o : ModelT.State ℝ) (edited : Prop) : Prop :=
  0 ≤ q.pending ∧ 0 ≤ q.rent ∧ q.rent < B ∧ 0 ≤ o.pending ∧
  ∃ E : ℝ, 0 ≤ E ∧ E ≤ o.cost ∧
    (B ≤ E ∨ (q.pending ≤ o.pending ∧ q.rent ≤ E)) ∧
    q.cost ≤ (1 + 1 / alpha) * (o.cost - E) + q.rent ∧
    (edited → q.cost < (1 + 1 / alpha) * (o.cost - E) + q.rent)

theorem guarded_credit (B alpha : ℝ) (pred : ModelT.Predicate ℝ)
    (hB : 0 < B) (ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (a : List ℝ) (hv : ModelT.arrivalsValid a) (sigma : ModelT.Schedule) :
    Credit B alpha
      (ModelT.run B a (ModelT.onlineSchedule B (ModelT.guarded alpha pred) a))
      (ModelT.run B a sigma) (ModelT.edits B a (ModelT.guarded alpha pred)) := by
  let ctrl : ModelT.Predicate ℝ := fun B history P R =>
    decide (0 < P ∧ (B ≤ R ∨ (pred B history P R = true ∧ alpha * B ≤ R)))
  change Credit B alpha (ModelT.run B a (ModelT.onlineSchedule B (ModelT.controller ctrl) a))
    (ModelT.run B a sigma) (ModelT.edits B a (ModelT.controller ctrl))
  rw [← trace_run]
  induction a using List.reverseRecOn with
  | nil =>
    simp only [trace, ModelT.run, List.zipIdx_nil, List.foldl_nil]
    refine ⟨le_rfl, le_rfl, hB, le_rfl, 0, le_rfl, le_rfl, Or.inr ⟨le_rfl, le_rfl⟩, ?_, ?_⟩
    · simp [ModelT.initial]
    · simp [ModelT.edits]
  | append_singleton a x ih =>
    have hva : ModelT.arrivalsValid a := by intro y hy; exact hv y (by simp [hy])
    have hx : 0 ≤ x := hv x (by simp)
    obtain ⟨hqp, hqr, hqrB, hop, E, hE, hEc, hsegment, hcost, hstrict⟩ := ih hva
    let q := trace B ctrl a [] ModelT.initial
    let o := ModelT.run B a sigma
    let P := q.pending + x
    let R := q.rent + q.pending + x
    let edit := ctrl B (a ++ [x]) P R
    let pay := if sigma a.length then B else o.pending + x
    have hpay : 0 ≤ pay := by dsimp [pay]; split <;> linarith
    have hnextcost : (ModelT.step B x (sigma a.length) o).cost = o.cost + pay := by
      dsimp [pay, ModelT.step]; split <;> rfl
    have hnextpending : 0 ≤ (ModelT.step B x (sigma a.length) o).pending := by
      dsimp [ModelT.step]; split <;> simp only <;> linarith
    have hnextsegment : B ≤ E + pay ∨
        (P ≤ (ModelT.step B x (sigma a.length) o).pending ∧ R ≤ E + pay) := by
      cases he : sigma a.length with
      | true => left; simp [pay, he]; linarith
      | false =>
        rcases hsegment with hb | ⟨hp, hr⟩
        · left; exact le_trans hb (le_add_of_nonneg_right hpay)
        · right
          simp only [ModelT.step, Bool.false_eq_true, ↓reduceIte]
          dsimp [pay]; rw [he]
          constructor <;> dsimp [P, R] <;> linarith
    have hlast : ModelT.onlineSchedule B (ModelT.controller ctrl) (a ++ [x]) a.length = edit := by
      rw [online_next, ← trace_run]
    rw [trace_append, run_append]
    simp only [trace, List.nil_append]
    change Credit B alpha (ModelT.step B x edit q)
      (ModelT.step B x (sigma a.length) o) _
    simp only [ModelT.step] at hnextcost hnextpending hnextsegment
    cases he : edit with
    | true =>
      have hfire : 0 < P ∧ (B ≤ R ∨
          (pred B (a ++ [x]) P R = true ∧ alpha * B ≤ R)) := by
        simpa only [edit, ctrl, decide_eq_true_eq] using he
      have hthreshold : alpha * B ≤ R := by
        rcases hfire.2 with hb | hp
        · have hab : alpha * B ≤ B := mul_le_of_le_one_left hB.le ha1
          exact hab.trans hb
        · exact hp.2
      have hcredit : q.rent + B < (1 + 1 / alpha) * (E + pay) := by
        apply cycle_credit B alpha q.rent P (E + pay) hB ha ha1 hqrB hfire.1
          (by simpa [R, P, add_assoc] using hthreshold)
        rcases hnextsegment with h | h
        · exact Or.inl h
        · right; dsimp [R, P] at *; linarith
      have hclosed : q.cost + B < (1 + 1 / alpha) * (o.cost + pay) := by
        have hh : q.cost ≤ (1 + 1 / alpha) * (o.cost - E) + q.rent := hcost
        nlinarith [hcredit]
      simp only [ModelT.step, ↓reduceIte, Credit]
      refine ⟨le_rfl, le_rfl, hB, hnextpending, 0, le_rfl, ?_, ?_, ?_, ?_⟩
      · rw [hnextcost]; have : E ≤ o.cost := hEc; linarith
      · exact Or.inr ⟨hnextpending, le_rfl⟩
      · rw [hnextcost]; simpa using hclosed.le
      · intro _; rw [hnextcost]; simpa using hclosed
    | false =>
      have hnot : ¬ (0 < P ∧ (B ≤ R ∨
          (pred B (a ++ [x]) P R = true ∧ alpha * B ≤ R))) := by
        simpa only [edit, ctrl, decide_eq_false_iff_not] using he
      have hP : 0 ≤ P := by dsimp [P, q]; linarith
      have hR : 0 ≤ R := by dsimp [R, q]; linarith
      have hRB : R < B := by
        by_cases hp : 0 < P
        · by_contra hb; exact hnot ⟨hp, Or.inl (by linarith)⟩
        · have hp0 : P = 0 := by linarith
          have hR0 : R = q.rent := by dsimp [R, P] at *; linarith
          rw [hR0]; exact hqrB
      simp only [ModelT.step, Bool.false_eq_true, ↓reduceIte, Credit]
      refine ⟨hP, by simpa [P, R, add_assoc] using hR,
        by simpa [P, R, add_assoc] using hRB, hnextpending, E + pay, by linarith, ?_,
        by simpa [P, R, add_assoc] using hnextsegment, ?_, ?_⟩
      · rw [hnextcost]; have : E ≤ o.cost := hEc; linarith
      · rw [hnextcost]
        change q.cost + P ≤ (1 + 1 / alpha) * (o.cost + pay - (E + pay)) + (q.rent + P)
        have hh : q.cost ≤ (1 + 1 / alpha) * (o.cost - E) + q.rent := hcost
        dsimp [R, P, q] at *; nlinarith
      · intro hedited
        have hprevious : ModelT.edits B a (ModelT.controller ctrl) := by
          rcases (edits_append B (ModelT.controller ctrl) a x).1 hedited with h | h
          · exact h
          · rw [hlast, he] at h; contradiction
        have hh := hstrict hprevious
        rw [hnextcost]
        change q.cost + P < (1 + 1 / alpha) * (o.cost + pay - (E + pay)) + (q.rent + P)
        dsimp [R, P, q] at *; nlinarith

/-- Nonnegative arrivals make every comparator payment nonnegative. -/
theorem run_nonnegative (B : ℝ) (hB : 0 ≤ B) (a : List ℝ)
    (hv : ModelT.arrivalsValid a) (sigma : ModelT.Schedule) :
    0 ≤ (ModelT.run B a sigma).pending ∧ 0 ≤ (ModelT.run B a sigma).cost := by
  induction a using List.reverseRecOn with
  | nil => simp [ModelT.run, ModelT.initial]
  | append_singleton a x ih =>
    have hva : ModelT.arrivalsValid a := by intro y hy; exact hv y (by simp [hy])
    have hx : 0 ≤ x := hv x (by simp)
    obtain ⟨hp, hc⟩ := ih hva
    rw [run_append]
    cases sigma a.length <;> simp only [ModelT.step, Bool.false_eq_true, ↓reduceIte]
    · constructor <;> linarith
    · constructor <;> linarith

theorem comparator_edit_lower (B : ℝ) (hB : 0 ≤ B) (a : List ℝ)
    (hv : ModelT.arrivalsValid a) (sigma : ModelT.Schedule)
    (hedit : ∃ i < a.length, sigma i = true) : B ≤ ModelT.cost B a sigma := by
  induction a using List.reverseRecOn with
  | nil => simp at hedit
  | append_singleton a x ih =>
    have hva : ModelT.arrivalsValid a := by intro y hy; exact hv y (by simp [hy])
    have hx : 0 ≤ x := hv x (by simp)
    obtain ⟨hp, hc⟩ := run_nonnegative B hB a hva sigma
    obtain ⟨i, hi, he⟩ := hedit
    have hprev : B ≤ ModelT.cost B a sigma ∨ sigma a.length = true := by
      by_cases hia : i < a.length
      · exact Or.inl (ih hva ⟨i, hia, he⟩)
      · right; have : i = a.length := by simp at hi; omega
        simpa [this] using he
    unfold ModelT.cost at *
    rw [run_append]
    cases hs : sigma a.length <;> simp [ModelT.step]
    · rcases hprev with h | h
      · linarith
      · rw [hs] at h; contradiction
    · linarith

theorem burst_valid (D : ℝ) (hD : 0 ≤ D) (m : ℕ) :
    ModelT.arrivalsValid (ModelT.burst D m) := by
  intro x hx
  simp only [ModelT.burst, List.mem_cons, List.mem_replicate] at hx
  rcases hx with rfl | ⟨_, rfl⟩ <;> positivity

theorem burst_hold_cost (B D : ℝ) (m : ℕ) :
    ModelT.cost B (ModelT.burst D m) (fun _ => false) = (m + 1 : ℕ) * D := by
  unfold ModelT.cost
  rw [run_hold B _ _ (by simp), fold_hold_burst]

theorem burst_buy_cost (B D : ℝ) (m : ℕ) :
    ModelT.cost B (ModelT.burst D m) (fun i => decide (i = 0)) = B := by
  have hzero : ((List.replicate m (0 : ℝ)).zipIdx 1).foldl
      (fun q ai => ModelT.step B ai.1 (decide (ai.2 = 0)) q)
      (⟨0, 0, B⟩ : ModelT.State ℝ) = ⟨0, 0, B⟩ := by
    calc
      _ = ((List.replicate m (0 : ℝ)).zipIdx 1).foldl
          (fun q ai => ModelT.step B ai.1 false q) ⟨0, 0, B⟩ := by
        apply List.foldl_ext
        intro q ai hai
        have hi := List.le_snd_of_mem_zipIdx hai
        have hn : ai.2 ≠ 0 := by omega
        simp [hn]
      _ = (List.replicate m (0 : ℝ)).foldl
          (fun q x => ModelT.step B x false q) ⟨0, 0, B⟩ := by
        simpa only [List.zipIdx_map_fst] using
          (List.foldl_map (f := Prod.fst) (g := fun q x => ModelT.step B x false q)
            (l := (List.replicate m (0 : ℝ)).zipIdx 1)
            (init := (⟨0, 0, B⟩ : ModelT.State ℝ))).symm
      _ = _ := by simpa using fold_hold_zeros B 0 0 B m
  unfold ModelT.cost ModelT.run ModelT.burst
  simp only [List.zipIdx_cons, List.foldl_cons, ModelT.step, ModelT.initial,
    decide_true, ↓reduceIte, zero_add]
  change _ = B
  have hc := congrArg ModelT.State.cost hzero
  simpa only [ModelT.step] using hc

/-- A burst's hindsight cost is min(B, (m+1)D), attained by hold or buy now. -/
theorem burst_optimal (B D : ℝ) (hB : 0 < B) (hD : 0 < D) (m : ℕ) :
    ∃ sigma : ModelT.Schedule, ModelT.Optimal B (ModelT.burst D m) sigma ∧
      ModelT.cost B (ModelT.burst D m) sigma = min B ((m + 1 : ℕ) * D) := by
  have hlower (tau : ModelT.Schedule) :
      min B ((m + 1 : ℕ) * D) ≤ ModelT.cost B (ModelT.burst D m) tau := by
    by_cases he : ∃ i < (ModelT.burst D m).length, tau i = true
    · exact (min_le_left _ _).trans (comparator_edit_lower B hB.le _ (burst_valid D hD.le m) tau he)
    · have hh : ∀ i, i < (ModelT.burst D m).length → tau i = false := by
        intro i hi
        cases hs : tau i
        · rfl
        · exact (he ⟨i, hi, hs⟩).elim
      unfold ModelT.cost
      rw [run_hold B _ tau hh, fold_hold_burst]
      exact min_le_right _ _
  by_cases h : (m + 1 : ℕ) * D ≤ B
  · refine ⟨fun _ => false, ?_, ?_⟩
    · intro tau; rw [burst_hold_cost]; have ht := hlower tau
      rw [min_eq_right h] at ht; exact ht
    · rw [burst_hold_cost, min_eq_right h]
  · refine ⟨fun i => decide (i = 0), ?_, ?_⟩
    · intro tau; rw [burst_buy_cost]; have ht := hlower tau
      rw [min_eq_left (le_of_not_ge h)] at ht; exact ht
    · rw [burst_buy_cost, min_eq_left (le_of_not_ge h)]

theorem burst_opt_positive (B D : ℝ) (hB : 0 < B) (hD : 0 < D) (m : ℕ) :
    0 < min B ((m + 1 : ℕ) * D) := by
  apply lt_min hB
  have : (0 : ℝ) < (m + 1 : ℕ) := by positivity
  positivity

theorem burst_no_edits_cost (B D : ℝ) (rule : ModelT.Online ℝ) (m : ℕ)
    (h : ∀ i, i < (ModelT.burst D m).length →
      ModelT.onlineSchedule B rule (ModelT.burst D m) i = false) :
    ModelT.algCost B (ModelT.burst D m) rule = (m + 1 : ℕ) * D := by
  unfold ModelT.algCost ModelT.cost
  rw [run_hold B _ _ h, fold_hold_burst]

/-- The source's two cases for a burst stopped on ALG's first edit. -/
theorem deterministic_burst_bound (B D eps : ℝ) (k : ℕ)
    (_hB : 0 < B) (hD : 0 < D) (_hDB : D ≤ B) (heps : 0 < eps)
    (hsmall : D ≤ eps * B) :
    (2 - eps) * min B ((k + 1 : ℕ) * D) ≤ (k : ℝ) * D + B := by
  have hk : (k + 1 : ℕ) * D = (k : ℝ) * D + D := by push_cast; ring
  have hkD : 0 ≤ (k : ℝ) * D := by positivity
  by_cases hcase : (k + 1 : ℕ) * D ≤ B
  · rw [min_eq_right hcase]
    by_cases he1 : eps ≤ 1
    · have hp := mul_nonneg (show 0 ≤ 1 - eps by linarith)
        (show 0 ≤ B - (k + 1 : ℕ) * D by linarith)
      rw [hk] at *; nlinarith
    · rw [hk]; nlinarith
  · rw [min_eq_left (le_of_not_ge hcase)]
    rw [hk] at hcase; nlinarith

/-- Increasing B makes the bounded-estimate first-request adversary arbitrarily bad. -/
theorem early_price (G c : ℝ) (hG : 0 < G) (hc : 0 < c) :
    ∃ B : ℝ, 0 < B ∧ Real.sqrt (2 * G * B) + 1 < B ∧
      c * (Real.sqrt (2 * G * B) + 1) < B := by
  let t := max c 1 + 1
  let B := 8 * G * t ^ 2 + 4 * t
  let s := Real.sqrt (2 * G * B)
  have ht : 1 < t := by dsimp [t]; have := le_max_right c (1 : ℝ); linarith
  have hct : c < t := by dsimp [t]; have := le_max_left c (1 : ℝ); linarith
  have hB : 0 < B := by dsimp [B]; positivity
  have hs : s ^ 2 = 2 * G * B := Real.sq_sqrt (by positivity)
  have hs0 : 0 ≤ s := Real.sqrt_nonneg _
  have hsq : (2 * t * s) ^ 2 = 8 * G * t ^ 2 * B := by
    calc
      _ = 4 * t ^ 2 * s ^ 2 := by ring
      _ = _ := by rw [hs]; ring
  have hgap : 0 < (B - 8 * G * t ^ 2) * B := by
    apply mul_pos _ hB
    dsimp [B]; nlinarith
  have hbound : 2 * t * s < B := by nlinarith [hsq, hgap]
  have hlarge : 2 * t < B := by
    dsimp [B]
    have := mul_pos hG (sq_pos_of_pos (show 0 < t by linarith))
    nlinarith
  have htd : t * (s + 1) < B := by nlinarith
  have hprice : s + 1 < B := by nlinarith
  refine ⟨B, hB, hprice, ?_⟩
  have := mul_lt_mul_of_pos_right hct (show 0 < s + 1 by linarith)
  exact this.trans htd

/-- On a positive burst below every LAW threshold, reconstructed decisions all hold. -/
theorem law_late_holds (estimate : ModelT.Estimate ℝ) (B G D : ℝ)
    (hB : 0 < B) (hD : 0 < D) (hbelow : D ^ 2 < 2 * G * B)
    (hest : ∀ a : List ℝ, a ≠ [] → ModelT.arrivalsValid a → G ≤ estimate B a)
    (m : ℕ) :
    ModelT.decisions B
      (fun B history P _ => decide (P ^ 2 ≥ 2 * estimate B history * B))
      (ModelT.burst D m) [] ModelT.initial =
      List.replicate (ModelT.burst D m).length false := by
  induction m with
  | zero =>
    have hb := mul_le_mul_of_nonneg_right (hest [D] (by simp) (burst_valid D hD.le 0)) hB.le
    have hn : ¬ D ^ 2 ≥ 2 * estimate B [D] * B := by nlinarith
    simp [ModelT.burst, ModelT.decisions, ModelT.initial, hn]
  | succ m ih =>
    have ha : ModelT.burst D (m + 1) = ModelT.burst D m ++ [0] := by
      simp [ModelT.burst, List.replicate_add]
    rw [ha, decisions_hold_append B _ (ModelT.burst D m) [0] [] ModelT.initial ih,
      fold_hold_burst]
    have hb := mul_le_mul_of_nonneg_right
      (hest (ModelT.burst D (m + 1)) (by simp [ModelT.burst]) (burst_valid D hD.le _)) hB.le
    have hn : ¬ D ^ 2 ≥ 2 * estimate B (ModelT.burst D (m + 1)) * B := by nlinarith
    simp [ModelT.burst, List.replicate_add] at hn
    simp [ModelT.decisions, hn, ModelT.burst, List.replicate_add]

theorem law_late_schedule (estimate : ModelT.Estimate ℝ) (B G D : ℝ)
    (hB : 0 < B) (hD : 0 < D) (hbelow : D ^ 2 < 2 * G * B)
    (hest : ∀ a : List ℝ, a ≠ [] → ModelT.arrivalsValid a → G ≤ estimate B a)
    (m i : ℕ) (hi : i < (ModelT.burst D m).length) :
    ModelT.onlineSchedule B (ModelT.law estimate) (ModelT.burst D m) i = false := by
  have him : i ≤ m := by simp [ModelT.burst] at hi; omega
  have ht : (ModelT.burst D m).take (i + 1) = ModelT.burst D i := by
    simp [ModelT.burst, List.take_succ_cons, Nat.min_eq_left him]
  simp only [ModelT.onlineSchedule, ht, ModelT.law, ModelT.controller]
  rw [law_late_holds estimate B G D hB hD hbelow hest i]
  simp [ModelT.burst, List.replicate_add]

/-- Before the guard threshold, neither branch can edit, irrespective of LAW. -/
theorem burst_guard_first (B D alpha : ℝ) (estimate : ModelT.Estimate ℝ) (m : ℕ)
    (hB : 0 < B) (hD : 0 < D) (_ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (hthreshold : alpha * B = (m + 1 : ℕ) * D)
    (hlaw : D ^ 2 ≥ 2 * estimate B (ModelT.burst D m) * B) :
    (∀ i, i < m → ModelT.onlineSchedule B
      (ModelT.guarded alpha (ModelT.lawPredicate estimate)) (ModelT.burst D m) i = false) ∧
    ModelT.onlineSchedule B (ModelT.guarded alpha (ModelT.lawPredicate estimate))
      (ModelT.burst D m) m = true := by
  let rule := ModelT.guarded alpha (ModelT.lawPredicate estimate)
  have hhold : ∀ i, i < m → ModelT.onlineSchedule B rule (ModelT.burst D m) i = false := by
    intro i
    induction i using Nat.strong_induction_on with
    | h i ih =>
      intro hi
      rw [guarded_burst_decision B D alpha estimate m i (by omega) hD
        (by intro j hj; exact ih j hj (by omega))]
      have hic : (i + 1 : ℕ) * D < alpha * B := by
        rw [hthreshold]
        apply mul_lt_mul_of_pos_right _ hD
        exact_mod_cast (show i + 1 < m + 1 by omega)
      have hab : alpha * B ≤ B := mul_le_of_le_one_left hB.le ha1
      simp only [decide_eq_false_iff_not, not_or, not_and]
      constructor
      · linarith
      · intro _; linarith
  refine ⟨hhold, ?_⟩
  rw [guarded_burst_decision B D alpha estimate m m le_rfl hD hhold]
  have ht : (ModelT.burst D m).take (m + 1) = ModelT.burst D m :=
    List.take_of_length_le (by simp [ModelT.burst])
  simp [ht, hlaw, hthreshold]

theorem fixed_lower (alpha G eps M : ℝ) (ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (hG : 0 < G) (heps : 0 < eps) (hM : 0 < M) :
    ∃ (B D : ℝ) (m : ℕ) (sigma : ModelT.Schedule), 0 < B ∧ M * G < B ∧ 0 < D ∧
      ModelT.Optimal B (ModelT.burst D m) sigma ∧ 0 < ModelT.cost B (ModelT.burst D m) sigma ∧
      (1 + 1 / alpha - eps) * ModelT.cost B (ModelT.burst D m) sigma ≤
        ModelT.algCost B (ModelT.burst D m)
          (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.fixed G))) := by
  obtain ⟨m, hm⟩ := exists_nat_gt (max (1 / eps) (max M 1))
  let n : ℝ := (m + 1 : ℕ)
  have hn : 1 < n := by
    have := (le_max_right (1 / eps) (max M 1)).trans_lt hm
    have := (le_max_right M (1 : ℝ)).trans_lt this
    dsimp [n]; push_cast; linarith
  have hnM : M < n := by
    have := (le_max_left M (1 : ℝ)).trans_lt
      ((le_max_right (1 / eps) (max M 1)).trans_lt hm)
    dsimp [n]; push_cast; linarith
  have hneps : 1 ≤ eps * n := by
    have hh := (le_max_left (1 / eps) (max M 1)).trans_lt hm
    have := (div_lt_iff₀ heps).1 hh
    dsimp [n]; push_cast; nlinarith
  let D := 2 * G * n / alpha
  let B := 2 * G * n ^ 2 / alpha ^ 2
  have hD : 0 < D := by dsimp [D]; positivity
  have hB : 0 < B := by dsimp [B]; positivity
  have hthreshold : alpha * B = (m + 1 : ℕ) * D := by
    dsimp [B, D, n]; field_simp
  have hlaw : D ^ 2 = 2 * G * B := by dsimp [B, D]; field_simp
  have hprice : M * G < B := by
    have ha2 : alpha ^ 2 ≤ 1 := by nlinarith
    have hM2 : M < 2 * n ^ 2 := by nlinarith
    have hbig : M * alpha ^ 2 < 2 * n ^ 2 := by
      have := mul_le_mul_of_nonneg_left ha2 hM.le; nlinarith
    dsimp [B]
    apply (lt_div_iff₀ (sq_pos_of_pos ha)).2
    nlinarith [mul_pos hG (show 0 < 2 * n ^ 2 - M * alpha ^ 2 by linarith)]
  obtain ⟨hfirst, hedit⟩ := burst_guard_first B D alpha (ModelT.fixed G) m hB hD ha ha1
    hthreshold (by simpa [ModelT.fixed] using hlaw.ge)
  obtain ⟨sigma, hopt, hcost⟩ := burst_optimal B D hB hD m
  have hoptcost : ModelT.cost B (ModelT.burst D m) sigma = alpha * B := by
    rw [hcost, ← hthreshold, min_eq_right (mul_le_of_le_one_left hB.le ha1)]
  refine ⟨B, D, m, sigma, hB, hprice, hD, hopt, ?_, ?_⟩
  · rw [hoptcost]; positivity
  · have hc := algCost_first_burst_edit B D
      (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.fixed G))) m m le_rfl hfirst hedit
    have ht : (ModelT.burst D m).take (m + 1) = ModelT.burst D m :=
      List.take_of_length_le (by simp [ModelT.burst])
    rw [ht] at hc
    rw [hc, hoptcost]
    have hfrac : (1 + 1 / alpha - eps) * (alpha * B) =
        alpha * B + B - eps * (alpha * B) := by field_simp
    rw [hfrac]
    have hsmall : D ≤ eps * (alpha * B) := by
      rw [hthreshold]
      have := mul_le_mul_of_nonneg_right hneps hD.le
      dsimp [n] at this; nlinarith
    push_cast at hthreshold; nlinarith

/-- In an all-hold run the cost and accumulated rent coincide. -/
theorem hold_cost_rent (B : ℝ) (a : List ℝ) (sigma : ModelT.Schedule)
    (h : ∀ i, i < a.length → sigma i = false) :
    (ModelT.run B a sigma).cost = (ModelT.run B a sigma).rent := by
  induction a using List.reverseRecOn with
  | nil => simp [ModelT.run, ModelT.initial]
  | append_singleton a x ih =>
    have hp : ∀ i, i < a.length → sigma i = false := by intro i hi; exact h i (by simp; omega)
    have he := h a.length (by simp)
    rw [run_append]
    simp [ModelT.step, he, ih hp]

theorem guarded_noedit_optimal (B alpha : ℝ) (pred : ModelT.Predicate ℝ)
    (a : List ℝ) (hB : 0 < B) (ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (hv : ModelT.arrivalsValid a)
    (hne : ¬ ModelT.edits B a (ModelT.guarded alpha pred)) (sigma : ModelT.Schedule) :
    ModelT.algCost B a (ModelT.guarded alpha pred) ≤ ModelT.cost B a sigma := by
  have hh : ∀ i, i < a.length →
      ModelT.onlineSchedule B (ModelT.guarded alpha pred) a i = false := by
    intro i hi
    cases hs : ModelT.onlineSchedule B (ModelT.guarded alpha pred) a i with
    | false => rfl
    | true => exact (hne ⟨i, hi, hs⟩).elim
  have hr := (guarded_credit B alpha pred hB ha ha1 a hv sigma).2.2.1
  have hc := hold_cost_rent B a _ hh
  by_cases he : ∃ i < a.length, sigma i = true
  · have hl := comparator_edit_lower B hB.le a hv sigma he
    unfold ModelT.algCost ModelT.cost at *
    linarith
  · have hs : ∀ i, i < a.length → sigma i = false := by
      intro i hi
      cases heq : sigma i with
      | false => rfl
      | true => exact (he ⟨i, hi, heq⟩).elim
    have heq := run_congr B a (ModelT.onlineSchedule B (ModelT.guarded alpha pred) a) sigma
      (by intro i hi; rw [hh i hi, hs i hi])
    exact le_of_eq (congrArg ModelT.State.cost heq)

/-- A zero arrival multiplies the removable-arrival EWMA by 9/10. -/
theorem ewma_zero_fold (g : ℝ) (m : ℕ) :
    (List.replicate m (0 : ℝ)).foldl (fun g a => (9 / 10) * g + (1 / 10) * a) g =
      (9 / 10 : ℝ) ^ m * g := by
  induction m generalizing g with
  | zero => simp
  | succ m ih =>
    simp only [List.replicate_succ, List.foldl_cons, mul_zero, add_zero]
    rw [ih, pow_succ]
    ring

theorem ewma_burst (g D : ℝ) (m : ℕ) (B : ℝ) :
    ModelT.ewma g B (ModelT.burst D m) =
      (9 / 10 : ℝ) ^ m * ((9 / 10) * g + (1 / 10) * D) := by
  unfold ModelT.ewma ModelT.burst
  simp only [List.foldl_cons]
  exact ewma_zero_fold _ m

/-- An elementary polynomial envelope for the geometric decay, avoiding asymptotics. -/
theorem ewma_envelope (m : ℕ) :
    (9 / 10 : ℝ) ^ m * ((m : ℝ) + 1) ^ 2 ≤ 500 := by
  induction m with
  | zero => norm_num
  | succ m ih =>
    have hp : 0 ≤ (9 / 10 : ℝ) ^ m := by positivity
    have hstep : (9 / 10 : ℝ) ^ (m + 1) * ((m : ℝ) + 2) ^ 2 =
        (9 / 10 : ℝ) ^ m * ((9 / 10) * ((m : ℝ) + 2) ^ 2) := by rw [pow_succ]; ring
    push_cast
    rw [show (m : ℝ) + 1 + 1 = (m : ℝ) + 2 by ring, hstep]
    by_cases hm : 20 ≤ m
    · have hmr : (20 : ℝ) ≤ m := by exact_mod_cast hm
      have hratio : (9 / 10 : ℝ) * ((m : ℝ) + 2) ^ 2 ≤ ((m : ℝ) + 1) ^ 2 := by
        nlinarith [sq_nonneg ((m : ℝ) - 20)]
      exact (mul_le_mul_of_nonneg_left hratio hp).trans ih
    · have hmr : (m : ℝ) ≤ 19 := by exact_mod_cast (show m ≤ 19 by omega)
      have hm0 : (0 : ℝ) ≤ m := by positivity
      have hpow : (9 / 10 : ℝ) ^ m ≤ 1 := pow_le_one₀ (by norm_num) (by norm_num)
      have hs : 0 ≤ (9 / 10 : ℝ) * ((m : ℝ) + 2) ^ 2 := by positivity
      have hmul := mul_le_mul_of_nonneg_right hpow hs
      nlinarith [sq_nonneg ((m : ℝ) - 19)]

theorem ewma_lower (alpha g0 eps M : ℝ) (ha : 0 < alpha) (ha1 : alpha ≤ 1)
    (hg : 0 ≤ g0) (heps : 0 < eps) (hM : 0 < M) :
    ∃ (B : ℝ) (m : ℕ) (sigma : ModelT.Schedule), 0 < B ∧ M < B ∧
      ModelT.Optimal B (ModelT.burst 1 m) sigma ∧ 0 < ModelT.cost B (ModelT.burst 1 m) sigma ∧
      (1 + 1 / alpha - eps) * ModelT.cost B (ModelT.burst 1 m) sigma ≤
        ModelT.algCost B (ModelT.burst 1 m)
          (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.ewma g0))) := by
  let C := (9 / 10 : ℝ) * g0 + 1 / 10
  have hC : 0 < C := by dsimp [C]; linarith
  obtain ⟨m, hm⟩ := exists_nat_gt (max M (max (1 / eps) (max (1000 * C / alpha) 1)))
  let n : ℝ := (m + 1 : ℕ)
  let B := n / alpha
  have hn : 0 < n := by dsimp [n]; positivity
  have hnM : M < n := by
    have hh := (le_max_left M _).trans_lt hm
    dsimp [n]; push_cast; linarith
  have hneps : 1 ≤ eps * n := by
    have hh := (le_max_left (1 / eps) _).trans_lt ((le_max_right M _).trans_lt hm)
    have hh' := (div_lt_iff₀ heps).1 hh
    dsimp [n]; push_cast; nlinarith
  have hlarge : 1000 * C < alpha * n := by
    have hh := (le_max_left (1000 * C / alpha) (1 : ℝ)).trans_lt
      ((le_max_right (1 / eps) _).trans_lt ((le_max_right M _).trans_lt hm))
    have hh' := (div_lt_iff₀ ha).1 hh
    dsimp [n]; push_cast; nlinarith
  have hB : 0 < B := by dsimp [B]; positivity
  have hprice : M < B := by
    dsimp [B]
    apply (lt_div_iff₀ ha).2
    have := mul_le_of_le_one_right hM.le ha1
    linarith
  have hthreshold : alpha * B = (m + 1 : ℕ) * (1 : ℝ) := by dsimp [B, n]; field_simp
  let e := ModelT.ewma g0 B (ModelT.burst 1 m)
  have he : e = (9 / 10 : ℝ) ^ m * C := by simpa [e, C] using ewma_burst g0 1 m B
  have he0 : 0 ≤ e := by rw [he]; positivity
  have henv : e * n ^ 2 ≤ 500 * C := by
    have hh := mul_le_mul_of_nonneg_right (ewma_envelope m) hC.le
    rw [he]
    dsimp [n]; push_cast
    nlinarith [hh]
  have hnprice : 2 * e * n < alpha := by nlinarith [henv, hlarge]
  have hlaw : (1 : ℝ) ^ 2 ≥ 2 * ModelT.ewma g0 B (ModelT.burst 1 m) * B := by
    have hh : 2 * e * (n / alpha) < 1 := by
      have hh : 2 * e * n / alpha < 1 := (div_lt_iff₀ ha).2 (by simpa using hnprice)
      convert hh using 1; ring
    dsimp [B] at *
    change (1 : ℝ) ^ 2 ≥ 2 * e * (n / alpha)
    norm_num; exact hh.le
  obtain ⟨hfirst, hedit⟩ := burst_guard_first B 1 alpha (ModelT.ewma g0) m hB (by norm_num)
    ha ha1 hthreshold hlaw
  obtain ⟨sigma, hopt, hcost⟩ := burst_optimal B 1 hB (by norm_num) m
  have hoptcost : ModelT.cost B (ModelT.burst 1 m) sigma = n := by
    rw [hcost, ← hthreshold, min_eq_right (mul_le_of_le_one_left hB.le ha1), hthreshold]
    simp [n]
  refine ⟨B, m, sigma, hB, hprice, hopt, ?_, ?_⟩
  · rw [hoptcost]; exact hn
  · have hc := algCost_first_burst_edit B 1
      (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.ewma g0))) m m le_rfl hfirst hedit
    have ht : (ModelT.burst (1 : ℝ) m).take (m + 1) = ModelT.burst 1 m :=
      List.take_of_length_le (by simp [ModelT.burst])
    rw [ht] at hc
    rw [hoptcost, hc]
    have hfrac : (1 + 1 / alpha - eps) * n = n + B - eps * n := by
      dsimp [B]; ring
    rw [hfrac]
    dsimp [n] at hneps ⊢; push_cast at hneps ⊢; nlinarith

end T45

/-- The guarded cycle argument, against every schedule on the same instance. -/
theorem T5_i_proof : PiZip.T5_i := by
  intro B alpha pred a hB ha ha1 hv sigma
  obtain ⟨_, hR, hRB, _, E, hE, _, hsegment, hc, hs⟩ :=
    T45.guarded_credit B alpha pred hB ha ha1 a hv sigma
  let q := ModelT.run B a (ModelT.onlineSchedule B (ModelT.guarded alpha pred) a)
  let o := ModelT.run B a sigma
  have hRE : q.rent ≤ E := by
    rcases hsegment with h | h
    · exact hRB.le.trans h
    · exact h.2
  have hinv : 0 ≤ 1 / alpha := by positivity
  have hprod := mul_nonneg hinv hE
  have hreserve : q.rent ≤ (1 + 1 / alpha) * E := by nlinarith
  change q.cost ≤ (1 + 1 / alpha) * o.cost ∧
    (ModelT.edits B a (ModelT.guarded alpha pred) → q.cost < (1 + 1 / alpha) * o.cost)
  constructor
  · nlinarith [hc]
  · intro he; have := hs he; nlinarith

/-- BAL is the guarded controller with the false predicate and alpha=1. -/
theorem T4_i_proof : PiZip.T4_i := by
  intro B a hB hv sigma
  have heq : ModelT.guarded (1 : ℝ) (fun _ _ _ _ => false) = ModelT.bal := by
    unfold ModelT.guarded ModelT.bal
    congr 1
    funext B history P R
    simp
  have h := T5_i_proof B 1 (fun _ _ _ _ => false) a hB (by norm_num) (by norm_num) hv sigma
  norm_num [heq] at h
  exact h

/-- Stop the deterministic online rule at its first edit, or after enough rent. -/
theorem T4_ii_proof : PiZip.T4_ii := by
  classical
  intro ALG B eps hB heps
  let D := min eps 1 * B / 2
  have hD : 0 < D := by dsimp [D]; positivity
  have hDB : D ≤ B := by
    have := min_le_right eps (1 : ℝ)
    dsimp [D]; nlinarith
  have hsmall : D ≤ eps * B := by
    have hmin := min_le_left eps (1 : ℝ)
    have hp := mul_le_mul_of_nonneg_right hmin hB.le
    dsimp [D]; nlinarith
  obtain ⟨m, hm⟩ := exists_nat_gt ((2 - eps) * B / D)
  have hlong : (2 - eps) * B < (m : ℝ) * D := (div_lt_iff₀ hD).1 hm
  let a := ModelT.burst D m
  by_cases he : ∃ i < a.length, ModelT.onlineSchedule B ALG a i = true
  · let k := Nat.find he
    have hk : k < a.length ∧ ModelT.onlineSchedule B ALG a k = true := Nat.find_spec he
    have hfirst : ∀ i, i < k → ModelT.onlineSchedule B ALG a i = false := by
      intro i hi
      cases hs : ModelT.onlineSchedule B ALG a i with
      | false => rfl
      | true => exact (Nat.find_min he hi ⟨by have := hk.1; omega, hs⟩).elim
    have hkm : k ≤ m := by have := hk.1; simp [a, ModelT.burst] at this; omega
    obtain ⟨sigma, hopt, hcost⟩ := T45.burst_optimal B D hB hD k
    refine ⟨ModelT.burst D k, sigma, T45.burst_valid D hD.le k, hopt, ?_, ?_⟩
    · rw [hcost]; exact T45.burst_opt_positive B D hB hD k
    · have htake : a.take (k + 1) = ModelT.burst D k := by
        simp [a, ModelT.burst, List.take_succ_cons, Nat.min_eq_left hkm]
      have hc := algCost_first_burst_edit B D ALG m k hkm hfirst hk.2
      rw [show (ModelT.burst D m).take (k + 1) = ModelT.burst D k from htake] at hc
      rw [hcost, hc]
      exact T45.deterministic_burst_bound B D eps k hB hD hDB heps hsmall
  · have hhold : ∀ i, i < a.length → ModelT.onlineSchedule B ALG a i = false := by
      intro i hi
      cases hs : ModelT.onlineSchedule B ALG a i with
      | false => rfl
      | true => exact (he ⟨i, hi, hs⟩).elim
    obtain ⟨sigma, hopt, hcost⟩ := T45.burst_optimal B D hB hD m
    refine ⟨a, sigma, T45.burst_valid D hD.le m, hopt, ?_, ?_⟩
    · rw [hcost]; exact T45.burst_opt_positive B D hB hD m
    · rw [hcost, T45.burst_no_edits_cost B D ALG m hhold]
      by_cases he2 : 0 ≤ 2 - eps
      · have hp := mul_le_mul_of_nonneg_left (min_le_left B ((m + 1 : ℕ) * D)) he2
        push_cast at hp ⊢; nlinarith
      · have hp := mul_nonpos_of_nonpos_of_nonneg (le_of_not_ge he2)
          (T45.burst_opt_positive B D hB hD m).le
        exact hp.trans (by positivity)

/-- Both LAW adversaries, including the quantitative first-request bound. -/
theorem T4_iv_proof : PiZip.T4_iv := by
  constructor
  · intro estimate Ghat hG _hnonneg hbound
    constructor
    · intro B hB hprice
      exact law_early_quantitative estimate Ghat B hG hB
        (fun D hD => hbound B D hB hD) hprice
    · intro c hc
      obtain ⟨B, hB, hprice, hratio⟩ := T45.early_price Ghat c hG hc
      obtain ⟨D, hD, hle, hDB, hopt, hhold, hlaw, _⟩ :=
        law_early_quantitative estimate Ghat B hG hB
          (fun D hD => hbound B D hB hD) hprice
      refine ⟨B, D, hB, hD, hDB, hopt, ?_⟩
      rw [hhold, hlaw]
      exact (mul_le_mul_of_nonneg_left hle hc.le).trans_lt hratio
  · intro estimate B G hB hG hest
    let D := Real.sqrt (2 * G * B) / 2
    have hD : 0 < D := by dsimp [D]; positivity
    have hs := Real.sq_sqrt (show 0 ≤ 2 * G * B by positivity)
    have hbelow : D ^ 2 < 2 * G * B := by
      dsimp [D]; nlinarith [mul_pos hG hB]
    have hholds := T45.law_late_schedule estimate B G D hB hD hbelow hest
    refine ⟨D, hD, hbelow, ?_, ?_⟩
    · intro m
      rintro ⟨i, hi, he⟩
      rw [hholds m i hi] at he; contradiction
    · intro c hc
      obtain ⟨m, hm⟩ := exists_nat_gt (c * B / D)
      obtain ⟨sigma, hopt, hcost⟩ := T45.burst_optimal B D hB hD m
      refine ⟨m, sigma, hopt, ?_, ?_⟩
      · rw [hcost]; exact T45.burst_opt_positive B D hB hD m
      · rw [hcost, T45.burst_no_edits_cost B D (ModelT.law estimate) m (hholds m)]
        have hl := (div_lt_iff₀ hD).1 hm
        have hp := mul_le_mul_of_nonneg_left (min_le_left B ((m + 1 : ℕ) * D)) hc.le
        push_cast at hp ⊢; nlinarith

/-- Steady-growth LAW can only fire after BAL's ledger crossing. -/
theorem T5_iv_proof : PiZip.T5_iv := by
  intro B g G alpha hB hg hgG _ha _ha1
  obtain ⟨L, hL⟩ := T3.optimal_exists B g hB hg
  refine ⟨L, hL, T3.optimal_rate B g hB hg hL, ?_⟩
  have hguard (N i : ℕ) (hi : i < N) :
      ModelT.onlineSchedule B
        (ModelT.guarded alpha (ModelT.lawPredicate (ModelT.fixed G))) (EOQ.arrivals g N) i =
        ModelT.periodic L i := by
    apply T3.controller_periodic B g L hL.1 _ _ N i hi
    intro history r hr
    let P := g * ((r : ℝ) + 1)
    let R := g * ((r : ℝ) + 1) * ((r : ℝ) + 2) / 2
    have hP : 0 < P := by dsimp [P]; positivity
    have hR : 0 ≤ R := by dsimp [R]; positivity
    have hG : 0 < G := hg.trans_le hgG
    have htri : P ^ 2 ≤ 2 * g * R := by
      have hid : 2 * g * R - P ^ 2 = g ^ 2 * ((r : ℝ) + 1) := by dsimp [P, R]; ring
      have : 0 ≤ g ^ 2 * ((r : ℝ) + 1) := by positivity
      linarith
    have hGR := mul_nonneg (show 0 ≤ G - g by linarith) hR
    have hlaw : P ^ 2 ≥ 2 * G * B → B ≤ R := by
      intro hl
      nlinarith
    have hcross : B ≤ R ↔ r + 1 = L := by
      constructor
      · intro hb
        by_contra hn
        have hh := hL.2.2 (r + 1) (by omega) (by omega)
        push_cast at hh
        dsimp [R] at hb; nlinarith
      · intro he
        have heR : (r : ℝ) + 1 = (L : ℝ) := by exact_mod_cast he
        have hh := hL.2.1
        dsimp [R]
        rw [heR, show (r : ℝ) + 2 = (L : ℝ) + 1 by linarith]
        linarith
    change decide (0 < P ∧ (B ≤ R ∨
      (decide (P ^ 2 ≥ 2 * G * B) = true ∧ alpha * B ≤ R))) = decide (r + 1 = L)
    simp only [hP, true_and, decide_eq_true_eq]
    congr 1
    apply propext
    constructor
    · rintro (h | ⟨h, _⟩)
      · exact hcross.1 h
      · exact hcross.1 (hlaw h)
    · intro h; exact Or.inl (hcross.2 h)
  intro N i hi
  have hb := T3.bal_periodic B g hB hg hL N i hi
  exact ⟨(hguard N i hi).trans hb.symm, hb⟩

/-- The fixed and removable-EWMA adversaries attain the guarded upper bound. -/
theorem T5_ii_proof : PiZip.T5_ii := by
  refine ⟨T45.fixed_lower, T45.ewma_lower, ?_, ?_⟩
  · intro B G P R alpha hB hG hP ha _ha1 hPR hlaw hR
    have hPB : P < alpha * B := hPR.trans_lt hR
    have hsq : P ^ 2 < (alpha * B) ^ 2 := by
      nlinarith [mul_pos (show 0 < alpha * B - P by linarith)
        (show 0 < alpha * B + P by positivity)]
    apply (div_lt_iff₀ (sq_pos_of_pos ha)).2
    nlinarith
  · intro B alpha a hB ha ha1 hv
    have heq : ModelT.guarded alpha (fun _ _ _ _ => false) = ModelT.bal := by
      unfold ModelT.guarded ModelT.bal
      congr 1
      funext B history P R
      simp
    constructor
    · intro i _hi; rw [heq]
    · intro sigma
      have hbal := T4_i_proof B a hB hv sigma
      rw [heq]
      refine ⟨hbal.1, hbal.2, ?_⟩
      intro hpositive
      by_cases he : ModelT.edits B a ModelT.bal
      · exact hbal.2 he
      · have hne : ¬ ModelT.edits B a (ModelT.guarded alpha (fun _ _ _ _ => false)) := by
          simpa [heq] using he
        have hhold := T45.guarded_noedit_optimal B alpha (fun _ _ _ _ => false)
          a hB ha ha1 hv hne sigma
        rw [heq] at hhold
        linarith

end PiZip
