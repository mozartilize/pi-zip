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

/-- Warm-forever relative continuation value on the continuation region. -/
def warmValue [Field K] (D dstar g : K) : K := (dstar * D - D ^ 2 / 2) / g

/-- Discounted continuation value for an optimal fluid hazard cycle of length dH/g. -/
noncomputable def hazardValue (D dH g h : ℝ) : ℝ :=
  D / h - g / h ^ 2 * Real.exp (-h * dH / g) * (Real.exp (h * D / g) - 1)

end ModelC
end PiZip
