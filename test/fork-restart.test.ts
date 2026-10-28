// Fork-only restart/ledger cases. Upstream cases stay in test/restart.test.ts.
// A restart plans like the live process: growth g and "the newest response carried an edit"
// are rebuilt from the session (RD, B2B). Each test builds a live process from real responses and a fresh
// one from the branch those responses left, and compares what they know.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { G0 } from "../src/plan.ts";
import { replayGrowth } from "../src/state.ts";
import { ZipFork as Zip } from "../src/run-fork.ts";
import { COMMIT_CUSTOM, PRODUCT } from "../src/util.ts";
import { fakeCtx, fakePi, type Any } from "./helpers.ts";

const saved: Record<string, string | undefined> = {};
// the live process learns into the cache-survival file: a private one, so the other test files' models stay unknown to it
beforeEach(() => {
	saved.ttl = process.env.PI_ZIP_TTL_SECS;
	saved.stats = process.env.PI_ZIP_CACHE_STATS;
	process.env.PI_ZIP_TTL_SECS = "300";
	process.env.PI_ZIP_CACHE_STATS = join(mkdtempSync(join(tmpdir(), "pi-zip-restart-")), "cache-survival.json");
});
afterEach(() => {
	for (const [k, v] of [["PI_ZIP_TTL_SECS", saved.ttl], ["PI_ZIP_CACHE_STATS", saved.stats]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const MODEL = { provider: "rst", id: "m", contextWindow: 1_000_000, promptCache: { short: 300 } };
const T0 = Date.UTC(2030, 0, 1);
const resp = (total: number, ts: number, over: Any = {}): Any => ({ role: "assistant", content: [{ type: "text", text: "x" }], provider: "rst", model: "m", stopReason: "stop", timestamp: ts, usage: { input: 10, cacheRead: total - 10, cacheWrite: 0 }, ...over });
const entry = (id: string, message: Any): Any => ({ type: "message", id, message, timestamp: new Date(message.timestamp).toISOString() });
const user = (ts: number): Any => ({ role: "user", content: "next", timestamp: ts });
const commit = (carried: boolean): Any => ({ type: "custom", id: `k${Math.random()}`, customType: COMMIT_CUSTOM, data: { carried } });
const fold = (target: string): Any => ({ type: "context_edit", id: `e${target}`, targetId: target, replacement: { content: [{ type: "text", text: "[folded by pi-zip" }] } });
const summary = (over: Any = {}): Any => ({ type: "compaction", id: "cmp", summary: "S", firstKeptEntryId: "x", details: { by: PRODUCT, trigger: "cold" }, timestamp: new Date(T0).toISOString(), ...over });

/** A process that lived through `msgs` (a request goes out, then its response ends), and a fresh one that starts on the branch. */
function live(msgs: Any[]) {
	const { pi } = fakePi();
	const z = new Zip(pi) as Any;
	for (const m of msgs) {
		if (m.role !== "assistant") continue;
		z.model = MODEL;
		(z as Any).requestStart(undefined);
		z.providerRequest({ payload: {} });
		z.messageEnd(m);
	}
	return z;
}
function fresh(branch: Any[]) {
	const { pi } = fakePi();
	const z = new Zip(pi) as Any;
	z.sessionStart(fakeCtx([], { branch, model: MODEL }).ctx);
	return z;
}

// The judge's errors (a refused call, a reply that does not parse) and the law's refusals are only visible in the ledger, so it is
// on by default now: one file per session, named after the session, next to the learned cache data.
describe("the ledger is on by default, one file per session", () => {
	const saved = process.env.PI_ZIP_LEDGER;
	const ctxOf = (sid: string) => fakeCtx([], { branch: [], model: MODEL, sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }), getSessionId: () => sid } }).ctx;
	const rows = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const logDir = () => join(dirname(process.env.PI_ZIP_CACHE_STATS!), "logs");
	beforeEach(() => { delete process.env.PI_ZIP_LEDGER; });
	afterEach(() => { if (saved === undefined) delete process.env.PI_ZIP_LEDGER; else process.env.PI_ZIP_LEDGER = saved; });

	test("no PI_ZIP_LEDGER: each session writes its own file under the stats directory", () => {
		const { pi } = fakePi();
		const z = new Zip(pi) as Any;
		z.sessionStart(ctxOf("sess-a"));
		const a = rows(join(logDir(), "sess-a.log"));
		expect(a[0].type).toBe("session_start");
		z.sessionStart(ctxOf("sess-b"));
		expect(rows(join(logDir(), "sess-b.log"))[0].type).toBe("session_start");
		expect(rows(join(logDir(), "sess-a.log")).length).toBe(a.length); // the second session did not write into the first one
	});

	test("PI_ZIP_LEDGER=off keeps nothing, and a named file is written exactly where it says", () => {
		const { pi } = fakePi();
		const z = new Zip(pi) as Any;
		process.env.PI_ZIP_LEDGER = "off";
		z.sessionStart(ctxOf("sess-c"));
		expect(existsSync(join(logDir(), "sess-c.log"))).toBe(false);
		const own = join(logDir(), "named.jsonl");
		process.env.PI_ZIP_LEDGER = own;
		z.sessionStart(ctxOf("sess-c"));
		expect(rows(own)[0].type).toBe("session_start");
		expect(existsSync(join(logDir(), "sess-c.log"))).toBe(false);
	});
});
