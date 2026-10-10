//! pz-formal command line. See README.md ("How to run").
use pz_formal::bridge::Pool;
use pz_formal::check::{check, describe_tick, print_report, Options};
use pz_formal::gen::{quick_suite, random_trace, special, standard_suite, world_preset, Body, Family, Rng};
use pz_formal::law::{grid, lemmas, Point, Terms};
use pz_formal::model::{Run, Trace};
use pz_formal::spec::{all, explain, Evidence};
use std::path::PathBuf;

const USAGE: &str = "usage:
  pz-formal check  --src DIR [--suite standard|quick|none] [--family SPEC] [--random N] [--seed S] [--workers W]
                   [--only ID,ID] [--shrink ROUNDS] [--json FILE] [--verdicts FILE] [--pi DIR] [--plan-opts JSON]
  pz-formal run    --src DIR TRACE_FILE [--pi DIR]      run one trace (text syntax), print every request and the verdicts
  pz-formal lemmas [--src DIR] [--pi DIR]               the law's lemmas on the Rust port (and on the real lawTerms with --src)
  pz-formal spec                                        print the axioms and the derived properties
  pz-formal count  [--suite standard|quick]             how many traces a suite enumerates

  --family 'worlds=explicit,glm depth=4 gaps=60,330,3600 bodies=q,p,b,c specials=switch,restart,foreign'
     worlds: explicit glm fresh tools small claude print long file reread warming; bodies: q p b c bb r s f;
     specials: switch restart foreign late-restart late-switch compact edit
  --verdicts FILE: one JSON line per trace (in check order): {\"n\", \"fails\": {property: class of its first violation}}";

struct Args(Vec<String>);
impl Args {
    fn opt(&self, k: &str) -> Option<String> {
        self.0.iter().position(|a| a == k).and_then(|i| self.0.get(i + 1)).cloned()
    }
    /// Arguments after the command that are neither options nor option values.
    fn positional(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut skip = true; // the command itself
        for a in &self.0 {
            if skip {
                skip = false;
            } else if a.starts_with("--") {
                skip = true; // every option takes a value
            } else {
                out.push(a.clone());
            }
        }
        out
    }
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}\n\n{USAGE}");
    std::process::exit(2)
}

fn parse_family(spec: &str) -> Family {
    let mut f = Family { worlds: vec![world_preset("explicit").unwrap()], depth: 3, gaps: vec![60, 3600], bodies: vec![Body::Q, Body::P, Body::B], specials: vec![] };
    for kv in spec.split_whitespace() {
        let (k, v) = kv.split_once('=').unwrap_or_else(|| die(&format!("bad family token {kv}")));
        let list: Vec<&str> = v.split(',').filter(|s| !s.is_empty()).collect();
        match k {
            "worlds" => f.worlds = list.iter().map(|w| world_preset(w).unwrap_or_else(|| die(&format!("unknown world {w}")))).collect(),
            "depth" => f.depth = v.parse().unwrap_or_else(|_| die("bad depth")),
            "gaps" => f.gaps = list.iter().map(|g| g.parse().unwrap_or_else(|_| die("bad gap"))).collect(),
            "bodies" => f.bodies = list.iter().map(|b| Body::parse(b).unwrap_or_else(|| die(&format!("unknown body {b}")))).collect(),
            "specials" => f.specials = list.iter().map(|s| special(s).unwrap_or_else(|| die(&format!("unknown special {s}")))).collect(),
            _ => die(&format!("unknown family key {k}")),
        }
    }
    f
}

fn families(a: &Args) -> Vec<Family> {
    let mut fs = match a.opt("--suite").as_deref().unwrap_or("standard") {
        "standard" => standard_suite(),
        "quick" => quick_suite(),
        "none" => vec![],
        s => die(&format!("unknown suite {s}")),
    };
    if let Some(spec) = a.opt("--family") {
        fs.push(parse_family(&spec));
    }
    fs
}

fn pool(a: &Args) -> Pool {
    let src = PathBuf::from(a.opt("--src").unwrap_or_else(|| die("--src is required")));
    let workers = a.opt("--workers").and_then(|w| w.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(1)).unwrap_or(4));
    let mut p = Pool::new(&src, workers, a.opt("--pi").map(PathBuf::from)).unwrap_or_else(|e| die(&e));
    if let Some(o) = a.opt("--plan-opts") {
        p.label = format!("{} with {o}", p.label);
        p.plan_opts = Some(o);
    }
    p
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let a = Args(argv.clone());
    match argv.first().map(String::as_str) {
        Some("spec") => {
            for p in all() {
                println!("{} {} [{}]{}", p.id, p.name, match p.evidence { Evidence::Conformance => "conformance", Evidence::Proven => "proven" }, if p.from.is_empty() { String::new() } else { format!(" from {}", p.from.join(", ")) });
                println!("    {}", p.f);
                println!("    {}\n", p.why);
            }
        }
        Some("count") => {
            let fs = families(&a);
            for f in &fs {
                println!("{:>8}  {f:?}", f.size());
            }
            println!("{:>8}  total", fs.iter().map(Family::size).sum::<usize>());
        }
        Some("lemmas") => {
            let pts = grid();
            println!("law lemmas on {} grid points", pts.len());
            for l in lemmas(&pts, &|q: &Point| q.terms()) {
                println!("  {} {:<6} (Rust port)  {}{}", l.name, if l.counterexample.is_none() { "holds" } else { "FAILS" }, l.statement, l.counterexample.map(|c| format!("\n      {c}")).unwrap_or_default());
            }
            if a.opt("--src").is_some() {
                let pool = pool(&a);
                // the same lemmas on the REAL lawTerms: every point (and its lower-P neighbours) through the bridge
                let mut all_pts = pts.clone();
                for q in &pts {
                    for lower in [0.0, q.p / 2.0, (q.p - 0.01).max(0.0)] {
                        all_pts.push(Point { p: lower, ..*q });
                    }
                    all_pts.push(Point { call: 0.0, ..*q });
                }
                let lines: Vec<String> = all_pts.chunks(5_000).enumerate().map(|(k, c)| serde_json::json!({ "id": k, "lawgrid": c.iter().map(Point::json).collect::<Vec<_>>() }).to_string()).collect();
                let mut real: Vec<Terms> = Vec::new();
                for r in pool.raw(&lines) {
                    let v = r.unwrap_or_else(|e| die(&e));
                    for x in v["lawgrid"].as_array().cloned().unwrap_or_default() {
                        let f = |k: &str| match &x[k] {
                            serde_json::Value::Number(n) => n.as_f64().unwrap(),
                            serde_json::Value::String(s) if s == "inf" => f64::INFINITY,
                            serde_json::Value::String(s) if s == "-inf" => f64::NEG_INFINITY,
                            _ => f64::NAN,
                        };
                        real.push(Terms { ok: x["ok"].as_bool().unwrap_or(false), k: f("K"), eta: f("eta"), gain: if f("phi").is_finite() { f("phi") * f("K") } else { f64::NAN } });
                    }
                }
                let table: std::collections::HashMap<String, Terms> = all_pts.iter().zip(real.iter()).map(|(p, t)| (format!("{p:?}"), *t)).collect();
                let mut mismatch = 0;
                for (p, t) in all_pts.iter().zip(&real) {
                    let m = p.terms();
                    if m.ok != t.ok || (m.k.is_finite() && (m.k - t.k).abs() > 1e-6 * m.k.abs().max(1.0)) {
                        mismatch += 1;
                        if mismatch <= 3 {
                            println!("  port != real at {p:?}: port {m:?}, real {t:?}");
                        }
                    }
                }
                println!("  port vs real lawTerms ({}): {} points, {mismatch} mismatches", pool.label, all_pts.len());
                let eval = |q: &Point| table.get(&format!("{q:?}")).copied().unwrap_or_else(|| q.terms());
                for l in lemmas(&pts, &eval) {
                    // E and G need the gain, which the real code exposes only through phi (K > 0): checked on the port
                    if matches!(l.name, "E" | "G") {
                        continue;
                    }
                    println!("  {} {:<6} (real code)  {}{}", l.name, if l.counterexample.is_none() { "holds" } else { "FAILS" }, l.statement, l.counterexample.map(|c| format!("\n      {c}")).unwrap_or_default());
                }
            }
        }
        Some("run") => {
            let file = a.positional().into_iter().next().unwrap_or_else(|| die("a trace file is required"));
            let text = std::fs::read_to_string(&file).unwrap_or_else(|e| die(&format!("{file}: {e}")));
            let trace = Trace::parse(&text).unwrap_or_else(|e| die(&e));
            let pool = pool(&a);
            let obs = pool.run(std::slice::from_ref(&trace)).pop().unwrap();
            if !obs.ok {
                die(&format!("bridge error: {}", obs.errors.join("\n")));
            }
            let run = Run::new(trace, obs);
            println!("{}", run.trace.world);
            let mut by_ev: std::collections::BTreeMap<i64, Vec<usize>> = Default::default();
            for (i, t) in run.obs.ticks.iter().enumerate() {
                by_ev.entry(t.ev).or_default().push(i);
            }
            for (e, ev) in run.trace.events.iter().enumerate() {
                println!("{:>3}  {ev}", e + 1);
                for &i in by_ev.get(&(e as i64)).map(|v| v.as_slice()).unwrap_or(&[]) {
                    println!("       {}", describe_tick(&run, i));
                }
            }
            println!();
            for p in all() {
                match p.f.first_violation(&run) {
                    None => println!("  {:<4} {:<44} PASS", p.id, p.name),
                    Some(v) => {
                        println!("  {:<4} {:<44} FAIL at req {} {:?}", p.id, p.name, v.at, v.witnesses);
                        for w in explain(p.id, &run, v.at) {
                            println!("         {w}");
                        }
                    }
                }
            }
        }
        Some("check") => {
            let pool = pool(&a);
            let only: Option<Vec<String>> = a.opt("--only").map(|s| s.split(',').map(String::from).collect());
            let props: Vec<_> = all().into_iter().filter(|p| only.as_ref().is_none_or(|o| o.iter().any(|x| x == p.id))).collect();
            let fs = families(&a);
            let n_random: usize = a.opt("--random").and_then(|x| x.parse().ok()).unwrap_or(0);
            let seed: u64 = a.opt("--seed").and_then(|x| x.parse().ok()).unwrap_or(1);
            let exhaustive: usize = fs.iter().map(Family::size).sum();
            eprintln!("checking {} on {} exhaustive + {} random traces ({} workers)", pool.label, exhaustive, n_random, std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0));
            let mut rng = Rng::new(seed);
            let traces = fs.iter().flat_map(|f| f.enumerate()).chain((0..n_random).map(move |_| random_trace(&mut rng)));
            let verdicts = a.opt("--verdicts").map(|p| std::io::BufWriter::new(std::fs::File::create(&p).unwrap_or_else(|e| die(&format!("{p}: {e}")))));
            let opts = Options { batch: 512, shrink_rounds: a.opt("--shrink").and_then(|x| x.parse().ok()).unwrap_or(60), progress: true, verdicts: verdicts.map(std::cell::RefCell::new) };
            let rep = check(&pool, &props, traces, &opts);
            let text = print_report(&rep);
            println!("{text}");
            if let Some(path) = a.opt("--json") {
                let j = serde_json::json!({
                    "src": rep.label, "traces": rep.traces, "requests": rep.requests, "bridgeErrors": rep.errors_total,
                    "props": rep.props.iter().map(|p| serde_json::json!({
                        "id": p.id, "name": p.name, "violations": p.violations,
                        "counterexamples": p.examples.iter().map(|(class, n, x)| serde_json::json!({ "class": class, "traces": n, "trace": x.trace.to_string(), "at": x.violation.at, "witnesses": x.violation.witnesses, "rendered": x.rendered })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                });
                std::fs::write(&path, serde_json::to_string_pretty(&j).unwrap()).unwrap_or_else(|e| die(&format!("{path}: {e}")));
            }
        }
        _ => die("unknown command"),
    }
}
