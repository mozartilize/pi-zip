//! Bounded temporal logic over finite traces, with frozen variables and cost terms.
//!
//! A formula is evaluated at a position `i` of a finite trace `C` (anything with a length). The operators are the usual ones,
//! with finite-trace (strong) semantics for the existential ones, so that a violation is always witnessed by positions that exist:
//!
//! | operator              | holds at i iff                                                        |
//! |-----------------------|-----------------------------------------------------------------------|
//! | `always(f)`           | f holds at every j >= i                                               |
//! | `next(f)`             | i+1 exists and f holds there                                          |
//! | `within(k, f)`        | f holds at some j in [i, i+k] (that exists)                           |
//! | `a.until(b)`          | b holds at some j >= i, and a at every m in [i, j)                    |
//! | `a.until_within(k,b)` | as `until`, with j <= i+k                                             |
//! | `a >> b`              | a implies b (at the same position)                                    |
//! | `freeze(x, t, f)`     | f holds at i with the variable x bound to the value of term t at i    |
//! | `le(t, u)` etc.       | comparison of two cost terms at i                                     |
//!
//! Terms are numbers: constants, frozen variables, named observables (`term(name, fn)`), `sum(k, t)` over [i, i+k), and
//! arithmetic. That is all the specification needs: costs are terms, "within k requests" is `within`, "since the cold plan" is a
//! frozen variable.
use std::fmt;
use std::ops::{BitAnd, BitOr, Not, Shr};
use std::rc::Rc;

/// Anything a formula can be evaluated over: a finite sequence of positions.
pub trait Timeline {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Frozen variables: name -> value, innermost binding last.
pub type Env = Vec<(&'static str, f64)>;
pub fn lookup(env: &Env, x: &str) -> f64 {
    env.iter().rev().find(|(n, _)| *n == x).map(|(_, v)| *v).unwrap_or(f64::NAN)
}

pub type AtomFn<C> = Rc<dyn Fn(&C, usize, &Env) -> bool>;
pub type TermFn<C> = Rc<dyn Fn(&C, usize, &Env) -> f64>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmp {
    Le,
    Lt,
    Ge,
    Gt,
}

#[derive(Clone, Copy, Debug)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Max,
}

pub enum Term<C> {
    Const(f64),
    Var(&'static str),
    Get(&'static str, TermFn<C>),
    Sum(usize, Rc<Term<C>>),
    Bin(Op, Rc<Term<C>>, Rc<Term<C>>),
}
impl<C> Clone for Term<C> {
    fn clone(&self) -> Self {
        match self {
            Term::Const(x) => Term::Const(*x),
            Term::Var(x) => Term::Var(x),
            Term::Get(n, f) => Term::Get(n, f.clone()),
            Term::Sum(k, t) => Term::Sum(*k, t.clone()),
            Term::Bin(o, a, b) => Term::Bin(*o, a.clone(), b.clone()),
        }
    }
}

pub enum F<C> {
    True,
    Atom(&'static str, AtomFn<C>),
    Not(Rc<F<C>>),
    And(Rc<F<C>>, Rc<F<C>>),
    Or(Rc<F<C>>, Rc<F<C>>),
    Implies(Rc<F<C>>, Rc<F<C>>),
    Always(Rc<F<C>>),
    Next(Rc<F<C>>),
    Within(usize, Rc<F<C>>),
    Until(Rc<F<C>>, Rc<F<C>>),
    UntilWithin(usize, Rc<F<C>>, Rc<F<C>>),
    Cmp(Term<C>, Cmp, Term<C>),
    Freeze(&'static str, Term<C>, Rc<F<C>>),
}
impl<C> Clone for F<C> {
    fn clone(&self) -> Self {
        match self {
            F::True => F::True,
            F::Atom(n, f) => F::Atom(n, f.clone()),
            F::Not(a) => F::Not(a.clone()),
            F::And(a, b) => F::And(a.clone(), b.clone()),
            F::Or(a, b) => F::Or(a.clone(), b.clone()),
            F::Implies(a, b) => F::Implies(a.clone(), b.clone()),
            F::Always(a) => F::Always(a.clone()),
            F::Next(a) => F::Next(a.clone()),
            F::Within(k, a) => F::Within(*k, a.clone()),
            F::Until(a, b) => F::Until(a.clone(), b.clone()),
            F::UntilWithin(k, a, b) => F::UntilWithin(*k, a.clone(), b.clone()),
            F::Cmp(a, c, b) => F::Cmp(a.clone(), *c, b.clone()),
            F::Freeze(x, t, f) => F::Freeze(x, t.clone(), f.clone()),
        }
    }
}

// ---- constructors: the surface syntax of the spec ----------------------------------------------------------------------------
pub fn atom<C: 'static>(name: &'static str, f: impl Fn(&C, usize, &Env) -> bool + 'static) -> F<C> {
    F::Atom(name, Rc::new(f))
}
pub fn always<C>(f: F<C>) -> F<C> {
    F::Always(Rc::new(f))
}
pub fn next<C>(f: F<C>) -> F<C> {
    F::Next(Rc::new(f))
}
pub fn within<C>(k: usize, f: F<C>) -> F<C> {
    F::Within(k, Rc::new(f))
}
pub fn freeze<C>(x: &'static str, t: Term<C>, f: F<C>) -> F<C> {
    F::Freeze(x, t, Rc::new(f))
}
pub fn term<C: 'static>(name: &'static str, f: impl Fn(&C, usize, &Env) -> f64 + 'static) -> Term<C> {
    Term::Get(name, Rc::new(f))
}
pub fn konst<C>(x: f64) -> Term<C> {
    Term::Const(x)
}
pub fn var<C>(x: &'static str) -> Term<C> {
    Term::Var(x)
}
pub fn sum<C>(k: usize, t: Term<C>) -> Term<C> {
    Term::Sum(k, Rc::new(t))
}
pub fn le<C>(a: Term<C>, b: Term<C>) -> F<C> {
    F::Cmp(a, Cmp::Le, b)
}
pub fn lt<C>(a: Term<C>, b: Term<C>) -> F<C> {
    F::Cmp(a, Cmp::Lt, b)
}
pub fn ge<C>(a: Term<C>, b: Term<C>) -> F<C> {
    F::Cmp(a, Cmp::Ge, b)
}
pub fn gt<C>(a: Term<C>, b: Term<C>) -> F<C> {
    F::Cmp(a, Cmp::Gt, b)
}
impl<C> F<C> {
    pub fn until(self, b: F<C>) -> F<C> {
        F::Until(Rc::new(self), Rc::new(b))
    }
    pub fn until_within(self, k: usize, b: F<C>) -> F<C> {
        F::UntilWithin(k, Rc::new(self), Rc::new(b))
    }
}
impl<C> BitAnd for F<C> {
    type Output = F<C>;
    fn bitand(self, b: F<C>) -> F<C> {
        F::And(Rc::new(self), Rc::new(b))
    }
}
impl<C> BitOr for F<C> {
    type Output = F<C>;
    fn bitor(self, b: F<C>) -> F<C> {
        F::Or(Rc::new(self), Rc::new(b))
    }
}
impl<C> Not for F<C> {
    type Output = F<C>;
    fn not(self) -> F<C> {
        F::Not(Rc::new(self))
    }
}
/// `a >> b` reads "a implies b".
impl<C> Shr for F<C> {
    type Output = F<C>;
    fn shr(self, b: F<C>) -> F<C> {
        F::Implies(Rc::new(self), Rc::new(b))
    }
}
impl<C> std::ops::Add for Term<C> {
    type Output = Term<C>;
    fn add(self, b: Term<C>) -> Term<C> {
        Term::Bin(Op::Add, Rc::new(self), Rc::new(b))
    }
}
impl<C> std::ops::Sub for Term<C> {
    type Output = Term<C>;
    fn sub(self, b: Term<C>) -> Term<C> {
        Term::Bin(Op::Sub, Rc::new(self), Rc::new(b))
    }
}
impl<C> std::ops::Mul for Term<C> {
    type Output = Term<C>;
    fn mul(self, b: Term<C>) -> Term<C> {
        Term::Bin(Op::Mul, Rc::new(self), Rc::new(b))
    }
}
pub fn max<C>(a: Term<C>, b: Term<C>) -> Term<C> {
    Term::Bin(Op::Max, Rc::new(a), Rc::new(b))
}

// ---- semantics ---------------------------------------------------------------------------------------------------------------
impl<C: Timeline> Term<C> {
    pub fn at(&self, c: &C, i: usize, env: &Env) -> f64 {
        match self {
            Term::Const(x) => *x,
            Term::Var(x) => lookup(env, x),
            Term::Get(_, f) => f(c, i, env),
            Term::Sum(k, t) => (i..(i + k).min(c.len())).map(|j| t.at(c, j, env)).sum(),
            Term::Bin(op, a, b) => {
                let (x, y) = (a.at(c, i, env), b.at(c, i, env));
                match op {
                    Op::Add => x + y,
                    Op::Sub => x - y,
                    Op::Mul => x * y,
                    Op::Max => x.max(y),
                }
            }
        }
    }
}

impl<C: Timeline> F<C> {
    /// Does the formula hold at position i? `w` collects the positions that witnessed the existential operators that held.
    pub fn eval(&self, c: &C, i: usize, env: &mut Env, w: &mut Vec<usize>) -> bool {
        let n = c.len();
        match self {
            F::True => true,
            F::Atom(_, f) => i < n && f(c, i, env),
            F::Not(a) => {
                let mut sub = Vec::new();
                let r = !a.eval(c, i, env, &mut sub);
                if !r {
                    w.extend(sub); // the positions that made `a` true are why `not a` fails
                }
                r
            }
            F::And(a, b) => a.eval(c, i, env, w) && b.eval(c, i, env, w),
            F::Or(a, b) => a.eval(c, i, env, w) || b.eval(c, i, env, w),
            F::Implies(a, b) => !a.eval(c, i, env, &mut Vec::new()) || b.eval(c, i, env, w),
            F::Always(a) => (i..n).all(|j| a.eval(c, j, env, w)),
            F::Next(a) => {
                let ok = i + 1 < n && a.eval(c, i + 1, env, w);
                if ok {
                    w.push(i + 1);
                }
                ok
            }
            F::Within(k, a) => {
                for j in i..=(i + k).min(n.saturating_sub(1)) {
                    if j < n && a.eval(c, j, env, w) {
                        w.push(j);
                        return true;
                    }
                }
                false
            }
            F::Until(a, b) => until(c, i, n, env, w, a, b),
            F::UntilWithin(k, a, b) => until(c, i, (i + k + 1).min(n), env, w, a, b),
            F::Cmp(a, op, b) => {
                let (x, y) = (a.at(c, i, env), b.at(c, i, env));
                match op {
                    Cmp::Le => x <= y,
                    Cmp::Lt => x < y,
                    Cmp::Ge => x >= y,
                    Cmp::Gt => x > y,
                }
            }
            F::Freeze(x, t, f) => {
                let v = t.at(c, i, env);
                env.push((x, v));
                let r = f.eval(c, i, env, w);
                env.pop();
                r
            }
        }
    }

    pub fn holds(&self, c: &C) -> bool {
        self.eval(c, 0, &mut Vec::new(), &mut Vec::new())
    }

    /// For a property `always(body)`: the first position where the body fails, with the positions that witness it.
    /// Any other formula: position 0 if it fails.
    pub fn first_violation(&self, c: &C) -> Option<Violation> {
        match self {
            F::Always(body) => (0..c.len()).find_map(|i| {
                let mut w = Vec::new();
                (!body.eval(c, i, &mut Vec::new(), &mut w)).then(|| Violation { at: i, witnesses: dedup(w) })
            }),
            // a conjunction of properties fails where its earliest conjunct fails
            F::And(a, b) => match (a.first_violation(c), b.first_violation(c)) {
                (Some(x), Some(y)) => Some(if y.at < x.at { y } else { x }),
                (x, y) => x.or(y),
            },
            _ => {
                let mut w = Vec::new();
                (!self.eval(c, 0, &mut Vec::new(), &mut w)).then(|| Violation { at: 0, witnesses: dedup(w) })
            }
        }
    }
}

fn until<C: Timeline>(c: &C, i: usize, end: usize, env: &mut Env, w: &mut Vec<usize>, a: &F<C>, b: &F<C>) -> bool {
    for j in i..end {
        if b.eval(c, j, env, w) {
            w.push(j);
            return true;
        }
        if !a.eval(c, j, env, &mut Vec::new()) {
            return false;
        }
    }
    false
}

fn dedup(mut v: Vec<usize>) -> Vec<usize> {
    v.sort_unstable();
    v.dedup();
    v
}

/// Where a property failed: the position where `always` broke, and the positions that witness why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub at: usize,
    pub witnesses: Vec<usize>,
}

impl<C> fmt::Display for F<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            F::True => write!(f, "true"),
            F::Atom(n, _) => write!(f, "{n}"),
            F::Not(a) => write!(f, "¬({a})"),
            F::And(a, b) => write!(f, "({a} ∧ {b})"),
            F::Or(a, b) => write!(f, "({a} ∨ {b})"),
            F::Implies(a, b) => write!(f, "({a} → {b})"),
            F::Always(a) => write!(f, "□ {a}"),
            F::Next(a) => write!(f, "○ {a}"),
            F::Within(k, a) => write!(f, "◇≤{k} {a}"),
            F::Until(a, b) => write!(f, "({a} U {b})"),
            F::UntilWithin(k, a, b) => write!(f, "({a} U≤{k} {b})"),
            F::Cmp(a, c, b) => write!(f, "{a} {} {b}", match c { Cmp::Le => "≤", Cmp::Lt => "<", Cmp::Ge => "≥", Cmp::Gt => ">" }),
            F::Freeze(x, t, g) => write!(f, "[{x} := {t}] {g}"),
        }
    }
}
impl<C> fmt::Display for Term<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Term::Const(x) => write!(f, "{x}"),
            Term::Var(x) => write!(f, "{x}"),
            Term::Get(n, _) => write!(f, "{n}"),
            Term::Sum(k, t) => write!(f, "Σ≤{k} {t}"),
            Term::Bin(o, a, b) => match o {
                Op::Max => write!(f, "max({a}, {b})"),
                _ => write!(f, "({a} {} {b})", match o { Op::Add => "+", Op::Sub => "-", Op::Mul => "×", Op::Max => unreachable!() }),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A trace of numbers is enough to test the operators.
    struct T(Vec<i64>);
    impl Timeline for T {
        fn len(&self) -> usize {
            self.0.len()
        }
    }
    fn is(v: i64) -> F<T> {
        atom("is", move |t: &T, i, _| t.0[i] == v)
    }
    fn val() -> Term<T> {
        term("val", |t: &T, i, _| t.0[i] as f64)
    }

    #[test]
    fn always_next_within() {
        let t = T(vec![1, 2, 3, 1, 5]);
        assert!(always(is(1) >> next(!is(1))).holds(&t));
        assert!(!always(is(1) >> within(1, is(2))).holds(&t)); // the second 1 is followed by 5
        let v = always(is(1) >> within(1, is(2))).first_violation(&t).unwrap();
        assert_eq!(v.at, 3);
        assert!(within(2, is(3)).holds(&t));
        assert!(!within(1, is(3)).holds(&t));
        assert!(!next(F::True).eval(&t, 4, &mut Vec::new(), &mut Vec::new())); // strong next at the end
    }

    #[test]
    fn until_and_bounded_until() {
        let t = T(vec![0, 0, 0, 7, 0]);
        let zero = || is(0);
        assert!(zero().until(is(7)).holds(&t));
        assert!(!zero().until_within(2, is(7)).holds(&t));
        assert!(zero().until_within(3, is(7)).holds(&t));
        let t2 = T(vec![0, 1, 7]);
        assert!(!is(0).until(is(7)).holds(&t2)); // broken by the 1
    }

    #[test]
    fn freeze_and_costs() {
        let t = T(vec![10, 12, 13, 30]);
        // from every position, the next value grows by at most 5 over the frozen one
        let p = always(freeze("v0", val(), within(1, F::True) >> !next(gt(val() - var("v0"), konst(5.0)))));
        let v = p.first_violation(&t).unwrap();
        assert_eq!(v.at, 2); // 13 -> 30
        assert!(le(sum(2, val()), konst(22.0)).holds(&t));
        assert!(!le(sum(3, val()), konst(34.0)).holds(&t));
        assert_eq!(max(val(), konst(11.0)).at(&t, 0, &Vec::new()), 11.0);
    }

    #[test]
    fn witnesses_point_at_the_reason() {
        let t = T(vec![1, 0, 0, 2]);
        let p = always(is(1) >> !within(3, is(2)));
        let v = p.first_violation(&t).unwrap();
        assert_eq!(v, Violation { at: 0, witnesses: vec![3] });
        assert_eq!(format!("{p}"), "□ (is → ¬(◇≤3 is))");
        // a conjunction of two `always` reports the earliest failing position
        let q = always(!is(2)) & always(!is(0));
        assert_eq!(q.first_violation(&t).unwrap().at, 1);
    }
}
