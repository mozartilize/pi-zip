//! Traces: exhaustive enumeration over small discretised runs, random traces at realistic sizes, and shrinking.
use crate::model::*;

// ---- discretised runs ---------------------------------------------------------------------------------------------------------

/// The body of one run in the exhaustive alphabet (after its prompt).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Body {
    /// a quick answer
    Q,
    /// a long prose answer (bulk no fold can remove: only a summary can)
    P,
    /// one big mutating command output (`npm test`: not re-readable)
    B,
    /// one big re-readable output (`cat`)
    C,
    /// two mid-size command outputs (the session's growth g rises)
    BB,
    /// zip_recall of the newest folded output
    R,
    /// a mid-run steering message between two command outputs (not a new user turn)
    S,
    /// a command output, then the next request fails (the provider refuses it) and the run ends
    F,
    /// a custom message rides with the prompt (Pi stores it right after the prompt: nextTurn, before_agent_start), then a mid-size
    /// command output: one user turn, not two
    N,
}
pub const LARGE: u32 = 60_000;
pub const MID: u32 = 25_000;

impl Body {
    pub fn parse(s: &str) -> Option<Body> {
        Some(match s {
            "q" => Body::Q,
            "p" => Body::P,
            "b" => Body::B,
            "c" => Body::C,
            "bb" => Body::BB,
            "r" => Body::R,
            "s" => Body::S,
            "f" => Body::F,
            "n" => Body::N,
            _ => return None,
        })
    }
    pub fn events(self) -> Vec<Event> {
        let say = Event::Say { size: 100 };
        match self {
            Body::Q => vec![say],
            Body::P => vec![Event::Say { size: LARGE }],
            Body::B => vec![Event::Call { tool: Tool::Npm, size: LARGE / 2 }, say],
            Body::C => vec![Event::Call { tool: Tool::Cat, size: LARGE / 2 }, say],
            Body::BB => vec![Event::Call { tool: Tool::Npm, size: MID }, Event::Call { tool: Tool::Npm, size: MID }, say],
            Body::R => vec![Event::Call { tool: Tool::Recall, size: 0 }, say],
            Body::S => vec![Event::Call { tool: Tool::Npm, size: MID }, Event::Steer, Event::Call { tool: Tool::Npm, size: MID }, say],
            Body::F => vec![Event::Call { tool: Tool::Npm, size: LARGE / 2 }, Event::Fail { abort: false }],
            Body::N => vec![Event::NextTurn, Event::Call { tool: Tool::Npm, size: MID }, say],
        }
    }
}

/// An exhaustive family: every sequence of `depth` runs over `gaps` x `bodies` (the first run has no gap), optionally with one
/// special (a short event sequence: switch, restart, foreign, ...) before one of the runs after the first, in each world.
#[derive(Clone, Debug)]
pub struct Family {
    pub worlds: Vec<World>,
    pub depth: usize,
    pub gaps: Vec<u32>,
    pub bodies: Vec<Body>,
    pub specials: Vec<Vec<Event>>,
}

/// The specials by name (`--family specials=...`): one event, or a restart at the return (the user is away an hour, the process
/// restarts, the prompt follows the family's gap later).
pub fn special(name: &str) -> Option<Vec<Event>> {
    Some(match name {
        "switch" => vec![Event::Switch],
        "restart" => vec![Event::Restart],
        "foreign" => vec![Event::Foreign { size: 2_000 }],
        "late-restart" => vec![Event::Wait { gap: 3_600 }, Event::Restart],
        "late-switch" => vec![Event::Wait { gap: 240 }, Event::Switch],
        "compact" => vec![Event::Compact],
        "edit" => vec![Event::Edit],
        // a run an extension's message starts (no prompt), an hour after the previous one (a cold wake) or a minute after it (warm),
        // and the cold wake followed by a restart (a resumed process must know the wake was a cold return)
        "drive" => vec![Event::Drive { gap: 3_600 }, Event::Call { tool: Tool::Npm, size: MID }, Event::Say { size: 100 }],
        "drive-warm" => vec![Event::Drive { gap: 60 }, Event::Call { tool: Tool::Npm, size: MID }, Event::Say { size: 100 }],
        "drive-restart" => vec![Event::Drive { gap: 3_600 }, Event::Call { tool: Tool::Npm, size: MID }, Event::Say { size: 100 }, Event::Restart],
        _ => return None,
    })
}

impl Family {
    pub fn size(&self) -> usize {
        let per = self.gaps.len() * self.bodies.len();
        let base = self.bodies.len() * per.pow(self.depth.saturating_sub(1) as u32);
        self.worlds.len() * base * (1 + self.specials.len() * self.depth.saturating_sub(1))
    }

    pub fn enumerate(&self) -> Vec<Trace> {
        let mut out = Vec::with_capacity(self.size());
        let per = self.gaps.len() * self.bodies.len();
        for w in &self.worlds {
            for first in &self.bodies {
                let rest_count = per.pow(self.depth.saturating_sub(1) as u32);
                for code in 0..rest_count {
                    let mut runs: Vec<(u32, Body)> = vec![(0, *first)];
                    let mut c = code;
                    for _ in 1..self.depth {
                        let x = c % per;
                        c /= per;
                        runs.push((self.gaps[x / self.bodies.len()], self.bodies[x % self.bodies.len()]));
                    }
                    let base = build(w, &runs, None);
                    out.push(base);
                    for s in &self.specials {
                        for at in 1..self.depth {
                            out.push(build(w, &runs, Some((at, s.clone()))));
                        }
                    }
                }
            }
        }
        out
    }
}

fn build(w: &World, runs: &[(u32, Body)], special: Option<(usize, Vec<Event>)>) -> Trace {
    let mut events = Vec::new();
    for (k, (gap, body)) in runs.iter().enumerate() {
        if let Some((at, e)) = &special {
            if *at == k {
                events.extend(e.iter().cloned());
            }
        }
        events.push(Event::Prompt { gap: *gap });
        events.extend(body.events());
    }
    Trace { world: w.clone(), events }
}

pub fn world_preset(name: &str) -> Option<World> {
    let d = World::default();
    Some(match name {
        // Claude-like: explicit cache, 5-minute TTL kept exactly
        "explicit" => d,
        // GLM-like: automatic prefix cache that outlives its declared 5 minutes, and pi-zip has learned that
        "glm" => World { cls: Class::Automatic, ttl_true: 600, survival: Survival::Outlives, ..d },
        // the class is not known yet (first session with this model): the legacy rule until the first response
        "fresh" => World { known: false, ..d },
        // a large tool set: the fixed prefix O is above half the cap
        "tools" => World { sys: 30_000, ..d },
        // a small window: Pi's compaction room is close
        "small" => World { window: 128_000, ..d },
        // Claude real-token scale
        "claude" => World { c: 1.7, ..d },
        // print / json mode: no away timer
        "print" => World { interactive: false, ..d },
        // the 1-hour tier (PI_CACHE_RETENTION=long)
        "long" => World { tier: Tier::Long, ..d },
        // a `--tools read,bash` allowlist: zip_recall hidden, recall through files
        "file" => World { tools: Tools::File, ..d },
        // an allowlist without read, grep, bash or zip_recall: only re-readable outputs fold
        "reread" => World { tools: Tools::Reread, ..d },
        // Pi's idle cache warming on (and a model expensive enough that refreshing a large context pays)
        "warming" => World { warming: true, ..d },
        // a summary call takes 2 minutes of the clock: a restart or a return can come while one runs (not in the standard suite)
        "slow" => World { slow: true, ..d },
        _ => return None,
    })
}

/// The standard exhaustive suite: five families, sized to run in minutes on the real implementation.
pub fn standard_suite() -> Vec<Family> {
    let w = |n: &str| world_preset(n).unwrap();
    let sp = |n: &str| special(n).unwrap();
    vec![
        // depth 4, every gap class, every body, two worlds
        Family { worlds: vec![w("explicit"), w("glm")], depth: 4, gaps: vec![60, 330, 3600], bodies: vec![Body::Q, Body::P, Body::B, Body::C], specials: vec![] },
        // depth 5, short and long gaps only (the window slides over five user turns)
        Family { worlds: vec![w("explicit")], depth: 5, gaps: vec![60, 3600], bodies: vec![Body::Q, Body::P, Body::B], specials: vec![] },
        // depth 3 with one special event, growth and recall bodies
        Family {
            worlds: vec![w("explicit")],
            depth: 3,
            gaps: vec![60, 270, 3600],
            bodies: vec![Body::Q, Body::P, Body::BB, Body::R],
            specials: vec![sp("switch"), sp("restart"), sp("foreign")],
        },
        // depth 3: steering and failing runs, a restart or a switch at the return, Pi's own compaction, another extension's edit
        Family {
            worlds: vec![w("explicit")],
            depth: 3,
            gaps: vec![60, 3600],
            bodies: vec![Body::Q, Body::P, Body::B, Body::S, Body::F],
            specials: vec![sp("late-restart"), sp("late-switch"), sp("compact"), sp("edit")],
        },
        // depth 3 in the other tool selections, the 1-hour tier and with Pi's idle cache warming
        Family { worlds: vec![w("long"), w("file"), w("reread"), w("warming")], depth: 3, gaps: vec![60, 330, 3600, 7200], bodies: vec![Body::Q, Body::P, Body::C, Body::R], specials: vec![] },
        // depth 3: runs an extension's message starts (cold, warm, a cold wake then a restart) and prompts a custom message rides with
        Family {
            worlds: vec![w("explicit"), w("small")],
            depth: 3,
            gaps: vec![60, 3600],
            bodies: vec![Body::Q, Body::P, Body::B, Body::N],
            specials: vec![sp("drive"), sp("drive-warm"), sp("drive-restart")],
        },
    ]
}

/// A small suite for smoke tests and CI.
pub fn quick_suite() -> Vec<Family> {
    vec![Family { worlds: vec![World::default()], depth: 3, gaps: vec![60, 3600], bodies: vec![Body::Q, Body::P, Body::B], specials: vec![] }]
}

// ---- random traces --------------------------------------------------------------------------------------------------------------

/// splitmix64: a tiny deterministic PRNG (no dependency).
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.f() * n as f64) as usize % n.max(1)
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.f() < p
    }
    /// log-uniform in [lo, hi]
    pub fn log(&mut self, lo: f64, hi: f64) -> u32 {
        (lo * (hi / lo).powf(self.f())).round() as u32
    }
    pub fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

/// A random trace at realistic sizes: 3-10 runs, 0-6 tool calls a run (sometimes a long autonomous run), outputs 100-40K tokens,
/// prose up to 30K, gaps from seconds to hours, occasional switches, restarts, foreign compactions and recalls, a random world.
pub fn random_trace(rng: &mut Rng) -> Trace {
    let world = World {
        cls: if rng.chance(0.35) { Class::Automatic } else { Class::Explicit },
        known: rng.chance(0.85),
        ttl: 300,
        ttl_true: if rng.chance(0.2) { 600 } else { 300 },
        survival: Survival::None,
        c: *rng.pick(&[1.0, 1.0, 1.7]),
        sys: *rng.pick(&[2_000, 3_000, 8_000, 30_000]),
        window: if rng.chance(0.2) { 128_000 } else { 200_000 },
        native: rng.chance(0.7),
        interactive: rng.chance(0.9),
        tier: if rng.chance(0.15) { Tier::Long } else { Tier::Short },
        tools: if rng.chance(0.08) { Tools::File } else if rng.chance(0.05) { Tools::Reread } else { Tools::Full },
        warming: rng.chance(0.15),
        slow: false, // no draw: the random stream (and every seed's traces) stay as they were
    };
    let world = World { survival: if world.ttl_true > world.ttl && rng.chance(0.7) { Survival::Outlives } else { Survival::None }, ..world };
    let runs = 3 + rng.below(8);
    let mut events = Vec::new();
    // runs an extension's message starts and custom messages riding with a prompt are drawn from a second stream seeded from this one's
    // state (not advancing it): the rest of every trace is what the same seed drew before they existed
    let mut aux = Rng::new(rng.0.rotate_left(29) ^ 0xA076_1D64_78BD_642F);
    for k in 0..runs {
        if k > 0 {
            if rng.chance(0.05) {
                events.push(Event::Switch);
            }
            if rng.chance(0.05) {
                events.push(Event::Restart);
            }
            if rng.chance(0.03) {
                events.push(Event::Foreign { size: rng.log(500.0, 8_000.0) });
            }
            if rng.chance(0.03) {
                events.push(Event::Compact);
            }
            if rng.chance(0.03) {
                events.push(Event::Edit);
            }
            if rng.chance(0.05) {
                // away without a prompt, then a restart or a switch at the return
                events.push(Event::Wait { gap: rng.log(200.0, 7_200.0) });
                events.push(if rng.chance(0.6) { Event::Restart } else { Event::Switch });
            }
        }
        let gap = if k == 0 {
            0
        } else {
            match rng.below(6) {
                0 => rng.log(5.0, 120.0),
                1 => rng.log(120.0, 280.0),
                2 => rng.log(280.0, 330.0),
                3 => rng.log(330.0, 700.0),
                _ => rng.log(700.0, 20_000.0),
            }
        };
        if k > 0 && aux.chance(0.12) {
            events.push(Event::Drive { gap });
        } else {
            events.push(Event::Prompt { gap });
            if aux.chance(0.1) {
                events.push(Event::NextTurn);
            }
        }
        let calls = if rng.chance(0.04) { 20 + rng.below(50) } else { rng.below(7) };
        for _ in 0..calls {
            let tool = if rng.chance(0.06) { Tool::Recall } else if rng.chance(0.4) { Tool::Cat } else { Tool::Npm };
            events.push(Event::Call { tool, size: if tool == Tool::Recall { 0 } else { rng.log(100.0, 40_000.0) } });
            if rng.chance(0.04) {
                events.push(Event::Steer);
            }
            if rng.chance(0.01) {
                events.push(if rng.chance(0.5) { Event::Compact } else { Event::Edit });
            }
        }
        if rng.chance(0.03) {
            events.push(Event::Fail { abort: rng.chance(0.4) });
        } else {
            events.push(Event::Say { size: if rng.chance(0.25) { rng.log(2_000.0, 30_000.0) } else { rng.log(30.0, 800.0) } });
        }
    }
    normalize(Trace { world, events })
}

// ---- shrinking ---------------------------------------------------------------------------------------------------------------

/// Index ranges of the runs of a trace: each run is its prompt plus everything up to the next prompt (specials before a prompt
/// belong to the run they precede).
fn runs_of(t: &Trace) -> Vec<(usize, usize)> {
    let mut starts = Vec::new();
    let mut k = 0;
    while k < t.events.len() {
        let mut s = k;
        while s < t.events.len() && !t.events[s].starts_run() {
            s += 1;
        }
        if s >= t.events.len() {
            break;
        }
        // specials just before the prompt belong to it
        let mut b = s;
        while b > k && t.events[b - 1].is_special() {
            b -= 1;
        }
        starts.push(b);
        k = s + 1;
    }
    let mut out = Vec::new();
    for (j, &s) in starts.iter().enumerate() {
        out.push((s, if j + 1 < starts.len() { starts[j + 1] } else { t.events.len() }));
    }
    out
}

/// Make a trace well-formed: the first prompt has gap 0, every run ends with a say or a fail, no special before the first prompt,
/// a steering message only right after a tool call of an open run.
pub fn normalize(mut t: Trace) -> Trace {
    while t.events.first().is_some_and(|e| !matches!(e, Event::Prompt { .. })) {
        t.events.remove(0); // the session starts with a prompt (a run an extension starts needs a session to start in)
    }
    if let Some(Event::Prompt { gap }) = t.events.first_mut() {
        *gap = 0;
    }
    let mut out: Vec<Event> = Vec::new();
    let mut open = false;
    for e in t.events {
        match e {
            Event::Prompt { .. } | Event::Drive { .. } | Event::Switch | Event::Restart | Event::Foreign { .. } | Event::Wait { .. } => {
                if open {
                    out.push(Event::Say { size: 100 });
                    open = false;
                }
                if e.starts_run() {
                    open = true;
                }
                out.push(e);
            }
            Event::NextTurn => {
                // only right after a prompt (Pi stores it with the prompt, before the first request)
                if open && matches!(out.last(), Some(Event::Prompt { .. }) | Some(Event::NextTurn)) {
                    out.push(e);
                }
            }
            Event::Say { .. } | Event::Fail { .. } => {
                if open {
                    out.push(e);
                    open = false;
                }
            }
            Event::Call { .. } => {
                if open {
                    out.push(e);
                }
            }
            Event::Steer => {
                if open && matches!(out.last(), Some(Event::Call { .. })) {
                    out.push(e);
                }
            }
            Event::Compact | Event::Edit => out.push(e),
        }
    }
    if open {
        out.push(Event::Say { size: 100 });
    }
    Trace { world: t.world, events: out }
}

/// Candidate simplifications of a trace, simplest first: drop a run, drop an event, drop a special, round a size or a gap down
/// to a canonical value, move the world towards the default.
pub fn candidates(t: &Trace) -> Vec<Trace> {
    let mut out = Vec::new();
    let mut push = |x: Trace| {
        let x = normalize(x);
        if x != *t && !x.events.is_empty() {
            out.push(x);
        }
    };
    let runs = runs_of(t);
    for &(s, e) in runs.iter() {
        let mut x = t.clone();
        x.events.drain(s..e);
        push(x);
    }
    for k in 0..t.events.len() {
        if !matches!(t.events[k], Event::Prompt { .. }) {
            let mut x = t.clone();
            x.events.remove(k);
            push(x);
        }
        // a run an extension started becomes a prompted one
        if let Event::Drive { gap } = t.events[k] {
            let mut x = t.clone();
            x.events[k] = Event::Prompt { gap };
            push(x);
        }
    }
    // merge a run into the previous one (its prompt disappears, its events stay)
    for &(s, _) in runs.iter().skip(1) {
        if let Some(p) = (s..t.events.len()).find(|&j| t.events[j].starts_run()) {
            let mut x = t.clone();
            x.events.remove(p);
            push(x);
        }
    }
    const SIZES: [u32; 7] = [100, 1_000, 5_000, 10_000, 20_000, 30_000, 60_000];
    const GAPS: [u32; 4] = [60, 270, 330, 3600];
    for k in 0..t.events.len() {
        match &t.events[k] {
            Event::Call { tool, size } if *tool != Tool::Recall => {
                for &s in SIZES.iter().filter(|&&s| s < *size) {
                    let mut x = t.clone();
                    x.events[k] = Event::Call { tool: *tool, size: s };
                    push(x);
                }
                if *tool == Tool::Cat {
                    let mut x = t.clone();
                    x.events[k] = Event::Call { tool: Tool::Npm, size: *size };
                    push(x);
                }
            }
            Event::Say { size } => {
                for &s in SIZES.iter().filter(|&&s| s < *size) {
                    let mut x = t.clone();
                    x.events[k] = Event::Say { size: s };
                    push(x);
                }
            }
            Event::Prompt { gap } if !GAPS.contains(gap) => {
                for &g in &GAPS {
                    let mut x = t.clone();
                    x.events[k] = Event::Prompt { gap: g };
                    push(x);
                }
            }
            Event::Drive { gap } if !GAPS.contains(gap) => {
                for &g in &GAPS {
                    let mut x = t.clone();
                    x.events[k] = Event::Drive { gap: g };
                    push(x);
                }
            }
            Event::Wait { gap } if !GAPS.contains(gap) => {
                for &g in &GAPS {
                    let mut x = t.clone();
                    x.events[k] = Event::Wait { gap: g };
                    push(x);
                }
            }
            Event::Fail { abort: true } => {
                let mut x = t.clone();
                x.events[k] = Event::Fail { abort: false };
                push(x);
            }
            Event::Foreign { size } if *size > 1_000 => {
                let mut x = t.clone();
                x.events[k] = Event::Foreign { size: 1_000 };
                push(x);
            }
            _ => {}
        }
    }
    let d = World::default();
    let w = &t.world;
    let worlds = [
        World { cls: d.cls, ..w.clone() },
        World { known: d.known, ..w.clone() },
        World { ttl_true: d.ttl_true, survival: d.survival, ..w.clone() },
        World { survival: d.survival, ..w.clone() },
        World { c: d.c, ..w.clone() },
        World { sys: d.sys, ..w.clone() },
        World { window: d.window, ..w.clone() },
        World { native: d.native, ..w.clone() },
        World { interactive: d.interactive, ..w.clone() },
        World { tier: d.tier, ..w.clone() },
        World { tools: d.tools, ..w.clone() },
        World { warming: d.warming, ..w.clone() },
    ];
    for nw in worlds {
        if nw != *w {
            push(Trace { world: nw, events: t.events.clone() });
        }
    }
    out
}

/// Greedy shrinking: repeatedly take the first candidate that still fails, until none does. `fails` evaluates a batch of
/// candidates (in parallel, on the bridge) and returns, for each, whether it still fails the property.
pub fn shrink(start: Trace, max_rounds: usize, fails: &mut dyn FnMut(&[Trace]) -> Vec<bool>) -> (Trace, usize) {
    let mut cur = start;
    let mut tried = 0;
    for _ in 0..max_rounds {
        let cands = candidates(&cur);
        if cands.is_empty() {
            break;
        }
        let mut next = None;
        for chunk in cands.chunks(32) {
            let res = fails(chunk);
            tried += chunk.len();
            if let Some(k) = res.iter().position(|&b| b) {
                next = Some(chunk[k].clone());
                break;
            }
        }
        match next {
            Some(n) => cur = n,
            None => break,
        }
    }
    (cur, tried)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_sizes_match_enumeration() {
        for f in standard_suite().into_iter().chain(quick_suite()) {
            assert_eq!(f.enumerate().len(), f.size(), "{f:?}");
        }
        let traces = quick_suite()[0].enumerate();
        assert!(traces.iter().all(|t| normalize(t.clone()) == *t), "enumerated traces are normal");
    }

    #[test]
    fn text_syntax_round_trips() {
        let mut rng = Rng::new(7);
        for _ in 0..200 {
            let t = random_trace(&mut rng);
            let back = Trace::parse(&t.to_string()).unwrap();
            assert_eq!(back.events.len(), t.events.len());
            assert_eq!(back.world, t.world);
            assert_eq!(normalize(t.clone()), t, "random traces are normal");
        }
    }

    #[test]
    fn shrinking_finds_the_minimal_trace() {
        // a synthetic property: fails iff some run has a long prose answer and a later prompt comes back after >= 1 h
        let bad = |t: &Trace| {
            let p = t.events.iter().position(|e| matches!(e, Event::Say { size } if *size >= 30_000));
            p.is_some_and(|p| t.events[p..].iter().any(|e| matches!(e, Event::Prompt { gap } if *gap >= 3600)))
        };
        let mut rng = Rng::new(3);
        let mut start = None;
        for _ in 0..200_000 {
            let t = random_trace(&mut rng);
            if bad(&t) && t.events.len() > 12 {
                start = Some(t);
                break;
            }
        }
        let start = start.expect("a failing random trace");
        let (small, _) = shrink(start, 200, &mut |cs: &[Trace]| cs.iter().map(bad).collect());
        let txt = small.to_string();
        assert!(bad(&small));
        assert_eq!(small.events.len(), 4, "{txt}");
        assert_eq!(small.world, World::default(), "{txt}");
        assert!(txt.contains("say 30K") && txt.contains("prompt +1h"), "{txt}");
    }
}
