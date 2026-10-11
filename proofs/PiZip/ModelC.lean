import Mathlib

namespace PiZip
namespace ModelC

/-- A one-decision instance. New tokens belong to both pre-edit and post-edit views. -/
structure Instance (K : Type*) where
  A : K
  D : K
  n : K
  k : K
  call : K
  eta : K

def view [Add K] (x : Instance K) : K := x.A + x.D

def Valid [Field K] [LinearOrder K] [IsStrictOrderedRing K] (x : Instance K) : Prop :=
  0 ≤ x.A ∧ 0 < x.D ∧ 0 ≤ x.n ∧ x.n ≤ x.A ∧
  x.n < (view x) ∧ 0 < x.k ∧ 0 ≤ x.call ∧ 0 ≤ x.eta

def probability [Field K] [LinearOrder K] [IsStrictOrderedRing K] (p : K) : Prop := 0 ≤ p ∧ p ≤ 1

def fireCost [Field K] (x : Instance K) : K := (1 + x.k) * x.A + x.call

def holdCost [Field K] (x : Instance K) (p F : K) : K :=
  p * ((view x) + x.k * x.n) + (1 - p) * (1 + x.k) * (view x) + x.eta * x.D + F

/-- V includes the current request's saved read, D; F is only future saving. -/
def delta [Field K] (x : Instance K) (p V : K) : K :=
  p * x.k * (x.A - x.n) - (1 - p) * x.k * x.D - x.eta * x.D + x.call - V

def threshold [Field K] (x : Instance K) (V : K) : K :=
  (V + (x.eta + x.k) * x.D - x.call) / (x.k * ((view x) - x.n))

def cycleValue [Field K] (D g : K) : K := D ^ 2 / (2 * g)

def law [Field K] [LinearOrder K] [IsStrictOrderedRing K] (x : Instance K) (p g T : K) : Prop :=
  cycleValue x.D g + (x.eta + (1 - p) * x.k) * x.D ≥ p * x.k * T + x.call

/-- Cost of the selected action, with the common future baseline removed. -/
def chosenCost [Field K] [LinearOrder K] [IsStrictOrderedRing K] (x : Instance K) (p phat F : K) : K :=
  if delta x phat (x.D + F) ≤ 0 then fireCost x else holdCost x p F

/-- Candidate closed formula; its model identification is stated separately. -/
def warmValue [Field K] (D dstar g : K) : K := (dstar * D - D ^ 2 / 2) / g

/-- Candidate hazard relative-value formula; model identification is separate. -/
noncomputable def hazardValue (D dH g h : ℝ) : ℝ :=
  D / h - g / h ^ 2 * Real.exp (-h * dH / g) * (Real.exp (h * D / g) - 1)

/-- Average cost of a fluid renewal cycle: integrated rent plus its terminal edit. -/
noncomputable def fluidAverageCost (B g T : ℝ) : ℝ :=
  (B + ∫ t in (0 : ℝ)..T, g * t) / T

/-- An attained minimum of the fluid renewal average costs. -/
def OptimalFluidAverage (B g d rate : ℝ) : Prop :=
  fluidAverageCost B g (d / g) = rate ∧
  ∀ T : ℝ, 0 < T → rate ≤ fluidAverageCost B g T

/-- Normalized average-cost Bellman characterization on the continuation region.
The derivative is the infinitesimal wait equation, and the terminal condition
is value matching for an edit that resets pending mass to zero. -/
def WarmBellman (B g d rate : ℝ) (V : ℝ → ℝ) : Prop :=
  OptimalFluidAverage B g d rate ∧ V 0 = 0 ∧ V d = B ∧
  ContinuousOn V (Set.Icc 0 d) ∧
  (∀ x ∈ Set.Ioo 0 d, HasDerivAt V ((rate - x) / g) x) ∧
  (∀ x ∈ Set.Icc 0 d, V x ≤ B)

/-- Expected cost of waiting T while the stretch survives, then editing and
restarting with continuation cost J0. The survival probability is exp(-h*t). -/
noncomputable def hazardWaitCost (B g h J0 D T : ℝ) : ℝ :=
  (∫ t in (0 : ℝ)..T, Real.exp (-h * t) * (D + g * t)) +
    Real.exp (-h * T) * (B + J0)

/-- Solution of the discounted renewal equation J0 = C(T) + exp(-h*T)*J0,
with C(T) derived from the survival-weighted rent integral and terminal edit. -/
noncomputable def hazardRenewalCost (B g h T : ℝ) : ℝ :=
  hazardWaitCost B g h 0 0 T / (1 - Real.exp (-h * T))

/-- Starting at pending mass D, continue to threshold d, then restart at zero. -/
noncomputable def hazardStateCost (B g h d D : ℝ) : ℝ :=
  hazardWaitCost B g h (hazardRenewalCost B g h (d / g)) D ((d - D) / g)

end ModelC
end PiZip
