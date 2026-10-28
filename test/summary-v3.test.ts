// Format v3 (state digest). Expected values are worked out by hand from the rules in src/summary-v3.ts, not copied from its output.
import { expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { recallRequestsInBranch } from "../src/recall-extended.ts";
import { buildCut, estimateMergeWork, parseSummary } from "../src/summary-engine.ts";
import { buildEpochSummaryV2 } from "../src/summary-v2.ts";
import {
	applyDigestOps, buildSummaryV3, type Digest, type DigestKey, type DigestOp, itemsOf, parseSummaryV3, parseV3Reply, prepareV3, previousDigest,
	renderSummaryV3, renderV3, SUMMARY_V3_MARK, v3Prompt, type V3Row,
} from "../src/summary-v3.ts";

const message = (id: string, role: string, content: any, extra: any = {}) => {
	const m = { role, content, ...extra };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const execution = (id: string, tool: string, args: any, output: string, isError = false) => [
	message(`a-${id}`, "assistant", [{ type: "toolCall", id, name: tool, arguments: args }]),
	message(`r-${id}`, "toolResult", output, { toolName: tool, toolCallId: id, isError }),
];
const h = handleFor;
const branchOf = (entries: any[]) => entries.map((e) => e.sourceEntry);
/** One ADD per given section, in DIGEST order. */
const adds = (o: Partial<Record<DigestKey, string>>): DigestOp[] => Object.entries(o).map(([section, text]) => ({ op: "add", section: section as DigestKey, text: text! }));
const texts = (d: Digest) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.map((i) => `#${i.id} ${i.text}`)]));
/** Rows as short labels: "R3" resident, "R1–R2 digested", "R4 ack". */
const shape = (rows: V3Row[]) => rows.map((r) => ("range" in r ? `R${r.range.first}${r.range.last > r.range.first ? `–R${r.range.last}` : ""} ${r.range.kind}` : `R${r.request.number}`));

test("go-ahead folding follows the model's judgement only, bounded to short user requests of this slice", () => {
	const long = "continue ".repeat(30); // 270 chars
	const entries = [
		message("u1", "user", "Build the parser"),
		message("u2", "user", "ok"),
		message("u3", "user", "ok, but do not commit"),
		message("u4", "user", "tiếp"),
		message("a1", "assistant", [{ type: "text", text: "Working on it." }]),
		message("u5", "user", long),
		message("u6", "user", "yes"),
		message("u7", "user", "go"),
		message("u8", "user", "Now add tests for the lexer"),
	];
	const prefix = buildBlocks(entries), branch = branchOf(entries);
	// u3 starts like u2 but is not proposed: the code must not fold it on its own. u5 is proposed but too long; a1 is not a user request.
	const acks = [h("u2"), h("u4"), h("u5"), h("u6"), h("u7"), h("a1"), "0000000000"];
	const p = prepareV3({ prefix, branch, acknowledgements: acks });
	expect(shape(p.state.rows)).toEqual(["R1", "R2 ack", "R3", "R4 ack", "R5", "R6–R7 ack", "R8"]);
	expect(p.stats.ackAccepted).toBe(4);
	const text = renderV3(p.state);
	expect(text).toContain(`- R6–R7 go-ahead only (2 requests, judged by the summariser); zip_recall({ requests: "6-7" }) returns the exact text`);
	expect(text).toContain("  > ok, but do not commit");
	// no proposals: nothing is folded, however short
	expect(shape(prepareV3({ prefix, branch }).state.rows)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
	// the folded text stays recallable byte for byte
	expect(recallRequestsInBranch(branch, "6-7").text).toContain("yes");
});

test("the room decides how many older requests stay verbatim (at least `recent`); only branch-recallable requests leave", () => {
	const first = [message("u1", "user", "Design the cache"), message("u2", "user", "ok"), message("u3", "user", "Use LRU, not LFU")];
	const second = [message("u4", "user", "Add eviction metrics"), message("u5", "user", "Profile it under load")];
	const branch = branchOf([...first, ...second]);
	const tight = { soft: 1, hard: Infinity };
	const one = buildSummaryV3({ prefix: buildBlocks(first), branch, acknowledgements: [h("u2")], recent: 2, targetTokens: 1 });
	expect(shape(parseSummaryV3(one.text)!.rows)).toEqual(["R1", "R2 ack", "R3"]);
	const two = prepareV3({ prefix: buildBlocks(second), previous: one.text, branch, recent: 2 });
	expect(shape(parseSummaryV3(renderSummaryV3(two, tight).text)!.rows)).toEqual(["R1–R3 digested", "R4", "R5"]);
	expect(recallRequestsInBranch(branch, "1-3").text).toContain("Use LRU, not LFU");
	// room for exactly one more request: the newest older one (R3) comes back, R1 does not, and the aged go-ahead joins R1's range
	const withR3 = renderSummaryV3(two, { soft: Infinity, hard: Infinity }).text.replace(/^- R1 · handle[^\n]*\n {2}> Design the cache\n- R2 go-ahead only[^\n]*\n/m, `- R1–R2 digested (2 requests); zip_recall({ requests: "1-2" }) returns the exact text\n`);
	expect(withR3).toContain("- R1–R2 digested");
	const roomy = renderSummaryV3(two, { soft: Math.ceil(withR3.length / 4), hard: Infinity });
	expect(roomy.text).toBe(withR3);
	// without the raw branch nothing proves recall, so no request text leaves the summary; the range stays a range
	const blind = prepareV3({ prefix: buildBlocks(second), previous: one.text, branch: [], recent: 2 });
	expect(shape(parseSummaryV3(renderSummaryV3(blind, tight).text)!.rows)).toEqual(["R1", "R2 digested", "R3", "R4", "R5"]);
});

test("digest operations: an item no operation names is kept word for word; bad operations change nothing; a failed call applies none", () => {
	const entries = [message("u1", "user", "Start")];
	const one = buildSummaryV3({
		prefix: buildBlocks(entries), branch: branchOf(entries), digestAt: "10-01 10:00 UTC",
		ops: adds({ architecture: "A1 parser in src/p.ts", decisions: "D1 keep LRU", discarded: "X1 LFU was slower", tests: "T1 12 pass", open: "O1 add metrics" }),
	});
	expect(texts(parseSummaryV3(one.text)!.digest)).toEqual({ architecture: ["#1 A1 parser in src/p.ts"], decisions: ["#2 D1 keep LRU"], discarded: ["#3 X1 LFU was slower"], tests: ["#4 T1 12 pass"], open: ["#5 O1 add metrics"] });
	// the reply mentions only #2 (edit), #5 (drop with a reason) and #3 (drop without a reason: refused); #1 and #4 are not mentioned
	const reply = parseV3Reply([
		"---DECISIONS---", "EDIT #2: D2 keep LRU with TTL", "  (TTL 60 s)", "MOVE #9: ghost", "Some prose the model should not write",
		"---DISCARDED---", "DROP #3:", "---OPEN---", "DROP #5: done: metrics merged in src/m.ts", "ADD i6: O2 profile", "---TESTS---", "(none)",
	].join("\n"))!;
	expect(reply.malformed).toBe(1);
	const next = [message("u2", "user", "Next")];
	const two = prepareV3({ prefix: buildBlocks(next), previous: one.text, branch: branchOf([...entries, ...next]), ops: reply.ops, digestAt: "10-02 11:00 UTC" });
	expect(texts(two.state.digest)).toEqual({ architecture: ["#1 A1 parser in src/p.ts"], decisions: ["#2 D2 keep LRU with TTL\n(TTL 60 s)"], discarded: ["#3 X1 LFU was slower"], tests: ["#4 T1 12 pass"], open: ["#6 O2 profile"] });
	expect([two.ops.edited, two.ops.added, two.ops.rejected]).toEqual([1, 1, 2]);
	expect(two.ops.dropped).toEqual([{ id: 5, text: "O1 add metrics", reason: "done: metrics merged in src/m.ts" }]);
	const twoText = renderSummaryV3(two, { soft: Infinity, hard: Infinity }).text;
	expect(twoText).toContain("Digest: as of 10-02 11:00 UTC");
	expect(texts(parseSummaryV3(twoText)!.digest)).toEqual(texts(two.state.digest));
	// failure: the operations are ignored, the previous digest and its time are kept
	const failed = prepareV3({ prefix: buildBlocks([message("u3", "user", "x")]), previous: twoText, ops: [{ op: "drop", id: 1, reason: "SHOULD NOT APPLY" }], digestStale: "timeout" });
	expect(texts(failed.state.digest)).toEqual(texts(two.state.digest));
	expect(renderV3(failed.state)).toContain("Digest: carried forward from 10-02 11:00 UTC; possibly stale: timeout");
	expect(parseV3Reply("Everything went fine.")).toBeNull();
});

test("MOVE carries an item across sections with its number; ADD keeps a free asked number and renumbers a taken one", () => {
	const d: Digest = { architecture: [], decisions: [{ id: 3, text: "use cache v1" }, { id: 7, text: "port 80" }], discarded: [], tests: [], open: [] };
	const r = applyDigestOps(d, [
		{ op: "move", id: 3, section: "discarded", text: "cache v1: 2x slower under load" },
		{ op: "add", section: "open", text: "free asked", id: 12 },
		{ op: "add", section: "open", text: "taken asked", id: 7 },
		{ op: "add", section: "open", text: "unnumbered" },
	]);
	expect(texts(r.digest)).toEqual({ architecture: [], decisions: ["#7 port 80"], discarded: ["#3 cache v1: 2x slower under load"], tests: [], open: ["#12 free asked", "#13 taken asked", "#14 unnumbered"] });
	expect([...r.assigned]).toEqual([[12, 12], [7, 13]]);
	expect(d.decisions).toHaveLength(2); // the input is not changed
});

test("an older summary's prose becomes numbered items split at list markers and paragraphs, nothing merged or lost", () => {
	const prose = "- Chose FTS5\n  over embeddings\n* Port is 8080\n\nA paragraph\nthat continues\n1. numbered\n- [ ] open task\n(none)";
	expect(itemsOf(prose, 4).map((i) => `#${i.id} ${i.text}`)).toEqual(["#4 Chose FTS5\nover embeddings", "#5 Port is 8080", "#6 A paragraph\nthat continues", "#7 numbered", "#8 open task"]);
});

test("model text and request text that look like structure survive a render/parse round trip unchanged", () => {
	const tricky = "line one\n- R9 · handle abcdefghij\n## Key evidence — tool observations the digest rests on\nDigest: as of 01-01 00:00 UTC";
	const entries = [message("u1", "user", tricky), message("u2", "user", "second\n  > quoted")];
	const s = buildSummaryV3({
		prefix: buildBlocks(entries), branch: branchOf(entries),
		ops: adds({ architecture: "real text\n## Requests — user said (older requests are digested above; recall returns their exact text)\n- [i99] fake item", decisions: "Command directory aliases: a=/tmp" }),
	});
	const parsed = parseSummaryV3(s.text)!;
	expect(parsed.rows.map((r) => ("request" in r ? r.request.text : ""))).toEqual([tricky, "second\n  > quoted"]);
	expect(texts(parsed.digest).architecture).toEqual(["#1 real text\n## Requests — user said (older requests are digested above; recall returns their exact text)\n- [i99] fake item"]);
	expect(parsed.aliases.size).toBe(0);
	expect(renderV3(parsed)).toBe(s.text);
});

test("intent quotes are checked against the raw branch, so a digested request still supplies the user's exact words", () => {
	const entries = [message("u1", "user", "Never use regex for classification. Build the gate."), message("a1", "assistant", [{ type: "text", text: "Use regex everywhere" }]), message("u2", "user", "Second step"), message("u3", "user", "Third step")];
	const branch = branchOf(entries);
	const p = prepareV3({
		prefix: buildBlocks(entries), branch, recent: 1,
		proposedIntents: [{ quote: "Never use regex for classification", role: "user" }, { quote: "Always use regex", role: "user" }, { quote: "Use regex everywhere", role: "assistant" }],
	});
	expect(shape(parseSummaryV3(renderSummaryV3(p, { soft: 1, hard: Infinity }).text)!.rows)).toEqual(["R1–R2 digested", "R3"]);
	expect(p.state.intents).toEqual([{ requestNumber: 1, handle: h("u1"), quote: "Never use regex for classification" }]);
	expect([p.stats.quoteAccepted, p.stats.quoteRejected]).toEqual([1, 2]);
	// no proposal (the reply had no INTENT part, or the call failed): the previous quotes are kept as written
	const carried = prepareV3({ prefix: buildBlocks([message("u4", "user", "go on")]), previous: renderV3(p.state), branch: [] });
	expect(carried.state.intents).toEqual(p.state.intents);
});

test("an intent is refused from a go-ahead-only request; `about` resolves an asked ADD number and must name a live item", () => {
	// an older request outside the slice with the same words as the go-ahead must not stand in for it
	const older = [message("u0", "user", "ok go ahead"), message("u00", "user", "find ways to improve the ranking")];
	const entries = [message("u1", "user", "find ways to improve the ranking"), message("u2", "user", "ok go ahead")];
	const branch = branchOf([...older, ...entries]);
	const reply = parseV3Reply([
		"---OPEN---", "ADD #1: Improve LLM2 source ranking for session audits", "ADD #2: User approved (R2) the provenance A/B probe",
		"---INTENT---", '- "find ways to improve the ranking" → i1', '- "ok go ahead" → i2', '- "improve the ranking" → #42',
		"---ACKNOWLEDGEMENTS---", `- ${h("u2")}`,
	].join("\n"))!;
	expect(reply.intent).toEqual([{ quote: "find ways to improve the ranking", about: 1 }, { quote: "ok go ahead", about: 2 }, { quote: "improve the ranking", about: 42 }]);
	const p = prepareV3({ prefix: buildBlocks(entries), branch, ops: reply.ops, acknowledgements: reply.acknowledgements, proposedIntents: reply.intent!.map((i) => ({ ...i, role: "user" })) });
	expect(p.state.intents).toEqual([
		{ requestNumber: 3, handle: h("u1"), quote: "find ways to improve the ranking", about: 1 },
		{ requestNumber: 3, handle: h("u1"), quote: "improve the ranking" }, // #42 names no item: the quote stays, the link does not
	]);
	expect([p.stats.quoteAccepted, p.stats.quoteRejected, p.stats.quoteAck]).toEqual([2, 1, 1]);
	const text = renderV3(p.state);
	expect(text).toContain(`- R3 · source ${h("u1")} · about i1\n  > find ways to improve the ranking`);
	expect(parseSummaryV3(text)!.intents).toEqual(p.state.intents);
	// the asked number was taken by a carried item: the link follows the renumbered ADD, not the old item
	const prev: Digest = { architecture: [], decisions: [{ id: 1, text: "old decision" }], discarded: [], tests: [], open: [] };
	const tune = [message("u5", "user", "find ways to tune it")];
	const moved = prepareV3({
		prefix: buildBlocks(tune), branch: branchOf([...older, ...entries, ...tune]), previous: renderV3({ ...p.state, digest: prev, intents: [] }),
		ops: [{ op: "add", section: "open", text: "new task", id: 1 }], proposedIntents: [{ quote: "find ways", about: 1, role: "user" }],
	});
	expect(texts(moved.state.digest).open).toEqual(["#2 new task"]);
	expect(moved.state.intents[0].about).toBe(2);
	// carried without a proposal: a link to an item that a later call dropped goes, the quote stays
	const later = prepareV3({ prefix: buildBlocks([message("u3", "user", "next")]), previous: text, branch: branchOf([...older, ...entries, message("u3", "user", "next")]), ops: [{ op: "drop", id: 1, reason: "done" }] });
	expect(later.state.intents[0]).toEqual({ requestNumber: 3, handle: h("u1"), quote: "find ways to improve the ranking" });
});

test("evidence: only selected or digest-named outputs are listed; this slice's always, older selected ones newest first as room allows", () => {
	const first = [
		message("u1", "user", "Fix and verify"),
		...execution("e1", "bash", { command: "bun test parser" }, "10 pass\n0 fail"),
		...execution("e2", "bash", { command: "ps -p 42" }, "42 R 0:01"),
		...execution("e3", "bash", { command: "make all" }, "linker error\nCommand exited with code 2", true),
		...execution("e4", "todo", { action: "update", id: 3 }, "completed"),
		...execution("e5", "bash", { command: "git commit -m x" }, "abc123 x"),
	];
	const second = [message("u2", "user", "Ship it"), ...execution("e6", "bash", { command: "npm publish" }, "published 1.0.0")];
	const ids = (t: string) => parseSummaryV3(t)!.evidence.map((r) => /execution a-(e\d):0/.exec(r)?.[1]);
	const one = prepareV3({
		prefix: buildBlocks(first), branch: branchOf(first), ops: adds({ decisions: `Parser tests pass (bash bun test parser, ${h("r-e1")}).` }),
		proposedEvidence: [{ sourceHandle: h("r-e3"), quote: "linker error" }, { sourceHandle: h("r-e5"), quote: "abc123 x" }],
	});
	// e2 (a status poll) and e4 (a task-list update) are neither selected nor named: never candidates. This slice's records are the base.
	const oneText = renderSummaryV3(one, { soft: 1, hard: Infinity }).text;
	expect(ids(oneText)).toEqual(["e1", "e3", "e5"]);
	const branch = branchOf([...first, ...second]);
	const two = prepareV3({ prefix: buildBlocks(second), previous: oneText, branch, proposedEvidence: [{ sourceHandle: h("r-e6"), quote: "published 1.0.0" }] });
	// base: e1 (the carried digest names it) and e6 (this slice); e3 and e5 are carried and fill the room
	expect(ids(renderSummaryV3(two, { soft: 1, hard: Infinity }).text)).toEqual(["e1", "e6"]);
	expect(ids(renderSummaryV3(two, { soft: Infinity, hard: Infinity }).text)).toEqual(["e1", "e3", "e5", "e6"]);
	// room for one carried record: the newest (e5), not the older error
	const base = parseSummaryV3(renderSummaryV3(two, { soft: 1, hard: Infinity }).text)!;
	const withE5 = { ...base, evidence: two.state.evidence.filter((r) => !/a-e3:0/.test(r)) };
	const fit = renderSummaryV3(two, { soft: Math.ceil(renderV3(withE5).length / 4), hard: Infinity });
	expect(ids(fit.text)).toEqual(["e1", "e5", "e6"]);
	expect(fit.diagnostics.evidenceDropped).toBe(1);
});
test("the hard room drops evidence, then digests old resident requests, before it touches intents or sections; overflow when nothing fits", () => {
	const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
	const entries = [
		message("u1", "user", `Goal: ${words(60, "alpha")}`),
		message("u2", "user", `Keep the public API stable. ${words(60, "beta")}`),
		message("u3", "user", `Third: ${words(60, "gamma")}`),
		...execution("e1", "bash", { command: "bun test" }, `${words(40, "out")}\n5 pass\n0 fail`),
	];
	const prefix = buildBlocks(entries), branch = branchOf(entries);
	const prep = prepareV3({
		prefix, branch,
		ops: adds({ architecture: "Arch.", decisions: "Dec.", discarded: "Disc.", tests: "Tests.", open: "open" }),
		proposedEvidence: [{ sourceHandle: h("r-e1"), quote: "5 pass\n0 fail" }],
		proposedIntents: [{ quote: "Keep the public API stable.", role: "user" }],
	});
	expect(prep.state.evidence).toHaveLength(1);
	// the expected end state: no evidence and R1 digested, everything else as prepared
	const target = { ...prep.state, evidence: [], rows: [{ range: { first: 1, last: 1, kind: "digested" as const } }, ...prep.state.rows.slice(1)] };
	const hard = Math.ceil(renderV3(target).length / 4);
	const fit = renderSummaryV3(prep, { soft: hard, hard });
	expect(fit.ok).toBe(true);
	expect(fit.text).toBe(renderV3(target));
	expect(fit.diagnostics.intentsOmitted).toBe(0);
	expect(fit.diagnostics.sectionsOmitted).toBe(0);
	// without the branch the requests cannot be digested: the intents and sections give way instead, and the request text stays
	const blind = renderSummaryV3(prepareV3({ prefix, ops: adds({ architecture: "Arch.", decisions: "Dec.", discarded: "Disc.", tests: "Tests.", open: "open" }), proposedIntents: [{ quote: "Keep the public API stable.", role: "user" }] }), { soft: hard, hard });
	expect(blind.diagnostics.digestedCount).toBe(0);
	expect(blind.diagnostics.intentsOmitted).toBe(1);
	expect(blind.text).toContain("alpha59");
	const none = renderSummaryV3(prep, { soft: 40, hard: 40 });
	expect(none.ok).toBe(false);
	expect(none.reason).toBe("request-budget-overflow");
	expect(none.overflow).toEqual({ requiredTokens: Math.ceil(none.text.length / 4), availableTokens: 40 });
});

test("a v2 previous summary migrates: request numbers and selected evidence carry, and each prose item is kept unless an operation names it", () => {
	const first = [message("u1", "user", "Index the logs"), ...execution("s1", "bash", { command: "bun test" }, "7 pass\n0 fail")];
	const v2 = buildEpochSummaryV2({
		prefix: buildBlocks(first), branch: branchOf(first), durableProse: "- Chose FTS5 over embeddings: equal recall on keywords.\n- Port 8080 is fixed by the proxy.", activeState: "- [ ] add stemming",
		proposedEvidence: [{ sourceHandle: h("r-s1"), quote: "7 pass\n0 fail" }],
	}).text;
	const next = [message("u2", "user", "Add stemming")];
	const branch = branchOf([...first, ...next]);
	const before = previousDigest(v2);
	expect(texts(before.digest)).toEqual({ architecture: [], decisions: ["#1 Chose FTS5 over embeddings: equal recall on keywords.", "#2 Port 8080 is fixed by the proxy."], discarded: [], tests: [], open: ["#3 add stemming"] });
	const prompt = v3Prompt("[user]: Add stemming", before.digest, before.intents);
	expect(prompt).toContain("---DECISIONS--- (85 of 6000 characters)\n- [i1] Chose FTS5 over embeddings: equal recall on keywords.\n- [i2] Port 8080 is fixed by the proxy.");
	expect(prompt).toContain("number new items i4, i5");
	// the call moves #1 to architecture and closes #3; #2 is not mentioned and stays as it was
	const p = prepareV3({ prefix: buildBlocks(next), previous: v2, branch, ops: [{ op: "move", id: 1, section: "architecture" }, { op: "drop", id: 3, reason: "stemming merged" }] });
	expect(shape(p.state.rows)).toEqual(["R1", "R2"]);
	expect(p.state.evidence).toHaveLength(1);
	expect(p.state.evidence[0]).toContain("Selected evidence: 7 pass ⏎ 0 fail");
	expect(texts(p.state.digest)).toEqual({ architecture: ["#1 Chose FTS5 over embeddings: equal recall on keywords."], decisions: ["#2 Port 8080 is fixed by the proxy."], discarded: [], tests: [], open: [] });
	// a failed first v3 call keeps every migrated item
	expect(texts(prepareV3({ prefix: buildBlocks(next), previous: v2, branch, digestStale: "timeout" }).state.digest)).toEqual(texts(before.digest));
});

test("older readers see a v3 summary: request numbers and the digested count; a digest is priced as input, never as a merge", () => {
	const entries = [message("u1", "user", "a"), message("u2", "user", "b"), message("u3", "user", "c"), ...execution("x", "bash", { command: "cd /repo/app && make" }, "ok")];
	const text = buildSummaryV3({ prefix: buildBlocks(entries), branch: branchOf(entries), recent: 1, targetTokens: 1, ops: adds({ decisions: `Built with make (${h("r-x")}).`, open: "ship" }) }).text;
	const pp = parseSummary(text);
	expect(pp.structured).toBe(true);
	expect(pp.users).toEqual({ items: ["c"], omitted: 2, nums: [3] });
	expect(pp.epochs!.activeState).toBe("ship");
	const work = estimateMergeWork(text, 300, 1);
	expect(work.merges).toBe(0);
	expect(work.inputTokens).toBeGreaterThan(0);
});

test("buildCut v3: one call reads labelled requests; the reply's digest, go-ahead labels and evidence are wired; a failure is marked stale", async () => {
	const entries = [message("u1", "user", "Verify the build"), ...execution("run", "bash", { command: "bun test" }, "893 pass\n0 fail"), message("u2", "user", "ok"), message("u3", "user", "kept")];
	const blocks = buildBlocks(entries);
	let calls = 0, prompt = "";
	const reply = [
		"---ARCHITECTURE---", "ADD #1: src/core.ts runs the build.", "---DECISIONS---", "ADD #2: Build verified.", "---DISCARDED---", "(none)", "---TESTS---", "ADD #3: 893 pass, 0 fail (bun test); no baseline failures",
		"---OPEN---", "(none)", "---INTENT---", '- "Verify the build" → i2', "---ACKNOWLEDGEMENTS---", `- ${h("u2")}`, "---EVIDENCE---", JSON.stringify({ sourceHandle: h("r-run"), quote: "893 pass\n0 fail" }),
	].join("\n");
	const ctx: any = {
		model: { provider: "p", id: "m", cost: { input: 0, output: 0 } },
		sessionManager: { getBranch: () => branchOf(entries) },
		modelRegistry: { complete: async (...args: any[]) => { calls++; prompt = JSON.stringify(args); return { stopReason: "stop", content: [{ type: "text", text: reply }], usage: { cost: { total: 0 } } }; } },
	};
	const p: any = { blocks, calls: toolCallIndex(blocks), cutIdx: 4, prefixTokens: 2000, summaryTokensPlanned: 1, summaryRoomTokens: 3000, summaryFormat: "v3", sumTrigger: "cold" };
	const cut = await buildCut(p, ctx);
	expect(calls).toBe(1);
	expect(prompt).toContain(`[user request R2 source: ${h("u2")}]`);
	expect(prompt).toContain(`[tool output source: ${h("r-run")}]`);
	expect(cut.text.startsWith(SUMMARY_V3_MARK)).toBe(true);
	const s = parseSummaryV3(cut.text)!;
	expect(shape(s.rows)).toEqual(["R1", "R2 ack"]);
	expect(texts(s.digest)).toEqual({ architecture: ["#1 src/core.ts runs the build."], decisions: ["#2 Build verified."], discarded: [], tests: ["#3 893 pass, 0 fail (bun test); no baseline failures"], open: [] });
	expect(s.intents[0].about).toBe(2);
	expect(s.evidence[0]).toContain("Selected evidence: 893 pass ⏎ 0 fail");
	expect(s.intents.map((i) => i.quote)).toEqual(["Verify the build"]);
	expect(cut.llmOk).toBe(true);
	ctx.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "timeout", content: [] });
	const failed = await buildCut(p, ctx);
	expect(failed.llmOk).toBe(false);
	expect(failed.text).toContain("possibly stale: timeout");
	expect(shape(parseSummaryV3(failed.text)!.rows)).toEqual(["R1", "R2"]);
	expect(failed.text).not.toContain("Selected evidence:");
	// no room left at all (the kept part alone fills it): the minimal summary still goes in, recorded as over the room, never failed
	const tight = await buildCut({ ...p, summaryRoomTokens: 0 }, ctx);
	expect(tight.reason).toBeUndefined();
	expect((tight.summaryDiagnostics as any).overRoom).toEqual({ requiredTokens: tight.summaryTokens, availableTokens: 0 });
	// the room steps all ran: the older request was digested, only the newest stays (its text is shorter than an excerpt)
	expect(shape(parseSummaryV3(tight.text)!.rows)).toEqual(["R1 digested", "R2"]);
});
