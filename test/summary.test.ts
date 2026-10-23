// Sectioned carry-forward of the previous summary (synthetic sessions only): merge, dedupe, oldest dropped first with a count,
// old formats and Pi's own free-text compaction summaries.
import { describe, expect, test } from "bun:test";
import { buildBlocks, NARRATIVE_CALL_MAX, NARRATIVE_MAX, plan, toolCallIndex, UNIT } from "../src/plan.ts";
import { lawPrices } from "../src/learn.ts";
import { tok4 } from "../src/util.ts";
import { handleFor } from "../src/placeholder.ts";
import { resolveHandlesInBranch } from "../src/recall.ts";
import {
	ACTIVE_WORDS,
	ACTIVE_INPUT_TOKENS,
	estimateMergeWork,
	BUDGET,
	buildCut,
	boundEpochs,
	clipActive,
	consolidateEpochs,
	mkEpoch,
	MERGE_REASONING_TOKENS,
	EPOCH_WORDS,
	EFFORT_REFUSED_RE,
	FIRST_REQUESTS,
	formatNarrative,
	handleRowsOf,
	handleTable,
	MAX_NARRATIVE_TOKENS,
	narrative,
	parseEpochNarrative,
	parseSummary,
	PREV_NARRATIVE_CHARS,
	previousNarrative,
	REASONING_LIMITS,
	REASONING_NOTE,
	REASONING_QUALIFICATION,
	reasoningInput,
	skeleton,
	TABLE_ROWS,
} from "../src/summary.ts";
import { A, AX, R, U, type Any } from "./helpers.ts";

const tcall = (id: string, name: string, args: Any) => {
	const m = { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: `c-${id}`, name, arguments: args }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const tres = (id: string, name: string, text: string) => {
	const m = { role: "toolResult", toolCallId: `c-${id}`, toolName: name, isError: false, content: [{ type: "text", text }] };
	return { sourceEntry: { id: `r-${id}`, type: "message", message: m }, messages: [m] };
};
const summaryEntry = (text: string) => ({ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: text, tokensBefore: 0, timestamp: 0 }] });

/** One level of a long session: 4 requests of ~2.5K chars, 30 commands (15 with a big output), 2 reads, 1 pathless call. */
function level(L: number): Any[] {
	const out: Any[] = [];
	for (let k = 1; k <= 4; k++) out.push(U(`u${L}-${k}`, `REQ-${L}-${k} ` + `please keep working on item ${L}.${k}; `.repeat(80)));
	for (let k = 1; k <= 30; k++) {
		out.push(tcall(`b${L}-${k}`, "bash", { command: `make step-${L}-${k}` }));
		out.push(tres(`b${L}-${k}`, "bash", k % 2 === 0 ? `KEY-${L}-${k}: value\n` + "padding line\n".repeat(300) : "ok"));
	}
	for (let k = 1; k <= 2; k++) {
		out.push(tcall(`f${L}-${k}`, "read", { path: `src/mod${L}_${k}.ts` }));
		out.push(tres(`f${L}-${k}`, "read", "export const x = 1;"));
	}
	out.push(tcall(`w${L}`, "web_fetch", { url: `https://example.test/${L}` }));
	out.push(tres(`w${L}`, "web_fetch", "page"));
	out.push(A(`end${L}`));
	return out;
}
const narrativeFor = (L: number) => `## Decisions and rationale\nDECISION-${L}: chose plan ${L}.\n## Current state of the work\n` + `state line for level ${L}\n`.repeat(40) + `## Open todos / next steps\nTODO-${L}: finish ${L}\n## Key facts to remember\nKEYFACT-${L}: value-${L}`;

/** The real buildCut over [previous summary?] + one level, with a stub model that writes narrativeFor(L); `prompts` collects what it was sent. */
async function cutOver(L: number, previous: string | null, prompts: string[] = []): Promise<string> {
	const entries = [...(previous ? [summaryEntry(previous)] : []), ...level(L), U(`keep${L}`, "kept"), A(`keepA${L}`)];
	const blocks = buildBlocks(entries);
	const cutIdx = blocks.findIndex((b) => b.entryId === `keep${L}`);
	const complete = async (_m: Any, c: Any, options: Any) => {
		expect(options.maxTokens).toBe(NARRATIVE_CALL_MAX);
		const prompt = c.messages[0].content[0].text;
		prompts.push(prompt);
		// The stub follows the active-state reconciliation contract; this checks wiring, not live model fidelity.
		const pending = /<previous-active-state>\n([\s\S]*?)\n<\/previous-active-state>/.exec(prompt)?.[1].match(/TODO-\d+: finish \d+/g) ?? [];
		const text = narrativeFor(L).replace(`TODO-${L}: finish ${L}`, [`TODO-${L}: finish ${L}`, ...pending].join("\n"));
		return { stopReason: "stop", content: [{ type: "text", text }], usage: { cost: { total: 0 } } };
	};
	const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx, prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
	return (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
}
async function chain(levels: number, prompts: string[] = []) {
	const texts: string[] = [];
	let prev: string | null = null;
	for (let L = 1; L <= levels; L++) texts.push((prev = await cutOver(L, prev, prompts)));
	return texts;
}
const requestsOf = (t: string) => t.split("\n").filter((l) => /^\d+\. REQ-\d+-\d+ /.test(l)).map((l) => /REQ-(\d+)-(\d+)/.exec(l)!.slice(1).map(Number) as [number, number]);
const sec = (t: string, head: string) => { const i = t.indexOf(head); const j = t.indexOf("\n## ", i + 1); return t.slice(i, j < 0 ? undefined : j); };
const prevBlockOf = (prompt: string) => /<previous-narrative[^>]*>\n([\s\S]*?)\n<\/previous-narrative>/.exec(prompt)?.[1] ?? null;
const cmdHandle = (L: number, k: number) => handleFor(`r-b${L}-${k}`);

describe("sectioned carry-forward: nested summaries, 4 levels deep", () => {
	test("requests: the session's first one and the newest are verbatim, the ones between shortened then counted; numbers are the session's", async () => {
		const texts = await chain(4);
		const last = texts[3];
		const lines = sec(last, "## User requests").split("\n").slice(1);
		const nums = lines.filter((l) => /^\d+\. /.test(l)).map((l) => Number(/^(\d+)\./.exec(l)![1]));
		expect(nums).toEqual([...nums].sort((a, b) => a - b)); // in order
		expect(last).toContain(`\n1. REQ-1-1 please keep working on item 1.1; `); // the first request defines the task: kept, as number 1
		expect(last).toContain(`\n16. REQ-4-4 please keep working on item 4.4; `); // the newest, verbatim
		const verbatim = lines.filter((l) => /^\d+\. REQ-/.test(l)).length;
		const short = lines.filter((l) => /^\d+\. ≈ REQ-\d+-\d+ please/.test(l));
		const omitted = [...last.matchAll(/\[… (\d+) older requests omitted …\]/g)].reduce((a, m) => a + Number(m[1]), 0);
		expect(short.length).toBeGreaterThan(0);
		expect(short.every((l) => l.length <= 110)).toBe(true);
		expect(verbatim + short.length + omitted).toBe(16); // every request is accounted for
		expect(last.split("\n")[2]).toMatch(/^## User requests \(.*≈ shortened/);
		// a shortened request stays shortened in the next summary; numbering stays the session's
		const s3 = sec(texts[2], "## User requests").split("\n").filter((l) => /^\d+\. ≈ /.test(l));
		for (const l of s3) if (last.includes(l.slice(0, 12))) expect(last).toContain(l);
		expect(sec(last, "## User requests").length).toBeLessThan(BUDGET.users + BUDGET.usersFirst + BUDGET.usersShort + 500);
	});

	test("handles: the newest commands are listed, older ones are counted and their handles move to the index; nothing newer than the budget is lost", async () => {
		const last = (await chain(4))[3];
		const cmds = sec(last, "## Commands run");
		for (let k = 1; k <= 30; k++) expect(cmds).toContain(cmdHandle(4, k)); // newest level in full
		expect(cmds.split("\n").filter((l) => l.startsWith("`")).length).toBeLessThanOrEqual(60);
		expect(cmds).toMatch(/\[… \d+ older omitted …\]/);
		const listed = new Set(handleRowsOf(last).map((r) => r.handle));
		for (const L of [3, 2, 1]) for (let k = 1; k <= 30; k++) expect(listed.has(cmdHandle(L, k))).toBe(true); // 120 handles fit the index budget
		expect(listed.has(handleFor("r-f4-1")) && listed.has(handleFor("r-w4"))).toBe(true);
		// each handle is written once in the lists and index (the index never repeats a listed one)
		const rows = handleRowsOf(last.slice(0, last.indexOf("## Narrative")));
		expect(new Set(rows.map((r) => `${r.handle}|${r.tool}`)).size).toBe(rows.length);
	});

	test("files: a path touched again moves to the newest end and keeps its newest handle", async () => {
		const t1 = await cutOver(1, null);
		const again = [U("ua", "again"), tcall("g1", "read", { path: "src/mod1_1.ts" }), tres("g1", "read", "export const x = 2;"), A("ea")];
		const blocks = buildBlocks([summaryEntry(t1), ...again]);
		const files = sec(skeleton(blocks.slice(1), t1).text, "## Files touched").split("\n");
		expect(files.at(-1)).toBe(`- src/mod1_1.ts (read: ${handleFor("r-g1")})`);
		expect(files.filter((l) => l.includes("src/mod1_1.ts"))).toHaveLength(1);
		expect(files.some((l) => l.startsWith("- src/mod1_2.ts"))).toBe(true);
	});

	test("narrative: durable epochs stay verbatim; only bounded active state is reconciled and unresolved todos survive", async () => {
		const prompts: string[] = [];
		const texts = await chain(4, prompts);
		const last = texts[3];
		for (let L = 1; L <= 4; L++) {
			expect(last).toContain(`#### Epoch ${L} · requests ${(L - 1) * 4 + 1}–${L * 4}`);
			expect(last).toContain(`DECISION-${L}: chose plan ${L}.`);
			expect(last).toContain(`KEYFACT-${L}: value-${L}`);
			expect(prevBlockOf(prompts[L - 1])).toBeNull();
			expect(prompts[L - 1]).not.toContain("KEYFACT-");
			expect(prompts[L - 1]).not.toContain("DECISION-");
			expect(prompts[L - 1]).toContain("---DECISIONS---");
			expect(prompts[L - 1]).toContain("---ACTIVE---");
		}
		expect(last).toContain("TODO-4: finish 4");
		expect(last).toContain("state line for level 4");
		for (let L = 1; L <= 3; L++) {
			expect(last).toContain(`TODO-${L}: finish ${L}`);
			expect(prompts[L]).toContain(`TODO-${L}: finish ${L}`);
			expect(last).not.toContain(`state line for level ${L}`);
		}
		expect(last).not.toContain("Earlier narrative");
		expect(last.match(/## Narrative \(model-written\)/g)).toHaveLength(1);
		expect(last).not.toContain("## Earlier summary (carried forward)");
	});

	test("an older summary with an 'Earlier narrative' excerpt: excerpt and narrative become Epoch 0 verbatim without re-sending to the model, and the heading is not carried", async () => {
		const old = (await chain(1))[0] + "";
		const legacy = old.slice(0, old.indexOf("\n## Narrative (model-written)\n")) +
			"\n## Earlier narrative (excerpt of the previous summary, newest part)\nKey facts: npm latest 0.2.8\n## Narrative (model-written)\nKEYFACT-1: value-1" +
			old.slice(old.indexOf("\n## Folded outputs"));
		const prompts: string[] = [];
		const t = await cutOver(2, legacy, prompts);
		expect(prevBlockOf(prompts[0])).toBeNull();
		expect(t).toContain("#### Epoch 0 · requests 1–4");
		expect(t).toContain("npm latest 0.2.8");
		expect(t).toContain("KEYFACT-1: value-1");
		expect(t).toContain("#### Epoch 1 · requests 5–8");
		expect(t).toContain("KEYFACT-2: value-2");
		expect(t).not.toContain("Earlier narrative");
	});

	test("each increment asks for a bounded epoch + active word budget; a reply over its budget keeps its head and its tail (the key facts)", async () => {
		const prompts: string[] = [];
		const first = await cutOver(1, null, prompts);
		const entries = [summaryEntry(first), ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const long = "## Decisions and rationale\nHEAD-DECISION\n" + "a sentence of the durable decisions of the work.\n".repeat(2000) + "## Key facts to remember\nTAIL-KEYFACT: 42";
		const complete = async (_m: Any, c: Any, options: Any) => (expect(options.maxTokens).toBe(NARRATIVE_CALL_MAX), prompts.push(c.messages[0].content[0].text), { stopReason: "stop", content: [{ type: "text", text: long }], usage: { cost: { total: 0 } } });
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 40_000, sumTrigger: "cold" };
		const t = (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
		expect(Number(/under about (\d+) words/.exec(prompts[0])![1])).toBe(EPOCH_WORDS + ACTIVE_WORDS);
		expect(Number(/under about (\d+) words/.exec(prompts[1])![1])).toBe(EPOCH_WORDS + ACTIVE_WORDS);
		expect(t).toContain("HEAD-DECISION");
		expect(t).toContain("TAIL-KEYFACT: 42");
		expect(t).toContain("[… middle of the narrative omitted …]");
		const narr = t.slice(t.indexOf("## Narrative (model-written)"), t.indexOf("\n## Folded outputs"));
		expect(narr.length).toBeLessThanOrEqual(MAX_NARRATIVE_TOKENS * 4);
		expect(parseSummary(t).epochs!.epochs).toHaveLength(2);
	});

	test("the previous narrative read by a legacy migration is bounded (head and tail of a longer one), so Epoch 0 cannot grow without limit", () => {
		const huge = "[summary of earlier conversation by pi-zip]\n## User requests (verbatim, oldest first)\n1. x\n## Narrative (model-written)\nHEAD-FACT\n" + "middle line of an endless narrative\n".repeat(3000) + "TAIL-FACT";
		const p = previousNarrative(huge)!;
		expect(p.text.length).toBeLessThanOrEqual(PREV_NARRATIVE_CHARS + 100);
		expect(p.text).toContain("HEAD-FACT");
		expect(p.text).toContain("TAIL-FACT");
		expect(p.text).toContain("[… middle of the narrative omitted …]");
		expect(p.foreign).toBe(false);
	});

	test("narrative call failed after an earlier summary: the previous narrative is carried whole, marked possibly stale, with its time; the next call appends a new epoch after it", async () => {
		const t1 = await cutOver(1, null);
		const at = new Date(2026, 9, 11, 2, 31).getTime();
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: t1, tokensBefore: 0, timestamp: at }] }, ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const down = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete: down } } as Any);
		expect(cut.llmOk).toBe(false);
		expect(cut.text).toContain("## Narrative (carried forward from the summary of 10-11 02:31; possibly stale: a new one could not be written: down)");
		expect(cut.text).toContain("KEYFACT-1: value-1");
		expect(cut.text).not.toContain("(unavailable");
		const prompts: string[] = [];
		const t3 = await cutOver(3, cut.text, prompts);
		expect(prevBlockOf(prompts[0])).toBeNull();
		expect(t3).toContain("KEYFACT-1: value-1");
		expect(t3).toContain("KEYFACT-3: value-3");
	});

	test("no narrative (model call failed): the fallback line points at recall by handle, like the header, not at re-reading", async () => {
		const entries = [...level(1), U("keep1", "kept"), A("keepA1")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const complete = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any);
		expect(cut.llmOk).toBe(false);
		const line = cut.text.split("\n")[cut.text.split("\n").indexOf("## Narrative") + 1];
		expect(line).toMatch(/^\(unavailable: .*; rely on the sections above and zip_recall an output by its handle rather than re-running or re-reading\)$/);
		expect(cut.text).not.toContain("re-read files as needed");
		expect(parseSummary(cut.text).narrative).toEqual([]); // still not taken for content when carried forward
	});

	// 0.4.0/0.4.1 capped the call at the budget: a real CJK merge (5,331 tokens out, 589 of them reasoning) hit the cap on every call
	test("the call's cap is not the narrative budget: a reply past the budget is taken, the cap stays within the model's own limit", async () => {
		const entries = [...level(1), U("keep1", "kept"), A("keepA1")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 40_000, sumTrigger: "cold" };
		const caps: number[] = [];
		// the reply needs 5,400 tokens: cut at any cap below that, like a provider does
		const complete = async (_m: Any, _c: Any, options: Any) => (caps.push(options.maxTokens), options.maxTokens < 5400
			? { stopReason: "length", content: [{ type: "text", text: "## Decisions and rationale\ncut" }], usage: { output: options.maxTokens, cost: { total: 0.01 } } }
			: { stopReason: "stop", content: [{ type: "text", text: "## Decisions and rationale\nWHOLE-REPLY" }], usage: { output: 5400, cost: { total: 0.01 } } });
		for (const [maxTokens, cap] of [[undefined, NARRATIVE_CALL_MAX], [8192, 8192], [128_000, NARRATIVE_CALL_MAX]] as const) {
			caps.length = 0;
			const cut = await buildCut(p, { model: { id: "m", ...(maxTokens ? { maxTokens } : {}) }, modelRegistry: { complete } } as Any);
			expect(cut.llmOk).toBe(true);
			expect(cut.text).toContain("WHOLE-REPLY");
			expect(caps).toEqual([cap]);
		}
		expect(NARRATIVE_CALL_MAX).toBeGreaterThanOrEqual(4 * NARRATIVE_MAX);
	});

	test("a reply cut at the cap is not retried identically: one call, and the summary carries the previous narrative", async () => {
		const t1 = await cutOver(1, null);
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: t1, tokensBefore: 0, timestamp: Date.now() }] }, ...level(2), U("keep2", "kept"), A("keepA2")];
		const blocks = buildBlocks(entries);
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep2"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		let calls = 0;
		const complete = async () => (calls++, { stopReason: "length", content: [{ type: "text", text: "runaway" }], usage: { cost: { total: 0.2 } } });
		const cut = await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any);
		expect(calls).toBe(1);
		expect(cut.llmOk).toBe(false);
		expect(cut.llmError).toBe("narrative hit the token cap");
		expect(cut.costUsd).toBe(0.2);
		expect(cut.text).toContain("KEYFACT-1: value-1");
	});

	test("size stays flat from level 2 on (it does not grow with depth)", async () => {
		const sizes = (await chain(5)).map((t) => Math.ceil(t.length / 4));
		expect(sizes[4]).toBeLessThan(sizes[2] * 1.25);
		expect(sizes[4]).toBeLessThan(12_000); // tokens (chars/4)
	});

	test("the folded-outputs table keeps earlier rows with their hints, newest TABLE_ROWS, and counts the rest", async () => {
		const last = (await chain(4))[3];
		const t = sec(last, "## Folded outputs");
		expect(t).toContain(`- ${cmdHandle(4, 30)} · bash make step-4-30`); // newest first-class
		expect(t).toContain("KEY-4-30: value"); // hint
		expect(t).toContain("KEY-3-30: value"); // a row carried from the previous summary keeps its hint
		const rows = t.split("\n").filter((l) => l.startsWith("- "));
		expect(rows.length).toBeLessThanOrEqual(TABLE_ROWS);
		expect(t).toMatch(/\[… \d+ older folded outputs omitted from this table …\]/);
	});
});

describe("handleTable merge", () => {
	const row = (i: number) => ({ handle: `h${String(i).padStart(9, "0")}x`.slice(0, 10), tool: "bash", args: `c${i}`, hint: `hint ${i}`, turn: i });
	test("previous rows are kept (hints included), a handle appears once with its newest text, and omissions accumulate", () => {
		const a = handleTable(Array.from({ length: 45 }, (_, i) => row(i)))!;
		expect(a).toContain(`${45 - TABLE_ROWS} older folded outputs omitted`);
		const b = handleTable([row(44), ...Array.from({ length: 10 }, (_, i) => ({ ...row(100 + i), hint: "new" }))], a)!;
		expect(b).toContain(`[… ${45 - TABLE_ROWS + 10} older folded outputs omitted from this table …]`);
		expect(b.match(new RegExp(row(44).handle, "g"))).toHaveLength(1);
		expect(b).toContain("hint 43"); // an earlier row, with its hint
		expect(b).not.toContain("hint 10 ");
		expect(b.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(TABLE_ROWS);
	});
});

describe("old formats and foreign summaries", () => {
	const H = (n: string) => handleFor(n);
	// ae3b971: commands with or without a handle, files without handles, a table without a turn; the carried-forward block of that era
	const aeText = [
		"[summary of earlier conversation by pi-zip]",
		"Covers 40 earlier messages. Tool outputs in the kept part of the conversation may have been folded; call zip_recall with a handle to get one back exactly.",
		"## User requests (verbatim, oldest first)",
		"1. OLD-ONE first request",
		"with a second line",
		"2. OLD-TWO second request",
		"## Files touched",
		"- src/a.ts (read, edit)",
		"## Commands run (with exit status)",
		`\`bun test\` -> exit 1 (turn 1, ${H("o1")})`,
		"`ls` -> exit 0 (turn 1)",
		"## Errors",
		"- bash bun test: 2 failed",
		"## Narrative (model-written)",
		"## Decisions and rationale\nOLD-DECISION use bun",
		`## Folded outputs (originals recallable with zip_recall)`,
		`- ${H("o1")} · bash bun test · turn 1 · exit 1, 8 passed, 2 failed · FAIL x`,
	].join("\n");
	// pre-v2 (d0e8892): the request list keeps the first three and a tail with a gap in the numbering
	const preV2 = [
		"[summary of earlier conversation by pi-zip]",
		"## User requests (verbatim, oldest first)",
		"1. P1", "2. P2", "3. P3", "[… 5 requests omitted …]", "9. P9", "10. P10",
		"## Files touched", "(none)",
		"## Commands run (with exit status)", "`ls` -> exit 0",
		"## Errors", "(none)",
		"## Narrative", "(unavailable: no model; rely on the sections above and re-read files as needed)",
		`## Folded outputs`, `- ${H("p1")} · read src/p.ts · big file`,
	].join("\n");

	test("an ae3b971-style summary parses: items, multi-line requests, files without handles, table rows", () => {
		const p = parseSummary(aeText);
		expect(p.structured).toBe(true);
		expect(p.users.items).toEqual(["OLD-ONE first request\nwith a second line", "OLD-TWO second request"]);
		expect([...p.files.rows[0].ops]).toEqual([["read", null], ["edit", null]]);
		expect(p.cmds.items).toHaveLength(2);
		expect(p.errors.items).toEqual(["- bash bun test: 2 failed"]);
		expect(p.table.items).toHaveLength(1);
		expect(p.narrative).toEqual(["## Decisions and rationale\nOLD-DECISION use bun"]);
	});

	test("merging it: new requests come last, old ones are kept while they fit, the old table row and narrative survive", () => {
		const blocks = buildBlocks([U("u1", "NEW-ONE"), tcall("n1", "bash", { command: "make" }), tres("n1", "bash", "ok"), A("e")]);
		const t = skeleton(blocks, aeText).text;
		expect(t.indexOf("OLD-ONE")).toBeLessThan(t.indexOf("OLD-TWO"));
		expect(t.indexOf("OLD-TWO")).toBeLessThan(t.indexOf("NEW-ONE"));
		expect(t).toContain("3. NEW-ONE");
		expect(t).toContain("`bun test` -> exit 1 (turn 1, " + H("o1") + ")");
		expect(t).toContain("`ls` -> exit 0 (turn 1)");
		expect(t).toContain("- src/a.ts (read, edit)");
		expect(t).not.toContain("OLD-DECISION use bun"); // the narrative is the narrative call's to merge ...
		expect(previousNarrative(aeText)!.text).toContain("OLD-DECISION use bun"); // ... which reads it
		expect(handleTable([], aeText)).toContain("FAIL x");
	});

	test("pre-v2: the omission marker in the middle of the list is counted and the numbering gap is accepted", () => {
		const p = parseSummary(preV2);
		expect(p.users.items).toEqual(["P1", "P2", "P3", "P9", "P10"]);
		expect(p.users.omitted).toBe(5);
		expect(p.narrative).toEqual([]); // "(unavailable ...)" is not content
		const t = skeleton(buildBlocks([U("u1", "N1"), A("e")]), preV2).text;
		expect(t).toContain("[… 5 older requests omitted …]\n6. P1\n7. P2\n8. P3\n9. P9\n10. P10\n11. N1");
	});

	test("the older nested format (clipped carried-forward block inside a carried-forward block) keeps the newest level's items", () => {
		const inner = aeText.split("\n").filter((l) => !l.startsWith("Covers ") && l !== "[summary of earlier conversation by pi-zip]").join("\n");
		const outer = [
			"[summary of earlier conversation by pi-zip]", "Covers 9 earlier messages. x",
			"## Earlier summary (carried forward)", inner.slice(0, 600), // clipped mid-line
			"## User requests (verbatim, oldest first)", "1. MID-ONE", "## Files touched", "- src/b.ts (read: " + H("m1") + ")",
			"## Commands run (with exit status)", `\`make\` -> exit 0 (turn 3, ${H("m2")})`, "## Errors", "(none)",
			"## Narrative (model-written)", "MID narrative KEYFACT-MID",
		].join("\n");
		const p = parseSummary(outer);
		expect(p.users.items[0]).toBe("OLD-ONE first request\nwith a second line");
		expect(p.users.items.at(-1)).toBe("MID-ONE");
		expect(p.narrative.at(-1)).toBe("MID narrative KEYFACT-MID");
		const t = skeleton(buildBlocks([U("u1", "NEW"), A("e")]), outer).text;
		expect(t.indexOf("OLD-ONE")).toBeLessThan(t.indexOf("MID-ONE"));
		expect(t.indexOf("MID-ONE")).toBeLessThan(t.indexOf("NEW"));
		expect(t).toContain(H("m2"));
		expect(previousNarrative(outer)!.text).toContain("KEYFACT-MID");
	});

	test("a native Pi compaction summary (free text) becomes Epoch 0 verbatim (head and tail if long) without re-sending to the model; the fallback carries it", async () => {
		const native = "## Goal\nGOAL-LINE ship the synthetic feature\n## Progress\n" + "progress line\n".repeat(900) + "## Next Steps\nNEXT-STEP do the final thing\n<read-files>\nsrc/x.ts\n</read-files>";
		const p = parseSummary(native);
		expect(p.structured).toBe(false);
		const t = skeleton(buildBlocks([U("u1", "NEW"), A("e")]), native).text;
		expect(t).toContain("1. NEW");
		expect(t).not.toContain("GOAL-LINE"); // not an excerpt in the skeleton any more
		const prompts: string[] = [];
		const merged = await cutOver(1, native, prompts);
		expect(prevBlockOf(prompts[0])).toBeNull();
		expect(merged).toContain("#### Epoch 0 · the earlier conversation");
		expect(merged).toContain("GOAL-LINE");
		expect(merged).toContain("NEXT-STEP do the final thing");
		expect(merged).toContain("#### Epoch 1 · requests 1–4");
		expect(merged).toContain("KEYFACT-1");
		const huge = native.replace("progress line\n".repeat(900), "progress line\n".repeat(4000));
		expect(previousNarrative(huge)!.text.length).toBeLessThanOrEqual(PREV_NARRATIVE_CHARS + 100);
		expect(previousNarrative(huge)!.text).toContain("NEXT-STEP");
		// the call fails: Pi's summary is carried, not lost
		const blocks = buildBlocks([summaryEntry(native), ...level(1), U("keep1", "kept"), A("keepA1")]);
		const pl: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
		const down = async () => ({ stopReason: "error", errorMessage: "down", content: [], usage: { cost: { total: 0 } } });
		const cut = await buildCut(pl, { model: { id: "m" }, modelRegistry: { complete: down } } as Any);
		expect(cut.text).toContain("GOAL-LINE");
		expect(cut.text).toContain("NEXT-STEP do the final thing");
		expect(cut.text).toContain("possibly stale");
	});

	test("after a summary that is not pi-zip's, the requests it took out of the view are quoted from the session branch and numbered from the first", async () => {
		const native = "## Goal\nGOAL-LINE ship it";
		const early = [U("e1", "FIRST-ASK review the plan"), A("ea1"), U("e2", "SECOND-ASK add the fixtures\nsecond line"), A("ea2")];
		const after = [...level(1), U("keep1", "kept"), A("keepA1")];
		const cutWith = async (prev: string, branch: Any[]) => {
			const blocks = buildBlocks([summaryEntry(prev), ...after]);
			const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep1"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
			const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: narrativeFor(1) }], usage: { cost: { total: 0 } } });
			return (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete }, sessionManager: { getBranch: () => branch } } as Any)).text;
		};
		const branch = [...early.map((e) => e.sourceEntry), { id: "comp", type: "compaction", summary: native }, ...after.map((e) => e.sourceEntry)];
		const t = await cutWith(native, branch);
		expect(t).toContain("1. FIRST-ASK review the plan");
		expect(t).toContain("2. SECOND-ASK add the fixtures\n   second line");
		expect(t).toMatch(/^3\. (≈ )?REQ-1-1 /m);
		expect(t).toContain("#### Epoch 0 · requests 1–2");
		expect(t).toContain("#### Epoch 1 · requests 3–6");
		expect(t).toContain("GOAL-LINE"); // Pi's text is still carried as Epoch 0
		// the summary's first kept entry is not on this branch: nothing is quoted, numbering starts over as before
		const other = await cutWith(native, early.map((e) => e.sourceEntry));
		expect(other).not.toContain("FIRST-ASK");
		expect(other).toMatch(/^1\. (≈ )?REQ-1-1 /m);
		// a pi-zip summary keeps its own list: the branch is not read
		const ours = await cutOver(1, null);
		const next = await cutWith(ours, branch);
		expect(next).not.toContain("FIRST-ASK");
		expect(next).toMatch(/^1\. (≈ )?REQ-1-1 /m);
	});

	test("a very long request is quoted head and tail; the marker names its handle, and recall returns the whole request", () => {
		const body = Array.from({ length: 5000 }, (_, i) => `line ${i} MID-${i}`).join("\n");
		const h = handleFor("long");
		const blocks = buildBlocks([U("long", body), A("la"), U("u2", "short ask"), A("a2")]);
		const sk = skeleton(blocks, null).text;
		expect(sk).toContain(`[… middle of this request omitted (handle ${h}): zip_recall returns it whole …]`);
		expect(sk).toContain("line 0 MID-0");
		expect(sk).toContain("line 4999 MID-4999");
		expect(sk).not.toContain("MID-2500");
		const branch = [U("long", body), A("la"), R("r1", "c1", 10)].map((e) => e.sourceEntry);
		const { items, entryIds } = resolveHandlesInBranch(branch, [h, "zzzzzzzzzz"]);
		expect(items[0].text).toBe(body);
		expect(items[0].label).toBe("user request");
		expect(entryIds).toEqual(["long", null]);
		expect(skeleton(blocks, null, "", { dir: "~/.cache/pi-zip/recall/S", read: true, grep: true, bash: true }).text)
			.toContain(`(handle ${h}): ~/.cache/pi-zip/recall/S/${h}.txt holds it whole …]`);
		// once the request is shortened to one line between the first and the newest, the handle stays on that line
		const many = [U("x1", "first"), A("xa1"), U("x2", "second"), A("xa2"), U("long", body), A("la"), ...Array.from({ length: 6 }, (_, i) => [U(`n${i}`, "N".repeat(900)), A(`na${i}`)]).flat()];
		const text = skeleton(buildBlocks(many), null).text;
		expect(text).toMatch(new RegExp(`^3\\. ≈ line 0 MID-0.*\\(whole request: handle ${h}\\)$`, "m"));
	});

	test("empty, '(none)'-only, null and a bare mark all merge into an empty-but-valid summary", () => {
		for (const prev of [null, "", "[summary of earlier conversation by pi-zip]", "## User requests (verbatim, oldest first)\n(none)\n## Files touched\n(none)"]) {
			const t = skeleton(buildBlocks([U("u1", "ONLY"), A("e")]), prev).text;
			expect(t).toContain("## User requests (verbatim, oldest first, continuation lines indented)\n1. ONLY\n## Files touched\n(none)");
			expect(t).not.toContain("Earlier narrative");
		}
	});

	test("the first request(s) of the session stay verbatim while they fit their budget (they define the task); the rest go oldest first, with a count", () => {
		const big = (n: number) => `R${n} ` + "w".repeat(2700);
		let prev: string | null = null;
		for (let i = 0; i < 4; i++) prev = skeleton(buildBlocks([U(`a${i}`, big(i * 3)), U(`b${i}`, big(i * 3 + 1)), U(`c${i}`, big(i * 3 + 2)), A(`e${i}`)]), prev).text;
		const t = prev!;
		expect(t).toContain("\n1. R0 www"); // pinned
		expect(t).not.toContain("\n2. R1 www"); // the second does not fit beside it: not pinned
		expect(t).toContain("\n12. R11 www");
		const listed = (t.match(/^\d+\. (≈ )?R\d+ /gm) ?? []).length;
		const omitted = [...t.matchAll(/\[… (\d+) older requests omitted …\]/g)].reduce((a, m) => a + Number(m[1]), 0);
		expect(listed + omitted).toBe(12);
		expect(FIRST_REQUESTS).toBeGreaterThanOrEqual(1);
		// short first requests: the first FIRST_REQUESTS stay
		let q: string | null = null;
		for (let i = 0; i < 6; i++) q = skeleton(buildBlocks([U(`s${i}`, i === 0 ? "TASK: build X" : i === 1 ? "TASK2: and Y" : big(i)), A(`f${i}`)]), q).text;
		expect(q).toContain("\n1. TASK: build X\n2. TASK2: and Y\n");
	});
});

describe("user requests survive carry-forward intact", () => {
	const reqs = ["Steps:\n1. fix A\n2. fix B\n3. fix C", "ok go"];
	const level = (names: string[]) => buildBlocks(names.flatMap((t, i) => [U(`x${i}-${t.length}-${Math.random()}`, t), A(`a${i}-${Math.random()}`)]));
	const users = (text: string) => parseSummary(text).users;

	test("a numbered list or a '## ' heading inside a request stays one request, across levels", () => {
		const heading = "Please look at this output:\n## Errors\nboom\n## Files touched\n- x\n1. not a request";
		let t = skeleton(level([...reqs, heading]), null).text;
		expect(users(t).items).toEqual([...reqs, heading]);
		t = skeleton(level(["next"]), t).text;
		expect(users(t).items).toEqual([...reqs, heading, "next"]);
		expect(t).toContain("1. Steps:\n   1. fix A");
		t = skeleton(level(["last"]), t).text;
		expect(users(t).items).toEqual([...reqs, heading, "next", "last"]);
		expect(t).toContain("4. next");
		expect(t).toContain("5. last");
		// the heading inside the request did not cut the real sections short
		expect(t).toContain("\n## Files touched\n");
	});

	test("with the budget forcing a drop, whole requests go or are shortened, the count is exact and every request keeps its number", () => {
		const big = (n: number) => `REQ${n}\n1. item\n2. item\n` + "x".repeat(5000);
		let t = skeleton(level(Array.from({ length: 10 }, (_, i) => big(i + 1))), null).text;
		t = skeleton(level(Array.from({ length: 10 }, (_, i) => big(i + 11))), t).text;
		t = skeleton(level([big(21)]), t).text;
		const u = users(t);
		expect(u.items.length + u.omitted).toBe(21);
		expect(u.omitted).toBeGreaterThan(0);
		for (const [i, item] of u.items.entries()) expect(item.replace(/^≈ /, "").startsWith(`REQ${u.nums![i]}`)).toBe(true);
		expect(u.items.filter((x) => !x.startsWith("≈ ")).map((_, i) => u.nums![i])).toContain(1);
		expect(t).toContain(`\n21. REQ21\n   1. item`);
		expect(t).toContain(`\n1. REQ1\n   1. item`);
	});

	test("repeated identical requests are all kept, in order, across levels", () => {
		let t = skeleton(level(["first", "yes", "now do Y", "yes"]), null).text;
		expect(users(t).items).toEqual(["first", "yes", "now do Y", "yes"]);
		t = skeleton(level(["yes", "yes"]), t).text;
		expect(users(t).items).toEqual(["first", "yes", "now do Y", "yes", "yes", "yes"]);
		expect(t).toContain("6. yes");
	});

	test("an older-format summary still parses heuristically (list numbers do not split when they are not last+1)", () => {
		const old = "## User requests (verbatim, oldest first)\n1. one\n2. two\n## Files touched\n(none)";
		expect(users(old).items).toEqual(["one", "two"]);
		expect(users(skeleton(level(["three"]), old).text).items).toEqual(["one", "two", "three"]);
	});
});


describe("a reasoning model whose provider refuses effort none (sota gpt-6.1-sol)", () => {
	const REFUSED = "unsupported_value: Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.";
	const refusing = (efforts: (string | undefined)[]) => async (_m: Any, _c: Any, o: Any) => (efforts.push(o?.reasoningEffort), o?.reasoningEffort
		? { stopReason: "stop", content: [{ type: "text", text: "narrative" }], usage: { cost: { total: 0.01 } } }
		: { stopReason: "error", errorMessage: REFUSED, usage: { cost: { total: 0 } } });
	test("asked again with low effort without using up the retry, then low at once for that model", async () => {
		const efforts: (string | undefined)[] = [];
		const ctx = { model: { provider: "sota", id: "unit-refuses-none", reasoning: true }, modelRegistry: { complete: refusing(efforts) } } as Any;
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), ctx, 1000)).ok).toBe(true);
		expect(efforts).toEqual([undefined, "low"]);
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), ctx, 1000)).ok).toBe(true);
		expect(efforts).toEqual([undefined, "low", "low"]);
	});
	test("a model without reasoning is not asked for an effort; other errors are not read as a refused effort", async () => {
		const efforts: (string | undefined)[] = [];
		const plain = { model: { provider: "x", id: "unit-plain", reasoning: false }, modelRegistry: { complete: refusing(efforts) } } as Any;
		expect((await narrative(buildBlocks([U("u", "work"), A("a")]), plain, 1000)).ok).toBe(false);
		expect(efforts).toEqual([undefined, undefined]);
		expect(EFFORT_REFUSED_RE.test(REFUSED)).toBe(true);
		for (const other of ["rate limit exceeded", "context length exceeded", "content policy refusal", "Unsupported value: 'image_url'"]) expect(EFFORT_REFUSED_RE.test(other)).toBe(false);
	});
});

describe("narrative cost survives unsuccessful responses", () => {
	test("a terminal policy refusal retains its reported charge", async () => {
		let calls = 0;
		const n = await narrative(buildBlocks([U("u", "work"), A("a")]), { model: { id: "m" }, modelRegistry: { complete: async () => {
			calls++; return { stopReason: "error", errorMessage: "content policy refusal", usage: { cost: { total: 0.17 } } };
		} } } as Any, 1000);
		expect(n.ok).toBe(false);
		expect(n.costUsd).toBe(0.17);
		expect(calls).toBe(1);
	});
	test("a successful retry retains the charge of its failed attempt", async () => {
		let calls = 0;
		const n = await narrative(buildBlocks([U("u", "work"), A("a")]), { model: { id: "m" }, modelRegistry: { complete: async () => ++calls === 1
			? { stopReason: "error", errorMessage: "transient error", usage: { input: 10, output: 2, totalTokens: 12, cost: { input: 0.01, output: 0.01, total: 0.02 } } }
			: { stopReason: "stop", content: [{ type: "text", text: "finished" }], usage: { input: 20, output: 4, totalTokens: 24, cost: { input: 0.02, output: 0.01, total: 0.03 } } },
		} } as Any, 1000);
		expect(n.ok).toBe(true);
		expect(n.costUsd).toBe(0.05);
		expect(n.usage).toEqual({ input: 30, output: 6, totalTokens: 36, cost: { input: 0.03, output: 0.02, total: 0.05 } });
		expect(calls).toBe(2);
	});
});

describe("append-only narrative epochs (billion-context §3.2, §3.6, §4.2; pi-vcc volatile/durable split)", () => {
	test("unmentioned work is carried until the new slice explicitly completes or supersedes it", async () => {
		const todo = "deploy production after QA approval";
		let previous: string | null = null;
		for (const [i, slice] of ["investigate failures", "debug unrelated parser", `QA approved; completed: ${todo}`].entries()) {
			const blocks = buildBlocks([...(previous ? [summaryEntry(previous)] : []), U(`u${i}`, slice), A(`a${i}`), U("keep", "kept")]);
			const complete = async (_m: Any, context: Any) => {
				const prompt: string = context.messages[0].content[0].text;
				expect(prompt).toContain("silence is not completion");
				if (i > 0) expect(prompt).toContain(`<previous-active-state>\n- ${todo}\n</previous-active-state>`);
				expect(prompt).not.toContain("DURABLE-SECRET");
				return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\nDURABLE-SECRET\n---ACTIVE---\n${i < 2 ? "- " + todo : "- deploy complete"}` }] };
			};
			previous = (await buildCut({ blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 7000 } as Any,
				{ model: { id: "m" }, modelRegistry: { complete } })).text;
			const active = parseSummary(previous).epochs!.activeState;
			if (i < 2) expect(active).toContain(todo); else expect(active).not.toContain(todo);
		}
	});

	test("previous active input is bounded, and an omitted ACTIVE reply does not erase pending work", async () => {
		let sent = "";
		await narrative(buildBlocks([U("u", "work")]), { model: { id: "m" }, modelRegistry: { complete: async (_m: Any, c: Any) => {
			sent = c.messages[0].content[0].text;
			return { stopReason: "stop", content: [{ type: "text", text: "---DECISIONS---\nnew fact" }] };
		} } }, 1000, undefined, "HEAD TODO\n" + "old status\n".repeat(2000) + "TAIL TODO");
		const active = /<previous-active-state>\n([\s\S]*?)\n<\/previous-active-state>/.exec(sent)![1];
		expect(tok4(active)).toBeLessThanOrEqual(ACTIVE_INPUT_TOKENS);
		expect(active).toContain("HEAD TODO");
		expect(active).toContain("TAIL TODO");
		const prev = "## Narrative\n" + formatNarrative({ activeState: "open deploy TODO", epochs: [mkEpoch(1, 1, "request 1", "time unknown", 1, "old fact")] });
		const blocks = buildBlocks([summaryEntry(prev), U("u", "unrelated"), A("a"), U("keep", "kept")]);
		const result = await buildCut({ blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 7000 } as Any,
			{ model: { id: "m" }, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "---DECISIONS---\nnew fact" }] }) } });
		expect(parseSummary(result.text).epochs!.activeState).toBe("open deploy TODO");
	});

	test("clipping the current state keeps open items from the middle, whole lines in order, and counts what it drops", () => {
		const status = (k: number) => `status ${k}: the parser module compiles and its unit tests run green again`;
		const lines = [...Array.from({ length: 20 }, (_, k) => status(k)), "- [ ] rotate the staging key before Friday", ...Array.from({ length: 20 }, (_, k) => status(20 + k))];
		const out = clipActive(lines.join("\n"), 1000).split("\n");
		expect(out.join("\n").length).toBeLessThanOrEqual(1000);
		expect(out).toContain("- [ ] rotate the staging key before Friday"); // a head and tail clip drops exactly this line
		const body = out.slice(0, -1);
		expect(body.every((l) => lines.includes(l))).toBe(true); // never cut inside a line
		expect(body).toEqual(lines.filter((l) => body.includes(l))); // original order
		expect(out.at(-1)).toBe(`[… ${lines.length - body.length} other lines omitted for length …]`);
		// only open items, more than fit: the count names them, and nothing over the bound goes out
		const todos = Array.from({ length: 40 }, (_, k) => `- [ ] item ${k} needs a follow-up check in module ${k}`);
		const t = clipActive(todos.join("\n"), 1000).split("\n");
		expect(t.join("\n").length).toBeLessThanOrEqual(1000);
		expect(t.slice(0, -1)).toEqual(todos.slice(0, t.length - 1));
		expect(t.at(-1)).toBe(`[… ${41 - t.length} open items omitted for length …]`);
		expect(clipActive("short", 1000)).toBe("short");
		// an oversized open item ending in a long path keeps the path prefix instead of stripping back to "- [ ] …"
		const longPath = `- [ ] /home/user/${"sub_directory_segment/".repeat(12)}target_file.ts`;
		const clippedPath = clipActive(`${longPath}\nstatus: waiting`, 220).split("\n")[0];
		expect(clippedPath.startsWith("- [ ] /home/user/sub_directory_segment/")).toBe(true);
		expect(clippedPath.endsWith(" …")).toBe(true);
	});

	test("an open item in the middle of a long current state survives two summaries the conversation is silent on", async () => {
		const critical = "- [ ] re-run the migration on the replica after the index fix";
		const filler = (tag: string) => Array.from({ length: 30 }, (_, k) => `${tag} status ${k}: builds and tests are green on branch feature-${k}`).join("\n");
		let previous: string | null = "## Narrative\n" + formatNarrative({ activeState: `${filler("old")}\n${critical}\n${filler("older")}`, epochs: [mkEpoch(1, 1, "request 1", "time unknown", 1, "old fact")] });
		for (const i of [1, 2]) {
			const blocks = buildBlocks([summaryEntry(previous!), U(`u${i}`, `unrelated work ${i}`), A(`a${i}`), U("keep", "kept")]);
			let sent = "";
			const complete = async (_m: Any, c: Any) => {
				sent = c.messages[0].content[0].text;
				const prev = /<previous-active-state>\n([\s\S]*?)\n<\/previous-active-state>/.exec(sent)?.[1] ?? "";
				// a compliant model: everything it was given (the marker line too), then the new status
				return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\nfact ${i}\n---ACTIVE---\n${prev}\n${filler(`new${i}`)}` }] };
			};
			previous = (await buildCut({ blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 7000 } as Any,
				{ model: { id: "m" }, modelRegistry: { complete } })).text;
			expect(sent).toContain(critical); // the reconciling call saw it
			const active = parseSummary(previous).epochs!.activeState;
			expect(active).toContain(critical);
			expect(active).toMatch(/\[… \d+ other lines omitted for length …\]$/);
		}
	});

	test("tier merge reserve can veto ROI that the narrative call alone would pass", () => {
		const previous = "## Narrative\n" + formatNarrative({ activeState: "deploy after QA", epochs: Array.from({ length: 5 }, (_, i) =>
			mkEpoch(i + 1, i + 1, `request ${i + 1}`, "time unknown", i === 0 ? 2 : 1, "constraint value ".repeat(200))) });
		const entries = [summaryEntry(previous), U("u2", "continue"), AX("bulk", 100_000), U("u3", "next"), A("a3"), U("u4", "last"), A("a4")];
		const trace: Any[] = [], pr = lawPrices("automatic", false), g = 1000;
		const q = plan(entries, { cwd: "/tmp", scale: UNIT, coldCap: 10_000, law: { pr, pWarm: 1, g }, trace });
		expect(q!.c).toBeNull();
		const t = trace.find((t) => t.where === "summary");
		const work = estimateMergeWork(previous, 300);
		expect(work.merges).toBe(3);
		expect(work.outputTokens).toBe(9000); // three word-sized 3000-token caps, not three 16K narrative caps
		const gain = pr.r * (t.B - t.A) ** 2 / (2 * g);
		expect(gain).toBeLessThan(t.K);
		expect(gain).toBeGreaterThan(t.K - (pr.w * work.inputTokens + pr.out * work.outputTokens));
		expect(estimateMergeWork(null, 300).merges).toBe(0);
		expect(estimateMergeWork(previous, 300, 1, { maxTokens: 700 }).outputTokens).toBe(2100);
	});

	test("a model that reasons anyway gets reasoning room on merge calls, and the planner reserve pays for it", async () => {
		const previous = "## Narrative\n" + formatNarrative({ activeState: "pending", epochs: Array.from({ length: 5 }, (_, i) =>
			mkEpoch(i + 1, i + 1, `request ${i + 1}`, "time unknown", 1, "constraint value ".repeat(200))) });
		const always = { provider: "p", id: "always", reasoning: true, thinkingLevelMap: { off: null } };
		// three 3000-token word caps; each gains MERGE_REASONING_TOKENS only where reasoning cannot be turned off
		expect(estimateMergeWork(previous, 300, 1, always).outputTokens).toBe(3 * (3000 + MERGE_REASONING_TOKENS));
		expect(estimateMergeWork(previous, 300, 1, { ...always, thinkingLevelMap: {} }).outputTokens).toBe(9000);
		expect(estimateMergeWork(previous, 300, 1, { ...always, reasoning: false }).outputTokens).toBe(9000);
		expect(estimateMergeWork(previous, 300, 1, { provider: "github-copilot", api: "openai-responses", id: "g", reasoning: true }).outputTokens).toBe(3 * (3000 + MERGE_REASONING_TOKENS));
		expect(estimateMergeWork(previous, 300, 1, { provider: "github-copilot", api: "anthropic-messages", id: "c", reasoning: true }).outputTokens).toBe(9000); // Pi turns its thinking off
		expect(estimateMergeWork(previous, 300, 1, { ...always, maxTokens: 5000 }).outputTokens).toBe(15_000); // never past the model's own limit
		const caps: number[] = [];
		const blocks = buildBlocks([summaryEntry(previous), U("u", "new work"), A("a"), U("keep", "kept")]);
		await buildCut({ blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 300 } as Any, { model: always, modelRegistry: { complete: async (_m: Any, c: Any, options: Any) => {
			if (c.messages[0].content[0].text.includes("<epoch heading=")) caps.push(options.maxTokens);
			return { stopReason: "stop", content: [{ type: "text", text: "- merged" }], usage: { cost: { total: 0 } } };
		} } });
		expect(caps[0]).toBe(3000 + MERGE_REASONING_TOKENS);
	});

	test("merge calls have their own output cap and report predicted and actual costs", async () => {
		const previous = "## Narrative\n" + formatNarrative({ activeState: "pending", epochs: Array.from({ length: 5 }, (_, i) =>
			mkEpoch(i + 1, i + 1, `request ${i + 1}`, "time unknown", 1, "constraint value ".repeat(200))) });
		const blocks = buildBlocks([summaryEntry(previous), U("u", "new work"), A("a"), U("keep", "kept")]);
		let merges = 0, mergeCost = 0;
		const complete = async (_m: Any, c: Any, options: Any) => {
			const prompt: string = c.messages[0].content[0].text;
			const merge = prompt.includes("<epoch heading=");
			if (merge) {
				merges++;
				expect(options.maxTokens).toBeGreaterThanOrEqual(1024);
				expect(options.maxTokens).toBeLessThanOrEqual(3000);
			} else expect(options.maxTokens).toBe(NARRATIVE_CALL_MAX);
			const cost = merge ? (tok4(c.systemPrompt + prompt) + 256 + 4 * options.maxTokens) / 1e6 : 0.01;
			if (merge) mergeCost += cost;
			return { stopReason: "stop", content: [{ type: "text", text: merge ? "- consolidated record" : "---DECISIONS---\nnew fact\n---ACTIVE---\npending" }], usage: { cost: { total: cost } } };
		};
		const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 1000 };
		const cut = await buildCut(p, { model: { id: "m", cost: { input: 1, output: 4 } }, modelRegistry: { complete } });
		expect(merges).toBeGreaterThan(0);
		expect(cut.actualMergeCostUsd).toBeCloseTo(mergeCost);
		expect(cut.predictedMergeCostUsd!).toBeGreaterThanOrEqual(mergeCost);
		expect(cut.costUsd).toBeCloseTo(0.01 + mergeCost);
		expect(cut.usage.cost.total).toBeCloseTo(cut.costUsd);
	});
	test("oversized replies stay bounded on the first and second cut, without a tier merge", async () => {
		let prev: string | null = null;
		for (let i = 1; i <= 2; i++) {
			// A summary persisted before budget enforcement can already contain an oversized epoch.
			if (prev) {
				const old = parseSummary(prev).epochs!.epochs[0].durableProse;
				prev = prev.replace(old, "legacy constraint\n".repeat(2000));
			}
			const blocks = buildBlocks([...(prev ? [summaryEntry(prev)] : []), U(`u${i}`, "request"), A(`a${i}`), U("keep", "kept")]);
			let calls = 0;
			const complete = async () => {
				calls++;
				return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\nHEAD-${i}\n` + "specific constraint abcdefghijklmnopqrstuvwxyz\n".repeat(600) + `TAIL-${i}\n---ACTIVE---\nworking` }] };
			};
			prev = (await buildCut({ blocks, calls: toolCallIndex(blocks), cutIdx: blocks.length - 1, prefixTokens: 50_000, summaryTokensPlanned: 7000 } as Any, { model: { id: "m" }, modelRegistry: { complete } })).text;
			const epochs = parseSummary(prev).epochs!.epochs;
			expect(calls).toBe(1);
			expect(epochs).toHaveLength(i);
			expect(epochs.reduce((n, e) => n + Math.ceil((`#### ${e.id} · ${e.turns} · ${e.timestamp}\n${e.durableProse}`).length / 4) + 1, 0)).toBeLessThanOrEqual(MAX_NARRATIVE_TOKENS);
			expect(epochs.at(-1)!.durableProse).toContain(`HEAD-${i}`);
			expect(epochs.at(-1)!.durableProse).toContain(`TAIL-${i}`);
		}
	});

	test("fallback reserves the newest epoch verbatim, including after a failed tier merge", async () => {
		const old = mkEpoch(1, 1, "request 1", "time unknown", 1, "old record\n".repeat(900));
		const recent = mkEpoch(2, 2, "request 2", "time unknown", 1, "NEW_HEAD\n" + "new record\n".repeat(150) + "NEW_TAIL");
		const cases = [[old, recent]];
		const middle = mkEpoch(2, 2, "request 2", "time unknown", 1, "middle record\n".repeat(500));
		const newest = mkEpoch(3, 3, "request 3", "time unknown", 1, recent.durableProse);
		const failed = await consolidateEpochs([old, middle, newest], {}, 1000);
		expect(failed.error).toBeDefined();
		expect(failed.merges).toBe(1);
		cases.push(failed.epochs);
		for (const input of cases) {
			const result = boundEpochs(input, 1000);
			expect(result.at(-1)).toEqual(input.at(-1));
			expect(result).toHaveLength(2);
			expect(result.reduce((n, e) => n + e.tokens + 1, 0)).toBeLessThanOrEqual(1000);
			expect(formatNarrative({ activeState: "", epochs: result })).toContain("middle of the narrative omitted");
		}
		expect(old.durableProse).toBe("old record\n".repeat(900));
	});

	test("an individually oversized epoch counts heading and omission marker toward the cap", () => {
		const old = mkEpoch(1, 1, "request 1", "time unknown", 1, "HEAD\n" + "long record\n".repeat(2000) + "TAIL");
		const [bounded] = boundEpochs([old], 1000);
		expect(bounded.tokens + 1).toBeLessThanOrEqual(1000);
		expect(bounded.durableProse).toContain("HEAD");
		expect(bounded.durableProse).toContain("TAIL");
	});
	test("1. deterministic preservation test: 6 consecutive compaction cuts keep Fact A..Fact F verbatim in Epoch 1..Epoch 6 without re-summarizing", async () => {
		const facts = ["Fact A: adopted SQLite v3", "Fact B: token bucket 100 req/min", "Fact C: SIGTERM 5s flush", "Fact D: OAuth2 PKCE flow", "Fact E: append-only steer injection", "Fact F: zero-copy ring buffer"];
		let prev: string | null = null;
		const prompts: string[] = [];
		for (let i = 0; i < 6; i++) {
			const entries = [...(prev ? [summaryEntry(prev)] : []), U(`u-${i}`, `turn ${i + 1} request`), A(`a-${i}`), U(`keep-${i}`, "kept"), A(`keepA-${i}`)];
			const blocks = buildBlocks(entries);
			const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === `keep-${i}`), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
			const reply = `---DECISIONS---\n- ${facts[i]}\n---ACTIVE---\n- Active state at cut ${i + 1}`;
			const complete = async (_m: Any, c: Any) => (prompts.push(c.messages[0].content[0].text), { stopReason: "stop", content: [{ type: "text", text: reply }], usage: { cost: { total: 0 } } });
			prev = (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
		}
		expect(prompts).toHaveLength(6);
		for (const pr of prompts) expect(pr).not.toContain("<previous-narrative");
		const parsed = parseSummary(prev!);
		expect(parsed.epochs?.epochs).toHaveLength(6);
		for (let i = 0; i < 6; i++) {
			expect(parsed.epochs!.epochs[i].id).toBe(`Epoch ${i + 1}`);
			expect(parsed.epochs!.epochs[i].durableProse).toBe(`- ${facts[i]}`);
		}
		expect(prev!).toContain("#### Epoch 1 · request 1");
		expect(prev!).toContain("- Fact A: adopted SQLite v3");
	});

	test("2. budget enforcement test: a 15-cut marathon session bounds total narrative tokens under MAX_NARRATIVE_TOKENS via Tier-2+ epoch compaction while keeping recent epochs untouched", async () => {
		let prev: string | null = null;
		let tierMerges = 0;
		for (let i = 1; i <= 15; i++) {
			const entries = [...(prev ? [summaryEntry(prev)] : []), U(`u-${i}`, `req ${i}`), A(`a-${i}`), U(`keep-${i}`, "kept"), A(`keepA-${i}`)];
			const blocks = buildBlocks(entries);
			const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === `keep-${i}`), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
			const complete = async (_m: Any, c: Any) => {
				const prompt: string = c.messages[0].content[0].text;
				if (prompt.includes("<epoch heading=")) {
					tierMerges++;
					const kept = [...prompt.matchAll(/MARATHON-FACT-\d+/g)].map((m) => m[0]);
					return { stopReason: "stop", content: [{ type: "text", text: `- consolidated ${kept.join(", ")}: ` + "condensed architectural record ".repeat(25) }], usage: { cost: { total: 0.001 } } };
				}
				const prose = `- MARATHON-FACT-${i}: ` + `detailed architectural constraint and invariant for epoch ${i} `.repeat(32);
				return { stopReason: "stop", content: [{ type: "text", text: `---DECISIONS---\n${prose}\n---ACTIVE---\n- Working on step ${i}` }], usage: { cost: { total: 0.002 } } };
			};
			prev = (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
		}
		expect(tierMerges).toBeGreaterThan(0);
		const parsed = parseSummary(prev!)!;
		const totalEpochTokens = parsed.epochs!.epochs.reduce((a, e) => a + e.tokens + 1, 0);
		expect(totalEpochTokens).toBeLessThanOrEqual(MAX_NARRATIVE_TOKENS);
		expect(parsed.epochs!.epochs[0].level).toBeGreaterThanOrEqual(2);
		expect(parsed.epochs!.epochs.at(-1)!.id).toBe("Epoch 15");
		expect(parsed.epochs!.epochs.at(-1)!.level).toBe(1);
		expect(parsed.epochs!.epochs.at(-1)!.durableProse).toContain("MARATHON-FACT-15:");
		expect(parsed.epochs!.epochs.at(-2)!.id).toBe("Epoch 14");
		expect(parsed.epochs!.epochs.at(-2)!.level).toBe(1);
		expect(parsed.epochs!.epochs.at(-2)!.durableProse).toContain("MARATHON-FACT-14:");
		expect(prev!).toContain("MARATHON-FACT-1"); // preserved inside the consolidated archive epoch
	});

	test("3. volatile invalidation test: an error/blocker in Active State during cut 2 is completely wiped out in cut 3 while cut 2's durable decision survives", async () => {
		const replies = [
			"---DECISIONS---\n- DECISION-CUT-1: use Bun test runner\n---ACTIVE---\n- Initial setup complete",
			"---DECISIONS---\n- DECISION-CUT-2: lock schema at v3\n---ACTIVE---\n- BLOCKER-CUT-2: broken token refresh race in src/auth/session.ts:84",
			"---DECISIONS---\n- DECISION-CUT-3: fixed race with mutex\n---ACTIVE---\n- Clean active state: all 42 auth tests passing",
		];
		let prev: string | null = null;
		for (let i = 0; i < 3; i++) {
			const entries = [...(prev ? [summaryEntry(prev)] : []), U(`u-${i}`, `req ${i + 1}`), A(`a-${i}`), U(`keep-${i}`, "kept"), A(`keepA-${i}`)];
			const blocks = buildBlocks(entries);
			const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === `keep-${i}`), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
			const complete = async () => ({ stopReason: "stop", content: [{ type: "text", text: replies[i] }], usage: { cost: { total: 0 } } });
			prev = (await buildCut(p, { model: { id: "m" }, modelRegistry: { complete } } as Any)).text;
			if (i === 1) expect(prev).toContain("BLOCKER-CUT-2");
		}
		expect(prev!).not.toContain("BLOCKER-CUT-2");
		expect(prev!).not.toContain("Initial setup complete");
		expect(prev!).toContain("Clean active state: all 42 auth tests passing");
		expect(prev!).toContain("DECISION-CUT-1: use Bun test runner");
		expect(prev!).toContain("DECISION-CUT-2: lock schema at v3");
		expect(prev!).toContain("DECISION-CUT-3: fixed race with mutex");
		const roundTrip = parseEpochNarrative(formatNarrative(parseSummary(prev!).epochs!))!;
		expect(roundTrip.activeState).toContain("Clean active state: all 42 auth tests passing");
		expect(roundTrip.epochs.map((e) => e.id)).toEqual(["Epoch 1", "Epoch 2", "Epoch 3"]);
	});

	test("4. bounded reasoning excerpts: narrative includes labeled tentative thinking only for clean tool-only steps, newest-first under budget", async () => {
		const toolOnly = (id: string, thought: string, extra: Any[] = [], stopReason = "toolUse") => ({
			sourceEntry: { id, type: "message", message: {} },
			messages: [{
				role: "assistant",
				stopReason,
				content: [
					{ type: "thinking", thinking: thought },
					...extra,
					{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: `src/${id}.ts` } },
				],
			}],
		});
		const entries = [
			U("u1", "investigate parser"),
			toolOnly("a-clean", "Checking parser token boundary at offset 128"),
			tres("a-clean", "read", "offset 128"),
			toolOnly("a-visible", "Private draft thought that must be suppressed because visible text exists", [{ type: "text", text: "Visible explanation" }]),
			tres("a-visible", "read", "ok"),
			toolOnly("a-redacted", "Secret redacted thought", [{ type: "thinking", thinking: "Redacted block", redacted: true }]),
			toolOnly("a-aborted", "Aborted step thought that must not enter summary", [], "aborted"),
			U("keep", "kept"),
			A("keepA"),
		];
		// Make a-redacted's only thinking block redacted:
		entries[5].messages[0].content[0].redacted = true;

		const blocks = buildBlocks(entries);
		let sentPrompt = "";
		const complete = async (_m: Any, c: Any) => {
			sentPrompt = c.messages[0].content[0].text;
			return { stopReason: "stop", content: [{ type: "text", text: "---DECISIONS---\n- Parser checked\n---ACTIVE---\n- [ ] Next" }], usage: { cost: { total: 0 } } };
		};
		await narrative(blocks.slice(0, blocks.findIndex((b) => b.entryId === "keep")), { model: { id: "m" }, modelRegistry: { complete } }, 1000);
		expect(sentPrompt).toContain(`${REASONING_NOTE}Checking parser token boundary at offset 128`);
		expect(sentPrompt).toContain(REASONING_QUALIFICATION);
		expect(sentPrompt).not.toContain("Private draft thought");
		expect(sentPrompt).not.toContain("Secret redacted thought");
		expect(sentPrompt).not.toContain("Aborted step thought");

		// Budget allocation: newest wins when total cap is tight, but output order stays chronological
		const r = reasoningInput([
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "OLDEST-THOUGHT" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }] },
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "MIDDLE-THOUGHT" }, { type: "toolCall", id: "c2", name: "read", arguments: {} }] },
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "NEWEST-THOUGHT" }, { type: "toolCall", id: "c3", name: "read", arguments: {} }] },
		], { perMessage: 120, total: (REASONING_NOTE.length + "MIDDLE-THOUGHT".length) * 2 });
		expect(r.selected).toEqual([1, 2]);
		expect(r.messages[0].content).toEqual([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]);
		expect(r.messages[1].content[0].text).toBe(`${REASONING_NOTE}MIDDLE-THOUGHT`);
		expect(r.messages[2].content[0].text).toBe(`${REASONING_NOTE}NEWEST-THOUGHT`);
		expect(r.addedChars).toBeLessThanOrEqual(REASONING_LIMITS.total);
	});
});
