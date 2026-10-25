import { expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { recallRequestsInBranch } from "../src/recall.ts";
import { skillReference } from "../src/skill-reference.ts";
import { buildCut, parseNarrativeReply } from "../src/summary.ts";
import { buildEpochSummaryV2, collectAssistantCommitments, parseSummaryV2, prepareEpochV2, renderV2 } from "../src/summary-v2.ts";

const entry = (id: string, role: string, content: any) => {
	const message = { role, content };
	return { sourceEntry: { id, type: "message", message }, messages: [message] };
};
const expanded = (body: string, suffix = "") => `<skill name="discriminating-testing" location="/skills/discriminating-testing/SKILL.md">\nReferences are relative to /skills/discriminating-testing.\n\n${body}\n</skill>${suffix}`;

test("skill references replace only the Pi envelope and preserve user suffix exactly", () => {
	const text = expanded("BODY", "\n\n  implement\nKeep this spacing.  ");
	expect(skillReference(text)).toBe("/skill:discriminating-testing\n\n  implement\nKeep this spacing.  ");
	expect(skillReference(expanded("BODY"))).toBe("/skill:discriminating-testing");
	for (const unchanged of ["/skill:discriminating-testing", `Example:\n${text}`, `\`\`\`xml\n${text}\n\`\`\``, text.replace("</skill>", ""), '<skill name="x">body</skill>']) {
		expect(skillReference(unchanged)).toBe(unchanged);
	}
});

test("v2 abbreviates fresh and historical skill expansions before budgeting; raw recall is unchanged", () => {
	const raw = expanded("UNIQUE SKILL BODY ".repeat(1800), "\n\nimplement exactly this");
	const first = entry("u1", "user", raw);
	// An older adopted v2 document contains the expanded body.
	const previous = renderV2(prepareEpochV2({ prefix: buildBlocks([first]) }).state);
	const second = entry("u2", "user", expanded("ANOTHER SKILL BODY ".repeat(1400), "\n\nreview only"));
	const branch = [first.sourceEntry, second.sourceEntry];
	const result = buildEpochSummaryV2({ prefix: buildBlocks([second]), previous, branch, maxSummaryTokens: 1000 });
	expect(result.ok).toBe(true);
	expect(result.diagnostics.requestEmergencyMode).toBe("none");
	expect(result.diagnostics.skillReferenceCount).toBe(2);
	expect(result.diagnostics.verbatimCount).toBe(0);
	expect(result.text).not.toContain("SKILL BODY");
	const requests = parseSummaryV2(result.text)!.epochs.flatMap(e => e.requests);
	expect(requests.map(r => r.text)).toEqual(["/skill:discriminating-testing\n\nimplement exactly this", "/skill:discriminating-testing\n\nreview only"]);
	expect(requests.map(r => r.handle)).toEqual([handleFor("u1"), handleFor("u2")]);
	expect(requests.every(r => r.skillReferences)).toBe(true);
	expect(recallRequestsInBranch(branch, "1", { limit: 50000 }).text).toContain(raw);
	for (const source of [branch, []]) {
		const carried = buildEpochSummaryV2({ prefix: [], previous: result.text, branch: source, maxSummaryTokens: 2000 });
		expect(parseSummaryV2(carried.text)!.epochs.flatMap(e => e.requests).map(r => r.text)).toEqual(requests.map(r => r.text));
		expect(carried.diagnostics.skillReferenceCount).toBe(2);
	}
});

test("emergency skill references preserve their qualifier and measure the abbreviated source", () => {
	const suffix = "\n\n" + "do not change the API ".repeat(500);
	const raw = expanded("SKILL CONTENT ".repeat(1000), suffix);
	const result = buildEpochSummaryV2({ prefix: buildBlocks([entry("u1", "user", raw)]), maxSummaryTokens: 400 });
	expect(result.ok).toBe(true);
	const request = parseSummaryV2(result.text)!.epochs[0].requests[0];
	expect(request.skillReferences).toBe(true);
	expect(request.emergencyExcerpt?.originalChars).toBe("/skill:discriminating-testing".length + suffix.length);
	expect(request.text.startsWith("/skill:discriminating-testing")).toBe(true);
	expect(result.diagnostics.skillReferenceCount).toBe(1);
	expect(result.diagnostics.verbatimCount).toBe(0);
	expect(result.diagnostics.truncatedRequestCount).toBe(1);
});

test("commitment proposals need an exact visible assistant source, not keywords or hidden reasoning", () => {
	const blocks = buildBlocks([
		entry("a1", "assistant", [{ type: "thinking", thinking: "SECRET PROMISE" }, { type: "text", text: "Tao sẽ sửa lỗi.\nSummary sẽ chỉ có request.\n明日、テストを追加します。" }]),
		entry("u1", "user", "User promise"),
		entry("t1", "toolResult", "Tool promise"),
	]);
	const h = handleFor("a1");
	// No model proposal means no inferred commitment, even for the old regex's matches.
	expect(collectAssistantCommitments(blocks)).toEqual([]);
	const valid = [{ sourceHandle: h, quote: "Tao sẽ sửa lỗi." }, { sourceHandle: h, quote: "明日、テストを追加します。" }];
	expect(collectAssistantCommitments(blocks, [
		...valid, valid[0], { sourceHandle: h, quote: "SECRET PROMISE" },
		{ sourceHandle: h, quote: "Tao sẽ triển khai toàn bộ." },
		{ sourceHandle: handleFor("u1"), quote: "User promise" },
		{ sourceHandle: handleFor("t1"), quote: "Tool promise" },
		{ sourceHandle: "0000000000", quote: "Tao sẽ sửa lỗi." },
	])).toEqual(valid);
	const parsed = parseNarrativeReply(`---DECISIONS---\nFinding\n---ACTIVE---\nPending\n---COMMITMENTS---\n${JSON.stringify(valid[0])}\nnot JSON\nnull\n{"quote":42}\n---INTENT---\n(none)`);
	expect(parsed.commitments).toEqual([valid[0]]);
	expect(parsed.durable).toBe("Finding");
	expect(parsed.active).toBe("Pending");
});

test("buildCut uses the existing narrative call for sourced commitments and keeps skill content in the narrative input", async () => {
	const raw = expanded("DO NOT DUPLICATE THIS BODY", "\n\nimplement");
	const prefix = [entry("u1", "user", raw), entry("a1", "assistant", [
		{ type: "text", text: "Summary sẽ chỉ có request.\n明日、テストを追加します。" },
	]), entry("u2", "user", "next")];
	const blocks = buildBlocks(prefix);
	const h = handleFor("a1");
	let calls = 0, prompt = "";
	const ctx: any = { model: { provider: "p", id: "m", cost: { input: 0, output: 0 } }, modelRegistry: {
		complete: async (...args: any[]) => {
			calls++;
			prompt = JSON.stringify(args);
			return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\n(none)\n---ACTIVE---\n- [ ] add tests\n---INTENT---\n(none)\n---COMMITMENTS---\n${JSON.stringify({ sourceHandle: h, quote: "明日、テストを追加します。" })}` }], usage: { cost: { total: 0 } } };
		},
	} };
	const p: any = { blocks, calls: toolCallIndex(blocks), cutIdx: 2, prefixTokens: 2000, summaryTokensPlanned: 4000, summaryRoomTokens: 10000, summaryFormat: "v2", sumTrigger: "cold" };
	const cut = await buildCut(p, ctx);
	expect(calls).toBe(1);
	expect(prompt).toContain(`[assistant source: ${h}]`);
	// The summariser reads the skill expansion as the user had it: constraints a skill carries are what durable prose and state must
	// keep, and a `/skill:name` reference would hide them. The summary's own request row still shows the short form (recallable).
	expect(prompt).toContain("DO NOT DUPLICATE THIS BODY");
	expect(prompt).not.toContain("/skill:discriminating-testing");
	expect(cut.text).toContain("/skill:discriminating-testing");
	expect(cut.text).not.toContain("DO NOT DUPLICATE THIS BODY");
	const commitments = parseSummaryV2(cut.text)!.epochs.flatMap(e => e.commitments);
	expect(commitments).toEqual([`- source ${h}\n  > 明日、テストを追加します。`]);
	ctx.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "timeout", content: [] });
	const failed = await buildCut(p, ctx);
	expect(parseSummaryV2(failed.text)!.epochs.flatMap(e => e.commitments)).toEqual([]);
});
