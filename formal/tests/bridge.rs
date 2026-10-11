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
