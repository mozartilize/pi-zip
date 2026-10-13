import PiZip.Statements.R1

namespace PiZip
namespace T3

/-- Rent in a final segment of n held requests. -/
noncomputable def rent (g : ℝ) (n : ℕ) : ℝ := g * (n : ℝ) * ((n : ℝ) + 1) / 2

/-- The finite-model run adds one request at the end of the observed history. -/
theorem run_succ (B g : ℝ) (n : ℕ) (sigma : ModelT.Schedule) :
    ModelT.run B (EOQ.arrivals g (n + 1)) sigma =
      ModelT.step B g (sigma n) (ModelT.run B (EOQ.arrivals g n) sigma) := by
  unfold EOQ.arrivals ModelT.run
  rw [List.replicate_add, List.zipIdx_append, List.foldl_append]
  simp [List.zipIdx, List.length_replicate]

/-- The AM-GM step, written without division by the cycle length. -/
theorem fluid_cycle_lower (B g : ℝ) (hB : 0 < B) (hg : 0 < g) (j : ℕ) :
    (j : ℝ) * EOQ.fluidBound B g ≤ EOQ.cycleCost B g j := by
  have hs := Real.sq_sqrt (show 0 ≤ 2 * g * B by positivity)
  have square := sq_nonneg (Real.sqrt (2 * g * B) - g * (j : ℝ))
  unfold EOQ.fluidBound EOQ.cycleCost
  nlinarith

theorem cycle_rate (B g : ℝ) (j : ℕ) (hj : 0 < j) :
    EOQ.cycleCost B g j = (j : ℝ) * EOQ.rate B g j := by
  have hj0 : (j : ℝ) ≠ 0 := by positivity
  unfold EOQ.cycleCost EOQ.rate
  field_simp

/-- Integer cycle costs also lie above the fluid lower bound. -/
theorem fluid_rate_lower (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (j : ℕ) (hj : 0 < j) : EOQ.fluidBound B g ≤ EOQ.rate B g j := by
  have h := fluid_cycle_lower B g hB hg j
  rw [cycle_rate B g j hj] at h
  have hjpos : 0 < (j : ℝ) := by positivity
  nlinarith

/-- There is a first positive length whose break-even ledger reaches B. -/
theorem optimal_exists (B g : ℝ) (hB : 0 < B) (hg : 0 < g) :
    ∃ L : ℕ, EOQ.OptimalCycle B g L := by
  have hex : ∃ n : ℕ, 0 < n ∧ 2 * B ≤ g * (n : ℝ) * ((n : ℝ) + 1) := by
    obtain ⟨n, hn⟩ := exists_nat_gt (2 * B / g + 1)
    have hq : 0 < 2 * B / g := by positivity
    have hnpos : 0 < n := by exact_mod_cast (show 0 < (n : ℝ) by linarith)
    have hgn : 2 * B < g * (n : ℝ) := by
      have := (div_lt_iff₀ hg).mp (show 2 * B / g < (n : ℝ) by linarith)
      nlinarith
    refine ⟨n, hnpos, ?_⟩
    nlinarith [show 0 ≤ (n : ℝ) by positivity]
  refine ⟨Nat.find hex, ?_⟩
  obtain ⟨hp, hreach⟩ := Nat.find_spec hex
  refine ⟨hp, hreach, ?_⟩
  intro j hj hjL
  have hnot := Nat.find_min hex hjL
  exact lt_of_not_ge (fun h => hnot ⟨hj, h⟩)

/-- The minimal ledger crossing bounds the previous cycle's ledger too. -/
theorem optimal_previous (B g : ℝ) (hB : 0 < B) (h : EOQ.OptimalCycle B g L) :
    g * (L : ℝ) * ((L : ℝ) - 1) ≤ 2 * B := by
  have hpos := h.1
  by_cases hL : L = 1
  · subst L; norm_num; linarith
  · have hp : 0 < L - 1 := by omega
    have hm := h.2.2 (L - 1) hp (by omega)
    have he : ((L - 1 : ℕ) : ℝ) = (L : ℝ) - 1 := by
      rw [Nat.cast_sub (by omega), Nat.cast_one]
    rw [he] at hm
    nlinarith

/-- Clearing positive denominators exposes the sign of the cycle-rate difference. -/
theorem rate_difference (B g : ℝ) (L j : ℕ) (hL : 0 < L) (hj : 0 < j) :
    (2 * (L : ℝ) * (j : ℝ)) * (EOQ.rate B g j - EOQ.rate B g L) =
      ((j : ℝ) - (L : ℝ)) * (g * (L : ℝ) * (j : ℝ) - 2 * B) := by
  have hL0 : (L : ℝ) ≠ 0 := by positivity
  have hj0 : (j : ℝ) ≠ 0 := by positivity
  unfold EOQ.rate
  field_simp
  ring

/-- The first break-even crossing minimizes the discrete EOQ rate. -/
theorem optimal_rate (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (h : EOQ.OptimalCycle B g L) (j : ℕ) (hj : 0 < j) :
    EOQ.rate B g L ≤ EOQ.rate B g j := by
  have hL := h.1
  have hprev := optimal_previous B g hB h
  have hid := rate_difference B g L j hL hj
  have hpos : 0 < 2 * (L : ℝ) * (j : ℝ) := by positivity
  have hproduct : 0 ≤ ((j : ℝ) - (L : ℝ)) * (g * (L : ℝ) * (j : ℝ) - 2 * B) := by
    rcases lt_trichotomy j L with hjL | heq | hLj
    · have hjcast : (j : ℝ) + 1 ≤ (L : ℝ) := by exact_mod_cast (show j + 1 ≤ L by omega)
      have hdiff : (j : ℝ) - (L : ℝ) ≤ 0 := by linarith
      have hledger : g * (L : ℝ) * (j : ℝ) - 2 * B ≤ 0 := by
        nlinarith [mul_nonneg (show 0 ≤ g * (L : ℝ) by positivity)
          (show 0 ≤ (L : ℝ) - 1 - (j : ℝ) by linarith)]
      exact mul_nonneg_of_nonpos_of_nonpos hdiff hledger
    · subst j; simp
    · have hjcast : (L : ℝ) + 1 ≤ (j : ℝ) := by exact_mod_cast (show L + 1 ≤ j by omega)
      have hdiff : 0 ≤ (j : ℝ) - (L : ℝ) := by linarith
      have hledger : 0 ≤ g * (L : ℝ) * (j : ℝ) - 2 * B := by
        nlinarith [h.2.1, mul_nonneg (show 0 ≤ g * (L : ℝ) by positivity)
          (show 0 ≤ (j : ℝ) - ((L : ℝ) + 1) by linarith)]
      exact mul_nonneg hdiff hledger
  nlinarith

/-- Pending age counts holds since the last edit, including a final incomplete cycle. -/
def age (sigma : ModelT.Schedule) : ℕ → ℕ
  | 0 => 0
  | n + 1 => if sigma n then 0 else age sigma n + 1

/-- A lower bound on each completed cycle propagates through an arbitrary schedule. -/
theorem schedule_invariant (B g c : ℝ)
    (hcycle : ∀ j : ℕ, 0 < j → (j : ℝ) * c ≤ EOQ.cycleCost B g j)
    (sigma : ModelT.Schedule) (n : ℕ) :
    (ModelT.run B (EOQ.arrivals g n) sigma).pending = g * (age sigma n : ℝ) ∧
    (n : ℝ) * c - ((age sigma n : ℝ) * c - rent g (age sigma n)) ≤
      ModelT.cost B (EOQ.arrivals g n) sigma := by
  induction n with
  | zero => simp [ModelT.run, ModelT.cost, EOQ.arrivals, ModelT.initial, age, rent]
  | succ n ih =>
    have hc := hcycle (age sigma n + 1) (by omega)
    simp only [EOQ.cycleCost, Nat.cast_add, Nat.cast_one] at hc
    simp only [ModelT.cost] at ih ⊢
    rw [run_succ]
    cases he : sigma n with
    | false =>
      simp only [age, he, Bool.false_eq_true, ↓reduceIte, ModelT.step,
        Nat.cast_add, Nat.cast_one, rent] at ih ⊢
      constructor
      · rw [ih.1]; ring
      · rw [ih.1]; nlinarith [ih.2]
    | true =>
      simp only [age, he, ↓reduceIte, ModelT.step, Nat.cast_zero, rent,
        Nat.cast_add, Nat.cast_one] at ih ⊢
      constructor
      · simp
      · nlinarith [ih.2]

/-- The final unedited segment loses at most one rewrite price. -/
theorem schedule_lower (B g c : ℝ) (hB : 0 ≤ B) (hg : 0 ≤ g)
    (hcycle : ∀ j : ℕ, 0 < j → (j : ℝ) * c ≤ EOQ.cycleCost B g j)
    (sigma : ModelT.Schedule) (n : ℕ) :
    (n : ℝ) * c - B ≤ ModelT.cost B (EOQ.arrivals g n) sigma := by
  have hi := (schedule_invariant B g c hcycle sigma n).2
  have hfinal : (age sigma n : ℝ) * c - rent g (age sigma n) ≤ B := by
    by_cases hz : age sigma n = 0
    · simp [hz, rent]; exact hB
    · have hc := hcycle (age sigma n) (Nat.pos_of_ne_zero hz)
      unfold EOQ.cycleCost rent at *
      nlinarith [mul_nonneg hg (show 0 ≤ (age sigma n : ℝ) by positivity)]
  linarith


/-- A periodic schedule resets exactly when the remainder reaches its cycle length. -/
theorem remainder_step (n L : ℕ) (hL : 0 < L) :
    (n + 1) % L = if n % L + 1 = L then 0 else n % L + 1 := by
  have hr := Nat.mod_lt n hL
  have he : (n + 1) % L = (n % L + 1) % L := by simp [Nat.add_mod]
  rw [he]
  split_ifs with h
  · rw [h]; simp
  · exact Nat.mod_eq_of_lt (by omega)

/-- Exact periodic accounting, including the final partial cycle. -/
theorem periodic_state (B g : ℝ) (L : ℕ) (hL : 0 < L) (n : ℕ) :
    let q := ModelT.run B (EOQ.arrivals g n) (ModelT.periodic L)
    q.pending = g * ((n % L : ℕ) : ℝ) ∧ q.rent = rent g (n % L) ∧
    q.cost = (n : ℝ) * EOQ.rate B g L -
      ((n % L : ℕ) : ℝ) * EOQ.rate B g L + rent g (n % L) := by
  induction n with
  | zero => simp [ModelT.run, EOQ.arrivals, ModelT.initial, rent]
  | succ n ih =>
    dsimp only at ih ⊢
    rw [run_succ]
    have hr := Nat.mod_lt n hL
    have hrem := remainder_step n L hL
    by_cases hcross : n % L + 1 = L
    · have hnext : (n + 1) % L = 0 := by simpa [hcross] using hrem
      have hcast : ((n % L : ℕ) : ℝ) + 1 = (L : ℝ) := by exact_mod_cast hcross
      have hcost := cycle_rate B g L hL
      unfold EOQ.cycleCost at hcost
      simp only [ModelT.periodic, hnext, decide_true, ModelT.step, ↓reduceIte,
        rent, Nat.cast_zero, Nat.cast_add, Nat.cast_one]
      refine ⟨by ring, by ring, ?_⟩
      rw [ih.2.2]
      unfold rent
      rw [← hcast] at hcost
      nlinarith [hcost]
    · have hnext : (n + 1) % L = n % L + 1 := by simpa [hcross] using hrem
      have hnzero : (n + 1) % L ≠ 0 := by rw [hnext]; omega
      have hedit : ModelT.periodic L n = false := by simp [ModelT.periodic, hnzero]
      rw [hedit]
      simp only [ModelT.step, Bool.false_eq_true, ↓reduceIte, hnext, Nat.cast_add, Nat.cast_one]
      rw [ih.1, ih.2.1, ih.2.2]
      unfold rent
      simp only [Nat.cast_add, Nat.cast_one]
      refine ⟨by ring, by ring, by ring⟩

/-- Periodic costs have a uniform end-effect constant, independent of the horizon. -/
theorem periodic_upper (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (L : ℕ) (hL : 0 < L) :
    ∃ C : ℝ, 0 ≤ C ∧ ∀ n : ℕ,
      ModelT.cost B (EOQ.arrivals g n) (ModelT.periodic L) ≤
        (n : ℝ) * EOQ.rate B g L + C := by
  refine ⟨rent g L, by unfold rent; positivity, ?_⟩
  intro n
  have hs := (periodic_state B g L hL n).2.2
  have hr : ((n % L : ℕ) : ℝ) ≤ (L : ℝ) := by exact_mod_cast (Nat.mod_lt n hL).le
  have hr0 : 0 ≤ ((n % L : ℕ) : ℝ) := by positivity
  have hL1 : 1 ≤ (L : ℝ) := by exact_mod_cast hL
  have hc : 0 ≤ EOQ.rate B g L := by unfold EOQ.rate; positivity
  have hsegment : rent g (n % L) ≤ rent g L := by
    unfold rent
    nlinarith [mul_nonneg (show 0 ≤ g * ((L : ℝ) + ((n % L : ℕ) : ℝ) + 1) by positivity)
      (show 0 ≤ (L : ℝ) - ((n % L : ℕ) : ℝ) by linarith)]
  unfold ModelT.cost
  nlinarith [mul_nonneg hr0 hc]

/-- The remainder test and the crossing of the within-cycle age are identical. -/
theorem periodic_cross (L k : ℕ) (hL : 0 < L) :
    ModelT.periodic L k = decide (k % L + 1 = L) := by
  unfold ModelT.periodic
  rw [remainder_step k L hL]
  by_cases h : k % L + 1 = L <;> simp [h]

/-- Reconstruct the controller on a constant-growth history from its cycle ledger.
The arbitrary history and arbitrary accumulated cost do not affect its next decision. -/
theorem decisions_periodic (B g : ℝ) (L : ℕ) (hL : 0 < L)
    (ctrl : ModelT.Predicate ℝ)
    (hpred : ∀ (history : List ℝ) (r : ℕ), r < L →
      ctrl B history (g * ((r : ℝ) + 1))
        (g * ((r : ℝ) + 1) * ((r : ℝ) + 2) / 2) = decide (r + 1 = L))
    (n k : ℕ) (history : List ℝ) (q : ModelT.State ℝ)
    (hp : q.pending = g * ((k % L : ℕ) : ℝ))
    (hrent : q.rent = rent g (k % L)) :
    ModelT.decisions B ctrl (List.replicate n g) history q =
      (List.range' k n).map (ModelT.periodic L) := by
  induction n generalizing k history q with
  | zero => simp [ModelT.decisions]
  | succ n ih =>
    have hr := Nat.mod_lt k hL
    have hpnext : q.pending + g = g * (((k % L : ℕ) : ℝ) + 1) := by rw [hp]; ring
    have hrnext : q.rent + q.pending + g =
        g * (((k % L : ℕ) : ℝ) + 1) * (((k % L : ℕ) : ℝ) + 2) / 2 := by
      rw [hp, hrent]; unfold rent; ring
    have hedit : ctrl B (history ++ [g]) (q.pending + g) (q.rent + q.pending + g) =
        ModelT.periodic L k := by
      rw [hpnext, hrnext, hpred (history ++ [g]) (k % L) hr, periodic_cross L k hL]
    simp only [List.replicate_succ, ModelT.decisions, hedit, List.range'_succ,
      List.map_cons, Nat.add_one]
    congr 1
    apply ih
    · rw [periodic_cross L k hL, remainder_step k L hL]
      by_cases h : k % L + 1 = L
      · simp [h, ModelT.step]
      · simp [h, ModelT.step, hp, Nat.cast_add, Nat.cast_one]; ring
    · rw [periodic_cross L k hL, remainder_step k L hL]
      by_cases h : k % L + 1 = L
      · simp [h, ModelT.step, rent]
      · simp [h, ModelT.step, hp, hrent, rent, Nat.cast_add, Nat.cast_one]; ring

/-- A controller with this cycle ledger equals the periodic schedule on every real request. -/
theorem controller_periodic (B g : ℝ) (L : ℕ) (hL : 0 < L)
    (ctrl : ModelT.Predicate ℝ)
    (hpred : ∀ (history : List ℝ) (r : ℕ), r < L →
      ctrl B history (g * ((r : ℝ) + 1))
        (g * ((r : ℝ) + 1) * ((r : ℝ) + 2) / 2) = decide (r + 1 = L))
    (N i : ℕ) (hi : i < N) :
    ModelT.onlineSchedule B (ModelT.controller ctrl) (EOQ.arrivals g N) i =
      ModelT.periodic L i := by
  unfold ModelT.onlineSchedule EOQ.arrivals ModelT.controller
  rw [List.take_replicate, Nat.min_eq_left (by omega)]
  rw [decisions_periodic B g L hL ctrl hpred (i + 1) 0 [] ModelT.initial
    (by simp [ModelT.initial]) (by simp [ModelT.initial, rent])]
  rw [List.range'_1_concat]
  simp

/-- BAL's first crossing is the minimum positive j with g*j*(j+1) >= 2B. -/
theorem bal_periodic (B g : ℝ) (_hB : 0 < B) (hg : 0 < g)
    (h : EOQ.OptimalCycle B g L) (N i : ℕ) (hi : i < N) :
    ModelT.onlineSchedule B ModelT.bal (EOQ.arrivals g N) i = ModelT.periodic L i := by
  apply controller_periodic B g L h.1 _ _ N i hi
  intro history r hr
  by_cases hc : r + 1 = L
  · have hcR : (r : ℝ) + 1 = (L : ℝ) := by exact_mod_cast hc
    have hreach := h.2.1
    simp only [hcR, show (r : ℝ) + 2 = (L : ℝ) + 1 by linarith]
    have hb : B ≤ g * (L : ℝ) * ((L : ℝ) + 1) / 2 := by linarith
    have hpL : 0 < g * (L : ℝ) := mul_pos hg (by exact_mod_cast h.1)
    simp [hc, hpL, hb]
  · have hbefore := h.2.2 (r + 1) (by omega) (by omega)
    simp only [Nat.cast_add, Nat.cast_one] at hbefore
    have hb : ¬ B ≤ g * ((r : ℝ) + 1) * ((r : ℝ) + 2) / 2 := by nlinarith
    simp [hc, hb]

/-- LAW's first crossing is the minimum positive j with g*j^2 >= 2B. -/
theorem law_periodic (B g : ℝ) (_hB : 0 < B) (hg : 0 < g)
    (h : EOQ.LawCycle B g L) (N i : ℕ) (hi : i < N) :
    ModelT.onlineSchedule B (ModelT.law (ModelT.fixed g)) (EOQ.arrivals g N) i =
      ModelT.periodic L i := by
  apply controller_periodic B g L h.1 _ _ N i hi
  intro history r hr
  by_cases hc : r + 1 = L
  · have hcR : (r : ℝ) + 1 = (L : ℝ) := by exact_mod_cast hc
    have hreach := h.2.1
    have hb : 2 * g * B ≤ (g * ((r : ℝ) + 1)) ^ 2 := by
      rw [hcR]
      nlinarith [mul_nonneg hg.le (show 0 ≤ g * (L : ℝ) ^ 2 - 2 * B by linarith)]
    simp [hc, ModelT.fixed, hb]
  · have hbefore := h.2.2 (r + 1) (by omega) (by omega)
    simp only [Nat.cast_add, Nat.cast_one] at hbefore
    have hb : ¬ 2 * g * B ≤ (g * ((r : ℝ) + 1)) ^ 2 := by
      nlinarith [mul_pos hg (show 0 < 2 * B - g * ((r : ℝ) + 1) ^ 2 by linarith)]
    simp [hc, ModelT.fixed, hb]

/-- The fluid length is positive, satisfies its defining quadratic, and sets the fluid rate. -/
theorem fluid_facts (B g : ℝ) (hB : 0 < B) (hg : 0 < g) :
    0 < EOQ.fluidLength B g ∧ g * EOQ.fluidLength B g ^ 2 = 2 * B ∧
      Real.sqrt (2 * g * B) = g * EOQ.fluidLength B g := by
  have hq : 0 < 2 * B / g := by positivity
  have hell : 0 < EOQ.fluidLength B g := Real.sqrt_pos.2 hq
  have hs := Real.sq_sqrt hq.le
  change EOQ.fluidLength B g ^ 2 = 2 * B / g at hs
  have he : g * EOQ.fluidLength B g ^ 2 = 2 * B := by
    have := (eq_div_iff hg.ne').mp hs
    nlinarith
  have hs2 := Real.sq_sqrt (show 0 ≤ 2 * g * B by positivity)
  have hp : (g * EOQ.fluidLength B g) ^ 2 = 2 * g * B := by
    calc
      (g * EOQ.fluidLength B g) ^ 2 = g * (g * EOQ.fluidLength B g ^ 2) := by ring
      _ = 2 * g * B := by rw [he]; ring
  refine ⟨hell, he, ?_⟩
  have hpos : 0 < g * EOQ.fluidLength B g := mul_pos hg hell
  nlinarith [Real.sqrt_nonneg (2 * g * B)]

/-- The first square-ledger crossing is the ceiling of the fluid cycle length. -/
theorem law_ceil (B g : ℝ) (hB : 0 < B) (hg : 0 < g) :
    EOQ.LawCycle B g (Nat.ceil (EOQ.fluidLength B g)) := by
  obtain ⟨hell, he, _⟩ := fluid_facts B g hB hg
  have hceil := Nat.le_ceil (EOQ.fluidLength B g)
  refine ⟨Nat.ceil_pos.2 hell, ?_, ?_⟩
  · have hs : EOQ.fluidLength B g ^ 2 ≤ (Nat.ceil (EOQ.fluidLength B g) : ℝ) ^ 2 := by
      nlinarith
    nlinarith [mul_le_mul_of_nonneg_left hs hg.le]
  · intro j hj hjL
    have hjell := Nat.lt_ceil.mp hjL
    have hj0 : 0 ≤ (j : ℝ) := by positivity
    have hs : (j : ℝ) ^ 2 < EOQ.fluidLength B g ^ 2 := by nlinarith
    nlinarith [mul_lt_mul_of_pos_left hs hg]

/-- The law ceiling is either the optimal integer cycle or its immediate successor. -/
theorem ceil_rounding (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (h : EOQ.OptimalCycle B g Lstar) :
    Nat.ceil (EOQ.fluidLength B g) = Lstar ∨
      Nat.ceil (EOQ.fluidLength B g) = Lstar + 1 := by
  obtain ⟨hell, he, _⟩ := fluid_facts B g hB hg
  have hspos : 0 < (Lstar : ℝ) := by exact_mod_cast h.1
  have hupper : Nat.ceil (EOQ.fluidLength B g) ≤ Lstar + 1 := by
    apply Nat.ceil_le.2
    have hs : EOQ.fluidLength B g ^ 2 ≤ (Lstar : ℝ) * ((Lstar : ℝ) + 1) := by
      nlinarith [h.2.1]
    simp only [Nat.cast_add, Nat.cast_one]
    nlinarith
  have hlower : Lstar ≤ Nat.ceil (EOQ.fluidLength B g) := by
    by_cases hunit : Lstar = 1
    · have hp := Nat.ceil_pos.2 hell; omega
    · have hp : 0 < Lstar - 1 := by have := h.1; omega
      have hb := h.2.2 (Lstar - 1) hp (by have := h.1; omega)
      have hcast : ((Lstar - 1 : ℕ) : ℝ) = (Lstar : ℝ) - 1 := by
        rw [Nat.cast_sub (by have := h.1; omega), Nat.cast_one]
      rw [hcast] at hb
      have hs : ((Lstar : ℝ) - 1) * (Lstar : ℝ) < EOQ.fluidLength B g ^ 2 := by
        nlinarith
      have hj : ((Lstar - 1 : ℕ) : ℝ) < EOQ.fluidLength B g := by
        rw [hcast]; nlinarith
      have := Nat.lt_ceil.2 hj
      omega
  omega

/-- Completing the square gives the exact excess above the fluid lower bound. -/
theorem excess_identity (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (L : ℕ) (hL : 0 < L) :
    EOQ.rate B g L - EOQ.fluidBound B g =
      g / (2 * (L : ℝ)) * ((L : ℝ) - EOQ.fluidLength B g) ^ 2 := by
  obtain ⟨_, he, hs⟩ := fluid_facts B g hB hg
  have hL0 : (L : ℝ) ≠ 0 := by positivity
  have hBexpr : B = g * EOQ.fluidLength B g ^ 2 / 2 := by linarith
  unfold EOQ.rate EOQ.fluidBound
  rw [hs]
  nth_rw 1 [hBexpr]
  field_simp
  ring

/-- Rounding upward has a strictly subunit error, even when the fluid length is an integer. -/
theorem excess_bound (B g : ℝ) (hB : 0 < B) (hg : 0 < g) :
    EOQ.rate B g (Nat.ceil (EOQ.fluidLength B g)) - EOQ.fluidBound B g <
      g / (2 * EOQ.fluidLength B g) := by
  obtain ⟨hell, _, _⟩ := fluid_facts B g hB hg
  have hL := Nat.ceil_pos.2 hell
  have hceil := Nat.le_ceil (EOQ.fluidLength B g)
  have hnear := Nat.ceil_lt_add_one hell.le
  have hLpos : 0 < (Nat.ceil (EOQ.fluidLength B g) : ℝ) := by positivity
  have herr0 : 0 ≤ (Nat.ceil (EOQ.fluidLength B g) : ℝ) - EOQ.fluidLength B g := by linarith
  have herr1 : (Nat.ceil (EOQ.fluidLength B g) : ℝ) - EOQ.fluidLength B g < 1 := by linarith
  have hs : ((Nat.ceil (EOQ.fluidLength B g) : ℝ) - EOQ.fluidLength B g) ^ 2 < 1 := by
    nlinarith
  rw [excess_identity B g hB hg _ hL]
  calc
    g / (2 * (Nat.ceil (EOQ.fluidLength B g) : ℝ)) *
        ((Nat.ceil (EOQ.fluidLength B g) : ℝ) - EOQ.fluidLength B g) ^ 2 <
        g / (2 * (Nat.ceil (EOQ.fluidLength B g) : ℝ)) := by
      nlinarith [mul_lt_mul_of_pos_left hs
        (show 0 < g / (2 * (Nat.ceil (EOQ.fluidLength B g) : ℝ)) by positivity)]
    _ ≤ g / (2 * EOQ.fluidLength B g) := by
      exact div_le_div_of_nonneg_left hg.le (by positivity) (by linarith)

/-- Divide by the positive optimal rate, then use its fluid lower bound. -/
theorem relative_excess_bound (B g : ℝ) (hB : 0 < B) (hg : 0 < g)
    (h : EOQ.OptimalCycle B g Lstar) (hell : 1 / 2 < EOQ.fluidLength B g) :
    (EOQ.rate B g (Nat.ceil (EOQ.fluidLength B g)) - EOQ.fluidBound B g) /
      EOQ.rate B g Lstar < 1 / (EOQ.fluidLength B g * (2 * EOQ.fluidLength B g - 1)) := by
  obtain ⟨hell0, _, hs⟩ := fluid_facts B g hB hg
  have hfluid := fluid_rate_lower B g hB hg Lstar h.1
  have hbound := excess_bound B g hB hg
  have hf : EOQ.fluidBound B g = g * (EOQ.fluidLength B g - 1 / 2) := by
    unfold EOQ.fluidBound; rw [hs]; ring
  have hfpos : 0 < EOQ.fluidBound B g := by rw [hf]; positivity
  have hcpos : 0 < EOQ.rate B g Lstar := lt_of_lt_of_le hfpos hfluid
  have hcompare : g / (2 * EOQ.fluidLength B g) / EOQ.rate B g Lstar ≤
      g / (2 * EOQ.fluidLength B g) / EOQ.fluidBound B g :=
    div_le_div_of_nonneg_left (by positivity) hfpos hfluid
  have hid : g / (2 * EOQ.fluidLength B g) / EOQ.fluidBound B g =
      1 / (EOQ.fluidLength B g * (2 * EOQ.fluidLength B g - 1)) := by
    rw [hf]
    field_simp
  calc
    _ < g / (2 * EOQ.fluidLength B g) / EOQ.rate B g Lstar :=
      (div_lt_div_iff_of_pos_right hcpos).2 hbound
    _ ≤ g / (2 * EOQ.fluidLength B g) / EOQ.fluidBound B g := hcompare
    _ = _ := hid

end T3

/-- Every finite schedule obeys the fluid EOQ lower bound from cycle decomposition. -/
theorem T3_i_proof : PiZip.T3_i := by
  intro B g hB hg N sigma
  exact T3.schedule_lower B g (EOQ.fluidBound B g) hB.le hg.le
    (fun j _ => T3.fluid_cycle_lower B g hB hg j) sigma N

/-- The minimizing positive integer cycle gives the optimal long-run rate via finite bounds. -/
theorem T3_ii_proof : PiZip.T3_ii := by
  intro B g hB hg
  obtain ⟨L, hL⟩ := T3.optimal_exists B g hB hg
  have hmin := T3.optimal_rate B g hB hg hL
  refine ⟨L, hL, hmin, T3.fluid_rate_lower B g hB hg L hL.1, ?_,
    T3.periodic_upper B g hB hg L hL.1⟩
  intro N sigma
  apply T3.schedule_lower B g (EOQ.rate B g L) hB.le hg.le _ sigma N
  intro j hj
  rw [T3.cycle_rate B g j hj]
  exact mul_le_mul_of_nonneg_left (hmin j hj) (by positivity)

/-- Break-even is the minimizing periodic EOQ schedule, including its finite phase. -/
theorem T3_iii_proof : PiZip.T3_iii := by
  intro B g L hB hg h
  exact ⟨T3.bal_periodic B g hB hg h, T3.optimal_rate B g hB hg h⟩

/-- True-growth LAW has the claimed ceiling cycle and the stated absolute and relative excess. -/
theorem T3_iv_proof : PiZip.T3_iv := by
  intro B g Lstar hB hg h
  exact ⟨T3.law_periodic B g hB hg (T3.law_ceil B g hB hg),
    T3.ceil_rounding B g hB hg h, T3.excess_bound B g hB hg,
    T3.relative_excess_bound B g hB hg h⟩

end PiZip
