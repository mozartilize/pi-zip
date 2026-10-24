import { afterEach, describe, expect, test } from "bun:test";
import { applyPlanToMessages, buildBlocks, compactionRoom, contentKeyOf, plan, planContext, selectPlan, settings, SUMMARY_PRESSURE_CAP, summaryPrepareThreshold, summaryThreshold, type Cut, type FoldTarget, type PlanOpts, type RunPlan } from "../src/plan.ts";
import { candidateOf, decideEdits, decideTurnEnd } from "../src/core.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, flat, longTurn, R, U, type Any } from "./helpers.ts";
import { validateEdits } from "../src/guard.ts";
const blockIdx = (blocks: { entryId: string | null }[], id: string) => blocks.findIndex((b) => b.entryId === id);

// a small working view: these sessions are a few thousand tokens, and below the working view nothing is planned
const opts = (over: Partial<PlanOpts> = {}): PlanOpts => ({ coldCap: 1000, cwd: process.cwd(), promptPending: true, ...over });
/** The law at P(warm) `p` with the explicit class ratios (the planner's default is P = 0). */
const at = (p: number, g = 2_500) => ({ pr: lawPrices("explicit", false), g, pWarm: p });
const foldIds = (p: { folds: FoldTarget[] } | null) => p?.folds.map((t) => t.entryId) ?? [];

// settle view of a finished run: 2 user turns, big outputs in both
const prevRun = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4")];

describe("cold plan", () => {
	test("settle plan is non-empty once an older turn has big outputs; the newest turn's outputs stay protected", () => {
		const p = planContext(prevRun, opts());
		expect(p!.folds.map((t) => t.entryId)).toEqual(["r1"]);
	});

	test("a one-user-turn session plans nothing (that turn is protected once the prompt arrives)", () => {
		const one = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2")];
		expect(planContext(one, opts())).toBeNull();
		expect(planContext(one, opts({ promptPending: false }))).toBeNull();
	});
	test("below the working view nothing is planned, whatever P (one planner: P enters only the law)", () => {
		for (const p of [0, 0.3, 1]) expect(planContext(prevRun, opts({ coldCap: 60_000, law: at(p) }))).toBeNull();
		expect(foldIds(planContext(prevRun, opts({ law: at(0) })))).toEqual(["r1"]);
	});

	test("run-start view (prompt in context) selects the identical set with byte-identical placeholders (F8)", () => {
		const settle = planContext(prevRun, opts())!;
		const run = planContext([...prevRun, U("u3", "back")], opts({ promptPending: false }))!;
		expect(run.folds.map((t) => t.entryId)).toEqual(settle.folds.map((t) => t.entryId));
		expect(run.folds[0].ph).toBe(settle.folds[0].ph);
		expect(run.folds[0].ph.length).toBeGreaterThan(100);
	});

	test("nothing below foldMin tokens and nothing recalled is folded (F4)", () => {
		const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 9000), A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2", 300), A("a4"), U("u3", "three"), A("a5")];
		expect(planContext(ctx, opts({ promptPending: false }))!.folds.map((t) => t.entryId)).toEqual(["r1"]);
		const h = planContext(ctx, opts({ promptPending: false }))!.folds[0];
		const { handleFor } = require("../src/placeholder.ts");
		expect(planContext(ctx, opts({ promptPending: false, recalled: new Set([handleFor("r1")]) }))).toBeNull();
		expect(h.recover).toBe("rereadable");
	});

	test("images are never folded", () => {
		const img = R("r1", "c1");
		(img.messages[0] as any).content = [{ type: "text", text: "y".repeat(9000) }, { type: "image", data: "x", mimeType: "image/png" }];
		const ctx = [U("u1", "one"), A("a1", ["c1"]), img, A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(ctx, opts({ promptPending: false }))).toBeNull();
	});
});

describe("after a pause (previous user turn)", () => {
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
	test("no pause: the previous turn is protected, at any P", () => {
		for (const p of [0, 1]) expect(planContext(ctx, opts({ promptPending: false, law: at(p) }))).toBeNull();
	});
	test("after a pause: a rereadable previous-turn output folds while above the working view", () => {
		const p = planContext(ctx, opts({ promptPending: false, pause: true }))!;
		expect(p.folds.map((f) => f.trig)).toEqual(["cold(relax)"]);
	});
	test("after a pause but under the working view: nothing folds", () => {
		expect(planContext(ctx, opts({ coldCap: 60_000, promptPending: false, pause: true }))).toBeNull();
	});
	test("a pause never takes the latest user turn's own outputs, nor non-rereadable ones", () => {
		const own = [U("u1", "one"), A("a1"), U("u2", "back"), A("a2", ["c1"]), R("r1", "c1")];
		expect(planContext(own, opts({ promptPending: false, pause: true }))).toBeNull();
		const mutating = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "back")];
		(mutating[1].messages[0] as any).content[1].arguments = { command: "npm test" };
		expect(planContext(mutating, opts({ promptPending: false, pause: true }))).toBeNull();
	});
});

describe("summary gate", () => {
	const sumCtx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 44_000), AX("a2", 120_000), U("u2", "two"), A("a3", ["c3"]), R("r3", "c3", 44_000), AX("a4", 120_000), U("u3", "three"), A("a5")];
	const sumOpts = (over: Partial<PlanOpts> = {}): PlanOpts => opts({ coldCap: 6000, model: { contextWindow: 50_000 }, ...over });
	test("a big prefix plans the same cut in the settle and run-start views; folds before the cut are void", () => {
		const s = planContext(sumCtx, sumOpts())!;
		const r = planContext([...sumCtx, U("u4", "back")], sumOpts({ promptPending: false }))!;
		expect(s.cutIdx).not.toBeNull();
		expect(s.firstKeptEntryId).toBe("u3");
		expect(r.firstKeptEntryId).toBe("u3");
		expect(s.prefixTokens).toBe(r.prefixTokens);
		expect(s.folds).toHaveLength(0);
	});
	test("a cut records the hard summary room: the largest summary whose compacted view still fits the model's room (above the soft target)", () => {
		const o = sumOpts();
		const s = planContext(sumCtx, o)!;
		const room = compactionRoom(o.model, o.reserve)!;
		expect(s.summaryRoomTokens).toBeDefined();
		expect(s.summaryRoomTokens!).toBeGreaterThan(s.summaryTokensPlanned);
		const after = (S: number) => s.ctxAfterFolds - s.scale.c * (s.prefixTokens - S);
		expect(after(s.summaryRoomTokens!)).toBeLessThanOrEqual(room);
		expect(after(s.summaryRoomTokens! + 1)).toBeGreaterThan(room);
		expect(planContext(sumCtx, sumOpts({ model: {} }))?.summaryRoomTokens).toBeUndefined(); // no known window: no hard bound
	});
	test("successive warm summaries pay below the previous starting size without a regrowth budget", () => {
		const o = sumOpts({ promptPending: false, law: at(1, 500) });
		const first = planContext([...sumCtx, U("u4", "back")], o)!;
		const summary = "S".repeat(4 * first.summaryTokensPlanned);
		const comp = { sourceEntry: { type: "compaction", id: "cmp", details: { by: "pi-zip" } }, messages: [{ role: "compactionSummary", summary }] };
		const view = [comp, U("u3", "three"), AX("a5", 160_000), U("u4", "four"), A("a6"), U("u5", "five"), A("a7")];
		const second = planContext(view, o)!;
		expect(second.ctxAfterFolds).toBeLessThan(first.ctxAfterFolds);
		expect(second.firstKeptEntryId).toBe("u4");
		expect(second.prefixTokens).toBeGreaterThanOrEqual(2 * second.summaryTokensPlanned);
		// The new turn boundary makes fresh prose eligible; the protected turns and the carried summary still stay.
		expect(second.blocks[second.cutIdx!].userTurn).toBe(second.userTurns - 1);
	});
	test("the next summary is planned at least as big as the previous one it carries (no re-summary of a small new prefix)", () => {
		const SUM = "S".repeat(48_000); // previous summary ~12K tokens, as in a real migrated session
		const comp = { sourceEntry: { id: "cmp", type: "compaction", summary: SUM, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: SUM, content: SUM }] };
		const view = [comp, U("k1", "one"), A("a1", ["c1"]), R("r1", "c1", 14_000), AX("a2", 8_000), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		// prefix ~18K: a 1.8K planned summary would remove 16K; planned at >= 12K it removes ~6K, which does not pay for its call
		expect(planContext(view, sumOpts({ promptPending: false }))?.cutIdx ?? null).toBeNull();
	});
	test("no summary when it does not pay for its call (small context)", () => {
		const small = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 3000), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		expect(planContext(small, sumOpts({ coldCap: 100, promptPending: false }))?.cutIdx ?? null).toBeNull();
	});
});

describe("applyPlanToMessages", () => {
	const cold3 = [...prevRun, U("u3", "back after the idle")];
	const visible = flat(cold3);
	const base = () => {
		const p = planContext(cold3, opts({ promptPending: false }))!;
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds, ms: 0, persisted: false };
		return { p, plan };
	};
	test("folds with the plan's exact placeholder text and touches nothing else", () => {
		const { p, plan } = base();
		const out = applyPlanToMessages(visible, plan)!;
		const r1 = out.messages.find((m: any) => m.toolCallId === "c1");
		expect(r1.content).toEqual([{ type: "text", text: p.folds[0].ph }]);
		out.messages.forEach((m: any, i: number) => { if (m.toolCallId !== "c1") expect(m).toBe(visible[i]); });
	});
	test("a persisted plan, an empty plan, no plan, and an already-folded result all apply nothing", () => {
		const { plan } = base();
		expect(applyPlanToMessages(visible, { ...plan, persisted: true })).toBeNull();
		expect(applyPlanToMessages(visible, null)).toBeNull();
		expect(applyPlanToMessages(visible, { ...plan, folds: [] })).toBeNull();
		const folded = applyPlanToMessages(visible, plan)!.messages;
		expect(applyPlanToMessages(folded, plan)).toBeNull();
	});

});
describe("recall results and reused tool call ids", () => {
	test("a zip_recall result is never folded (it is the content the model just asked for)", () => {
		const rec = R("r1", "c1");
		(rec.messages[0] as any).toolName = "zip_recall";
		(rec.sourceEntry.message as any).toolName = "zip_recall";
		const call = A("a1", ["c1"]);
		(call.messages[0] as any).content[1].name = "zip_recall";
		const ctx = [U("u1", "one"), call, rec, R("r2", "c2"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];
		ctx.splice(3, 1, { ...R("r2", "c2"), messages: [{ ...R("r2", "c2").messages[0], toolCallId: "c2" }] });
		expect(foldIds(planContext(ctx, opts({ promptPending: false })))).not.toContain("r1");
	});
	test("a server that reuses tool call ids (call_0): each result is folded by its own position and content", () => {
		const mk = (id: string, ch: string) => R(id, "call_0", 9000, `${ch} `.repeat(4500));
		const ctx = [U("u1", "one"), A("a1", ["call_0"]), mk("r1", "x"), A("a2"), U("u2", "two"), A("a3", ["call_0"]), mk("r2", "y"), A("a4"), U("u3", "three"), A("a5", ["call_0"]), mk("r3", "z"), A("a6"), U("u4", "four"), A("a7")];
		const p = planContext(ctx, opts({ promptPending: false }))!;
		expect(p.folds.map((t) => t.entryId)).toEqual(["r1", "r2"]);
		const plan: RunPlan = { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const out = applyPlanToMessages(flat(ctx), plan)!.messages.filter((m: any) => m.role === "toolResult");
		expect(out[0].content[0].text).toBe(p.folds[0].ph);
		expect(out[1].content[0].text).toBe(p.folds[1].ph);
		expect(out[2].content[0].text.startsWith("z z")).toBe(true); // the third result, same id, untouched
		// the request view shifted (steering message in front): position no longer matches, content still does
		const shifted = applyPlanToMessages([{ role: "user", content: "steering" }, ...flat(ctx)], plan)!.messages.filter((m: any) => m.role === "toolResult");
		expect(shifted[0].content[0].text).toBe(p.folds[0].ph);
		expect(shifted[1].content[0].text).toBe(p.folds[1].ph);
		expect(shifted[2].content[0].text.startsWith("z z")).toBe(true);
		// two identical results under one id and only one planned: ambiguity is never guessed (left unfolded)
		const dupe = [U("u1", "one"), A("a1", ["call_0"]), mk("r1", "x"), A("a2"), U("u2", "two"), A("a3", ["call_0"]), mk("r2", "x"), A("a4"), U("u3", "three"), A("a5"), U("u4", "four"), A("a6")];
		const pd = planContext(dupe, opts({ promptPending: false }))!;
		const onlyFirst: RunPlan = { source: "runstart", folds: [pd.folds[0]], cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		expect(applyPlanToMessages([{ role: "user", content: "steering" }, ...flat(dupe)], onlyFirst)).toBeNull(); // nothing applied
		const inPlace = applyPlanToMessages(flat(dupe), onlyFirst)!.messages.filter((m: any) => m.role === "toolResult"); // unshifted: position decides
		expect(inPlace[0].content[0].text).toBe(pd.folds[0].ph);
		expect(inPlace[1].content[0].text.startsWith("x x")).toBe(true);
	});
});
test("folds already saved in the old placeholder format stay byte-identical: they are never re-rendered", () => {
	const old = '[folded by pi-zip · bash ls · 9000 chars, 1 lines · handle abcdefghij]\nFull original is saved and stays recallable even after later summaries or compaction: call zip_recall("abcdefghij") to get it back exactly (optionally with grep or range). Do not guess its content.';
	const e = R("r1", "c1");
	const saved = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: old }] }] };
	const entries = [U("u1", "one"), A("a1", ["c1"]), saved, A("a2"), U("u2", "two"), A("a3", ["c2"]), R("r2", "c2"), A("a4"), U("u3", "three"), A("a5"), U("u4", "back")];
	const p = planContext(entries, opts({ promptPending: false }))!;
	expect(p.folds.map((t) => t.entryId)).toEqual(["r2"]); // the saved fold is not a candidate again
	expect(p.folds[0].ph).toContain("· turn 2 ·"); // new folds get the new format
	expect(applyPlanToMessages(flat(entries), { source: "runstart", folds: p.folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false })!.messages.find((m: Any) => m.toolCallId === "c1").content[0].text).toBe(old);
	expect(buildBlocks(entries)[2]).toMatchObject({ edited: true, ours: true });
});

const buildBlocksEntries = () => [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1"), A("a2"), U("u2", "two"), A("a3"), U("u3", "three"), A("a4")];

test("buildBlocks flags our placeholders as ours and foreign edits as edited", () => {
	const e = R("r1", "c1");
	const folded = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "[folded by pi-zip · x]" }] }] };
	const foreign = { sourceEntry: e.sourceEntry, messages: [{ ...e.messages[0], content: [{ type: "text", text: "someone else" }] }] };
	expect(buildBlocks([folded])[0]).toMatchObject({ edited: true, ours: true });
	expect(buildBlocks([foreign])[0]).toMatchObject({ edited: true, ours: false });
});

// =============================================================================================================
describe("cold cap default", () => {
	const saved = process.env.PI_ZIP_COLD_CAP;
	afterEach(() => { if (saved === undefined) delete process.env.PI_ZIP_COLD_CAP; else process.env.PI_ZIP_COLD_CAP = saved; });

	test("40K real tokens by default; PI_ZIP_COLD_CAP still overrides", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		expect(settings().coldCap).toBe(40_000);
		process.env.PI_ZIP_COLD_CAP = "25000";
		expect(settings().coldCap).toBe(25_000);
	});

	test("a ~45K prose context exceeds the fold target but does not authorize a summary", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		delete process.env.PI_ZIP_SUMMARY_AT;
		const prose = [U("u1", "one"), AX("x1", 90_000), U("u2", "two"), AX("x2", 90_000), U("u3", "three"), A("a3"), U("u4", "now")]; // ~45K tokens of prose
		expect(planContext(prose, { cwd: ".", promptPending: false, model: { contextWindow: 200_000 } })).toBeNull();
		expect(planContext(prose, { cwd: ".", promptPending: false, coldCap: 60_000 })).toBeNull(); // below the working view: no plan at all
	});
});

describe("summary pressure gate and tuning diagnostics", () => {
	const saved = { cap: process.env.PI_ZIP_COLD_CAP, at: process.env.PI_ZIP_SUMMARY_AT };
	afterEach(() => {
		if (saved.cap === undefined) delete process.env.PI_ZIP_COLD_CAP; else process.env.PI_ZIP_COLD_CAP = saved.cap;
		if (saved.at === undefined) delete process.env.PI_ZIP_SUMMARY_AT; else process.env.PI_ZIP_SUMMARY_AT = saved.at;
	});

	test("application threshold caps at 400K while preparation keeps its 200K-window cap, with PI_ZIP_SUMMARY_AT override", () => {
		delete process.env.PI_ZIP_SUMMARY_AT;
		const room = compactionRoom({ contextWindow: 100_000 }, 16_384)!;
		expect(room).toBe(75_424);
		expect(summaryThreshold(room)).toBeCloseTo(60_339.2, 6);
		expect(summaryPrepareThreshold(room)).toBeCloseTo(60_339.2, 6);
		// Application scales with room up to 400K; preparation still caps at 200K's 140,339.2.
		expect(SUMMARY_PRESSURE_CAP).toBeCloseTo(140_339.2, 6);
		expect(summaryThreshold(compactionRoom({ contextWindow: 200_000 }, 16_384))).toBeCloseTo(140_339.2, 6);
		expect(summaryThreshold(compactionRoom({ contextWindow: 272_000 }, 16_384))).toBeCloseTo(197_939.2, 6);
		expect(summaryThreshold(compactionRoom({ contextWindow: 500_000 }, 16_384))).toBeCloseTo(380_339.2, 6);
		expect(summaryThreshold(compactionRoom({ contextWindow: 1_000_000 }, 16_384))).toBe(400_000);
		expect(summaryThreshold(499_999)).toBeCloseTo(399_999.2, 6);
		expect(summaryThreshold(500_000)).toBe(400_000);
		expect(summaryThreshold(500_001)).toBe(400_000);
		expect(summaryPrepareThreshold(compactionRoom({ contextWindow: 200_000 }, 16_384))).toBeCloseTo(140_339.2, 6);
		expect(summaryPrepareThreshold(compactionRoom({ contextWindow: 272_000 }, 16_384))).toBeCloseTo(140_339.2, 6);
		expect(summaryPrepareThreshold(compactionRoom({ contextWindow: 1_000_000 }, 16_384))).toBeCloseTo(140_339.2, 6);
		expect(summaryThreshold(null)).toBe(Infinity);
		expect(summaryPrepareThreshold(null)).toBe(Infinity);
		process.env.PI_ZIP_SUMMARY_AT = "50000";
		expect(summaryThreshold(room)).toBe(50_000);
		expect(summaryPrepareThreshold(room)).toBe(50_000);
		process.env.PI_ZIP_SUMMARY_AT = "600000";
		expect(summaryThreshold(975_424)).toBe(600_000); // explicit override is not capped
		expect(summaryPrepareThreshold(975_424)).toBe(600_000);
		expect(summaryThreshold(null)).toBe(600_000);
	});

	test("1M -> 200K/272K mid-run model switch: 1M prepares background summary at 140.3K without applying it; switching to 200K/272K compacts only the prepared prefix and keeps unsummarised later turns", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		delete process.env.PI_ZIP_SUMMARY_AT;
		// While on 1M at ~150K tokens (u1..u4): above prepareThreshold (140.3K) but well below 1M's applyThreshold (780.3K).
		const at150K = [
			U("u1", "old1"), AX("x1", 300_000),
			U("u2", "old2"), AX("x2", 300_000),
			U("u3", "prev"), A("a3"), U("u4", "now"),
		];
		const on1M: PlanOpts = { cwd: ".", promptPending: false, coldCap: 40_000, model: { contextWindow: 1_000_000 }, law: at(0, 2_500) };
		const q1M = plan(at150K, { ...on1M, application: true })!;
		// 1. On 1M, background preparation produces c="u3", but application (a / selectPlan) is withheld so 1M keeps full context.
		expect(q1M.c?.firstKeptEntryId).toBe("u3");
		expect(q1M.a).toBeNull();
		expect(selectPlan(q1M, { ...on1M, application: true })).toBeNull();
		expect(planContext(at150K, on1M)).toBeNull();
		expect(on1M.summaryGate).toMatchObject({ eligible: false, prepareEligible: true, reason: "prepare-only", prepareThreshold: SUMMARY_PRESSURE_CAP });

		// 2. Session grows further on 1M with new unsummarised turns u4..u6 (~80K more tokens => ~230K total), while only u3's summary is READY.
		// Even with u3 READY in memory, staying on 1M at 230K still does NOT apply the summary (< 400K).
		const grown = [
			...at150K,
			AX("x4", 160_000),
			U("u5", "later"), AX("x5", 160_000),
			U("u6", "latest"),
		];
		const still1M: PlanOpts = { cwd: ".", promptPending: false, coldCap: 40_000, model: { contextWindow: 1_000_000 }, ready: ["u3"], readySizes: { u3: 4_000 }, application: true, law: at(0, 2_500) };
		expect(planContext(grown, still1M)).toBeNull();
		expect(still1M.summaryGate).toMatchObject({ eligible: false, prepareEligible: true, reason: "prepare-only" });

		// 3. User switches model mid-run to 272K (threshold 197.9K) or 200K (threshold 140.3K).
		// Now grown (~230K) >= applyThreshold(272K/200K): planner immediately applies the already-ready summary at u3 (0ms wait),
		// compacting only u1..x2 and keeping the unsummarised suffix u3..u6 intact while requesting background preparation for u5.
		for (const contextWindow of [272_000, 200_000]) {
			const switched: PlanOpts = { cwd: ".", promptPending: false, coldCap: 40_000, model: { contextWindow }, ready: ["u3"], readySizes: { u3: 4_000 }, application: true, law: at(0, 2_500) };
			const qSwitched = plan(grown, switched)!;
			expect(qSwitched.c?.firstKeptEntryId).toBe("u5"); // deeper cut wanted for background production
			expect(qSwitched.a?.firstKeptEntryId).toBe("u3"); // ready prefix cut taken now
			const applied = selectPlan(qSwitched, switched)!;
			expect(applied.firstKeptEntryId).toBe("u3"); // compacts only what already has a summary; keeps u3..u6 untouched!
			expect(switched.summaryGate).toMatchObject({ eligible: true, prepareEligible: true, reason: "pressure" });
		}
	});

	test("1M applies a READY prefix above 400K, but only prepares below it", () => {
		delete process.env.PI_ZIP_SUMMARY_AT;
		for (const [chars, eligible] of [[790_000, false], [810_000, true]] as const) {
			const entries = [U("u1", "old"), AX("x1", chars), U("u2", "old"), AX("x2", chars), U("u3", "prev"), A("a3"), U("u4", "now")];
			const o: PlanOpts = { cwd: ".", promptPending: false, coldCap: 40_000, model: { contextWindow: 1_000_000 }, ready: ["u3"], readySizes: { u3: 4_000 }, application: true, law: at(0, 2_500) };
			const q = plan(entries, o)!;
			expect(q.f.ctxAfterFolds > 400_000).toBe(eligible);
			expect(o.summaryGate).toMatchObject({ threshold: 400_000, prepareThreshold: SUMMARY_PRESSURE_CAP, prepareEligible: true, eligible, reason: eligible ? "pressure" : "prepare-only" });
			expect(q.a?.firstKeptEntryId ?? null).toBe(eligible ? "u3" : null);
			expect(selectPlan(q, o)?.firstKeptEntryId ?? null).toBe(eligible ? "u3" : null);
		}
	});

	test("speculative checkpoints refresh for uncovered pressure and material progress, not a new cut ID", () => {
		delete process.env.PI_ZIP_SUMMARY_AT;
		const entries = [U("u1", "old"), AX("x1", 300_000), U("u2", "old"), AX("x2", 300_000), U("u3", "prev"), A("a3"), U("u4", "now")];
		const opts = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => ({ o: { cwd: ".", coldCap: 40_000, model: { contextWindow: 1_000_000 }, promptPending: false, law: at(0, 2500), cutAt, foldsOnly, ready } });
		const ready = [{ key: "u3", running: false, summaryTokens: 4_000 }];
		const decide = () => decideEdits({ at: "turn_end", justEdited: false, pWarm: 0, entries, ready, opts });
		// The new legal cut at u4 adds only two tokens to the existing ~150K prefix. Even an oversized suffix cannot justify it.
		entries.push(AX("x4", 600_000), U("u5", "later"));
		const suppressed = decide();
		expect(suppressed.produce).toBeNull();
		expect(suppressed.o.summaryGate?.checkpoint).toMatchObject({ key: "u3", refresh: false });
		expect(suppressed.o.summaryGate!.checkpoint!.advance).toBeLessThan(10);
		// Once u4 is eligible, substantial new coverage exists and the remaining suffix is under pressure.
		entries.push(AX("x5", 4_000), U("u6", "latest"));
		expect(decide().produce?.firstKeptEntryId).toBe("u5");
		expect(candidateOf(entries, opts, ready, "timer").r.p?.firstKeptEntryId).toBe("u5");
		// Once that checkpoint is ready, no duplicate/full-prefix refresh is needed for the small remainder.
		ready.push({ key: "u5", running: false, summaryTokens: 4_000 });
		expect(decide().produce).toBeNull();
		// Material progress alone is insufficient while the existing checkpoint still covers the small-window return.
		const covered = [U("c1", "old"), AX("cx1", 600_000), U("c2", "covered"), AX("cx2", 200_000), U("c3", "prev"), A("ca3"), U("c4", "now")];
		const q = plan(covered, { ...opts().o, application: true, ready: ["c2"], readySizes: { c2: 4_000 } })!;
		expect(q.c).toBeNull(); // 54K after the checkpoint is below 140K, despite another 50K of eligible coverage
	});

	test("post-fold calibrated context decides summary eligibility: folding below 0.8 * room blocks summary even when pre-fold was above it and cache is cold", () => {
		delete process.env.PI_ZIP_COLD_CAP;
		delete process.env.PI_ZIP_SUMMARY_AT;
		// O=10,000, c=1.5; room(100K)=75,424 => threshold=60,339.2.
		// Before folds: 10,000 + 1.5 * ~55,000 = ~92,500 > threshold.
		// Fold removes ~20,000 est; post-fold: 10,000 + 1.5 * ~35,000 = ~62,500 if prose is 35K, or ~55,000 < threshold if prose is 30K.
		const entries = [
			U("u1", "old"), A("a1", ["c1"]), R("r1", "c1", 80_000), AX("x1", 60_000),
			U("u2", "mid"), AX("x2", 60_000),
			U("u3", "prev"), A("a3"), U("u4", "now"),
		];
		const scale = { O: 10_000, c: 1.5, real: 90_000, est: 53_333, source: "usage" as const, oSource: "first" as const };
		const base: PlanOpts = { cwd: ".", promptPending: false, coldCap: 30_000, scale, model: { contextWindow: 100_000 }, law: at(0, 2_500) };

		const blocked = { ...base };
		const pBlocked = planContext(entries, blocked)!;
		expect(pBlocked.folds.map((f) => f.entryId)).toEqual(["r1"]);
		expect(pBlocked.cutIdx).toBeNull();
		expect(blocked.summaryGate).toMatchObject({ eligible: false, reason: "below-pressure", room: 75_424 });
		expect(blocked.summaryGate!.before).toBeGreaterThan(blocked.summaryGate!.threshold!);
		expect(blocked.summaryGate!.afterFolds).toBeLessThan(blocked.summaryGate!.threshold!);

		// Same post-fold size against a slightly tighter window crosses 0.8 * room and authorizes the summary cut.
		const allowed = { ...base, model: { contextWindow: 90_000 } }; // room 65,424 => threshold 52,339.2 < afterFolds (~55.5K)
		const pAllowed = planContext(entries, allowed)!;
		expect(pAllowed.folds).toHaveLength(0); // r1 is before the cut
		expect(pAllowed.cutIdx).not.toBeNull();
		expect(pAllowed.firstKeptEntryId).toBe("u3");
		expect(allowed.summaryGate).toMatchObject({ eligible: true, reason: "pressure", room: 65_424 });
		expect(allowed.summaryGate!.afterFolds).toBeGreaterThanOrEqual(allowed.summaryGate!.threshold!);
	});

	test("exact threshold boundary and ready-artifact gating: ready summaries are withheld below pressure and applied at/above pressure", () => {
		delete process.env.PI_ZIP_SUMMARY_AT;
		const prose = [U("u1", "one"), AX("x1", 120_000), U("u2", "two"), AX("x2", 120_000), U("u3", "three"), A("a3"), U("u4", "now")];
		const est = buildBlocks(prose).reduce((n, b) => n + b.tokens, 0);
		// Choose summaryThreshold(room) = 0.8 * room around est: room = est / 0.8 => window = room + 16,384 + 8,192.
		const exactWindow = Math.floor(est / 0.8) + 16_384 + 8_192;
		const makeOpts = (contextWindow?: number): PlanOpts => ({
			cwd: ".", promptPending: false, coldCap: 20_000, model: contextWindow ? { contextWindow } : undefined,
			ready: ["u3"], readySizes: { u3: 3_000 }, application: true, law: at(0, 2_500),
		});

		const unknown = makeOpts(undefined);
		expect(planContext(prose, unknown)).toBeNull();
		expect(unknown.summaryGate).toMatchObject({ eligible: false, reason: "unknown-window", threshold: null, room: null });

		const below = makeOpts(exactWindow + 20); // threshold > est
		expect(plan(prose, below)?.a).toBeNull();
		expect(below.summaryGate).toMatchObject({ eligible: false, reason: "below-pressure" });

		const atOrAbove = makeOpts(exactWindow); // threshold <= est
		const selected = planContext(prose, atOrAbove)!;
		expect(selected.firstKeptEntryId).toBe("u3");
		expect(atOrAbove.summaryGate).toMatchObject({ eligible: true, reason: "pressure" });
	});

	test("room safety still compacts when post-fold context reaches Pi's compaction room", () => {
		delete process.env.PI_ZIP_SUMMARY_AT;
		const entries = [U("u1", "one"), AX("x1", 140_000), U("u2", "two"), AX("x2", 140_000), U("u3", "three"), A("a3"), U("u4", "now")];
		const model = { contextWindow: 90_000 }; // room 65,424; entries are ~70K
		const d = decideTurnEnd({
			failed: false, justEdited: false, pWarm: 1, ready: [], entries,
			opts: (cutAt, foldsOnly, ready) => ({ o: { cwd: ".", promptPending: false, coldCap: 20_000, model, law: at(1, 500), ...(cutAt ? { cutAt } : {}), ...(foldsOnly ? { foldsOnly } : {}), ...(ready ? { ready } : {}) } }),
		});
		expect(d.room?.cutIdx).not.toBeNull();
		expect(d.room?.firstKeptEntryId).toBe("u3");
	});
});


// =============================================================================================================
describe("the law at P = 1 (a warm cache)", () => {
	// old turns: `oldOutputs` foldable 9000-char reads; the previous user turn holds one `bigChars` write result that can never be folded
	// (not re-readable), so it stays and decides how much of the context a plan can remove
	const session = (oldOutputs: number, bigChars: number) => {
		const e: Any[] = [];
		for (let t = 0; t < oldOutputs; t++) e.push(U(`u${t}`, `q${t}`), A(`a${t}`, [`c${t}`]), R(`r${t}`, `c${t}`, 9000), A(`z${t}`));
		const call = A("aw", ["cw"]);
		(call.messages[0] as Any).content[1].name = "write";
		const big = R("rw", "cw", bigChars);
		(big.messages[0] as Any).toolName = "write";
		e.push(U("uw", "write it"), call, big, A("zw"), U("uN", "now"));
		return e;
	};
	const warm = (entries: Any[], contextWindow?: number) => planContext(entries, { law: at(1), cwd: ".", promptPending: false, model: contextWindow ? { provider: "p", id: "m", contextWindow } : undefined });

	test("planner: 183K -> 131K is blocked, 200K -> 90K fires (unknown window, V = 160K)", () => {
		const blocked = session(24, 512_000); // ~54K of foldable reads + a ~128K protected write
		const cold = planContext(blocked, { cwd: ".", promptPending: false, coldCap: 1000 })!;
		expect(cold.ctxTokens).toBeGreaterThan(180_000);
		expect(cold.ctxTokens).toBeLessThan(186_000);
		expect(cold.ctxAfterFolds).toBeGreaterThan(128_000);
		expect(cold.ctxAfterFolds).toBeLessThan(134_000);
		expect(warm(blocked)).toBeNull(); // above V, but the plan only cuts ~28%

		const allowed = session(49, 352_000); // ~110K of foldable reads + a ~88K protected write
		const p = warm(allowed)!;
		expect(p).not.toBeNull();
		expect(p.ctxTokens).toBeGreaterThan(195_000);
		expect(p.ctxAfterFolds).toBeLessThan(0.5 * p.ctxTokens);
		expect(p.folds.length).toBe(49);
	});

	test("planner: in the danger zone with nothing to remove the valve has nothing to do", () => {
		const entries = [U("u0", "q"), A("a0", ["cw"]), R("rw", "cw", 720_000), A("z0"), U("uN", "now")];
		(entries[1].messages[0] as Any).content[1].name = "write";
		(entries[2].messages[0] as Any).toolName = "write";
		expect(warm(entries, 200_000)).toBeNull();
	});
});

describe("in-turn folds (PI_ZIP_INTURN_AGE)", () => {
	const saved = process.env.PI_ZIP_INTURN_AGE;
	afterEach(() => { if (saved === undefined) delete process.env.PI_ZIP_INTURN_AGE; else process.env.PI_ZIP_INTURN_AGE = saved; });
	const ids = (p: Any) => p.folds.map((f: Any) => f.entryId).sort();
	const rr = (from: number, to: number, skip: number[] = []) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`).filter((x) => !skip.includes(Number(x.slice(1)))).sort();

	test("default 60, 0 disables; the setting reads PI_ZIP_INTURN_AGE", () => {
		delete process.env.PI_ZIP_INTURN_AGE;
		expect(settings().inturnAge).toBe(60);
		process.env.PI_ZIP_INTURN_AGE = "0";
		expect(settings().inturnAge).toBe(0);
		process.env.PI_ZIP_INTURN_AGE = "35";
		expect(settings().inturnAge).toBe(35);
	});

	test("a single user turn: outputs of every class at least 20 requests old fold; newer and zip_recall results stay", () => {
		delete process.env.PI_ZIP_INTURN_AGE;
		const s = longTurn(60, { mutating: [3, 10, 50], recalls: [7] });
		const p = planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 20 }))!;
		// 61 assistant messages: call i is answered i requests in, so its age is 61 - i; age >= 20  <=>  i <= 41
		expect(ids(p)).toEqual(rr(1, 41, [7])); // the non-rereadable r3 and r10 fold too (final model: one age for every class)
		expect(p.folds.every((f) => f.trig === "cold(inturn)")).toBe(true);
		expect(p.folds.filter((f) => f.recover !== "rereadable").map((f) => f.entryId).sort()).toEqual(["r10", "r3"]);
		expect(p.cutIdx).toBeNull(); // the whole session is the protected turn: nothing to summarise
		expect(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 0 }))).toBeNull();
	});

	test("the boundary is exact: age 20 folds, age 19 stays; a larger setting moves it", () => {
		const s = longTurn(60);
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 20 }))!)).toEqual(rr(1, 41));
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false, inturnAge: 40 }))!)).toEqual(rr(1, 21));
		process.env.PI_ZIP_INTURN_AGE = "30";
		expect(ids(planContext(s, opts({ coldCap: 8000, promptPending: false }))!)).toEqual(rr(1, 31));
	});

	test("folds stop at the cap, biggest first (same order as the sim)", () => {
		const s = longTurn(60);
		// make r5 and r9 much bigger than the rest
		for (const id of ["r5", "r9"]) { const e = s.find((x: Any) => x.sourceEntry.id === id)!; e.messages[0].content[0].text = e.messages[0].content[0].text.repeat(4); }
		const total = buildBlocks(s).reduce((a, b) => a + b.tokens, 0);
		const p = planContext(s, opts({ coldCap: total - 3000, promptPending: false, inturnAge: 20 }))!; // needs ~3K tokens: the two big ones are enough
		expect(ids(p)).toEqual(["r5", "r9"]);
	});

	test("under the cap nothing folds; the settle view and the run-start view agree", () => {
		const s = longTurn(60);
		expect(planContext(s, opts({ coldCap: 1_000_000, promptPending: false }))).toBeNull();
		const settle = planContext(s, opts({ coldCap: 8000 }))!; // prompt pending: the finished turn is the previous one
		const run = planContext([...s, U("u2", "next")], opts({ coldCap: 8000, promptPending: false }))!;
		expect(ids(settle)).toEqual(ids(run));
		expect(settle.folds.map((f) => f.ph)).toEqual(run.folds.map((f) => f.ph));
	});

	test("recalled outputs and outputs below foldMin are never folded in-turn either", () => {
		const { handleFor } = require("../src/placeholder.ts");
		const s = longTurn(60);
		expect(foldIds(planContext(s, opts({ coldCap: 8000, promptPending: false, recalled: new Set([handleFor("r1")]) })))).not.toContain("r1");
		const small = longTurn(60, { chars: 400 });
		expect(planContext(small, opts({ coldCap: 100, promptPending: false }))).toBeNull();
	});

	test("warm valve: a long single-turn session above V folds old outputs when that halves the context", () => {
		const s = longTurn(60, { chars: 24_000 }); // ~4K tokens per output, ~240K estimated (V = 160K)
		const p = planContext(s, opts({ coldCap: 40_000, promptPending: false, law: at(1, 500), inturnAge: 20 }))!;
		expect(p).not.toBeNull();
		expect(p.folds.length).toBeGreaterThan(0);
		expect(p.folds.every((f) => f.trig === "valve(inturn)")).toBe(true);
		expect(p.ctxAfterFolds).toBeLessThanOrEqual(0.5 * p.ctxTokens);
		// ... and not when the age rule is off (nothing else is foldable in one turn)
		expect(planContext(s, opts({ coldCap: 40_000, promptPending: false, law: at(1, 500), inturnAge: 0 }))).toBeNull();
	});

	test("a tool call id reused by the server counts its age from the latest call that used it", () => {
		const s = longTurn(30);
		// results r1 and r30 both answer "call_0"; r1's age must come from the assistant right before it
		for (const id of ["a1", "a30"]) (s.find((x: Any) => x.sourceEntry.id === id)!.messages[0].content[1] as Any).id = "call_0";
		for (const id of ["r1", "r30"]) s.find((x: Any) => x.sourceEntry.id === id)!.messages[0].toolCallId = "call_0";
		const b = buildBlocks(s);
		const age = (id: string) => b.find((x) => x.entryId === id)!.age;
		expect(age("r30")).toBe(1);
		expect(age("r1")).toBe(30);
	});
});

describe("age counts only assistant messages the model is sent", () => {
	test("aborted and final-error assistant messages add no age; the calls they issued still count as issued", () => {
		const mk = (stop: string) => {
			const bad = A("bad", ["c2"]);
			Object.assign(bad.sourceEntry.message, { stopReason: stop });
			Object.assign(bad.messages[0], { stopReason: stop });
			return [U("u1", "go"), A("a1", ["c1"]), R("r1", "c1"), bad, R("r2", "c2"), A("a3"), A("a4")];
		};
		const ageOf = (stop: string) => { const bl = buildBlocks(mk(stop)); return [bl.find((b: Any) => b.entryId === "r1")!.age, bl.find((b: Any) => b.entryId === "r2")!.age]; };
		expect(ageOf("stop")).toEqual([3, 2]);
		expect(ageOf("aborted")).toEqual([2, 2]);
		expect(ageOf("error")).toEqual([2, 2]);
	});
});

describe("native compaction: folds are planned on the resulting projection", () => {
	test("duplicate results are folded by their positions after the native summary", () => {
		const same = "same output line\n".repeat(600);
		const post = [{ sourceEntry: { id: "cmp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: "S", timestamp: 0 }] }, U("u2", "two"), A("a3", ["c9"]), R("r2", "c9", 0, same), A("a4", ["c9"]), R("r3", "c9", 0, same), U("u3", "three"), A("a6"), U("u4", "back")];
		const p = planContext(post, opts({ coldCap: 1000, promptPending: false, foldsOnly: true }))!;
		const folds = p.folds.filter((t) => t.entryId === "r3");
		expect(folds).toHaveLength(1);
		expect(folds[0].visIdx).toBe(5);
		const plan: RunPlan = { source: "settle", folds, cut: null, ctxBefore: 0, ctxAfter: 0, ms: 0, persisted: false };
		const out = applyPlanToMessages(flat(post), plan)!;
		expect(out.applied).toEqual(new Set(["r3"]));
		expect(out.messages[5].content[0].text).toBe(folds[0].ph);
		expect(out.messages[3].content[0].text).toBe(same);
	});
});

// ---- item 5: a custom message that starts a run ends the protected tail like a user prompt ---------------------------------
describe("driven runs (an extension's triggerTurn message): turn boundaries", () => {
	const C = (id: string, text = "drive the owed work") => {
		const m = { role: "custom", customType: "owed-drive", content: text, display: true, timestamp: 1 };
		return { sourceEntry: { id, type: "custom_message" }, messages: [m] };
	};
	const turns = (entries: Any[]) => buildBlocks(entries).map((b) => b.userTurn);

	test("a custom message after a final answer starts a turn; one mid-run (after a tool result) does not; a prompt that follows its own starter is the same turn", () => {
		const e = [U("u1", "first"), A("a1", ["c1"]), R("r1", "c1", 400), A("a2"), C("k1"), A("a3", ["c2"]), R("r2", "c2", 400), C("k2"), A("a4"), C("k3"), U("u2", "typed"), A("a5")];
		// u1 a1 r1 a2 | k1 a3 r2 k2(mid-run: after a tool result) a4 | k3 u2 (one turn) a5
		expect(turns(e)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3]);
	});

	// review P0-2: Pi 1.1.0 stores the prompt FIRST and then the nextTurn / before_agent_start messages that ride with it
	// (agent-session.js prompt); a user message never cleared afterAnswer, so that custom message started a turn of its own: three prompts
	// counted as five turns, and "the current turn and the previous one" covered only the current prompt
	test("a prompt followed by the custom messages Pi stores after it is ONE turn (user then custom, as Pi 1.1.0 appends them)", () => {
		const e = [U("u1", "a"), A("a1"), U("u2", "b"), C("k2"), A("a2"), U("u3", "c"), C("k3"), C("k3b")];
		expect(turns(e)).toEqual([1, 1, 2, 2, 2, 3, 3, 3]); // old code: 1 1 2 3 3 4 5 5
		// a driven run's starter followed by another custom message (before_agent_start of a later prompt is not involved): one turn
		expect(turns([U("u1", "a"), A("a1"), C("k1"), C("k1b"), A("a2")])).toEqual([1, 1, 2, 2, 2]);
		// steering after a final answer (the run goes on) and a custom message after it: the same run
		expect(buildBlocks([U("u1", "a"), A("a1"), U("s1", "also"), C("k1"), A("a2")], new Set(["s1"])).map((b) => b.userTurn)).toEqual([1, 1, 1, 1, 1]);
	});

	// formal TR, round 4: a run that ended in a failed (refused) or aborted request is over; the run an extension's message starts next
	// is a new turn (old code: it joined the failed run's turn, which then stayed protected and kept a 20K output from folding)
	test("a custom message after a failed or aborted request starts a turn (the run ended there)", () => {
		const err = (id: string, stopReason: string) => {
			const message = { role: "assistant", content: [], stopReason, timestamp: 1 };
			return { sourceEntry: { id, type: "message", message }, messages: [message] };
		};
		expect(turns([U("u1", "a"), A("a1", ["c1"]), R("r1", "c1", 400), err("x1", "error"), C("k1"), A("a2")])).toEqual([1, 1, 1, 1, 2, 2]);
		expect(turns([U("u1", "a"), err("x1", "aborted"), C("k1"), A("a2")])).toEqual([1, 1, 2, 2]);
	});

	test("the protected tail with a nextTurn message after each prompt is still the current prompt and the previous one", () => {
		const e: Any[] = [];
		for (let i = 1; i <= 4; i++) e.push(U(`u${i}`, `p${i}`), C(`k${i}`), A(`a${i}`, [`c${i}`]), R(`r${i}`, `c${i}`, 20_000), AX(`e${i}`, 30_000));
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: false, law: at(0, 100), model: { contextWindow: 50_000 } })!;
		// the latest two user turns are prompts 3 and 4: nothing of turn 3 may be cut (old code: turns 6..8 were 3's and 4's, so the
		// window covered only prompt 4 and its nextTurn message, and prompt 3's turn was summarised)
		expect(p.cutIdx).not.toBeNull();
		const firstKept = p.blocks[p.cutIdx!];
		expect(firstKept.userTurn).toBeLessThanOrEqual(3);
		const kept = p.blocks.slice(p.cutIdx!).map((b) => b.entryId);
		for (const id of ["u3", "k3", "a3", "r3", "e3", "u4", "k4"]) expect(kept).toContain(id);
	});

	// formal TR, round 4: a summary may keep from the custom message that started a run (Pi's own cut points include it); before, the
	// first kept block had to be a user or assistant message, so the kept tail in front of a driven run began at the previous turn's
	// final answer (29K of prose kept at a cold return)
	test("a summary before a driven run keeps from the custom message that started it, not from the previous final answer", () => {
		const e = [U("u1", "the one real prompt"), A("a1", ["c1"]), R("r1", "c1", 30_000), AX("a2", 60_000), C("k2"), AX("a3", 400)];
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: true, law: at(0, 100), model: { contextWindow: 40_000 } })!;
		expect(p.cutIdx).not.toBeNull();
		expect(p.firstKeptEntryId).toBe("k2"); // old code: "a2" (the 60K answer stayed)
		expect(validateEdits(p.blocks, { folds: new Map(p.folds.map((f) => [blockIdx(p.blocks, f.entryId), f.ph])), recover: new Map(p.folds.map((f) => [blockIdx(p.blocks, f.entryId), f.recover])), cut: p.cutIdx }, p.userTurns)).toBeNull();
	});

	test("with no custom messages nothing changes (prompts count as before; steering stays in its turn)", () => {
		const e = [U("u1", "a"), A("a1"), U("u2", "b"), A("a2"), U("u3", "c")];
		expect(turns(e)).toEqual([1, 1, 2, 2, 3]);
		const steer = buildBlocks(e, new Set(["u3"])).map((b) => b.userTurn);
		expect(steer).toEqual([1, 1, 2, 2, 2]);
	});

	test("a driven run sequence keeps only the latest run protected: the user's old prompt and the runs after it are summarised, as at a prompt", () => {
		const old = [U("u1", "the one real prompt"), A("a1", ["c0"]), R("r0", "c0", 30_000), A("a2")];
		const driven: Any[] = [];
		for (let i = 1; i <= 6; i++) driven.push(C(`k${i}`), A(`d${i}`, [`x${i}`]), R(`rx${i}`, `x${i}`, 30_000), AX(`e${i}`, 60_000));
		const e = [...old, ...driven];
		const p = planContext(e, { cwd: process.cwd(), coldCap: 3000, promptPending: true, model: { contextWindow: 100_000 } })!;
		// the pending prompt is turn 8, the last run turn 7: only they are protected. Old code: every run belonged to turn 1 and the cut
		// could not pass the real prompt's turn (the protected tail reached back to it: 273K kept of 518K).
		expect(p.cutIdx).not.toBeNull();
		const kept = p.blocks.slice(p.cutIdx!).map((b) => b.entryId);
		expect(kept).toContain("k6");
		expect(kept).not.toContain("k5");
		expect(kept.length).toBeLessThan(p.blocks.length / 2);
	});
});
