//! A pool of bun processes running bridge/bridge.ts against one pi-zip src dir. Each process takes one trace per line and answers
//! one observation per line; traces are spread over the processes and the answers returned in order.
use crate::model::{Obs, Trace};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct Pool {
    src: PathBuf,
    script: PathBuf,
    pi: Option<PathBuf>,
    /// planner options merged into every planContext call (PZF_PLAN_OPTS), e.g. {"inturnAge":20}
    pub plan_opts: Option<String>,
    workers: Vec<Mutex<Option<Worker>>>,
    next_id: AtomicU64,
    pub label: String,
}

/// The bridge script shipped with this crate.
pub fn default_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("bridge/bridge.ts")
}

impl Pool {
    pub fn new(src: &Path, workers: usize, pi: Option<PathBuf>) -> Result<Pool, String> {
        let src = src.canonicalize().map_err(|e| format!("{}: {e}", src.display()))?;
        if !src.join("plan.ts").exists() || !src.join("run.ts").exists() {
            return Err(format!("{} is not a pi-zip src dir (no plan.ts / run.ts)", src.display()));
        }
        let label = version_of(&src);
        let pool = Pool { src, script: default_script(), pi, plan_opts: None, workers: (0..workers.max(1)).map(|_| Mutex::new(None)).collect(), next_id: AtomicU64::new(1), label };
        Ok(pool)
    }

    fn spawn(&self, k: usize) -> Result<Worker, String> {
        // one directory per worker of every pool (several pools may live in one process: the tests run in parallel)
        static POOLS: AtomicU64 = AtomicU64::new(0);
        let work = std::env::temp_dir().join(format!("pz-formal-{}-{}-{k}", std::process::id(), POOLS.fetch_add(1, Ordering::Relaxed)));
        let mut cmd = Command::new("bun");
        cmd.arg(&self.script).arg(&self.src);
        if let Some(pi) = &self.pi {
            cmd.arg("--pi").arg(pi);
        }
        // isolation: the extension writes nothing outside the worker's own directory
        cmd.env("PZF_WORK", &work).env("HOME", &work);
        match &self.plan_opts {
            Some(o) => cmd.env("PZF_PLAN_OPTS", o),
            None => cmd.env_remove("PZF_PLAN_OPTS"),
        };
        for v in ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_FOLD_MIN", "PI_ZIP_KEEP_LINES", "PI_ZIP_MIN_GAIN", "PI_ZIP_INTURN_AGE", "PI_ZIP_OFF", "PI_CACHE_RETENTION", "PI_ZIP_LEDGER"] {
            cmd.env_remove(v);
        }
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().map_err(|e| format!("cannot start bun: {e}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Worker { child, stdin, stdout })
    }

    fn call(&self, k: usize, line: &str) -> Result<String, String> {
        let mut slot = self.workers[k].lock().unwrap();
        for attempt in 0..2 {
            if slot.is_none() {
                *slot = Some(self.spawn(k)?);
            }
            let w = slot.as_mut().unwrap();
            let res = (|| -> Result<String, String> {
                w.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
                w.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
                w.stdin.flush().map_err(|e| e.to_string())?;
                let mut out = String::new();
                let n = w.stdout.read_line(&mut out).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("bridge exited".into());
                }
                Ok(out)
            })();
            match res {
                Ok(o) => return Ok(o),
                Err(e) => {
                    if let Some(mut w) = slot.take() {
                        let _ = w.child.kill();
                        let _ = w.child.wait();
                    }
                    if attempt == 1 {
                        return Err(e);
                    }
                }
            }
        }
        Err("unreachable".into())
    }

    /// Run raw JSON lines through the pool, answers in order.
    pub fn raw(&self, lines: &[String]) -> Vec<Result<serde_json::Value, String>> {
        let n = self.workers.len();
        let next = AtomicU64::new(0);
        let results: Vec<Mutex<Option<Result<serde_json::Value, String>>>> = lines.iter().map(|_| Mutex::new(None)).collect();
        std::thread::scope(|s| {
            for k in 0..n {
                let (next, results) = (&next, &results);
                s.spawn(move || loop {
                    let j = next.fetch_add(1, Ordering::SeqCst) as usize;
                    if j >= lines.len() {
                        break;
                    }
                    let r = self.call(k, &lines[j]).and_then(|o| serde_json::from_str(&o).map_err(|e| format!("bad bridge output: {e}")));
                    *results[j].lock().unwrap() = Some(r);
                });
            }
        });
        results.into_iter().map(|m| m.into_inner().unwrap().unwrap_or(Err("not run".into()))).collect()
    }

    /// Run traces, observations in order (a failed run is an Obs with ok = false and the error).
    pub fn run(&self, traces: &[Trace]) -> Vec<Obs> {
        let lines: Vec<String> = traces.iter().map(|t| t.to_json(self.next_id.fetch_add(1, Ordering::SeqCst))).collect();
        self.raw(&lines)
            .into_iter()
            .map(|r| match r {
                Ok(v) => serde_json::from_value::<Obs>(v).unwrap_or_else(|e| Obs { ok: false, errors: vec![format!("cannot read observation: {e}")], ..Default::default() }),
                Err(e) => Obs { ok: false, errors: vec![e], ..Default::default() },
            })
            .collect()
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        for w in &self.workers {
            if let Some(mut w) = w.lock().unwrap().take() {
                drop(w.stdin);
                let _ = w.child.wait();
            }
        }
    }
}

/// "pi-zip 0.2.8 (/tmp/pz-replay/src)", from the package.json next to the src dir.
fn version_of(src: &Path) -> String {
    let v = std::fs::read_to_string(src.join("../package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|j| j.get("version").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| "?".into());
    format!("pi-zip {v} ({})", src.display())
}
