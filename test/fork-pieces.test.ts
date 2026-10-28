import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairPayload } from "../src/guard.ts";
import { cacheActivity, detectCold, isColdByTtl, lastMessageMs, observedTier, payloadRetention, resolveTtl } from "../src/cache.ts";
import { classifyRecoverability, classifySummaryRead, isReadOnlyBash } from "../src/read-policy.ts";
import { colorTail, fmtK, noticeText, renderNotice, splitDesc, type NoticeAction, type NoticeData } from "../src/notice.ts";
import { clipMid, handleFor, KEY_LINE_MAX_CHARS, keyTexts, makePlaceholder, makePlaceholderFor, outcomeHint, pickKeyLines, shortArgs, summaryHint } from "../src/fold-format.ts";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { A, type Any, fakeCtx, fakePi, R, startZip, U } from "./helpers.ts";
import { branchOutputs, parseRange, recalledHandlesFromBranch, recallSections, resolveHandlesInBranch, searchOutputs, sliceRecall } from "../src/recall-extended.ts";
import { handleRowsOf, handleTable, INDEX_TOKENS, skeleton, TABLE_ROWS } from "../src/summary.ts";
import { TOOL_FRAME_CHARS, tokensOf } from "../src/util.ts";

const zipRecallName = "zip_recall";

describe("fork recall and verified reads", () => {
	const call = (id: string, cid: string, name: string, args: object) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: cid, name, arguments: args }] } });
	const res = (id: string, cid: string, name: string, text: string) => ({ type: "message", id, message: { role: "toolResult", toolCallId: cid, toolName: name, content: [{ type: "text", text }] } });
	const session = [
		{ type: "message", id: "u1", message: { role: "user", content: "go" } },
		call("a1", "c1", "bash", { command: "npm test" }),
		res("e1", "c1", "bash", "ok 1\nERROR one: timeout 30s\nok 3"),
		{ type: "compaction", id: "k1", summary: "s", firstKeptEntryId: "u2" },
		{ type: "message", id: "u2", message: { role: "user", content: "more" } },
		call("a2", "c2", "read", { path: "src/a.ts" }),
		res("e2", "c2", "read", "x\nthrow new Error('ERROR two')"),
		call("a3", "c3", zipRecallName, { handle: handleFor("e1") }),
		res("e3", "c3", zipRecallName, "ERROR one (a recall result)"),
	];
	test("branchOutputs pairs reused toolCallId with the latest preceding issuer and leaves duplicate IDs in one message unresolved", () => {
		const branch = [
			{ type: "message", id: "u1", message: { role: "user", content: "first" } },
			call("a1", "shared", "bash", { command: "echo first" }),
			res("r1", "shared", "bash", "first"),
			{ type: "message", id: "u2", message: { role: "user", content: "second" } },
			call("a2", "shared", "bash", { command: "echo second" }),
			res("r2", "shared", "bash", "second"),
			{ type: "message", id: "a3", message: { role: "assistant", content: [
				{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "echo a" } },
				{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "echo b" } },
			] } },
			res("r3", "dup", "bash", "ambiguous"),
		];
		const outs = branchOutputs(branch);
		expect(outs[0]).toMatchObject({ entryId: "r1", label: "bash echo first", executionId: "a1:0" });
		expect(outs[1]).toMatchObject({ entryId: "r2", label: "bash echo second", executionId: "a2:0" });
		expect(outs[2].executionId).toBeUndefined();
		expect(outs[2].ambiguous).toBe(true);
		expect(outs[2].label).toBe("bash"); // does not guess which duplicate call produced it
	});

	test("requests selector, exact assistant handle recall, and role-aware grep scope work on raw branch without exposing hidden reasoning", async () => {
		const { registerRecallTool, branchRequests } = await import("../src/recall-extended.ts");
		let def: any;
		registerRecallTool({ registerTool: (t: any) => (def = t) } as any, { onRecall: () => {} });
		const branch: any[] = [
			{ type: "message", id: "u1", message: { role: "user", content: "First requirement: never drop active constraints" } },
			{ type: "custom", id: "c_start", customType: "starter", data: {} },
			{ type: "message", id: "a1", message: { role: "assistant", content: [
				{ type: "thinking", thinking: "SECRET_HIDDEN_REASONING_TOKEN" },
				{ type: "text", text: "Proposal 1: keep old tables\nProposal 2: group by epoch" },
			] } },
			{ type: "message", id: "u2", message: { role: "user", content: "chọn cách 2" } },
			{ type: "message", id: "u3", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } },
			call("a2", "tc1", "bash", { command: "bun test" }),
			res("r1", "tc1", "bash", "test output: Proposal 2 verified"),
		];
		const reqs = branchRequests(branch);
		expect(reqs.map((r) => [r.number, r.entryId, r.text])).toEqual([
			[1, "u1", "First requirement: never drop active constraints"],
			[2, "u2", "chọn cách 2"],
			[3, "u3", "[non-text user content]"],
		]);
		const ctx = { sessionManager: { getBranch: () => branch } };
		const byReq = await def.execute("t", { requests: "1-2" }, undefined, undefined, ctx);
		expect(byReq.isError).toBe(false);
		expect(byReq.content[0].text).toContain("R1 · user request");
		expect(byReq.content[0].text).toContain("First requirement: never drop active constraints");
		expect(byReq.content[0].text).toContain("R2 · user request");
		expect(byReq.content[0].text).toContain("chọn cách 2");

		// Invalid range or mutually exclusive combination is rejected
		expect((await def.execute("t", { requests: "3-1" }, undefined, undefined, ctx)).isError).toBe(true);
		expect((await def.execute("t", { requests: "1", handle: handleFor("u1") }, undefined, undefined, ctx)).isError).toBe(true);

		// Exact assistant handle recall returns visible prose only, never thinking
		const asstRecall = await def.execute("t", { handle: handleFor("a1") }, undefined, undefined, ctx);
		expect(asstRecall.isError).toBe(false);
		expect(asstRecall.content[0].text).toContain("Proposal 2: group by epoch");
		expect(asstRecall.content[0].text).not.toContain("SECRET_HIDDEN_REASONING_TOKEN");

		// Scope grep: default outputs vs assistant vs requests vs all
		const gOut = await def.execute("t", { grep: "Proposal 2" }, undefined, undefined, ctx);
		expect(gOut.content[0].text).toContain("1 matching line(s) in 1 output(s)");
		const gAsst = await def.execute("t", { grep: "Proposal 2", scope: "assistant" }, undefined, undefined, ctx);
		expect(gAsst.content[0].text).toContain("1 matching line(s) in 1 assistant message(s)");
		expect(gAsst.content[0].text).toContain("assistant response · R1");
		const gHidden = await def.execute("t", { grep: "SECRET_HIDDEN_REASONING_TOKEN", scope: "all" }, undefined, undefined, ctx);
		expect(gHidden.content[0].text).toContain("Nothing matched");
		const gAll = await def.execute("t", { grep: "Proposal 2|chọn cách 2", scope: "all" }, undefined, undefined, ctx);
		expect(gAll.content[0].text).toContain("3 matching line(s) in 3 record(s)");
	});

	test("the recalled set keeps successful zip_recall results only", () => {
		const call = (id: string, name: string, args: object) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: "t" + id, name, arguments: args }] } });
		const res = (id: string, isError: boolean, sections: object[]) => ({ type: "message", id: "r" + id, message: { role: "toolResult", toolCallId: "t" + id, toolName: "zip_recall", isError, content: [], details: { sections } } });
		const set = recalledHandlesFromBranch([
			call("1", "zip_recall", { handle: "aaaaaaaaaa" }), res("1", false, [{ handle: "aaaaaaaaaa" }]),
			call("2", "zip_recall", { handles: ["bbbbbbbbbb", "cccccccccc"] }), res("2", false, [{ handle: "bbbbbbbbbb" }, { handle: "cccccccccc", missing: true }]),
			call("3", "other", { handle: "dddddddddd" }),
			call("4", "zip_recall", { handle: "eeeeeeeeee" }), res("4", true, [{ handle: "eeeeeeeeee", missing: true }]),
			call("5", "zip_recall", { handle: "ffffffffff" }),
		]);
		expect([...set].sort()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
	});

	test("read: rereadable iff the file slice/truncation matches on disk; partial, truncated, and >2MB changed files are handled accurately", () => {
		const dir = mkdtempSync(join(tmpdir(), "zip-"));
		writeFileSync(join(dir, "f.txt"), "hello\nworld\n");
		expect(classifyRecoverability("read", { path: "f.txt" }, "hello\nworld\n", dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path: "f.txt" }, "hello\nworld\n\n[Showing lines 1-2 of 2]", dir)).toBe("rereadable");
		expect(classifyRecoverability("read", { path: "f.txt" }, "stale", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("read", { path: "nope.txt" }, "x", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("write", { path: "f.txt" }, "x", dir)).toBe("nonrereadable");
		expect(classifyRecoverability("grep", {}, "x", dir)).toBe("rereadable");

		// Partial read with offset & limit on 3000-line file
		const lines3000 = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(join(dir, "long.txt"), lines3000);
		const partialOut = Array.from({ length: 5 }, (_, i) => `line ${11 + i}`).join("\n") + "\n\n[2985 more lines in file. Use offset=16 to continue.]";
		expect(classifyRecoverability("read", { path: "long.txt", offset: 11, limit: 5 }, partialOut, dir)).toBe("rereadable");
		// Wrong offset with same prefix must be rejected
		expect(classifyRecoverability("read", { path: "long.txt", offset: 12, limit: 5 }, partialOut, dir)).toBe("nonrereadable");

		// Default 2000-line truncation notice
		const head2000 = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]";
		expect(classifyRecoverability("read", { path: "long.txt" }, head2000, dir)).toBe("rereadable");

		// >2MB changed file must NOT be treated as rereadable via an existence shortcut
		writeFileSync(join(dir, "huge.txt"), "NEW".repeat(750_000));
		expect(classifyRecoverability("read", { path: "huge.txt" }, "OLD CONTENT", dir)).toBe("nonrereadable");

		// Image or first-line-exceeds-limit notes are never treated as verified text reads
		expect(classifyRecoverability("read", { path: "f.txt" }, "Read image file [image/png]", dir, [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "x", mimeType: "image/png" }])).toBe("nonrereadable");
		expect(classifySummaryRead("bash", { command: "git status" }, "On branch master", dir)).toEqual({ eligible: false, reason: "volatile-snapshot" });
		expect(classifySummaryRead("bash", { command: "git show 0123456789abcdef0123456789abcdef01234567" }, "commit ...", dir)).toEqual({ eligible: false, reason: "volatile-snapshot" });
		expect(classifySummaryRead("read", { path: "long.txt", offset: 11, limit: 5 }, partialOut, dir)).toEqual({ eligible: true, reason: "verified-matching-read" });
	});

	test("zip_recall with grep alone goes through execute as a search; with neither handle nor grep it says what to pass", async () => {
		const { registerRecallTool } = await import("../src/recall-extended.ts");
		let def: any;
		const seen: any[] = [];
		registerRecallTool({ registerTool: (t: any) => (def = t) } as any, { onRecall: (...a: any[]) => seen.push(a) });
		const ctx = { sessionManager: { getBranch: () => session } };
		const r = await def.execute("t", { grep: "timeout \\d+s" }, undefined, undefined, ctx);
		expect(r.isError).toBe(false);
		expect(r.content[0].text).toContain("1 matching line(s) in 1 output(s)");
		expect(r.content[0].text).toContain(`[handle ${handleFor("e1")} \u00b7 bash npm test`);
		expect(seen[0][0]).toEqual([]); // a search marks nothing as recalled
		const bad = await def.execute("t", {}, undefined, undefined, ctx);
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toContain("grep alone");
		const miss = await def.execute("t", { handle: "zzzzzzzzzz" }, undefined, undefined, ctx);
		expect(miss.isError).toBe(true);
		expect(seen.at(-1)[0]).toEqual([]);
		const hit = await def.execute("t", { handles: [handleFor("e1"), "zzzzzzzzzz"] }, undefined, undefined, ctx);
		expect(hit.isError).toBe(false);
		expect(seen.at(-1)[0]).toEqual([handleFor("e1")]);
		expect(def.description).toContain("grep alone searches every earlier tool output");
	});
});

test("placeholder marker carries the fold time in UTC: fixed width, absent when unknown, byte-stable for the same stamp", () => {
	const out = "line\n".repeat(400);
	const at = Date.UTC(2026, 9, 25, 15, 18), folded = Date.UTC(2026, 9, 25, 15, 33);
	const ph = makePlaceholder(out, "bash", "make", handleFor("x"), 8, { at, foldedAt: folded })!;
	expect(ph.startsWith("[folded by pi-zip at 10-25 15:33 UTC · bash make · 10-25 15:18 UTC · ")).toBe(true);
	// Without a known fold time the marker is the earlier one, byte for byte.
	const plain = makePlaceholder(out, "bash", "make", handleFor("x"), 8, { at })!;
	expect(plain.startsWith("[folded by pi-zip · bash make · 10-25 15:18 UTC · ")).toBe(true);
	expect(ph).toBe(plain.replace("[folded by pi-zip ·", "[folded by pi-zip at 10-25 15:33 UTC ·"));
	// Fixed width: any stamp prices the same, so the planner's savings do not depend on the time of day.
	const other = makePlaceholder(out, "bash", "make", handleFor("x"), 8, { at, foldedAt: Date.UTC(2026, 0, 2, 3, 4) })!;
	expect(other.length).toBe(ph.length);
	expect(makePlaceholder(out, "bash", "make", handleFor("x"), 8, { at, foldedAt: folded })).toBe(ph);
});

test("summary hints skip identifiers that merely contain 'error', separators and source lines; findings and outcomes stay", () => {
	const code = (lines: string[]) => lines.join("\n");
	// Each case is a shape seen in a real v2 summary, where the placeholder heuristics picked the noise.
	expect(summaryHint(code(["\tisError?: boolean;", "\tdiagnostics: Diag;", "}"]))).toBeUndefined();
	expect(summaryHint(code(["160  \tisError: boolean;", "161  \tcode?: number;", "162  }"]))).toBeUndefined();
	expect(summaryHint(code(["886:export function skeleton(", "887:\tblocks: Block[],", "888:): string {"]))).toBeUndefined();
	expect(summaryHint(code(["\tnarrativeAt?: string; // carried forward", "\terrors: Items;"]))).toBeUndefined();
	expect(summaryHint(code(["===", "==="]))).toBeUndefined();
	// A located hit is a finding, not a listing; a separator before it is skipped.
	expect(summaryHint(code(["===", "src/run.ts:991:\tconst overflowed = w?.cut.reason === \"x\";"]))).toBe("src/run.ts:991:\tconst overflowed = w?.cut.reason === \"x\";");
	// Whole error words win over the first line; an identifier containing "error" does not.
	expect(summaryHint(code(["bun test v1.4.3", "\tconst isError = true;", "2 tests failed:", "Ran 3 tests"]))).toBe("2 tests failed:");
	expect(summaryHint(code(["bun test v1.4.3", "", " 0 fail", "Ran 925 tests"]))).toBe(" 0 fail");
	expect(summaryHint(code(["6161a25 Render model-visible timestamps in explicit UTC", "ac77f77 feat(summary): retain useful context"])))
		.toBe("6161a25 Render model-visible timestamps in explicit UTC");
	expect(summaryHint(code(["309:#### Final failure", "310:text"]))).toBe("309:#### Final failure");
	expect(summaryHint("(no output)")).toBe("(no output)");
	// JSON outputs keep their key fields.
	expect(summaryHint(JSON.stringify({ status: "ok", error: "none", items: [1, 2, 3] }))).toBe(keyTexts(JSON.stringify({ status: "ok", error: "none", items: [1, 2, 3] }), 4)[0]);
});

test("bounded key lines preserve both ends of a minified output", () => {
    const text = "HEAD-MARKER:" + "x".repeat(32_000) + ":TAIL-MARKER";
    const keys = pickKeyLines(text);
    expect(keys).toHaveLength(1);
    expect(keys[0].text.length).toBeLessThanOrEqual(KEY_LINE_MAX_CHARS);
    expect(keys[0].text).toContain("HEAD-MARKER:");
    expect(keys[0].text).toContain(":TAIL-MARKER");
    expect(keyTexts(text)[0]).toBe(keys[0].text);
});
