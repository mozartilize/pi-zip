// Fork planner suite: upstream's test/planlaw.test.ts run against src/plan-fork.ts, plus fork-only cases.
// The plan's law (formal/TRIAGE.md (a) 2 and 3): the whole plan's gate prices the summary call, a refused minimal cut gives way to a
// deeper one that pays, what a plan says it leaves is what it leaves (the folds a cut voids sit inside the prefix it replaces), and
// one planner: the candidates do not depend on P, so a lower P never plans less.
import { describe, expect, test } from "bun:test";
import { buildBlocks, lawTerms, type PlanOpts } from "../src/plan.ts";
import { planContext } from "../src/plan-fork.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, R, U, type Any } from "./helpers.ts";

const ANTH = lawPrices("explicit", false)!;
const base: PlanOpts = { cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 } };
const savedSummaryAt = process.env.PI_ZIP_SUMMARY_AT;
process.env.PI_ZIP_SUMMARY_AT = "0"; // this file tests economic law pricing, not the pressure threshold
import { afterAll } from "bun:test";
afterAll(() => { if (savedSummaryAt === undefined) delete process.env.PI_ZIP_SUMMARY_AT; else process.env.PI_ZIP_SUMMARY_AT = savedSummaryAt; });
const law = (pWarm: number, g: number) => ({ pr: ANTH, g, pWarm });

describe("the whole plan's gate prices the summary call", () => {
	// 20K tokens of prose, a small turn, then the protected window
	const ctx = [U("u1", "one"), AX("x1", 80_000), U("u2", "two"), AX("y", 8_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("every plan step with a cut carries the call: its K is the summary step's K plus the rewrite of what is left", () => {
		const trace: Any[] = [];
		planContext(ctx, { ...base, coldCap: 20_000, law: law(1, 400), trace });
		const pairs = trace.flatMap((t, i) => (t.where === "plan" && t.cut && trace[i - 1]?.where === "summary" ? [[trace[i - 1], t]] : []));
		expect(pairs.length).toBeGreaterThan(0);
		for (const [sum, plan] of pairs) expect(plan.K).toBeGreaterThan(sum.K); // old code: the plan's K = (w - r) A, a few K against the call's 30K
	});
	test("a cut whose call the whole plan cannot pay is not written: the next cut that pays is", () => {
		const trace: Any[] = [];
		const p = planContext(ctx, { ...base, coldCap: 20_000, law: law(1, 420), trace })!;
		expect(trace.some((t) => t.where === "plan" && !t.ok)).toBe(true);
		expect(p.cutIdx).not.toBeNull();
		expect(p.firstKeptEntryId).not.toBe("u2"); // the minimal cut: its summary passed the summary gate, the plan did not
		const last = trace.filter((t) => t.where === "plan").at(-1);
		expect(last.ok).toBe(true);
		expect(last.K).toBe(lawTerms(last.B, last.A, 1, null, ANTH, 420, last.K - lawTerms(last.B, last.A, 1, null, ANTH, 420, 0, last.T).K, last.T).K);
	});
});

describe("a refused minimal cut gives way to a deeper one", () => {
	// two prose turns: the gain of a summary grows as D^2, the call only as the prefix read
	const ctx = [U("u1", "one"), AX("x1", 40_000), A("a1"), U("u2", "two"), AX("x2", 40_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("warm: the minimal cut's summary is refused, the deeper cut's passes both gates", () => {
		const trace: Any[] = [];
		const p = planContext(ctx, { ...base, coldCap: 20_000, law: law(1, 300), trace });
		const sums = trace.filter((t) => t.where === "summary").map((t) => t.ok);
		expect(sums.at(-1)).toBe(true);
		expect(sums.slice(0, -1).every((ok) => !ok)).toBe(true); // the cuts inside the first turn (10K tokens read) are refused one by one
		expect(p?.firstKeptEntryId).toBe("a2"); // old code: null (only the minimal cut was gated)
	});
	test("the shallower cuts stay the choice when they pay: the first cut that reaches the cap is still the first tried", () => {
		const p = planContext(ctx, { ...base, coldCap: 20_000, law: law(1, 100) });
		expect(p?.firstKeptEntryId).toBe("a1");
	});
});

describe("what a plan says it leaves is what it leaves", () => {
	// an old 120K output is folded; the prose after it is summarised; the fold lies inside the prefix and is void
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 120_000), A("a1b"), U("u2", "two"), AX("x1", 80_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("folds inside the replaced prefix do not count back: after = kept + summary", () => {
		const p = planContext(ctx, { ...base, coldCap: 20_000, law: law(1, 400) });
		expect(p?.cutIdx).not.toBeNull(); // old code: null (the plan believed it left the voided fold's savings more, 30K, and the law refused)
		const blocks = buildBlocks(ctx);
		const kept = blocks.slice(p!.cutIdx!).reduce((a, b) => a + b.tokens, 0);
		const after = p!.ctxAfterFolds - (p!.prefixTokens - p!.summaryTokensPlanned);
		expect(after).toBeCloseTo(kept + p!.summaryTokensPlanned, 0);
	});
});

describe("one planner: P enters only the law, so a lower P never plans less (MP structural)", () => {
	// a 120K-token prose turn, a previous turn with a 30K rereadable output, the current turn with 20K. v0.3.1 planned a cold return at
	// P = 0.49 with the previous turn's relax fold, which the law refused, and had to re-plan "warm style"; the candidates are now the
	// same at every P (the pause decides the previous turn, not P), and the law accepts at a lower P whatever it accepts at a higher one
	const ctx = [U("u1", "one"), AX("x1", 120_000), A("a1"), U("u2", "two"), A("a2", ["c2"]), R("r2", "c2", 30_000), A("a2b"), U("u3", "three"), A("a3", ["c3"]), R("r3", "c3", 20_000), A("a3b")];
	const o = { ...base, coldCap: 40_000 };
	const ids = (p: Any) => (p ? [...p.folds.map((f: Any) => f.entryId).sort(), p.firstKeptEntryId] : null);
	test("the same plan at P = 0.49 and P = 0.51; at P = 0 the same edits", () => {
		const warm = planContext(ctx, { ...o, law: law(0.51, 200) });
		expect(warm?.cutIdx).not.toBeNull();
		expect(ids(planContext(ctx, { ...o, law: law(0.49, 200) }))).toEqual(ids(warm));
		expect(ids(planContext(ctx, { ...o, law: law(0, 200) }))).toEqual(ids(warm));
	});
	test("after a pause the previous turn's re-readable output is a candidate too; without one it never is, at any P", () => {
		expect(planContext(ctx, { ...o, pause: true, law: law(0, 200) })!.folds.some((f) => f.trig.endsWith("(relax)"))).toBe(true);
		for (const p of [0, 0.49, 1]) expect(planContext(ctx, { ...o, law: law(p, 200) })?.folds.some((f) => f.trig.endsWith("(relax)")) ?? false).toBe(false);
	});
	test("monotone in P: on a grid of P every edit planned at a higher P is planned at every lower P", () => {
		for (const pause of [false, true]) {
			const grid = [0, 0.1, 0.25, 0.49, 0.5, 0.75, 0.9, 1].map((p) => planContext(ctx, { ...o, pause, law: law(p, 200) }));
			for (let i = 0; i < grid.length; i++) for (let j = i + 1; j < grid.length; j++) if (grid[j]) {
				expect(grid[i]).not.toBeNull();
				for (const f of grid[j]!.folds) expect(grid[i]!.folds.map((x) => x.entryId)).toContain(f.entryId);
				if (grid[j]!.cutIdx !== null) expect(grid[i]!.cutIdx).not.toBeNull();
			}
		}
	});
});
