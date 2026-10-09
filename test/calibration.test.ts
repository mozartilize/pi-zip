// Token scale: real = O + c x content, both read from the branch itself (no stored state), used by every limit and every number shown.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { buildBlocks, C0, C_MAX, C_MIN, calibrate, planContext, R0, sizeOf, sysEst, UNIT } from "../src/plan.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, fakeCtx, fakePi, flat, R, U, type Any } from "./helpers.ts";

const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_OFF", "PI_ZIP_LEDGER", "PI_ZIP_MIN_GAIN"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); ENV.forEach((k) => delete process.env[k]); process.env.PI_ZIP_TTL_SECS = "1"; });
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const content = (entries: Any[], upTo?: number) => buildBlocks(entries).slice(0, upTo).reduce((a, b) => a + b.tokens, 0);
const TOOLS = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
/** A system message as Pi writes it into the transcript: prompt sections + the declared tools. */
const SYS = (id: string, text: string, toolsAdded: Any[] = TOOLS) => {
	const m = { role: "system", content: "", sections: { body: text }, toolsAdded, timestamp: 1 };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const at = (e: Any, ts: number) => (Object.assign(e.sourceEntry.message, { timestamp: ts }), e);
/** A provider that follows the affine law exactly: stamp usage real = O + c x (content before the message) on the given assistant entries. */
function provider(entries: Any[], O: number, c: number, ids: string[], read = (real: number) => real - 500) {
	const blocks = buildBlocks(entries);
	for (const id of ids) {
		const i = blocks.findIndex((b) => b.entryId === id);
		const real = Math.round(O + c * blocks.slice(0, i).reduce((a, b) => a + b.tokens, 0));
		Object.assign(blocks[i].raw, { stopReason: "stop", usage: { input: 2, cacheRead: read(real), cacheWrite: real - 2 - read(real), output: 300 } });
	}
	return entries;
}
const session = (rounds = 6, chars = 24_000) => {
	const e: Any[] = [SYS("s0", "x".repeat(8_000)), U("u1", "please look at the logs"), A("a1", ["c1"])];
	for (let i = 1; i <= rounds; i++) e.push(R(`r${i}`, `c${i}`, chars), A(`a${i + 1}`, i < rounds ? [`c${i + 1}`] : []));
	return e;
};
const newest = (e: Any[]) => [...e].reverse().find((x) => x.sourceEntry.message?.role === "assistant").sourceEntry.id;

describe("calibrate: O and c from the branch", () => {
	test("a provider with O = 30K, c = 2.2 is recovered: O from the session's first request, c from the newest response", () => {
		const e = provider(session(), 30_000, 2.2, ["a1", "a7"]);
		const cal = calibrate(e);
		expect(cal.oSource).toBe("first");
		expect(cal.source).toBe("usage");
		const e0 = content(e, 2); // the opening prompt: its content is what C0 is applied to
		expect(cal.O).toBeCloseTo(30_000 + (2.2 - C0) * e0, 0);
		expect(Math.abs(cal.c - 2.2)).toBeLessThan(0.01);
		// the next request (one more output) is predicted within 0.5%, the old single ratio k = real / (system + content), clamped at 2.5, is 10% low
		const next = content(e) + 6_000;
		const truth = 30_000 + 2.2 * next;
		expect(Math.abs(sizeOf(cal, next) / truth - 1)).toBeLessThan(0.005);
		const k = Math.min(cal.real / (2_000 + cal.est), 2.5);
		expect(k * (2_000 + next) / truth).toBeLessThan(0.92);
	});

	test("c is what the provider says: 3.2 (CJK-heavy content) and 0.8 (an efficient tokenizer) are not clamped; only absurd ratios hit [C_MIN, C_MAX]", () => {
		for (const c of [0.8, 3.2]) expect(calibrate(provider(session(), 20_000, c, ["a1", "a7"])).c).toBeCloseTo(c, 1);
		expect(C_MIN).toBeLessThan(0.7);
		expect(C_MAX).toBeGreaterThan(3.5);
		// one response is one equation: it gives O (minus C0 x its small content), and c stays C0
		const one = provider([U("u1", "hi"), A("a1")], 30_000, 2.2, ["a1"]);
		expect(calibrate(one)).toMatchObject({ c: C0, oSource: "first" });
		// a wild jump over a tiny content estimate hits the clamp instead of running away
		const wild = provider([U("u1", "hi"), A("a1"), U("u2", "x".repeat(400)), A("a2")], 30_000, 2.2, ["a1"]);
		Object.assign(wild[3].sourceEntry.message, { stopReason: "stop", usage: { input: 900_000, cacheRead: 0, cacheWrite: 0 } });
		expect(calibrate(wild).c).toBe(C_MAX);
	});

	test("the first request carrying a new summary read exactly O from the cache: that read is O (valve: the first response after the compaction entry)", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k2", ["c1"]), T - 8_000), R("kr", "c1", 30_000), at(A("k3"), T - 7_000), at(U("u2", "next"), T + 1_000), at(A("a1", ["c2"]), T + 2_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 28_656, 2.1, ["k2", "k3"]); // pre-summary responses: full reads
		provider(e, 28_656, 2.1, ["a1"], () => 28_656); // carried the summary: read stopped at the system prompt + tools
		provider(e, 28_656, 2.1, ["a2"]);
		const cal = calibrate(e);
		expect(cal.oSource).toBe("summary");
		expect(cal.O).toBe(28_656);
		expect(cal.c).toBeCloseTo(2.1, 2);
	});

	test("a run plan's summary is carried by the response right before its compaction entry: that response's read is O", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip", trigger: "cold" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k2", ["c1"]), T - 8_000), R("kr", "c1", 30_000), at(U("u2", "back after an hour"), T - 2_000), at(A("a1", ["c2"]), T - 1_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 41_000, 1.9, ["a2"]);
		provider(e, 41_000, 1.9, ["a1"], () => 41_000);
		Object.assign(e[2].sourceEntry.message, { stopReason: "stop", usage: { input: 2, cacheRead: 160_000, cacheWrite: 900, output: 300 } }); // before the summary: the whole old context
		const cal = calibrate(e);
		expect(cal.oSource).toBe("summary");
		expect(cal.O).toBe(41_000);
	});

	test("a cold summary (nothing read) gives no O: the session's first request stands in, measured on the branch", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const first = provider([SYS("s0", "x".repeat(8_000)), U("u0", "start"), at(A("a0"), T - 99_000)], 30_000, 2, ["a0"]);
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("u2", "back"), T + 1_000), at(A("a1", ["c2"]), T + 2_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 30_000, 2, ["a1"], () => 0);
		provider(e, 30_000, 2, ["a2"]);
		const branch = [...first, ...e].map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));
		expect(calibrate(e).oSource).toBe("default"); // the projection alone has no first request any more
		const cal = calibrate(e, undefined, branch);
		expect(cal.oSource).toBe("first");
		expect(Math.abs(cal.O - 30_000)).toBeLessThan(50);
	});

	test("tools added after O was measured move it by R0 x their chars/4; with no usage at all O = R0 x (system prompt + tool JSON)", () => {
		const e = provider(session(), 30_000, 2.2, ["a1", "a7"]);
		const more = [{ name: "mcp_big", description: "d".repeat(8_000), parameters: { type: "object" } }];
		const S1 = sysEst({ text: "x".repeat(8_000), tools: TOOLS }), S2 = sysEst({ text: "x".repeat(8_000), tools: [...TOOLS, ...more] });
		const add = { role: "system", content: "", toolsAdded: more, timestamp: 2 };
		const moved = calibrate([...e.slice(0, 4), { sourceEntry: { id: "s1", type: "message", message: add }, messages: [add] }, ...e.slice(4)]); // a tool added after the first request
		expect(moved.O - calibrate(e).O).toBeCloseTo(R0 * (S2 - S1), 0);
		const none = calibrate([SYS("s0", "x".repeat(8_000)), U("u1", "hi")]);
		expect(none).toMatchObject({ source: "default", oSource: "default", c: C0 });
		expect(none.O).toBeCloseTo(R0 * S1, 6);
		// Pi's API stands in only when the transcript records no system message
		expect(calibrate([U("u1", "hi")], { text: "y".repeat(4_000), tools: TOOLS }).O).toBeCloseTo(R0 * sysEst({ text: "y".repeat(4_000), tools: TOOLS }), 6);
		expect(calibrate([SYS("s0", "x".repeat(8_000)), U("u1", "hi")], { text: "y".repeat(40_000), tools: [] }).O).toBeCloseTo(R0 * S1, 6);
	});

	test("a valve fold persisted after the newest response (its read shows an intact prefix) is counted with its original; a run plan's carried fold is not", () => {
		const e = provider(session(), 30_000, 2.2, ["a1", "a6", "a7"]);
		const fresh = calibrate(e);
		const ph = "[folded by pi-zip · bash ls]\nkey line\nFull original is saved: call zip_recall(\"h\")";
		const fold = (x: Any[]) => x.map((pe) => (pe.sourceEntry.id === "r2" ? { sourceEntry: pe.sourceEntry, messages: [{ ...pe.messages[0], content: [{ type: "text", text: ph }] }] } : pe));
		const valve = [...fold(e), { sourceEntry: { id: "ed", type: "context_edit", targetId: "r2" }, messages: [] }];
		expect(calibrate(valve).c).toBeCloseTo(fresh.c, 6); // not inflated by the placeholder the request never carried
		// the same fold carried by the newest request (a run plan: its read stopped at the untouched head)
		const carried = provider(fold(e), 30_000, 2.2, ["a7"], () => 31_000);
		const run = calibrate([...carried, { sourceEntry: { id: "ed", type: "context_edit", targetId: "r2" }, messages: [] }]);
		expect(run.c).toBeCloseTo(2.2, 1);
		expect(run.est).toBe(content(carried, carried.length - 1));
	});

	test("Pi's own compaction after the newest response (never request-local): that response carried text now summarised away, so c is C0 until the next one", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: {} }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k2"), T - 8_000)];
		provider(e, 30_000, 2.2, ["k2"], () => 0);
		expect(calibrate(e)).toMatchObject({ c: C0, source: "default" });
	});
});

describe("calibrate: per model, Pi's compaction, dropped responses", () => {
	const as = (e: Any[], ids: string[], provider: string, model: string) => {
		for (const x of e) if (ids.includes(x.sourceEntry.id)) Object.assign(x.sourceEntry.message, { provider, model });
		return e;
	};
	const GLM = "zai/glm-like", CLA = "anthropic/claude-like";
	const switched = () => {
		const e = session(8);
		provider(e, 15_000, 1.0, ["a1", "a2", "a3", "a4"]);
		as(e, ["a1", "a2", "a3", "a4"], "zai", "glm-like");
		provider(e, 30_000, 1.9, ["a5", "a6", "a7", "a8", "a9"]);
		return as(e, ["a5", "a6", "a7", "a8", "a9"], "anthropic", "claude-like");
	};

	test("a model switch: only the current model's responses are evidence; the size after a deep fold stays within 5% (one scale for both: -25%)", () => {
		const e = switched();
		const branch = e.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));
		for (const cal of [calibrate(e), calibrate(e, undefined, branch), calibrate(e, undefined, branch, CLA)]) {
			expect(cal.oSource).toBe("model"); // the first Claude response is no opening request: O comes from the GLM O in content units
			for (const keep of [0.5, 0.2, 0.1]) {
				const E = keep * content(e);
				expect(Math.abs(sizeOf(cal, E) / (30_000 + 1.9 * E) - 1)).toBeLessThan(0.05);
			}
		}
		// the old model on its own is still read exactly (its first request is an opening one)
		const glm = calibrate(e, undefined, branch, GLM);
		expect(glm.oSource).toBe("first");
		expect(Math.abs(glm.O - 15_000)).toBeLessThan(100);
		expect(glm.c).toBeCloseTo(1.0, 2);
		// right after the switch, before any response of the new model: nothing of the old one carries over
		const before = e.slice(0, e.findIndex((x) => x.sourceEntry.id === "a5"));
		expect(calibrate(before, undefined, [], CLA)).toMatchObject({ c: C0, source: "default", oSource: "default" });
		expect(calibrate(before, undefined, [], CLA).O).toBeCloseTo(R0 * sysEst({ text: "x".repeat(8_000), tools: TOOLS }), 6);
	});

	test("the session's first request counts for O only if it went to the current model", () => {
		const e = switched();
		const branch = e.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));
		// a Claude session that opened on Claude: O from its own first request
		const own = provider(session(8), 30_000, 1.9, ["a1", "a9"]);
		as(own, ["a1", "a9"], "anthropic", "claude-like");
		expect(calibrate(own, undefined, own.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), CLA).oSource).toBe("first");
		expect(calibrate(e, undefined, branch, CLA).oSource).not.toBe("first");
	});

	test("Pi's own compaction: only the first response after its entry can have carried it (the one before read a pi-zip valve fold, 60K)", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: {} }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k0", ["c0"]), T - 8_500), R("k0r", "c0", 200_000), at(A("k2", ["c1"]), T - 8_000), R("kr", "c1", 30_000), at(A("k3"), T - 7_000), at(U("u2", "next"), T + 1_000), at(A("a1", ["c2"]), T + 2_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 30_000, 2.1, ["k0", "k2"]);
		provider(e, 30_000, 2.1, ["k3"], () => 60_000); // a valve fold of pi-zip: the read stopped at the folded output
		provider(e, 30_000, 2.1, ["a1"], () => 30_000); // carried Pi's summary: the read stopped at the system prompt + tools
		provider(e, 30_000, 2.1, ["a2"]);
		const cal = calibrate(e);
		expect(cal.oSource).toBe("summary");
		expect(cal.O).toBe(30_000);
		expect(cal.c).toBeCloseTo(2.1, 2);
	});

	test("/zip folded total: each fold on the scale of the model that made it, not today's c for all", async () => {
		const { Zip } = await import("../src/run.ts");
		const e = [SYS("s0", "x".repeat(8_000)), U("u1", "one"), A("a1", ["c1"]), R("ra", "c1", 40_000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("rb", "c2", 40_000), A("a4")];
		provider(e, 15_000, 1, ["a1", "a2"]);
		as(e, ["a1", "a2"], "zai", "glm-like");
		provider(e, 30_000, 2, ["a3", "a4"]);
		as(e, ["a3", "a4"], "anthropic", "claude-like");
		const ph = (id: string) => ({ type: "context_edit", targetId: id, replacement: { content: [{ type: "text", text: `[folded by pi-zip · bash ls · handle ${id}]` }] } });
		const msg = (x: Any) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message });
		const branch = [...e.slice(0, 5).map(msg), ph("ra"), ...e.slice(5).map(msg), ph("rb")];
		const { ctx } = fakeCtx(e, { branch, model: { provider: "anthropic", id: "claude-like", contextWindow: 1_000_000 } });
		const m = /(\d+(?:\.\d+)?)K tokens/.exec(new Zip(fakePi().pi).statsLine(ctx));
		expect(Number(m![1])).toBeGreaterThan(28); // ~10K chars/4 x 1 (GLM) + ~10K x 2 (Claude) = ~30K; one c for both: ~40K
		expect(Number(m![1])).toBeLessThan(32);
	});

	test("an aborted or errored assistant message (pi-ai drops it before sending) adds nothing to the content estimate", () => {
		const ok = session(4);
		const withAbort = session(4);
		const i = withAbort.findIndex((x) => x.sourceEntry.id === "a3");
		const ab = A("ab", ["cx", "cy"]);
		Object.assign(ab.sourceEntry.message, { stopReason: "aborted", content: [...ab.sourceEntry.message.content, { type: "text", text: "partial ".repeat(2_000) }] });
		withAbort.splice(i, 0, ab);
		expect(buildBlocks(withAbort).find((b) => b.entryId === "ab")!.tokens).toBe(0);
		expect(content(withAbort)).toBe(content(ok));
		provider(ok, 20_000, 2, ["a1", "a5"]);
		provider(withAbort, 20_000, 2, ["a1", "a5"]);
		expect(calibrate(withAbort).c).toBeCloseTo(calibrate(ok).c, 6);
	});
});

describe("every limit and every number on the right scale", () => {
	const turns = (n: number, chars: number) => Array.from({ length: n }, (_, t) => [U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, chars), A(`z${t}`)]).flat();

	test("the cold cap is on content above O: 30K of content is under a 40K cap however large O is, 41K of content is over it", () => {
		const model = { provider: "p", id: "m", contextWindow: 1_000_000 };
		const law = { pr: lawPrices("explicit", false), g: 2_500, pWarm: 0 }; // P = 0: the law always fires, only the cap decides
		const warm = (entries: Any[], O: number) => planContext(entries, { mode: "warm", cwd: ".", promptPending: false, model, coldCap: 40_000, law, scale: { ...UNIT, O, c: 1 } });
		for (const O of [0, 50_000, 500_000]) expect(warm([...turns(3, 40_000), U("uN", "now")], O)).toBeNull(); // the old total rule: over the cap for O >= 10K
		const over = warm([...turns(4, 41_000), U("uN", "now")], 50_000)!;
		expect(over).not.toBeNull();
		expect(over.ctxTokens).toBeGreaterThan(50_000 + 41_000);
		// a cold return relaxes into the previous turn's re-readable outputs only down to the cap ON CONTENT (O + 40K), never towards a 40K
		// total it cannot reach (the total rule would fold all six and then summarise)
		const prev: Any[] = [U("u1", "one"), A("a1"), U("u2", "prev")];
		for (let i = 1; i <= 6; i++) prev.push(A(`p${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 40_000));
		prev.push(A("pe"), U("u3", "now"));
		const cold = planContext(prev, { mode: "cold", cwd: ".", promptPending: false, model, coldCap: 40_000, scale: { ...UNIT, O: 50_000, c: 1 } })!;
		expect(cold.cutIdx).toBeNull();
		expect(cold.folds.length).toBeGreaterThanOrEqual(2);
		expect(cold.folds.length).toBeLessThanOrEqual(3);
		expect(cold.ctxAfterFolds).toBeLessThanOrEqual(50_000 + 40_000);
		expect(cold.ctxAfterFolds).toBeGreaterThan(50_000 + 25_000);
	});

	test("the compaction room is Pi's trigger on the whole context: O counts toward it", () => {
		const model = { provider: "p", id: "m", contextWindow: 200_000 }; // room = 200000 - 16384 - 8192 = 175424
		const view = [U("u0", "q"), AX("x0", 200_000), U("u1", "q"), AX("x1", 200_000), U("u9", "next"), A("a9"), U("uN", "now")]; // ~100K of prose no fold can touch
		const plan = (O: number) => planContext(view, { mode: "warm", cwd: ".", promptPending: false, model, coldCap: 40_000, noSummary: true, scale: { ...UNIT, O, c: 1 } });
		expect(plan(0)?.cutIdx ?? null).toBeNull(); // below the room: one summary per warm stretch holds
		expect(plan(80_000)!.cutIdx).not.toBeNull(); // the same content with 80K of system and tools is past Pi's trigger: the summary is allowed
	});

	test("restart: a fresh process reads the same scale from the branch and makes the same plan", async () => {
		const ledger = `/tmp/pi-zip-test-calibration-restart-${process.pid}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		try { unlinkSync(ledger); } catch {}
		const prev = provider([SYS("s0", "x".repeat(8_000)), ...turns(6, 30_000)], 30_000, 2.2, ["a0", "z5"]);
		const all = [...prev, U("uN", "back after the idle")];
		const branch = [...all.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { default: piZip } = await import("../src/index.ts");
		for (let i = 0; i < 2; i++) {
			const f = fakePi();
			piZip(f.pi); // a new Zip each time: nothing from the first one exists in memory
			const { ctx } = fakeCtx(all, { branch });
			await f.handlers.get("before_agent_start")({}, ctx);
			await f.handlers.get("context_with_system")({ messages: flat(all) }, ctx);
		}
		const plans = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l: Any) => l.type === "cold_plan");
		unlinkSync(ledger);
		expect(plans).toHaveLength(2);
		const strip = (p: Any) => ({ ...p, ts: 0, pid: 0, ms: 0 });
		expect(strip(plans[1])).toEqual(strip(plans[0]));
		expect(plans[0]).toMatchObject({ oSource: "first", calSource: "usage" });
		expect(Math.abs(plans[0].c - 2.2)).toBeLessThan(0.02);
	});

	test("notice = plan = provider: with a provider that follows the affine law, the run-plan notice's after is the real size of the request that carried it", async () => {
		const prev = provider([SYS("s0", "x".repeat(8_000)), ...turns(6, 30_000)], 52_000, 2.1, ["a0", "z5"]);
		const all = [...prev, U("uN", "back after the idle")];
		const branch = [...all.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi({ registerEntryRenderer: () => {} });
		piZip(f.pi);
		const { ctx } = fakeCtx(all, { branch });
		await f.handlers.get("before_agent_start")({}, ctx);
		const req = await f.handlers.get("context_with_system")({ messages: flat(all) }, ctx);
		await new Promise((r) => setTimeout(r, 5));
		const notice = f.appended.find((x: Any) => x.customType === "pi-zip/notice")!.data;
		// what the provider would bill for the request as sent: O + c x the content of the folded view
		const sent = req.messages.filter((m: Any) => m.role !== "system");
		const real = 52_000 + 2.1 * sent.reduce((a: number, m: Any) => a + buildBlocks([{ sourceEntry: { type: "message", message: m }, messages: [m] }])[0].tokens, 0);
		expect(Math.abs(notice.after / real - 1)).toBeLessThan(0.01);
		expect(Math.abs(notice.before / (52_000 + 2.1 * content(all)) - 1)).toBeLessThan(0.01);
		// the content above O is at the cap, not the whole context
		expect(notice.after - 52_000).toBeLessThanOrEqual(40_000 + 100);
		for (const it of notice.items) expect(it.tokens).toBeGreaterThan(2.1 * 7_000); // an output's own size on the provider's scale
	});
});

describe("regression (fresh process, print mode): the last usage says ~88K real while chars/4 says ~51K", () => {
	const entries = () => {
		const e: Any[] = [U("u1", "one"), A("a1", ["c0"]), R("r0", "c0", 16_000), A("a1e"), U("u2", "two")];
		for (let i = 1; i <= 8; i++) e.push(A(`a2_${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 24_000));
		e.push(A("a2e"), U("u3", "back after the idle"));
		return e;
	};
	const REAL = 88_000;
	const ledger = `/tmp/pi-zip-test-calibration-${process.pid}.jsonl`;

	async function coldReturn(all: Any[]) {
		process.env.PI_ZIP_LEDGER = ledger;
		try { unlinkSync(ledger); } catch {}
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi();
		piZip(f.pi);
		const branch = [...all.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { ctx } = fakeCtx(all, { branch });
		await f.handlers.get("before_agent_start")({}, ctx);
		const req = await f.handlers.get("context_with_system")({ messages: flat(all) }, ctx);
		const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		unlinkSync(ledger);
		return { req, plan: lines.find((l: Any) => l.type === "cold_plan") };
	}

	test("the plan folds the content down to <= 40K real, where the uncalibrated estimate (c = 1) would have stopped far above it", async () => {
		const all = entries();
		const last = all.find((x) => x.sourceEntry.id === "a2e")!;
		const view = content(all, all.findIndex((x) => x.sourceEntry.id === "a2e"));
		expect(view).toBeGreaterThan(48_000);
		expect(view).toBeLessThan(55_000);
		Object.assign(last.sourceEntry.message, { stopReason: "stop", usage: { input: 2_000, cacheRead: 80_000, cacheWrite: REAL - 82_000, output: 300 } });
		const { req, plan } = await coldReturn(all);
		expect(plan.source).toBe("runstart");
		expect(plan.calSource).toBe("usage");
		expect(plan.calReal).toBe(REAL);
		expect(plan.c).toBeGreaterThan(1.6);
		expect(plan.c).toBeLessThan(1.8);
		expect(plan.ctxBefore).toBeGreaterThan(REAL - 1_000); // real: the whole view incl. the new prompt
		expect(plan.ctxAfter - plan.O).toBeLessThanOrEqual(40_000);
		expect(plan.folds).toBeGreaterThanOrEqual(4);
		expect(req.messages.filter((m: Any) => m.role === "toolResult" && m.content[0].text.startsWith("[folded by pi-zip")).length).toBe(plan.folds);
		const old = planContext(all, { cwd: process.cwd(), promptPending: false })!; // UNIT: sizes taken as real
		expect(1.7 * old.ctxAfterFolds).toBeGreaterThan(40_000);
		expect(old.folds.length).toBeLessThan(plan.folds);
	});

	test("without usage in the branch: c = C0 and O = R0 x the system prompt (nothing else is known)", async () => {
		const { plan } = await coldReturn(entries());
		expect(plan.calSource).toBe("default");
		expect(plan.c).toBe(C0);
		expect(plan.calReal).toBe(0);
		expect(plan.ctxAfter - plan.O).toBeLessThanOrEqual(40_000);
	});
});

describe("stats and notices use the plan's scale", () => {
	test("the fold ledger line carries O and c and real sizes: ctxBefore = O + c x content", async () => {
		const ledger = `/tmp/pi-zip-test-calibration-fold-${process.pid}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
		try { unlinkSync(ledger); } catch {}
		const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 20_000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
		const cold = provider([...prevRun, U("u3", "back after the idle")], 0, 2, ["a4"]);
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi();
		piZip(f.pi);
		const branch = [...cold.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { ctx, notes } = fakeCtx(cold, { branch });
		await f.handlers.get("before_agent_start")({}, ctx);
		await f.handlers.get("context_with_system")({ messages: flat(cold) }, ctx);
		const all = [...cold, A("a5")];
		await f.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop", usage: { input: 1, cacheRead: 0, cacheWrite: 0 } }, messageEntryId: "a5", context: { contextEntries: all }, entries: [], turnIndex: 0 }, ctx);
		const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		unlinkSync(ledger);
		const plan = lines.find((l: Any) => l.type === "cold_plan");
		const fold = lines.find((l: Any) => l.type === "fold");
		expect(fold.c).toBe(plan.c);
		expect(fold.O).toBe(plan.O);
		expect(Math.abs(fold.ctxBefore / (fold.O + fold.c * content(all)) - 1)).toBeLessThan(0.001); // the ledger rounds O and c
		expect(Math.abs(fold.entryTokensBefore - fold.c * buildBlocks(all).find((b) => b.entryId === "r1")!.tokens)).toBeLessThanOrEqual(2);
		expect(fold.ctxAfter).toBe(fold.ctxBefore - (fold.entryTokensBefore - fold.entryTokensAfter));
		expect(notes).toHaveLength(1);
	});
});
