//! Conformance smoke test: the B1 and B2 traces (minimal counterexamples of bugs the rc fixes clear) through the bridge on this
//! worktree's src: every property must hold on them now. Skipped without bun or src.
use pz_formal::bridge::Pool;
use pz_formal::model::{Run, Trace};
use pz_formal::spec::all;
use std::path::Path;

fn verdicts(src: &Path, file: &str) -> Option<Vec<(&'static str, bool)>> {
    if std::process::Command::new("bun").arg("--version").output().is_err() || !src.join("plan.ts").exists() || !src.join("../node_modules").exists() {
        eprintln!("skipped: bun or {} not available", src.display());
        return None;
    }
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("traces").join(file)).unwrap();
    let trace = Trace::parse(&text).unwrap();
    let pool = Pool::new(src, 1, None).unwrap();
    let obs = pool.run(std::slice::from_ref(&trace)).pop().unwrap();
    assert!(obs.ok, "bridge error: {:?}", obs.errors);
    let run = Run::new(trace, obs);
    Some(all().into_iter().map(|p| (p.id, p.f.first_violation(&run).is_none())).collect())
}

fn src() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src")
}

#[test]
fn b1_and_b2_are_fixed() {
    for file in ["b1.trace", "b2.trace"] {
        let Some(v) = verdicts(&src(), file) else { return };
        for (id, ok) in &v {
            assert!(ok, "{file}: {id} must hold (the bug the trace shrank is fixed): {v:?}");
        }
    }
}

/// 0.4.0 step 2: produced summaries are pi-zip/summary entries. A restart after the call finished (b2-restart.trace) and a restart
/// while it runs (rd-restart-mid-call.trace, a slow world): the restarted process decides as a fresh one would (RD, RDr), and the
/// warm return makes nobody wait (A3).
#[test]
fn restart_with_a_summary_finished_or_running() {
    for file in ["b2-restart.trace", "rd-restart-mid-call.trace"] {
        let Some(v) = verdicts(&src(), file) else { return };
        for (id, ok) in &v {
            if ["RD", "RDr", "A3", "A1", "I1"].contains(id) {
                assert!(ok, "{file}: {id} must hold: {v:?}");
            }
        }
    }
}

/// A native artifact has already paid for its call, even though the native door emits no `take` ledger record.
#[test]
fn native_application_prices_the_spent_call_at_zero() {
    use pz_formal::model::Obs;
    use pz_formal::spec::{native_withheld, pays_fully, took_ready};
    use serde_json::json;
    let trace = Trace::parse("world explicit known ttl=300 true=300 survival=none c=1 sys=3000 window=200000 native print\nprompt\nsay 100\nprompt +60s\nsay 100\n").unwrap();
    let obs: Obs = serde_json::from_value(json!({
        "ok": true,
        "ticks": [
            { "req": 0, "model": "p/m", "n": 0, "t0": 0, "t1": 5,
              "view": [{ "h": "sys", "role": "system", "tok": 3000 }, { "h": "old", "role": "assistant", "tok": 85000 }] },
            { "req": 1, "model": "p/m", "n": 0, "t0": 65, "t1": 70, "rawTok": 88000,
              "view": [{ "h": "sys", "role": "system", "tok": 3000 }, { "h": "summary", "role": "compactionSummary", "sum": "zip", "tok": 5000 }, { "h": "kept", "role": "assistant", "tok": 26000 }],
              "zipNew": ["s:summary"], "runPlan": { "native": true, "cut": "u12" },
              "nativeDoor": { "open": true, "p": 1, "g": 2500, "known": true, "before": 88000, "afterFolds": 88000, "target": 40000, "floor": 14000,
                              "cuts": [{ "key": "u12", "prefix": 60000, "summary": 5000, "read": 60000, "written": 2500, "ready": true, "guard": true, "hash": "artifact" }],
                              "applied": { "key": "u12", "hash": "artifact" } },
              "narr": [{ "input": 60000, "output": 2500 }], "runLedger": [],
              "grids": [{ "at": "run", "p": 1, "g": 2500, "pr": { "r": 0.1, "w": 1.25, "out": 5, "cls": "explicit", "src": "class" },
                          "grid": [{ "actual": true, "p": 1, "plan": true, "cut": "u12" }] }] }
        ]
    })).unwrap();
    let run = Run::new(trace.clone(), obs.clone());
    assert_eq!(took_ready(&run, 1).as_deref(), Some("u12"));
    assert!(pays_fully(&run, 1).is_ok(), "the ready native cut pays without another call");
    assert!(native_withheld(&run, 1).is_none());
    let mut missed = obs.clone();
    missed.ticks[1].native_door.as_mut().unwrap().applied = None;
    assert!(native_withheld(&Run::new(trace.clone(), missed), 1).is_some(), "NA detects withholding from artifact state even with no native_skip or take ledger");
    let mut fresh = obs;
    fresh.ticks[1].run_plan.as_mut().unwrap().native = false;
    let unpaid = Run::new(trace, fresh);
    assert_eq!(took_ready(&unpaid, 1), None);
    assert!(pays_fully(&unpaid, 1).unwrap_err().contains("with the summary call 87500"), "the same cut with a fresh call does not pay");
}

/// A large indivisible recent block changes Pi's room price; NA must use the observed tail before applying the guard.
#[test]
fn native_completeness_prices_the_measured_long_tail() {
    use pz_formal::law::{class_prices, guard};
    use pz_formal::model::{Class, Obs};
    use pz_formal::spec::native_withheld;
    use serde_json::json;
    let pr = class_prices(Class::Explicit, false);
    let measured = guard(200_000.0, 199_000.0, 1.0, Some(100_000.0), pr, 2_500.0, 0.0, Some(198_000.0));
    assert!((measured.eta - 236.35).abs() < 1e-9);
    assert!(measured.ok);
    assert!(!guard(200_000.0, 199_000.0, 1.0, Some(100_000.0), pr, 2_500.0, 0.0, None).ok);
    let trace = Trace::parse("world explicit known ttl=300 true=300 survival=none c=1 sys=3000 window=124576 native print\nprompt\nsay 100\n").unwrap();
    let obs: Obs = serde_json::from_value(json!({
        "ok": true, "ticks": [{ "req": 0, "model": "p/m", "n": 0, "t0": 0, "t1": 5,
            "nativeDoor": { "open": true, "p": 1, "g": 2500, "known": true,
                "before": 200000, "afterFolds": 200000, "target": 40000, "keep": 198000,
                "cuts": [{ "key": "kept", "prefix": 2000, "summary": 1000, "ready": true, "guard": true, "hash": "artifact" }] }
        }]
    })).unwrap();
    assert!(native_withheld(&Run::new(trace.clone(), obs.clone()), 0).is_some(), "the room credit pays for this withheld ready artifact");
    let mut default_tail = obs.clone();
    default_tail.ticks[0].native_door.as_mut().unwrap().keep = None;
    assert!(native_withheld(&Run::new(trace.clone(), default_tail), 0).is_none(), "the default tail cannot pay for the same edit");

    // The shallow call fails its summary law. Only the measured whole-plan room credit makes the deeper call pay,
    // so the ready bound must move past the shallow cut. Enough rent makes application pass with either tail.
    let mut priced = obs;
    let n = priced.ticks[0].native_door.as_mut().unwrap();
    n.g = 10.0;
    n.rent = 3_000_000.0;
    n.target = 199_000.0;
    n.cuts = serde_json::from_value(json!([
        { "key": "shallow", "prefix": 2000, "summary": 1000, "read": 2000, "written": 1000, "guard": true },
        { "key": "deeper", "prefix": 3000, "summary": 1500, "read": 3000, "written": 1000, "ready": true, "guard": true, "hash": "artifact" }
    ])).unwrap();
    assert!(native_withheld(&Run::new(trace.clone(), priced.clone()), 0).unwrap().contains("deeper"));
    priced.ticks[0].native_door.as_mut().unwrap().keep = None;
    assert!(native_withheld(&Run::new(trace, priced), 0).is_none(), "without the measured whole-plan credit the ready bound stays shallow");
}
