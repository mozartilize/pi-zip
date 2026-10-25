import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildBlocks } from "../src/plan.ts";
import { buildEpochSummaryV2, formatRequestExcerpt, MIN_EXCERPT_CHARS, parseSummaryV2 } from "../src/summary-v2.ts";
import { tok4 } from "../src/util.ts";

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

// ---------------------------------------------------------------------------------------------------------------
// The request floor, the archive step and the terminal-report breakdown.
// ---------------------------------------------------------------------------------------------------------------

test("a shortened row is never longer than the text it replaces (both markers)", () => {
	for (const file of [undefined, { dir: "/cache/s1", handle: "abcdef1234" } as any]) {
		for (const n of [199, 200, 201, 220, 250, 286, 287, 288, 300, 400]) {
			const raw = "x".repeat(n);
			const ex = formatRequestExcerpt(raw, MIN_EXCERPT_CHARS, "abcdef1234", file);
			expect(ex.text.length).toBeLessThanOrEqual(n);
			expect(ex.truncated).toBe(ex.text.length < n);
			// A row that saves nothing keeps the original text and says so.
			if (!ex.truncated) expect(ex.text).toBe(raw);
		}
	}
});

test("E1 never renders a shorter row that costs more: resident chars stay at or below the original", () => {
	// 201-286 char requests used to grow by the marker (287 chars) and the water-filling pass could not undo it.
	const texts = Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(250));
	const prefix = prefixFor(texts);
	const full = buildEpochSummaryV2({ prefix });
	const e1 = buildEpochSummaryV2({ prefix, maxSummaryTokens: Math.floor(full.diagnostics.tokens.total / 2) });
	expect(e1.diagnostics.originalRequestChars).toBe(40 * 250);
	expect(e1.diagnostics.residentRequestChars).toBeLessThanOrEqual(e1.diagnostics.originalRequestChars);
	for (const r of parseSummaryV2(e1.text)!.epochs.flatMap((e) => e.requests)) {
		if (r.emergencyExcerpt) expect(r.text.length).toBeLessThan(r.emergencyExcerpt.originalChars);
	}
});

test("E2 archives whole old epochs' request ranges when even the floors do not fit, and the next compaction restores them", () => {
	const entries: any[] = [];
	for (let i = 1; i <= 30; i++) {
		const message = { role: "user", content: `constraint ${i} ` + "z".repeat(4000) };
		entries.push({ sourceEntry: { id: `u${i}`, type: "message", message }, messages: [message] });
		const a = { role: "assistant", content: [{ type: "text", text: "ok" }] };
		entries.push({ sourceEntry: { id: `a${i}`, type: "message", message: a }, messages: [a] });
	}
	const branch = entries.map((e) => e.sourceEntry);
	const first = buildEpochSummaryV2({ prefix: buildBlocks(entries.slice(0, 30)), branch });
	const all = buildBlocks(entries);
	const e1 = buildEpochSummaryV2({ prefix: all, branch, previous: first.text, maxSummaryTokens: 5200 });
	expect(e1.ok).toBe(true);
	expect(e1.diagnostics.requestEmergencyMode).toBe("excerpt");
	expect(e1.diagnostics.archivedRequestCount).toBe(0);

	const e2 = buildEpochSummaryV2({ prefix: all, branch, previous: first.text, maxSummaryTokens: 4200 });
	const d = e2.diagnostics;
	expect(e2.ok).toBe(true);
	expect(d.requestEmergencyMode).toBe("archive");
	expect(d.archivedRequestCount).toBe(15); // the whole older epoch, never the newest one
	expect(d.requestCount).toBe(45);
	expect(e2.text).toContain("- R1–R15 archived, not resident (15 requests); zip_recall({ requests: \"1-15\" }) returns the exact text");
	expect(e2.text).toContain("15 of 45 requests archived, not resident");
	// Only the resident rows are weight-carrying: an archived request has no row of its own.
	const parsed = parseSummaryV2(e2.text)!;
	expect(parsed.epochs.flatMap((e) => e.requests).filter((r) => r.archived)).toHaveLength(15);
	expect(parsed.epochs.flatMap((e) => e.requests)).toHaveLength(45);

	// Identity comes from the raw branch: with room again, every request is back verbatim, no excerpt and no archive.
	const back = buildEpochSummaryV2({ prefix: all, branch, previous: e2.text });
	expect(back.diagnostics.requestEmergencyMode).toBe("none");
	expect(back.diagnostics.archivedRequestCount).toBe(0);
	expect(back.diagnostics.verbatimCount).toBe(45);
	expect(back.text).not.toContain("archived, not resident");
});

test("terminal request overflow still fails closed, and reports a section breakdown instead of one lump", () => {
	const blocks = prefixFor(Array.from({ length: 20 }, () => "q".repeat(3000)));
	const r = buildEpochSummaryV2({ prefix: blocks, maxSummaryTokens: 300 });
	expect(r.ok).toBe(false);
	expect(r.reason).toBe("request-budget-overflow");
	expect(r.overflow!.requiredTokens).toBe(tok4(r.text));
	const t = r.diagnostics.tokens;
	expect(t.total).toBe(r.overflow!.requiredTokens);
	// The minimal representation is overhead too (header, recall line, headings, labels, omission rows).
	expect(t.requests).toBeLessThan(t.total);
	expect(t.overhead).toBeGreaterThan(0);
	expect(t.requests + t.intent + t.state + t.prose + t.commitments + t.evidence + t.overhead).toBe(t.total);
});
