// The plan's law (formal/TRIAGE.md (a) 2 and 3): the whole plan's gate prices the summary call, a refused minimal cut gives way to a
// deeper one that pays, what a plan says it leaves is what it leaves (the folds a cut voids sit inside the prefix it replaces), and a
// plan the law refuses falls back to the plan it would accept.
import { describe, expect, test } from "bun:test";
import { buildBlocks, lawTerms, planContext, type PlanOpts } from "../src/plan.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, R, U, type Any } from "./helpers.ts";

const ANTH = lawPrices("explicit", false)!;
const base: PlanOpts = { cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 }, warmSummaryGate: true, lookahead: false, narrativePrice: true };
const law = (pWarm: number, g: number) => ({ pr: ANTH, g, pWarm });

describe("the whole plan's gate prices the summary call", () => {
	// 20K tokens of prose, a small turn, then the protected window
	const ctx = [U("u1", "one"), AX("x1", 80_000), U("u2", "two"), AX("y", 4_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("every plan step with a cut carries the call: its K is the summary step's K plus the rewrite of what is left", () => {
		const trace: Any[] = [];
		planContext(ctx, { ...base, mode: "warm", coldCap: 20_000, law: law(1, 500), trace });
		const pairs = trace.flatMap((t, i) => (t.where === "plan" && trace[i - 1]?.where === "summary" ? [[trace[i - 1], t]] : []));
		expect(pairs.length).toBeGreaterThan(0);
		for (const [sum, plan] of pairs) expect(plan.K).toBeGreaterThan(sum.K); // old code: the plan's K = (w - r) A, a few K against the call's 30K
	});
	test("a cut whose call the whole plan cannot pay is not written: the next cut that pays is", () => {
		const trace: Any[] = [];
		const p = planContext(ctx, { ...base, mode: "warm", coldCap: 20_000, law: law(1, 500), trace })!;
		expect(trace.some((t) => t.where === "plan" && !t.ok)).toBe(true);
		expect(p.cutIdx).not.toBeNull();
		expect(p.firstKeptEntryId).not.toBe("u2"); // the minimal cut: its summary passed the summary gate, the plan did not
		const last = trace.filter((t) => t.where === "plan").at(-1);
		expect(last.ok).toBe(true);
		expect(last.K).toBe(lawTerms(last.B, last.A, 1, null, ANTH, 500, last.K - lawTerms(last.B, last.A, 1, null, ANTH, 500, 0, last.T).K, last.T).K);
	});
});

describe("a refused minimal cut gives way to a deeper one", () => {
	// two prose turns: the gain of a summary grows as D^2, the call only as the prefix read
	const ctx = [U("u1", "one"), AX("x1", 40_000), A("a1"), U("u2", "two"), AX("x2", 40_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("warm: the minimal cut's summary is refused, the deeper cut's passes both gates", () => {
		const trace: Any[] = [];
		const p = planContext(ctx, { ...base, mode: "warm", coldCap: 20_000, law: law(1, 300), trace });
		const sums = trace.filter((t) => t.where === "summary").map((t) => t.ok);
		expect(sums.at(-1)).toBe(true);
		expect(sums.slice(0, -1).every((ok) => !ok)).toBe(true); // the cuts inside the first turn (10K tokens read) are refused one by one
		expect(p?.firstKeptEntryId).toBe("a2"); // old code: null (only the minimal cut was gated)
	});
	test("the shallower cuts stay the choice when they pay: the first cut that reaches the cap is still the first tried", () => {
		const p = planContext(ctx, { ...base, mode: "warm", coldCap: 20_000, law: law(1, 100) });
		expect(p?.firstKeptEntryId).toBe("a1");
	});
});

describe("what a plan says it leaves is what it leaves", () => {
	// an old 120K output is folded; the prose after it is summarised; the fold lies inside the prefix and is void
	const ctx = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 120_000), A("a1b"), U("u2", "two"), AX("x1", 80_000), A("a2"), U("u3", "three"), A("a3"), U("u4", "four")];
	test("folds inside the replaced prefix do not count back: after = kept + summary", () => {
		const p = planContext(ctx, { ...base, mode: "warm", coldCap: 20_000, law: law(1, 500) });
		expect(p?.cutIdx).not.toBeNull(); // old code: null (the plan believed it left the voided fold's savings more, 30K, and the law refused)
		const blocks = buildBlocks(ctx);
		const kept = blocks.slice(p!.cutIdx!).reduce((a, b) => a + b.tokens, 0);
		const after = p!.ctxAfterFolds - (p!.prefixTokens - p!.summaryTokensPlanned);
		expect(after).toBeCloseTo(kept + p!.summaryTokensPlanned, 0);
	});
});

describe("a plan the law refuses falls back to the plan a warm cache would make (cold at 0 < P < 0.5)", () => {
	// a 120K-token prose turn, a previous turn with a 30K rereadable output, the current turn with 20K: the cold plan's relax fold of the
	// previous turn's output is refused by the law at P = 0.49 (it is small next to what a rewrite costs), and with it no summary was
	// planned; the warm plan (no relax folds) summarises the prose and the law accepts that
	const ctx = [U("u1", "one"), AX("x1", 120_000), A("a1"), U("u2", "two"), A("a2", ["c2"]), R("r2", "c2", 30_000), A("a2b"), U("u3", "three"), A("a3", ["c3"]), R("r3", "c3", 20_000), A("a3b")];
	const o = { ...base, coldCap: 40_000, law: law(0.49, 200) };
	test("cold at P = 0.49 writes the summary the warm plan at P = 0.51 writes", () => {
		const warm = planContext(ctx, { ...o, mode: "warm", law: law(0.51, 200) });
		expect(warm?.cutIdx).not.toBeNull();
		const cold = planContext(ctx, { ...o, mode: "cold" });
		expect(cold?.firstKeptEntryId).toBe(warm!.firstKeptEntryId);
	});
	test("a cold plan the law accepts is not replaced (P = 0: the relax folds and no fallback)", () => {
		expect(planContext(ctx, { ...o, mode: "cold", law: law(0, 200) })?.folds.some((f) => f.trig === "cold(relax)")).toBe(true);
	});
});
