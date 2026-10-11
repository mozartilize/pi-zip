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

end PiZip
