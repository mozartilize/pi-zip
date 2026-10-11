import Mathlib

namespace PiZip
namespace ModelT

/-- Request indices are zero based; arrivals precede the request and edits pay no rent. -/
abbrev Schedule := ℕ → Bool
abbrev Online (K : Type*) := K → List K → Bool
abbrev Estimate (K : Type*) := K → List K → K
abbrev Predicate (K : Type*) := K → List K → K → K → Bool

structure State (K : Type*) where
  pending : K
  rent : K
  cost : K
  deriving Repr

def initial [Zero K] : State K := ⟨0, 0, 0⟩

def step [Add K] [Zero K] (B a : K) (edit : Bool) (q : State K) : State K :=
  if edit then ⟨0, 0, q.cost + B⟩
  else let P := q.pending + a; ⟨P, q.rent + P, q.cost + P⟩

def run [Add K] [Zero K] (B : K) (a : List K) (sigma : Schedule) : State K :=
  (a.zipIdx).foldl (fun q ai => step B ai.1 (sigma ai.2) q) initial

def cost [Add K] [Zero K] (B : K) (a : List K) (sigma : Schedule) : K :=
  (run B a sigma).cost

def arrivalsValid [Preorder K] [Zero K] (a : List K) : Prop := ∀ x ∈ a, 0 ≤ x

def onlineSchedule (B : K) (rule : Online K) (a : List K) : Schedule :=
  fun i => rule B (a.take (i + 1))

/-- Execute a controller on a history to reconstruct its persistent state and decisions. -/
def decisions [Add K] [Zero K] (B : K) (ctrl : Predicate K) :
    List K → List K → State K → List Bool
  | [], _, _ => []
  | x :: xs, history, q =>
    let seen := history ++ [x]
    let edit := ctrl B seen (q.pending + x) (q.rent + q.pending + x)
    edit :: decisions B ctrl xs seen (step B x edit q)

/-- An online rule is literally a function of B and the arrival history, never the horizon. -/
def controller [Add K] [Zero K] (ctrl : Predicate K) : Online K :=
  fun B history => ((decisions B ctrl history [] initial).getLast?).getD false

def bal [Field K] [LinearOrder K] [IsStrictOrderedRing K] : Online K := controller fun B _ P R =>
  decide (0 < P ∧ B ≤ R)

def law [Field K] [LinearOrder K] [IsStrictOrderedRing K] (estimate : Estimate K) : Online K :=
  controller fun B history P _ => decide (P ^ 2 ≥ 2 * estimate B history * B)

def guarded [Field K] [LinearOrder K] [IsStrictOrderedRing K] (alpha : K) (pred : Predicate K) : Online K :=
  controller fun B history P R => decide (0 < P ∧ (B ≤ R ∨ (pred B history P R = true ∧ alpha * B ≤ R)))

def lawPredicate [Field K] [LinearOrder K] [IsStrictOrderedRing K] (estimate : Estimate K) : Predicate K :=
  fun B history P _ => decide (P ^ 2 ≥ 2 * estimate B history * B)

def fixed (G : K) : Estimate K := fun _ _ => G

/-- EWMA of removable arrivals, with the 0.1 update in T5's proof (not capped context growth). -/
def ewma [Field K] (g0 : K) : Estimate K := fun _ history =>
  history.foldl (fun g a => (9 / 10) * g + (1 / 10) * a) g0

def algCost [Add K] [Zero K] (B : K) (a : List K) (rule : Online K) : K :=
  cost B a (onlineSchedule B rule a)

def edits (B : K) (a : List K) (rule : Online K) : Prop :=
  ∃ i < a.length, onlineSchedule B rule a i = true

def periodic (L : ℕ) : Schedule := fun i => decide ((i + 1) % L = 0)

def burst [Zero K] (D : K) (m : ℕ) : List K := D :: List.replicate m 0

end ModelT
end PiZip

namespace PiZip.ModelT
/-- Hindsight optimality on the same finite instance; schedules need not be online. -/
def Optimal [Add K] [Zero K] [LE K] (B : K) (a : List K) (sigma : Schedule) : Prop :=
  ∀ tau : Schedule, cost B a sigma ≤ cost B a tau
end PiZip.ModelT
