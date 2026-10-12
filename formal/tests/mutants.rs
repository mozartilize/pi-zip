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
    mutant_files(name, &edits.iter().map(|&(from, to, n)| (file, from, to, n)).collect::<Vec<_>>())
}

/// The same, with replacements in several files: (file, from, to, how many times `from` occurs).
fn mutant_files(name: &str, edits: &[(&str, &str, &str, usize)]) -> PathBuf {
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
    for (file, from, to, n) in edits {
        let path = root.join("src").join(file);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches(from).count(), *n, "{name}: the mutation site {from:?} must occur {n} time(s) in {file}");
        std::fs::write(&path, text.replace(from, to)).unwrap();
    }
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
    caught_files(name, &edits.iter().map(|&(from, to, n)| (file, from, to, n)).collect::<Vec<_>>(), props, trace)
}

fn caught_files(name: &str, edits: &[(&str, &str, &str, usize)], props: &[&str], trace: &str) {
    if !available() {
        return;
    }
    let t = Trace::parse(trace).unwrap();
    let base = observe(&worktree_src(), &t);
    let m = mutant_files(name, edits);
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

/// a 150K turn, a cold return of small calls (the window has not slid), a second cold return that summarises: prepared while away.
/// Three calls, not more (round 5): with a long run of small calls the growth estimate g falls so far that a WARM return would
/// summarise too, and rule A then starts the summary at the run's end, which the away timer's mutants cannot remove.
fn summary_prepared_away(gap: &str) -> String {
    let mut v = vec![W, "prompt", "say 150K", "prompt +1h"];
    v.extend(std::iter::repeat_n("call npm 100", 3));
    v.extend(["say 100", gap, "say 100"]);
    lines(&v)
}

/// The same, with a run after the return long enough for a later decision to take a summary produced at the return.
fn summary_prepared_away_run(gap: &str) -> String {
    let mut v = vec![W, "prompt", "say 150K", "prompt +1h"];
    v.extend(std::iter::repeat_n("call npm 100", 3));
    v.extend(["say 100", gap, "call npm 100", "call npm 100", "say 100"]);
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
    caught("m03", "summary.ts", "out.push(...(mu.lines.length ? mu.lines : [NONE_ROW]));", "out.push(NONE_ROW);", "A1", &summary_prepared_away("prompt +1h"));
}

#[test]
fn lw_summary_call_is_priced() {
    let t = lines(&["world explicit known ttl=300 true=300 survival=none c=1 sys=30000 window=200000 native interactive", "prompt", "say 25K", "prompt +60s", "say 100", "prompt +60s", "say 100", "prompt +1h", "say 100"]);
    caught_all("m25", "plan.ts", &[("gate(\"summary\", X, Sr, null, call, Sr, undefined, undefined, isReady)", "gate(\"summary\", X, Sr, null, 0, Sr, undefined, undefined, isReady)", 1)], &["LW"], &t);
}

/// Review P1-3: LW pins the call of a whole-plan step both ways. A plan with a cut that reaches the plan gate with no call (the summary
/// priced separately only), and a folds-only plan that carries one, are both caught. (Backing the call out of K for every plan step let
/// both through: the old LW only compared a call it found with the summary step's.) 0.4.0: in print mode, so nothing is prepared while
/// away and the return's production decision prices the call (a summary prepared away is ready: its call is 0 in both steps).
#[test]
fn lw_plan_step_call_is_pinned_both_ways() {
    caught_all("lw1", "plan.ts", &[("if (!planGate(ctxAfterFolds - (pre[pick] - S(pre[pick])), 0, call, true, isReady)) return false;", "if (!planGate(ctxAfterFolds - (pre[pick] - S(pre[pick])), 0, 0, true, isReady)) return false;", 1)], &["LW"], &summary_prepared_away("prompt +1h").replacen(" interactive", " print", 1));
    caught_all("lw2", "plan.ts", &[("!planGate(ctxAfterFolds, untouchedEst(blocks, folds, false), 0, false)", "!planGate(ctxAfterFolds, untouchedEst(blocks, folds, false), 1000, false)", 1)], &["LW"], &fold_and_recall());
}

/// Never wait (0.4.0 step 4): a turn_end whose plan wants a summary that is not ready takes its folds alone and produces the summary in
/// the background; it waits only when the view after its edit is still at Pi's compaction room. The mutant judges the room at 0 (every
/// turn_end with a cut waits for it: 0.3.0's valve summary at turn_end).
#[test]
fn a3_turn_end_does_not_wait() {
    caught("r5b", "core.ts", "if (room === null || after < room) return null;", "if (room === null) return null;", "A3", &trace_file("a3-warm-turn-end.trace"));
}

/// Never wait at a return: a plan whose summary is not ready (here a restart lost the call still running for it) goes with its folds
/// alone and produces the summary. The mutant is 0.3.1's run-plan summary at a return: the plan keeps its cut and the request waits
/// for the call (core.ts without `unready`, run.ts writing the summary in line).
#[test]
fn a3_return_does_not_wait() {
    caught_files(
        "r5b2",
        &[
            ("core.ts", "\tif (!onPre) {", "\tif (false) {", 1),
            ("run.ts", ": null; // labelled by the return that adopts it", ": await buildCut(p, ctx); // labelled by the return that adopts it", 1),
        ],
        &["A3"],
        &trace_file("rd-restart-mid-call.trace"),
    );
}

/// TR restated (architecture section 8): a return without a ready summary reaches the target at the first decision after it is ready.
/// The mutant forgets which summaries are ready, so the turn_end prices the spent call again and refuses the summary.
#[test]
fn tr_produced_summary_goes_in_once_ready() {
    caught("r4tr", "plan.ts", "const ready = new Set(o.ready ?? []);", "const ready = new Set<string>();", "TR", &trace_file("tr-produced.trace"));
}

/// 0.4.0 step 4, review fix: the turn_end that persists a run plan of folds alone still waits at Pi's compaction room for the room
/// plan's cut (theory 1.4 R9). The mutant persists the run plan alone, and the next request reaches Pi's own threshold (PC).
#[test]
fn pc_run_plan_turn_end_waits_at_the_room() {
    caught("r4pc", "run.ts", "const room = failed ? null : await this.runRoom(e, ctx, this.runPlan, o, pIn);", "const room = null;", "PC", &trace_file("pc-run-plan-room.trace"));
}

/// 0.4.0 step 4, WL restated: a summary a decision wants is produced at once and taken at the first decision after it is ready. The
/// mutant hides ready summaries from the decisions (run.ts ready), so the next return produces the same cut again (WL (c)).
#[test]
fn wl_ready_summary_is_taken_not_produced_again() {
    caught("r4wl", "run.ts", "return readyOf(branch, this.mine).map((a) => ({ key: a.key, running: false }));", "return [];", "WL", &trace_file("wl-ready-taken.trace"));
}

/// The away timer prepares the summary a return after a pause wants, so the return's free rewrite carries it. 0.4.0: nobody waits,
/// so a missing timer (m07) or one that fires after the return (m08) shows as a regret, not a wait: the return goes without the
/// summary and a warm decision of the same run applies it (NR; the return could have prepared it, so it is not excused).
#[test]
fn nr_away_timer() {
    caught("m07", "run.ts", "this.armAway(delay, () => void this.runAway(p, ctx));", "void 0;", "NR", &summary_prepared_away_run("prompt +1h"));
    caught("m08", "run.ts", "export const AWAY_FRACTION = 0.8;", "export const AWAY_FRACTION = 1.15;", "NR", &summary_prepared_away_run("prompt +330s"));
}

#[test]
fn gc_gone_cache_gets_a_cold_plan() {
    let ttl = lines(&[W, "prompt", "call npm 30K", "say 100", "prompt +330s", "say 100"]);
    // 0.4.0: the TTL marks a pause (the learned survival decides cold): the mutant marks it only after 4 x the requested lifetime
    caught("m18", "cache.ts", "pause: nowMs - last >= ttl.ms };", "pause: nowMs - last >= 4 * ttl.ms };", "GC", &ttl);
    caught("m18b", "cache.ts", "return { cold: s.p < 0.5, reason,", "return { cold: s.p < 0.5 && gapS > 1200, reason,", "GC", &ttl);
    let switch = lines(&[W, "prompt", "call npm 30K", "say 100", "switch", "prompt +60s", "say 100"]);
    caught("m19", "cache.ts", "if (prev && modelKey(model) && prev !== modelKey(model)) return", "if (false) return", "GC", &switch);
}

#[test]
fn wb_warm_does_nothing_below_the_target() {
    let t = lines(&[W, "prompt", "call npm 30K", "say 100", "prompt +60s", "say 100", "prompt +60s", "say 100"]);
    // one planner (0.4.0): below the working view nothing is planned, and the folds stop at it; the mutant drops both
    caught_all("m26", "plan.ts", &[("if (!(ctxEst > coldCap)) return null;", "if (false) return null;", 1), ("if (est <= coldCap) return;", "if (false) return;", 1)], &["WB"], &t);
}

#[test]
fn mh_automatic_head() {
    // 0.4.0: a 45K output (one planner: below the working view nothing is planned, so the context must pass it)
    let t = lines(&["world automatic known ttl=300 true=600 survival=outlives c=1 sys=3000 window=200000 native interactive", "prompt", "call npm 45K", "say 100", "prompt +60s", "say 100", "prompt +1h", "say 100"]);
    caught("m20", "plan.ts", "const head = law.pr.cls === \"automatic\" ? (MIN_EXPECT - O) / c : 0;", "const head = 0;", "MH", &t);
}

#[test]
fn lw_class_ratios_and_the_long_tier() {
    let t = lines(&[&format!("{W} long"), "prompt", "call npm 30K", "say 100", "prompt +60s", "say 100", "prompt +2h", "say 100"]);
    caught("m21", "learn.ts", "const w = k === \"explicit\" && longTier ? 2 : d.w;", "const w = d.w;", "LW", &t);
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
    let t = trace_of(&[W, "prompt", "call npm 45K", "say 100", "prompt +60s", "say 100", "prompt +1h", "call npm 100", "say 100"]);
    caught("m09", "run.ts", "const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t));", "const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t)).slice(plan.source === \"valve\" ? 0 : 1);", "I1", &t);
}

#[test]
fn b2b_no_back_to_back() {
    // 0.4.0: the folds stop at the working view, so a second rewrite needs new candidates: the window slides at the next prompt.
    // traces/b2b-slide.trace is the shrunk counterexample of `check --suite standard --random 3000 --seed 1 --only B2B` on the mutant
    let t = trace_file("b2b-slide.trace");
    caught_all("m10", "core.ts", &[("if (!cold && x.justEdited && !nat) {", "if (false) {", 1), ("if (x.justEdited && x.pWarm >= 0.5) {", "if (false) {", 1)], &["B2B"], &t);
}

#[test]
fn rc_recall_is_never_refolded() {
    let rec = |gaps: &[&str]| {
        let mut v = vec![W, "prompt", "call npm 45K", "say 100", "prompt +60s", "call recall", "say 100"];
        for g in gaps {
            v.extend([*g, "say 100"]);
        }
        trace_of(&v)
    };
    caught("m11", "plan.ts", "if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false;", "if (tokOverride.has(b.idx)) return false;", "RC", &rec(&["prompt +60s", "prompt +330s"]));
    caught("m12", "plan.ts", "b.tokens > foldMin && !isRecall(b) && start[b.idx] >= head", "b.tokens > foldMin && start[b.idx] >= head", "RC", &rec(&["prompt +60s", "prompt +330s"]));
    let restart = trace_of(&[W, "prompt", "call npm 45K", "say 100", "prompt +60s", "call recall", "say 100", "restart", "prompt +330s", "say 100"]);
    caught_all("m23", "run.ts", &[("\t\tfor (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);\n", "\t\tvoid 0;\n", 3)], &["RC"], &restart);
}

#[test]
fn pw_protection_windows() {
    caught("m13", "plan.ts", "if (o.pause) take(", "if (true) take(", "PW", &trace_of(&[WC, "prompt", "call cat 20K", "say 100", "prompt +60s", "say 100"]));
    caught("m14", "plan.ts", "const PROTECT_USER_TURNS = 2;", "const PROTECT_USER_TURNS = 1;", "PW", &trace_of(&[W, "prompt", "say 100", "prompt +60s", "say 60K", "prompt +60s", "call npm 100", "call npm 100", "say 100"]));
}

#[test]
fn mp_residual_new_mechanism() {
    let t = trace_of(&[WC, "prompt", "call cat 26.3K", "say 100", "prompt +60s", "say 100"]);
    // the previous turn's candidates depend on P (v0.3.1's warm-only relax, inverted): MP is structural only while P stays in the law
    caught_all("m28", "plan.ts", &[("if (o.pause) take(", "if (law.pWarm >= 0.5) take(", 1)], &["MP", "MPr"], &t);
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
    // 0.4.0: the fresh process takes the return for a session's first request (P = 0, no pause): it differs from the live one only by
    // the pause, so the previous turn holds a re-readable output the pause folds, and the older turn is prose only a summary removes
    let t = trace_of(&[W, "prompt", "say 30K", "prompt +60s", "call cat 30K", "say 100", "prompt +1h", "say 100"]);
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

// ---- review round 4: the model's blind spots (runs an extension's message starts, nextTurn messages, completeness) -------------

/// RC with file recall: a read of a recall file made inside a run is in the branch only; the turn_end after it must know the handle.
/// traces/rc-file-recall-in-run.trace is the shrunk seed-7 counterexample on 0.4.0 step 3 before the fix (its RC rose by 1 there).
#[test]
fn rc_file_recall_inside_a_run() {
    let t = trace_file("rc-file-recall-in-run.trace");
    caught("rcf", "run.ts", "\t\tfor (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);\n\t\tconst pIn", "\t\tconst pIn", "RC", &t);
}

fn trace_file(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("traces").join(name)).unwrap()
}

/// WL (b): the one-summary-per-warm-stretch flag lapses once the context has grown back to the size the stretch's summary started
/// from. The mutant is the flag of 4795af3, which never lapses: at request 80 the context is back at 100K (the summary started from
/// 75K) and a summary that pays (Phi 5.3) is withheld. NT holds on the src: the second summary comes after the regrowth.
#[test]
fn wl_the_one_summary_flag_lapses() {
    let t = trace_file("wl-regrow.trace");
    caught_all(
        "wl1",
        "plan.ts",
        &[("const noSummary = !!o.noSummary && !(o.regrowAt !== undefined && o.regrowAt > 0 && real(ctxAfterFolds) >= o.regrowAt);", "const noSummary = !!o.noSummary;", 1)],
        &["WL"],
        &t,
    );
}

/// WL (b), review P0-1: a summary, a cold wake started by an extension's message, a restart: the resumed process must know the wake
/// ended the warm stretch. The mutant is 4795af3's restore: it walks only user prompts (summarizedSince) and has no regrowth rule, so
/// it restores the flag for a stretch the wake had ended and withholds the summary at request 81 (Phi 5.3); 4795af3 itself fails WL
/// on this trace the same way. (With the regrowth rule alone the flag would lapse at the same request: both edits are needed.)
#[test]
fn wl_a_restart_knows_a_driven_cold_wake() {
    let t = trace_file("wl-drive-restart.trace");
    caught_all(
        "wl2",
        "core.ts",
        &[
            ("if (!afterAnswer) continue; // mid-run, or riding with the prompt just before it", "continue;", 1),
            // lastRegrow is read only by run.ts restoreState: the same as restoring `summaryRegrow = undefined`
            ("return typeof e.details.regrow === \"number\" && e.details.regrow > 0 ? e.details.regrow : undefined;", "return undefined;", 1),
        ],
        &["WL"],
        &t,
    );
}

/// GC over `drive`: a run an extension's message starts after an hour is planned cold. The mutant drops the agent_start handling
/// (2cda8e1 and earlier): the driven run is planned on the state of the previous prompt.
#[test]
fn gc_a_driven_run_after_the_ttl_is_cold() {
    let t = trace_file("gc-drive.trace");
    caught("drv", "index.ts", "pi.on(\"agent_start\", (_e, ctx) => zip.agentStart(ctx));", "", "GC", &t);
}

/// PW over `nextturn`, review P0-2: Pi stores a prompt first and the nextTurn message after it; the mutant (4795af3's buildBlocks)
/// counts that message as a turn of its own, so the window covers only the newest prompt and the previous turn's output is folded
/// at a cold return. 4795af3 fails PW on this trace at request 2.
#[test]
fn pw_a_nexturn_message_is_not_a_turn() {
    let t = trace_file("pw-nextturn.trace");
    caught("p02", "plan.ts", "\t\t\tstarter = false;\n\t\t\tafterAnswer = false;\n", "\t\t\tstarter = false;\n", "PW", &t);
}

/// TR over `drive`, found by this round's run: a run an extension's message starts right after a refused request is a new turn
/// (the failed run ended there). The mutant (4795af3 / 007d1d1's buildBlocks) counts it into the failed run's turn, which stays
/// protected, so the cold return an hour later keeps a 20K output and stops at 52.6K against a 40K target.
#[test]
fn tr_a_driven_run_after_a_failed_request_is_a_turn() {
    let t = trace_file("tr-drive-after-error.trace");
    caught("trd", "plan.ts", "if (kind === \"assistant\") afterAnswer = msg.stopReason !== \"toolUse\";", "if (kind === \"assistant\") afterAnswer = msg.stopReason !== \"toolUse\" && msg.stopReason !== \"error\" && msg.stopReason !== \"aborted\";", "TR", &t);
}

/// TR over `drive`, found by this round's seed-7 run: a summary before a run an extension started keeps from that run's custom
/// message (one of Pi's own cut points). The mutant (4795af3) cuts only at user and assistant messages, so the kept tail starts at the
/// previous turn's 29K final answer and the cold return leaves 60.6K against a 40K target.
#[test]
fn tr_a_summary_may_keep_from_a_driven_runs_message() {
    let t = trace_file("tr-cut-at-drive.trace");
    caught("trc", "plan.ts", " || (b.kind === \"other\" && b.msg?.role === \"custom\"));", ");", "TR", &t);
}
