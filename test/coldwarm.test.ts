// Cold/warm consistency of the summary decision (research round5/cold-warm.md): F1 warm summary gate, F2 lookahead, F3 narrative price.
import { describe, expect, test } from "bun:test";
import { buildBlocks, finalAnswerIdx, LOOKAHEAD, NARRATIVE_PRICE, planContext, WARM_SUMMARY_GATE, type PlanOpts } from "../src/plan.ts";
import { validateEdits } from "../src/guard.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, U, type Any } from "./helpers.ts";

const ANTH = lawPrices("explicit", false)!;
const SUM = "S".repeat(40_000); // the previous summary, carried forward by the next one (~10K tokens)
const comp = { sourceEntry: { id: "cmp", type: "compaction", summary: SUM, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: SUM, content: SUM }] };
const law = (pWarm: number, g = 2_400) => ({ pr: ANTH, g, pWarm });
const base: PlanOpts = { cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 }, warmSummaryGate: false, lookahead: false, narrativePrice: false };

// the live 14:41 shape: the unprotected prefix is the previous summary and a small turn; the previous user turn (long work, its final
// answer at the end) is protected; the user comes back cold
const slid = [comp, U("k1", "one"), A("a1"), U("u2", "two"), AX("w1", 40_000), AX("w2", 40_000), AX("w3", 40_000), AX("w4", 40_000), A("fin"), U("u3", "back after a while")];
// the live 13:44 shape: a summarisable older turn, the protected window small
const older = [comp, U("k1", "one"), AX("x1", 40_000), AX("x2", 40_000), A("a1"), U("u2", "two"), A("a2"), U("u3", "three")];

describe("defaults", () => {
	test("the shipped switches", () => {
		expect(WARM_SUMMARY_GATE).toBe(true);
		expect(LOOKAHEAD).toBe(false); // F2 is measured but not shipped: +1-4 lost items for 1-2% of cost (cold-warm.md)
		expect(NARRATIVE_PRICE).toBe(true);
	});
});

describe("F2: a cold plan looks one user turn ahead", () => {
	test("nothing summarisable now, the valve would summarise next turn: the cold plan cuts inside the previous turn, before its final answer", () => {
		const o = { ...base, mode: "cold" as const, law: law(0, 500) };
		expect(planContext(slid, o)?.cutIdx ?? null).toBeNull(); // base: folds only (here nothing), the summary waits for the window to slide
		const p = planContext(slid, { ...o, lookahead: true })!;
		expect(p.ahead).toBe(true);
		// the first cut that reaches the cap, inside the previous user turn: its prompt and early work are summarised; the answer the
		// user saw, the new prompt and everything after stay verbatim
		// (the whole plan's law prices the summary call: the first cut, w3, reads too much for the saving, the next one pays)
		expect(p.firstKeptEntryId).toBe("w4");
		const kept = p.blocks.slice(p.cutIdx!).map((b) => b.entryId);
		expect(kept).toEqual(["w4", "fin", "u3"]);
		// with F1 the lookahead prices the valve's summary like the valve would: the minimal cut is refused there (and not written now
		// either), the deeper cut the valve would write at the next prompt pays, and is the one written now
		expect(planContext(slid, { ...o, lookahead: true, warmSummaryGate: true })?.firstKeptEntryId).toBe("w4");
	});
	test("the settle view (prompt pending) plans the same cut as the run-start view (I1: the prepared summary is adopted)", () => {
		const o = { ...base, mode: "cold" as const, law: law(0, 500), lookahead: true };
		const settle = planContext(slid.slice(0, -1), { ...o, promptPending: true })!;
		const run = planContext(slid, o)!;
		expect(settle.firstKeptEntryId).toBe(run.firstKeptEntryId);
		expect(settle.prefixTokens).toBe(run.prefixTokens);
	});
	test("no lookahead when the valve would not fire next turn (small context), nor in warm plans, nor without prices", () => {
		const small = [comp, U("k1", "one"), A("a1"), U("u2", "two"), AX("w1", 4_000), A("fin"), U("u3", "back")];
		expect(planContext(small, { ...base, mode: "cold", law: law(0, 500), lookahead: true })?.cutIdx ?? null).toBeNull();
		expect(planContext(slid, { ...base, mode: "cold", law: law(0, 2_400), lookahead: true })?.cutIdx ?? null).toBeNull(); // the valve's law would not fire
		expect(planContext(slid, { ...base, mode: "warm", law: law(1, 500), lookahead: true })?.ahead).toBeUndefined();
		expect(planContext(slid, { ...base, mode: "cold", lookahead: true })?.ahead).toBeUndefined(); // no prices: the legacy rule, no lookahead
	});
	test("guard: a lookahead cut may lie inside the previous user turn up to its final answer, never past it; other cuts stay outside", () => {
		const blocks = buildBlocks(slid);
		const fin = blocks.findIndex((b) => b.entryId === "fin");
		expect(finalAnswerIdx(blocks, 2)).toBe(fin);
		expect(validateEdits(blocks, { folds: new Map(), cut: fin, ahead: true }, 3)).toBeNull();
		expect(validateEdits(blocks, { folds: new Map(), cut: fin }, 3)).toMatch(/inside the last/);
		expect(validateEdits(blocks, { folds: new Map(), cut: fin + 1, ahead: true }, 3)).toMatch(/inside the last/);
	});
});

describe("F1: a warm summary passes the summary gate too", () => {
	test("a summary the gate refuses is not written warm either", () => {
		const o = { ...base, mode: "warm" as const, coldCap: 20_000, law: law(1, 500), trace: [] as Any[] };
		// without F1 the valve skipped the summary gate; the whole plan's law prices the call too (TRIAGE (a) 2), so a summary whose call
		// does not pay is refused there instead
		const f0 = { ...o, trace: [] as Any[] };
		expect(planContext(older, f0)?.cutIdx ?? null).toBeNull();
		expect(f0.trace.some((t: Any) => t.where === "plan" && !t.ok)).toBe(true);
		expect(f0.trace.some((t: Any) => t.where === "summary")).toBe(false);
		const f1 = { ...o, warmSummaryGate: true, trace: [] as Any[] };
		expect(planContext(older, f1)?.cutIdx ?? null).toBeNull();
		expect(f1.trace.some((t: Any) => t.where === "summary" && !t.ok)).toBe(true);
	});
});

describe("F3: the summary call is priced as the narrative call it is", () => {
	test("the carried-forward previous summary is not priced as model output: the cold gate accepts what w X + out S refused", () => {
		const o = { ...base, mode: "cold" as const, coldCap: 20_000, law: law(0, 500), trace: [] as Any[] };
		expect(planContext(older, o)?.cutIdx ?? null).toBeNull();
		const f3 = { ...o, narrativePrice: true, trace: [] as Any[] };
		const p = planContext(older, f3)!;
		expect(p.cutIdx).not.toBeNull();
		expect(p.blocks.slice(p.cutIdx!).map((b) => b.entryId)).toContain("u2"); // the protected window stays
	});
	test("the previous summary's narrative, which the call merges, is priced as input; its lists are not", () => {
		// two previous summaries of the same size: one mostly lists, one mostly narrative. Same prefix, same carried size, so the
		// summary step's call differs only by the narrative the call reads (chars/4 tokens, at the input price)
		const mk = (narr: number) => {
			const s = "[summary of earlier conversation by pi-zip]\n## User requests (verbatim, oldest first, continuation lines indented)\n1. x\n## Commands run (with exit status)\n" + "`ls` -> exit 0 (turn 1)\n".repeat((40_000 - narr) / 24) + "## Narrative (model-written)\n" + "n".repeat(narr);
			return { sourceEntry: { id: "cmp", type: "compaction", summary: s, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: s, content: s }] };
		};
		const step = (narr: number) => {
			const o = { ...base, narrativePrice: true, mode: "cold" as const, coldCap: 20_000, law: law(0, 500), trace: [] as Any[] };
			planContext([mk(narr), ...older.slice(1)], o);
			return o.trace.find((t: Any) => t.where === "summary")!;
		};
		const small = step(240), big = step(10_040);
		expect(big.K - small.K).toBeCloseTo(ANTH.input * (Math.ceil(10_040 / 4) - Math.ceil(240 / 4)), 0);
	});
});
