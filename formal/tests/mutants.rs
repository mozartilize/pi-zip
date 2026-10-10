//! Every property can fail: each test injects one bug into a copy of this worktree's src (the review's mutants) and runs one trace
//! that the unmutated src passes; the property that names the bug must pass on the original and fail on the mutant. The harness
//! self-checks (G, W) and LW's arithmetic are shown to fail on a tampered observation of a real run. Skipped without bun or src.
use pz_formal::bridge::Pool;
use pz_formal::model::{Obs, Run, Trace};
use pz_formal::spec::all;
use std::path::{Path, PathBuf};

const W: &str = "world explicit known ttl=300 true=300 survival=none c=1 sys=3000 window=200000 native interactive";

fn worktree_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src")
}

fn available() -> bool {
    let src = worktree_src();
    let ok = std::process::Command::new("bun").arg("--version").output().is_ok() && src.join("plan.ts").exists() && src.join("../node_modules").exists();
    if !ok {
        eprintln!("skipped: bun or {} not available", src.display());
    }
    ok
}

/// A copy of the worktree's src with exact replacements in one file: (from, to, how many times `from` occurs; all are replaced).
fn mutant(name: &str, file: &str, edits: &[(&str, &str, usize)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("pz-formal-mutant-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    let src = worktree_src();
    for e in std::fs::read_dir(&src).unwrap() {
        let e = e.unwrap();
        std::fs::copy(e.path(), root.join("src").join(e.file_name())).unwrap();
    }
    std::fs::copy(src.join("../package.json"), root.join("package.json")).unwrap();
    std::os::unix::fs::symlink(src.join("../node_modules").canonicalize().unwrap(), root.join("node_modules")).unwrap();
    let path = root.join("src").join(file);
    let mut text = std::fs::read_to_string(&path).unwrap();
    for (from, to, n) in edits {
        assert_eq!(text.matches(from).count(), *n, "{name}: the mutation site {from:?} must occur {n} time(s) in {file}");
        text = text.replace(from, to);
    }
    std::fs::write(&path, text).unwrap();
    root.join("src")
}

/// Removes the mutant's copy even when an assertion fails.
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn observe(src: &Path, trace: &Trace) -> Run {
    let pool = Pool::new(src, 1, None).unwrap();
    let obs = pool.run(std::slice::from_ref(trace)).pop().unwrap();
    assert!(obs.ok, "bridge error: {:?}", obs.errors);
    Run::new(trace.clone(), obs)
}

fn holds(run: &Run, id: &str) -> bool {
    all().into_iter().find(|p| p.id == id).unwrap().f.first_violation(run).is_none()
}

/// The property passes on the original src and fails on the mutant, on this trace.
fn caught(name: &str, file: &str, from: &str, to: &str, prop: &str, trace: &str) {
    caught_all(name, file, &[(from, to, 1)], &[prop], trace)
}

fn caught_all(name: &str, file: &str, edits: &[(&str, &str, usize)], props: &[&str], trace: &str) {
    if !available() {
        return;
    }
    let t = Trace::parse(trace).unwrap();
    let base = observe(&worktree_src(), &t);
    let m = mutant(name, file, edits);
    let _cleanup = Cleanup(m.parent().unwrap().to_path_buf());
    let run = observe(&m, &t);
    for prop in props {
        assert!(holds(&base, prop), "{name}: {prop} must hold on the original src for this trace");
        assert!(!holds(&run, prop), "{name}: {prop} must fail on the mutant");
    }
}

fn lines(xs: &[&str]) -> String {
    xs.join("\n") + "\n"
}

/// prompt; 30K command output; prose; a second turn; a cold return that folds the output; recall it
fn fold_and_recall() -> String {
    lines(&[W, "prompt", "call npm 30K", "say 60K", "prompt +60s", "say 100", "prompt +1h", "call recall", "say 100"])
}

/// a 150K turn, a cold return of small calls (the window has not slid), a second cold return that summarises: prepared while away
fn summary_prepared_away(gap: &str) -> String {
    let mut v = vec![W, "prompt", "say 150K", "prompt +1h"];
    v.extend(std::iter::repeat_n("call npm 100", 12));
    v.extend(["say 100", gap, "say 100"]);
    lines(&v)
}

#[test]
fn a1_recall_through_the_tool() {
    caught("m01", "recall.ts", "const out = recallSections(items, { grep, range, offset, limit });", "const out = recallSections(items, { grep, range, offset, limit }); out.text = out.text.slice(0, 300);", "A1", &fold_and_recall());
}

#[test]
fn a1_placeholder_names_its_handle() {
    caught("m02", "placeholder.ts", "${text.length} chars, ${lines} lines · handle ${handle}]", "${text.length} chars, ${lines} lines]", "A1", &fold_and_recall());
}

#[test]
fn a1_placeholder_shows_its_key_lines() {
    caught("keylines", "placeholder.ts", "if (keep <= 0 || !lines.length) return [];", "if (keep <= 0 || !lines.length) return []; keep = 1;", "A1", &fold_and_recall());
}

#[test]
fn a1_view_by_position() {
    caught(
        "m04",
        "run.ts",
        "return out ? { messages: out.messages } : undefined;",
        "return out ? { messages: out.messages.filter((m: Any) => !(m?.role === \"assistant\" && m?.stopReason === \"stop\" && JSON.stringify(m.content).length > 100000)) } : undefined;",
        "A1",
        &fold_and_recall(),
    );
}

#[test]
fn a1_users_quoted_by_the_summary() {
    caught("m03", "summary.ts", "out.push(...(userLines.length ? userLines : [NONE_ROW]));", "out.push(NONE_ROW);", "A1", &summary_prepared_away("prompt +1h"));
}

#[test]
fn lw_summary_call_is_priced() {
    let t = lines(&["world explicit known ttl=300 true=300 survival=none c=1 sys=30000 window=200000 native interactive", "prompt", "say 25K", "prompt +60s", "say 100", "prompt +60s", "say 100", "prompt +1h", "say 100"]);
    caught_all("m25", "plan.ts", &[("gate(\"summary\", X, Sr, null, call, Sr)", "gate(\"summary\", X, Sr, null, 0, Sr)", 1)], &["LW"], &t);
}

#[test]
fn a3_away_timer() {
    caught("m07", "run.ts", "this.armAway(delay, () => void this.runAway(p, ctx));", "void 0;", "A3", &summary_prepared_away("prompt +1h"));
    caught("m08", "run.ts", "export const AWAY_FRACTION = 0.8;", "export const AWAY_FRACTION = 1.15;", "A3", &summary_prepared_away("prompt +330s"));
}

#[test]
fn gc_gone_cache_gets_a_cold_plan() {
    let ttl = lines(&[W, "prompt", "call npm 30K", "say 100", "prompt +330s", "say 100"]);
    caught("m18", "cache.ts", "nowMs - lastActivityMs > ttlMs;", "nowMs - lastActivityMs > 4 * ttlMs;", "GC", &ttl);
    caught("m18b", "cache.ts", "return { cold: s.p < 0.5, reason,", "return { cold: s.p < 0.5 && gapS > 1200, reason,", "GC", &ttl);
    let switch = lines(&[W, "prompt", "call npm 30K", "say 100", "switch", "prompt +60s", "say 100"]);
    caught("m19", "cache.ts", "if (prev && modelKey(model) && prev !== modelKey(model)) return", "if (false) return", "GC", &switch);
}

#[test]
fn wb_warm_does_nothing_below_the_target() {
    let t = lines(&[W, "prompt", "call npm 30K", "say 100", "prompt +60s", "say 100", "prompt +60s", "say 100"]);
    caught("m26", "plan.ts", "if (warmLike && !(ctxEst > coldCap)) return null;", "if (false) return null;", "WB", &t);
}

#[test]
fn mh_automatic_head() {
    let t = lines(&["world automatic known ttl=300 true=600 survival=outlives c=1 sys=3000 window=200000 native interactive", "prompt", "call npm 30K", "say 100", "prompt +60s", "say 100", "prompt +1h", "say 100"]);
    caught("m20", "plan.ts", "const head = law.pr?.cls === \"automatic\" ? (MIN_EXPECT - O) / c : 0;", "const head = 0;", "MH", &t);
}

#[test]
fn lw_class_ratios_and_the_long_tier() {
    let t = lines(&[&format!("{W} long"), "prompt", "call npm 30K", "say 100", "prompt +60s", "say 100", "prompt +2h", "say 100"]);
    caught("m21", "learn.ts", "const w = cls === \"explicit\" && longTier ? 2 : d.w;", "const w = d.w;", "LW", &t);
    caught("m06", "learn.ts", "explicit: { r: 0.1, w: 1.25 }", "explicit: { r: 0.1, w: 0.3 }", "LW", &t);
}

#[test]
fn pw_steering_is_not_a_turn() {
    let t = lines(&[W, "prompt", "call npm 30K", "steer", "call npm 30K", "say 100", "prompt +1h", "say 100"]);
    caught("m22", "run.ts", "if (this.runUserSeen++ > 0 && typeof m.timestamp === \"number\") this.steerTs.add(m.timestamp);", "this.runUserSeen++;", "PW", &t);
}

fn trace_of(xs: &[&str]) -> String {
    lines(xs)
}
const WA: &str = "world automatic known ttl=300 true=300 survival=none c=1 sys=3000 window=200000 native interactive";
const WC: &str = "world explicit known ttl=300 true=300 survival=none c=1.7 sys=3000 window=200000 native interactive";

#[test]
fn i1_persisted_equals_sent() {
    let t = trace_of(&[W, "prompt", "call npm 1K", "say 100", "prompt +60s", "say 100", "prompt +1h", "call npm 100", "say 100"]);
    caught("m09", "run.ts", "const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t));", "const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t)).slice(plan.source === \"valve\" ? 0 : 1);", "I1", &t);
}

#[test]
fn b2b_no_back_to_back() {
    let t = trace_of(&["world explicit known ttl=300 true=300 survival=none c=1 sys=3000 window=128000 native interactive", "prompt", "call npm 5K", "call npm 10K", "call npm 11.2K", "call npm 9.6K", "say 100", "prompt +60s", "call npm 28.4K", "call npm 23.3K", "call npm 5K", "call npm 5.7K", "say 100", "prompt +60s", "say 100", "prompt +60s", "say 100"]);
    caught_all("m10", "run.ts", &[("if (!this.cold && this.justEdited) {", "if (false) {", 1), ("if (this.justEdited) {", "if (false) {", 1)], &["B2B"], &t);
}

#[test]
fn rc_recall_is_never_refolded() {
    let rec = |gaps: &[&str]| {
        let mut v = vec![W, "prompt", "call npm 1K", "say 100", "prompt +60s", "call recall", "say 100"];
        for g in gaps {
            v.extend([*g, "say 100"]);
        }
        trace_of(&v)
    };
    caught("m11", "plan.ts", "if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false;", "if (tokOverride.has(b.idx)) return false;", "RC", &rec(&["prompt +330s"]));
    caught("m12", "plan.ts", "b.tokens > foldMin && !isRecall(b) && start[b.idx] >= head", "b.tokens > foldMin && start[b.idx] >= head", "RC", &rec(&["prompt +60s", "prompt +330s"]));
    let restart = trace_of(&[W, "prompt", "call npm 1K", "say 100", "prompt +60s", "call recall", "say 100", "restart", "prompt +330s", "say 100"]);
    caught_all("m23", "run.ts", &[("for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);", "void 0;", 2)], &["RC"], &restart);
}

#[test]
fn pw_protection_windows() {
    caught("m13", "plan.ts", "if (relax && ((mode === \"cold\" && !o.warmStyle) || o.pastTtl === true)) {", "if (relax) {", "PW", &trace_of(&[WC, "prompt", "call cat 20K", "say 100", "prompt +60s", "say 100"]));
    caught("m14", "plan.ts", "const PROTECT_USER_TURNS = 2;", "const PROTECT_USER_TURNS = 1;", "PW", &trace_of(&[W, "prompt", "say 100", "prompt +60s", "say 60K", "prompt +60s", "say 100"]));
}

#[test]
fn mp_residual_new_mechanism() {
    let t = trace_of(&[WC, "prompt", "call cat 26.3K", "say 100", "prompt +60s", "say 100"]);
    caught_all("m28", "plan.ts", &[("if (relax && ((mode === \"cold\" && !o.warmStyle) || o.pastTtl === true)) {", "if (relax && mode === \"warm\") {", 1)], &["MP", "MPr"], &t);
}

/// NOT RUN (ignored, on purpose): since the planner state is read from the branch (state.ts) no small mutant of "a summary was made in
/// this warm stretch" changes what NT sees on a trace the unmutated src passes: the only NT counterexample the mutant hunt found (a
/// cold summary after a model switch that removes almost nothing, 126K context, 123K protected) fails on the unmutated src too
/// (formal/TRIAGE.md, new finding N6). NT can fail (that trace), but no mutant is paired with it yet.
#[test]
#[ignore = "no mutant that the unmutated src survives yet: see TRIAGE N6"]
fn nt_no_thrash() {
    let t = trace_of(&[WA, "prompt", "call npm 25.9K", "say 100", "prompt +60s", "call npm 20K", "call npm 5K", "say 100", "wait +330s", "restart", "prompt +0s", "call npm 13.0K", "say 100", "prompt +60s", "say 100"]);
    caught("m15", "run.ts", "noSummary: mode === \"warm\" && this.summarizedWarm,", "noSummary: false,", "NT", &t);
}

#[test]
fn rd_restart_state_is_read_from_the_branch() {
    let t = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("traces/rd-g.trace")).unwrap();
    caught("m29", "run.ts", "this.g = r.g;", "this.g = G0;", "RD", &t);
}

#[test]
fn tr_target_reachability() {
    let t = trace_of(&[WA, "prompt", "call npm 23.3K", "say 100", "prompt +60s", "call npm 1K", "call npm 11.5K", "call npm 3.3K", "call npm 3.0K", "say 100", "prompt +330s", "say 100"]);
    caught("m17", "plan.ts", "coldCap: envInt(\"COLD_CAP\", 40_000),", "coldCap: envInt(\"COLD_CAP\", 60_000),", "TR", &t);
}

#[test]
fn rd_residual_new_cause() {
    let t = trace_of(&[W, "prompt", "call npm 1K", "say 100", "prompt +60s", "say 100", "prompt +1h", "say 100"]);
    caught_all("m27", "cache.ts", &[("const last = Math.max(lastReqMs, lastMessageMs(branch));", "const last = lastReqMs;", 1)], &["RDr"], &t);
}

/// The harness self-checks and LW's arithmetic fail on a tampered observation of a real run (a cold return that folds an output).
#[test]
fn harness_checks_can_fail() {
    if !available() {
        return;
    }
    let t = Trace::parse(&fold_and_recall()).unwrap();
    let base = observe(&worktree_src(), &t);
    for id in ["W", "G", "LW"] {
        assert!(holds(&base, id), "{id} holds on the real observation");
    }
    let tamper = |f: &dyn Fn(&mut Obs)| {
        let mut o = base.obs.clone();
        f(&mut o);
        Run::new(t.clone(), o)
    };
    // W: the provider's cache disagrees with the spec's clock
    assert!(!holds(&tamper(&|o| o.ticks[3].warm = !o.ticks[3].warm), "W"));
    // G: the probe's re-plan at the actual P differs from the plan run.ts acted on
    assert!(!holds(&tamper(&|o| o.ticks[3].run_plan.as_mut().unwrap().folds.push("x".into())), "G"));
    // LW: a recorded law evaluation that is not law.rs on its inputs
    assert!(!holds(
        &tamper(&|o| {
            let mut n = 0;
            for st in o.ticks.iter_mut().flat_map(|t| t.grids.iter_mut()).flat_map(|g| g.grid.iter_mut()).flat_map(|p| p.law.iter_mut()).filter(|s| s.at == "plan") {
                st.k = st.k.map(|k| k + 1000.0);
                n += 1;
            }
            assert!(n > 0, "the trace records plan steps");
        }),
        "LW"
    ));
}
