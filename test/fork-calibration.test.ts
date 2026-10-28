// Fork planner suite: upstream's test/calibration.test.ts run against src/plan-fork.ts, plus fork-only cases.
// Token scale: real = O + c x content, both read from the branch itself (no stored state), used by every limit and every number shown.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { buildBlocks, C0, C_MAX, C_MIN, calibrate, coldTarget, R0, sameTokenizer, sizeOf, sysEst, UNIT } from "../src/plan.ts";
import { planContext } from "../src/plan-fork.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, fakeCtx, fakePi, flat, R, startPrompt, U, type Any } from "./helpers.ts";

const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_OFF", "PI_ZIP_LEDGER"];
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

	test("a boundary summary measures O only from a response after the compaction entry", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip", trigger: "cold" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k2", ["c1"]), T - 8_000), R("kr", "c1", 30_000), at(U("u2", "back after an hour"), T - 2_000), at(A("a1", ["c2"]), T - 1_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 41_000, 1.9, ["a2"]);
		provider(e, 41_000, 1.9, ["a1"], () => 41_000);
		Object.assign(e[2].sourceEntry.message, { stopReason: "stop", usage: { input: 2, cacheRead: 160_000, cacheWrite: 900, output: 300 } }); // before the summary: the whole old context
		const cal = calibrate(e);
		expect(cal.oSource).toBe("default");
		expect(cal.O).toBe(0);
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

	// N6: a cold return right after a switch used O = R0 x system and c = C0 (1.5) although the session had measured c = 1.9; every
	// believed size was 20% off, and the 126K-context summary that "removed 7K" was judged against a floor in the real scale
	test("a switch to a model of the SAME provider, before its first response: the session's measured O and c carry over (another provider: the defaults)", () => {
		const e = session(8);
		provider(e, 30_000, 1.9, ["a1", "a2", "a3", "a4", "a5"]);
		as(e, ["a1", "a2", "a3", "a4", "a5"], "anthropic", "opus-like");
		const branch = e.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));
		const sameProvider = calibrate(e, undefined, branch, "anthropic/sonnet-like");
		expect(sameProvider.c).toBeCloseTo(1.9, 1);
		expect(Math.abs(sameProvider.O - 30_000)).toBeLessThan(300);
		expect(sameProvider.oSource).toBe("model");
		for (const keep of [1, 0.5, 0.2]) expect(Math.abs(sizeOf(sameProvider, keep * content(e)) / (30_000 + 1.9 * keep * content(e)) - 1)).toBeLessThan(0.02);
		const other = calibrate(e, undefined, branch, "zai/glm-like");
		expect(other).toMatchObject({ c: C0, source: "default", oSource: "default" });
		// the previous model's scale follows the system prompt: a tool set that changed moves O as it moves the model's own
		const moved = calibrate([...e.slice(0, 4), { sourceEntry: { id: "s1", type: "message", message: { role: "system", content: "", toolsAdded: [{ name: "t2", description: "x".repeat(4_000), parameters: {} }], timestamp: 2 } }, messages: [{ role: "system", content: "", toolsAdded: [{ name: "t2", description: "x".repeat(4_000), parameters: {} }], timestamp: 2 }] }, ...e.slice(4)], undefined, branch, "anthropic/sonnet-like");
		expect(moved.c).toBeCloseTo(1.9, 0);
	});

	// review P1-3: "same provider" is not "same tokenizer" on a multi-vendor provider (github-copilot serves GPT, Claude, Gemini and Grok;
	// openrouter, gateways). A GPT -> Claude switch there carried c ~ 0.9 where Claude's is ~ 1.7: every size believed at half its value
	test("a multi-vendor provider: the scale carries over only within one model family (GPT -> Claude falls back to the defaults)", () => {
		const e = session(8);
		provider(e, 30_000, 0.9, ["a1", "a2", "a3", "a4", "a5"]);
		as(e, ["a1", "a2", "a3", "a4", "a5"], "github-copilot", "gpt-5");
		const branch = e.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));
		expect(calibrate(e, undefined, branch, "github-copilot/claude-sonnet-4.5")).toMatchObject({ c: C0, source: "default", oSource: "default" }); // old code: c 0.9, oSource "model"
		expect(calibrate(e, undefined, branch, "openrouter/anthropic/claude-sonnet-4.5")).toMatchObject({ c: C0, source: "default" }); // another provider
		const gpt = calibrate(e, undefined, branch, "github-copilot/gpt-5-mini"); // the same family on the same provider: carried
		expect(gpt.c).toBeCloseTo(0.9, 1);
		expect(gpt.oSource).toBe("model");
		// unrecognised ids on a multi-vendor provider are not guessed
		as(e, ["a1", "a2", "a3", "a4", "a5"], "openrouter", "acme/model-x");
		expect(calibrate(e, undefined, branch.map((b) => ({ ...b, message: e.find((x) => x.sourceEntry.id === b.id)!.sourceEntry.message })), "openrouter/acme/model-y")).toMatchObject({ c: C0, source: "default" });
		expect(sameTokenizer("anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5")).toBe(true);
		expect(sameTokenizer("github-copilot/claude-sonnet-4", "github-copilot/gpt-5")).toBe(false);
		expect(sameTokenizer("openrouter/anthropic/claude-opus-4", "openrouter/anthropic/claude-sonnet-4")).toBe(true);
		expect(sameTokenizer("openrouter/openai/gpt-5", "openrouter/z-ai/glm-4.6")).toBe(false);
		expect(sameTokenizer("mistral/mistral-large", "mistral/glm-4.6")).toBe(false); // mistral's catalog lists GLM models too
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

	test("a pi-zip summary that went in through Pi's compaction (via native) is carried after its entry, like Pi's own: the response before it is not O", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip", via: "native", trigger: "cold" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k0", ["c0"]), T - 8_500), R("k0r", "c0", 200_000), at(A("k2", ["c1"]), T - 8_000), R("kr", "c1", 30_000), at(A("k3"), T - 7_000), at(U("u2", "next"), T + 1_000), at(A("a1", ["c2"]), T + 2_000), R("r2", "c2", 40_000), at(A("a2"), T + 3_000)];
		provider(e, 30_000, 2.1, ["k0", "k2"]);
		provider(e, 30_000, 2.1, ["k3"], () => 60_000); // before the user went away: a read that stopped at a valve fold
		provider(e, 30_000, 2.1, ["a1"], () => 30_000); // the run's first request carried the summary: the read stopped at the system prompt + tools
		provider(e, 30_000, 2.1, ["a2"]);
		const cal = calibrate(e);
		expect(cal.oSource).toBe("summary");
		expect(cal.O).toBe(30_000); // a request-local pi-zip summary would have taken k3's 60K read
		expect(cal.c).toBeCloseTo(2.1, 2);
	});

	test("a native pi-zip compaction after the newest response: that response's content is summarised away, so c is C0 until the next one (as for Pi's own)", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const comp = { sourceEntry: { id: "cmp", type: "compaction", timestamp: new Date(T).toISOString(), details: { by: "pi-zip", via: "native" } }, messages: [{ role: "compactionSummary", summary: "s".repeat(20_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, at(U("k1", "kept"), T - 9_000), at(A("k2"), T - 8_000)];
		provider(e, 30_000, 2.2, ["k2"], () => 0);
		expect(calibrate(e)).toMatchObject({ c: C0, source: "default" });
		// A draft summary also enters after the response; neither door uses its usage as post-summary evidence.
		const local = [{ ...comp, sourceEntry: { ...comp.sourceEntry, details: { by: "pi-zip" } } }, ...e.slice(1)];
		expect(calibrate(local)).toMatchObject({ c: C0, source: "default" });
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

	test("the cold target is the whole context while O is small and O + half the cap once O is large: never inside O, never 40K of conversation on top of it", () => {
		expect(coldTarget(40_000, 0, null)).toBe(40_000);
		expect(coldTarget(40_000, 3_000, null)).toBe(40_000); // a bare Pi: the cap as tuned, on the whole context
		expect(coldTarget(40_000, 20_000, null)).toBe(40_000); // the kink: O is half the cap
		expect(coldTarget(40_000, 36_000, null)).toBe(56_000); // a 36K prefix: 20K of conversation (0.2.9 left 4K, the cap on content 40K)
		expect(coldTarget(40_000, 52_000, null)).toBe(72_000); // O above the cap: 0.2.9's target lay inside O, out of reach
		expect(coldTarget(60_000, 52_000, null)).toBe(82_000); // PI_ZIP_COLD_CAP scales both parts
		expect(coldTarget(40_000, 52_000, 60_000)).toBe(60_000); // never above Pi's compaction room
	});

	test("a warm plan is considered only above the target: with a small O the whole context counts, with a large O half the cap of conversation", () => {
		const model = { provider: "p", id: "m", contextWindow: 1_000_000 };
		const law = { pr: lawPrices("explicit", false), g: 2_500, pWarm: 0 }; // P = 0: the law always fires, only the cap decides
		const warm = (entries: Any[], O: number) => planContext(entries, { cwd: ".", promptPending: false, model, coldCap: 40_000, law, scale: { ...UNIT, O, c: 1 } });
		const view = (chars: number) => [...turns(3, chars), U("uN", "now")];
		const [v15, v25, v35, v38] = [19_500, 32_800, 46_000, 50_500].map(view);
		for (const [v, lo, hi] of [[v15, 14_000, 16_000], [v25, 24_000, 26_000], [v35, 34_000, 36_000], [v38, 37_500, 39_000]] as const) {
			expect(content(v)).toBeGreaterThan(lo);
			expect(content(v)).toBeLessThan(hi);
		}
		// O = 3K: 38K of conversation is a 41K context, over the 40K cap (the cap on content let it grow to 43K); 35K (38K in all) is under
		expect(warm(v38, 3_000)).not.toBeNull();
		expect(warm(v35, 3_000)).toBeNull();
		// a large O: 15K of conversation is under O + 20K however large O is (0.2.9: over a 40K it could never reach), 25K is over it
		// (the cap on content kept up to 40K of conversation on top of O)
		for (const O of [50_000, 500_000]) {
			expect(warm(v15, O)).toBeNull();
			expect(warm(v25, O)).not.toBeNull();
		}
	});

	test("a cold return with a large O relaxes into the previous turn only down to O + half the cap: not to O + 40K, not towards a 40K it cannot reach", () => {
		const model = { provider: "p", id: "m", contextWindow: 1_000_000 };
		const prev: Any[] = [U("u1", "one"), A("a1"), U("u2", "prev")];
		for (let i = 1; i <= 6; i++) prev.push(A(`p${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 40_000));
		prev.push(A("pe"), U("u3", "now"));
		const out = buildBlocks(prev).find((b) => b.entryId === "r1")!.tokens;
		expect(content(prev)).toBeGreaterThan(6 * out); // six re-readable outputs of the previous turn, ~10K each
		const cold = planContext(prev, { pause: true, cwd: ".", promptPending: false, model, coldCap: 40_000, scale: { ...UNIT, O: 50_000, c: 1 } })!;
		expect(cold.cutIdx).toBeNull(); // the target is reachable by folding: no summary
		expect(cold.folds.length).toBe(5); // the cap on content folded 3 (stopping at O + 40K), 0.2.9's 40K total all 6
		expect(cold.ctxAfterFolds).toBeLessThanOrEqual(50_000 + 20_000);
		expect(cold.ctxAfterFolds).toBeGreaterThan(50_000 + 20_000 - out); // it stops as soon as it is under
		// with a small O the same view is planned against the whole-context cap, as before the affine scale
		const small = planContext(prev, { pause: true, cwd: ".", promptPending: false, model, coldCap: 40_000, scale: { ...UNIT, O: 3_000, c: 1 } })!;
		expect(small.ctxAfterFolds).toBeLessThanOrEqual(40_000);
		expect(small.ctxAfterFolds).toBeGreaterThan(40_000 - out);
	});

	test("the compaction room is Pi's trigger on the whole context: O counts toward it", () => {
		const model = { provider: "p", id: "m", contextWindow: 200_000 }; // room = 200000 - 16384 - 8192 = 175424
		const view = [U("u0", "q"), AX("x0", 200_000), U("u1", "q"), AX("x1", 200_000), U("u9", "next"), A("a9"), U("uN", "now")]; // ~100K of prose no fold can touch
		const plan = (O: number) => planContext(view, { cwd: ".", promptPending: false, model, coldCap: 40_000, law: { pr: lawPrices("explicit", false), g: 500, pWarm: 1 }, scale: { ...UNIT, O, c: 1 } });
		expect(plan(0)).toBeNull(); // O = 0 leaves the 100K view below both the 175,424 room and its 80% summary threshold
		expect(plan(50_000)!.atRoom).toBeUndefined(); // O = 50K puts the view at 150K: summary-eligible (>= 140,339), still below the room
		expect(plan(80_000)!.atRoom).toBe(true); // system and tools count toward Pi's trigger
		expect(plan(80_000)!.cutIdx).not.toBeNull();
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
			await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
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
		await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
		const req = await f.handlers.get("context_with_system")({ messages: flat(all) }, ctx);
		await f.handlers.get("turn_end")({ entries: [], turnIndex: 1, message: { role: "assistant", usage: {} }, context: { contextEntries: all } }, ctx);
		await new Promise((r) => setTimeout(r, 5));
		const notice = f.appended.find((x: Any) => x.customType === "pi-zip/notice")!.data;
		// what the provider would bill for the request as sent: O + c x the content of the folded view
		const sent = req.messages.filter((m: Any) => m.role !== "system");
		const real = 52_000 + 2.1 * sent.reduce((a: number, m: Any) => a + buildBlocks([{ sourceEntry: { type: "message", message: m }, messages: [m] }])[0].tokens, 0);
		expect(Math.abs(notice.after / real - 1)).toBeLessThan(0.01);
		expect(Math.abs(notice.before / (52_000 + 2.1 * content(all)) - 1)).toBeLessThan(0.01);
		// O is above half the cap: the target is O + 20K of conversation (not a 40K total inside O, not 40K of conversation on top of it)
		expect(notice.after - 52_000).toBeLessThanOrEqual(20_000 + 100);
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
		await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
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
		process.env.PI_ZIP_COLD_CAP = "8000"; // a small session: a working view it is above, so the cold return folds r1 (and only r1)
		try { unlinkSync(ledger); } catch {}
		const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 20_000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];
		const cold = provider([...prevRun, U("u3", "back after the idle")], 0, 2, ["a4"]);
		const { default: piZip } = await import("../src/index.ts");
		const f = fakePi();
		piZip(f.pi);
		const branch = [...cold.map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message })), { type: "message", id: "ts", message: { role: "assistant", timestamp: Date.now() - 60_000, content: [] } }];
		const { ctx, notes } = fakeCtx(cold, { branch });
		await startPrompt((n, e) => f.handlers.get(n)(e, ctx));
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

// formal/TRIAGE.md (a) 4 (N1) and (a) 9 (TR): what the calibration takes from a response must be what that response's request carried
describe("calibrate: the request behind a response (compactions, who carried which edit, a model switch)", () => {
	const mark = (id: string, carried: boolean) => ({ sourceEntry: { id, type: "custom", customType: "pi-zip/commit", data: { carried } }, messages: [] });
	const PH = "[folded by pi-zip · bash ls]\nkey line\nFull original is saved: call zip_recall(\"h\")";
	const edit = (id: string, target: string, text = PH) => ({ sourceEntry: { id, type: "context_edit", targetId: target, replacement: { content: [{ type: "text", text }] } }, messages: [] });
	const folded = (x: Any[], target: string, text = PH) => x.map((pe) => (pe.sourceEntry.id === target ? { sourceEntry: pe.sourceEntry, messages: [{ ...pe.messages[0], content: [{ type: "text", text }] }] } : pe));
	const asBranch = (e: Any[]) => e.filter((x) => x.sourceEntry.message).map((x) => ({ type: "message", id: x.sourceEntry.id, message: x.sourceEntry.message }));

	test("N1: Pi's (or another extension's) compaction written after the newest response: c is what that response's request measured, not C0 (the plan after it used 1.5 for a c of 1.0)", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const raw = session(6, 40_000);
		provider(raw, 30_000, 2.2, ["a1", "a7"]); // a7 carried the whole pre-compaction context
		for (const x of raw) Object.assign(x.sourceEntry.message, { timestamp: T - 1_000 });
		const branch = asBranch(raw);
		branch.push({ type: "compaction", id: "cmp", summary: "s".repeat(8_000), firstKeptEntryId: "r5", timestamp: new Date(T).toISOString(), details: {} } as Any);
		const comp = { sourceEntry: branch[branch.length - 1], messages: [{ role: "compactionSummary", summary: "s".repeat(8_000), tokensBefore: 0, timestamp: T }] };
		const e = [comp, ...raw.slice(raw.findIndex((x) => x.sourceEntry.id === "r5"))]; // Pi keeps from r5 on: the response a7 is in the kept part, its request is not
		const cal = calibrate(e, undefined, branch);
		expect(cal.c).toBeCloseTo(2.2, 1);
		expect(cal).toMatchObject({ source: "usage", real: 30_000 + Math.round(2.2 * content(raw, raw.length - 1)) });
		expect(cal.est).toBe(content(raw, raw.length - 1)); // the content its request carried: all of it, before the compaction
		expect(cal.O).toBeCloseTo(30_000, -2);
		// without the branch (a test, a print-mode stub) nothing is known of that request: C0, as before
		expect(calibrate(e)).toMatchObject({ c: C0, source: "default" });
		// a response whose request is not on the branch's side of the compaction is no evidence either
		expect(calibrate(e, undefined, branch.slice(0, 2).concat(branch.slice(-1)))).toMatchObject({ c: C0 });
	});

	test("N1: after a model switch and a compaction that took the other model's responses out of the projection, O still transfers from the branch (it was R0 x the system state: 4K for 2K)", () => {
		const T = Date.parse("2026-10-09T04:00:00Z");
		const raw = session(6, 8_000);
		provider(raw, 2_100, 1.0, ["a1", "a2"]);
		as(raw, ["a1", "a2"], "zai", "glm-like");
		provider(raw, 2_100, 1.0, ["a4", "a5", "a7"]);
		as(raw, ["a4", "a5", "a7"], "anthropic", "claude-like");
		for (const x of raw) Object.assign(x.sourceEntry.message, { timestamp: T - 1_000 });
		const branch = asBranch(raw);
		const cut = raw.findIndex((x) => x.sourceEntry.id === "r5");
		branch.push({ type: "compaction", id: "cmp", summary: "s".repeat(4_000), firstKeptEntryId: "r5", timestamp: new Date(T).toISOString(), details: {} } as Any);
		const comp = { sourceEntry: branch[branch.length - 1], messages: [{ role: "compactionSummary", summary: "s".repeat(4_000), tokensBefore: 0, timestamp: T }] };
		const cal = calibrate([comp, ...raw.slice(cut)], undefined, branch, "anthropic/claude-like");
		expect(cal.oSource).toBe("model");
		expect(cal.O).toBeLessThan(3_000);
	});

	test("TR: a run plan's request that grew and missed the cache still carried its folds: the commit entry says so, no original is added back", () => {
		const raw = session(7, 24_000);
		provider(raw, 30_000, 2.2, ["a1", "a7"]); // the opening request, and the last request before the user left
		const fe = folded(raw, "r1");
		// the cold return's request (a8): its fold of r1 removed less than the previous turn added, and nothing was read from the cache
		provider(fe, 30_000, 2.2, ["a8"], () => 0);
		const N = raw.find((x) => x.sourceEntry.id === "a8").sourceEntry.message, P = raw.find((x) => x.sourceEntry.id === "a7").sourceEntry.message;
		expect(N.usage.input + N.usage.cacheRead + N.usage.cacheWrite).toBeGreaterThanOrEqual(P.usage.input + P.usage.cacheRead + P.usage.cacheWrite);
		const run = calibrate([...fe, edit("ed1", "r1"), mark("mk", true)], undefined, asBranch(raw));
		expect(run.c).toBeCloseTo(2.2, 1);
		expect(run.est).toBe(content(fe, fe.length - 1)); // the folded content: what a8's request carried
		// the same edit as a warm valve plan (the next request is the first to carry it): the original is added back
		const valve = calibrate([...fe, edit("ed1", "r1"), mark("mk", false)], undefined, asBranch(raw));
		expect(valve.est).toBeGreaterThan(run.est + 3_000);
		// ... and another extension's edit never was carried by a request of ours
		const foreign = calibrate([...fe, edit("ed1", "r1", "[pruned by another extension]")], undefined, asBranch(raw));
		expect(foreign.est).toBeGreaterThan(run.est + 3_000);
	});

	test("TR: after a model switch, the first request of the new model carried the originals of folds persisted after it: it is not an opening request", () => {
		// GLM opens; the user switches to Claude mid-session: Claude's first request (a5) carries 40K tokens of conversation. A valve then
		// folds most of it (persisted after a5's response, carried by the next request), so the projection's estimate for a5 is tiny
		const e = session(6, 40_000);
		provider(e, 15_000, 1.0, ["a1", "a2", "a3", "a4"]);
		as(e, ["a1", "a2", "a3", "a4"], "zai", "glm-like");
		provider(e, 30_000, 1.9, ["a5"]);
		let v = e;
		for (const r of ["r1", "r2", "r3", "r4"]) v = folded(v, r);
		provider(v, 30_000, 1.9, ["a6", "a7"]); // the requests after the valve carry its folds
		as(e, ["a5", "a6", "a7"], "anthropic", "claude-like");
		const k = v.findIndex((x) => x.sourceEntry.id === "r5");
		const entries = [...v.slice(0, k + 1), edit("e1", "r1"), edit("e2", "r2"), edit("e3", "r3"), edit("e4", "r4"), mark("mk", false), ...v.slice(k + 1)];
		const cal = calibrate(entries, undefined, asBranch(e), "anthropic/claude-like");
		expect(cal.oSource).toBe("model"); // not "first": a5 is no opening request (the old code read O = 105K off it)
		for (const keep of [0.5, 0.2]) {
			const E = keep * content(e);
			expect(Math.abs(sizeOf(cal, E) / (30_000 + 1.9 * E) - 1)).toBeLessThan(0.05);
		}
	});
	const as = (e: Any[], ids: string[], provider: string, model: string) => {
		for (const x of e) if (ids.includes(x.sourceEntry.id)) Object.assign(x.sourceEntry.message, { provider, model });
		return e;
	};
});
