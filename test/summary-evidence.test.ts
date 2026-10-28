import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { buildCut } from "../src/summary-engine.ts";
import { buildEpochSummaryV2, collectExecutions, evidenceQuotes, parseSummaryV2 } from "../src/summary-v2.ts";

const message = (id: string, role: string, content: any, extra: any = {}) => {
	const m = { role, content, ...extra };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const execution = (id: string, tool: string, args: any, output: string, isError = false) => [
	message(`a-${id}`, "assistant", [{ type: "toolCall", id, name: tool, arguments: args }]),
	message(`r-${id}`, "toolResult", output, { toolName: tool, toolCallId: id, isError }),
];
const proposal = (id: string, quote: string) => ({ sourceHandle: handleFor(`r-${id}`), quote });

test("selected final verification, finding and blocker outrank acknowledgements and intermediate errors, including after carry", () => {
	const entries = [message("u1", "user", "Fix core and verify"),
		...execution("old", "bash", { command: "bun test" }, "FAIL temporary typo\nCommand exited with code 1", true),
		...execution("db", "bash", { command: "query-db" }, "rows=17; missing_ids=3"),
		...execution("final", "bash", { command: "bun test" }, "893 pass\n0 fail\nCommand exited with code 0"),
		...execution("narrow", "bash", { command: "bun test parser" }, "1 pass\n0 fail"),
		...execution("edit", "edit", { path: "src/core.ts" }, "Successfully replaced 1 block(s)"),
		...execution("read", "read", { path: "nonexistent-helper.ts" }, "export function helper() {}"),
		...execution("blocker", "bash", { command: "validate-schema" }, "schema version mismatch\nCommand exited with code 2", true),
	];
	const blocks = buildBlocks(entries);
	const selected = [proposal("db", "rows=17; missing_ids=3"), proposal("final", "893 pass\n0 fail"), proposal("blocker", "schema version mismatch")];
	const result = buildEpochSummaryV2({ prefix: blocks, durableProse: "Updated src/core.ts.", proposedEvidence: selected, targetTokens: 1, maxSummaryTokens: 3000 });
	expect(result.ok).toBe(true);
	const evidence = parseSummaryV2(result.text)!.epochs.flatMap(e => e.evidence);
	expect(evidence).toHaveLength(3);
	for (const id of ["db", "final", "blocker"]) expect(evidence.some(row => row.includes(`execution a-${id}:0`))).toBe(true);
	for (const id of ["old", "narrow", "edit", "read"]) expect(evidence.some(row => row.includes(`execution a-${id}:0`))).toBe(false);
	expect(evidence.join("\n")).toContain("Selected evidence: 893 pass ⏎ 0 fail");
	expect(evidence.join("\n")).toContain("exit 0, 893 passed, 0 failed");
	expect(result.diagnostics.budgetOmitted).toBe(4);
	const carried = buildEpochSummaryV2({ prefix: buildBlocks([message("u2", "user", "continue")]), previous: result.text, targetTokens: 1, maxSummaryTokens: 3000 });
	expect(parseSummaryV2(carried.text)!.epochs.flatMap(e => e.evidence)).toEqual(evidence);
	// Naming the acknowledgement by handle explicitly can still retain it; a file name alone could not.
	const named = buildEpochSummaryV2({ prefix: blocks, durableProse: `Edit receipt ${handleFor("r-edit")}`, targetTokens: 1, maxSummaryTokens: 3000 });
	expect(parseSummaryV2(named.text)!.epochs.flatMap(e => e.evidence).some(row => row.includes("execution a-edit:0"))).toBe(true);
});

test("evidence proposals reject fabricated spans and non-tool sources", () => {
	const blocks = buildBlocks([message("u1", "user", "1000 pass"), message("a1", "assistant", "1000 pass"), ...execution("real", "bash", { command: "check" }, "17 pass\n2 fail")]);
	expect([...evidenceQuotes(blocks, [
		{ sourceHandle: handleFor("u1"), quote: "1000 pass" },
		{ sourceHandle: handleFor("a1"), quote: "1000 pass" },
		proposal("real", "1000 pass"), proposal("real", "17 pass\n2 fail"), proposal("real", "17 pass"),
	])]).toEqual([[handleFor("r-real"), "17 pass\n2 fail"]]);
});

test("selected evidence survives the hard budget before newer path/handle references", () => {
	const entries = [message("u1", "user", "verify"), ...execution("final", "bash", { command: "bun test" }, "893 pass\n0 fail")];
	const references: string[] = [];
	for (let i = 0; i < 10; i++) {
		entries.push(...execution(`edit${i}`, "edit", { path: `src/module-${i}.ts` }, "Successfully replaced 1 block(s)"));
		references.push(handleFor(`r-edit${i}`));
	}
	const options = { prefix: buildBlocks(entries), durableProse: references.join(" "), proposedEvidence: [proposal("final", "893 pass\n0 fail")] };
	expect(buildEpochSummaryV2(options).diagnostics.tokens.total).toBeGreaterThan(400);
	const bounded = buildEpochSummaryV2({ ...options, targetTokens: 1, maxSummaryTokens: 400 });
	expect(bounded.ok).toBe(true);
	expect(bounded.diagnostics.budgetOmitted).toBeGreaterThan(0);
	expect(Math.ceil(bounded.text.length / 4)).toBeLessThanOrEqual(400);
	expect(parseSummaryV2(bounded.text)!.epochs[0].evidence.some(row => row.includes("execution a-final:0"))).toBe(true);
});

test("a selected verified routine read is kept before routine-read filtering", () => {
	const path = new URL("../src/skill-reference.ts", import.meta.url);
	const blocks = buildBlocks([message("u1", "user", "inspect"), ...execution("read", "read", { path: path.pathname }, readFileSync(path, "utf8"))]);
	expect(buildEpochSummaryV2({ prefix: blocks }).diagnostics.routineReadFiltered).toBe(1);
	const selected = buildEpochSummaryV2({ prefix: blocks, proposedEvidence: [proposal("read", "export function skillReference")], targetTokens: 1, maxSummaryTokens: 3000 });
	expect(selected.diagnostics.routineReadFiltered).toBe(0);
	expect(parseSummaryV2(selected.text)!.epochs[0].evidence[0]).toContain("Selected evidence: export function skillReference");
});

test("diff exit 1 is differences only for direct commands with that exit contract", () => {
	const cases: Array<[string, number, boolean]> = [
		["diff before.txt after.txt", 1, false],
		["git diff --exit-code", 1, false],
		["git diff --quiet", 1, false],
		["git diff --no-index before after", 1, false],
		["diff missing after", 2, true],
		["git diff --check --exit-code", 1, true],
		["diff before after; false", 1, true],
		["cd missing && diff before after", 1, true],
		["git diff --exit-code --ext-diff", 1, true],
		["make test", 1, true],
	];
	for (const [command, code, error] of cases) {
		const blocks = buildBlocks(execution("c", "bash", { command }, `observed output\nCommand exited with code ${code}`, true));
		const ref = collectExecutions(blocks).records[0].results[0];
		expect(ref.isError).toBe(error);
		expect(ref.outcome).toBe(error ? `exit ${code}` : "differences (exit 1)");
		expect(!!ref.errorExcerpt).toBe(error);
	}
});

test("buildCut wires evidence selection through one narrative call, without synthesizing it on failure", async () => {
	const entries = [message("u1", "user", "Verify"), ...execution("run", "bash", { command: "bun test" }, "893 pass\n0 fail"), message("u2", "user", "next")];
	const blocks = buildBlocks(entries);
	let calls = 0, prompt = "";
	const ctx: any = { model: { provider: "p", id: "m", cost: { input: 0, output: 0 } }, modelRegistry: {
		complete: async (...args: any[]) => {
			calls++; prompt = JSON.stringify(args);
			return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\nVerification completed.\n---ACTIVE---\n(none)\n---EVIDENCE---\n${JSON.stringify(proposal("run", "893 pass\n0 fail"))}\nnot JSON\n---INTENT---\n(none)` }], usage: { cost: { total: 0 } } };
		},
	} };
	const p: any = { blocks, calls: toolCallIndex(blocks), cutIdx: 3, prefixTokens: 2000, summaryTokensPlanned: 1, summaryRoomTokens: 3000, summaryFormat: "v2", sumTrigger: "cold" };
	const result = await buildCut(p, ctx);
	expect(calls).toBe(1);
	expect(prompt).toContain(`[tool output source: ${handleFor("r-run")}]`);
	expect(parseSummaryV2(result.text)!.epochs[0].evidence[0]).toContain("Selected evidence: 893 pass ⏎ 0 fail");
	ctx.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "timeout", content: [] });
	const failed = await buildCut(p, ctx);
	expect(failed.text).not.toContain("Selected evidence:");
});

test("a v2 record of a source listing has no Evidence line; a test run keeps its outcome line", () => {
	const listing = ["export interface Diag {", "\tisError?: boolean;", "\terrors: Items;", ...Array.from({ length: 60 }, (_, i) => `\tfield${i}: number;`), "}"].join("\n");
	const run = ["bun test v1.4.3", ...Array.from({ length: 40 }, (_, i) => `(pass) case ${i}`), "", " 41 pass", " 0 fail", "Ran 41 tests across 1 file."].join("\n");
	const blocks = buildBlocks([message("u1", "user", "inspect and test"),
		...execution("l", "bash", { command: "sed -n 1,80p src/a.ts" }, listing),
		...execution("t", "bash", { command: "bun test" }, run)]);
	const text = buildEpochSummaryV2({ prefix: blocks }).text;
	const rec = (id: string) => { const lines = text.split("\n"); const i = lines.findIndex((l) => l.includes(`handle ${handleFor(`r-${id}`)}`)); return lines.slice(i, i + 2).join("\n"); };
	expect(rec("l")).not.toContain("Evidence:");
	expect(text).not.toContain("isError?: boolean;");
	expect(rec("t")).toContain("Evidence: 0 fail");
});
