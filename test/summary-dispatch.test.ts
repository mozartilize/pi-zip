import { expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { buildCut } from "../src/summary-engine.ts";
import { parseSummaryV2 } from "../src/summary-v2.ts";
import { parseSummaryV3 } from "../src/summary-v3.ts";
import { U } from "./helpers.ts";

test("the fork emits only v2/v3: v3 by default, v2 opt-in, explicit supported format wins", async () => {
	const saved = process.env.PI_ZIP_SUMMARY_V2;
	const blocks = buildBlocks([U("old", "Keep the audit log"), U("keep", "Continue")]);
	const p = { blocks, calls: toolCallIndex(blocks), cutIdx: 1, prefixTokens: 100, summaryTokensPlanned: 1000 } as any;
	const ctx = { model: null };
	try {
		delete process.env.PI_ZIP_SUMMARY_V2;
		expect(parseSummaryV3((await buildCut(p, ctx)).text)).not.toBeNull();
		process.env.PI_ZIP_SUMMARY_V2 = "1";
		expect(parseSummaryV2((await buildCut(p, ctx)).text)).not.toBeNull();
		expect(parseSummaryV3((await buildCut({ ...p, summaryFormat: "v3" }, ctx)).text)).not.toBeNull();
		// A stale internal v1 selector cannot resurrect the deleted fork-v1 emitter.
		expect(parseSummaryV3((await buildCut({ ...p, summaryFormat: "v1" }, ctx)).text)).not.toBeNull();
		delete process.env.PI_ZIP_SUMMARY_V2;
		expect(parseSummaryV2((await buildCut({ ...p, summaryFormat: "v2" }, ctx)).text)).not.toBeNull();
	} finally {
		if (saved === undefined) delete process.env.PI_ZIP_SUMMARY_V2;
		else process.env.PI_ZIP_SUMMARY_V2 = saved;
	}
});
