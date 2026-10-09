//! # The pi-zip specification
//!
//! Read this file like the README's "three rules". The state machine it talks about is in `model.rs` (blocks with kind, size,
//! user turn, recoverability and folded / summarised / recalled state; the cache with class, TTL and warm/cold; the clock; the
//! events). Every property is a formula of the bounded temporal logic in `logic.rs`, evaluated over every request of a run
//! (position i = the i-th request pi-zip let go out).
//!
//! The three axioms come first. Every other property is derived from them: it names the axiom(s) it refines and says why.
//! Constants: K_REGRET requests and DELTA tokens bound "soon" and "no new information".
use crate::law::{call_of, law, summary_call, Prices};
use crate::logic::*;
use crate::model::*;
use std::collections::BTreeSet;
use crate::logic::Violation;

/// How a property is established (README: proven / bounded-checked / conformance).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    /// checked on the real implementation, over bounded traces (exhaustive and random), through the bridge
    Conformance,
    /// a lemma about a pure function, proven in the README and checked on a grid against the real code
    Proven,
}

pub struct Prop {
    pub id: &'static str,
    pub name: &'static str,
    /// the axioms it is derived from
    pub from: &'static [&'static str],
    pub why: &'static str,
    pub evidence: Evidence,
    pub f: F<Run>,
}
impl Prop {
    /// The mechanism behind a violation: the checker keeps one minimal counterexample per (property, class).
    pub fn class(&self, r: &Run, v: &Violation) -> String {
        classify(self.id, r, v)
    }
}

/// "Soon": a warm edit this many requests after a cold plan is a regret (it could have been done for free).
pub const K_REGRET: usize = 10;
/// "No new information": the session grew by at most this many real tokens (a quarter of the cold cap).
pub const DELTA: f64 = 10_000.0;
/// Estimates are chars/4 and the planner calibrates its scale: sizes are compared with this relative tolerance.
pub const TOL: f64 = 0.10;
/// The size a plan predicts for the request that carries it is 12-15% off at worst one time in ten (README, token counts):
/// target reachability allows that much.
pub const TOL_TARGET: f64 = 0.15;

// =================================================================================================================================
// Atoms: what can be said about one request. Each is one line; the formulas below combine them.
// =================================================================================================================================
type R = Run;

/// The first request of a run (the user just sent a prompt).
fn run_start() -> F<R> {
    atom("run_start", |r: &R, i, _| r.tick(i).n == 0)
}
/// pi-zip carries a new edit in this request (a new fold or a new summary): the cache is rewritten from the edit on.
fn zip_edit() -> F<R> {
    atom("zip_edit", |r: &R, i, _| r.zip_new(i))
}
fn zip_summary() -> F<R> {
    atom("zip_summary", |r: &R, i, _| r.zip_summary_new(i))
}
/// The cache holds the previous request (the spec's clock and TTL).
fn cache_warm() -> F<R> {
    atom("cache_warm", |r: &R, i, _| r.st[i].warm)
}
/// The first request of a run that pi-zip planned as cold (P(warm) < 0.5).
fn cold_plan() -> F<R> {
    atom("cold_plan", |r: &R, i, _| r.tick(i).n == 0 && r.st[i].believed_cold)
}
/// The decision behind what this request carries new was made believing the cache warm (P(warm) >= 0.5).
fn planned_warm() -> F<R> {
    atom("planned_warm", |r: &R, i, _| r.decision_for(i).is_some_and(|g| g.p >= 0.5))
}
/// Something happened outside pi-zip's requests since the previous request (switch, restart, foreign compaction, recall, a
/// summary prepared while away).
fn env_event() -> F<R> {
    atom("env_event", |r: &R, i, _| !r.tick(i).env.is_empty())
}
/// This request starts with the previous request's messages, byte for byte.
fn prefix_kept() -> F<R> {
    atom("prefix_kept", |r: &R, i, _| r.prefix_kept(i))
}
/// What turn_end persisted after this request equals what this request sent (the projection Pi builds next starts with it).
fn persisted_as_sent() -> F<R> {
    atom("persisted_as_sent", |r: &R, i, _| r.tick(i).persist_ok != Some(false))
}
/// A fresh pi process, given the same session and clock, sends the same first request of this run.
fn fresh_plans_alike() -> F<R> {
    atom("fresh_plans_alike", |r: &R, i, _| r.tick(i).fresh.as_ref().is_none_or(|f| f.same))
}
/// Nothing is lost at this request: every message other than a folded output or a summary is sent byte for byte, every output
/// the model does not see verbatim comes back byte for byte from zip_recall, a request pi-zip summarised away is quoted verbatim,
/// the system prompt is intact.
fn nothing_lost() -> F<R> {
    atom("nothing_lost", |r: &R, i, _| lossless_issues(r, i).is_empty())
}
/// No edit planned at this request folds an output zip_recall returned, or a zip_recall result.
fn recall_kept() -> F<R> {
    atom("recall_kept", |r: &R, i, _| refolded_recalls(r, i).is_empty())
}
/// Every edit planned at this request respects the protection windows.
fn protection_respected() -> F<R> {
    atom("protection_respected", |r: &R, i, _| protection_breaches(r, i).is_empty())
}
/// At every decision point of this request, the plan at a lower P(warm) dominates the plan at a higher one.
fn monotone_in_p() -> F<R> {
    atom("monotone_in_p", |r: &R, i, _| monotonicity_breaches(r, i).is_empty())
}
/// The decision behind this request's new edit pays for everything it causes, in the law's own model (the summary call included),
/// or was made at a cache believed gone.
fn pays_or_cold() -> F<R> {
    atom("pays_or_cold", |r: &R, i, _| pays_fully(r, i).is_ok())
}
/// The user waited for a summary model call before this request (interactive mode).
fn user_waits() -> F<R> {
    atom("user_waits", |r: &R, i, _| r.trace.world.interactive && (r.tick(i).wait_run > 0 || (i > 0 && r.tick(i - 1).wait_te > 0)))
}
/// The summary the user waited for was planned at a warm cache (the valve: at a warm return's run plan or at a turn_end).
fn valve_summary() -> F<R> {
    atom("valve_summary", |r: &R, i, _| r.decision_for(i).is_some_and(|g| g.p >= 0.5))
}
/// The model was switched since the previous request: the cache dies at the prompt, nothing could be prepared while away.
fn switched() -> F<R> {
    atom("switched", |r: &R, i, _| r.tick(i).env.iter().any(|e| e == "switch"))
}
/// The decision behind this request was at or above Pi's compaction room.
fn at_room() -> F<R> {
    atom("at_room", |r: &R, i, _| r.decision_for(i).and_then(|g| g.actual()).and_then(|p| p.before).is_some_and(|b| b >= r.st[i].room))
}
/// No new information since the cold plan frozen in i0: no switch, foreign compaction, recall or class change, the session grew
/// by at most DELTA tokens, and no new cold return took over.
fn quiet_since_i0() -> F<R> {
    atom("quiet_since_i0", |r: &R, i, env: &Env| {
        let i0 = lookup(env, "i0") as usize;
        i == i0 || (r.st[i].new_info.is_empty() && !r.st[i].cold_start && (i0 + 1..=i).map(|m| r.st[m].appended).sum::<f64>() <= DELTA)
    })
}
fn after_i0() -> F<R> {
    atom("after_i0", |_r: &R, i, env: &Env| i > lookup(env, "i0") as usize)
}
fn index() -> Term<R> {
    term("i", |_r: &R, i, _| i as f64)
}
/// The summary at this request removes something: the prefix it replaces, minus the previous summary it carries forward, is at
/// least the new summary, and the context before it is above the irreducible floor (system prompt, previous summary, protected
/// turns) by more than a minimal summary.
fn summary_worth_it() -> F<R> {
    atom("summary_worth_it", |r: &R, i, _| summary_waste(r, i).is_none())
}
/// The cold plan reaches the cold target, or something the spec allows stops it: the protected turns and the previous summary
/// alone exceed it, or the law refused the summary.
fn target_reached_or_excused() -> F<R> {
    atom("target_reached_or_excused", |r: &R, i, _| target_miss(r, i).is_none())
}
/// The bridge's provider found the cache warm exactly when the spec's cache is warm.
fn world_agrees() -> F<R> {
    atom("world_agrees", |r: &R, i, _| r.tick(i).warm == r.st[i].warm)
}
/// Every law evaluation recorded at this request equals the spec's law (law.rs) on the same inputs.
fn law_as_specified() -> F<R> {
    atom("law_as_specified", |r: &R, i, _| law_mismatch(r, i).is_none())
}

// =================================================================================================================================
// The axioms
// =================================================================================================================================
pub fn axioms() -> Vec<Prop> {
    vec![
        Prop {
            id: "A1",
            name: "nothing is lost",
            from: &[],
            why: "README rule 1: the session is the source of truth; only the view changes; folded outputs come back byte for byte.",
            evidence: Evidence::Conformance,
            f: always(nothing_lost()),
        },
        Prop {
            id: "A2",
            name: "edit only when the cache is gone or the edit pays",
            from: &[],
            why: "README rule 2: every new edit was planned at a cache believed gone, or the law's own model says it pays for every cost it causes.",
            evidence: Evidence::Conformance,
            f: always(zip_edit() >> pays_or_cold()),
        },
        Prop {
            id: "A3",
            name: "never in the way",
            from: &[],
            why: "README rule 3: a summary model call is prepared while the user is away; the user waits for one only at Pi's compaction room \
                  or in the warm valve (rule 3 allows a valve summary, priced by the same inequality: A2 checks it pays), or at a \
                  return the model switch made cold (no away time to prepare it in).",
            evidence: Evidence::Conformance,
            f: always(user_waits() >> (at_room() | valve_summary() | switched())),
        },
    ]
}

// =================================================================================================================================
// Derived properties
// =================================================================================================================================
pub fn derived() -> Vec<Prop> {
    vec![
        Prop {
            id: "I1",
            name: "run stability",
            from: &["A2"],
            why: "a request that changes bytes the previous one sent rewrites the cache; inside a run only a new, priced edit may do that, \
                  and what turn_end persists must be what was sent (else the next request rewrites for nothing).",
            evidence: Evidence::Conformance,
            f: always((!run_start() & !zip_edit() & !env_event()) >> prefix_kept()) & always(persisted_as_sent()),
        },
        Prop {
            id: "RD",
            name: "restart determinism",
            from: &["A2", "A3"],
            why: "decisions are functions of the session: a restart must not plan differently (else the law, the b2b rule and the \
                  one-summary rule are evaluated on state the session does not carry).",
            evidence: Evidence::Conformance,
            f: always(run_start() >> fresh_plans_alike()),
        },
        Prop {
            id: "RC",
            name: "recall is never refolded",
            from: &["A1", "A2"],
            why: "a recalled output is what the model asked for; folding it again hides it (A1) and invites the same recall, \
                  each time a rewrite (A2).",
            evidence: Evidence::Conformance,
            f: always(recall_kept()),
        },
        Prop {
            id: "PW",
            name: "protection windows",
            from: &["A1"],
            why: "the model works on the latest two user turns: their outputs fold only when re-readable in the previous turn at a \
                  cold return or after the declared TTL, or when 60 requests old; a summary never cuts into them.",
            evidence: Evidence::Conformance,
            f: always(protection_respected()),
        },
        Prop {
            id: "B2B",
            name: "no back-to-back warm rewrites",
            from: &["A2"],
            why: "a rewrite planned at a warm cache right after a rewrite pays the cache write twice for one saving (a return pi-zip \
                  believes cold is excused here, as in A2: learning the cache's real lifetime is outside this spec).",
            evidence: Evidence::Conformance,
            f: always(zip_edit() >> !next(zip_edit() & cache_warm() & planned_warm())),
        },
        Prop {
            id: "MP",
            name: "monotone in P(warm)",
            from: &["A2"],
            why: "an edit is never cheaper at a warm cache than at a cold one: whatever fires at P must fire, or be dominated, at \
                  every lower P, with the same prices and context.",
            evidence: Evidence::Conformance,
            f: always(monotone_in_p()),
        },
        Prop {
            id: "NR",
            name: "time consistency (no regret)",
            from: &["A2", "A3"],
            why: "an edit is free at a cold cache and paid at a warm one: a warm edit within K_REGRET requests of a cold plan, with no \
                  new information (switch, foreign compaction, recall, class change, growth > DELTA) in between, means the cold plan \
                  was dominated by doing that edit then.",
            evidence: Evidence::Conformance,
            f: always(cold_plan() >> freeze("i0", index(), !quiet_since_i0().until_within(K_REGRET, after_i0() & zip_edit() & planned_warm()))),
        },
        Prop {
            id: "NT",
            name: "no thrash",
            from: &["A2", "A3"],
            why: "at most one summary per warm stretch as pi-zip believes it (a stretch ends at a return planned cold; learning that a cache \
                  outlives its declared TTL is outside this spec) unless at Pi's compaction room; and never a \
                  summary that removes nothing (below the irreducible floor, or a prefix that is mostly the previous summary).",
            evidence: Evidence::Conformance,
            f: always(zip_summary() >> !next((!cold_plan()).until(zip_summary() & !cold_plan() & !at_room()))) & always(zip_summary() >> summary_worth_it()),
        },
        Prop {
            id: "TR",
            name: "target reachability",
            from: &["A2"],
            why: "a cold return is the one free rewrite: it must reach the cold target unless the protected turns forbid it or the law \
                  refuses the summary call.",
            evidence: Evidence::Conformance,
            f: always(cold_plan() >> target_reached_or_excused()),
        },
        Prop {
            id: "LW",
            name: "the law as specified",
            from: &["A2"],
            why: "the economic lemmas (README: M, E, G, C, S) are proven for law.rs; this checks that every law evaluation of the real \
                  planner is law.rs on the same inputs, so the proofs apply to it.",
            evidence: Evidence::Proven,
            f: always(law_as_specified()),
        },
        Prop {
            id: "G",
            name: "the P-grid probe reproduces the real decision",
            from: &[],
            why: "sanity of the harness: re-planning with the captured options at the actual P gives the plan run.ts acted on \
                  (so MP, A2, PW, RC, LW judge the real decisions).",
            evidence: Evidence::Conformance,
            f: always(atom("probe_faithful", |r: &R, i, _| probe_mismatch(r, i).is_none())),
        },
        Prop {
            id: "W",
            name: "the bridge's world is the spec's world",
            from: &[],
            why: "sanity of the harness: the provider the bridge simulates keeps the cache exactly as the spec's clock and TTL say.",
            evidence: Evidence::Conformance,
            f: always(world_agrees()),
        },
    ]
}

pub fn all() -> Vec<Prop> {
    let mut v = axioms();
    v.extend(derived());
    v
}

// =================================================================================================================================
// The predicates behind the atoms (each returns what is wrong, for the counterexample report)
// =================================================================================================================================

pub fn lossless_issues(r: &R, i: usize) -> Vec<String> {
    r.tick(i).lossless.clone()
}

fn recalled_before(r: &R, i: usize, at: &str) -> BTreeSet<String> {
    r.blocks
        .iter()
        .filter(|b| b.recover == Recover::RecallResult && (b.req < i as i64 || (at == "turn_end" && b.req == i as i64)))
        .filter_map(|b| b.recall_of.clone())
        .collect()
}

pub fn refolded_recalls(r: &R, i: usize) -> Vec<String> {
    let mut bad = Vec::new();
    for g in r.grids(i) {
        let Some(p) = g.actual().filter(|p| p.edits()) else { continue };
        let rec = recalled_before(r, i, &g.at);
        for f in &p.folds {
            if rec.contains(f) {
                bad.push(format!("{} folds {f}, an output zip_recall returned", g.at));
            }
            if r.block(f).is_some_and(|b| b.recover == Recover::RecallResult) {
                bad.push(format!("{} folds {f}, a zip_recall result", g.at));
            }
        }
    }
    bad
}

pub fn protection_breaches(r: &R, i: usize) -> Vec<String> {
    let mut bad = Vec::new();
    for g in r.grids(i) {
        let Some(p) = g.actual().filter(|p| p.edits()) else { continue };
        let u = r.st[i].user_turns;
        if u < 1 {
            continue;
        }
        let prev = u.saturating_sub(1);
        for f in &p.folds {
            let Some(b) = r.block(f) else { continue };
            if b.turn + 1 < u {
                continue; // outside the window
            }
            let age = r.age_at(b, i, &g.at);
            let relax_ok = b.turn == prev && prev >= 1 && b.recover == Recover::Rereadable && (g.mode == "cold" || g.past_ttl);
            if age < INTURN_AGE && !relax_ok {
                bad.push(format!("{} folds {f} (turn {}, {:?}, age {age}) inside the protected turns {}..{u} ({} plan, pastTtl {})", g.at, b.turn, b.recover, prev.max(1), g.mode, g.past_ttl));
            }
        }
        if let Some(cut) = &p.cut {
            let first_protected = r.blocks.iter().position(|b| b.kind == "user" && b.turn == prev.max(1));
            // a lookahead cut (F2) may lie inside the previous turn, up to that turn's final answer (its last assistant message)
            let final_answer = r.blocks.iter().rposition(|b| b.kind == "assistant" && b.turn == prev);
            if let (Some(c), Some(fp)) = (r.order(cut), first_protected) {
                let ahead_ok = p.ahead && g.mode == "cold" && final_answer.is_some_and(|fa| c <= fa);
                if u >= 2 && c > fp && !ahead_ok {
                    bad.push(format!("{} summary keeps from {cut}, after the start of protected turn {prev}{}", g.at, if p.ahead { " (a lookahead cut past the turn's final answer)" } else { "" }));
                }
            }
        }
    }
    bad
}

/// Everything plan q edits, plan p edits too (a fold or a summary at least as far).
fn covers(r: &R, p: &GridPt, q: &GridPt) -> bool {
    let cut_p = p.cut.as_deref().and_then(|c| r.order(c));
    let folded = |f: &String| p.folds.contains(f) || matches!((cut_p, r.order(f)), (Some(c), Some(o)) if o < c);
    q.folds.iter().all(folded)
        && match q.cut.as_deref().and_then(|c| r.order(c)) {
            None => true,
            Some(cq) => cut_p.is_some_and(|cp| cp >= cq),
        }
}

/// Plan p (lower P) dominates plan q (higher P): it edits everything q edits, or it leaves a context no larger than q's, or it
/// reaches the cold target (the planner's goal: a cold plan that gets there with fewer, lossless edits is the better plan).
pub fn dominates(r: &R, i: usize, p: &GridPt, q: &GridPt) -> bool {
    p.plan
        && (covers(r, p, q)
            || matches!((p.after, q.after), (Some(x), Some(y)) if x <= y * (1.0 + 1e-3) + 1.0)
            || p.after.is_some_and(|x| x <= r.st[i].target * (1.0 + TOL)))
}

pub fn monotonicity_breaches(r: &R, i: usize) -> Vec<String> {
    let mut bad = Vec::new();
    for g in r.grids(i) {
        let pts: Vec<&GridPt> = g.grid.iter().filter(|x| x.error.is_none()).collect();
        for (a, q) in pts.iter().enumerate() {
            if !q.edits() {
                continue;
            }
            for p in pts[..a].iter().filter(|p| p.p < q.p) {
                let dominated = dominates(r, i, p, q);
                if !dominated {
                    bad.push(format!(
                        "{} at P={}: {} (folds {}, summary {}, after {:.0}); at P={}: {} (folds {}, summary {}, after {:.0}; law {})",
                        g.at,
                        q.p,
                        q.mode,
                        q.folds.len(),
                        q.cut.is_some(),
                        q.after.unwrap_or(f64::NAN),
                        p.p,
                        if p.plan { p.mode.as_str() } else { "no plan" },
                        p.folds.len(),
                        p.cut.is_some(),
                        p.after.unwrap_or(f64::NAN),
                        p.law.iter().map(|l| format!("{} {} B={:.0} A={:.0} K={:.0}", l.at, if l.ok { "ok" } else { "refused" }, l.b, l.a, l.k.unwrap_or(f64::NAN))).collect::<Vec<_>>().join(", ")
                    ));
                    break;
                }
            }
        }
    }
    bad
}

fn prices(g: &Grid) -> Option<Prices> {
    g.pr.as_ref().filter(|p| p.r > 0.0).map(|p| Prices { r: p.r, w: p.w, out: p.out })
}

/// Ok(()) when the decision behind request i's new edit was cold, or pays in full in the law's own model; Err(why) otherwise.
pub fn pays_fully(r: &R, i: usize) -> Result<(), String> {
    let Some(g) = r.decision_for(i) else { return Err("an edit no decision point explains".into()) };
    if g.p < 0.5 {
        return Ok(());
    }
    let Some(pt) = g.actual() else { return Err("no actual plan in the decision".into()) };
    let Some(pr) = prices(g) else { return Ok(()) }; // legacy rule (class unknown): nothing to price
    let Some(step) = pt.law.iter().find(|s| s.at == "plan") else { return Err("a warm edit without a law evaluation".into()) };
    // the summary call at what it really costs: the conversation it reads (the prefix without the carried previous summary), uncached
    let carried = if i > 0 { r.st[i - 1].prev_sum } else { 0.0 };
    let call = if pt.cut.is_some() { summary_call(pr, pt.prefix - carried, pt.sum) } else { 0.0 };
    let room = Some(r.st[i].room);
    let t = law(step.b, step.a, g.p, room, Some(pr), g.g.unwrap_or(2500.0), call, step.a);
    if t.ok {
        Ok(())
    } else {
        Err(format!(
            "{} plan at P={}: B={:.0} A={:.0}{}; K={:.0} with the summary call {:.0}, gain {:.0}: the law's own model says it costs {:.0} more than not editing",
            g.at,
            g.p,
            step.b,
            step.a,
            if pt.cut.is_some() { format!(", summary of {:.0} into {:.0}", pt.prefix, pt.sum) } else { String::new() },
            t.k,
            call,
            t.gain,
            t.k - t.gain
        ))
    }
}

pub fn summary_waste(r: &R, i: usize) -> Option<String> {
    let g = r.decision_for(i)?;
    let p = g.actual()?;
    let cut = p.cut.as_deref()?;
    if i == 0 {
        return None;
    }
    let co = r.order(cut)?;
    // what the cut removes, as the previous request sent it: everything before the cut except the system prompt (Pi replays it
    // at the head of every compacted projection) and the previous summary (the new one carries it forward)
    let prev = &r.tick(i - 1).view;
    let carried: f64 = prev.iter().filter(|m| m.sum.is_some()).map(|m| m.tok).sum();
    let removed: f64 = prev.iter().filter(|m| m.role != "system" && m.sum.is_none() && m.id.as_deref().and_then(|id| r.order(id)).is_some_and(|o| o < co)).map(|m| m.tok).sum();
    if removed < p.sum * (1.0 - TOL) {
        return Some(format!(
            "the summary replaces {removed:.0} tokens of conversation (besides the system prompt and {carried:.0} of previous summary it carries) with a {:.0}-token summary; the planner counted a prefix of {:.0}",
            p.sum, p.prefix
        ));
    }
    let before = p.after_folds.unwrap_or(p.before.unwrap_or(0.0));
    let floor = r.st[i].floor - r.st[i].prev_sum + carried; // the floor before the cut: system, previous summary, protected turns
    if before <= floor + SUMMARY_FLOOR * r.trace.world.c * (1.0 - TOL) {
        return Some(format!("context {before:.0} is within a minimal summary of the floor {floor:.0}"));
    }
    None
}

pub fn target_miss(r: &R, i: usize) -> Option<String> {
    let s = &r.st[i];
    let g = r.tick(i).grids.iter().find(|g| g.at == "run")?;
    if s.view_tok <= s.target * (1.0 + TOL_TARGET) {
        return None;
    }
    if s.floor + SUMMARY_FLOOR * r.trace.world.c >= s.target * (1.0 - TOL) {
        return None; // the protected turns and the previous summary alone fill the target
    }
    let refused = g.actual().is_some_and(|p| p.law.iter().any(|l| l.at == "summary" && !l.ok));
    let legacy = g.pr.as_ref().is_none_or(|p| p.r.is_nan() || p.r <= 0.0); // class unknown: the legacy summary rule decides
    if refused || legacy {
        return None;
    }
    Some(format!("cold plan leaves {:.0} tokens, target {:.0}, floor {:.0}, and no law refused a summary", s.view_tok, s.target, s.floor))
}

pub fn probe_mismatch(r: &R, i: usize) -> Option<String> {
    let t = r.tick(i);
    let set = |v: &[String]| v.iter().cloned().collect::<BTreeSet<_>>();
    if let (Some(rp), Some(g)) = (&t.run_plan, t.grids.iter().find(|g| g.at == "run")) {
        if !rp.native && r.ledger(i, "guard_drop").is_empty() {
            let pt = g.actual()?;
            let (f, c) = if pt.plan { (set(&pt.folds), pt.cut.clone()) } else { (BTreeSet::new(), None) };
            if f != set(&rp.folds) || c != rp.cut {
                return Some(format!("run plan: real folds {:?} cut {:?}, probe folds {:?} cut {:?}", rp.folds, rp.cut, f, c));
            }
        }
    }
    if t.te_valve {
        let g = t.grids.iter().find(|g| g.at == "turn_end")?;
        let pt = g.actual()?;
        let real_f: BTreeSet<String> = t.drafts.iter().filter(|d| d["type"] == "context_edit").filter_map(|d| d["target"].as_str().map(String::from)).collect();
        let real_c = t.drafts.iter().find(|d| d["type"] == "compaction").and_then(|d| d["firstKept"].as_str().map(String::from));
        if real_f != set(&pt.folds) || real_c != pt.cut {
            return Some(format!("valve: real folds {real_f:?} cut {real_c:?}, probe folds {:?} cut {:?}", pt.folds, pt.cut));
        }
    }
    None
}

/// Every recorded law step is law.rs on the same inputs. The plan step has no call: compared exactly (ok and K). A summary step's call
/// is a pricing choice of each version (0.2.8: w X + out S; coldwarm F3: the narrative's real input and output): it is backed out of
/// K and must be >= 0, and the step's verdict must be law.rs's with that call.
pub fn law_mismatch(r: &R, i: usize) -> Option<String> {
    for g in r.grids(i) {
        let Some(pr) = prices(g) else { continue };
        let gg = g.g.unwrap_or(2500.0);
        for pt in &g.grid {
            for s in &pt.law {
                let t = s.t.unwrap_or(s.a);
                let call = match (s.at.as_str(), s.k) {
                    ("summary", Some(k)) => call_of(pr, s.b, s.a, pt.p, t, k),
                    _ => 0.0,
                };
                if call < -1e-6 * s.b.max(1.0) {
                    return Some(format!("{} {} at P={}: a negative call term {call:.1}", g.at, s.at, pt.p));
                }
                let room = if s.at == "summary" { None } else { Some(r.st[i].room) };
                let m = law(s.b, s.a, pt.p, room, Some(pr), gg, call, t);
                let k_ok = match s.k {
                    Some(k) => m.k.is_finite() && (k - m.k).abs() <= 1e-6 * k.abs().max(1.0),
                    None => !m.k.is_finite(),
                };
                if m.ok != s.ok || !k_ok {
                    return Some(format!("{} {} at P={}: recorded ok={} K={:?}, spec ok={} K={:.3}", g.at, s.at, pt.p, s.ok, s.k, m.ok, m.k));
                }
            }
        }
    }
    None
}

/// Why a property fails at position i, in words (for the counterexample report).
pub fn explain(id: &str, r: &R, i: usize) -> Vec<String> {
    match id {
        "A1" => lossless_issues(r, i),
        "A2" => pays_fully(r, i).err().into_iter().collect(),
        "A3" => vec![format!(
            "the user waits for a summary call ({}) below Pi's compaction room {:.0}",
            if r.tick(i).wait_run > 0 { "run plan" } else { "valve at the previous turn_end" },
            r.st[i].room
        )],
        "RC" => refolded_recalls(r, i),
        "PW" => protection_breaches(r, i),
        "MP" => monotonicity_breaches(r, i),
        "NT" => summary_waste(r, i).into_iter().collect(),
        "TR" => target_miss(r, i).into_iter().collect(),
        "LW" => law_mismatch(r, i).into_iter().collect(),
        "G" => probe_mismatch(r, i).into_iter().collect(),
        "RD" => r
            .tick(i)
            .fresh
            .as_ref()
            .map(|f| {
                let z = if i > 0 { r.tick(i - 1).zip.clone() } else { Default::default() };
                vec![format!(
                    "live process sends {} messages ({} pi-zip edits), a fresh process {} ({} edits); in-memory state a restart loses: \
                     growth g {:.0} (fresh: 2500), justEdited {}, summarizedWarm {}; fresh plan: {}",
                    f.live,
                    f.live_mods,
                    f.fresh,
                    f.fresh_mods,
                    z.g.unwrap_or(f64::NAN),
                    z.just_edited,
                    z.summarized_warm,
                    f.fresh_plan.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ")
                )]
            })
            .unwrap_or_default(),
        "I1" => {
            let t = r.tick(i);
            if t.persist_ok == Some(false) {
                vec!["turn_end persisted something other than what the request sent".into()]
            } else {
                vec!["the request does not start with the previous request's bytes, and no new edit explains it".into()]
            }
        }
        _ => vec![],
    }
}

// =================================================================================================================================
// Counterexample classes: which mechanism broke the property (one minimal counterexample is kept per class)
// =================================================================================================================================
/// A restart happened between requests a (exclusive) and b (inclusive).
fn restart_between(r: &R, a: usize, b: usize) -> bool {
    (a + 1..=b.min(r.obs.ticks.len() - 1)).any(|m| r.tick(m).env.iter().any(|e| e == "restart"))
}

/// The mechanism of an MP breach between plan p (lower P) and q (higher P) at a decision point.
fn mp_mechanism(g: &Grid, p: &GridPt, q: &GridPt) -> String {
    let p_sum_refused = p.law.iter().find(|l| l.at == "summary" && !l.ok);
    let q_gated = q.law.iter().any(|l| l.at == "summary");
    if q.cut.is_some() && p.cut.is_none() && !q_gated && p_sum_refused.is_some() {
        return format!("{}: B1, the warm summary skips the summary gate the cold one fails", g.at);
    }
    if let Some(l) = p_sum_refused {
        if q.cut.is_some() && l.b < q.prefix {
            return format!("{}: smallest cut only: the lower-P summary of the minimal cut is refused, a deeper cut pays (plan.ts summarise pick)", g.at);
        }
    }
    if !p.plan && p.law.iter().any(|l| l.at == "summary" && l.ok) && p.law.iter().any(|l| l.at == "plan" && !l.ok) {
        return format!("{}: the summary voids better folds and the plan gate then refuses all; no folds-only fallback (plan.ts:716)", g.at);
    }
    if !p.plan && p.mode == "cold" && p.p > 0.0 && p.law.iter().any(|l| l.at == "plan" && !l.ok) {
        return format!("{}: cold mode at 0 < P < 0.5: the plan gate refuses the folds, no fallback to the warm plan's summary (plan.ts:716)", g.at);
    }
    if p.ahead || q.ahead {
        return format!("{}: lookahead (F2) changes the plan with the mode", g.at);
    }
    format!("{}: {}", g.at, if p.plan { "fewer edits at the lower P" } else { "no plan at the lower P" })
}

/// Counterexample classes: which mechanism broke the property (one minimal counterexample is kept per class). The names are the
/// rows of TRIAGE.md.
pub fn classify(id: &str, r: &R, v: &Violation) -> String {
    match id {
        "NR" => {
            let i0 = v.at;
            let Some(&j) = v.witnesses.iter().filter(|&&w| w > i0).max() else { return "other".into() };
            let cold = r.tick(i0).grids.iter().find(|g| g.at == "run").and_then(|g| g.actual());
            let Some(wg) = r.decision_for(j) else { return "other".into() };
            let Some(w) = wg.actual() else { return "other".into() };
            let restart = restart_between(r, i0.saturating_sub(1), j) || r.tick(i0).env.iter().any(|e| e == "restart");
            let refused = cold.and_then(|p| p.law.iter().find(|l| l.at == "summary" && !l.ok));
            let u0 = r.st[i0].user_turns;
            if restart && w.cut.is_some() && !matches!(refused, Some(l) if l.b < w.prefix) {
                return "warm summary after a restart reset the growth g (run.ts g = G0)".into();
            }
            if w.cut.is_none() {
                let slid = w.folds.iter().filter_map(|f| r.block(f)).any(|b| b.turn + 1 >= u0);
                return if slid { "window slide, folds: outputs protected at the cold plan are folded warm a prompt later (B2 for folds)".into() } else { "warm folds a cold plan left".into() };
            }
            let cut = w.cut.as_deref().and_then(|c| r.order(c)).unwrap_or(0);
            let slid = r.blocks.iter().take(cut).any(|b| b.kind != "system" && b.turn + 1 >= u0);
            let gated = w.law.iter().any(|l| l.at == "summary");
            match (slid, refused) {
                (true, _) if !gated => "window slide, summary (B2): the cold plan could not cut into the protected turns, the warm valve did a prompt later".into(),
                (_, Some(_)) if !gated => "B1: the cold summary gate refused, the warm summary skipped the gate".into(),
                (_, Some(l)) if l.b < w.prefix => "smallest cut only: the cold plan's minimal-cut summary was refused, the warm valve's deeper cut paid".into(),
                (true, _) if restart => "window slide, summary (B2), after a restart reset the growth g".into(),
                (true, _) => "window slide, summary (B2): the cold plan could not cut into the protected turns, the warm valve did a prompt later".into(),
                _ => "warm summary a cold plan could have made".into(),
            }
        }
        "MP" => {
            for g in r.grids(v.at) {
                let pts: Vec<&GridPt> = g.grid.iter().filter(|x| x.error.is_none()).collect();
                for (a, q) in pts.iter().enumerate() {
                    if !q.edits() {
                        continue;
                    }
                    if let Some(p) = pts[..a].iter().filter(|p| p.p < q.p).find(|p| !dominates(r, v.at, p, q)) {
                        return mp_mechanism(g, p, q);
                    }
                }
            }
            "other".into()
        }
        "A2" => match r.decision_for(v.at).and_then(|g| g.actual().map(|p| (g, p))) {
            Some((g, p)) if p.cut.is_some() && p.law.iter().any(|l| l.at == "summary") => {
                format!("{}: summary gate and plan gate pass separately, the call is not in the plan gate (plan.ts:716 call = 0)", g.at)
            }
            Some((g, p)) if p.cut.is_some() => format!("{}: B1, a warm summary whose call no gate prices", g.at),
            Some((g, _)) => format!("{}: warm folds that do not pay", g.at),
            None => "an unexplained edit".into(),
        },
        "A3" => {
            let t = r.tick(v.at);
            let env = &t.env;
            let gap = t.gap.unwrap_or(0.0);
            let ttl = r.trace.world.ttl as f64;
            if env.iter().any(|e| e == "switch") {
                "cold return by a model switch (nothing to foresee while away)".into()
            } else if env.iter().any(|e| e == "foreign") {
                "cold return after a foreign compaction".into()
            } else if gap < 0.8 * ttl {
                "cold return before the away timer could fire".into()
            } else if env.iter().any(|e| e == "restart") {
                "cold return after a restart: the resumed process never armed the away timer".into()
            } else if env.iter().any(|e| e == "away-summary") {
                "cold return: an away summary was prepared but not used".into()
            } else if r.decision_for(v.at).is_some_and(|g| g.actual().is_some_and(|p| p.ahead)) {
                "cold return: a lookahead summary no away timer prepared".into()
            } else {
                "cold return: no away summary was prepared".into()
            }
        }
        "RD" => match r.tick(v.at).fresh.as_ref() {
            Some(f) if !f.fixed_by.is_empty() => format!("in-memory state a restart loses: {}", f.fixed_by.join("+")),
            Some(f) if f.fixed_by_all => "in-memory state a restart loses: several fields together".into(),
            Some(_) => "not explained by the transplanted in-memory state".into(),
            None => "other".into(),
        },
        "B2B" | "NT" => {
            let j = v.witnesses.iter().copied().max().unwrap_or(v.at);
            if summary_waste(r, v.at).is_some() {
                "a summary that removes (almost) nothing".into()
            } else if restart_between(r, v.at, j) {
                format!("a restart in between loses {}", if id == "B2B" { "justEdited" } else { "summarizedWarm" })
            } else if id == "NT" {
                "two summaries in one warm stretch".into()
            } else {
                "two warm rewrites in a row".into()
            }
        }
        "TR" => {
            let i = v.at;
            let believed = r.tick(i).grids.iter().find(|g| g.at == "run").and_then(|g| g.actual()).and_then(|p| if p.plan { p.after } else { p.before });
            let t = r.st[i].target * (1.0 + TOL_TARGET);
            match believed {
                Some(b) if b <= t => format!("calibration: the plan believed it left {:.0}K (target {:.0}K), the request was {:.0}K (plan.ts calibrate `carried`)", b / 1e3, r.st[i].target / 1e3, r.st[i].view_tok / 1e3),
                _ => "the cold plan stops above the target by its own estimate".into(),
            }
        }
        "PW" => {
            let ahead = r.grids(v.at).iter().any(|g| g.actual().is_some_and(|p| p.ahead));
            if ahead { "a lookahead cut past the previous turn's final answer".into() } else { "edit inside the protected turns".into() }
        }
        _ => String::new(),
    }
}
