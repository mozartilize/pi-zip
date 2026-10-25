import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildBlocks } from "../src/plan.ts";
import { buildEpochSummaryV2, parseSummaryV2 } from "../src/summary-v2.ts";

const prefixFor = (texts: string[]) => buildBlocks(texts.map((text, i) => {
	const message = { role: "user", content: text };
	return { sourceEntry: { id: `u${i}`, type: "message", message }, messages: [message] };
}));

test("E1 multiline expansion terminates and measures rendered quote overhead", () => {
	// Isolate the synchronous renderer: a loop regression must fail, not hang the test runner.
	const result = spawnSync(process.execPath, ["-e", `
		import { buildBlocks } from "./src/plan.ts";
		import { buildEpochSummaryV2, parseSummaryV2 } from "./src/summary-v2.ts";
		const texts = ["a".repeat(134) + "\\n".repeat(160) + "z".repeat(67), "b".repeat(10000)];
		const prefix = buildBlocks(texts.map((text, i) => {
			const message = { role: "user", content: text };
			return { sourceEntry: { id: "u" + i, type: "message", message }, messages: [message] };
		}));
		const result = buildEpochSummaryV2({ prefix, maxSummaryTokens: 448 });
		console.log(JSON.stringify({ ok: result.ok, size: Math.ceil(result.text.length / 4),
			requests: parseSummaryV2(result.text).epochs.flatMap(e => e.requests).map(r => r.number) }));
	`], { cwd: new URL("..", import.meta.url), timeout: 3000, encoding: "utf8" });
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	const output = JSON.parse(result.stdout);
	expect(output.ok).toBe(true);
	expect(output.size).toBeLessThanOrEqual(448);
	expect(output.requests).toEqual([1, 2]);
});

test("E1 keeps newest prose without selected intents and budgets stale state metadata", () => {
	const prefix = prefixFor(["prefix " + "abc ".repeat(3000)]);
	const options = { prefix, activeState: "pending", activeStale: "provider timeout", activeAt: "10-25 01:00", durableProse: "IMPORTANT NEW FINDING" };
	const result = buildEpochSummaryV2({ ...options, maxSummaryTokens: 600 });
	const parsed = parseSummaryV2(result.text)!;
	expect(result.ok).toBe(true);
	expect(result.diagnostics.requestEmergencyMode).toBe("excerpt");
	expect(parsed.intents).toEqual([]);
	expect(parsed.epochs[0].block.durableProse).toBe(options.durableProse);
	expect(parsed.activeState).toBe("pending");
	expect(parsed.activeStale).toBe("provider timeout");
	expect(parsed.activeAt).toBe("10-25 01:00");
	// State body is small; metadata alone exceeds the room. It cannot be kept without its warning.
	const tight = buildEpochSummaryV2({ ...options, activeStale: "stale ".repeat(500), maxSummaryTokens: 400 });
	expect(tight.ok).toBe(true);
	expect(Math.ceil(tight.text.length / 4)).toBeLessThanOrEqual(400);
	expect(tight.text).not.toContain("pending");
	expect(tight.text).not.toContain("possibly stale");
});

test("carried E1 excerpts report original lengths and remain excerpts without the raw branch", () => {
	const text = "prefix " + "abc ".repeat(3000);
	const first = buildEpochSummaryV2({ prefix: prefixFor([text]), maxSummaryTokens: 600 });
	expect(first.ok).toBe(true);
	const carry = buildEpochSummaryV2({ prefix: [], previous: first.text, branch: [], maxSummaryTokens: 10000 });
	const reqs = parseSummaryV2(carry.text)!.epochs.flatMap(e => e.requests);
	expect(carry.ok).toBe(true);
	expect(carry.diagnostics.requestEmergencyMode).toBe("excerpt");
	expect(carry.diagnostics.truncatedRequestCount).toBe(1);
	expect(carry.diagnostics.verbatimCount).toBe(0);
	expect(carry.diagnostics.sourceIncompleteCount).toBe(1);
	expect(carry.diagnostics.originalRequestChars).toBe(text.length);
	expect(carry.diagnostics.residentRequestChars).toBe(reqs[0].text.length);
	// A tighter subsequent emergency must not overwrite the original length with the excerpt length.
	const tighter = buildEpochSummaryV2({ prefix: [], previous: first.text, branch: [], maxSummaryTokens: 500 });
	expect(tighter.ok).toBe(true);
	expect(tighter.diagnostics.originalRequestChars).toBe(text.length);
	expect(tighter.diagnostics.truncatedRequestCount).toBe(1);
	expect(parseSummaryV2(tighter.text)!.epochs[0].requests[0].emergencyExcerpt?.originalChars).toBe(text.length);
});
