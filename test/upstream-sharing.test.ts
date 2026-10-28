import { expect, test } from "bun:test";
import * as upstream from "../src/summary.ts";
import * as engine from "../src/summary-engine.ts";
import { Zip } from "../src/run.ts";
import { ZipFork } from "../src/run-fork.ts";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { parseSummaryV3 } from "../src/summary-v3.ts";
import { fakePi, U, type Any } from "./helpers.ts";

test("v2/v3 reuse the upstream serializer, budget constants and provider call, not copies", () => {
	expect(engine.serialize).toBe(upstream.serialize);
	expect(engine.excerpt).toBe(upstream.excerpt);
	expect(engine.complete).toBe(upstream.complete);
	expect(engine.addUsage).toBe(upstream.addUsage);
	expect(engine.BUDGET).toBe(upstream.BUDGET);
	expect(engine.bashCommands).toBe(upstream.bashCommands);
});

test("provider effort refusals learned by upstream are reused by the fork, with all attempt costs retained", async () => {
	const efforts: Array<string | undefined> = [];
	const ctx = {
		model: { provider: "sharing-test", id: "shared-effort", reasoning: true },
		modelRegistry: { complete: async (_model: Any, _prompt: Any, opts: Any) => {
			efforts.push(opts.reasoningEffort);
			expect(opts.cacheRetention).toBe("none");
			return opts.reasoningEffort === "low"
				? { stopReason: "stop", content: [{ type: "text", text: "kept" }], usage: { input: 3, cost: { total: 0.2 } } }
				: { stopReason: "error", errorMessage: "'none' is not supported", usage: { input: 2, cost: { total: 0.1 } } };
		} },
	};
	const first = await upstream.complete(ctx, "base prompt");
	const second = await engine.complete(ctx, "fork prompt");
	expect(first.ok).toBe(true);
	expect(first.costUsd).toBeCloseTo(0.3);
	expect(first.usage.input).toBe(5);
	expect(second.ok).toBe(true);
	expect(second.costUsd).toBe(0.2);
	expect(efforts).toEqual([undefined, "low", "low"]);
});

test("extended legacy parsing retains the upstream result and adds aliases and epoch state", () => {
	const text = [upstream.SUMMARY_MARK,
		"## User requests (verbatim, oldest first, continuation lines indented)", "1. Keep this request", "   ## Narrative is user text here",
		'## Commands run (with exit status; "[a] cmd" stands for "cd <dir> && cmd": a=/workspace)',
		"`[a] bun test` -> exit 0 (turn 1, aaaaaaaaaa)",
		"## Narrative", "### Current state and open todos (as of 10-25 15:33 UTC)", "Still open",
	].join("\n");
	const parsed = engine.parseSummary(text);
	expect(parsed).toMatchObject(upstream.parseSummary(text));
	expect(parsed.users.items).toEqual(["Keep this request\n## Narrative is user text here"]);
	expect(parsed.cmdAliases.get("/workspace")).toBe("a");
	expect(parsed.epochs?.activeState).toBe("Still open");
});

test("ZipFork inherits the lifecycle and producer instead of copying them", () => {
	expect(Object.getPrototypeOf(ZipFork.prototype)).toBe(Zip.prototype);
	for (const method of ["sessionStart", "context", "settle", "turnEnd", "agentEnd"] as const) {
		expect(ZipFork.prototype[method]).toBe(Zip.prototype[method]);
		expect(Object.hasOwn(ZipFork.prototype, method)).toBe(false);
	}
	expect(new ZipFork(fakePi().pi)).toBeInstanceOf(Zip);
});

class BaseSummaryProbe extends Zip {
	generate(p: Any) { return this.buildSummary(p, { model: null }, new AbortController().signal); }
}
class ForkSummaryProbe extends ZipFork {
	generate(p: Any) { return this.buildSummary(p, { model: null }, new AbortController().signal); }
}

test("the inherited producer's factory uses upstream summaries by default, and v3 in the fork", async () => {
	const blocks = buildBlocks([U("old", "Keep the audit log"), U("keep", "Continue")]);
	const p = { blocks, calls: toolCallIndex(blocks), cutIdx: 1, prefixTokens: 100, summaryTokensPlanned: 1000, summaryFormat: "v3" };
	const original = await new BaseSummaryProbe(fakePi().pi).generate(p);
	const fork = await new ForkSummaryProbe(fakePi().pi).generate(p);
	expect(upstream.parseSummary(original.text).structured).toBe(true);
	expect(parseSummaryV3(original.text)).toBeNull();
	expect(parseSummaryV3(fork.text)).not.toBeNull();
});
