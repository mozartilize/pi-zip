import PiZip.ModelT

namespace PiZip
namespace EOQ

def arrivals (g : K) (N : ℕ) : List K := List.replicate N g

def cycleCost [Field K] (B g : K) (L : ℕ) : K := B + g * (L : K) * ((L : K) - 1) / 2

def rate [Field K] (B g : K) (L : ℕ) : K := B / (L : K) + g * ((L : K) - 1) / 2

/-- Minimal positive integer reaching the discrete break-even ledger. -/
def OptimalCycle [Field K] [LinearOrder K] [IsStrictOrderedRing K] (B g : K) (L : ℕ) : Prop :=
  0 < L ∧ 2 * B ≤ g * (L : K) * ((L : K) + 1) ∧
  ∀ j : ℕ, 0 < j → j < L → g * (j : K) * ((j : K) + 1) < 2 * B

/-- Minimal positive integer reaching the fluid law threshold. -/
def LawCycle [Field K] [LinearOrder K] [IsStrictOrderedRing K] (B g : K) (L : ℕ) : Prop :=
  0 < L ∧ 2 * B ≤ g * (L : K) ^ 2 ∧
  ∀ j : ℕ, 0 < j → j < L → g * (j : K) ^ 2 < 2 * B

noncomputable def fluidLength (B g : ℝ) : ℝ := Real.sqrt (2 * B / g)
noncomputable def fluidBound (B g : ℝ) : ℝ := Real.sqrt (2 * g * B) - g / 2

end EOQ
end PiZip
