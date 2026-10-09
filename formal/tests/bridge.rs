//! Conformance smoke test: the B1 and B2 traces through the bridge on this worktree's src (affine). Skipped without bun or src.
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
fn b1_and_b2_on_affine() {
    for (file, must_fail) in [("b1.trace", "MP"), ("b2.trace", "NR")] {
        let Some(v) = verdicts(&src(), file) else { return };
        let ok = |id: &str| v.iter().find(|(p, _)| *p == id).unwrap().1;
        for harness in ["W", "G", "LW", "A1", "I1"] {
            assert!(ok(harness), "{file}: {harness} must hold (harness fidelity / lossless): {v:?}");
        }
        assert!(!ok(must_fail), "{file}: {must_fail} must fail on affine (the bug is not fixed there): {v:?}");
    }
}
