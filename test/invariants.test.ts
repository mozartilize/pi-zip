// One group per invariant of design §6 (I1-I6), driven through the real extension with a fake Pi.
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repairPayload, validateEdits } from "../src/guard.ts";
import { record } from "../src/learn.ts";
import { buildBlocks, planContext, applyPlanToMessages, reserveTokensFor, type Block, type RunPlan } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { skeleton } from "../src/summary.ts";
import { NATIVE_MARKER, Zip } from "../src/run.ts";
import { A, AX, fakeCtx, fakePi, flat, longTurn, project, R, U, withK, type Any } from "./helpers.ts";

const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_OFF", "PI_ZIP_LEDGER", "PI_ZIP_MIN_GAIN", "PI_ZIP_INTURN_AGE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); ENV.forEach((k) => delete process.env[k]); process.env.PI_ZIP_TTL_SECS = "1"; });
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const branchOf = (entries: Any[], lastTs: number) => [
	...entries.map((e) => ({ type: "message", id: e.sourceEntry.id, message: e.sourceEntry.message })),
	{ type: "message", id: "ts", message: { role: "assistant", timestamp: lastTs, content: [] } },
];
const COLD_TS = () => Date.now() - 60_000;
const WARM_TS = () => Date.now();

async function rig(entries: Any[], lastTs: number, over: Any = {}, piExtra: Any = {}) {
	const { default: piZip } = await import("../src/index.ts");
	const f = fakePi(piExtra);
	piZip(f.pi);
	const { ctx, notes } = fakeCtx(entries, { branch: branchOf(entries, lastTs), ...over });
	return { ...f, ctx, notes, fire: async (name: string, e: Any) => f.handlers.get(name)(e, ctx) };
}
const turnEnd = (all: Any[], lastId: string, turnIndex = 0) => ({
	message: { role: "assistant", stopReason: "stop", usage: { input: 1000, cacheRead: 0, cacheWrite: 0 } },
	messageEntryId: lastId, context: { contextEntries: all }, entries: [], turnIndex,
});
const norm = (ms: Any[]) => JSON.stringify(ms.map((m) => (m.role === "compactionSummary" ? { ...m, timestamp: 0, tokensBefore: 0 } : m)));

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
// ---- deterministic random sessions --------------------------------------------------------------------------
function prng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s + 0x6d2b79f5) >>> 0), ((((s ^ (s >>> 15)) * (1 | s)) >>> 0) / 4294967296));
}
function randomSession(seed: number) {
	const r = prng(seed);
	const entries: Any[] = [];
	let id = 0;
	const turns = 3 + Math.floor(r() * 4);
	for (let t = 0; t < turns; t++) {
		entries.push(U(`u${t}`, `request ${t} seed ${seed}`));
		const rounds = 1 + Math.floor(r() * 3);
		for (let k = 0; k < rounds; k++) {
			const calls = [`c${++id}`, ...(r() < 0.3 ? [`c${++id}`] : [])];
			const m = A(`a${id}`, calls, r() < 0.5);
			(m.messages[0] as Any).content[calls.length ? 1 : 0].text = `thinking about ${id}`;
			entries.push(m);
			for (const c of calls) {
				const chars = Math.floor(r() * 15000);
				const text = Array.from({ length: 1 + Math.floor(chars / 40) }, (_, i) => `line ${i}: value=${Math.floor(r() * 1e6)} ${r() < 0.05 ? "ERROR boom" : "ok"}`).join("\n");
				entries.push(R(`r${c}`, c, 0, text));
			}
		}
		entries.push(A(`end${t}`));
	}
	return entries;
}
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

// =============================================================================================================
describe("I1 byte stability: every request of a run sends the same prefix, and it equals the turn_end projection", () => {
	const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
	const cold = [...prevRun, U("u3", "back after the idle")];
	const tail = [A("a5", ["c9"]), R("r9", "c9", 300)];

	async function runCold(entries: Any[]) {
		const r = await rig(entries, COLD_TS());
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(entries) });
		const req2 = await r.fire("context_with_system", { messages: [...flat(entries), ...flat(tail)] });
		const all = [...entries, ...tail, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6", 1));
		return { r, req1, req2, all, te, projected: flat(project(all, te.entries)) };
	}

	test("fold only: request 2 repeats request 1's prefix, and the persisted projection equals it", async () => {
		const { req1, req2, projected, te, r } = await runCold(cold);
		expect(req1.messages.find((m: Any) => m.toolCallId === "c1").content[0].text).toContain("[folded by pi-zip");
		expect(JSON.stringify(req2.messages.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
		expect(JSON.stringify(projected.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
		expect(te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId)).toEqual(["r1"]);
		expect(r.notes).toHaveLength(1);
		expect(r.notes[0]).toMatch(/^pi-zip  zipped 1 old output  [\d.]+K → [\d.]+K  [\d.]+ m?s$/);
	});

	test("after the persist the next request needs no local edit (the session projection already carries it)", async () => {
		const { r, all, projected } = await runCold(cold);
		const next = await r.fire("context_with_system", { messages: projected });
		expect(next).toBeUndefined();
		expect(all.length).toBeGreaterThan(0);
	});

	test("relax: a rereadable previous-turn output folds and PERSISTS (the guard allows the previous turn, never the latest)", async () => {
		process.env.PI_ZIP_COLD_CAP = "1000";
		const { req1, projected, te } = await runCold(cold);
		const targets = te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId).sort();
		expect(targets).toEqual(["r1", "r2"]);
		expect(JSON.stringify(projected.slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
	});

	test("summary: the local view and the persisted compaction carry the same text and the same kept part", async () => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		const big = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5"), U("u4", "back")];
		const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0.01 } } });
		const r = await rig(big, COLD_TS(), { modelRegistry: { complete } });
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(big) });
		expect(req1.messages[0].role).toBe("compactionSummary");
		const all = [...big, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6"));
		const comp = te.entries.find((e: Any) => e.type === "compaction");
		expect(comp.summary).toBe(req1.messages[0].summary);
		expect(comp.firstKeptEntryId).toBe("u3");
		expect(norm(flat(project(all, te.entries)).slice(0, req1.messages.length))).toBe(norm(req1.messages));
		expect(r.notes[0]).toMatch(/summarized 2 requests .* waited [\d.]+ s/);
	});

	test("a summary and folds in one batch: the compaction draft comes first (Pi takes its tokensBefore before any fold makes the usage stale)", async () => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		// the cut lands at u3; the previous turn's re-readable output r5 (ls) folds by relax, in the kept part
		const big = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5", ["c5"]), R("r5", "c5", 30_000), A("a5e"), U("u4", "back")];
		const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0.01 } } });
		const r = await rig(big, COLD_TS(), { modelRegistry: { complete } });
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(big) });
		expect(req1.messages[0].role).toBe("compactionSummary");
		const all = [...big, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6"));
		expect(te.entries.map((e: Any) => e.type)).toEqual(["compaction", "context_edit", "custom"]); // the edits, then the commit marker
		expect(te.entries[0].firstKeptEntryId).toBe("u3");
		expect(te.entries[1].targetId).toBe("r5");
		// the order changes nothing in what the session projects
		expect(norm(flat(project(all, te.entries)).slice(0, req1.messages.length))).toBe(norm(req1.messages));
	});
});

describe("F12 summary prepared while the user is away (timer at 0.8 x TTL)", () => {
	const done = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
	const back = [...done, U("u4", "back")];
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const mkComplete = (state: { calls: number; delay?: number; signals?: Any[] }) => async (_m: Any, _c: Any, o: Any) => {
		state.calls++;
		state.signals?.push(o?.signal);
		if (state.delay) await sleep(state.delay);
		return { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } };
	};
	const settle = (r: Any) => r.fire("agent_before_settle", { context: { contextEntries: done }, entries: [] });
	const comeBack = async (r: Any, settled: Any, ts: number) => {
		r.ctx.sessionManager.getBranch = () => [...branchOf(done, ts), ...(settled?.entries?.length ? [settled.entries.at(-1)] : [])];
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: back });
		await r.fire("before_agent_start", {});
		return r.fire("context_with_system", { messages: flat(back) });
	};
	beforeEach(() => { process.env.PI_ZIP_COLD_CAP = "6000"; process.env.PI_ZIP_TTL_SECS = "0.1"; });
	/** The away timer's own tests: a summary was already made in this warm stretch (restored from the branch at session_start), so a
	 *  warm return would not summarise again and settle starts nothing early (rule A); only the cold plan has a cut. */
	const coldOnly = async <T extends Any>(r: T): Promise<T> => {
		const sm = (r as Any).ctx.sessionManager, branch = sm.getBranch;
		sm.getBranch = () => [...branch(), { type: "compaction", id: "prior", details: { by: "pi-zip" } }];
		await (r as Any).fire("session_start", {});
		sm.getBranch = branch;
		return r;
	};
	// the summary loads Pi's serializer lazily; cold, that import alone outlasts the 120 ms these tests leave the away timer
	beforeAll(async () => { await import("@earendil-works/pi-coding-agent"); });

	test("settle only plans: no model call yet; the timer builds the summary at 0.8 x TTL; the next cold return adopts it with no second call", async () => {
		const st = { calls: 0 };
		const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }));
		const settled = await settle(r);
		expect(settled.entries.at(-1).customType).toBe("pi-zip/plan");
		expect(st.calls).toBe(0); // nothing is started at settle itself
		await sleep(200); // 0.8 x 100 ms has passed: the user is still away
		expect(st.calls).toBe(1);
		const req = await comeBack(r, settled, COLD_TS());
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1); // adopted, not rebuilt
		const te = await r.fire("turn_end", turnEnd([...back, A("a6")], "a6"));
		const base = r.ctx.sessionManager.getBranch();
		r.ctx.sessionManager.getBranch = () => [...base, ...te.entries]; // what Pi persists
		expect(r.notes.at(-1)).toMatch(/^pi-zip  summarized 2 requests  [\d.]+K → [\d.]+K  [\d.]+ m?s · ready while you were away$/);
		await r.handlers.get("cmd:zip").handler("stats", r.ctx);
		expect(r.notes.at(-1)).toContain("1 summary");
		expect(r.notes.at(-1)).toContain("$0.0200");
	});

	test("the settle entry stores entry ids only: no placeholder text, no summary text", async () => {
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } });
		const settled = await settle(r);
		const data = settled.entries.at(-1).data;
		expect(data.policy).toBe("pi-zip");
		expect(data.targets.every((t: unknown) => typeof t === "string")).toBe(true);
		expect(data).not.toHaveProperty("summary");
		expect(JSON.stringify(data)).not.toContain("[folded by pi-zip");
		expect(JSON.stringify(data).length).toBeLessThan(400);
	});

	test("the user returns before the timer: before_agent_start cancels it and no summary call is ever made", async () => {
		const st = { calls: 0 };
		const r = await coldOnly(await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } }));
		const settled = await settle(r);
		await r.fire("before_provider_request", { payload: {} }); // the cache clock: a request just went out
		await r.fire("before_agent_start", {});
		await sleep(250);
		expect(st.calls).toBe(0);
		void settled;
	});

	test("the timer is unref'd (it never keeps the process alive)", async () => {
		const realSet = globalThis.setTimeout;
		const timers: Any[] = [];
		(globalThis as Any).setTimeout = (...a: Any[]) => { const h = (realSet as Any)(...a); timers.push(h); return h; };
		try {
			const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }));
			process.env.PI_ZIP_TTL_SECS = "3600";
			await settle(r);
			await r.fire("before_agent_start", {}); // cancel before it could fire
			expect(timers.some((h) => typeof h.hasRef === "function" && h.hasRef() === false)).toBe(true);
		} finally {
			globalThis.setTimeout = realSet;
		}
	});

	test("a summary the warm return never needs (the law does not fire) is discarded and still booked as cost", async () => {
		const st = { calls: 0 };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
		const settled = await settle(r);
		await sleep(200);
		expect(st.calls).toBe(1);
		await r.fire("before_provider_request", { payload: {} }); // a fresh request: the cache is warm again
		process.env.PI_ZIP_COLD_CAP = "200000"; // ~100K tokens, now below the cap: a warm cache is never edited
		const req = await comeBack(r, settled, Date.now());
		expect(req).toBeUndefined();
		await sleep(0);
		const base = r.ctx.sessionManager.getBranch();
		r.ctx.sessionManager.getBranch = () => [...base, ...r.appended]; // the unused summary's cost is booked in the session
		await r.handlers.get("cmd:zip").handler("stats", r.ctx);
		expect(r.notes.at(-1)).toContain("$0.0200");
		expect(st.calls).toBe(1);
	});

	test("a summary still being written when the cold user returns: only the remainder is waited for, and nothing is built twice", async () => {
		const st = { calls: 0, delay: 250 };
		const working: (string | undefined)[] = [];
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) }, ui: { notify: () => {}, setWorkingMessage: (t?: string) => working.push(t) } });
		const settled = await settle(r);
		await sleep(150); // timer fired at ~80 ms; the call needs 250 ms
		expect(st.calls).toBe(1);
		const t0 = Date.now();
		const req = await comeBack(r, settled, COLD_TS());
		expect(Date.now() - t0).toBeLessThan(250); // less than a full call
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1);
		// Pi's working line while the user waits, then cleared. In Pi 1.1.0 Esc there aborts the whole prompt: the line says so
		expect(working).toEqual(["pi-zip: finishing the summary it started while you were away · Esc cancels this prompt", undefined]);
	});

	test("Esc while waiting (Pi cancels the prompt): pi-zip stops waiting at once, adds no cut, and the summary goes on for the next try", async () => {
		const st = { calls: 0, delay: 300, signals: [] as Any[] };
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } });
		const settled = await settle(r);
		await sleep(150);
		const esc = new AbortController();
		(r.ctx as Any).signal = esc.signal;
		setTimeout(() => esc.abort(), 30);
		const t0 = Date.now();
		const req = await comeBack(r, settled, COLD_TS());
		expect(Date.now() - t0).toBeLessThan(250);
		expect(req).toBeUndefined(); // the request never goes out: nothing is applied ...
		expect(r.notes).toEqual([]); // ... nor announced
		expect(await r.fire("turn_end", { ...turnEnd([...back, A("a6")], "a6"), message: { role: "assistant", stopReason: "aborted", usage: {} } })).toBeUndefined(); // ... nor persisted
		expect(st.calls).toBe(1);
		expect(st.signals[0]?.aborted).toBe(false); // the background call has its own controller: Esc did not cancel it
		// the next try uses the summary that went on being written
		await sleep(350);
		(r.ctx as Any).signal = undefined;
		const again = await comeBack(r, settled, COLD_TS());
		expect(again.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1);
	});

	test("Esc while waiting, with a fold in the kept part: that fold is not applied, announced or persisted either (the request never went out)", async () => {
		const done2 = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5", ["c5"]), R("r5", "c5", 30_000), A("a5e")];
		const back2 = [...done2, U("u4", "back")];
		const st = { calls: 0, delay: 300 };
		const r = await rig(done2, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } });
		const settled = await r.fire("agent_before_settle", { context: { contextEntries: done2 }, entries: [] });
		await sleep(150);
		const esc = new AbortController();
		(r.ctx as Any).signal = esc.signal;
		setTimeout(() => esc.abort(), 30);
		r.ctx.sessionManager.getBranch = () => [...branchOf(done2, COLD_TS()), settled.entries.at(-1)];
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: back2 });
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(back2) })).toBeUndefined(); // the relax fold of r5 stays out
		expect(r.notes).toEqual([]);
		expect(await r.fire("turn_end", { ...turnEnd([...back2, A("a6")], "a6"), message: { role: "assistant", stopReason: "aborted", usage: {} } })).toBeUndefined();
		expect(st.calls).toBe(1);
	});

	test("print/json mode (no UI): settle does nothing and starts nothing; a cold return that needs a summary computes it then", async () => {
		const st = { calls: 0 };
		const r = await rig(done, COLD_TS(), { hasUI: false, mode: "print", modelRegistry: { complete: mkComplete(st) } });
		expect(await settle(r)).toBeUndefined();
		await sleep(200);
		expect(st.calls).toBe(0); // no timer, no background work
		const req = await comeBack(r, undefined, COLD_TS());
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1); // built at the cold return, awaited
	});

	test("/zip off cancels a pending timer", async () => {
		const st = { calls: 0 };
		const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }));
		await settle(r);
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		await sleep(200);
		expect(st.calls).toBe(0);
	});

	// ---- Pi's idle cache warming (pi-tricks §3.3): observed, never answered -------------------------------------------------
	describe("Pi warms the cache between runs (cacheWarming idle)", () => {
		// a 10.2 s lifetime: Pi decides at 0.2 s (at least 10 s before expiry), pi-zip gives up waiting 1 s after a due decision, and
		// looks for the refresh of a "warm" decision 1.3 s later (10.2 / 8); the old rule would start the summary at 8.2 s
		beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "10.2"; });
		const idle = { getSettings: () => ({ cacheWarming: "idle" }) };
		const decide = (r: Any, action: string) => r.handlers.get("cache_warming_decision")({ type: "cache_warming_decision", action, warmCost: 0.01, missCost: 1, continuationProbability: 0.15 }, r.ctx);

		test("Pi decides stop: the summary is prepared at once, as without warming; the decision is never answered", async () => {
			const st = { calls: 0 };
			const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }, idle));
			await settle(r);
			await sleep(100);
			expect(st.calls).toBe(0); // waiting for Pi's decision
			expect(await decide(r, "stop")).toBeUndefined();
			await sleep(50);
			expect(st.calls).toBe(1);
		});

		// the timing on a fake clock (jest.useFakeTimers fakes setTimeout and Date): no real sleeps, so no slack to run out of on a busy CI
		describe("on a fake clock", () => {
			let ledger = "";
			const settings = () => join(process.env.PI_CODING_AGENT_DIR!, "settings.json"); // Pi's global settings (test/setup.ts)
			beforeEach(() => {
				ledger = `/tmp/pi-zip-warm-clock-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
				process.env.PI_ZIP_LEDGER = ledger;
			});
			afterEach(() => {
				jest.useRealTimers();
				delete process.env.PI_ZIP_LEDGER;
				rmSync(ledger, { force: true });
				rmSync(settings(), { force: true });
			});
			const rows = (type: string): Any[] => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === type) : []);
			const started = () => rows("away_summary_start").length;
			const unblocked = () => rows("away_unblocked").map((x) => x.reason);

			test("while Pi keeps deciding warm (and refreshing), no summary; once it falls silent, the summary is prepared", async () => {
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle));
				jest.useFakeTimers();
				await settle(r);
				const base = r.ctx.sessionManager.getBranch();
				const refreshes: Any[] = [];
				r.ctx.sessionManager.getBranch = () => [...base, ...refreshes];
				for (let i = 0; i < 6; i++) { // a decision every 0.3 s, each followed by its refresh (Pi persists a cache_warm usage entry)
					expect(await decide(r, "warm")).toBeUndefined();
					jest.advanceTimersByTime(100);
					refreshes.push({ type: "usage", kind: "cache_warm", timestamp: new Date().toISOString() });
					jest.advanceTimersByTime(200);
				}
				expect([started(), unblocked()]).toEqual([0, []]); // 1.8 s: past the warming delay and the margin, and Pi is still warming
				jest.advanceTimersByTime(900); // no decision since the last refresh (1.6 s): the next one was due at 1.8 s, the margin is 1 s
				expect(started()).toBe(0);
				jest.advanceTimersByTime(200);
				expect([started(), unblocked()]).toEqual([1, ["no warming decision"]]);
			});

			test("a warm decision with no refresh after it (another extension answered stop): the summary is prepared at the refresh check", async () => {
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle));
				jest.useFakeTimers();
				await settle(r);
				await decide(r, "warm");
				jest.advanceTimersByTime(1_250);
				expect(started()).toBe(0);
				jest.advanceTimersByTime(50); // the check, 10.2 s / 8 after the decision: no cache_warm entry since it
				expect([started(), unblocked()]).toEqual([1, ["no refresh after a warm decision"]]);
			});

			test("Pi never decides (it is not warming this request after all): the summary starts just after the decision was due, not at 0.8 x TTL", async () => {
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle));
				jest.useFakeTimers();
				await settle(r);
				jest.advanceTimersByTime(1_150);
				expect(started()).toBe(0);
				jest.advanceTimersByTime(100); // 0.2 s + the 1 s margin
				expect([started(), unblocked()]).toEqual([1, ["no warming decision"]]);
			});

			test("a refresh slower than the margin: Pi's next decision is expected a warming delay after the refresh finished, not after the decision", async () => {
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle));
				jest.useFakeTimers();
				await settle(r);
				const base = r.ctx.sessionManager.getBranch();
				const refreshes: Any[] = [];
				r.ctx.sessionManager.getBranch = () => [...base, ...refreshes];
				for (let i = 0; i < 4; i++) {
					await decide(r, "warm");
					jest.advanceTimersByTime(1_200); // the refresh takes 1.2 s, more than the 1 s margin; Pi persists it as it finishes
					refreshes.push({ type: "usage", kind: "cache_warm", timestamp: new Date().toISOString() });
					jest.advanceTimersByTime(200); // Pi decides again one warming delay (0.2 s) after the refresh finished
					expect([i, started(), unblocked()]).toEqual([i, 0, []]);
				}
				jest.advanceTimersByTime(900); // silent from now: the decision due 0.2 s after the last refresh does not come; 1 s margin
				expect([started(), unblocked()]).toEqual([0, []]);
				jest.advanceTimersByTime(200);
				expect([started(), unblocked()]).toEqual([1, ["no warming decision"]]);
			});

			test("idle warming set only in the project settings (Pi reads cacheWarming from the global ones only): no decision is waited for", async () => {
				writeFileSync(settings(), JSON.stringify({ defaultModel: "m" })); // the global settings: Pi warms during runs only
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle)); // merged: "idle"
				jest.useFakeTimers();
				await settle(r);
				jest.advanceTimersByTime(8_000); // a due decision (0.2 s) and its margin (1 s) are long past; 0.8 x 10.2 s is not yet
				expect([started(), unblocked()]).toEqual([0, []]);
				jest.advanceTimersByTime(300);
				expect([started(), unblocked()]).toEqual([1, []]); // the plain away timer
			});

			test("idle warming in the global settings: decisions are waited for", async () => {
				writeFileSync(settings(), JSON.stringify({ cacheWarming: "idle" }));
				const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, idle));
				jest.useFakeTimers();
				await settle(r);
				jest.advanceTimersByTime(1_100);
				expect(started()).toBe(0);
				jest.advanceTimersByTime(200); // 0.2 s + 1 s: the decision did not come
				expect([started(), unblocked()]).toEqual([1, ["no warming decision"]]);
			});
		});

		test("without idle warming a decision changes nothing (no summary waits for one)", async () => {
			const st = { calls: 0 };
			const r = await coldOnly(await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }));
			await settle(r);
			expect(await decide(r, "stop")).toBeUndefined();
			await sleep(100);
			expect(st.calls).toBe(0); // the usual timer (0.8 x 10.2 s) has not fired
		});
	});

	// ---- the prepared summary goes in through Pi's own compaction (pi-tricks §1b, variant 1) -------------------------------
	/** The cold return as Pi runs it: before_agent_start sees the session WITHOUT the prompt (Pi appends it after the hook), then the
	 *  first request. `pi` fakes Pi's side: ctx.compact (asks session_before_compact, appends the entry, projects it), isIdle, settings. */
	const comeBackNative = async (r: Any, settled: Any, o: { idle?: boolean; compact?: "ok" | "error" | "none"; abort?: boolean; tail?: Any[]; beforeMs?: number; postMs?: number } = {}) => {
		const st = { compactCalls: 0, answer: undefined as Any, instructions: undefined as Any };
		let branch: Any[] = [...branchOf(done, COLD_TS()), ...(settled?.entries?.length ? [settled.entries.at(-1)] : []), ...(o.tail ?? [])];
		let comp: Any = null;
		r.ctx.sessionManager.getBranch = () => branch;
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: done });
		r.ctx.isIdle = () => o.idle !== false;
		if (o.abort !== false) r.ctx.abort = () => {}; // Pi's ctx.abort (it cancels a pending compaction)
		if (o.compact !== "none") {
			r.ctx.compact = (opts: Any) => {
				st.compactCalls++;
				queueMicrotask(async () => {
					if (o.compact === "error") return opts?.onError?.(new Error("Compaction failed: provider refused"));
					st.instructions = opts?.customInstructions;
					if (o.beforeMs) await sleep(o.beforeMs); // another extension's handler, loaded before pi-zip's, takes its time
					st.answer = await r.handlers.get("session_before_compact")?.({ type: "session_before_compact", reason: "manual", customInstructions: opts?.customInstructions }, r.ctx);
					const c = st.answer?.compaction;
					if (!c) return opts?.onError?.(new Error("Compaction cancelled"));
					comp = { type: "compaction", id: "comp", timestamp: new Date().toISOString(), summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details, fromHook: true };
					branch = [...branch, comp];
					if (o.postMs) await sleep(o.postMs); // Pi's own work after the append: context refresh, projection, token estimate, the chat rebuild
					opts?.onComplete?.({ ...c });
				});
			};
		}
		await r.fire("before_agent_start", { prompt: "back" });
		// Pi appends the prompt, then builds the first request from the session
		const view = comp ? project(back, [comp]) : back;
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: view });
		branch = [...branch, { type: "message", id: "u4", message: back.at(-1).sourceEntry.message }];
		const req = await r.fire("context_with_system", { messages: flat(view) });
		return { ...st, req, comp, view };
	};

	test("a summary prepared while away goes in through Pi's compaction before the run, with pi-zip's own before; the run sends it as Pi projects it", async () => {
		const st = { calls: 0 };
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }, { registerEntryRenderer: () => {} });
		const settled = await settle(r);
		await sleep(200);
		const n = await comeBackNative(r, settled);
		expect(st.calls).toBe(1); // written once, while away
		expect(n.compactCalls).toBe(1);
		expect(n.answer.compaction).toMatchObject({ firstKeptEntryId: "u3", details: { by: "pi-zip", via: "native", trigger: "cold" } });
		expect(n.answer.compaction.summary).toContain("[summary of earlier conversation by pi-zip]");
		expect(n.answer.compaction.usage).toMatchObject({ input: 11, output: 22 }); // Pi books the summary call's cost on its block
		expect(n.req).toBeUndefined(); // nothing left to do locally: the request Pi built already starts with the summary
		await sleep(5);
		const notice = r.appended.filter((x: Any) => x.customType === "pi-zip/notice").at(-1).data;
		expect(notice.before).toBe(n.answer.compaction.tokensBefore); // Pi's "Compacted from N tokens" is the notice's before
		expect(notice.desc).toMatch(/^summarized 2 requests in [\d.]+ m?s · ready while you were away$/);
		// turn_end persists no second compaction; another compaction (Pi's own threshold one) is not answered
		const te = await r.fire("turn_end", turnEnd([...n.view, A("a6")], "a6"));
		expect(te?.entries?.some((e: Any) => e.type === "compaction") ?? false).toBe(false);
		expect(await r.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "threshold" }, r.ctx)).toBeUndefined();
	});

	const noticeOf = (r: Any) => r.appended.filter((x: Any) => x.customType === "pi-zip/notice" && !x.data?.kind).at(-1)?.data;

	test("item 4(a): the notice carries the native outcome: ok with its timings, or the reason the draft path was taken", async () => {
		const run = async (o: Any, piExtra: Any = {}) => {
			const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, { registerEntryRenderer: () => {}, ...piExtra });
			const settled = await settle(r);
			await sleep(200);
			const n = await comeBackNative(r, settled, o);
			await sleep(5);
			return { n, notice: noticeOf(r) };
		};
		const ok = await run({});
		expect(ok.notice).toMatchObject({ native: "ok" });
		expect(typeof ok.notice.nativeMs).toBe("number");
		expect(typeof ok.notice.nativeAskMs).toBe("number");
		expect((await run({ idle: false })).notice.native).toBe("not idle");
		expect((await run({ compact: "none" })).notice.native).toBe("no ctx.compact");
		expect((await run({ compact: "error" })).notice.native).toMatch(/^Pi's compaction failed: .*refused/);
		expect((await run({}, { getSettings: () => ({ compaction: { keepRecentTokens: 10_000_000 } }) })).notice.native).toBe("nothing to compact");
		// a later cold return in the same process: the reason is that of the run, not a stale one
	});

	test("item 4(b): Pi's work after the append is not 'another handler at work': a slow but successful native compaction keeps the native path for the process", async () => {
		const ledger = `/tmp/pz-native-${process.pid}-${Date.now()}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, { registerEntryRenderer: () => {} });
		const settled = await settle(r);
		await sleep(200);
		const n = await comeBackNative(r, settled, { postMs: 600 }); // 600 ms of Pi's post-append refresh on a big branch: > NATIVE_SLOW_MS (250)
		await sleep(5);
		const log = readFileSync(ledger, "utf8");
		expect(log).not.toContain("native_off"); // old code: "Pi's compaction took 6xx ms: another session_before_compact handler at work"
		expect(noticeOf(r)).toMatchObject({ native: "ok" });
		expect(noticeOf(r).nativeMs).toBeGreaterThan(550); // the whole call is still recorded
		expect(noticeOf(r).nativeAskMs).toBeLessThan(100);
		expect(n.answer.compaction).toBeTruthy();
		rmSync(ledger, { force: true });
	});

	test("item 4(b): a handler that really is slow (before ours, or between ours and the append) still ends the native path", async () => {
		const ledger = `/tmp/pz-native-${process.pid}-${Date.now()}-b.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, { registerEntryRenderer: () => {} });
		const settled = await settle(r);
		await sleep(200);
		await comeBackNative(r, settled, { beforeMs: 400 });
		await sleep(5);
		expect(readFileSync(ledger, "utf8")).toContain("native_off");
		expect(noticeOf(r).native).toMatch(/spent \d+ ms in session_before_compact handlers: another handler at work/);
		rmSync(ledger, { force: true });
	});

	test("item 6: pi-zip's compaction carries a marker for other extensions' handlers; a compaction that carries it is answered or cancelled, never left to Pi's default summariser", async () => {
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete({ calls: 0 }) } }, { registerEntryRenderer: () => {} });
		const settled = await settle(r);
		await sleep(200);
		const n = await comeBackNative(r, settled);
		expect(n.instructions).toBe(NATIVE_MARKER);
		expect(n.answer.compaction).toBeTruthy();
		// the ask is over: another delivery of a marked compaction (a slow handler of the same event) is cancelled, not passed on
		const again = await r.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "manual", customInstructions: NATIVE_MARKER }, r.ctx);
		expect(again).toEqual({ cancel: true });
		// a compaction with other instructions (the user's /compact focus) is none of pi-zip's business
		expect(await r.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "manual", customInstructions: "focus on the tests" }, r.ctx)).toBeUndefined();
		// no ask at all (pi-zip never started one) and the marker present: still cancelled
		const idle = await rig(done, COLD_TS());
		expect(await idle.handlers.get("session_before_compact")({ type: "session_before_compact", reason: "manual", customInstructions: NATIVE_MARKER + " more" }, idle.ctx)).toEqual({ cancel: true });
	});

	test("every gate keeps today's path: not idle, the branch already ends in a compaction, nothing for Pi to compact, no ctx.compact, a failed compaction", async () => {
		const foreignComp = { type: "compaction", id: "pc", summary: "Pi's own", firstKeptEntryId: "u3", details: {}, fromHook: false };
		const cases: Array<[string, Any, Any]> = [
			["not idle", { idle: false }, {}],
			["already compacted", { tail: [foreignComp] }, {}],
			["nothing to compact", {}, { getSettings: () => ({ compaction: { keepRecentTokens: 10_000_000 } }) }],
			["no ctx.compact (older Pi)", { compact: "none" }, {}],
			["no ctx.abort (nothing could cancel a compaction another handler holds up)", { abort: false }, {}],
			["compaction failed", { compact: "error" }, {}],
		];
		for (const [name, o, piExtra] of cases) {
			const st = { calls: 0 };
			const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } }, piExtra);
			const settled = await settle(r);
			await sleep(200);
			const n = await comeBackNative(r, settled, o);
			expect([name, n.compactCalls]).toEqual([name, name === "compaction failed" ? 1 : 0]);
			expect([name, n.comp]).toEqual([name, null]);
			expect([name, n.req?.messages?.[0]?.role]).toEqual([name, "compactionSummary"]); // the request carries it request-locally, as before
			expect([name, st.calls]).toEqual([name, 1]); // the prepared summary is still the one used
			const te = await r.fire("turn_end", turnEnd([...back, A("a6")], "a6"));
			expect([name, te.entries.filter((e: Any) => e.type === "compaction").length]).toEqual([name, 1]); // ... and turn_end persists it
		}
	});

	test("a summary still being written at the return is not pushed through Pi's compaction: the remainder is waited for, as before", async () => {
		const st = { calls: 0, delay: 250 };
		const r = await rig(done, COLD_TS(), { modelRegistry: { complete: mkComplete(st) } });
		const settled = await settle(r);
		await sleep(150);
		const n = await comeBackNative(r, settled);
		expect(n.compactCalls).toBe(0);
		expect(n.req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1);
	});
});

// =============================================================================================================
// Round 5 (the 39 s warm wait of 0.3.0): rule A starts a summary a warm return would make when the run ends; rule B never makes the
// user wait for one while the cache is warm (unless the context is at Pi's compaction room), and only with a UI.
describe("round 5: rules A (start early) and B (never wait while warm)", () => {
	const done = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
	const back = [...done, U("u4", "back")];
	const tail = [A("a6", ["c6"]), R("r6", "c6", 400)];
	const mkComplete = (state: { calls: number; delay?: number; signals?: Any[] }) => async (_m: Any, _c: Any, o: Any) => {
		state.calls++;
		state.signals?.push(o?.signal);
		if (state.delay) await sleep(state.delay);
		return { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } };
	};
	let ledger = "";
	beforeEach(() => {
		process.env.PI_ZIP_COLD_CAP = "6000";
		process.env.PI_ZIP_TTL_SECS = "300"; // a return within minutes is warm
		ledger = `/tmp/pi-zip-r5-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
	});
	afterEach(() => { if (process.env.R5_KEEP) console.error("LEDGER", ledger); else rmSync(ledger, { force: true }); });
	beforeAll(async () => { await import("@earendil-works/pi-coding-agent"); });
	const rows = (type: string): Any[] => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === type) : []);
	const settle = (r: Any) => r.fire("agent_before_settle", { context: { contextEntries: done }, entries: [] });
	/** The user comes back: before_agent_start, then the first request (Pi appended the prompt). */
	const prompt = async (r: Any, settled?: Any) => {
		r.ctx.sessionManager.getBranch = () => [...branchOf(done, WARM_TS()), ...(settled?.entries?.length ? [settled.entries.at(-1)] : [])];
		r.ctx.sessionManager.buildSessionProjection = () => ({ entries: back });
		await r.fire("before_agent_start", {});
		return r.fire("context_with_system", { messages: flat(back) });
	};
	const noticeOf = (r: Any) => r.appended.filter((x: Any) => x.customType === "pi-zip/notice" && !x.data?.kind).at(-1)?.data;
	/** The Zip instance behind a rig (index.ts keeps it private): only to put it in a state a test needs (justEdited after a warm edit). */
	const zipOf = async (r: Any): Promise<Any> => {
		const orig = Zip.prototype.sessionStart;
		let z: Any = null;
		Zip.prototype.sessionStart = function (this: Any, ...a: Any[]) { z = this; return (orig as Any).apply(this, a); };
		try { await r.fire("session_start", {}); } finally { Zip.prototype.sessionStart = orig; }
		return z;
	};
	const R5 = { registerEntryRenderer: () => {} }; // notices go to the transcript (r.appended)

	test("A: settle starts the summary a warm return would make at once (not at 0.8 x TTL); the warm return takes it, no second call, no wait", async () => {
		const st = { calls: 0 };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } }, R5);
		const settled = await settle(r);
		await sleep(20);
		expect(st.calls).toBe(1); // 0.3.0: 0 (the away timer would start one 240 s later, and the warm return wrote its own while the user waited)
		expect(rows("settle_plan")[0]).toMatchObject({ warmCut: "u3", early: true });
		const t0 = Date.now();
		const req = await prompt(r, settled);
		expect(Date.now() - t0).toBeLessThan(150);
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1);
		await sleep(5);
		expect(noticeOf(r).desc).toMatch(/ready while you were away$/);
	});

	test("A: nothing early right after a request that carried an edit (a warm return then makes none, b2b), nor without a UI", async () => {
		const st = { calls: 0 };
		const quiet = await rig(done, WARM_TS(), { hasUI: false, mode: "json", modelRegistry: { complete: mkComplete(st) } });
		expect(await settle(quiet)).toBeUndefined();
		await sleep(20);
		expect(st.calls).toBe(0);
		// the b2b case: the newest response answered a request that carried a fresh edit (justEdited)
		const b2b = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
		(await zipOf(b2b)).justEdited = true;
		await settle(b2b);
		await sleep(20);
		expect(rows("settle_plan").at(-1)?.warmCut).toBeUndefined();
		expect(rows("away_summary_start").filter((x) => x.origin === "early")).toEqual([]);
		expect(st.calls).toBe(0);
		// ... while the same session without that state starts it (0.3.0: never)
		const plain = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
		await settle(plain);
		await sleep(20);
		expect(st.calls).toBe(1);
	});

	test("B at the prompt: no finished summary for the warm cut: no wait, nothing applied (not even the folds), the summary starts in the background", async () => {
		const st = { calls: 0, delay: 300 };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } }, R5); // a fresh process: no settle ran
		const t0 = Date.now();
		const req = await prompt(r);
		expect(Date.now() - t0).toBeLessThan(150); // 0.3.0: the whole call (300 ms here; 39 s in the incident)
		expect(req).toBeUndefined(); // nothing applied: the law priced folds and summary together
		await sleep(20);
		expect(st.calls).toBe(1); // ... and the summary is being written
		expect(rows("warm_defer")[0]).toMatchObject({ where: "run", key: "u3", running: false });
		// the first turn_end: still being written: no wait there either, nothing persisted
		const t1 = Date.now();
		expect(await r.fire("turn_end", turnEnd([...back, ...tail], "r6"))).toBeUndefined();
		expect(Date.now() - t1).toBeLessThan(150);
		expect(st.calls).toBe(1);
		// a later turn_end, once it is done: the valve adopts it (a draft the next request first carries)
		await sleep(350);
		const te = await r.fire("turn_end", turnEnd([...back, ...tail, A("a7")], "a7"));
		expect(te.entries.map((e: Any) => e.type)).toEqual(["compaction", "custom"]);
		expect(te.entries[0]).toMatchObject({ firstKeptEntryId: "u3", details: { trigger: "valve", carried: false } });
		expect(st.calls).toBe(1);
		await sleep(5);
		expect(noticeOf(r).desc).toMatch(/written while you worked$/);
	});

	test("B waits at Pi's compaction room (Pi would compact, lossily, otherwise); below it, the same warm return does not", async () => {
		const run = async (contextWindow: number) => {
			const st = { calls: 0, delay: 200 };
			const r = await rig(done, WARM_TS(), { model: { provider: "p", id: "m", contextWindow, cost: { cacheWrite: 3, cacheRead: 0.3 }, promptCache: { short: 300 } }, modelRegistry: { complete: mkComplete(st) } });
			const t0 = Date.now();
			const req = await prompt(r);
			const ms = Date.now() - t0;
			await sleep(20);
			return { ms, summary: req?.messages?.[0]?.role === "compactionSummary", calls: st.calls };
		};
		const room = await run(100_000); // ~80K tokens against a room of 75K: atRoom
		expect(room.summary).toBe(true);
		expect(room.ms).toBeGreaterThanOrEqual(190); // waited for the whole call, as 0.3.0
		const roomy = await run(1_000_000);
		expect(roomy.summary).toBe(false); // 0.3.0: true, after the same wait
		expect(roomy.ms).toBeLessThan(150);
		expect(roomy.calls).toBe(1);
	});

	test("no UI (print, json, rpc): the warm return waits for the summary as in 0.3.0; with a UI the same return does not", async () => {
		const st = { calls: 0, delay: 200 };
		const quiet = await rig(done, WARM_TS(), { hasUI: false, mode: "json", modelRegistry: { complete: mkComplete(st) } });
		expect(await settle(quiet)).toBeUndefined();
		const t0 = Date.now();
		const req = await prompt(quiet);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(rows("warm_defer")).toEqual([]);
		const st2 = { calls: 0, delay: 200 };
		const ui = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st2) } });
		expect(await prompt(ui)).toBeUndefined(); // 0.3.0: the summary, after the wait
	});

	test("runAway never leaks a background summary: one for its cut is kept (no second call); a context rewritten while away drops the early one (aborted, booked)", async () => {
		process.env.PI_ZIP_TTL_SECS = "0.3"; // the timer fires at 240 ms
		// (1) the cold plan cuts where the early summary cuts: the timer keeps it
		const st = { calls: 0, delay: 400, signals: [] as Any[] };
		const r = await rig(done, Date.now(), { modelRegistry: { complete: mkComplete(st) } });
		await settle(r);
		await sleep(10);
		expect(st.calls).toBe(1); // rule A, at settle
		await sleep(300); // the timer fired at 240 ms, the call still runs
		expect(st.calls).toBe(1);
		expect(st.signals[0].aborted).toBe(false);
		// (2) something rewrote the context while away (Pi's compaction, another extension's edit): the early summary read a context that is
		// gone: aborted, booked as unused, and the timer's own summary for the context as it is replaces it
		const s2 = { calls: 0, delay: 400, signals: [] as Any[] };
		const q = await rig(done, Date.now(), { modelRegistry: { complete: mkComplete(s2) } });
		await settle(q);
		await sleep(10);
		const base = q.ctx.sessionManager.getBranch();
		q.ctx.sessionManager.getBranch = () => [...base, { type: "compaction", id: "pc", summary: "another", firstKeptEntryId: "u2", details: {} }];
		await sleep(300);
		expect(s2.calls).toBe(2);
		expect(s2.signals[0].aborted).toBe(true); // 0.3.0 never started the first one; its final startBg replaced a live summary without aborting it
		expect(s2.signals[1].aborted).toBe(false);
		await sleep(450);
		expect(q.appended.filter((x: Any) => x.customType === "pi-zip/unused-summary").map((x: Any) => x.data)).toEqual([{ usd: 0.02, ab: true }]);
	});

	test("anti-thrash: once a background summary went unused in a warm stretch, a moved cut is written while the user waits; no new call per turn", async () => {
		const st = { calls: 0, delay: 200 };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
		expect(await prompt(r)).toBeUndefined(); // B: deferred, the summary for u3 is being written
		await sleep(20);
		expect(st.calls).toBe(1);
		// the session as the next turn_end sees it no longer has u3 (another branch of the same size): the plan cuts elsewhere and the
		// running summary cannot be pinned to it
		const other = back.map((pe: Any) => ({ sourceEntry: { ...pe.sourceEntry, id: `x${pe.sourceEntry.id}` }, messages: pe.messages }));
		const t0 = Date.now();
		const te = await r.fire("turn_end", turnEnd([...other, A("xa6")], "xa6"));
		expect(Date.now() - t0).toBeGreaterThanOrEqual(190); // written while the user waits (0.3.0's behaviour), not one more background call
		expect(te.entries[0]).toMatchObject({ type: "compaction", firstKeptEntryId: "xu3" });
		expect(st.calls).toBe(2); // the unused one and the one adopted: no third
		expect(rows("unused_summary")).toMatchObject([{ origin: "defer", key: "u3", unused: 1 }]);
		expect(rows("warm_wait")).toMatchObject([{ where: "turn_end", key: "xu3" }]);
		// a later turn_end of the same stretch starts nothing more
		await r.fire("turn_end", turnEnd(project([...other, A("xa6"), U("xu5", "more"), A("xa7")], te.entries), "xa7")); // the session with the summary in
		await sleep(250);
		expect(st.calls).toBe(2);
	});

	test("idle cache warming does not drop the early summary: Pi's warm and stop decisions leave it alone, the warm return takes it", async () => {
		const st = { calls: 0, signals: [] as Any[] };
		const idle = { getSettings: () => ({ cacheWarming: "idle" }), registerEntryRenderer: () => {} };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } }, idle);
		const settled = await settle(r);
		await sleep(20);
		expect(st.calls).toBe(1); // rule A does not wait for Pi's decision (only the cold plan's timer does)
		const decide = (action: string) => r.handlers.get("cache_warming_decision")({ type: "cache_warming_decision", action, warmCost: 0.01, missCost: 1, continuationProbability: 0.15 }, r.ctx);
		await decide("warm");
		await decide("stop"); // the cold plan's summary is released: it cuts where the early one does, which is kept
		await sleep(20);
		expect(st.calls).toBe(1);
		expect(st.signals[0].aborted).toBe(false);
		const req = await prompt(r, settled);
		expect(req.messages[0].role).toBe("compactionSummary");
		expect(st.calls).toBe(1);
		expect(rows("unused_summary")).toEqual([]);
	});

	test("a finished early summary lost when the process ends is booked (its cost), but not counted against the bound: the restarted process starts its own", async () => {
		const st = { calls: 0 };
		const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
		await settle(r);
		await sleep(20);
		expect(st.calls).toBe(1);
		await r.fire("session_shutdown", {});
		expect(r.appended.filter((x: Any) => x.customType === "pi-zip/unused-summary").map((x: Any) => x.data)).toEqual([{ usd: 0.02, lost: "shutdown" }]); // 0.3.0: never booked
	});

	test("anti-thrash across a restart: the unused one is in the session (pi-zip/unused-summary, ab), so a restarted process keeps the bound", async () => {
		const run = async (extra: Any[]) => {
			const st = { calls: 0, delay: 200 };
			const r = await rig(done, WARM_TS(), { modelRegistry: { complete: mkComplete(st) } });
			const base = r.ctx.sessionManager.getBranch;
			r.ctx.sessionManager.getBranch = () => [...base(), ...extra];
			await r.fire("session_start", {});
			const t0 = Date.now();
			const req = await prompt(r);
			return { ms: Date.now() - t0, summary: req?.messages?.[0]?.role === "compactionSummary" };
		};
		const spent = await run([{ type: "custom", customType: "pi-zip/unused-summary", data: { usd: 0.02, ab: true } }]);
		expect(spent.summary).toBe(true); // the budget of this warm stretch is spent: written while the user waits, as 0.3.0
		expect(spent.ms).toBeGreaterThanOrEqual(190);
		const away = await run([{ type: "custom", customType: "pi-zip/unused-summary", data: { usd: 0.02 } }]); // the away timer's: not counted
		expect(away.summary).toBe(false);
		expect(away.ms).toBeLessThan(150);
	});
});

// =============================================================================================================
describe("I2 lossless: zip_recall(handle) returns the original, byte for byte", () => {
	test.each(SEEDS)("random session, seed %i", async (seed) => {
		process.env.PI_ZIP_COLD_CAP = "1000";
		const entries = [...randomSession(seed), U("uN", "back")];
		const p = planContext(entries, { cwd: process.cwd(), coldCap: 1000 })!;
		const r = await rig(entries, COLD_TS());
		const tool = r.handlers.get("tool:zip_recall");
		const originals = new Map(entries.filter((e) => e.messages[0].role === "toolResult").map((e) => [e.sourceEntry.id, e.messages[0].content[0].text as string]));
		for (const f of p.folds) {
			const h = handleFor(f.entryId);
			expect(f.ph).toContain(h);
			const res = await tool.execute("t", { handle: h }, undefined, undefined, r.ctx);
			const orig = originals.get(f.entryId)!;
			expect(res.isError).toBe(false);
			expect(res.content[0].text.endsWith(`lines]\n${orig}`)).toBe(true);
		}
		const batch = await tool.execute("t", { handles: [...p.folds.map((f) => handleFor(f.entryId)), "nope000000"] }, undefined, undefined, r.ctx);
		expect(batch.content[0].text).toContain("[handle nope000000] not found");
	});
});

// =============================================================================================================
describe("I3 untouched: user messages, tool-call arguments, thinking and the payload's system/tools never change", () => {
	test.each(SEEDS)("random session, seed %i", (seed) => {
		const entries = [...randomSession(seed), U("uN", "back")];
		const p = planContext(entries, { cwd: process.cwd(), coldCap: 1000 })!;
		const before = flat(entries);
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const view = applyPlanToMessages(before, plan)?.messages ?? before;
		expect(view).toHaveLength(before.length);
		const phById = new Map(p.folds.map((f) => [f.toolCallId, f.ph]));
		view.forEach((m: Any, i: number) => {
			const o = before[i];
			if (o.role !== "toolResult") return expect(m).toBe(o); // identical object: not even copied
			const { content, ...rest } = m;
			const { content: oc, ...orest } = o;
			expect(rest).toEqual(orest);
			if (phById.has(o.toolCallId)) expect(content).toEqual([{ type: "text", text: phById.get(o.toolCallId) }]);
			else expect(content).toBe(oc);
		});
		expect(JSON.stringify(view.filter((m: Any) => m.role === "user"))).toBe(JSON.stringify(before.filter((m: Any) => m.role === "user")));
	});

	test("a summary skeleton carries every user request verbatim", () => {
		const entries = randomSession(7);
		const blocks = buildBlocks(entries);
		const sk = skeleton(blocks, null);
		for (const e of entries) if (e.messages[0].role === "user") expect(sk.text).toContain(e.messages[0].content);
	});

	test("the guard repairs only tool results: system and tools are byte-identical", () => {
		const payload = { system: [{ type: "text", text: "S" }], tools: [{ name: "bash" }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: "x" }] }] };
		const out = repairPayload(payload)!;
		expect(JSON.stringify(out.payload.system)).toBe(JSON.stringify(payload.system));
		expect(JSON.stringify(out.payload.tools)).toBe(JSON.stringify(payload.tools));
		expect(out.payload.messages[0].content[0].type).toBe("text");
	});
});

// =============================================================================================================
describe("I4 off is a strict no-op", () => {
	const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "back")];
	const orphan = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "gone", content: "x" }] }] };

	test("PI_ZIP_OFF=1 registers nothing at all", async () => {
		process.env.PI_ZIP_OFF = "1";
		const r = await rig(prevRun, COLD_TS());
		expect(r.calls).toEqual([]);
	});

	test("/zip off: no handler changes the view, the entries or the payload, even on a cold return that would fold", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		r.notes.length = 0; // the command's own confirmation is the only message allowed
		const msgs = flat(prevRun);
		expect(await r.fire("before_agent_start", {})).toBeUndefined();
		expect(await r.fire("context_with_system", { messages: msgs })).toBeUndefined();
		const all = [...prevRun, A("a4")];
		expect(await r.fire("turn_end", turnEnd(all, "a4"))).toBeUndefined();
		expect(await r.fire("agent_before_settle", { context: { contextEntries: all }, entries: [] })).toBeUndefined();
		expect(await r.fire("before_provider_request", { payload: orphan })).toBeUndefined();
		expect(r.notes).toEqual([]);
		// same scenario with zip on does change things (the test would be vacuous otherwise)
		const on = await rig(prevRun, COLD_TS());
		await on.fire("before_agent_start", {});
		expect(await on.fire("context_with_system", { messages: msgs })).toBeDefined();
		expect(await on.fire("before_provider_request", { payload: orphan })).toBeDefined();
		await r.handlers.get("cmd:zip").handler("on", r.ctx); // and /zip on resumes
		expect(r.appended.at(-1)).toMatchObject({ data: { off: false } });
	});

	test("off survives a restart (state entry), and a restart in off mode stays a no-op", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		expect(r.appended.at(-1)).toMatchObject({ customType: "pi-zip/state", data: { off: true } });
		const r2 = await rig(prevRun, COLD_TS(), { branch: [...branchOf(prevRun, COLD_TS()), r.appended.at(-1)] });
		await r2.fire("session_start", { reason: "startup" });
		await r2.fire("before_agent_start", {});
		expect(await r2.fire("context_with_system", { messages: flat(prevRun) })).toBeUndefined();
	});

	test("the recall tool stays registered while off (earlier folds must stay recallable)", async () => {
		const r = await rig(prevRun, COLD_TS());
		await r.handlers.get("cmd:zip").handler("off", r.ctx);
		expect(r.handlers.has("tool:zip_recall")).toBe(true);
	});
});

// =============================================================================================================
describe("I5 valid: every tool_use keeps its tool_result", () => {
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5", ["c3"]), R("r3", "c3"), A("a6"), U("u4", "four"), A("a7")];
	const blocks = buildBlocks(ctx);
	const idx = (id: string) => blocks.findIndex((b) => b.entryId === id);
	const N = blocks.filter((b) => b.kind === "user").length;
	const ok = (folds: [string, string][], cut: string | null = null) => validateEdits(blocks, { folds: new Map(folds.map(([i, t]) => [idx(i), t])), cut: cut ? idx(cut) : null }, N);

	test("legal edit sets are accepted", () => {
		expect(ok([["r1", "[ph]"]])).toBeNull();
		expect(ok([["r2", "[ph]"]])).toBeNull(); // an older turn
		expect(ok([], "u3")).toBeNull();
		expect(ok([], "a3")).toBeNull();
	});
	test("illegal edit sets are rejected", () => {
		expect(ok([["a1", "[ph]"]])).not.toBeNull(); // not a toolResult
		expect(ok([["u1", "[ph]"]])).not.toBeNull();
		expect(ok([["r1", "  "]])).not.toBeNull(); // empty placeholder
		expect(ok([], "a5")).not.toBeNull(); // cut inside the last 2 user turns
		expect(ok([], "u4")).not.toBeNull();
		expect(ok([], "r2")).not.toBeNull(); // cut at a toolResult orphans it
		expect(validateEdits(blocks, { folds: new Map(), cut: 0 }, N)).not.toBeNull();
	});
	test("the latest user turn's own output is never a fold target; the previous turn's only when re-readable", () => {
		const three = buildBlocks([U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5", ["c3"]), R("r3", "c3")]);
		const at = (id: string) => three.findIndex((b) => b.entryId === id);
		const rec = (r: string) => new Map([[at("r2"), r]]);
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("rereadable"), cut: null }, 3)).toBeNull();
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("nonrereadable"), cut: null }, 3)).toMatch(/previous user turn/);
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), cut: null }, 3)).toMatch(/previous user turn/); // unknown = not proven re-readable
		expect(validateEdits(three, { folds: new Map([[at("r2"), "[ph]"]]), recover: rec("rereadable"), relax: false, cut: null }, 3)).toMatch(/previous user turn/);
		expect(validateEdits(three, { folds: new Map([[at("r1"), "[ph]"]]), cut: null }, 3)).toBeNull(); // older turns need no proof
		expect(validateEdits(three, { folds: new Map([[at("r3"), "[ph]"]]), recover: new Map([[at("r3"), "rereadable"]]), cut: null }, 3)).toMatch(/latest user turn/);
	});
	test("a target another extension already edited is rejected", () => {
		const b = buildBlocks(ctx);
		b[idx("r1")].edited = true;
		expect(validateEdits(b, { folds: new Map([[idx("r1"), "[ph]"]]), cut: null }, N)).toMatch(/already edited/);
	});
	test("only the pairing breaks the edits themselves create are rejected; an already odd session stays as odd as it was", () => {
		const broken = buildBlocks([U("u1", "one"), A("a1", ["c1", "c9"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(broken, { folds: new Map([[2, "[ph]"]]), cut: null }, 3)).toBeNull(); // a missing result already existed; folding does not change it
		const orphan = buildBlocks([U("u1", "one"), R("r0", "zz"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(orphan, { folds: new Map(), cut: 3 }, 3)).toBeNull();
		const split = buildBlocks([U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "t"), A("a4")]);
		expect(validateEdits(split, { folds: new Map(), cut: 2 }, 3)).toMatch(/cut/); // a cut at the result orphans it
	});
	test("aborted and errored assistant turns (saved without results) never count as orphans: later edits stay legal", () => {
		const dead = (id: string, stop: string, call: string) => {
			const e = A(id, [call]);
			(e.messages[0] as Any).stopReason = stop;
			return e;
		};
		const ctx2 = [U("u1", "one"), dead("a1", "aborted", "x1"), U("u2", "two"), A("a2", ["c2"]), R("r2", "c2"), A("a3"), U("u3", "three"), dead("a4", "error", "x2"), U("u4", "four"), A("a5", ["c5"]), R("r5", "c5"), A("a6"), U("u5", "five"), A("a7")];
		const b = buildBlocks(ctx2);
		const id = (x: string) => b.findIndex((y) => y.entryId === x);
		expect(validateEdits(b, { folds: new Map([[id("r2"), "[ph]"]]), cut: null }, 5)).toBeNull();
		expect(validateEdits(b, { folds: new Map(), cut: id("u3") }, 5)).toBeNull();
		expect(validateEdits(b, { folds: new Map(), cut: id("u2") }, 5)).toBeNull();
		// ... while a live assistant turn without results that the cut strands is still the cut's doing only when it is new
		const live = buildBlocks([U("u1", "one"), A("a1", ["x1"]), U("u2", "two"), A("a2"), U("u3", "three"), A("a3")]);
		expect(validateEdits(live, { folds: new Map(), cut: 2 }, 3)).toBeNull();
	});

	test.each(SEEDS)("random deletion, seed %i: an edit set is rejected exactly when the cut creates an orphan the session did not already have", (seed) => {
		const r = prng(seed * 7919);
		const entries = randomSession(seed);
		const full = buildBlocks(entries);
		const turns = (bl: Block[]) => bl.filter((x) => x.kind === "user").length;
		expect(validateEdits(full, { folds: new Map(), cut: null }, turns(full))).toBeNull();
		const victim = Math.floor(r() * entries.length);
		const rest = entries.filter((_, i) => i !== victim);
		const b = buildBlocks(rest);
		expect(validateEdits(b, { folds: new Map(), cut: null }, turns(b))).toBeNull(); // no edit, nothing created
		// every legal cut position: rejected iff some kept toolResult lost its call (calls before the cut are gone)
		const limit = b.findIndex((x) => x.userTurn >= turns(b) - 1);
		for (let c = 1; c < b.length && (limit < 0 || c <= limit); c++) {
			if (!b[c].entryId || (b[c].kind !== "user" && b[c].kind !== "assistant")) continue;
			const seen = new Set<string>();
			const callsAll = new Set<string>();
			for (const x of b.slice(0, c)) if (x.kind === "assistant") for (const k of x.msg.content) if (k.type === "toolCall") callsAll.add(k.id);
			for (const x of b.slice(c)) if (x.kind === "assistant") for (const k of x.msg.content) if (k.type === "toolCall") seen.add(k.id);
			const baseOrphan = (id: string) => ![...b.slice(0, b.findIndex((y) => y.msg.toolCallId === id))].some((y) => y.kind === "assistant" && y.msg.content.some((k: Any) => k.id === id));
			const newOrphan = b.slice(c).some((x) => x.kind === "toolResult" && !seen.has(x.msg.toolCallId) && !baseOrphan(x.msg.toolCallId));
			const verdict = validateEdits(b, { folds: new Map(), cut: c }, turns(b));
			if (newOrphan) expect(verdict).not.toBeNull();
		}
	});

	test.each(SEEDS)("payload guard on a random Anthropic-shaped request, seed %i", (seed) => {
		const r = prng(seed);
		const messages: Any[] = [];
		let n = 0;
		for (let i = 0; i < 6; i++) {
			const ids = r() < 0.7 ? [`t${++n}`] : [];
			messages.push({ role: "user", content: `q${i}` });
			messages.push({ role: "assistant", content: [{ type: "text", text: "x" }, ...ids.map((id) => ({ type: "tool_use", id, name: "bash", input: {} }))] });
			if (ids.length) messages.push({ role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "out" })) });
		}
		expect(repairPayload({ messages })).toBeNull(); // a valid request is never touched
		const kill = messages.map((m, i) => (m.role === "assistant" && m.content.some((c: Any) => c.type === "tool_use") ? i : -1)).filter((i) => i >= 0);
		if (!kill.length) return;
		const victim = kill[Math.floor(r() * kill.length)];
		const broken = messages.filter((_, i) => i !== victim);
		const fixed = repairPayload({ messages: broken })!;
		expect(fixed.repaired).toBeGreaterThan(0);
		fixed.payload.messages.forEach((m: Any, i: number) => {
			if (!Array.isArray(m.content)) return;
			for (const b of m.content) if (b.type === "tool_result") expect(fixed.payload.messages[i - 1].content.some((c: Any) => c.type === "tool_use" && c.id === b.tool_use_id)).toBe(true);
		});
	});

	test("the guard repairs OpenAI-shaped orphan tool messages too, and the extension forwards the repair", async () => {
		const r = await rig([U("u1", "x")], WARM_TS());
		const out = await r.fire("before_provider_request", { payload: { messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "gone", content: "x" }] } });
		expect(out.messages[1].role).toBe("user");
	});
});

// =============================================================================================================
describe("I6 / F10 warm cache: nothing changes unless the context passes the valve V", () => {
	const session = (outputs: number) => {
		const e: Any[] = [];
		for (let t = 0; t < outputs; t++) e.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`));
		e.push(U("uN", "now"));
		return e;
	};
	const model = (contextWindow?: number) => ({ provider: "p", id: "m", ...(contextWindow ? { contextWindow } : {}), cost: { cacheWrite: 3, cacheRead: 0.3 }, promptCache: { short: 300 } });

	test("the reserve is Pi's setting", () => {
		expect(reserveTokensFor({}, undefined)).toBe(16_384);
		expect(reserveTokensFor({ compaction: { reserveTokens: 5000 } }, undefined)).toBe(5000);
		expect(reserveTokensFor({ compaction: { reserveTokens: 5000, modelOverrides: { "p/m": { reserveTokens: 9000 } } } }, { provider: "p", id: "m" })).toBe(9000);
	});

	test("a warm request below V: no local edit, no persisted edit, even with a stale cold plan in the branch", async () => {
		const entries = session(8);
		const stale = { type: "custom", customType: "pi-zip/plan", data: { policy: "pi-zip", targets: [], summary: null } };
		const r = await rig(entries, WARM_TS(), { branch: [...branchOf(entries, WARM_TS()), stale] });
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
		expect(await r.fire("turn_end", turnEnd([...entries, A("zN")], "zN"))).toBeUndefined();
		expect(r.notes).toEqual([]);
		expect(planContext(entries, { mode: "warm", cwd: ".", model: r.ctx.model })).toBeNull();
	});

	test("above V the warm cache is edited with the cold plan: first request carries it, turn_end persists exactly it (one valve, no 0.85 threshold)", async () => {
		const entries = session(80); // ~180K tokens: above 160K at an unknown window
		const r = await rig(entries, WARM_TS(), { model: model(undefined) });
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(entries) });
		const foldedIds = req1.messages.filter((m: Any) => m.role === "toolResult" && m.content[0].text.startsWith("[folded by pi-zip")).map((m: Any) => m.toolCallId);
		expect(foldedIds.length).toBe(79); // the cold plan folds every eligible output (all but the latest turn's... r79 is the previous turn: protected)
		expect(foldedIds).not.toContain("c79");
		const all = [...entries, A("zN")];
		const te = await r.fire("turn_end", turnEnd(all, "zN"));
		const ids = te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId).sort();
		expect(ids.length).toBe(79);
		expect(JSON.stringify(flat(project(all, te.entries)).slice(0, req1.messages.length))).toBe(JSON.stringify(req1.messages));
		expect(r.notes[0]).toMatch(/^pi-zip  zipped \d+ old outputs  [\d.]+K → [\d.]+K  [\d.]+ m?s$/); // the valve reason is in the expanded transcript view
	});

	test("above V but the plan would cut under 50% (the bulk is a protected, non-re-readable result): nothing is edited, at the first request or at turn_end", async () => {
		const entries = session(24);
		const call = A("aw", ["cw"]);
		(call.messages[0] as Any).content[1].name = "write";
		const big = R("rw", "cw", 512_000); // ~128K protected tokens next to ~54K of foldable reads: 183K -> 131K
		(big.messages[0] as Any).toolName = "write";
		entries.splice(entries.length - 1, 0, U("uw", "write it"), call, big, A("zw"));
		const r = await rig(entries, WARM_TS(), { model: model(undefined) });
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
		expect(await r.fire("turn_end", turnEnd([...entries, A("zN")], "zN"))).toBeUndefined();
		expect(r.notes).toEqual([]);
	});

	test("no V any more: with prices a big warm cut pays at any window (the law); a small window clamps the cap below Pi's compaction trigger", async () => {
		const mid = withK(session(50), 1); // ~112K tokens, ~105K of it foldable
		const stats = process.env.PI_ZIP_CACHE_STATS;
		process.env.PI_ZIP_CACHE_STATS = `${stats}.priced-${process.pid}`;
		record("p/m", { explicit: true, total: 10_000 }); // the class is known: the law prices the edit with the class ratios
		const big = await rig(mid, WARM_TS(), { model: model(1_000_000) });
		await big.fire("before_agent_start", {});
		expect(await big.fire("context_with_system", { messages: flat(mid) })).toBeDefined(); // D ~105K >> the EOQ Delta at this A
		rmSync(process.env.PI_ZIP_CACHE_STATS, { force: true });
		process.env.PI_ZIP_CACHE_STATS = stats;
		const small = session(6); // ~14K tokens
		const tiny = await rig(small, WARM_TS(), { model: model(32_000) }); // cap = room = 7.4K
		await tiny.fire("before_agent_start", {});
		expect(await tiny.fire("context_with_system", { messages: flat(small) })).toBeDefined();
		// the cold cap never exceeds Pi's compaction room either
		const prose = [U("u1", "one"), A("a1"), AX("x1", 60_000), U("u2", "two"), A("a2"), AX("x2", 60_000), U("u3", "three"), A("a3"), U("u4", "now")]; // ~30K tokens of prose
		const clamped = planContext(prose, { mode: "cold", cwd: ".", model: model(32_000), coldCap: 60_000, promptPending: false });
		expect(clamped!.sumTrigger).not.toBeNull(); // 30K > the compaction room (7.4K): the 60K default cap is clamped
		const roomy = planContext(prose, { mode: "cold", cwd: ".", model: model(1_000_000), coldCap: 60_000, promptPending: false });
		expect(roomy!.sumTrigger).toBeNull(); // the same context at a 1M window is under the cap
	});

	test("a context that grows past V in the middle of a warm run is edited at turn_end, for the next request", async () => {
		const entries = session(80);
		const r = await rig(entries, WARM_TS(), { model: model(undefined) });
		await r.fire("before_agent_start", {});
		// the run started small (first request saw a short session), then grew
		const first = await rig(session(3), WARM_TS(), { model: model(undefined) });
		await first.fire("before_agent_start", {});
		expect(await first.fire("context_with_system", { messages: flat(session(3)) })).toBeUndefined();
		const te = await first.fire("turn_end", turnEnd([...entries, A("zN")], "zN"));
		expect(te.entries.filter((e: Any) => e.type === "context_edit").length).toBe(79);
		expect(first.notes[0]).toMatch(/^pi-zip  zipped \d+ old outputs  [\d.]+K → [\d.]+K  [\d.]+ m?s$/);
	});

	test("a warm plan committed at a run's last turn_end, then a cold return: its notice keeps the estimate (the next response answers a later run)", async () => {
		const renderers = new Map<string, Any>();
		const big = session(80);
		const r = await rig(session(3), WARM_TS(), { model: model(undefined) }, { registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn) });
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(session(3)) })).toBeUndefined();
		const te = await r.fire("turn_end", turnEnd([...big, A("zN")], "zN")); // the run's last turn: no request of this run carries the plan
		expect(te.entries.some((e: Any) => e.type === "context_edit")).toBe(true);
		await sleep(5);
		const notice = r.appended.filter((x: Any) => x.customType === "pi-zip/notice").at(-1);
		const reqTs = notice.data.reqTs as number;
		expect(typeof reqTs).toBe("number");
		const th = { fg: (_c: string, t: string) => t };
		const render = (d: Any) => renderers.get("pi-zip/notice")({ id: "nv", data: d }, { expanded: false }, th).render(200)[0];
		const estimate = render({ ...notice.data, reqTs: undefined });
		// the next run: the user comes back after the TTL; its first response (after its own cold plan, or Pi's compaction) is much smaller
		const prompt = { type: "message", id: "u-back", message: { role: "user", content: "back", timestamp: reqTs + 600_000 } };
		const reply = { type: "message", id: "a-back", message: { role: "assistant", timestamp: reqTs + 601_000, stopReason: "stop", usage: { input: 900, cacheRead: 0, cacheWrite: 7_000 } } };
		let branch: Any[] = [...branchOf(big, reqTs - 50), ...te.entries, notice, prompt, reply];
		r.ctx.sessionManager.getBranch = () => branch;
		r.ctx.sessionManager.getEntryCount = () => branch.length;
		expect(render(notice.data)).toBe(estimate);
		expect(render(notice.data)).not.toContain("7.9K");
		// the same reply without a later prompt before it would be this plan's own (the next request of the same run): its real size
		branch = branch.filter((e) => e !== prompt);
		expect(render({ ...notice.data, reqTs: reqTs + 1 })).toContain("→ 7.9K");
	});
});

// =============================================================================================================
describe("run lifecycle: failures, steering", () => {
	const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
	const cold = [...prevRun, U("u3", "back after the idle")];

	test("an aborted or errored first turn still persists the plan its first request already sent", async () => {
		for (const stopReason of ["aborted", "error"]) {
			const r = await rig(cold, COLD_TS());
			await r.fire("before_agent_start", {});
			const req = await r.fire("context_with_system", { messages: flat(cold) });
			expect(req.messages.some((m: Any) => m.role === "toolResult" && m.content[0].text.startsWith("[folded"))).toBe(true);
			const te = await r.fire("turn_end", { ...turnEnd([...cold, A("a5")], "a5"), message: { role: "assistant", stopReason, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } });
			expect(te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId)).toEqual(["r1"]);
		}
	});

	test("a failed turn that never sent a plan persists nothing; when planning threw, the edit run simply ends", async () => {
		const r = await rig(cold, COLD_TS());
		await r.fire("before_agent_start", {});
		// the request failed before the context hook ran: no plan was sent
		expect(await r.fire("turn_end", { ...turnEnd([...cold, A("a5")], "a5"), message: { role: "assistant", stopReason: "error", usage: {} } })).toBeUndefined();
		const t = await rig(cold, COLD_TS());
		t.ctx.sessionManager.buildSessionProjection = () => { throw new Error("projection exploded"); };
		await t.fire("before_agent_start", {});
		expect(await t.fire("context_with_system", { messages: flat(cold) })).toBeUndefined();
		expect(await t.fire("turn_end", turnEnd([...cold, A("a5")], "a5"))).toBeUndefined(); // nothing was sent, so nothing is persisted
	});

	test("only re-readable previous-turn outputs are folded (planner and guard agree)", async () => {
		// a previous-turn output that is not re-readable stays: the planner never picks it and the guard would refuse it
		const nonRereadable = cold.map((e) => e);
		const r1 = nonRereadable.find((e) => e.sourceEntry.id === "r2")!;
		(r1.messages[0] as Any).toolName = "write";
		const call = nonRereadable.find((e) => e.sourceEntry.id === "a3")!;
		(call.messages[0] as Any).content[1].name = "write";
		process.env.PI_ZIP_COLD_CAP = "1000";
		const r = await rig(nonRereadable, COLD_TS());
		await r.fire("before_agent_start", {});
		const req = await r.fire("context_with_system", { messages: flat(nonRereadable) });
		const foldedIds = req.messages.filter((m: Any) => m.role === "toolResult" && m.content[0].text.startsWith("[folded")).map((m: Any) => m.toolCallId);
		expect(foldedIds).toEqual(["c1"]); // c2 (write, previous turn) stays: not re-readable
	});

	test("steering messages typed during a run are not new user turns: marked at turn_end, persisted, restored on resume", async () => {
		const withTs = (e: Any, ts: number) => { (e.sourceEntry.message as Any).timestamp = ts; (e.messages[0] as Any).timestamp = ts; return e; };
		const prompt = withTs(U("u3", "back"), 1000);
		const steer = withTs(U("u3s", "also do this"), 2000);
		const entries = [...prevRun, prompt, A("a5", ["c5"]), R("r5", "c5", 300), steer];
		const r = await rig(entries, COLD_TS());
		await r.fire("before_agent_start", {});
		await r.fire("message_end", { message: { role: "user", timestamp: 1000, content: "back" } });
		await r.fire("message_end", { message: { role: "user", timestamp: 2000, content: "also do this" } });
		const all = [...entries, A("a6")];
		const te = await r.fire("turn_end", turnEnd(all, "a6"));
		const marker = te.entries.find((e: Any) => e.customType === "pi-zip/steer");
		expect(marker.data.ids).toEqual(["u3s"]);
		// a new pi started on this session: the markers come back from the branch
		const resumed = await rig(entries, COLD_TS(), { branch: [...branchOf(entries, COLD_TS()), { type: "custom", customType: "pi-zip/steer", data: { ids: ["u3s"] } }] });
		await resumed.fire("session_start", {});
		// ... and the plan counts 3 turns, not 4: the steering message is part of turn 3
		const asTurns = (steerIds?: Set<string>) => planContext(entries, { cwd: ".", promptPending: false, steerIds })!.userTurns;
		expect(asTurns()).toBe(4);
		expect(asTurns(new Set(["u3s"]))).toBe(3);
		const blocks = buildBlocks(entries, new Set(["u3s"]));
		expect(blocks.find((b) => b.entryId === "u3s")!.userTurn).toBe(3);
	});

	test("a steering message does not unprotect or protect the wrong turn: folds are chosen as if it were absent", () => {
		const prompt = U("u3", "back");
		const steer = U("u3s", "also");
		const base = [...prevRun, prompt, A("a5", ["c5"]), R("r5", "c5"), A("a6")];
		const without = planContext(base, { cwd: ".", promptPending: false })!.folds.map((t) => t.entryId);
		const withSteer = planContext([...base, steer, A("a7")], { cwd: ".", promptPending: false, steerIds: new Set(["u3s"]) })!.folds.map((t) => t.entryId);
		expect(withSteer).toEqual(without);
		const counted = planContext([...base, steer, A("a7")], { cwd: ".", promptPending: false })!.folds.map((t) => t.entryId);
		expect(counted).not.toEqual(without); // unmarked, the same message would shift the protected window
	});
});

// =============================================================================================================
describe("coexistence (F14)", () => {
	test("another context manager pauses folding, keeps the guard, and says so once", async () => {
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "back")];
		const other = { getAllTools: () => [{ name: "compress", sourceInfo: { path: "/opt/ext/node_modules/billion-context-pi/index.ts", source: "npm" } }] };
		const r = await rig(entries, COLD_TS(), {}, other);
		await r.fire("session_start", {});
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
		expect(await r.fire("turn_end", turnEnd([...entries, A("a4")], "a4"))).toBeUndefined();
		expect(await r.fire("before_provider_request", { payload: { messages: [{ role: "tool", tool_call_id: "gone", content: "x" }] } })).toBeDefined();
		expect(r.notes).toHaveLength(1);
		expect(r.notes[0]).toContain("billion-context");
		await r.handlers.get("cmd:zip").handler("status", r.ctx);
		expect(r.notes.at(-1)).toContain("paused");
	});
});

// =============================================================================================================
describe("foreign context editors are logged, never acted on (pi-tricks §3.5)", () => {
	test("another extension's context_edit or compaction goes to the ledger once; pi-zip's own entries and Pi's omissions do not; plans are unchanged", async () => {
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "back")];
		const msg = (x: Any) => ({ type: "message", id: x.sourceEntry.id, message: { ...x.sourceEntry.message, timestamp: COLD_TS() } });
		const branch = [
			...entries.map(msg),
			{ type: "context_edit", id: "e-ours", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip · bash ls · handle x]" }] } },
			{ type: "context_edit", id: "e-pi", targetId: "a2", replacement: null }, // Pi's own recovery omission
			{ type: "context_edit", id: "e-other", targetId: "r2", replacement: { content: [{ type: "text", text: "[pruned by another manager]" }] } },
			{ type: "compaction", id: "c-ours", summary: "s", firstKeptEntryId: "u2", fromHook: true, details: { by: "pi-zip" } },
			{ type: "compaction", id: "c-pi", summary: "Pi's own", firstKeptEntryId: "u2", fromHook: false, details: {} },
			{ type: "compaction", id: "c-other", summary: "theirs", firstKeptEntryId: "u2", fromHook: true, details: { by: "bc" } },
		];
		const run = async (ledger?: string) => {
			if (ledger) process.env.PI_ZIP_LEDGER = ledger;
			else delete process.env.PI_ZIP_LEDGER;
			const r = await rig(entries, COLD_TS(), { branch });
			await r.fire("before_agent_start", {});
			const req = await r.fire("context_with_system", { messages: flat(entries) });
			const te = await r.fire("turn_end", turnEnd([...entries, A("a5")], "a5"));
			await r.fire("before_agent_start", {}); // a second run: nothing is logged twice
			return { req, te };
		};
		const ledger = `/tmp/pi-zip-foreign-${process.pid}.jsonl`;
		rmSync(ledger, { force: true });
		const logged = await run(ledger);
		const rows = (await Bun.file(ledger).text()).trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === "foreign_edit");
		expect(rows.map((x: Any) => [x.id, x.kind, x.where])).toEqual([["e-other", "context_edit", "run"], ["c-other", "compaction", "run"]]);
		expect(rows[0]).toMatchObject({ targetId: "r2", head: "[pruned by another manager]" });
		expect(rows[1]).toMatchObject({ by: "bc", firstKeptEntryId: "u2" });
		const silent = await run(undefined);
		expect(JSON.stringify(logged)).toBe(JSON.stringify(silent)); // behaviour unchanged: the same request and the same entries
		rmSync(ledger, { force: true });
	});
});

// =============================================================================================================
describe("in-turn folds through the real extension: one user message, 60 tool calls", () => {
	beforeEach(() => { process.env.PI_ZIP_INTURN_AGE = "20"; }); // the mechanics at age 20 (default 60: a 61-request turn would fold only r1)
	const MUT = [3, 10, 50];
	const session = () => longTurn(60, { mutating: MUT, recalls: [7] });
	const tail = [A("a62", ["c62"]), R("r62", "c62", 300)];
	const expected = Array.from({ length: 41 }, (_, i) => `r${i + 1}`).filter((x) => x !== "r7"); // every class folds at age; never zip_recall
	const ledgerPath = () => `/tmp/pi-zip-inturn-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;

	async function run() {
		process.env.PI_ZIP_COLD_CAP = "8000";
		const entries = session();
		const r = await rig(entries, COLD_TS());
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(entries) });
		const req2 = await r.fire("context_with_system", { messages: [...flat(entries), ...flat(tail)] });
		const all = [...entries, ...tail, A("a63")];
		const te = await r.fire("turn_end", turnEnd(all, "a63", 1));
		return { r, entries, req1, req2, all, te, projected: flat(project(all, te.entries)) };
	}
	const folded = (msgs: Any[]) => msgs.filter((m) => m.role === "toolResult" && String(m.content[0].text).startsWith("[folded by pi-zip")).map((m) => m.toolCallId.replace("c", "r")).sort();

	test("cold return: old outputs of every class fold, recent / zip_recall results stay, the guard accepts and the edits persist", async () => {
		const ledger = ledgerPath();
		process.env.PI_ZIP_LEDGER = ledger;
		const { req1, te } = await run();
		expect(folded(req1.messages)).toEqual([...expected].sort());
		const edits = te.entries.filter((e: Any) => e.type === "context_edit").map((e: Any) => e.targetId).sort();
		expect(edits).toEqual([...expected].sort()); // persisted as context_edit entries
		const rows = (await Bun.file(ledger).text()).trim().split("\n").map((l) => JSON.parse(l));
		expect(rows.filter((x) => x.type === "guard_drop")).toHaveLength(0);
		const fold = rows.find((x) => x.type === "fold");
		expect(fold.count).toBe(expected.length);
		expect(new Set(fold.trigs)).toEqual(new Set(["cold(inturn)"]));
		rmSync(ledger, { force: true });
	});

	test("the fold notice stays in the transcript: a custom entry with its own renderer, not a status line", async () => {
		process.env.PI_ZIP_COLD_CAP = "8000";
		const renderers = new Map<string, Any>();
		const entries = session();
		const r = await rig(entries, COLD_TS(), {}, { registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn) });
		await r.fire("before_agent_start", {});
		await r.fire("context_with_system", { messages: flat(entries) });
		await r.fire("turn_end", turnEnd([...entries, ...tail, A("a63")], "a63", 1));
		await sleep(5);
		const kept = r.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		expect(kept[0].data.text).toMatch(/^pi-zip  zipped \d+ old outputs  [\d.]+K → [\d.]+K  [\d.]+ m?s$/);
		expect(kept[0].data).toMatchObject({ v: 2, first: true });
		expect(kept[0].data.items.length).toBeGreaterThan(0);
		expect(kept[0].data.items[0].handle).toMatch(/^[0-9a-z]{10}$/);
		expect(r.notes).toHaveLength(0); // not also a status line
		const comp = renderers.get("pi-zip/notice")({ data: kept[0].data }, { expanded: false }, { fg: (_c: string, t: string) => t });
		const line = comp.render(30);
		expect(line).toEqual([expect.stringMatching(/^ƶ [\d.]+K → [\d.]+K$/)]); // 30 columns: words, time and the "originals are kept" line drop
		const wide = comp.render(200);
		expect(wide[0]).toMatch(/^ƶ zipped \d+ old outputs   [\d.]+K → [\d.]+K   [\d.]+ m?s$/);
		expect(wide[1]).toContain("originals are kept");
		const ex = renderers.get("pi-zip/notice")({ data: kept[0].data }, { expanded: true }, { fg: (_c: string, t: string) => t }).render(200);
		expect(ex.length).toBeGreaterThan(3);
		expect(ex.join("\n")).toContain(kept[0].data.items[0].handle);
		// a left click toggles the detail (Pi rebuilds the component, so the state is keyed by entry id); ctrl+o still wins
		const th = { fg: (_c: string, t: string) => t };
		const entry = { id: "n1", data: kept[0].data };
		const c1 = renderers.get("pi-zip/notice")(entry, { expanded: false }, th);
		expect(c1.handleMouse({ type: "press", button: "left" })).toBeUndefined();
		expect(c1.handleMouse({ type: "click", button: "left" })).toMatchObject({ handled: true });
		expect(c1.render(200).length).toBe(ex.length);
		expect(renderers.get("pi-zip/notice")(entry, { expanded: false }, th).render(200).length).toBe(ex.length); // survives a rebuild
		expect(renderers.get("pi-zip/notice")(entry, { expanded: true }, th).render(200).length).toBe(ex.length); // ctrl+o: open
		const c2 = renderers.get("pi-zip/notice")(entry, { expanded: true }, th);
		c2.handleMouse({ type: "click", button: "left" });
		expect(c2.render(200)).toEqual(wide);
	});

	test("the notice is in the transcript when the first request carrying the plan goes out (top of the turn), once per plan", async () => {
		process.env.PI_ZIP_COLD_CAP = "8000";
		const entries = session();
		const r = await rig(entries, COLD_TS(), {}, { registerEntryRenderer: () => {} });
		await r.fire("before_agent_start", {});
		await r.fire("context_with_system", { messages: flat(entries) });
		await sleep(5);
		const early = r.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(early.length).toBe(1); // before the model answered
		expect(early[0].data.after).toBeLessThan(early[0].data.before);
		expect(Math.abs(early[0].data.reqTs - Date.now())).toBeLessThan(1_000); // when that request went out: the renderer finds its response by it
		await r.fire("context_with_system", { messages: flat(entries) }); // the run's second request
		await r.fire("turn_end", turnEnd([...entries, ...tail, A("a63")], "a63", 1));
		await sleep(5);
		expect(r.appended.filter((x: Any) => x.customType === "pi-zip/notice").length).toBe(1); // not again at turn_end
	});

	test("an allowlist that hides zip_recall, read, grep and bash: only rereadable outputs fold, placeholders point at re-reading", async () => {
		process.env.PI_ZIP_COLD_CAP = "8000";
		const entries = session();
		const r = await rig(entries, COLD_TS(), {}, { getActiveTools: () => ["edit", "write"] });
		await r.fire("session_start", {});
		await r.fire("before_agent_start", {});
		const req1 = await r.fire("context_with_system", { messages: flat(entries) });
		expect(folded(req1.messages)).toEqual(expected.filter((x) => !["r3", "r10"].includes(x)).sort()); // npm test outputs stay
		const ph = req1.messages.filter((m: Any) => m.role === "toolResult" && String(m.content[0].text).startsWith("[folded by pi-zip")).map((m: Any) => String(m.content[0].text));
		expect(ph.length).toBeGreaterThan(0);
		for (const t of ph) {
			expect(t).toContain("re-read the file");
			expect(t).not.toContain("zip_recall(\"");
		}
	});

	test("the second request repeats the first byte for byte, and so does the persisted projection", async () => {
		const { req1, req2, projected } = await run();
		const n = req1.messages.length;
		expect(JSON.stringify(req2.messages.slice(0, n))).toBe(JSON.stringify(req1.messages));
		expect(JSON.stringify(projected.slice(0, n))).toBe(JSON.stringify(req1.messages));
	});

	test("recall of every in-turn fold is byte-exact", async () => {
		const { r, entries } = await run();
		const tool = r.handlers.get("tool:zip_recall");
		const originals = new Map(entries.filter((e) => e.messages[0].role === "toolResult").map((e) => [e.sourceEntry.id, e.messages[0].content[0].text as string]));
		for (const id of ["r1", "r12", "r41"]) {
			const res = await tool.execute("t", { handle: handleFor(id), limit: 50_000 }, undefined, undefined, r.ctx);
			expect(res.isError).toBe(false);
			expect(res.content[0].text.endsWith(`lines]\n${originals.get(id)}`)).toBe(true);
		}
	});

	test("PI_ZIP_INTURN_AGE=0 restores the old behaviour: the single turn is left alone", async () => {
		process.env.PI_ZIP_INTURN_AGE = "0";
		const entries = session();
		process.env.PI_ZIP_COLD_CAP = "8000";
		const r = await rig(entries, COLD_TS());
		await r.fire("before_agent_start", {});
		expect(await r.fire("context_with_system", { messages: flat(entries) })).toBeUndefined();
	});

	test("the guard: an aged output of any class is a legal target in the latest turn; recent ones are not", () => {
		const b = buildBlocks(session());
		const at = (id: string) => b.findIndex((x) => x.entryId === id);
		const v = (id: string, rec: string | undefined, over: Any = {}) => validateEdits(b, { folds: new Map([[at(id), "[ph]"]]), recover: rec ? new Map([[at(id), rec]]) : undefined, cut: null, ...over }, 1);
		expect(v("r41", "rereadable")).toBeNull(); // age 20
		expect(v("r42", "rereadable")).toMatch(/latest user turn/); // age 19
		expect(v("r41", "nonrereadable")).toBeNull(); // final model: the age rule is class-blind
		expect(v("r41", undefined)).toBeNull();
		expect(v("r42", "nonrereadable")).toMatch(/latest user turn/);
		expect(v("r41", "rereadable", { inturnAge: 0 })).toMatch(/latest user turn/);
		expect(v("r41", "rereadable", { inturnAge: 30 })).toMatch(/latest user turn/);
		expect(v("r30", "rereadable", { inturnAge: 30 })).toBeNull();
	});

	test("random sessions: every fold the planner makes, in-turn ones included, passes the guard", () => {
		for (const seed of SEEDS) {
			const entries = [...randomSession(seed), U("uN", "back")];
			for (const age of [1, 2, 5]) {
				const p = planContext(entries, { cwd: process.cwd(), coldCap: 500, inturnAge: age, promptPending: false })!;
				const byId = new Map(p.blocks.map((x) => [x.entryId, x]));
				const bad = validateEdits(p.blocks, { folds: new Map(p.folds.map((f) => [byId.get(f.entryId)!.idx, f.ph])), recover: new Map(p.folds.map((f) => [byId.get(f.entryId)!.idx, f.recover])), cut: null, inturnAge: age }, p.userTurns);
				expect(bad).toBeNull();
			}
		}
	});
});
