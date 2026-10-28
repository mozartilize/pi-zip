// Fork planner suite: upstream's test/coldwarm.test.ts run against src/plan-fork.ts, plus fork-only cases.
// The summary decision is the same whatever the cache is believed to be (research round5/cold-warm.md, round 6 one planner): every
// summary passes its own law with the call priced, and the call is priced as the narrative call summary.ts makes.
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { type PlanOpts } from "../src/plan.ts";
import { planContext } from "../src/plan-fork.ts";
import { lawPrices } from "../src/learn.ts";
import { A, AX, U, type Any } from "./helpers.ts";

let savedAt: string | undefined;
beforeEach(() => { savedAt = process.env.PI_ZIP_SUMMARY_AT; process.env.PI_ZIP_SUMMARY_AT = "0"; });
afterEach(() => { if (savedAt === undefined) delete process.env.PI_ZIP_SUMMARY_AT; else process.env.PI_ZIP_SUMMARY_AT = savedAt; });

const ANTH = lawPrices("explicit", false);
const SUM = "S".repeat(40_000); // the previous summary, carried forward by the next one (~10K tokens)
const comp = { sourceEntry: { id: "cmp", type: "compaction", summary: SUM, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: SUM, content: SUM }] };
const law = (pWarm: number, g = 2_400) => ({ pr: ANTH, g, pWarm });
const base: PlanOpts = { cwd: ".", promptPending: false, model: { contextWindow: 1_000_000 } };

// the live 13:44 shape: a summarisable older turn, the protected window small
const older = [comp, U("k1", "one"), AX("x1", 40_000), AX("x2", 40_000), A("a1"), U("u2", "two"), A("a2"), U("u3", "three")];

describe("a warm summary passes the summary gate too", () => {
	test("a summary the gate refuses is not written warm either", () => {
		const o = { ...base, coldCap: 20_000, law: law(1, 500), trace: [] as Any[] };
		expect(planContext(older, o)?.cutIdx ?? null).toBeNull();
		expect(o.trace.some((t: Any) => t.where === "summary" && !t.ok)).toBe(true);
	});
	test("the same summary at a cache believed gone pays: only P differs, and only inside the law", () => {
		const o = { ...base, coldCap: 20_000, law: law(0, 500), trace: [] as Any[] };
		const p = planContext(older, o)!;
		expect(p.cutIdx).not.toBeNull();
		expect(p.blocks.slice(p.cutIdx!).map((b) => b.entryId)).toContain("u2"); // the protected window stays
	});
});

describe("the summary call is priced as the narrative call it is", () => {
	test("the carried-forward previous summary is not priced as model output: its narrative is read, at the input price", () => {
		const o = { ...base, coldCap: 20_000, law: law(0, 500), trace: [] as Any[] };
		planContext(older, o);
		const s = o.trace.find((t: Any) => t.where === "summary")!;
		// K = (w - r)(0 - (X - S)) + call: the call reads the prefix uncached (the previous summary as its narrative: here a free text,
		// read whole) and writes at most the narrative budget, less than the write of the prefix plus the whole planned summary as output
		const X = s.B, S = s.A, call = s.K + (ANTH.w - ANTH.r) * (X - S);
		expect(call).toBeLessThan(ANTH.w * X + ANTH.out * S);
		expect(call).toBeGreaterThanOrEqual(ANTH.input * X);
	});
	test("the previous summary is excluded from the specification call price, including its narrative", () => {
		// two previous summaries of the same size: one mostly lists, one mostly narrative. Same prefix, same carried size, so the
		// summary step's call differs only by the narrative the call reads (chars/4 tokens, at the input price)
		const mk = (narr: number) => {
			const s = "[summary of earlier conversation by pi-zip]\n## User requests (verbatim, oldest first, continuation lines indented)\n1. x\n## Commands run (with exit status)\n" + "`ls` -> exit 0 (turn 1)\n".repeat((40_000 - narr) / 24) + "## Narrative (model-written)\n" + "n".repeat(narr);
			return { sourceEntry: { id: "cmp", type: "compaction", summary: s, firstKeptEntryId: "k1" }, messages: [{ role: "compactionSummary", summary: s, content: s }] };
		};
		const step = (narr: number) => {
			const o = { ...base, coldCap: 20_000, law: law(0, 500), trace: [] as Any[] };
			planContext([mk(narr), ...older.slice(1)], o);
			return o.trace.find((t: Any) => t.where === "summary")!;
		};
		const small = step(240), big = step(10_040);
		expect(big.K - small.K).toBe(0);
	});
});
