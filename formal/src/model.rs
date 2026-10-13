//! The abstract state machine (spec part a): the world pi-zip lives in, the events that drive it, and the state the properties
//! talk about. Three layers:
//!
//! * `Trace`: what the environment does (the input of the checker): a world and a list of events.
//! * `Obs`: what the system under test did, as reported by the bridge (every request it sent, every decision it made).
//! * `Run`: the trace and the observation together with the abstract state at every request (`St`), computed here from the
//!   events by the spec's own rules (the cache, the clock, user turns, recalls, new information). The properties in `spec.rs`
//!   are evaluated over a `Run`.
use crate::logic::Timeline;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fmt;

// ================================================================================================================================
// The environment: world and events
// ================================================================================================================================

/// The provider's prompt cache class: explicit (a write premium is reported, Anthropic style) or automatic (prefix cache).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Explicit,
    Automatic,
}

/// What pi-zip has learned about cache survival before the trace starts: nothing (the declared TTL decides), or that this cache
/// outlives its declared TTL (read in full up to 600 s, GLM-like).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Survival {
    None,
    Outlives,
}

/// The cache tier Pi asks for: the short one (the model's declared `ttl`), or the 1-hour tier (`PI_CACHE_RETENTION=long`, a 1-hour
/// cache_control in every request payload).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    #[default]
    Short,
    Long,
}

/// The tools the model has: zip_recall declared (full); a `--tools read,bash` allowlist that hides it (recall through files); an
/// allowlist without read, grep, bash or zip_recall (only re-readable outputs may fold).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tools {
    #[default]
    Full,
    File,
    Reread,
}

/// The 1-hour tier's declared lifetime.
pub const LONG_TTL: u32 = 3600;
/// The short tier: the lifetime the requests ask for without `PI_CACHE_RETENTION=long` (tau0, pi-zip cache.ts SHORT_TTL_MS).
pub const SHORT_TTL: u32 = 300;

/// The world: provider, cache and session setup. `ttl` is declared, `ttl_true` is what the provider really keeps (on the long tier
/// both scale to the hour: declared 3600 s, kept 3600 x ttl_true / ttl).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub cls: Class,
    /// pi-zip already knows the class (from an earlier session); otherwise the first response reveals it.
    pub known: bool,
    pub ttl: u32,
    pub ttl_true: u32,
    pub survival: Survival,
    /// real tokens per chars/4 token
    pub c: f64,
    /// system prompt and tools, chars/4 tokens
    pub sys: u32,
    pub window: u32,
    /// Pi's ctx.compact is available (pi-zip's native summary path)
    pub native: bool,
    /// interactive (the away timer exists)
    pub interactive: bool,
    #[serde(default)]
    pub tier: Tier,
    #[serde(default)]
    pub tools: Tools,
    /// Pi's idle cache warming is on (settings cacheWarming "idle"; Pi's own CacheWarmer refreshes the cache between runs while it
    /// pays, and asks extensions first)
    #[serde(default)]
    pub warming: bool,
    /// a summary call in the background takes 2 minutes of the clock (else it answers at once): a restart, or a return, can come while
    /// one runs; waiting for one (pi-zip says so in Pi's working line) ends it at once
    #[serde(default)]
    pub slow: bool,
}
impl Default for World {
    fn default() -> Self {
        World { cls: Class::Explicit, known: true, ttl: 300, ttl_true: 300, survival: Survival::None, c: 1.0, sys: 3000, window: 200_000, native: true, interactive: true, tier: Tier::Short, tools: Tools::Full, warming: false, slow: false }
    }
}
impl World {
    pub fn room(&self) -> f64 {
        (self.window as f64 - 16_384.0 - 8_192.0).max(4_096.0)
    }
    /// The lifetime the requests ask for (tau: 300 s on the short tier, the hour on the long one). Since 0.4.0 pi-zip reads no
    /// model catalogue (`ttl`, the model's promptCache, is only the provider's declaration the kept lifetime scales from).
    pub fn ttl_decl(&self) -> f64 {
        match self.tier {
            Tier::Short => SHORT_TTL as f64,
            Tier::Long => LONG_TTL as f64,
        }
    }
    /// The lifetime the provider really keeps.
    pub fn ttl_kept(&self) -> f64 {
        match self.tier {
            Tier::Short => self.ttl_true as f64,
            Tier::Long => (LONG_TTL as f64 * self.ttl_true as f64 / self.ttl as f64).round(),
        }
    }
}

/// The tool an assistant request calls: a mutating command (`npm test`, not re-readable), a read-only one (`cat`, re-readable),
/// or `zip_recall` of the newest folded output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Npm,
    Cat,
    Recall,
}

/// Environment events. A `Prompt` starts a run (and ends the previous one); `Call` is one assistant request whose response calls a
/// tool, followed by the tool result of `size` tokens; `Say` is the assistant request that answers in prose and ends the run; `Fail`
/// is an assistant request that fails (the provider refuses it, or the user aborts it with Esc) and ends the run; `Steer` is a
/// message the user types while the agent runs (Pi delivers it before the next request; it is not a new user turn).
/// `Wait` ends the run and lets time pass without a prompt (so a `Restart` or a `Switch` can happen at the return), `Switch` changes
/// the model for the next prompt, `Restart` is a fresh pi process on the same session, `Foreign` is a compaction another extension
/// writes between runs, `Compact` is Pi's own compaction (its threshold, an overflow or /compact; between runs or mid-run), `Edit`
/// is another extension's context_edit of the oldest output the model still sees (anywhere). The away timer and Pi's cache
/// warming are not environment events: the clock fires them.
/// `Drive` starts a run the way an extension's message does (Pi 1.1.0 `sendCustomMessage(..., { triggerTurn: true })` ->
/// `_runAgentPrompt`: agent_start, the custom message appended, the first request; never before_agent_start): pi-runway's owed-drive,
/// durable-subagents' attention. It is a new user turn, as a prompt is (README rule 3's protected turns). `NextTurn` is a custom
/// message Pi stores right after a prompt (a nextTurn message, or a before_agent_start handler's message): part of the prompt's turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "e", rename_all = "lowercase")]
pub enum Event {
    Prompt { gap: u32 },
    Drive { gap: u32 },
    NextTurn,
    Call { tool: Tool, size: u32 },
    Say { size: u32 },
    Fail { abort: bool },
    Steer,
    Wait { gap: u32 },
    Switch,
    Restart,
    Foreign { size: u32 },
    Compact,
    Edit,
    BoundaryEdit,
}
impl Event {
    /// Events that start a run: a prompt, or a custom message that triggers a turn.
    pub fn starts_run(&self) -> bool {
        matches!(self, Event::Prompt { .. } | Event::Drive { .. })
    }
    /// Events that happen outside a run and belong to the run they precede.
    pub fn is_special(&self) -> bool {
        matches!(self, Event::Switch | Event::Restart | Event::Foreign { .. } | Event::Wait { .. } | Event::Compact | Event::Edit | Event::BoundaryEdit)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    pub world: World,
    pub events: Vec<Event>,
}

fn k(x: u32) -> String {
    if x >= 1000 && x.is_multiple_of(1000) {
        format!("{}K", x / 1000)
    } else if x >= 1000 {
        format!("{}.{:03}K", x / 1000, x % 1000)
    } else {
        format!("{x}")
    }
}
fn dur(s: u32) -> String {
    if s >= 3600 && s.is_multiple_of(3600) {
        format!("{}h", s / 3600)
    } else if s >= 120 && s.is_multiple_of(60) {
        format!("{}min", s / 60)
    } else {
        format!("{s}s")
    }
}

impl fmt::Display for World {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "world {} {} ttl={} true={} survival={} c={} sys={} window={}{}{}{}{}{}{}",
            match self.cls { Class::Explicit => "explicit", Class::Automatic => "automatic" },
            if self.known { "known" } else { "unknown" },
            self.ttl,
            self.ttl_true,
            match self.survival { Survival::None => "none", Survival::Outlives => "outlives" },
            self.c,
            self.sys,
            self.window,
            if self.native { " native" } else { " nonative" },
            if self.interactive { " interactive" } else { " print" },
            if self.tier == Tier::Long { " long" } else { "" },
            match self.tools { Tools::Full => "", Tools::File => " tools=file", Tools::Reread => " tools=reread" },
            if self.warming { " warming" } else { "" },
            if self.slow { " slow" } else { "" }
        )
    }
}
impl fmt::Display for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Event::Prompt { gap } => write!(f, "prompt +{}", dur(*gap)),
            Event::Drive { gap } => write!(f, "drive +{}", dur(*gap)),
            Event::NextTurn => write!(f, "nextturn"),
            Event::Call { tool, size } => match tool {
                Tool::Recall => write!(f, "call recall {}", k(*size)),
                Tool::Npm => write!(f, "call npm {}", k(*size)),
                Tool::Cat => write!(f, "call cat {}", k(*size)),
            },
            Event::Say { size } => write!(f, "say {}", k(*size)),
            Event::Fail { abort } => write!(f, "fail {}", if *abort { "abort" } else { "error" }),
            Event::Steer => write!(f, "steer"),
            Event::Wait { gap } => write!(f, "wait +{}", dur(*gap)),
            Event::Switch => write!(f, "switch"),
            Event::Restart => write!(f, "restart"),
            Event::Foreign { size } => write!(f, "foreign {}", k(*size)),
            Event::Compact => write!(f, "compact"),
            Event::Edit => write!(f, "edit"),
            Event::BoundaryEdit => write!(f, "boundaryedit"),
        }
    }
}
/// The trace in the text syntax `Trace::parse` reads: one line for the world, one per event.
impl fmt::Display for Trace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{}", self.world)?;
        for e in &self.events {
            writeln!(f, "{e}")?;
        }
        Ok(())
    }
}

fn num(s: &str) -> Result<u32, String> {
    let s = s.trim();
    let (n, mul) = if let Some(x) = s.strip_suffix('K') {
        (x, 1000.0)
    } else if let Some(x) = s.strip_suffix("min") {
        (x, 60.0)
    } else if let Some(x) = s.strip_suffix('h') {
        (x, 3600.0)
    } else if let Some(x) = s.strip_suffix('s') {
        (x, 1.0)
    } else {
        (s, 1.0)
    };
    n.parse::<f64>().map(|v| (v * mul).round() as u32).map_err(|e| format!("bad number {s:?}: {e}"))
}

impl Trace {
    /// Parse the text syntax (see `Display`). Blank lines and `#` comments are ignored; `world` may be omitted (default world).
    pub fn parse(text: &str) -> Result<Trace, String> {
        let mut world = World::default();
        let mut events = Vec::new();
        for raw in text.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let w: Vec<&str> = line.split_whitespace().collect();
            match w[0] {
                "world" => {
                    for t in &w[1..] {
                        match *t {
                            "explicit" => world.cls = Class::Explicit,
                            "automatic" => world.cls = Class::Automatic,
                            "known" => world.known = true,
                            "unknown" => world.known = false,
                            "native" => world.native = true,
                            "nonative" => world.native = false,
                            "interactive" => world.interactive = true,
                            "print" => world.interactive = false,
                            "long" => world.tier = Tier::Long,
                            "short" => world.tier = Tier::Short,
                            "warming" => world.warming = true,
                            "slow" => world.slow = true,
                            _ => {
                                let (key, val) = t.split_once('=').ok_or(format!("bad world token {t:?}"))?;
                                match key {
                                    "ttl" => world.ttl = num(val)?,
                                    "true" => world.ttl_true = num(val)?,
                                    "survival" => world.survival = if val == "outlives" { Survival::Outlives } else { Survival::None },
                                    "c" => world.c = val.parse().map_err(|e| format!("{e}"))?,
                                    "sys" => world.sys = num(val)?,
                                    "window" => world.window = num(val)?,
                                    "tools" => {
                                        world.tools = match val {
                                            "full" => Tools::Full,
                                            "file" => Tools::File,
                                            "reread" => Tools::Reread,
                                            _ => return Err(format!("bad tools {val:?}")),
                                        }
                                    }
                                    _ => return Err(format!("unknown world key {key:?}")),
                                }
                            }
                        }
                    }
                }
                "prompt" => events.push(Event::Prompt { gap: w.get(1).map(|g| num(g.trim_start_matches('+'))).transpose()?.unwrap_or(0) }),
                "drive" => events.push(Event::Drive { gap: w.get(1).map(|g| num(g.trim_start_matches('+'))).transpose()?.unwrap_or(0) }),
                "nextturn" => events.push(Event::NextTurn),
                "call" => {
                    let tool = match w.get(1).copied() {
                        Some("npm") => Tool::Npm,
                        Some("cat") => Tool::Cat,
                        Some("recall") => Tool::Recall,
                        x => return Err(format!("bad tool {x:?}")),
                    };
                    let size = w.get(2).map(|s| num(s)).transpose()?.unwrap_or(1000);
                    events.push(Event::Call { tool, size });
                }
                "say" => events.push(Event::Say { size: w.get(1).map(|s| num(s)).transpose()?.unwrap_or(100) }),
                "fail" => events.push(Event::Fail { abort: w.get(1) == Some(&"abort") }),
                "steer" => events.push(Event::Steer),
                "wait" => events.push(Event::Wait { gap: w.get(1).map(|g| num(g.trim_start_matches('+'))).transpose()?.unwrap_or(0) }),
                "compact" => events.push(Event::Compact),
                "edit" => events.push(Event::Edit),
                "boundaryedit" => events.push(Event::BoundaryEdit),
                "switch" => events.push(Event::Switch),
                "restart" => events.push(Event::Restart),
                "foreign" => events.push(Event::Foreign { size: w.get(1).map(|s| num(s)).transpose()?.unwrap_or(2000) }),
                x => return Err(format!("unknown event {x:?}")),
            }
        }
        Ok(Trace { world, events })
    }

    /// The bridge's input line.
    pub fn to_json(&self, id: u64) -> String {
        serde_json::json!({ "id": id, "world": self.world, "events": self.events }).to_string()
    }

    /// Size used to pick the smallest of several counterexamples.
    pub fn weight(&self) -> u64 {
        self.events.len() as u64 * 1_000_000
            + self
                .events
                .iter()
                .map(|e| match e {
                    Event::Call { size, .. } | Event::Say { size } | Event::Foreign { size } => *size as u64 / 100,
                    Event::Prompt { gap } | Event::Drive { gap } | Event::Wait { gap } => *gap as u64 / 60,
                    _ => 10,
                })
                .sum::<u64>()
    }
}

// ================================================================================================================================
// What the system under test did (the bridge's report)
// ================================================================================================================================

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BlockObs {
    pub id: String,
    pub ev: i64,
    /// system | user | assistant | toolResult | foreignSummary
    pub kind: String,
    /// real tokens on the provider's scale
    pub tok: f64,
    pub turn: u32,
    pub tool: Option<String>,
    /// the request that produced it (assistant, toolResult) or the first request that carries it (user, foreignSummary)
    pub req: i64,
    pub recall_of: Option<String>,
    /// a user message typed while the agent ran (steering, follow-up): part of the current turn
    pub steer: bool,
    /// a custom message that started a run (`Drive`): a new user turn; a custom message riding with a prompt (`NextTurn`) is not
    pub starts: bool,
}

/// One message of a request as sent: its hash, real tokens, and what it is.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Msg {
    pub h: String,
    pub tok: f64,
    pub role: String,
    pub id: Option<String>,
    /// a pi-zip placeholder (folded output)
    pub ph: bool,
    /// a summary: "zip" or "foreign"
    pub sum: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State0 {
    pub cold: bool,
    pub p_warm: Option<f64>,
    pub pause: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct RunPlanObs {
    pub source: String,
    pub folds: Vec<String>,
    pub cut: Option<String>,
    pub native: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Prices {
    pub r: f64,
    pub w: f64,
    pub out: f64,
    pub cls: String,
    /// "class" (learned from usage) or "default" (before the first response of a model: the explicit ratios)
    pub src: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct LawStep {
    pub keep: Option<f64>,
    pub rent: Option<f64>,
    pub at: String,
    pub ok: bool,
    #[serde(rename = "B")]
    pub b: f64,
    #[serde(rename = "A")]
    pub a: f64,
    #[serde(rename = "T")]
    pub t: Option<f64>,
    #[serde(rename = "K")]
    pub k: Option<f64>,
    pub phi: Option<f64>,
    pub eta: Option<f64>,
    /// a whole-plan step only: the plan it judges has a cut (the source reports it; older sources do not)
    pub cut: Option<bool>,
    /// the step judges a cut whose summary is produced and ready: its call is spent, priced 0 (theory 1.4; 0.4.0 step 4)
    pub ready: Option<bool>,
    /// a summary step only: its cut (the first kept entry)
    pub key: Option<String>,
}

/// One plan the planner would make at this decision point, at one P(warm) (everything else held fixed).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridPt {
    pub planned_plan: Option<bool>,
    pub planned_folds: Vec<String>,
    pub planned_cut: Option<String>,
    pub planned_after: Option<f64>,
    pub p: f64,
    pub actual: bool,
    pub mode: String,
    pub plan: bool,
    /// a warm plan at an actual cold return whose warm twin would have been skipped by the b2b rule (no plan)
    pub b2b: bool,
    pub folds: Vec<String>,
    pub cut: Option<String>,
    /// real tokens the cut summarises, and the planned summary
    pub prefix: f64,
    pub sum: f64,
    pub before: Option<f64>,
    pub after_folds: Option<f64>,
    pub after: Option<f64>,
    pub law: Vec<LawStep>,
    pub error: Option<String>,
}
impl GridPt {
    pub fn edits(&self) -> bool {
        self.plan && (!self.folds.is_empty() || self.cut.is_some())
    }
}

/// A native, run, production or turn_end decision and its P-grid probe.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Grid {
    pub room: bool,
    /// "native" | "run" | "produce" | "turn_end"
    pub at: String,
    pub mode: String,
    pub p: f64,
    pub pause: bool,
    pub g: Option<f64>,
    pub pr: Option<Prices>,
    pub grid: Vec<GridPt>,
}
impl Grid {
    pub fn actual(&self) -> Option<&GridPt> {
        self.grid.iter().find(|g| g.actual)
    }
    pub fn at_p(&self, p: f64) -> Option<&GridPt> {
        self.grid.iter().find(|g| (g.p - p).abs() < 1e-9)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZipState {
    pub g: Option<f64>,
    pub just_edited: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Fresh {
    pub same: bool,
    pub live: usize,
    pub fresh: usize,
    pub live_mods: usize,
    pub fresh_mods: usize,
    pub fresh_plan: Vec<Value>,
    /// in-memory state groups whose transplant into the fresh process makes it plan like the live one (g, justEdited, ...)
    pub fixed_by: Vec<String>,
    /// growth and edit state transplanted together make the fresh process plan alike
    pub fixed_by_known: bool,
    pub fixed_by_all: bool,
}

/// Session facts sampled before a typed idle prompt, independently of the native planner's opts and ledger.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeDoor {
    pub keep: Option<f64>,
    pub rent: f64,
    pub open: bool,
    pub p: f64,
    pub g: f64,
    pub known: bool,
    pub b2b: bool,
    pub before: f64,
    pub after_folds: f64,
    pub target: f64,
    pub floor: f64,
    pub cuts: Vec<NativeCut>,
    pub applied: Option<NativeApplied>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct NativeCut {
    pub key: String,
    pub prefix: f64,
    pub summary: f64,
    /// The finished artifact's size when ready (pi-zip/summary `cut.summaryTokens`); the planned size otherwise.
    pub finished: f64,
    pub read: f64,
    pub written: f64,
    pub ready: bool,
    pub guard: bool,
    pub hash: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeApplied {
    pub key: String,
    pub hash: String,
    pub tokens_before: f64,
    pub idle: bool,
}

/// One request the system sent, and every decision made around it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tick {
    pub exact_issues: Vec<String>,
    pub native_door: Option<NativeDoor>,
    pub req: usize,
    pub ev: i64,
    pub run: i64,
    /// index of the request inside its run (0 = the run's first request)
    pub n: usize,
    pub t0: f64,
    pub t1: f64,
    pub gap: Option<f64>,
    pub model: String,
    /// the narrative model calls since the previous request's turn_end, in real tokens (the summary a new edit of this request uses
    /// is the last one)
    pub narr: Vec<NarrCall>,
    /// the response failed: "error" (the provider refused the request; its cache was not touched) or "aborted" (Esc)
    pub failed: Option<String>,
    /// the bridge's provider found the cache alive
    pub warm: bool,
    pub total: f64,
    pub read: f64,
    pub out: f64,
    pub raw_tok: f64,
    pub view: Vec<Msg>,
    /// pi-zip modifications this request carries for the first time ("f:<entry>" fold, "s:<hash>" summary)
    pub zip_new: Vec<String>,
    /// environment events since the previous request (switch, restart, foreign, recall, away-summary)
    pub env: Vec<String>,
    pub state0: Option<State0>,
    pub run_plan: Option<RunPlanObs>,
    pub run_ledger: Vec<Value>,
    pub te_ledger: Vec<Value>,
    pub drafts: Vec<Value>,
    pub persist_ok: Option<bool>,
    /// the turn_end after this request persisted a new (valve) plan, not the run plan already sent
    pub te_valve: bool,
    /// that turn_end persisted the run plan already sent together with a summary its room wait wrote (run.ts runRoom): the valve
    /// decision is the room plan's cut; the folds are the run plan's
    pub run_room: bool,
    /// narrative (summary) model calls the user waited for: in the run hook, at the turn_end after this request
    pub wait_run: u32,
    pub wait_te: u32,
    pub grids: Vec<Grid>,
    pub zip: ZipState,
    pub fresh: Option<Fresh>,
    /// what A1 finds wrong with this request as sent (checked at run starts and whenever pi-zip carries something new)
    pub lossless: Vec<String>,
}

/// One narrative model call (the summary's model-written part): what it read uncached and what it wrote, real tokens.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct NarrCall {
    pub input: f64,
    pub output: f64,
    pub away: bool,
}

/// A cache refresh by Pi's idle cache warming (a tiny request that re-sends the newest prefix).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Refresh {
    pub model: String,
    pub t: f64,
    pub alive: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ProducerObs {
    pub calls: u32,
    pub timers: u32,
    pub writes: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Obs {
    pub producer: ProducerObs,
    pub ok: bool,
    pub errors: Vec<String>,
    pub blocks: Vec<BlockObs>,
    pub ticks: Vec<Tick>,
    pub refreshes: Vec<Refresh>,
}

// ================================================================================================================================
// The abstract state at every request
// ================================================================================================================================

/// Recoverability of a session block (what the model can get back if it is folded).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recover {
    Rereadable,
    NonRereadable,
    RecallResult,
    NotAnOutput,
}

/// A session block: kind, size, user turn, recoverability, and the request that issued it (tool results: their call's request).
#[derive(Clone, Debug)]
pub struct Block {
    pub id: String,
    pub kind: String,
    pub tok: f64,
    pub turn: u32,
    pub recover: Recover,
    pub req: i64,
    pub recall_of: Option<String>,
    pub steer: bool,
    /// a custom message that started a run (a new user turn)
    pub starts: bool,
}
impl Block {
    /// The block that starts a user turn: a prompt (not steering), or a custom message that started a run.
    pub fn starts_turn(&self) -> bool {
        (self.kind == "user" && !self.steer) || (self.kind == "custom" && self.starts)
    }
}

/// What a block looks like in one request: shown as is, folded to a placeholder, or summarised away (not in the request).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown {
    Visible,
    Folded,
    Summarized,
}

/// The abstract state when request i is sent.
#[derive(Clone, Debug, Default)]
pub struct St {
    /// the spec's cache: a response from this model (or a refresh of it) ended at most the kept TTL ago
    pub warm: bool,
    /// seconds since anything last touched this model's cache (a response that reached the provider, or a refresh); None: never
    pub touch_gap: Option<f64>,
    /// the model differs from the previous request's
    pub switched: bool,
    /// the first request of a run, at a cache that is gone (by the spec's clock)
    pub cold_start: bool,
    /// what pi-zip believed when it planned this request: cold (P(warm) < 0.5) and P(warm) (in a run: 1 here; the decision records
    /// its own, learned in-run P), and whether the return came after a pause (gap >= tau) or a model switch
    pub believed_cold: bool,
    pub p: f64,
    pub pause: bool,
    /// user turns so far (the run's own prompt included)
    pub user_turns: u32,
    /// blocks zip_recall returned before this request
    pub recalled: BTreeSet<String>,
    /// real tokens appended to the session since the previous request
    pub appended: f64,
    /// new information since the previous request: switch, foreign, recall, class (the first response revealed the class)
    pub new_info: Vec<String>,
    /// real tokens of this request, and the parts no summary may remove: system prompt, the leading summary, the protected turns
    pub view_tok: f64,
    pub floor: f64,
    pub prev_sum: f64,
    /// the cold target: max(cap, O + cap/2), at most Pi's compaction room (README rule 2)
    pub target: f64,
    pub room: f64,
}

pub const COLD_CAP: f64 = 40_000.0;
pub const PROTECT_USER_TURNS: u32 = 2;
pub const INTURN_AGE: i64 = 60;
pub const SUMMARY_FLOOR: f64 = 1_000.0;

/// A trace, what the system did on it, and the abstract state at every request.
pub struct Run {
    pub trace: Trace,
    pub obs: Obs,
    pub st: Vec<St>,
    pub blocks: Vec<Block>,
    pub by_id: HashMap<String, usize>,
}
impl Timeline for Run {
    fn len(&self) -> usize {
        self.obs.ticks.len()
    }
}

impl Run {
    pub fn new(trace: Trace, obs: Obs) -> Run {
        let blocks: Vec<Block> = obs
            .blocks
            .iter()
            .map(|b| Block {
                id: b.id.clone(),
                kind: b.kind.clone(),
                tok: b.tok,
                turn: b.turn,
                recover: match (b.kind.as_str(), b.tool.as_deref()) {
                    ("toolResult", Some("cat")) => Recover::Rereadable,
                    ("toolResult", Some("recall")) => Recover::RecallResult,
                    ("toolResult", _) => Recover::NonRereadable,
                    _ => Recover::NotAnOutput,
                },
                req: b.req,
                recall_of: b.recall_of.clone(),
                steer: b.steer,
                starts: b.starts,
            })
            .collect();
        let by_id = blocks.iter().enumerate().map(|(i, b)| (b.id.clone(), i)).collect();
        let mut run = Run { trace, obs, st: Vec::new(), blocks, by_id };
        run.st = run.derive();
        run
    }

    fn derive(&self) -> Vec<St> {
        let w = &self.trace.world;
        let room = w.room();
        let mut last_resp: HashMap<&str, f64> = HashMap::new();
        let mut out = Vec::with_capacity(self.obs.ticks.len());
        let kept = w.ttl_kept();
        for (i, t) in self.obs.ticks.iter().enumerate() {
            // Pi's cache warming refreshed this model's cache before the request
            for f in self.obs.refreshes.iter().filter(|f| f.t <= t.t0 + 1e-9 && (i == 0 || f.t > self.obs.ticks[i - 1].t0)) {
                let e = last_resp.entry(f.model.as_str()).or_insert(f.t);
                *e = e.max(f.t);
            }
            let touch_gap = last_resp.get(t.model.as_str()).map(|r| t.t0 - r);
            let warm = touch_gap.is_some_and(|g| g < kept - 1e-6);
            let switched = i > 0 && self.obs.ticks[i - 1].model != t.model;
            let s0 = t.state0.as_ref();
            let (believed_cold, p, pause) = if t.n == 0 { s0.map(|s| (s.cold, s.p_warm.unwrap_or(1.0), s.pause)).unwrap_or((false, 1.0, false)) } else { (false, 1.0, false) };
            let user_turns = self.blocks.iter().filter(|b| b.starts_turn() && b.req <= i as i64).count() as u32;
            let recalled = self.blocks.iter().filter(|b| b.recover == Recover::RecallResult && b.req < i as i64).filter_map(|b| b.recall_of.clone()).collect();
            let appended = self
                .blocks
                .iter()
                .filter(|b| match b.kind.as_str() {
                    "assistant" | "toolResult" => b.req == i as i64 - 1,
                    "user" | "custom" | "foreignSummary" => b.req == i as i64 && (i == 0 || b.req > self.obs.ticks[i - 1].req as i64),
                    _ => false,
                })
                .map(|b| b.tok)
                .sum();
            let mut new_info: Vec<String> = t.env.iter().filter(|e| matches!(e.as_str(), "switch" | "foreign" | "recall" | "compact" | "edit")).cloned().collect();
            if i == 1 && !w.known {
                new_info.push("class".into());
            }
            let view_tok: f64 = t.view.iter().map(|m| m.tok).sum();
            let sys: f64 = t.view.iter().filter(|m| m.role == "system").map(|m| m.tok).sum();
            let prev_sum = t.view.iter().filter(|m| m.role != "system").take(1).filter(|m| m.sum.is_some()).map(|m| m.tok).sum::<f64>();
            let protected_from = user_turns.saturating_sub(PROTECT_USER_TURNS - 1);
            let protected: f64 = t.view.iter().filter(|m| m.id.as_ref().and_then(|id| self.block(id)).is_some_and(|b| b.turn >= protected_from && b.kind != "system")).map(|m| m.tok).sum();
            let target = (COLD_CAP.max(sys + COLD_CAP / 2.0)).min(room);
            out.push(St { warm, touch_gap, switched, cold_start: t.n == 0 && !warm, believed_cold, p, pause, user_turns, recalled, appended, new_info, view_tok, floor: sys + prev_sum + protected, prev_sum, target, room });
            if t.failed.as_deref() != Some("error") {
                last_resp.insert(t.model.as_str(), t.t1);
            }
        }
        out
    }

    pub fn tick(&self, i: usize) -> &Tick {
        &self.obs.ticks[i]
    }
    pub fn block(&self, id: &str) -> Option<&Block> {
        self.by_id.get(id).map(|&i| &self.blocks[i])
    }
    /// Session order of a block (its position among all blocks ever appended).
    pub fn order(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }
    /// How a block appears in request i.
    pub fn shown(&self, i: usize, id: &str) -> Shown {
        match self.tick(i).view.iter().find(|m| m.id.as_deref() == Some(id)) {
            Some(m) if m.ph => Shown::Folded,
            Some(_) => Shown::Visible,
            None => Shown::Summarized,
        }
    }
    /// pi-zip changed request i in a way no earlier request carried (a new fold or a new summary): the cache is rewritten from there.
    pub fn zip_new(&self, i: usize) -> bool {
        !self.tick(i).zip_new.is_empty()
    }
    pub fn zip_summary_new(&self, i: usize) -> bool {
        self.tick(i).zip_new.iter().any(|m| m.starts_with("s:"))
    }
    /// Request i sends the previous request's messages unchanged, then appends (prefix stability).
    pub fn prefix_kept(&self, i: usize) -> bool {
        i == 0 || {
            let (a, b) = (&self.tick(i - 1).view, &self.tick(i).view);
            a.len() <= b.len() && a.iter().zip(b).all(|(x, y)| x.h == y.h)
        }
    }
    /// The decision that produced what request i carries new: its run plan (first request of a run) or the valve at the
    /// turn_end after request i-1.
    pub fn decision_for(&self, i: usize) -> Option<&Grid> {
        // a valve plan persisted at the previous turn_end is first carried by this request (even the first of a new run)
        if i > 0 && self.tick(i - 1).te_valve {
            let t = self.tick(i - 1);
            let waited = t.te_ledger.iter().any(|v| v["type"] == "room_wait");
            return t.grids.iter().find(|g| g.at == "turn_end" && g.room == waited).or_else(|| t.grids.iter().find(|g| g.at == "turn_end"));
        }
        let t = self.tick(i);
        if t.n == 0 {
            if t.run_plan.as_ref().is_some_and(|p| p.native) {
                if let Some(g) = t.grids.iter().find(|g| g.at == "native") { return Some(g); }
            }
            if let Some(g) = t.grids.iter().find(|g| g.at == "run") {
                return Some(g);
            }
        }
        None
    }
    /// Every decision point at request i (run plan, then the turn_end valve after it).
    pub fn grids(&self, i: usize) -> &[Grid] {
        &self.tick(i).grids
    }
    /// Ledger records of a type at request i (run hook and turn_end).
    pub fn ledger(&self, i: usize, ty: &str) -> Vec<&Value> {
        let t = self.tick(i);
        t.run_ledger.iter().chain(t.te_ledger.iter()).filter(|r| r.get("type").and_then(Value::as_str) == Some(ty)).collect()
    }
    /// Assistant requests between the request that issued block b and the decision point (true age; the planner's own age,
    /// counted over the projection, is never larger).
    pub fn age_at(&self, b: &Block, i: usize, at: &str) -> i64 {
        let asst = if at == "run" || at == "native" { i as i64 } else { i as i64 + 1 };
        asst - (b.req + 1)
    }
}
