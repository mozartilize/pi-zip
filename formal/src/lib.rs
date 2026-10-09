//! pz-formal: a small specification language and a bounded model checker for pi-zip, with conformance against the real
//! implementation (TypeScript, driven through bridge/bridge.ts).
//!
//! * `logic`: the bounded temporal logic (always, next, within k, until, implication, frozen variables, cost terms)
//! * `model`: the abstract state machine (world, events, blocks, cache, clock) and the observed runs
//! * `spec`:  the three axioms and the properties derived from them
//! * `law`:   the economic law, ported line for line, and its lemmas
//! * `gen`:   exhaustive and random traces, shrinking
//! * `bridge`, `check`: the system under test and the checker
pub mod bridge;
pub mod check;
pub mod gen;
pub mod law;
pub mod logic;
pub mod model;
pub mod spec;
