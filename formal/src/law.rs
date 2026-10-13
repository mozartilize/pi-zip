//! The economic law (plan.ts `lawTerms`, identical in 0.2.8 and affine), ported line for line, and its lemmas.
//!
//!   Phi = [ r D^2/(2g) + eta D ] / K >= 1,   D = B - A,   K = (w - r)(P T - (1 - P) D) + call,   T = min(T, A)
//!   ok  = K <= 0  or  gain >= K
//!
//! The law's own cost model: editing changes the expected cost of the session by  E[edit] - E[no edit] = K - gain:
//! K is what the next request pays extra in expectation (a warm cache, probability P, is rewritten: (w - r)T more, minus the
//! r D the smaller prefix saves; a cold one costs w D less) plus the r D read credit that the read integral below counts again,
//! plus `call` (an uncached summary call); gain is the reads the removed D tokens would have cost while the context grows back at
//! g tokens per request (the integral of r (D - g t) over D/g requests) plus, at Pi's compaction room, what Pi would charge for the
//! same room (eta D). Lemma E below is the statement that the law never picks an edit its own model says costs more.
use crate::model::Class;

pub const KEEP_RECENT: f64 = 20_000.0; // Pi's keepRecentTokens default (lawTerms' `keep`)

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prices {
    pub r: f64,
    pub w: f64,
    pub out: f64,
}

/// What a summary model call really costs, in the law's units (uncached input = 1): summary.ts narrative() reads the prefix without
/// the previous summary's lists (the code carries them forward verbatim) but with its narrative, which it merges, with cacheRetention
/// "none", and writes the summary.
pub fn summary_call(pr: Prices, read: f64, written: f64) -> f64 {
    pr.w * read.max(0.0) + pr.out * written.max(0.0)
}

/// The call term a recorded law step used, backed out of its K (K = (w - r)(P min(T, A) - (1 - P)(B - A)) + call).
pub fn call_of(pr: Prices, b: f64, a: f64, p: f64, t: f64, k: f64) -> f64 {
    k - (pr.w - pr.r) * (p * t.min(a) - (1.0 - p) * (b - a))
}

/// learn.ts lawPrices: the class ratios (never the model's price table).
pub fn class_prices(cls: Class, long_tier: bool) -> Prices {
    match cls {
        Class::Explicit => Prices { r: 0.1, w: if long_tier { 2.0 } else { 1.25 }, out: 5.0 },
        Class::Automatic => Prices { r: 0.2, w: 1.0, out: 4.0 },
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Terms {
    pub ok: bool,
    pub k: f64,
    pub eta: f64,
    pub gain: f64,
}

/// plan.ts lawTerms, line for line (`!(a < b)` as in the TypeScript: a NaN size refuses).
#[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
pub fn law(b: f64, a: f64, p: f64, room: Option<f64>, pr: Option<Prices>, g: f64, call: f64, t: f64) -> Terms {
    let none = Terms { ok: false, k: f64::NAN, eta: 0.0, gain: f64::NAN };
    if !(a < b) {
        return none;
    }
    // no prices: nothing is allowed (since 0.4.0 the planner always has prices: the class ratios, the explicit ones before the class
    // is learned; the legacy rule is gone)
    let Some(pr) = pr.filter(|pr| pr.r > 0.0) else {
        return none;
    };
    let d = b - a;
    let k = (pr.w - pr.r) * (p * t.min(a) - (1.0 - p) * d) + call;
    let mut eta = 0.0;
    if let Some(room) = room {
        if b >= room {
            let x = (b - KEEP_RECENT).max(0.0);
            let s = (0.1 * x).clamp(1_000.0, 8_000.0);
            eta = if x > s { (pr.w * x + pr.out * s + (pr.w - pr.r) * (b - x + s)) / (x - s) } else { 0.0 };
        }
    }
    let gain = (pr.r * d * d) / (2.0 * g.max(1.0)) + eta * d;
    Terms { ok: k <= 0.0 || gain >= k, k, eta, gain }
}

pub fn with_tail(mut t: Terms, b: f64, a: f64, room: Option<f64>, pr: Prices, keep: Option<f64>) -> Terms {
    if let Some(keep) = keep.filter(|_| room.is_some_and(|room| b >= room)) {
        let x = (b - keep).max(0.0);
        let s = (0.1 * x).clamp(1_000.0, 8_000.0);
        let eta = if x > s { (pr.w * x + pr.out * s + (pr.w - pr.r) * (b - x + s)) / (x - s) } else { 0.0 };
        t.gain += (eta - t.eta) * (b - a);
        t.eta = eta;
        t.ok = a < b && (t.k <= 0.0 || t.gain >= t.k);
    }
    t
}

/// The guarded application law, in the same input-price units as law(). Production stays plain.
pub fn guard(b: f64, a: f64, p: f64, room: Option<f64>, pr: Prices, g: f64, rent: f64, keep: Option<f64>) -> Terms {
    let mut t = with_tail(law(b, a, p, room, Some(pr), g, 0.0, a), b, a, room, pr, keep);
    let effective = t.k - t.eta * (b - a);
    let paid = pr.r * (rent + b - a);
    t.ok = a < b && (effective <= 0.0 || paid >= effective || (t.ok && paid >= effective / 10.0));
    t
}

/// The expected cost difference of an edit under the law's own model (negative: the edit saves).
pub fn expected_delta(t: &Terms) -> f64 {
    t.k - t.gain
}

/// One numeric point of the lemma grid (also sent to the real lawTerms through the bridge).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub b: f64,
    pub a: f64,
    pub p: f64,
    pub room: Option<f64>,
    pub pr: Prices,
    pub g: f64,
    pub call: f64,
}
impl Point {
    pub fn terms(&self) -> Terms {
        law(self.b, self.a, self.p, self.room, Some(self.pr), self.g, self.call, self.a)
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "B": self.b, "A": self.a, "P": self.p, "room": self.room, "pr": { "r": self.pr.r, "w": self.pr.w, "out": self.pr.out, "input": 1, "cls": "x", "src": "class" }, "g": self.g, "call": self.call })
    }
}

/// The lemma grid: contexts 4K..400K, every after-size, P in [0, 1], growth 1..60K, every price class, with and without the
/// compaction room, with and without a summary call. B >= the smallest compaction room the planner allows (4096).
pub fn grid() -> Vec<Point> {
    let bs: [f64; 7] = [4_096.0, 10_000.0, 30_000.0, 60_000.0, 93_000.0, 150_000.0, 400_000.0];
    let fr: [f64; 6] = [0.01, 0.1, 0.3, 0.5, 0.8, 0.99];
    let ps = [0.0, 0.1, 0.25, 0.49, 0.5, 0.51, 0.75, 0.9, 1.0];
    let gs = [1.0, 500.0, 2_500.0, 8_000.0, 60_000.0];
    let prices = [class_prices(Class::Explicit, false), class_prices(Class::Explicit, true), class_prices(Class::Automatic, false)];
    let mut out = Vec::new();
    for &b in &bs {
        for &f in &fr {
            let a = (b * f).max(1.0);
            for &pr in &prices {
                for &g in &gs {
                    for room in [None, Some(4_096.0), Some(b * 0.9), Some(b + 1.0)] {
                        for call in [0.0, pr.w * (b - a) + pr.out * a] {
                            for &p in &ps {
                                out.push(Point { b, a, p, room, pr, g, call });
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// A lemma and its first counterexample on the grid (None = holds on every point).
pub struct LemmaResult {
    pub name: &'static str,
    pub statement: &'static str,
    pub counterexample: Option<String>,
    pub points: usize,
}

/// The lemmas, checked on the Rust port over the grid. Their proofs are in the README; the bridge re-checks them on the real
/// lawTerms (`check --lemmas`), so the proofs are about the code and not about this port.
pub fn lemmas(points: &[Point], eval: &dyn Fn(&Point) -> Terms) -> Vec<LemmaResult> {
    let mut res = Vec::new();
    // M: monotone in P. For fixed everything else, ok at P implies ok at every P' < P.
    let mut cx = None;
    for q in points.iter().filter(|q| q.p > 0.0) {
        if eval(q).ok {
            for lower in [0.0, q.p / 2.0, (q.p - 0.01).max(0.0)] {
                let lo = Point { p: lower, ..*q };
                if !eval(&lo).ok {
                    cx.get_or_insert(format!("ok at P={} but not at P={lower}: {q:?}", q.p));
                }
            }
        }
    }
    res.push(LemmaResult { name: "M", statement: "lawTerms(.., P, ..).ok is antitone in P: an edit the law allows at P is allowed at every P' < P", counterexample: cx, points: points.len() });
    // E: economic sanity. ok implies K - gain <= 0 (the edit does not cost more than not editing, in the law's own model).
    let cx = points.iter().find(|q| {
        let t = eval(q);
        t.ok && t.k.is_finite() && expected_delta(&t) > 1e-9 * t.k.abs().max(1.0)
    });
    res.push(LemmaResult { name: "E", statement: "ok implies E[cost | edit] - E[cost | no edit] = K - gain <= 0", counterexample: cx.map(|q| format!("{q:?} -> {:?}", eval(q))), points: points.len() });
    // G: the gain is never negative (so K <= 0 alone is a sound reason to edit), and eta >= 0 wherever B reaches the room.
    let cx = points.iter().find(|q| {
        let t = eval(q);
        t.k.is_finite() && (t.gain < 0.0 || t.eta < 0.0)
    });
    res.push(LemmaResult { name: "G", statement: "gain >= 0 and eta >= 0 (B >= room >= 4096)", counterexample: cx.map(|q| format!("{q:?} -> {:?}", eval(q))), points: points.len() });
    // C: a cold cache (P = 0) without a model call always allows the edit (K = -(w - r) D < 0).
    let cx = points.iter().find(|q| q.p == 0.0 && q.call == 0.0 && q.a < q.b && !eval(q).ok);
    res.push(LemmaResult { name: "C", statement: "P = 0 and call = 0 imply ok (an edit at a dead cache is free)", counterexample: cx.map(|q| format!("{q:?}")), points: points.len() });
    // S: the summary call is priced: at P = 0, ok with call implies ok without it, never the reverse (call >= 0 only raises K).
    let cx = points.iter().find(|q| q.call > 0.0 && eval(q).ok && !eval(&Point { call: 0.0, ..**q }).ok);
    res.push(LemmaResult { name: "S", statement: "a model call only makes an edit harder: ok with call implies ok without it", counterexample: cx.map(|q| format!("{q:?}")), points: points.len() });
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_matches_known_values() {
        // the B1 numbers from the 0.2.8 ledger: summary step B = X = 63053, A = Sr = 6305, P = 0, g = 8317, explicit, call = w X + out Sr
        let pr = class_prices(Class::Explicit, false);
        let t = law(63_053.0, 6_305.0, 0.0, None, Some(pr), 8_316.6, pr.w * 63_053.0 + pr.out * 6_305.0, 6_305.0);
        assert!(!t.ok);
        assert!((t.k - 45_082.895).abs() < 5.0, "{t:?}"); // the ledger rounds B and A
        // the warm valve that followed: plan step at P = 1, no call: fires
        let v = law(126_348.0, 11_147.0, 1.0, Some(175_424.0), Some(pr), 12_820.876, 0.0, 11_147.0);
        assert!(v.ok);
        assert!((v.k - 12_819.05).abs() < 5.0, "{v:?}");
    }

    #[test]
    fn lemmas_hold_on_the_port() {
        // the lemmas' premise: every class ratio has w >= r > 0 (LW checks the planner uses exactly these)
        for cls in [Class::Explicit, Class::Automatic] {
            for long in [false, true] {
                let p = class_prices(cls, long);
                assert!(p.w >= p.r && p.r > 0.0 && p.out > 0.0, "{cls:?} long={long}: {p:?}");
            }
        }
        let pts = grid();
        for l in lemmas(&pts, &|q: &Point| q.terms()) {
            assert!(l.counterexample.is_none(), "{}: {:?}", l.name, l.counterexample);
        }
    }

    #[test]
    fn nothing_without_prices() {
        for (b, a, p, room) in [(100.0, 40.0, 1.0, None), (100.0, 99.0, 1.0, Some(90.0)), (100.0, 40.0, 0.0, None)] {
            assert!(!law(b, a, p, room, None, 1.0, 0.0, a).ok);
        }
    }
}
