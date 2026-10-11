// The pure decision core (src/core.ts): view, clock, law, plan and decide as functions of (branch, Λ, now).
import { describe, expect, test } from "bun:test";
import { checkEdits, clock, coldReturnAfter, decideRun, decideSettle, decideTurnEnd, adopt, artifactsOf, grow, headOf, lastRegrow, lawOf, planOpts, readyOf, ruleB, unusedOf, runPlanOf, scaleOf, summarizedSince, valvePlanOf, type Env, type Learned } from "../src/core.ts";
import { planContext, UNIT, type PlanResult } from "../src/plan.ts";
import { replayGrowth } from "../src/state.ts";
import { A, AX, R, U, type Any } from "./helpers.ts";

const MODEL = { provider: "p", id: "m", contextWindow: 200_000, promptCache: { short: 300, long: 3600 } };
const env = (over: Partial<Env> = {}): Env => ({ model: MODEL, cwd: "/tmp", sys: { text: "sys", tools: [] }, reserve: 16_384, recalled: new Set(), steerIds: new Set(), rereadOnly: false, ...over });
const lam = (over: Partial<Learned> = {}): Learned => ({ model: MODEL, ent: { cls: "explicit", bins: {}, n: 0 }, g: 2_500, justEdited: false, summarizedWarm: false, ...over });
// ~60K tokens of prose no fold can touch, two tool outputs that fold, and a new prompt: a cold plan folds both and cuts at u2
const big = [U("u1", "one"), AX("a2", 120_000), AX("a2b", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), A("a5"), U("u3", "three"), A("a6", ["c6"]), R("r6", "c6", 44_000), A("a7"), U("u4", "back")];
const small = [U("u1", "one"), A("a1"), U("u2", "two")];
const T0 = 1_760_000_000_000;
const msg = (id: string, role: string, ts: number, extra: Any = {}) => ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role, content: "x", timestamp: ts, ...extra } });
const asst = (id: string, ts: number, extra: Any = {}) => msg(id, "assistant", ts, { provider: "p", model: "m", stopReason: "stop", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, ...extra });

describe("core: view", () => {
	test("scaleOf is UNIT on a branch it cannot read, and the same for the same inputs", () => {
		expect(scaleOf(null as Any, [], { text: "", tools: [] })).toEqual(UNIT);
		expect(scaleOf(big, [], { text: "sys", tools: [] }, "p/m")).toEqual(scaleOf(big, [], { text: "sys", tools: [] }, "p/m"));
	});
	test("checkEdits: a cut whose first kept entry left the projection is refused; folds of entries that left are ignored", () => {
		const p = planContext(big, planOpts(big, [], env(), lam(), false, "cold").o)!;
		expect(checkEdits(p.blocks, p.userTurns, p.folds, { firstKeptEntryId: "gone" } as Any)).toContain("not in the projection");
		expect(checkEdits(p.blocks, p.userTurns, [...p.folds, { ...p.folds[0], entryId: "gone" }], null)).toBeNull();
	});
});

describe("core: clock", () => {
	test("no touch: warm at P = 1; a model switch: cold at P = 0; a gap past the TTL: cold and past the TTL", () => {
		const l = { model: MODEL };
		expect(clock([], l, T0)).toMatchObject({ cold: false, pWarm: 1, src: "no prior request" });
		const br = [msg("u1", "user", T0), asst("a1", T0 + 1000)];
		expect(clock(br, l, T0 + 2000, { reqMs: 0, modelKey: "p/other" })).toMatchObject({ cold: true, pWarm: 0, src: "model switch" });
		expect(clock(br, l, T0 + 60_000)).toMatchObject({ cold: false, pastTtl: false });
		expect(clock(br, l, T0 + 1000 + 301_000)).toMatchObject({ cold: true, pastTtl: true });
	});
	test("learned survival decides, not the declared TTL: a cache read in full at 600 s is warm past 300 s", () => {
		const bins: Record<string, [number, number]> = {};
		for (const b of [3, 4, 5, 6, 7, 8, 9]) bins[b] = [8, 0];
		bins[10] = [0, 8];
		const br = [msg("u1", "user", T0), asst("a1", T0 + 1000)];
		const c = clock(br, { model: MODEL, ent: { cls: "explicit", bins, n: 64 } }, T0 + 1000 + 400_000);
		expect(c.pastTtl).toBe(true);
		expect(c.cold).toBe(false);
	});
	test("coldReturnAfter / summarizedSince: a summary stays this warm stretch's until a return the clock judges cold", () => {
		const comp = { type: "compaction", id: "s1", details: { by: "pi-zip" } };
		const warm = [msg("u1", "user", T0), asst("a1", T0 + 1000), comp, msg("u2", "user", T0 + 60_000), asst("a2", T0 + 61_000)];
		const none = () => undefined;
		expect(coldReturnAfter(warm, 2, false, new Set(), {}, none)).toBe(-1);
		expect(summarizedSince(warm, new Set(), {}, none)).toBe(true);
		const cold = [...warm, msg("u3", "user", T0 + 61_000 + 400_000), asst("a3", T0 + 462_000)];
		expect(coldReturnAfter(cold, 2, false, new Set(), {}, none)).toBe(5);
		expect(summarizedSince(cold, new Set(), {}, none)).toBe(false);
		// a steering message is no return
		expect(coldReturnAfter(cold, 2, false, new Set(["u3"]), {}, none)).toBe(-1);
		expect(lastRegrow([{ ...comp, details: { by: "pi-zip", regrow: 1234 } }])).toBe(1234);
		expect(lastRegrow([comp])).toBeUndefined();
	});
	test("grow is the growth step state.ts replays: the same g as replaying the branch", () => {
		let g = 2_500, deltas: number[] = [];
		const totals = [1000, 5000, 9000, 8000, 30_000, 31_000];
		for (let i = 1; i < totals.length; i++) if (totals[i] >= totals[i - 1]) ({ g, deltas } = grow(g, deltas, totals[i] - totals[i - 1]));
		const br = totals.map((t, i) => asst(`a${i}`, T0 + i * 1000, { usage: { input: t, output: 1, cacheRead: 0, cacheWrite: 0 } }));
		expect(replayGrowth(br, 2_500).g).toBeCloseTo(g, 9);
		// one delta far above the p90 of the last 20 counts only up to that p90
		expect(grow(100, [10, 10, 10], 1_000_000).g).toBeCloseTo(0.9 * 100 + 0.1 * 1_000_000, 6); // 4 samples: the p90 is the largest
		expect(grow(100, Array(19).fill(10), 1_000_000).g).toBeCloseTo(0.9 * 100 + 0.1 * 10, 6);
	});
});

describe("core: law", () => {
	test("lawOf: class prices of Λ's entry, the 1-hour premium by tier, g and P passed through; no class, no prices", () => {
		const short = lawOf([], lam({ g: 1234 }), 0.7), long = lawOf([], lam({ tier: "long" }), 0.7);
		expect(short).toMatchObject({ g: 1234, pWarm: 0.7 });
		expect(short.pr?.cls).toBe("explicit");
		expect(long.pr!.w).toBeGreaterThan(short.pr!.w);
		expect(lawOf([], lam({ ent: undefined }), 1).pr).toBeNull();
	});
});

describe("core: plan", () => {
	test("planOpts: P defaults to 0 cold / 1 warm; noSummary and regrowAt only for a warm plan after a summary; cutAt only when asked", () => {
		expect(planOpts(big, [], env(), lam(), true, "cold").o.law!.pWarm).toBe(0);
		expect(planOpts(big, [], env(), lam(), true, "warm").o.law!.pWarm).toBe(1);
		const after = lam({ summarizedWarm: true, summaryRegrow: 9999 });
		expect(planOpts(big, [], env(), after, false, "cold").o).toMatchObject({ noSummary: false });
		expect(planOpts(big, [], env(), after, false, "cold").o.regrowAt).toBeUndefined();
		expect(planOpts(big, [], env(), after, false, "warm").o).toMatchObject({ noSummary: true, regrowAt: 9999 });
		expect("cutAt" in planOpts(big, [], env(), lam(), false, "warm").o).toBe(false);
		expect(planOpts(big, [], env(), lam(), false, "warm", 1, "u2").o.cutAt).toBe("u2");
		expect(planOpts(big, [], env({ rereadOnly: true }), lam(), false, "cold").o.rereadOnly).toBe(true);
	});
	test("adopt: nothing available, no cut or the same cut keep the first plan; the deepest summary not deeper than the cut is taken if the plan for it cuts there", () => {
		const blocks = ["s", "a", "b", "c", "d"].map((entryId) => ({ entryId }));
		const p = (k: string | null) => ({ p: k === null ? null : ({ cutIdx: 3, firstKeptEntryId: k, blocks } as unknown as PlanResult) });
		const r = (key: string) => ({ key, running: false });
		expect(adopt(p("c"), () => p("b"), [], "x")).toEqual({ r: p("c") });
		expect(adopt(p("c"), () => p("b"), [r("c"), r("a")], "x")).toEqual({ r: p("c") });
		expect(adopt(p("c"), (k) => p(k), [r("a"), r("b")], "x")).toEqual({ r: p("b"), note: { type: "pin", where: "x", from: "c", to: "b", ok: true } });
		expect(adopt(p("c"), (k) => p(k), [{ key: "b", running: true }], "x")).toEqual({ r: p("b"), note: { type: "pin", where: "x", from: "c", to: "b", ok: true, running: true } });
		expect(adopt(p("c"), () => p(null), [r("b")], "x")).toEqual({ r: p("c"), note: { type: "pin", where: "x", from: "c", to: "b", ok: false } });
		// never deeper than the plan's own cut, and never a cut the projection does not have
		expect(adopt(p("c"), (k) => p(k), [r("d"), r("gone")], "x")).toEqual({ r: p("c") });
	});
	test("artifacts: ready while their head is the branch's; unused unless a pi-zip compaction used their text; lost calls count, at their cost", () => {
		const cut = (k: string, text: string) => ({ firstKeptEntryId: k, text }) as Any;
		const rec = (data: Any) => ({ type: "custom", customType: "pi-zip/summary", data });
		const branch: Any[] = [{ type: "message", id: "m1" }, rec({ head: "", key: "m1", cut: cut("m1", "S1"), usd: 0.1 }), rec({ head: "", key: "m2", usd: 0.05, estimated: true, lost: "shutdown" })];
		expect(headOf(branch)).toBe("");
		expect(artifactsOf(branch)).toHaveLength(2);
		expect(readyOf(branch).map((a) => a.key)).toEqual(["m1"]); // the lost call has no summary
		expect(readyOf(branch, [{ head: "", key: "m3", cut: cut("m3", "S3"), usd: 0 }]).map((a) => a.key)).toEqual(["m1", "m3"]);
		expect(unusedOf(branch)).toEqual({ n: 2, usd: 0.15000000000000002 });
		const used = [...branch, { type: "compaction", id: "c1", firstKeptEntryId: "m1", summary: "S1", details: { by: "pi-zip" } }];
		expect(headOf(used)).toBe("c1");
		expect(readyOf(used)).toEqual([]); // any compaction moves the head: what was written for the old one is not ready any more
		expect(unusedOf(used)).toEqual({ n: 1, usd: 0.05 });
		expect(unusedOf([...branch, { type: "compaction", id: "c2", firstKeptEntryId: "m1", summary: "other", details: { by: "pi-zip" } }]).n).toBe(2);
	});
});

describe("core: decide", () => {
	const plan = (o: Any) => ({ atRoom: false, atRoomUnedited: false, firstKeptEntryId: "k", ...o }) as PlanResult;
	test("ruleB: no UI or the room waits; a summary for this cut is taken when ready, else left running; otherwise started", () => {
		expect(ruleB(plan({}), false, [])).toBe("wait");
		expect(ruleB(plan({ atRoom: true }), true, [])).toBe("wait");
		expect(ruleB(plan({ atRoomUnedited: true }), true, [])).toBe("wait");
		expect(ruleB(plan({}), true, [{ key: "k", running: false }])).toBe("take");
		expect(ruleB(plan({}), true, [{ key: "k", running: true }])).toBe("running");
		expect(ruleB(plan({}), true, [{ key: "other", running: false }])).toBe("start");
		expect(ruleB(plan({}), true, [])).toBe("start");
	});
	const opts = (l: Learned, mode: "cold" | "warm", p: number) => (entries: Any[], cutAt?: string) => planOpts(entries, [], env(), l, false, mode, p, cutAt);
	test("decideRun: b2b only for a warm return right after an edit without a native summary; a cold return plans on the session", () => {
		const l = lam({ justEdited: true });
		expect(decideRun({ cold: false, pastTtl: false, justEdited: true, nat: null, foreign: false, now: big, avail: [], opts: opts(l, "warm", 1) }).kind).toBe("b2b");
		const d = decideRun({ cold: true, pastTtl: true, justEdited: true, nat: null, foreign: false, now: big, avail: [], opts: opts(l, "cold", 0) });
		expect(d.kind).toBe("plan");
		if (d.kind !== "plan") return;
		expect(d.o.pastTtl).toBe(true);
		expect(d.p?.cutIdx).not.toBeNull();
		expect(d.p!.folds.length).toBeGreaterThan(0);
		expect(d.onPre).toBe(false);
		expect(d.notes).toEqual([]);
		// pure: the same inputs give the same decision
		const again = decideRun({ cold: true, pastTtl: true, justEdited: true, nat: null, foreign: false, now: big, avail: [], opts: opts(l, "cold", 0) });
		expect(again.kind === "plan" && again.p?.firstKeptEntryId).toBe(d.p!.firstKeptEntryId);
	});
	test("decideRun: another extension's compaction just went in: folds only (no summary)", () => {
		const d = decideRun({ cold: true, pastTtl: true, justEdited: false, nat: null, foreign: true, now: big, avail: [], opts: opts(lam(), "cold", 0) });
		expect(d.kind === "plan" && d.o.noSummary).toBe(true);
		expect(d.kind === "plan" && d.p?.cutIdx).toBeNull();
	});
	test("decideRun: a native summary whose cut the plan does not reach: the session as it is, with a note", () => {
		const d = decideRun({ cold: false, pastTtl: false, justEdited: true, nat: { key: "nowhere", pre: big, entryId: "c9" }, foreign: false, now: small, avail: [], opts: opts(lam(), "warm", 1) });
		expect(d.kind).toBe("plan");
		if (d.kind !== "plan") return;
		expect(d.onPre).toBe(false);
		expect(d.notes).toEqual([{ type: "native_mismatch", planned: d.p?.firstKeptEntryId ?? null, compacted: "nowhere" }]);
	});
	test("runPlanOf: source settle / runstart / valve; the guard drops a cut that left the projection; sizes count the summary", () => {
		const d = decideRun({ cold: true, pastTtl: true, justEdited: false, nat: null, foreign: false, now: big, avail: [], opts: opts(lam(), "cold", 0) });
		if (d.kind !== "plan" || !d.p) throw new Error("no plan");
		const base = { p: d.p, cal: d.cal, cold: true, onPre: false, native: null, nat: null, folds: d.p.folds, cut: null, adopted: false, settleIds: [] as string[], ms: 1, bgWaitMs: 0 };
		expect(runPlanOf(base).plan.source).toBe("runstart");
		expect(runPlanOf({ ...base, settleIds: d.p.folds.map((t) => t.entryId) }).plan.source).toBe("settle");
		expect(runPlanOf({ ...base, cold: false }).plan.source).toBe("valve");
		const cut = { firstKeptEntryId: d.p.firstKeptEntryId, prefixTokens: 1000, summaryTokens: 100, ms: 7 } as Any;
		const r = runPlanOf({ ...base, cut });
		expect(r.cut).toBe(cut);
		expect(r.plan.ctxAfter).toBeCloseTo(d.p.ctxAfterFolds - d.cal.c * 900, 6);
		expect(r.plan.waitMs).toBe(7);
		const gone = runPlanOf({ ...base, cut: { ...cut, firstKeptEntryId: "gone" } });
		expect(gone.cut).toBeNull();
		expect(gone.drop).toMatchObject({ type: "guard_drop", where: "run_plan", summary: true });
		expect(gone.folds).toEqual(d.p.folds); // the folds alone pass
	});
	test("decideTurnEnd: none after a failed turn, b2b after an edited request, a warm plan only when it changes something", () => {
		const o = (cutAt?: string) => planOpts(small, [], env(), lam(), false, "warm", 1, cutAt);
		expect(decideTurnEnd({ failed: true, justEdited: false, avail: [], entries: small, opts: o }).kind).toBe("none");
		expect(decideTurnEnd({ failed: false, justEdited: true, avail: [], entries: small, opts: o }).kind).toBe("b2b");
		const d = decideTurnEnd({ failed: false, justEdited: false, avail: [], entries: small, opts: o });
		expect(d.kind === "plan" && d.p).toBeNull();
	});
	test("valvePlanOf: a valve plan's sizes and the wait of its summary (adopted: the background wait)", () => {
		const p = planContext(big, planOpts(big, [], env(), lam(), false, "cold").o)!;
		const cut = { prefixTokens: 1000, summaryTokens: 100, ms: 7 } as Any;
		expect(valvePlanOf(p, null, false, 0, 1)).toMatchObject({ source: "valve", cut: null, ctxAfter: p.ctxAfterFolds, persisted: false });
		expect(valvePlanOf(p, cut, true, 42, 1)).toMatchObject({ waitMs: 42, ready: "background" });
		expect(valvePlanOf(p, cut, false, 42, 1).waitMs).toBe(7);
	});
	test("decideSettle: the cold plan always; the warm plan unless the newest request carried an edit", () => {
		const x = (justEdited: boolean) => decideSettle({ justEdited, avail: [], entries: big, cold: () => planOpts(big, [], env(), lam(), true, "cold"), warm: (cutAt) => planOpts(big, [], env(), lam(), true, "warm", undefined, cutAt) });
		expect(x(true).p).not.toBeNull();
		expect(x(true).w).toBeNull();
		expect(x(false).w).not.toBeNull();
	});
});
