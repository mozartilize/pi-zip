// The pure decision core (src/core.ts): view, clock, law, plan and decide as functions of (branch, Λ, now).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkEdits, clock, inRunClock, decideRun, decideEdits, want, decideTurnEnd, artifactsOf, grow, headOf, lawOf, planOpts, readyOf, unusedOf, runPlanOf, scaleOf, valvePlanOf, type Env, type Learned } from "../src/core.ts";
import { UNIT, type PlanResult } from "../src/plan.ts";
import { planContext } from "../src/plan-fork.ts";
import { buildCut } from "../src/summary.ts";
import { replayGrowth } from "../src/state.ts";
import { A, AX, R, U, type Any } from "./helpers.ts";

let savedAt: string | undefined;
beforeEach(() => { savedAt = process.env.PI_ZIP_SUMMARY_AT; process.env.PI_ZIP_SUMMARY_AT = "0"; });
afterEach(() => { if (savedAt === undefined) delete process.env.PI_ZIP_SUMMARY_AT; else process.env.PI_ZIP_SUMMARY_AT = savedAt; });

const MODEL = { provider: "p", id: "m", contextWindow: 200_000, promptCache: { short: 300, long: 3600 } };
const env = (over: Partial<Env> = {}): Env => ({ model: MODEL, cwd: "/tmp", sys: { text: "sys", tools: [] }, reserve: 16_384, recalled: new Set(), steerIds: new Set(), rereadOnly: false, ...over });
const lam = (over: Partial<Learned> = {}): Learned => ({ model: MODEL, ent: { cls: "explicit", bins: {}, n: 0 }, g: 2_500, justEdited: false, ...over });
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
		const p = planContext(big, planOpts(big, [], env(), lam(), false, 0, true).o)!;
		expect(checkEdits(p.blocks, p.userTurns, p.folds, { firstKeptEntryId: "gone" } as Any)).toContain("not in the projection");
		expect(checkEdits(p.blocks, p.userTurns, [...p.folds, { ...p.folds[0], entryId: "gone" }], null)).toBeNull();
	});
});

describe("core: clock", () => {
	test("no touch: P = 0, no pause; a model switch: P = 0; a gap past the TTL: cold and a pause", () => {
		const l = { model: MODEL };
		expect(clock([], l, T0)).toMatchObject({ cold: true, pWarm: 0, pause: false, src: "no prior request" });
		const br = [msg("u1", "user", T0), asst("a1", T0 + 1000)];
		expect(clock(br, l, T0 + 2000, { reqMs: 0, modelKey: "p/other" })).toMatchObject({ cold: true, pWarm: 0, pause: false, src: "model switch" });
		expect(clock(br, l, T0 + 60_000)).toMatchObject({ cold: false, pause: false });
		expect(clock(br, l, T0 + 1000 + 301_000)).toMatchObject({ cold: true, pause: true });
	});
	test("inRunClock: the gap runs from the newest response, not from the tool results after it; never a pause", () => {
		const l = { model: MODEL };
		const br = [msg("u1", "user", T0), asst("a1", T0 + 1000), msg("t1", "toolResult", T0 + 400_000)];
		expect(clock(br, l, T0 + 401_000)).toMatchObject({ cold: false, pause: false }); // the tool result counts as a touch for a prompt
		expect(inRunClock(br, l, T0 + 401_000, { reqMs: T0 + 1000, modelKey: "p/m" })).toMatchObject({ cold: true, pWarm: 0, pause: false });
		expect(inRunClock(br, l, T0 + 2000, { reqMs: T0 + 1000, modelKey: "p/m" })).toMatchObject({ cold: false, pWarm: 1, pause: false });
	});
	test("inRunClock keeps kind-agnostic usage touches among trailing tool and user messages", () => {
		const response = asst("a1", T0 + 1000, { usage: { cacheRead: 100, cacheWrite: 50 } });
		const br = [response, msg("t1", "toolResult", T0 + 390_000),
			{ type: "usage", kind: "another-extension", provider: "p", model: "m", usage: { cacheRead: 150 }, timestamp: new Date(T0 + 400_000).toISOString() },
			msg("u2", "user", T0 + 409_000)];
		const last = { reqMs: T0 + 1000, modelKey: "p/m" };
		expect(inRunClock(br, { model: MODEL }, T0 + 410_000, last)).toMatchObject({ cold: false, gapS: 10, pause: false });
		br[2].usage.cacheRead = 149;
		expect(inRunClock(br, { model: MODEL }, T0 + 410_000, last)).toMatchObject({ cold: true, gapS: 409, pause: false });
	});
	test("learned survival decides, not the declared TTL: a cache read in full at 600 s is warm past 300 s", () => {
		const bins: Record<string, [number, number]> = {};
		for (const b of [3, 4, 5, 6, 7, 8, 9]) bins[b] = [8, 0];
		bins[10] = [0, 8];
		const br = [msg("u1", "user", T0), asst("a1", T0 + 1000)];
		const c = clock(br, { model: MODEL, ent: { cls: "explicit", bins, n: 64 } }, T0 + 1000 + 400_000);
		expect(c.pause).toBe(true);
		expect(c.cold).toBe(false);
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
	test("lawOf: class prices of Λ's entry, the 1-hour premium by tier, g and P passed through; no class yet: the explicit ratios", () => {
		const short = lawOf([], lam({ g: 1234 }), 0.7), long = lawOf([], lam({ tier: "long" }), 0.7);
		expect(short).toMatchObject({ g: 1234, pWarm: 0.7 });
		expect(short.pr?.cls).toBe("explicit");
		expect(long.pr!.w).toBeGreaterThan(short.pr!.w);
		expect(lawOf([], lam({ ent: undefined }), 1).pr).toEqual({ ...short.pr, src: "default" });
	});
});

describe("core: plan", () => {
	test("planOpts: P goes into the law only, pause as given; cutAt only when asked", () => {
		expect(planOpts(big, [], env(), lam(), true, 0.3, true).o).toMatchObject({ pause: true, law: { pWarm: 0.3 } });
		expect(planOpts(big, [], env(), lam(), true, 1, false).o).toMatchObject({ pause: false, law: { pWarm: 1 } });
		expect("cutAt" in planOpts(big, [], env(), lam(), false, 1, false).o).toBe(false);
		expect(planOpts(big, [], env(), lam(), false, 1, false, "u2").o.cutAt).toBe("u2");
		expect(planOpts(big, [], env({ rereadOnly: true }), lam(), false, 0, true).o.rereadOnly).toBe(true);
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
		const used = [...branch, { type: "compaction", id: "c1", firstKeptEntryId: "m1", summary: "S1", details: { by: "pi-zip" }, usage: { cost: { total: 0.1 } } }];
		expect(headOf(used)).toBe("c1");
		expect(readyOf(used)).toEqual([]); // any compaction moves the head: what was written for the old one is not ready any more
		expect(unusedOf(used)).toEqual({ n: 1, usd: 0.05 });
		expect(unusedOf([...branch, { type: "compaction", id: "c2", firstKeptEntryId: "m1", summary: "other", details: { by: "pi-zip" } }]).n).toBe(2);
	});
	test("unused calls retain their own charge when identical summaries are produced on successive heads", () => {
		const artifact = (head: string, usd: number) => ({ type: "custom", customType: "pi-zip/summary", data: { head, key: "m", cut: { text: "same" }, usd } });
		const compaction = (id: string, usd: number, by = "pi-zip") => ({ type: "compaction", id, firstKeptEntryId: "m", summary: "same", details: { by }, usage: { cost: { total: usd } } });
		const branch = [artifact("", 0.1), artifact("", 0.2), compaction("c1", 0.3), artifact("", 0.3)]; // the last call's artifact is a boundary draft
		expect(unusedOf([artifact("", 0.1), artifact("", 0.1), compaction("equal", 0.1)])).toEqual({ n: 1, usd: 0.1 }); // equal charges still represent two calls
		expect(unusedOf([artifact("", 0.1), compaction("early", 0.1), artifact("", 0.2)])).toEqual({ n: 1, usd: 0.2 }); // a delayed draft can belong to a different call
		expect(unusedOf(branch).n).toBe(2);
		expect(unusedOf(branch).usd).toBeCloseTo(0.3, 10); // one compaction takes the newest call, leaving the two older charges
		const next = [...branch, artifact("c1", 0.4), compaction("c2", 0.4), artifact("c2", 0.5)];
		expect(unusedOf(next).n).toBe(3);
		expect(unusedOf(next).usd).toBeCloseTo(0.8, 10); // a later identical artifact cannot be charged to an earlier head
		expect(unusedOf([artifact("", 0.1), compaction("foreign", 0.1, "other"), artifact("foreign", 0.2), compaction("own", 0.2)])).toEqual({ n: 1, usd: 0.1 });
	});
});

describe("core: decide", () => {
	const plan = (o: Any) => ({ atRoom: false, atRoomUnedited: false, firstKeptEntryId: "k", ...o }) as PlanResult;
	const opts = (l: Learned, p: number, pause: boolean) => (entries: Any[], cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => planOpts(entries, [], env(), l, false, p, pause, cutAt, foldsOnly, ready);
	test("a ready summary never cuts deeper than c, or than cW when no cut pays with its call (theory 1.4 plan)", () => {
		// 18 turns of prose no fold can touch: cW is u12; at p = 1 no cut from cW on pays with its call
		const prose = Array.from({ length: 18 }, (_, i) => [U(`u${i + 1}`, `turn ${i + 1}`), AX(`a${i + 1}`, 13_000)]).flat();
		const cutAt = (p: number, ready: string[]) => planContext(prose, planOpts(prose, [], env(), lam(), false, p, false, undefined, false, ready).o)?.firstKeptEntryId ?? null;
		expect(cutAt(1, [])).toBeNull();
		expect(cutAt(0, [])).toBe("u12"); // c at a dead cache: the cut that reaches the view
		expect(cutAt(1, ["u12"])).toBe("u12"); // a = cW: its call is spent
		expect(cutAt(1, ["u9", "u12", "u15"])).toBe("u12"); // the deepest ready summary no deeper than cW
		for (const deep of ["u13", "u15", "u17"]) {
			expect(cutAt(1, [deep])).toBeNull(); // deeper than cW, no c: not taken however cheap
			expect(cutAt(0, [deep])).toBe("u12"); // deeper than c: c stands (and is produced)
		}
	});
	test("decideRun: b2b only for a warm return right after an edit without a native summary (its summary is still produced); a cold return plans on the session", () => {
		const l = lam({ justEdited: true });
		const b = decideRun({ cold: false, justEdited: true, nat: null, foreign: false, now: big, ready: [], opts: opts(l, 1, false) });
		expect(b.kind).toBe("b2b");
		const d = decideRun({ cold: true, justEdited: true, nat: null, foreign: false, now: big, ready: [], opts: opts(l, 0, true) });
		expect(d.kind).toBe("plan");
		if (d.kind !== "plan") return;
		expect(d.o.pause).toBe(true);
		expect(d.notes).toEqual([]);
		// no ready summary: the folds alone go now, the cut is produced in the background (nobody waits)
		expect(d.o.deferSummary).toBe(true);
		expect(d.p?.cutIdx).toBeNull();
		expect(d.p!.folds.length).toBeGreaterThan(0);
		expect(d.produce?.cutIdx).not.toBeNull();
		const key = d.produce!.firstKeptEntryId!;
		// pure: the same inputs give the same decision
		const again = decideRun({ cold: true, justEdited: true, nat: null, foreign: false, now: big, ready: [], opts: opts(l, 0, true) });
		expect(again.kind === "plan" && again.produce?.firstKeptEntryId).toBe(key);
		// A ready summary waits for turn_end when the native door has not taken it.
		const taken = decideRun({ cold: true, justEdited: true, nat: null, foreign: false, now: big, ready: [{ key, running: false }], opts: opts(l, 0, true) });
		expect(taken.kind === "plan" && taken.p?.cutIdx).toBeNull();
		expect(taken.kind === "plan" && taken.produce).toBeNull();
		// a call still running is not ready: the folds alone, as without it
		const running = decideRun({ cold: true, justEdited: true, nat: null, foreign: false, now: big, ready: [{ key, running: true }], opts: opts(l, 0, true) });
		expect(running.kind === "plan" && running.p?.cutIdx).toBeNull();
	});
	test("decideRun: another extension's compaction just went in: folds only (no summary)", () => {
		const d = decideRun({ cold: true, justEdited: false, nat: null, foreign: true, now: big, ready: [], opts: opts(lam(), 0, true) });
		expect(d.kind === "plan" && d.o.foldsOnly).toBe(true);
		expect(d.kind === "plan" && d.p?.cutIdx).toBeNull();
		expect(d.kind === "plan" && d.produce).toBeNull();
	});
	test("decideRun: native application carries the joint prompt decision without a folds-only re-plan", () => {
		const input = opts(lam(), 0, true)(big), p = planContext(big, input.o)!;
		const d = decideRun({ cold: false, justEdited: true, nat: { ...input, p }, foreign: false, now: small, ready: [], opts: () => { throw new Error("native request must not re-plan"); } });
		expect(d.kind).toBe("plan");
		if (d.kind !== "plan") throw new Error("no decision");
		expect(d.p).toBe(p);
		expect(d.o).toBe(input.o);
		expect(d.produce).toBeNull();
		expect(d.notes).toEqual([]);
	});
	test("runPlanOf: native folds keep their entry IDs and priced sizes, with positions looked up after the cut", () => {
		const d = decideRun({ cold: true, justEdited: false, nat: null, foreign: false, now: big, ready: [], opts: opts(lam(), 0, true) });
		if (d.kind !== "plan" || !d.p) throw new Error("no plan");
		const p = d.p, base = { p, cal: d.cal, cold: true, native: null, nat: null, folds: p.folds, settleIds: [] as string[], ms: 1 };
		expect(runPlanOf(base).plan.source).toBe("runstart");
		expect(runPlanOf({ ...base, settleIds: p.folds.map((t) => t.entryId) }).plan.source).toBe("settle");
		expect(runPlanOf({ ...base, cold: false }).plan.source).toBe("valve");
		const joint = planContext(big, planOpts(big, [], env(), lam(), false, 0, true).o)!;
		const native = { firstKeptEntryId: joint.firstKeptEntryId } as Any;
		const now = [{ sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: "S" }] }, ...big.slice(joint.cutIdx!)];
		const r = runPlanOf({ ...base, p: joint, folds: joint.folds, native, now, nat: { before: 100_000, after: 40_000 } });
		expect(r.plan.cut).toBeNull();
		expect(r.plan.native).toBe(native);
		expect(r.folds.map((t) => t.entryId)).toEqual(joint.folds.map((t) => t.entryId));
		expect(r.plan.ctxBefore).toBe(100_000);
		expect(r.plan.ctxAfter).toBe(40_000);
		expect(() => runPlanOf({ ...base, p: joint, native, now, folds: [{ ...joint.folds[0], entryId: "a2" }] })).toThrow("native fold target must be kept after the cut");
		expect(() => runPlanOf({ ...base, p: joint, native, now: [], folds: joint.folds })).toThrow("native fold target must be kept after the cut");
	});
	test("rent counts the ready edit or folds, never an unproduced cut; a dead cache resets it", () => {
		const at = (pWarm: number, ready: Any[] = [], rent = 123) => decideEdits({
			at: "turn_end", justEdited: false, pWarm, ready, entries: big,
			opts: (cutAt, foldsOnly, ready) => {
				const r = planOpts(big, [], env(), lam({ g: pWarm === 0 ? 2500 : 1e9 }), false, pWarm, false, cutAt, foldsOnly, ready);
				r.o.rent = rent;
				return r;
			},
		});
		const cold = at(0);
		expect(cold.produce?.cutIdx).not.toBeNull();
		expect(cold.p?.cutIdx ?? null).toBeNull();
		expect(cold.rentNext).toBe(0);
		const warm = at(1);
		expect(warm.p).toBeNull();
		const folds = warm.o.carriedFolds ?? [];
		const plain = planContext(big, { ...warm.o, application: false, law: { ...warm.o.law!, pWarm: 0 }, foldsOnly: true })!;
		expect(folds).toHaveLength(0);
		expect(warm.rentNext).toBeCloseTo(123 + plain.folds.reduce((n, f) => n + plain.scale.c * (f.entryTokens - f.phTokens), 0), 8);
		const key = cold.produce!.firstKeptEntryId!;
		const ready = at(1, [{ key, running: false, summaryTokens: 25 }]);
		expect(ready.p).toBeNull(); // huge g, low rent: availability alone does not authorize a rewrite
		expect(ready.rentNext).toBeGreaterThan(warm.rentNext);
		const bought = at(1, [{ key, running: false, summaryTokens: 25 }], 1e9);
		expect(bought.p?.firstKeptEntryId).toBe(key);
		expect(bought.p?.summaryTokensPlanned).toBe(25);
		expect(bought.rentNext).toBe(0);
	});
	test("a boundary adds no rent for folds already sent on the preceding request", () => {
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 160_000), U("u2", "two"), AX("a2", 40_000), U("u3", "three")];
		const opts = (p: number) => (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => {
			const r = planOpts(entries, [], env(), lam(), false, p, false, cutAt, foldsOnly, ready);
			r.o.scale = UNIT;
			r.o.rent = 0;
			return r;
		};
		const cold = decideEdits({ at: "run", justEdited: false, pWarm: 0, ready: [], entries, opts: opts(0) });
		expect(cold.p!.folds).toHaveLength(1);
		expect(cold.p!.ctxAfterFolds).toBeLessThan(40_000);
		expect(cold.rentNext).toBe(0);
		const runPlan = runPlanOf({ p: cold.p, cal: cold.cal, cold: true, native: null, nat: null, folds: cold.p!.folds, settleIds: [], ms: 1 }).plan;
		runPlan.sent = true;
		runPlan.applied = new Set(runPlan.folds.map((t) => t.entryId));
		const d = decideTurnEnd({ failed: false, justEdited: true, pWarm: 1, ready: [], entries, opts: opts(1), runPlan });
		if (d.kind !== "b2b") throw new Error("expected b2b");
		expect(d.p).toBeNull();
		expect(d.room).toBeNull();
		expect(d.rentNext).toBe(0);
	});
	test("the room waits for the same cut when its actual finished summary exceeds the planned size", async () => {
		const outputs = Array.from({ length: 80 }, (_, i) => {
			const a = A(`a-old-${i}`, [`c-old-${i}`]);
			(a.messages[0] as Any).content[1].arguments.command = `printf record-${i} ${"x".repeat(70)}`;
			return [a, R(`r-old-${i}`, `c-old-${i}`, 5000)];
		}).flat();
		const entries = [U("u1", "record ".repeat(400)), AX("a1", 320_000), ...outputs, U("u2", "two"), AX("a2", 478_000), U("u3", "three"), A("a3")];
		const model = { ...MODEL, contextWindow: 144_576 }, e = env({ model }), l = lam({ model });
		const opts = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => {
			const r = planOpts(entries, [], e, l, false, 0, false, cutAt, foldsOnly, ready);
			r.o.scale = UNIT;
			return r;
		};
		const p = planContext(entries, opts().o)!;
		const cut = await buildCut(p, { cwd: ".", model, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "## Decisions\n" + "detail ".repeat(4000) }] }) } });
		expect(cut.llmOk).toBe(true);
		// Simulate an oversized persisted/foreign summary; the narrative writer now bounds oversized model replies.
		cut.summaryTokens = p.summaryTokensPlanned + 4000;
		expect(cut.summaryTokens).toBeGreaterThan(p.summaryTokensPlanned);
		const estimatedAfter = p.ctxAfterFolds - p.prefixTokens + p.summaryTokensPlanned;
		expect(estimatedAfter).toBeLessThan(model.contextWindow - e.reserve);
		const after = p.ctxAfterFolds - p.prefixTokens + cut.summaryTokens;
		expect(after).toBeGreaterThan(model.contextWindow - e.reserve);
		const d = decideTurnEnd({ failed: false, justEdited: false, pWarm: 0, ready: [{ key: cut.firstKeptEntryId, running: false, summaryTokens: cut.summaryTokens }], entries, opts });
		if (d.kind !== "plan") throw new Error("expected plan");
		expect(d.p?.firstKeptEntryId).toBe(cut.firstKeptEntryId);
		expect(d.p?.summaryTokensPlanned).toBe(cut.summaryTokens);
		expect(d.room?.firstKeptEntryId).toBe(cut.firstKeptEntryId);
		expect(d.room?.summaryTokensPlanned).toBe(p.summaryTokensPlanned);
		expect(d.produce).toBeNull();
	});
	test("decideTurnEnd: none after a failed turn, b2b after an edited request while warm, a plan only when it changes something", () => {
		const o = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => planOpts(small, [], env(), lam(), false, 1, false, cutAt, foldsOnly, ready);
		expect(decideTurnEnd({ failed: true, justEdited: false, pWarm: 1, ready: [], entries: small, opts: o }).kind).toBe("none");
		expect(decideTurnEnd({ failed: false, justEdited: true, pWarm: 1, ready: [], entries: small, opts: o }).kind).toBe("b2b");
		expect(decideTurnEnd({ failed: false, justEdited: true, pWarm: 0.2, ready: [], entries: small, opts: o }).kind).toBe("plan"); // a long tool call: the cache is believed gone
		const d = decideTurnEnd({ failed: false, justEdited: false, pWarm: 1, ready: [], entries: small, opts: o });
		expect(d.kind === "plan" && d.p).toBeNull();
	});
	test("decideTurnEnd: an unready summary is produced and its folds go alone; at Pi's compaction room the plan's own cut is the one wait", () => {
		const at = (model: Any, ready: { key: string; running: boolean }[] = []) => {
			const e = env({ model }), l = lam({ model });
			return decideTurnEnd({ failed: false, justEdited: false, pWarm: 0, ready, entries: big, opts: (cutAt, foldsOnly, ready) => planOpts(big, [], e, l, false, 0, false, cutAt, foldsOnly, ready) });
		};
		const below = at(MODEL); // a 200K window: the view is far below the room
		if (below.kind !== "plan") throw new Error("no plan");
		expect(below.room).toBeNull();
		expect(below.p?.cutIdx ?? null).toBeNull();
		expect(below.produce?.cutIdx).not.toBeNull();
		const key = below.produce!.firstKeptEntryId!;
		const ready = at(MODEL, [{ key, running: false }]);
		expect(ready.kind === "plan" && ready.p?.firstKeptEntryId).toBe(key); // ready: taken, nothing produced
		expect(ready.kind === "plan" && ready.produce).toBeNull();
		const tight = at({ ...MODEL, contextWindow: 60_000 }); // room 35,424: still above it after the folds alone
		if (tight.kind !== "plan") throw new Error("no plan");
		expect(tight.room?.cutIdx).not.toBeNull(); // wait for the plan's own cut
		expect(tight.produce).toBeNull(); // the wait makes it: no background call besides
		// the room plan prices every call: it is planned with no ready summaries (theory 1.3 R9), whatever the decision may take
		const seen: (readonly string[] | undefined)[] = [];
		const e = env({ model: { ...MODEL, contextWindow: 60_000 } }), l = lam({ model: { ...MODEL, contextWindow: 60_000 } });
		const opts = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => (seen.push(ready), planOpts(big, [], e, l, false, 0, false, cutAt, foldsOnly, ready));
		const b2b = decideTurnEnd({ failed: false, justEdited: true, pWarm: 1, ready: [{ key: "elsewhere", running: false }], entries: big, opts });
		if (b2b.kind !== "b2b") throw new Error("no b2b");
		expect(b2b.room?.cutIdx).not.toBeNull(); // b2b blocks the application, not the room wait (theory 1.3 R6)
		expect(b2b.produce).toBeNull();
		expect(seen).toEqual([["elsewhere"], []]);
	});
	test("decideTurnEnd: the room still judges a large protected context when the ordinary planner returns no plan", () => {
		const entries = [U("u1", "one"), AX("a1", 240_000), U("u2", "two")];
		const model = { ...MODEL, contextWindow: 60_000 }, e = env({ model }), l = lam({ model });
		const seen: (readonly string[] | undefined)[] = [];
		const d = decideTurnEnd({ failed: false, justEdited: false, pWarm: 1, ready: [], entries,
			opts: (cutAt, foldsOnly, ready) => (seen.push(ready), planOpts(entries, [], e, l, false, 1, false, cutAt, foldsOnly, ready)) });
		if (d.kind !== "plan") throw new Error("no decision");
		expect(d.p).toBeNull(); // protection leaves no legal edit
		expect(d.room).toBeNull(); // the room planner also respects protection
		expect(seen).toEqual([[], []]); // it still gets one post-edit room judgement
	});
	test("valvePlanOf: a valve plan's sizes, a ready summary (no wait) and the room wait", () => {
		const p = planContext(big, planOpts(big, [], env(), lam(), false, 0, true).o)!;
		const cut = { prefixTokens: 1000, summaryTokens: 100, ms: 7 } as Any;
		expect(valvePlanOf(p, null, false, 0, 1)).toMatchObject({ source: "valve", cut: null, ctxAfter: p.ctxAfterFolds, persisted: false });
		expect(valvePlanOf(p, cut, true, 0, 1)).toMatchObject({ waitMs: 0, ready: "background" });
		expect(valvePlanOf(p, cut, false, 42, 1).waitMs).toBe(42);
	});
	test("want schedules the first paying pause from the last touch and measured call time", () => {
		const p = planContext(big, planOpts(big, [], env(), lam(), true, 0, true).o)!;
		const x = { at: "timer" as const, now: 100_000, lastTouch: 80_000, ttlMs: 300_000, avail: [], survival: (g: number) => g <= 300 ? 1 : 0,
			plan: (prob: number) => prob < 0.5 ? p : null, latency: () => 40_000 };
		expect(want(x)).toMatchObject({ p, start: 321_000, gapS: 301 });
		expect(want({ ...x, now: 350_000 })?.start).toBe(321_000); // fixed deadline: due now, no drift
		expect(want({ ...x, avail: [{ key: p.firstKeptEntryId!, running: true }] })).toBeNull();
		expect(want({ ...x, at: "decision", candidate: p })?.start).toBe(x.now);
		expect(want({ ...x, at: "settle", plan: () => p })?.start).toBe(x.now);
		expect(want({ ...x, plan: () => null })).toBeNull();
	});
});
