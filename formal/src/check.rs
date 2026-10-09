//! The checker: run traces on the system under test, evaluate every property, keep the smallest counterexample of each,
//! shrink it, and render it as a readable trace.
use crate::bridge::Pool;
use crate::gen::shrink;
use crate::logic::Violation;
use crate::model::*;
use crate::spec::{explain, Evidence, Prop};
use std::fmt::Write as _;

pub struct Example {
    pub trace: Trace,
    pub original_events: usize,
    pub shrink_runs: usize,
    pub violation: Violation,
    pub rendered: String,
}

pub struct PropResult {
    pub id: &'static str,
    pub name: &'static str,
    pub evidence: Evidence,
    pub violations: usize,
    /// one minimal counterexample per class (mechanism), with how many traces fell in that class
    pub examples: Vec<(String, usize, Example)>,
}

pub struct Report {
    pub label: String,
    pub traces: usize,
    pub requests: usize,
    pub errors: Vec<(Trace, Vec<String>)>,
    pub errors_total: usize,
    pub props: Vec<PropResult>,
}

pub struct Options {
    pub batch: usize,
    pub shrink_rounds: usize,
    pub progress: bool,
}

/// Check every property on every trace (in batches), then shrink the smallest counterexample of each failing property.
pub fn check(pool: &Pool, props: &[Prop], traces: impl Iterator<Item = Trace>, opts: &Options) -> Report {
    let mut best: Vec<std::collections::BTreeMap<String, (usize, Trace)>> = props.iter().map(|_| Default::default()).collect();
    let mut counts = vec![0usize; props.len()];
    let mut errors = Vec::new();
    let (mut errors_total, mut total, mut requests) = (0, 0, 0);
    let mut batch = Vec::with_capacity(opts.batch);
    let mut flush = |batch: &mut Vec<Trace>, total: &mut usize, requests: &mut usize| {
        if batch.is_empty() {
            return;
        }
        let obs = pool.run(batch);
        for (t, o) in batch.drain(..).zip(obs) {
            *total += 1;
            if !o.ok {
                errors_total += 1;
                if errors.len() < 5 {
                    errors.push((t, o.errors.clone()));
                }
                continue;
            }
            *requests += o.ticks.len();
            let run = Run::new(t, o);
            for (k, p) in props.iter().enumerate() {
                if let Some(v) = p.f.first_violation(&run) {
                    counts[k] += 1;
                    let e = best[k].entry(p.class(&run, &v)).or_insert((0, run.trace.clone()));
                    e.0 += 1;
                    if run.trace.weight() < e.1.weight() {
                        e.1 = run.trace.clone();
                    }
                }
            }
        }
        if opts.progress {
            eprint!("\r  {} traces, {} requests, failing: {}        ", total, requests, props.iter().zip(&counts).filter(|(_, c)| **c > 0).map(|(p, c)| format!("{} {c}", p.id)).collect::<Vec<_>>().join(", "));
        }
    };
    for t in traces {
        batch.push(t);
        if batch.len() >= opts.batch {
            flush(&mut batch, &mut total, &mut requests);
        }
    }
    flush(&mut batch, &mut total, &mut requests);
    if opts.progress {
        eprintln!();
    }
    let mut results = Vec::new();
    for (k, p) in props.iter().enumerate() {
        let mut examples = Vec::new();
        for (class, (n, t)) in std::mem::take(&mut best[k]) {
            if opts.progress {
                eprintln!("  shrinking {} [{class}] ({} events)", p.id, t.events.len());
            }
            if let Some(x) = minimal(pool, p, &class, t, opts.shrink_rounds) {
                examples.push((class, n, x));
            }
        }
        results.push(PropResult { id: p.id, name: p.name, evidence: p.evidence, violations: counts[k], examples });
    }
    Report { label: pool.label.clone(), traces: total, requests, errors, errors_total, props: results }
}

/// Shrink a failing trace for one property, keeping the violation in the same class, and render the result.
pub fn minimal(pool: &Pool, p: &Prop, class: &str, t: Trace, rounds: usize) -> Option<Example> {
    let original_events = t.events.len();
    let mut fails = |cs: &[Trace]| -> Vec<bool> {
        pool.run(cs)
            .into_iter()
            .zip(cs)
            .map(|(o, t)| {
                if !o.ok {
                    return false;
                }
                let run = Run::new(t.clone(), o);
                p.f.first_violation(&run).is_some_and(|v| p.class(&run, &v) == class)
            })
            .collect()
    };
    let (small, shrink_runs) = if rounds > 0 { shrink(t, rounds, &mut fails) } else { (t, 0) };
    let o = pool.run(std::slice::from_ref(&small)).pop()?;
    let run = Run::new(small.clone(), o);
    let violation = p.f.first_violation(&run)?;
    let rendered = render(&run, p, &violation);
    Some(Example { trace: small, original_events, shrink_runs, violation, rendered })
}

fn kt(x: f64) -> String {
    if x >= 1000.0 {
        format!("{:.1}K", x / 1000.0)
    } else {
        format!("{x:.0}")
    }
}

/// One line about request i: the cache, the plan, what changed.
pub fn describe_tick(r: &Run, i: usize) -> String {
    let t = r.tick(i);
    let s = &r.st[i];
    let mut out = format!("req {i}: ");
    if t.n == 0 && t.gap.is_none() {
        let _ = write!(out, "first prompt, ");
    } else if t.n == 0 {
        if let Some(s0) = &t.state0 {
            let _ = write!(out, "{} return{} (P(warm) {:.2}{}), ", if s0.cold { "cold" } else { "warm" }, t.gap.map(|g| format!(" after {:.0}s", g)).unwrap_or_default(), s0.p_warm.unwrap_or(1.0), if s0.past_ttl { ", past TTL" } else { "" });
        }
    }
    let _ = write!(out, "cache {}, sends {}", if s.warm { "warm" } else { "cold" }, kt(s.view_tok));
    let folds = t.zip_new.iter().filter(|m| m.starts_with("f:")).count();
    let sums = t.zip_new.iter().filter(|m| m.starts_with("s:")).count();
    if folds + sums > 0 {
        let src = r.decision_for(i).map(|g| if g.at == "run" { format!("{} run plan", g.mode) } else { "warm valve (previous turn_end)".into() }).unwrap_or_default();
        let _ = write!(out, " · NEW EDIT by the {src}:{}{}", if folds > 0 { format!(" {folds} fold(s)") } else { String::new() }, if sums > 0 { " a summary" } else { "" });
    } else if t.n == 0 && t.run_plan.is_some() {
        let _ = write!(out, " · plan: no edit");
    }
    let waited = t.wait_run > 0 || (i > 0 && r.tick(i - 1).wait_te > 0);
    if waited && r.trace.world.interactive {
        let _ = write!(out, " · the user waits for a summary call");
    }
    if !t.env.is_empty() {
        let _ = write!(out, " · since the previous request: {}", t.env.join(", "));
    }
    let skips: Vec<&str> = r.ledger(i, "b2b_skip").iter().filter_map(|v| v.get("where").and_then(|x| x.as_str())).collect();
    if !skips.is_empty() {
        let _ = write!(out, " · b2b skip at {}", skips.join("+"));
    }
    out
}

pub fn render(r: &Run, p: &Prop, v: &Violation) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "    {}", r.trace.world);
    let mut by_ev: std::collections::BTreeMap<i64, Vec<usize>> = Default::default();
    for (i, t) in r.obs.ticks.iter().enumerate() {
        by_ev.entry(t.ev).or_default().push(i);
    }
    for (e, ev) in r.trace.events.iter().enumerate() {
        let _ = writeln!(out, "    {:>3}  {ev}", e + 1);
        for &i in by_ev.get(&(e as i64)).map(|v| v.as_slice()).unwrap_or(&[]) {
            let mark = if i == v.at { "✗" } else if v.witnesses.contains(&i) { "▶" } else { " " };
            let _ = writeln!(out, "         {mark} {}", describe_tick(r, i));
        }
    }
    let mut why = explain(p.id, r, v.at);
    if why.is_empty() {
        if let Some(&w) = v.witnesses.iter().max() {
            why = explain(p.id, r, w);
        }
    }
    let _ = writeln!(out, "    violated at req {}{}", v.at, if v.witnesses.is_empty() { String::new() } else { format!(", witnessed by req {:?}", v.witnesses) });
    for w in why {
        let _ = writeln!(out, "    why: {w}");
    }
    out
}

pub fn print_report(rep: &Report) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "== {}: {} traces, {} requests{}", rep.label, rep.traces, rep.requests, if rep.errors_total > 0 { format!(", {} bridge errors", rep.errors_total) } else { String::new() });
    for (t, e) in &rep.errors {
        let _ = writeln!(out, "  bridge error on:\n{}  {}", indent(&t.to_string()), e.join("\n  ").lines().take(6).collect::<Vec<_>>().join("\n  "));
    }
    for p in &rep.props {
        let ev = match p.evidence {
            Evidence::Conformance => "conformance",
            Evidence::Proven => "proven+conformance",
        };
        let _ = writeln!(out, "  {:<4} {:<44} {:<18} {}", p.id, p.name, ev, if p.violations == 0 { "PASS".to_string() } else { format!("FAIL ({} of {} traces)", p.violations, rep.traces) });
    }
    for p in &rep.props {
        for (class, n, x) in &p.examples {
            let _ = writeln!(out, "\n  -- {} {}{}: minimal counterexample ({} events, shrunk from {} in {} runs; {n} traces in this class)", p.id, p.name, if class.is_empty() { String::new() } else { format!(" [{class}]") }, x.trace.events.len(), x.original_events, x.shrink_runs);
            out.push_str(&x.rendered);
        }
    }
    out
}

fn indent(s: &str) -> String {
    s.lines().map(|l| format!("    {l}\n")).collect()
}
