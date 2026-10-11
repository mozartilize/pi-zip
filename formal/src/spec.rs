//! # The pi-zip specification
//!
//! Read this file like the README's "three rules". The state machine it talks about is in `model.rs` (blocks with kind, size,
//! user turn, recoverability and folded / summarised / recalled state; the cache with class, TTL and warm/cold; the clock; the
//! events). Every property is a formula of the bounded temporal logic in `logic.rs`, evaluated over every request of a run
//! (position i = the i-th request pi-zip let go out).
//!
//! The three axioms come first. Every other property is derived from them: it names the axiom(s) it refines and says why.
//! Constants: K_REGRET requests and DELTA tokens bound "soon" and "no new information".
use crate::law::{call_of, class_prices, law, summary_call, Prices};
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
    atom("fresh_plans_alike", |r: &R, i, _| r.tick(i).fresh.as_ref().is_none_or(|f| f.same || f.deferred_same))
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
fn pays() -> F<R> {
    atom("pays", |r: &R, i, _| pays_fully(r, i).is_ok())
}
/// The user waited for a summary model call before this request (interactive mode).
fn user_waits() -> F<R> {
    atom("user_waits", |r: &R, i, _| r.trace.world.interactive && (r.tick(i).wait_run > 0 || (i > 0 && r.tick(i - 1).wait_te > 0)))
}
/// The summary the user waited for was planned warm (P(warm) >= 0.5): a warm return's run plan or the warm valve at a turn_end.
/// Round 5 excuses it only together with bg_budget_spent (rule B's fallback to 0.3.0).
fn warm_summary() -> F<R> {
    atom("warm_summary", |r: &R, i, _| r.decision_for(i).is_some_and(|g| g.p >= 0.5))
}
/// Round 5: the live process's warm plan at this return cut where a summary it held in memory (written in the background) cuts, the
/// law accepting that cut (run.ts pinned, the anti-thrash rule). A restarted process has lost that summary and makes its unpinned plan.
pub fn pinned_live(r: &R, i: usize) -> bool {
    r.ledger(i, "pin").iter().any(|p| p.get("ok").and_then(serde_json::Value::as_bool) == Some(true) && matches!(p.get("where").and_then(serde_json::Value::as_str), Some("run") | Some("native")))
}
/// Round 5 (rules A/B): a summary pi-zip started in the background for a warm return or a warm turn_end was dropped unused in this
/// warm stretch (since the last return planned cold), up to this request. Then the stretch's bound of one unused background summary is
/// spent, and a warm summary whose cut moved is written while the user waits, as in 0.3.0.
fn bg_budget_spent() -> F<R> {
    atom("bg_budget_spent", |r: &R, i, _| {
        for j in (0..=i).rev() {
            if r.tick(j).unused_ab > 0 {
                return true;
            }
            if r.tick(j).n == 0 && r.st[j].believed_cold {
                return false;
            }
        }
        false
    })
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
/// The session grew by at most DELTA real tokens up to and including this request's own: a plan made for request i (a run plan at the
/// prompt, a turn_end valve after the response of request i - 1) has seen what was appended at i, so growth that arrives with the
/// witness request is information the plan had, not just what came before it.
fn quiet_through_i() -> F<R> {
    atom("quiet_through_i", |r: &R, i, env: &Env| {
        let i0 = lookup(env, "i0") as usize;
        i <= i0 || (i0 + 1..=i).map(|m| r.st[m].appended).sum::<f64>() <= DELTA
    })
}
/// The edit is not excused by Pi's compaction room. The context the plan for this request saw (the previous request's view plus what
/// was appended) is below the room, or it is at or above it but the cold plan's own request (frozen in i0) already sent a context at or
/// above the room: then the cold plan had left the room unmet and nothing since pushed the context there. Only growth after a cold plan
/// that sent less than the room excuses a warm edit at the room (review P2-1: the earlier form, "at the room, whatever the cold plan
/// left", hid regrets of the cold plan itself).
fn not_pushed_to_room() -> F<R> {
    atom("not_pushed_to_room", |r: &R, i, env: &Env| {
        let i0 = lookup(env, "i0") as usize;
        i == 0 || r.st[i - 1].view_tok + r.st[i].appended < r.st[i].room || r.st[i0].view_tok >= r.st[i0].room
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
/// Every law evaluation recorded at this request equals the spec's law (law.rs) on the same inputs, at the class ratios.
fn law_as_specified() -> F<R> {
    atom("law_as_specified", |r: &R, i, _| law_mismatch(r, i).is_none())
}
/// The first request of a run after the cache is gone (a model switch; or the declared TTL and the kept TTL both passed since the
/// last response or refresh) is planned cold, and a return after the declared TTL is marked past it.
fn gone_is_cold() -> F<R> {
    atom("gone_is_cold", |r: &R, i, _| gone_but_warm(r, i).is_none())
}
/// A new edit planned warm comes from a context above the cold target.
fn warm_above_target() -> F<R> {
    atom("warm_above_target", |r: &R, i, _| warm_below_target(r, i).is_none())
}
/// On an automatic prefix cache no new fold starts inside the first MIN_EXPECT real tokens of the request.
fn head_kept() -> F<R> {
    atom("head_kept", |r: &R, i, _| head_breach(r, i).is_none())
}
/// The context (after folds) the summary this request carries new started from: the size its decision saw (WL, NT: the
/// one-summary-per-warm-stretch rule lapses once the context has grown back to it). Unknown: never regrown.
fn summary_start() -> Term<R> {
    term("summary_start", |r: &R, i, _| summary_start_at(r, i))
}
/// The decision behind this request's new summary saw a context below the size the stretch's previous summary (frozen in s0)
/// started from: the stretch's one summary has not been paid back by growth yet.
fn not_regrown() -> F<R> {
    atom("not_regrown", |r: &R, i, env: &Env| {
        let s0 = lookup(env, "s0");
        r.decision_for(i).and_then(|g| g.actual()).and_then(|p| p.after_folds).is_none_or(|a| a < s0 * (1.0 - TOL))
    })
}
/// No warm decision at this request withholds a summary the law says pays by a margin, unless the one-summary-per-warm-stretch rule
/// allows it; and every warm turn_end asks the valve.
fn warm_summary_not_withheld() -> F<R> {
    atom("warm_summary_not_withheld", |r: &R, i, _| withheld(r, i).is_none())
}
/// Residuals: the property's failures at this request that no known root cause (TRIAGE.md (a)) explains.
fn rd_residual() -> F<R> {
    atom("fresh_plans_alike_or_known_cause", |r: &R, i, _| r.tick(i).fresh.as_ref().is_none_or(|f| f.same || f.deferred_same || f.fixed_by_known || pinned_live(r, i)))
}
fn mp_residual() -> F<R> {
    atom("monotone_or_known_cause", |r: &R, i, _| mp_breaches(r, i).iter().all(|(m, _)| MP_KNOWN.iter().any(|k| m.contains(k))))
}
fn a2_residual() -> F<R> {
    atom("pays_or_known_cause", |r: &R, i, _| pays_fully(r, i).is_ok() || A2_KNOWN.iter().any(|k| a2_class(r, i).contains(k)))
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
            why: "README rules 2 and 3: the law's own model, at the class ratios and the request's real sizes, says the edit pays for \
                  every cost it causes, the summary call included; at a cache believed gone (P < 0.5) folds are free (lemma C) and a \
                  summary still pays its call at its own margin.",
            evidence: Evidence::Conformance,
            f: always(zip_edit() >> pays()),
        },
        Prop {
            id: "A3",
            name: "never in the way",
            from: &[],
            why: "README rule 3: a summary model call is prepared while the user is away, or (round 5, rules A/B) written in the background \
                  while the cache is warm; the user waits for one only at Pi's compaction room, at a return a model switch made cold (no \
                  away time to prepare it in), or for a warm plan (a warm return's run plan, the valve at a turn_end) once the warm \
                  stretch's one unused background summary is spent (the anti-thrash bound: 0.3.0's wait). Otherwise a warm wait is not \
                  excused: the summary is written in the background (rule B).",
            evidence: Evidence::Conformance,
            f: always(user_waits() >> (at_room() | switched() | (warm_summary() & bg_budget_spent()))),
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
                  new information (switch, foreign compaction, recall, class change, growth > DELTA, counted through the witness \
                  request itself: the plan made for it has seen what that request appended; and a context that reached Pi's \
                  compaction room, where the edit is forced) in between, means the cold plan \
                  was dominated by doing that edit then.",
            evidence: Evidence::Conformance,
            f: always(cold_plan() >> freeze("i0", index(), !quiet_since_i0().until_within(K_REGRET, after_i0() & zip_edit() & planned_warm() & quiet_through_i() & not_pushed_to_room()))),
        },
        Prop {
            id: "NT",
            name: "no thrash",
            from: &["A2", "A3"],
            why: "at most one summary per warm stretch as pi-zip believes it (a stretch ends at a return planned cold; learning that a cache \
                  outlives its declared TTL is outside this spec) unless at Pi's compaction room or once the context has grown back to the \
                  size the stretch's summary started from (then a second one gains what the first did: review round 4, P0-1); and never a \
                  summary that removes nothing (below the irreducible floor, or a prefix that is mostly the previous summary).",
            evidence: Evidence::Conformance,
            f: always(zip_summary() >> freeze("s0", summary_start(), !next((!cold_plan()).until(zip_summary() & !cold_plan() & !at_room() & not_regrown())))) & always(zip_summary() >> summary_worth_it()),
        },
        Prop {
            id: "WL",
            name: "a warm summary that pays is not withheld",
            from: &["A2", "A3"],
            why: "completeness (every other property is safety: a pi-zip that never summarises passes them). (a) Every warm turn_end of a \
                  request that did not fail asks the valve (a decision point), unless the request right before carried a fresh edit (b2b) \
                  or the run plan is persisted there. (b) A warm decision the one-summary-per-warm-stretch flag constrained, planned again \
                  with the flag lifted, may withhold a summary whose summary step and whole-plan step (the call priced) the law accepts \
                  with Phi >= 1 + WL_MARGIN only while the rule allows it: a pi-zip summary (or another extension's compaction) was made \
                  since the last cold plan and the context has not grown back to the size that summary started from. A flag that never \
                  lapses, or one a restart restored for a stretch a cold return had ended, withholds summaries that pay.",
            evidence: Evidence::Conformance,
            f: always(warm_summary_not_withheld()),
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
            id: "GC",
            name: "a gone cache gets a cold plan",
            from: &["A2"],
            why: "README rule 2: after the TTL, or after switching model, pi-zip folds: a return to a cache that is gone (a switch, or both \
                  the declared and the kept lifetime passed since the last response or refresh) is planned cold, and a return after the \
                  declared TTL is marked past it (the previous turn becomes eligible).",
            evidence: Evidence::Conformance,
            f: always(gone_is_cold()),
        },
        Prop {
            id: "WB",
            name: "warm does nothing below the target",
            from: &["A2"],
            why: "README rule 2: while the cache is warm it does nothing, except the warm valve above the cold target (15% tolerance, the \
                  estimate's own error).",
            evidence: Evidence::Conformance,
            f: always((zip_edit() & planned_warm()) >> warm_above_target()),
        },
        Prop {
            id: "MH",
            name: "an automatic cache keeps its head",
            from: &["A2"],
            why: "README (cache lifetime): on an automatic prefix cache every edit leaves the first 8K tokens alone, so even the response \
                  right after a fold says whether the cache survived (a cut, which replaces the prefix, is exempt as in the code).",
            evidence: Evidence::Conformance,
            f: always(head_kept()),
        },
        Prop {
            id: "RDr",
            name: "restart determinism, residual",
            from: &["RD"],
            why: "RD with the known cause transplanted (g, justEdited, summarizedWarm together, TRIAGE (a) 1): what is left is a new cause.",
            evidence: Evidence::Conformance,
            f: always(run_start() >> rd_residual()),
        },
        Prop {
            id: "MPr",
            name: "monotone in P(warm), residual",
            from: &["MP"],
            why: "MP breaches outside the planner paths TRIAGE (a) 3 and 6 name (B1, smallest cut only, the summary voids better folds, \
                  cold mode at 0 < P < 0.5, F2): what is left is a new mechanism.",
            evidence: Evidence::Conformance,
            f: always(mp_residual()),
        },
        Prop {
            id: "A2r",
            name: "edit only when gone or it pays, residual",
            from: &["A2"],
            why: "A2 failures outside the known classes (B1, and the plan gate without the summary call, TRIAGE (a) 2): what is left is \
                  a new cause.",
            evidence: Evidence::Conformance,
            f: always(zip_edit() >> a2_residual()),
        },
        Prop {
            id: "LW",
            name: "the law as specified",
            from: &["A2"],
            why: "the economic lemmas (README: M, E, G, C, S) are proven for law.rs; this checks that every law evaluation of the real \
                  planner is law.rs on the same inputs, at the class ratios of the true cache class and tier (learn.ts CLASS_RATIOS; \
                  they satisfy the lemmas' premise w >= r), so the proofs apply to it.",
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
            let first_protected = r.blocks.iter().position(|b| b.starts_turn() && b.turn == prev.max(1));
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

/// MP breaches at request i: (mechanism, description) per decision point and higher-P plan the lower-P plan does not dominate.
pub fn mp_breaches(r: &R, i: usize) -> Vec<(String, String)> {
    let mut bad = Vec::new();
    for g in r.grids(i) {
        let pts: Vec<&GridPt> = g.grid.iter().filter(|x| x.error.is_none()).collect();
        for (a, q) in pts.iter().enumerate() {
            if !q.edits() {
                continue;
            }
            if let Some(p) = pts[..a].iter().filter(|p| p.p < q.p).find(|p| !dominates(r, i, p, q)) {
                bad.push((
                    mp_mechanism(g, p, q),
                    format!(
                        "{} at P={}: {} (folds {}, summary {}, after {:.0}); at P={}: {} (folds {}, summary {}, after {:.0}; law {})",
                        g.at,
                        q.p,
                        q.mode,
                        q.folds.len(),
                        q.cut.is_some(),
                        q.after.unwrap_or(f64::NAN),
                        p.p,
                        if p.plan { p.mode.as_str() } else if p.b2b { "b2b skip" } else { "no plan" },
                        p.folds.len(),
                        p.cut.is_some(),
                        p.after.unwrap_or(f64::NAN),
                        p.law.iter().map(|l| format!("{} {} B={:.0} A={:.0} K={:.0}", l.at, if l.ok { "ok" } else { "refused" }, l.b, l.a, l.k.unwrap_or(f64::NAN))).collect::<Vec<_>>().join(", ")
                    ),
                ));
            }
        }
    }
    bad
}

pub fn monotonicity_breaches(r: &R, i: usize) -> Vec<String> {
    mp_breaches(r, i).into_iter().map(|(_, d)| d).collect()
}

/// The MP mechanisms TRIAGE.md (a) 3 and 6 name (MPr is MP without them).
pub const MP_KNOWN: &[&str] = &["B1, the warm summary", "smallest cut only", "the summary voids better folds", "cold mode at 0 < P < 0.5", "lookahead (F2)"];
/// The A2 classes TRIAGE.md names (A2r is A2 without them).
pub const A2_KNOWN: &[&str] = &["B1, a warm summary whose call no gate prices", "the call is not in the plan gate"];

fn prices(g: &Grid) -> Option<Prices> {
    g.pr.as_ref().filter(|p| p.r > 0.0).map(|p| Prices { r: p.r, w: p.w, out: p.out })
}

/// The prices of the law at a decision: the class ratios of the TRUE cache class and tier (learn.ts CLASS_RATIOS, law.rs
/// class_prices), when pi-zip knows the class at all (None: the legacy rule, before the first response of a model). LW checks that
/// the planner used exactly these.
pub fn spec_prices(r: &R, g: &Grid) -> Option<Prices> {
    prices(g)?;
    Some(class_prices(r.trace.world.cls, r.trace.world.tier == Tier::Long))
}

/// The real sizes of what request i carries new, read from the requests themselves (the provider's scale), not from the planner:
/// `b` what the request would have sent without the edit (Pi's own projection for a run plan; the previous request plus what was
/// appended since for a plan persisted at a turn_end or through Pi's compaction), `a` what it sent, `d_folds` what the new folds
/// removed, `sum` the new summary; `call` what the summary's model call cost at the class ratios: its uncached read at the input
/// price plus the narrative written at the output price (the bridge's narrative model reports both; the deterministic skeleton
/// and handle table are not model output).
#[derive(Clone, Copy, Debug)]
pub struct EditSizes {
    pub b: f64,
    pub a: f64,
    pub d_folds: f64,
    pub sum: f64,
    pub read: f64,
    pub written: f64,
}
pub fn edit_sizes(r: &R, i: usize) -> Option<EditSizes> {
    if i == 0 {
        return None;
    }
    let t = r.tick(i);
    let g = r.decision_for(i)?;
    let a = r.st[i].view_tok;
    let native = t.run_plan.as_ref().is_some_and(|p| p.native);
    let b = if g.at == "run" && t.n == 0 && !native && !r.tick(i - 1).te_valve { t.raw_tok } else { r.st[i - 1].view_tok + r.st[i].appended };
    let new_f: BTreeSet<&str> = t.zip_new.iter().filter_map(|m| m.strip_prefix("f:")).collect();
    let d_folds: f64 = t
        .view
        .iter()
        .filter(|m| m.ph && m.id.as_deref().is_some_and(|id| new_f.contains(id)))
        .map(|m| r.block(m.id.as_deref().unwrap_or("")).map(|bk| (bk.tok - m.tok).max(0.0)).unwrap_or(0.0))
        .sum();
    let sum: f64 = t.view.iter().filter(|m| m.sum.as_deref() == Some("zip") && t.zip_new.iter().any(|z| z.strip_prefix("s:") == Some(m.h.as_str()))).map(|m| m.tok).sum();
    // the call: the last narrative call since the previous request (the summary this request carries); without one (a summary
    // whose narrative failed) the conversation the cut replaced, read, and the summary, written
    let (read, written) = match (sum > 0.0, t.narr.last()) {
        (false, _) => (0.0, 0.0),
        (true, Some(c)) => (c.input, c.output),
        (true, None) => ((b - a - d_folds + sum - r.st[i - 1].prev_sum).max(0.0), sum),
    };
    Some(EditSizes { b, a, d_folds, sum, read, written })
}

/// Ok(()) when the edit request i carries new pays in the law's own model, at the class ratios and the request's real sizes, the
/// summary call included (its uncached read of the conversation it replaces plus the summary written); at a cache believed gone
/// (P < 0.5) a summary must also pay its call at its own margin (what the cut removes beyond the folds), since the folds alone are
/// free there (lemma C). Err(why) otherwise.
pub fn pays_fully(r: &R, i: usize) -> Result<(), String> {
    let Some(g) = r.decision_for(i) else { return Err("an edit no decision point explains".into()) };
    if g.actual().is_none() {
        return Err("no actual plan in the decision".into());
    }
    let Some(pr) = spec_prices(r, g) else { return Ok(()) }; // legacy rule (class unknown): nothing to price
    let Some(e) = edit_sizes(r, i) else { return Ok(()) };
    let room = Some(r.st[i].room);
    let gg = g.g.unwrap_or(2500.0);
    let call = if e.sum > 0.0 { summary_call(pr, e.read, e.written) } else { 0.0 };
    // pays: K <= 0 or gain >= K, up to the estimate's error: the planner decides on chars/4 estimates it calibrates, the spec judges
    // on the request's real size, so the verdict may differ by TOL of the gross terms of K (the rewrite, the reads saved, the call)
    let pays = |b: f64, a: f64, t: &crate::law::Terms| {
        let gross = (pr.w - pr.r) * (g.p * a + (1.0 - g.p) * (b - a)).abs() + call;
        t.ok || t.k - t.gain <= TOL * gross
    };
    if e.a >= e.b {
        return Err(format!("{} plan at P={}: B={:.0} A={:.0} (real){}: the edit makes the request larger", g.at, g.p, e.b, e.a, if e.sum > 0.0 { format!(", a summary of {:.0}", e.sum) } else { String::new() }));
    }
    let t = law(e.b, e.a, g.p, room, Some(pr), gg, call, e.a);
    let mut sum_txt = if e.sum > 0.0 { format!(", a summary of {:.0} (its call read {:.0} and wrote {:.0})", e.sum, e.read, e.written) } else { String::new() };
    // what the planner itself evaluated (its estimates), for the diagnosis
    if let Some(p) = g.actual() {
        let steps: Vec<String> = p.law.iter().map(|l| format!("{} B={:.0} A={:.0} K={:.0} {}", l.at, l.b, l.a, l.k.unwrap_or(f64::NAN), if l.ok { "ok" } else { "refused" })).collect();
        if !steps.is_empty() {
            sum_txt += &format!(" [planner: {}]", steps.join(", "));
        }
    }
    if !pays(e.b, e.a, &t) {
        return Err(format!(
            "{} plan at P={}: B={:.0} A={:.0} (real){sum_txt}; K={:.0} with the summary call {call:.0}, gain {:.0}: the law's own model says it costs {:.0} more than not editing",
            g.at,
            g.p,
            e.b,
            e.a,
            t.k,
            t.gain,
            t.k - t.gain
        ));
    }
    if e.sum > 0.0 && g.p < 0.5 {
        let d = (e.b - e.a - e.d_folds).max(0.0);
        let m = law(e.a + d, e.a, g.p, room, Some(pr), gg, call, e.a);
        if !pays(e.a + d, e.a, &m) {
            return Err(format!(
                "{} plan at P={}: the summary removes {d:.0} beyond the folds{sum_txt}; at its margin K={:.0} with the call {call:.0}, gain {:.0}: the call costs {:.0} more than the summary saves",
                g.at,
                g.p,
                m.k,
                m.gain,
                m.k - m.gain
            ));
        }
    }
    Ok(())
}

/// The narrative part of a planned summary the planner's estimate is checked with (summary.ts asks for at most 1,500 words).
const NARRATIVE_EST: f64 = 2_500.0;

/// The mechanism behind an A2 failure at request i (one class per failing request).
pub fn a2_class(r: &R, i: usize) -> String {
    let Some((g, p)) = r.decision_for(i).and_then(|g| g.actual().map(|p| (g, p))) else { return "an unexplained edit".into() };
    let code_pr = prices(g);
    if code_pr.is_some_and(|c| spec_prices(r, g).is_some_and(|s| (c.w - s.w).abs() > 1e-9 || (c.r - s.r).abs() > 1e-9)) {
        return format!("{}: the planner's prices are not the class ratios", g.at);
    }
    let sum = edit_sizes(r, i).is_some_and(|e| e.sum > 0.0);
    // every law step the planner evaluated, on its own estimates of B and A but with the spec's call, says it pays: the request's
    // real size says otherwise
    let carried = if i > 0 { r.st[i - 1].prev_sum } else { 0.0 };
    let by_estimate = code_pr.is_some_and(|pr| {
        !p.law.is_empty()
            && p.law.iter().filter(|step| step.at != "summary" || p.cut.is_some()).all(|step| {
                let (call, t) = match step.at.as_str() {
                    "summary" => (summary_call(pr, step.b - carried, step.a.min(NARRATIVE_EST)), step.a),
                    _ => (if p.cut.is_some() { summary_call(pr, p.prefix - carried, p.sum.min(NARRATIVE_EST)) } else { 0.0 }, step.a),
                };
                let room = if step.at == "summary" { None } else { Some(r.st[i].room) };
                law(step.b, step.a, g.p, room, Some(pr), g.g.unwrap_or(2500.0), call, t).ok
            })
    });
    if by_estimate {
        return format!("{}: pays by the planner's estimate of B and A, not by the request's real size (calibration)", g.at);
    }
    if sum && g.p < 0.5 {
        return format!("{}: a cold summary whose call does not pay at its margin (the summary gate)", g.at);
    }
    match () {
        _ if p.cut.is_some() && p.law.iter().any(|l| l.at == "summary") => format!("{}: summary gate and plan gate pass separately, the call is not in the plan gate (plan.ts:716 call = 0)", g.at),
        _ if p.cut.is_some() => format!("{}: B1, a warm summary whose call no gate prices", g.at),
        _ => format!("{}: warm folds that do not pay", g.at),
    }
}

/// GC: why the run starting at request i was not planned cold although its cache is gone (None: it was, or the cache is not gone).
pub fn gone_but_warm(r: &R, i: usize) -> Option<String> {
    let t = r.tick(i);
    if t.n != 0 || i == 0 {
        return None;
    }
    let s = &r.st[i];
    let w = &r.trace.world;
    if s.switched {
        return (!s.believed_cold || s.p > 0.0).then(|| format!("the model switched ({} -> {}) and the return was planned with P(warm) {:.2}", r.tick(i - 1).model, t.model, s.p));
    }
    let gap = s.touch_gap?;
    if gap > w.ttl_decl() + 1.0 && !s.past_ttl {
        return Some(format!("{gap:.0} s since the cache was last touched, past the declared TTL {:.0} s, and the return is not marked past it", w.ttl_decl()));
    }
    if gap > w.ttl_decl() + 1.0 && gap > w.ttl_kept() + 1.0 && !s.believed_cold {
        return Some(format!("{gap:.0} s since the cache was last touched, past the declared ({:.0} s) and the kept ({:.0} s) TTL, and the return was planned warm (P(warm) {:.2})", w.ttl_decl(), w.ttl_kept(), s.p));
    }
    None
}

/// WB: a new edit planned warm at request i from a context at or below the cold target.
pub fn warm_below_target(r: &R, i: usize) -> Option<String> {
    let g = r.decision_for(i)?;
    if g.p < 0.5 || !r.zip_new(i) {
        return None;
    }
    let e = edit_sizes(r, i)?;
    let planner = g.actual().and_then(|p| p.law.iter().find(|l| l.at == "plan")).map(|l| format!(" (the planner estimated {:.0})", l.b)).unwrap_or_default();
    (e.b <= r.st[i].target * (1.0 - TOL_TARGET)).then(|| format!("a {} plan at P={} edits a context of {:.0} real tokens{planner}, below the cold target {:.0}", g.at, g.p, e.b, r.st[i].target))
}

/// What MIN_EXPECT is (learn.ts): the head every edit leaves untouched on an automatic cache.
pub const MIN_EXPECT: f64 = 8_192.0;
/// MH: a new fold at request i that starts inside the first MIN_EXPECT real tokens of an automatic cache pi-zip knows as such.
pub fn head_breach(r: &R, i: usize) -> Option<String> {
    if r.trace.world.cls != Class::Automatic {
        return None;
    }
    let g = r.decision_for(i)?;
    if g.pr.as_ref().is_none_or(|p| p.cls != "automatic") {
        return None;
    }
    let t = r.tick(i);
    if r.st[i].switched {
        return None; // the first request to a new model is no survival sample (learn.ts: another model's cache), nothing to keep
    }
    if t.zip_new.iter().any(|m| m.starts_with("s:")) {
        return None; // a cut replaces the prefix from the first message on: the sample is censored anyway (plan.ts, exempt)
    }
    let new_f: BTreeSet<&str> = t.zip_new.iter().filter_map(|m| m.strip_prefix("f:")).collect();
    let mut off = 0.0;
    for m in &t.view {
        if m.ph && m.id.as_deref().is_some_and(|id| new_f.contains(id)) && off < MIN_EXPECT * (1.0 - TOL) {
            return Some(format!("the {} plan folds {} at {off:.0} real tokens into the request, inside the first {MIN_EXPECT:.0} an automatic cache keeps for the survival sample", g.at, m.id.as_deref().unwrap_or("?")));
        }
        off += m.tok;
    }
    None
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

/// WL: the summary step and the whole plan's step must beat their cost by this margin before a withheld summary counts (the sizes
/// are the planner's calibrated estimates).
pub const WL_MARGIN: f64 = 0.25;

/// The context (after folds) the decision behind request i's summary saw; infinite when unknown (never regrown).
pub fn summary_start_at(r: &R, i: usize) -> f64 {
    r.decision_for(i).and_then(|g| g.actual()).and_then(|p| p.after_folds).unwrap_or(f64::INFINITY)
}

/// The newest request at or before i whose run pi-zip planned cold (the start of the warm stretch i belongs to), if any.
fn last_cold_plan(r: &R, i: usize) -> Option<usize> {
    (0..=i).rev().find(|&m| r.tick(m).n == 0 && r.st[m].believed_cold)
}

/// A recorded law step passes with Phi >= 1 + WL_MARGIN (Phi is infinite, reported as none, when K <= 0).
fn pays_by_margin(s: &LawStep) -> bool {
    s.ok && s.phi.is_none_or(|phi| phi >= 1.0 + WL_MARGIN)
}

/// WL at request i: what is withheld, and why it is not excused.
pub fn withheld(r: &R, i: usize) -> Option<String> {
    let t = r.tick(i);
    // (a) the valve is asked at every warm turn_end
    let asked = r.grids(i).iter().any(|g| g.at == "turn_end");
    let b2b = t.te_ledger.iter().any(|x| x.get("type").and_then(|v| v.as_str()) == Some("b2b_skip"));
    let run_plan_persisted = t.n == 0 && t.run_plan.is_some();
    if !asked && t.failed.is_none() && !b2b && !run_plan_persisted {
        return Some("a warm turn_end asked no valve (no decision point, no b2b skip, no run plan to persist)".into());
    }
    // (b) the one-summary flag withholds only what the rule allows
    for g in r.grids(i) {
        if g.mode != "warm" || !g.no_summary {
            continue;
        }
        let Some(f) = g.free.as_ref().filter(|f| f.error.is_none() && f.cut.is_some()) else { continue };
        if g.actual().is_some_and(|p| p.cut.is_some()) {
            continue;
        }
        let Some(k) = f.law.iter().rposition(|s| s.at == "plan" && s.cut == Some(true) && s.ok) else { continue };
        let sum_ok = k > 0 && f.law[k - 1].at == "summary" && pays_by_margin(&f.law[k - 1]);
        if !sum_ok || !pays_by_margin(&f.law[k]) {
            continue;
        }
        let phi = f.law[k].phi.map(|x| format!("{x:.2}")).unwrap_or_else(|| "inf".into());
        let now = f.after_folds.unwrap_or(0.0);
        let m0 = last_cold_plan(r, i).unwrap_or(0);
        if (m0..=i).any(|m| r.tick(m).env.iter().any(|e| e == "foreign")) {
            continue; // another extension's compaction is this stretch's summary
        }
        let starts: Vec<f64> = (m0..=i).filter(|&m| r.zip_summary_new(m)).map(|m| summary_start_at(r, m)).collect();
        match starts.last() {
            None => {
                return Some(format!(
                    "{} plan at P={}: the one-summary flag is set, but pi-zip made no summary since the last cold plan (request {m0}); it withholds a summary that pays (Phi {phi}, context {now:.0})",
                    g.at, g.p
                ))
            }
            Some(&s0) if now >= s0 * (1.0 + TOL) => {
                return Some(format!(
                    "{} plan at P={}: the context ({now:.0}) has grown back past the size the stretch's summary started from ({s0:.0}), and the flag still withholds a summary that pays (Phi {phi})",
                    g.at, g.p
                ))
            }
            _ => {}
        }
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

/// Every recorded law step is law.rs on the same inputs, at the class ratios. The plan step has no call, or, when it plans a cut, the
/// call of that cut's summary step (the whole plan pays the summary call too): compared exactly (ok and K).
/// A summary step's call is a pricing choice of each version (0.2.8: w X + out S; coldwarm F3: the narrative's real input and output):
/// it is backed out of K, must cost at least half the uncached read of what it summarises, and the step's verdict must be law.rs's
/// with that call.
pub fn law_mismatch(r: &R, i: usize) -> Option<String> {
    for g in r.grids(i) {
        let Some(pr) = prices(g) else { continue };
        // the prices are the class ratios of the true class and tier (README rule 2; the lemmas' premise w >= r)
        let want = class_prices(r.trace.world.cls, r.trace.world.tier == Tier::Long);
        let cls = match r.trace.world.cls {
            Class::Explicit => "explicit",
            Class::Automatic => "automatic",
        };
        let pcls = g.pr.as_ref().map(|p| p.cls.as_str()).unwrap_or("");
        if (pr.r - want.r).abs() > 1e-9 || (pr.w - want.w).abs() > 1e-9 || (pr.out - want.out).abs() > 1e-9 || pcls != cls {
            return Some(format!(
                "{} prices {pcls} r={} w={} out={}; the class ratios of the {cls} cache{} are r={} w={} out={}",
                g.at,
                pr.r,
                pr.w,
                pr.out,
                if r.trace.world.tier == Tier::Long { " on the 1-hour tier" } else { "" },
                want.r,
                want.w,
                want.out
            ));
        }
        let gg = g.g.unwrap_or(2500.0);
        let reports_cut = g.grid.iter().any(|pt| pt.law.iter().any(|x| x.at == "plan" && x.cut.is_some()));
        for pt in &g.grid {
            // a plan with a cut ends in an accepted whole-plan step that carries its cut (and so the summary call); a plan without one
            // has no such accepted step (it would have applied the cut). Only for a source that reports the flag.
            if reports_cut && !pt.law.is_empty() && !pt.ahead {
                let last = pt.law.iter().rev().find(|x| x.at == "plan");
                let cut_ok = last.map(|x| x.ok && x.cut == Some(true)).unwrap_or(false);
                if pt.cut.is_some() && !cut_ok {
                    return Some(format!("{} plan at P={}: a cut is planned, but the law has no accepted whole-plan step for a cut (the summary call was never priced into the plan)", g.at, pt.p));
                }
                if pt.cut.is_none() && cut_ok {
                    return Some(format!("{} plan at P={}: no cut is planned, but the law accepted a whole-plan step with a cut", g.at, pt.p));
                }
            }
            for s in &pt.law {
                let t = s.t.unwrap_or(s.a);
                let call = match (s.at.as_str(), s.k) {
                    ("summary", Some(k)) => call_of(pr, s.b, s.a, pt.p, t, k),
                    // the whole plan's step carries the summary call exactly when it plans a cut (TRIAGE (a) 2). Review P1-3: pinned both
                    // ways, by the flag the planner records on the step. A cut's step carries the call of the summary step recorded just
                    // before it (the same cut), to the token; a folds-only plan's step has no call, so K is checked exactly as before the
                    // call was priced into the plan (a source that does not report the flag has no call in any plan step, same rule).
                    ("plan", Some(k)) if s.cut == Some(true) && !pt.ahead => {
                        let call = call_of(pr, s.b, s.a, pt.p, t, k);
                        let prev = pt.law.iter().position(|x| std::ptr::eq(x, s)).and_then(|j| j.checked_sub(1)).map(|j| &pt.law[j]).filter(|x| x.at == "summary");
                        match prev.and_then(|x| x.k.map(|pk| (x, pk))) {
                            Some((ps, pk)) => {
                                let pc = call_of(pr, ps.b, ps.a, pt.p, ps.t.unwrap_or(ps.a), pk);
                                if (pc - call).abs() > 1e-6 * call.abs().max(pc.abs()).max(1.0) {
                                    return Some(format!("{} plan at P={}: the call in the plan step ({call:.0}) is not the call of the cut's summary step ({pc:.0})", g.at, pt.p));
                                }
                            }
                            None => return Some(format!("{} plan at P={}: a whole-plan step for a cut with no summary step before it", g.at, pt.p)),
                        }
                        call
                    }
                    ("plan", Some(k)) if pt.ahead && s.cut == Some(true) => call_of(pr, s.b, s.a, pt.p, t, k), // a lookahead summary passes no summary gate
                    _ => 0.0,
                };
                if call < -1e-6 * s.b.max(1.0) {
                    return Some(format!("{} {} at P={}: a negative call term {call:.1}", g.at, s.at, pt.p));
                }
                // the call is a real uncached model call that reads the conversation the summary replaces (B = X, the prefix, minus the
                // previous summary it carries forward and never reads): whatever each version's pricing, it costs at least half of that
                // at the input price (half: the planner's calibrated estimate against the request's real size of the previous summary)
                if s.at == "summary" && s.a < s.b && s.k.is_some() {
                    let carried = r.st[i].prev_sum.max(if i > 0 { r.st[i - 1].prev_sum } else { 0.0 });
                    let floor = 0.5 * (s.b - carried).max(0.0);
                    if call < floor {
                        return Some(format!("{} summary at P={}: the call is priced {call:.0}, below half the uncached read of the {:.0} tokens it summarises ({floor:.0})", g.at, pt.p, s.b - carried));
                    }
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
        "MPr" => mp_breaches(r, i).into_iter().filter(|(m, _)| !MP_KNOWN.iter().any(|k| m.contains(k))).map(|(m, d)| format!("[{m}] {d}")).collect(),
        "A2r" => pays_fully(r, i).err().into_iter().collect(),
        "GC" => gone_but_warm(r, i).into_iter().collect(),
        "WB" => warm_below_target(r, i).into_iter().collect(),
        "MH" => head_breach(r, i).into_iter().collect(),
        "NT" => summary_waste(r, i).into_iter().collect(),
        "WL" => withheld(r, i).into_iter().collect(),
        "TR" => target_miss(r, i).into_iter().collect(),
        "LW" => law_mismatch(r, i).into_iter().collect(),
        "G" => probe_mismatch(r, i).into_iter().collect(),
        "RD" | "RDr" => r
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
    if p.cut.is_some() && q.cut.is_some() && p.prefix < q.prefix && p.folds.len() > q.folds.len() {
        return format!("{}: smallest cut only: the lower-P plan's relax folds let a smaller cut reach the cap, and it leaves more (plan.ts summarise pick)", g.at);
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
        "MP" => mp_breaches(r, v.at).into_iter().next().map(|(m, _)| m).unwrap_or_else(|| "other".into()),
        "MPr" => mp_breaches(r, v.at).into_iter().map(|(m, _)| m).find(|m| !MP_KNOWN.iter().any(|k| m.contains(k))).unwrap_or_else(|| "other".into()),
        "A2" | "A2r" => a2_class(r, v.at),
        "GC" => {
            let s = &r.st[v.at];
            let after_fail = v.at > 0 && r.tick(v.at - 1).failed.is_some();
            let restart = r.tick(v.at).env.iter().any(|e| e == "restart");
            let why = if s.switched {
                "a model switch planned warm"
            } else if !s.past_ttl && s.touch_gap.is_some_and(|g| g > r.trace.world.ttl_decl() + 1.0) {
                "a return after the declared TTL not marked past it"
            } else {
                "a gone cache planned warm"
            };
            format!("{why}{}", if after_fail { " (after a failed request)" } else if restart { " (after a restart)" } else { "" })
        }
        "WB" => r
            .decision_for(v.at)
            .map(|g| {
                let est = g.actual().and_then(|p| p.law.iter().find(|l| l.at == "plan")).map(|l| l.b);
                let real = edit_sizes(r, v.at).map(|e| e.b);
                let cal = matches!((est, real), (Some(e), Some(b)) if e > r.st[v.at].target && b <= r.st[v.at].target);
                let after = if r.tick(v.at).env.iter().any(|e| e == "compact") { " after Pi's own compaction" } else { "" };
                format!("{}: a warm edit below the cold target{}{after}", g.at, if cal { " the planner believed above it (calibration)" } else { "" })
            })
            .unwrap_or_default(),
        "MH" => {
            let env = &r.tick(v.at).env;
            if env.iter().any(|e| e == "compact" || e == "edit" || e == "foreign") {
                "a fold inside the automatic cache's head, after a compaction or edit pi-zip did not write (calibration)".into()
            } else {
                "a fold inside the automatic cache's head".into()
            }
        }
        "A3" => {
            let t = r.tick(v.at);
            let env = &t.env;
            let gap = t.gap.unwrap_or(0.0);
            let ttl = r.trace.world.ttl_decl();
            if r.decision_for(v.at).is_some_and(|g| g.at == "run" && g.p >= 0.5) {
                "warm return: the run plan summarises while the user waits (B2)".into()
            } else if r.decision_for(v.at).is_some_and(|g| g.at == "turn_end" && g.p >= 0.5) {
                "warm turn_end: the valve summarises while the user waits, the stretch's unused background summary not spent (rule B)".into()
            } else if env.iter().any(|e| e == "switch") {
                "cold return by a model switch (nothing to foresee while away)".into()
            } else if env.iter().any(|e| e == "foreign") {
                "cold return after a foreign compaction".into()
            } else if env.iter().any(|e| e == "compact" || e == "edit") {
                "cold return after Pi's own compaction or another extension's edit".into()
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
        "RD" | "RDr" if r.tick(v.at).fresh.as_ref().is_some_and(|f| !f.fixed_by_all) && r.tick(v.at).env.iter().any(|e| e == "away-summary") && r.tick(v.at).env.iter().any(|e| e == "edit" || e == "compact") => {
            "the summary prepared while away was planned before another context change (an extension's edit, Pi's compaction)".into()
        }
        "RD" | "RDr" if pinned_live(r, v.at) => "the live process pinned its warm plan to a summary only it held in memory (round 5 anti-thrash)".into(),
        "RD" | "RDr" => match r.tick(v.at).fresh.as_ref() {
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
        "WL" => match withheld(r, v.at) {
            Some(w) if w.contains("asked no valve") => "a warm turn_end that asks no valve".into(),
            Some(w) if w.contains("no summary since the last cold plan") => {
                if (0..=v.at).any(|m| r.tick(m).env.iter().any(|e| e == "restart")) { "the flag outlives the stretch: restored after a restart for a stretch a cold return ended".into() } else { "the flag outlives the stretch".into() }
            }
            Some(_) => "the flag never lapses: the context grew back past the size the stretch's summary started from".into(),
            None => "other".into(),
        },
        "PW" => {
            let ahead = r.grids(v.at).iter().any(|g| g.actual().is_some_and(|p| p.ahead));
            if ahead { "a lookahead cut past the previous turn's final answer".into() } else { "edit inside the protected turns".into() }
        }
        _ => String::new(),
    }
}
