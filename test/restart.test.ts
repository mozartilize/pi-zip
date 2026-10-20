// A restart plans like the live process: growth g and "the newest response carried an edit"
// are rebuilt from the session (RD, B2B). Each test builds a live process from real responses and a fresh
// one from the branch those responses left, and compares what they know.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { G0 } from "../src/plan.ts";
import { replayGrowth } from "../src/state.ts";
import { Zip } from "../src/run.ts";
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

describe("growth g is rebuilt from the branch", () => {
	const totals = [20_000, 23_000, 30_000, 31_000, 55_000, 56_500, 57_000];
	const msgs = totals.map((t, i) => resp(t, T0 + i * 10_000));
	const branch = msgs.flatMap((m, i) => [entry(`u${i}`, user(m.timestamp - 1)), entry(`a${i}`, m)]);

	test("a fresh process knows the growth the live one measured, not G0", () => {
		const l = live(msgs), f = fresh(branch);
		expect(l.g).not.toBe(G0);
		expect(f.g).toBeCloseTo(l.g, 9);
		expect(f.deltas).toEqual(l.deltas);
	});
	test("a response that first carried one of our edits adds no delta (the prompt shrank or was rewritten), as live", () => {
		// the third response carried a run plan (commit marker after it), the sixth a valve plan (marker before it)
		const b = [...branch.slice(0, 6), commit(true), ...branch.slice(6, 10), commit(false), ...branch.slice(10)];
		const l = live(msgs);
		l.deltas = []; l.g = G0; // replay by hand which responses were edited, with the live learner
		const { pi } = fakePi();
		const z = new Zip(pi) as Any;
		msgs.forEach((m, i) => {
			z.model = MODEL;
			if (i === 2 || i === 5) z.nextEdit = 0; // the request that first carried an edit
			z.providerRequest({ payload: {} });
			z.messageEnd(m);
		});
		const f = fresh(b);
		expect(f.g).toBeCloseTo(z.g, 9);
		expect(f.g).not.toBeCloseTo(l.g, 3); // and it is not the unmarked answer
	});
	test("pure: errors, aborts and other models' responses are skipped like live", () => {
		const other = resp(90_000, T0 + 5, { model: "o" });
		const err = resp(0, T0 + 6, { stopReason: "error", usage: undefined });
		const b = [entry("a", resp(10_000, T0)), entry("o", other), entry("e", err), entry("b", resp(14_000, T0 + 20)), entry("c", resp(16_000, T0 + 30))];
		// 10K -> (other model: no delta, previous key resets) -> 14K (other key before: no delta) -> 16K (+2K)
		const r = replayGrowth(b, G0);
		expect(r.deltas).toEqual([2_000]);
		expect(r.g).toBeCloseTo(0.9 * G0 + 0.1 * 2_000, 9);
	});
});

describe("justEdited: the newest response was the first to carry an edit of ours", () => {
	const a1 = entry("a1", resp(30_000, T0)), a2 = entry("a2", resp(31_000, T0 + 5_000));
	test("a run plan is persisted after the response that carried it", () => {
		expect(fresh([entry("u", user(T0 - 1)), a1, fold("r1"), commit(true)]).justEdited).toBe(true);
	});
	test("a valve plan is persisted after the response, but the next request is the first to carry it", () => {
		expect(fresh([entry("u", user(T0 - 1)), a1, fold("r1"), commit(false)]).justEdited).toBe(false);
		expect(fresh([entry("u", user(T0 - 1)), a1, fold("r1"), commit(false), a2]).justEdited).toBe(true);
	});
	test("an older edit and a later response: not edited; an edit of another extension (no commit entry): not ours", () => {
		expect(fresh([a1, fold("r1"), commit(true), a2]).justEdited).toBe(false);
		expect(fresh([entry("u", user(T0 - 1)), a1, { type: "context_edit", id: "x", targetId: "r1", replacement: { content: [{ type: "text", text: "pruned" }] } }]).justEdited).toBe(false);
	});
	test("a summary that went in through Pi's compaction before the run is first carried by that run's request", () => {
		const native = summary({ details: { by: PRODUCT, trigger: "cold", via: "native" } });
		expect(fresh([a1, native, entry("u", user(T0 + 9_000))]).justEdited).toBe(false); // nothing answered yet
		expect(fresh([a1, native, entry("u", user(T0 + 9_000)), entry("a2", resp(8_000, T0 + 9_500))]).justEdited).toBe(true);
	});
	test("live and fresh agree on a valve edit before a restart (B2B: no warm rewrite right after one)", () => {
		const { pi } = fakePi();
		const z = new Zip(pi) as Any;
		z.model = MODEL;
		z.nextEdit = 0; // the valve's edit is carried by this request
		z.providerRequest({ payload: {} });
		z.messageEnd(a1.message);
		expect(z.justEdited).toBe(true);
		expect(fresh([entry("u", user(T0 - 1)), entry("v", resp(20_000, T0 - 10_000)), fold("r0"), commit(false), a1]).justEdited).toBe(true);
	});
});

describe("a refused request does not move the cache clock (GC)", () => {
	test("the live clock goes back to the last request that was read, as a restarted process reads it from the branch", () => {
		const { pi } = fakePi();
		const z = new Zip(pi) as Any;
		z.model = MODEL;
		z.providerRequest({ payload: {} });
		z.messageEnd(resp(30_000, T0));
		const real = z.lastReqMs;
		expect(real).toBeGreaterThan(0);
		z.lastReqMs = real - 400_000; // pretend the answered request was a while ago
		const before = z.lastReqMs;
		z.providerRequest({ payload: {} });
		expect(z.lastReqMs).toBeGreaterThan(before); // the request went out
		z.messageEnd(resp(0, T0 + 1, { stopReason: "error", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }));
		expect(z.lastReqMs).toBe(before); // the provider refused it: no cache was touched (old code: now)
		// an error that reports usage was read
		z.providerRequest({ payload: {} });
		z.messageEnd(resp(30_000, T0 + 2, { stopReason: "error" }));
		expect(z.lastReqMs).toBeGreaterThan(before);
	});
});

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
