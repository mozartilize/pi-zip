import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import piZip from "../src/index.ts";
import { join } from "node:path";
import { buildSessionProjection } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { handleFor } from "../src/handle.ts";
import { Ledger } from "../src/ledger/projector.ts";
import { readSource } from "../src/ledger/source.ts";
import { Memory, recentContext } from "../src/memory.ts";
import { renderPacket, statusFor, validate } from "../src/retrieval/packet.ts";
import { answerInput, parseReply, recordedAt, requestText, RetrievalConversation, type NeedDecision } from "../src/retrieval/assistant.ts";
import { conclusionsOf, DEFAULT_LIMITS, type Evidence, queryOf, retrieve, scopeOf } from "../src/retrieval/search.ts";
import { Zip } from "../src/run.ts";
import { A, fakeCtx, fakePi, flat, startZip, U } from "./helpers.ts";
import { asst, call, E, fakeSession, fixtureEntries, result, user, type Any } from "./memory-fixture.ts";

const open: Ledger[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** The fixture plus a sibling-branch conclusion that matches the same words as a3 (under u2, not on the active branch). */
function withSibling() {
	return [...fixtureEntries(), asst("a6", "u2", [{ type: "text", text: "The sockets were fixed differently on the sibling branch." }])];
}
/** What the fixture's compaction (firstKept u3) takes out of the view: u1's whole turn, ending in its conclusion a3. */
const COMPACTED = ["u1", "a1", "r1", "r2", "a2", "r3", "a3"];
function indexed(entries: Any[], o: Parameters<typeof fakeSession>[1] = {}) {
	const s = fakeSession(entries, o);
	const l = Ledger.open(readSource(s.ctx)!, join(s.dir, "x.sqlite"));
	open.push(l);
	l.reconcile(readSource(s.ctx)!);
	return { s, l };
}
const q = (prompt: string) => queryOf(prompt);

describe("retrieve", () => {
	test("a turn's conclusion is its last assistant text; text followed by more work in that turn is not one", () => {
		const c = conclusionsOf(withSibling().filter((e) => ["u1", "a1", "r1", "r2", "a2", "r3", "a3", "u3", "a4", "r4"].includes(e.id)));
		expect([...c.entries()]).toEqual([["a3", "fix the retry timeout in src/retry.ts"]]); // a1's "Running the tests first" is not; u3's turn has none
		const tail = conclusionsOf([user("u1", null, "q1"), asst("a1", "u1", [{ type: "text", text: "answer one" }]), user("u2", "a1", "q2"), asst("a2", "u2", [{ type: "text", text: "answer two" }])]);
		expect([...tail.entries()]).toEqual([["a1", "q1"], ["a2", "q2"]]); // the branch's last turn ends at the branch end
	});

	test("unfinished work cannot be a conclusion, even after an earlier completed answer in the same turn", () => {
		for (const reason of ["toolUse", "aborted", "error", "length", undefined]) {
			const early = asst("early", "u", [{ type: "text", text: "Preliminary answer" }]);
			const unfinished = asst("pending", "early", [{ type: "text", text: "I will check retries" }]);
			unfinished.message.stopReason = reason;
			const entries = [user("u", null, "diagnose retry"), early, unfinished];
			expect([...conclusionsOf(entries)]).toEqual([]);
			expect([...conclusionsOf([...entries, user("next", "pending", "another task")])]).toEqual([]);
			const final = asst("done", "pending", [{ type: "text", text: "Retries fail because the socket is closed" }]);
			expect([...conclusionsOf([...entries, final])]).toEqual([["done", "diagnose retry"]]);
		}
		const preamble = asst("work", "u", [{ type: "text", text: "Running tests" }, call("c", "bash", { command: "false" })]);
		preamble.message.stopReason = "stop"; // even a misleading terminal reason cannot turn a tool call into an answer
		expect([...conclusionsOf([user("u", null, "diagnose retry"), preamble, result("r", "work", "c", "bash", "FAIL"), user("next", "r", "next")])]).toEqual([]);
	});

	test("recent context uses projected text only, never compacted history or a raw replacement", () => {
		const s = fakeSession([
			user("u", null, "hidden request sentinel"),
			asst("a", "u", [{ type: "text", text: "hidden answer sentinel" }]),
			E("cm", "a", { type: "compaction", firstKeptEntryId: "cm", summary: "summary", tokensBefore: 100 }),
		]);
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		expect(recentContext(s.ctx)).toBe("");
		s.state.entries.push(user("v", "cm", "visible request"), asst("b", "v", [{ type: "text", text: "raw answer sentinel" }]),
			E("edit", "b", { type: "context_edit", targetId: "b", replacement: { content: [{ type: "text", text: "projected answer" }] } }));
		s.state.leaf = "edit";
		expect(recentContext(s.ctx)).toBe("previous user request: visible request\nlatest assistant reply: projected answer");
		s.sm.buildSessionProjection = () => { throw new Error("no view"); };
		expect(recentContext(s.ctx)).toBe(""); // no fallback to invisible raw text
	});

	test("long conclusions retain the winning FTS passage rather than an earlier common query word", () => {
		const cause = "The mutex approach failed because lock ownership outlived the socket.";
		const entries = [user("u", null, "explain the experiment"),
			asst("a", "u", [{ type: "thinking", thinking: "private hypothesis" },
				{ type: "text", text: "Why this project exists: " + "unrelated background detail ".repeat(200) + cause }]),
			E("cm", "a", { type: "compaction", firstKeptEntryId: "cm", summary: "summary", tokensBefore: 2000 })];
		const { s, l } = indexed(entries);
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const [e] = retrieve(l.db, q("why mutex failed"), scopeOf(s.ctx)).evidence;
		expect(e.entryId).toBe("a");
		expect(e.excerpt).toContain(cause);
		expect(e.excerpt).not.toContain("Why this project exists");
		expect(e.excerpt).not.toContain("private hypothesis");
		const [named] = retrieve(l.db, q(handleFor("a")), scopeOf(s.ctx)).evidence;
		expect(named.kind).toBe("assistant");
		expect(named.excerpt).toContain("Why this project exists");
		expect(named.excerpt).not.toContain("private hypothesis");
	});

	test("only hidden conclusions on the active branch are candidates: visible, sibling-branch and mid-turn text are not", () => {
		const { s, l } = indexed(withSibling(), { leaf: "om", hidden: [...COMPACTED, "a6"] });
		const ids = (prompt: string) => retrieve(l.db, q(prompt), scopeOf(s.ctx)).evidence.map((e) => e.entryId);
		expect(ids("how were the sockets fixed")).toEqual(["a3"]); // a6 matches too, on the sibling branch
		expect(ids("running first")).toEqual([]); // a1: hidden, matching, but not a conclusion
		expect(ids("PASS 12 tests")).toEqual([]); // a hidden tool output is not searched
		s.state.leaf = "a6"; // /tree to the sibling: no compaction on that branch, so nothing there is hidden
		expect(ids("how were the sockets fixed")).toEqual([]);
		const shown = indexed(withSibling(), { leaf: "om" }); // nothing hidden: a3 is in the view
		expect(retrieve(shown.l.db, q("how were the sockets fixed"), scopeOf(shown.s.ctx)).evidence).toEqual([]);
	});

	test("a conclusion is quoted from its own text and titled by the request it answered", () => {
		const { s, l } = indexed(fixtureEntries(), { leaf: "om", hidden: COMPACTED });
		const [a3] = retrieve(l.db, q("sockets"), scopeOf(s.ctx)).evidence;
		expect(a3).toMatchObject({ kind: "assistant", hidden: "compacted", handle: handleFor("a3"), folded: false, excerpt: "Fixed by closing sockets in the pool.",
			title: 'answer to: "fix the retry timeout in src/retry.ts"' });
		expect(answerInput("x", "", [a3])).toContain(`E1 conclusion — answer to: "fix the retry timeout in src/retry.ts"`);
	});

	test("the hidden boundary follows Pi's own projection; with no projection nothing is hidden", () => {
		const s = fakeSession(fixtureEntries(), { leaf: "om" });
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const real = scopeOf(s.ctx);
		expect([...real.hidden.keys()].sort()).toEqual(["a1", "a2", "a3", "r1", "r2", "r3", "u1"]);
		expect(real.visible.has("u3")).toBe(true); // firstKept is retained
		const l = Ledger.open(readSource(s.ctx)!, join(s.dir, "x.sqlite"));
		open.push(l);
		l.reconcile(readSource(s.ctx)!);
		expect(retrieve(l.db, q("sockets fixed"), real).evidence.map((e) => e.entryId)).toEqual(["a3"]);
		s.sm.buildSessionProjection = () => { throw new Error("projection unavailable"); };
		expect(retrieve(l.db, q("sockets fixed"), scopeOf(s.ctx)).evidence).toEqual([]);
	});

	test("a tool result named by handle is titled by its own call (nearest issuer of a reused id), only when that call is hidden too", () => {
		const both = indexed(fixtureEntries(), { leaf: "om", hidden: ["a1", "r1", "a2", "r3"] });
		const ev1 = retrieve(both.l.db, q(`${handleFor("r3")} and ${handleFor("r1")}`), scopeOf(both.s.ctx)).evidence;
		expect(ev1.find((e) => e.entryId === "r3")!.title).toBe("bash: npm test -- retry"); // a2's c1, not a1's "cd /w && npm test"
		expect(ev1.find((e) => e.entryId === "r1")!.title).toBe("read: src/retry.ts");
		const callShown = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"] }); // a2 still visible
		const r3 = retrieve(callShown.l.db, q(handleFor("r3")), scopeOf(callShown.s.ctx)).evidence.find((e) => e.entryId === "r3")!;
		expect(r3.title).toBe("tool result bash");
		expect(answerInput("x", "", [r3])).not.toContain("npm test -- retry");
	});

	test("a long prompt is searched by its first 32 and last 96 distinct words, in prompt order, none twice", () => {
		const w = (i: number) => `w${i}`;
		const fits = Array.from({ length: 128 }, (_, i) => w(i)).join(" ");
		expect(queryOf(fits).tokens).toHaveLength(128); // at the cap: every word
		// 200 distinct words, then the head words repeated at the very end: the repeats are not tail words
		const long = [...Array.from({ length: 200 }, (_, i) => w(i)), w(0), w(1)].join(" ");
		const expected = [...Array.from({ length: 32 }, (_, i) => w(i)), ...Array.from({ length: 96 }, (_, i) => w(104 + i))];
		expect(queryOf(long).tokens).toEqual(expected);
		// a word that occurs early and again near the end counts once, at its tail position
		const again = [...Array.from({ length: 200 }, (_, i) => w(i)), w(50)].join(" ");
		const t = queryOf(again).tokens;
		expect(t.filter((x) => x === "w50")).toHaveLength(1);
		expect(t.slice(-1)).toEqual(["w50"]);
		expect(t).not.toContain("w104"); // w50 took the place of the oldest tail word (w104..w199 without it)
		expect(t).toContain("w105");
	});

	test("the model reads the user's request: skill files removed, a long one kept by its start and its end", () => {
		const request = requestText(`<skill name="t">${"s".repeat(9000)}</skill>\n\ncontinue #3 #4`);
		expect(request).toBe("continue #3 #4");
		const long = "A".repeat(1000) + "M".repeat(500) + "Z".repeat(3000);
		expect(requestText(long)).toBe(`${"A".repeat(1000)}\n[… 500 chars omitted …]\n${"Z".repeat(3000)}`);
		expect(requestText("x".repeat(4000))).toBe("x".repeat(4000)); // at the limit: unchanged
		expect(answerInput(`<skill>${"s".repeat(3000)}</skill> why did it fail`, "", [ev({})])).toContain("why did it fail");
	});

	test("a loaded skill's text is not part of the query; the user's own words are", () => {
		expect(queryOf('<skill name="t" location="/x">\nalpha beta gamma\n</skill>\n\ncheck log').tokens).toEqual(["check", "log"]);
		expect(queryOf("<skill>a</skill> one <skill>b</skill> two").tokens).toEqual(["one", "two"]); // two blocks, text between kept
	});

	test("visible conclusions that outrank a hidden one cannot fill the FTS rows before it is considered", () => {
		const entries: Any[] = [user("u1", null, "start"), asst("a1", "u1", [{ type: "text", text: "retry happened once" }])];
		let parent = "a1";
		for (let i = 2; i <= 6; i++) { // five visible conclusions that rank higher for "retry"
			entries.push(user(`u${i}`, parent, "again"), asst(`a${i}`, `u${i}`, [{ type: "text", text: "retry retry retry retry" }]));
			parent = `a${i}`;
		}
		entries.push(E("cm", parent, { type: "compaction", summary: "s", firstKeptEntryId: "u2", tokensBefore: 1 })); // positive mark of hiding
		const { s: sess, l } = indexed(entries, { hidden: ["u1", "a1"] });
		const ev = retrieve(l.db, q("retry"), scopeOf(sess.ctx), { ...DEFAULT_LIMITS, ftsRows: 2 }).evidence;
		expect(ev.map((e) => e.entryId)).toEqual(["a1"]);
	});

	test("a compaction that keeps nothing before it hides everything before it, as Pi's own projection does", () => {
		for (const firstKept of ["cm", null, "not-on-branch"]) {
			const entries = fixtureEntries().map((e) => (e.id === "cm" ? { ...e, firstKeptEntryId: firstKept } : e));
			const s = fakeSession(entries, { leaf: "om" });
			s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
			const hidden = [...scopeOf(s.ctx).hidden.keys()].sort();
			expect(hidden).toEqual(["a1", "a2", "a3", "a4", "r1", "r2", "r3", "r4", "u1", "u3"]); // u2 is the sibling branch
		}
	});

	test("handles in the prompt name their outputs exactly, each kept, also two results of one step; a visible one is not repeated", () => {
		const { s: sess, l } = indexed(fixtureEntries(), { leaf: "om", folded: ["r1", "r2"] });
		const [h1, h2, h3] = [handleFor("r1"), handleFor("r2"), handleFor("r3")]; // r1, r2: both results of a1's calls
		const ev = retrieve(l.db, q(`compare ${h2} with ${h1} and ${h3}`), scopeOf(sess.ctx)).evidence;
		expect(ev.map((e) => [e.entryId, e.exact, e.folded])).toEqual([["r2", true, true], ["r1", true, true]]); // r3 is visible
	});


});

const ev = (over: Partial<Evidence>): Evidence => ({ at: 0, outcome: "", ref: "E1", handle: "h000000001", entryId: "x", hidden: "compacted", kind: "tool_result", tool: "bash", title: "tool result bash npm test", excerpt: "", isError: false, folded: false, matched: 2, exact: false, context: [], seq: 0, ...over });

describe("packet validation", () => {
	test("each item and each cited handle says when it was recorded, against the request time", () => {
		const now = Date.UTC(2026, 9, 25, 21, 33);
		const input = answerInput("check the new log", "", [
			ev({ ref: "E1", at: Date.UTC(2026, 9, 25, 20, 55) }),
			ev({ ref: "E2", handle: "bbbbbbbbbb", at: Date.UTC(2026, 9, 24, 21, 33) }),
			ev({ ref: "E3", handle: "cccccccccc", at: 0 }),
		], now);
		expect(input).toContain("NEW USER REQUEST (2026-10-25 21:33 UTC)");
		expect(input).toContain("E1 tool_result bash — tool result bash npm test (recorded 2026-10-25 20:55 UTC, 38 min before this request)");
		expect(input).toContain("(recorded 2026-10-24 21:33 UTC, 24 h before this request)");
		expect(input).toContain("E3 tool_result bash — tool result bash npm test (recorded at an unknown time)");
		expect(recordedAt(now + 60_000, now)).toContain("0 min before"); // clock skew never reads as negative
		const text = renderPacket({ requestId: "r", ledgerRevision: "v", findings: [{ summary: "s", sourceHandles: ["aaaaaaaaa1", "bbbbbbbbbb"], status: "historical" }], foldedCandidates: [] },
			new Map([["aaaaaaaaa1", "38 min ago"]]))!;
		expect(text).toContain("Evidence: aaaaaaaaa1 (38 min ago), bbbbbbbbbb [earlier conclusion]");
	});

	test("only listed needed items count: unlisted, need=N, reasonless, duplicate, unknown and mixed citations are rejected", () => {
		const evidence = Array.from({ length: 6 }, (_, i) => ev({ ref: `E${i + 1}`, handle: `aaaaaaaaa${i + 1}`, folded: true }));
		const decisions: NeedDecision[] = [];
		const drops = { unknownHandle: 0, empty: 0, cap: 0, notFolded: 0, notNeeded: 0 };
		const needed = [
			{ evidence: "E1", reason: "Current task needs the failure line." },
			{ evidence: "E3", reason: "  " },
			{ evidence: "E5", reason: "first" }, { evidence: "E5", reason: "again" },
			{ evidence: "E6", need: "N", reason: "listed out of habit" },
			{ evidence: "E99", reason: "never retrieved" },
		];
		const refs = [["E1"], ["E2"], ["E3"], ["E4"], ["E5"], ["E6"], ["E1", "E2"], ["E1", "E99"]];
		const reply = JSON.stringify({ needed, findings: refs.map((ids) => ({ summary: ids.join(), evidence: ids })),
			folded: evidence.map((e) => ({ evidence: e.ref, reason: "detail" })) });
		const packet = parseReply(reply, evidence, "r", "v", drops, decisions)!;
		expect(packet.findings.map((f) => f.summary)).toEqual(["E1"]);
		expect(packet.foldedCandidates.map((f) => f.handle)).toEqual(["aaaaaaaaa1"]);
		expect(decisions).toEqual([
			{ ref: "E1", need: "Y", reason: "Current task needs the failure line." },
			{ ref: "E2", need: "N", reason: "not listed" },
			{ ref: "E3", need: "U", reason: "listed without a reason" },
			{ ref: "E4", need: "N", reason: "not listed" },
			{ ref: "E5", need: "U", reason: "listed more than once" },
			{ ref: "E6", need: "N", reason: "listed as need=N" },
		]);
		expect(drops.unknownHandle).toBe(1); // E99 in [E1, E99]
		expect(drops.notNeeded).toBe(11); // findings E2..E6 and E2 of [E1, E2]: 6; folded E2..E6: 5
	});

	test("the old per-item format grants nothing: an items list is not a needed list", () => {
		const reply = JSON.stringify({ items: [{ evidence: "E1", need: "Y", reason: "old format" }], findings: [{ summary: "x", evidence: ["E1"] }] });
		const decisions: NeedDecision[] = [];
		expect(parseReply(reply, [ev({})], "r", "v", undefined, decisions)!.findings).toEqual([]);
		expect(decisions).toEqual([{ ref: "E1", need: "N", reason: "not listed" }]);
	});

	test("an item cut from the model input cannot receive need=Y by guessing its id", async () => {
		const { reg, sent } = registry([JSON.stringify({
			needed: [{ evidence: "E2", reason: "claimed dependency" }],
			findings: [{ summary: "invented from unsent item", evidence: ["E2"] }],
		})]);
		const conv = new RetrievalConversation({ modelRegistry: reg, model: { provider: "p" } });
		const evidence = [ev({ excerpt: "small" }), ev({ ref: "E2", handle: "bbbbbbbbbb", excerpt: "x".repeat(16_000) })];
		const packet = await conv.answer("request", "", evidence, "r", "v");
		expect(sent[0].messages[0].content[0].text).not.toContain("E2 tool_result");
		expect(conv.stats.evidenceItems).toBe(1);
		expect(packet!.findings).toEqual([]);
		expect(conv.decisions.map((d) => d.ref)).toEqual(["E1"]);
	});

	test("trace captures truncated text before the length error, and can be disabled", async () => {
		const prev = process.env.PI_ZIP_MEMORY_TRACE;
		try {
			for (const enabled of [true, false]) {
				if (enabled) delete process.env.PI_ZIP_MEMORY_TRACE;
				else process.env.PI_ZIP_MEMORY_TRACE = "0";
				const { reg } = registry([]);
				reg.complete = async () => ({ role: "assistant", stopReason: "length", content: [
					{ type: "text", text: "partial".repeat(1000) }, { type: "thinking", thinking: "reasoning" },
				], usage: { cost: { total: 0.001 } } } as Any);
				const conv = new RetrievalConversation({ modelRegistry: reg, model: { provider: "p" } });
				expect(await conv.answer("request", "", [ev({})], "r", "v")).toBeNull();
				expect(conv.calls[0]).toMatchObject({ stopReason: "length", replyChars: 7000, thinkingChars: 9 });
				expect(conv.calls[0].reply).toBe(enabled ? "partial".repeat(1000).slice(0, 4000) : undefined);
			}
		} finally {
			if (prev === undefined) delete process.env.PI_ZIP_MEMORY_TRACE;
			else process.env.PI_ZIP_MEMORY_TRACE = prev;
		}
	});

	const okResult = ev({ ref: "E1", handle: "aaaaaaaaa1", folded: true });
	const errResult = ev({ ref: "E2", handle: "aaaaaaaaa2", isError: true });
	const thought = ev({ ref: "E3", handle: "aaaaaaaaa3", kind: "thinking", tool: null });
	const prose = ev({ ref: "E4", handle: "aaaaaaaaa4", kind: "assistant", tool: null, folded: true });
	const all = [okResult, errResult, thought, prose];

	test("statuses follow the citations; invented handles and non-folded or non-result folded items are dropped", () => {
		const p = validate({
			requestId: "r", ledgerRevision: "v",
			findings: [
				{ summary: "passes", sourceHandles: ["aaaaaaaaa1", "zzzzzzzzzz"], status: "verified" },
				{ summary: "failed then", sourceHandles: ["aaaaaaaaa2"], status: "verified" },
				{ summary: "maybe sockets", sourceHandles: ["aaaaaaaaa3"], status: "verified" },
				{ summary: "made up", sourceHandles: ["zzzzzzzzzz"], status: "historical" },
				{ summary: "said so", sourceHandles: ["aaaaaaaaa4"], status: "verified" },
				{ summary: "output, model unsure", sourceHandles: ["aaaaaaaaa1"], status: "uncertain" },
			],
			foldedCandidates: [
				{ handle: "aaaaaaaaa1", tool: "", reason: "exact log" },
				{ handle: "aaaaaaaaa1", tool: "", reason: "duplicate" },
				{ handle: "aaaaaaaaa2", tool: "", reason: "not folded" },
				{ handle: "aaaaaaaaa4", tool: "", reason: "folded but not a tool result" },
			],
		}, all);
		expect(statusFor("historical", [okResult])).toBe("verified"); // the cited kind decides, not the model's word
		expect(p.findings).toEqual([
			{ summary: "passes", sourceHandles: ["aaaaaaaaa1"], status: "verified" },
			{ summary: "failed then", sourceHandles: ["aaaaaaaaa2"], status: "verified" }, // the output showed the error
			{ summary: "maybe sockets", sourceHandles: ["aaaaaaaaa3"], status: "uncertain" }, // reasoning alone never does
			{ summary: "said so", sourceHandles: ["aaaaaaaaa4"], status: "historical" }, // prose: the model cannot raise it
			{ summary: "output, model unsure", sourceHandles: ["aaaaaaaaa1"], status: "uncertain" }, // lowering is allowed
		]);
		expect(p.foldedCandidates).toEqual([{ handle: "aaaaaaaaa1", tool: "bash npm test", reason: "exact log" }]);
	});

});

/** A model registry that answers each call from `replies` in order and records every context it was sent. */
function registry(replies: Array<string | Error>, modelOver: Partial<Any> = {}) {
	const sent: Any[] = [], options: Any[] = [];
	const model = { provider: "p", id: "cheap", contextWindow: 100_000, cost: { input: 0.1 }, maxTokens: 8000, ...modelOver };
	return {
		sent,
		options,
		reg: {
			getAvailable: async () => [model],
			complete: async (_m: Any, context: Any, opts: Any) => {
				sent.push(structuredClone(context));
				if (opts) options.push({ ...opts });
				const r = replies[sent.length - 1];
				if (r instanceof Error) throw r;
				return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: r ?? "{}" }], usage: { cost: { total: 0.001 } } };
			},
		},
	};
}

// The shared model setting must not leak in from the machine running the tests.
const AMBIENT_MODEL = process.env.PI_ZIP_JUDGE_MODEL;
beforeEach(() => { delete process.env.PI_ZIP_JUDGE_MODEL; });
afterAll(() => { if (AMBIENT_MODEL !== undefined) process.env.PI_ZIP_JUDGE_MODEL = AMBIENT_MODEL; });

describe("Memory at a new user prompt", () => {
	const PROMPT = "how were the sockets fixed?";
	// The one call's reply: a finding from the earlier conclusion a3.
	const ANSWER = '{"needed":[{"evidence":"E1","reason":"The request asks how the sockets were fixed."}],"findings":[{"summary":"Earlier the retry timeout was fixed by closing sockets in the pool.","evidence":["E1"],"status":"historical"}],"folded":[]}';

	async function run(replies: Array<string | Error>, e: Any = { messageType: "user", prompt: PROMPT }, o: Parameters<typeof fakeSession>[1] = { hidden: COMPACTED }, entries: Any[] = withSibling()) {
		const s = fakeSession(entries, { leaf: "om", ...o });
		const { sent, reg } = registry(replies);
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		await mem.beforeAgentStart(ctx, e);
		const note = mem.current(ctx);
		mem.shutdown();
		return { sent, note, logs, retrieval: logs.find((r) => r.type === "memory_retrieval"), ctx };
	}
	test("a tool result carries the outcome of its whole output, which the excerpt alone may not show", () => {
		const out = "PASS retry 1\n" + "pad\n".repeat(400) + "21 pass\n1 fail\nCommand exited with code 1";
		const entries = [user("u1", null, "go"), asst("a1", "u1", [call("c1", "bash", { command: "bun test" })]), result("r1", "a1", "c1", "bash", out, true)];
		const { s: sess, l } = indexed(entries, { folded: ["r1"] });
		const e = retrieve(l.db, q(`PASS retry ${handleFor("r1")}`), scopeOf(sess.ctx)).evidence[0];
		expect(e.excerpt).not.toContain("fail");
		expect(e.outcome).toBe("exit 1, 21 passed, 1 failed");
		expect(answerInput("x", "", [e])).toContain("[whole output: exit 1, 21 passed, 1 failed]");
	});

	test("a prepared note that no request carried is logged as dropped, with no usage record", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { reg } = registry([ANSWER]);
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
		expect(mem.current(ctx)).not.toBeNull();
		mem.agentEnd(ctx); // no injected() call
		const id = logs.find((r) => r.type === "memory_retrieval").requestId;
		expect(logs.filter((r) => r.type === "memory_dropped")).toEqual([expect.objectContaining({ requestId: id })]);
		expect(logs.some((r) => r.type === "memory_usage")).toBe(false);
		mem.shutdown();
	});

	test("the trace keeps the note text, and agent_end records whether the run used the cited handles", async () => {
		for (const [used, recall, name] of [[true, true, true], [false, false, false], [false, false, true]] as const) {
			const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
			const { reg } = registry([ANSWER]);
			const ctx = { ...s.ctx, modelRegistry: reg };
			const logs: Any[] = [];
			const mem = new Memory((r) => logs.push(r));
			mem.sessionStart(ctx);
			await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
			const note = mem.current(ctx)!;
			const retrieval = logs.find((r) => r.type === "memory_retrieval");
			expect(retrieval.note).toBe(note.text);
			const h = handleFor("a3");
			mem.injected(note.text.length, 1);
			// the run: the prompt, then a recall of the cited handle (or of something else), then a final answer naming it (or not)
			const msg = (id: string, parentId: string, message: Any) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message });
			s.state.entries.push(
				msg("p1", "om", { role: "user", content: [{ type: "text", text: PROMPT }] }),
				msg("p2", "p1", { role: "assistant", content: [{ type: "toolCall", id: "z", name: "zip_recall", arguments: { handle: recall ? h : "zzzzzzzzzz" } }] }),
				msg("p3", "p2", { role: "assistant", content: [{ type: "text", text: name ? `${h} is wrong` : "done" }] }),
			);
			s.state.leaf = "p3";
			mem.agentEnd(ctx);
			const usage = logs.find((r) => r.type === "memory_usage");
			expect(usage).toMatchObject({ requestId: retrieval.requestId, recallCalls: 1, assistantMessages: 2, used });
			expect(usage.recalled).toEqual(recall ? [h] : []);
			expect(usage.mentioned).toEqual(name ? [h] : []); // named only: recorded, but not "used"
			mem.shutdown();
		}
		// a note that never went into a request gets no usage record
		const { logs } = await run([ANSWER]);
		expect(logs.some((r) => r.type === "memory_usage")).toBe(false);
	});

	test("rejected items stay in the trace but never enter the note", async () => {
		const reply = JSON.stringify({
			needed: [],
			findings: [{ summary: "must not inject", evidence: ["E1"] }],
			folded: [{ evidence: "E1", reason: "must not inject" }],
		});
		const { sent, note, retrieval } = await run([reply]);
		expect(sent).toHaveLength(1);
		expect(note).toBeNull();
		expect(retrieval.skip).toBe("nothing relevant");
		expect(retrieval.evidence[0]).toMatchObject({ hidden: "compacted", cited: false });
		expect(retrieval.decisions[0].need).toBe("N");
		expect(retrieval.drops.notNeeded).toBe(2);
	});

	test("reasoning level: low by default on reasoning models, explicit level wins, non-reasoning models send none", async () => {
		const cases: Array<[Partial<Any>, string | undefined, string | undefined]> = [
			[{ reasoning: true }, undefined, "low"],
			[{ reasoning: true }, "p/cheap:high", "high"],
			[{ reasoning: false }, undefined, undefined],
			[{}, undefined, undefined], // no capability metadata: provider default
		];
		for (const [over, setting, expected] of cases) {
			if (setting) process.env.PI_ZIP_JUDGE_MODEL = setting; else delete process.env.PI_ZIP_JUDGE_MODEL;
			const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
			const { options, reg } = registry([ANSWER], over);
			const streamed: Any[] = [];
			(reg as Any).streamSimple = (_m: Any, _c: Any, opts: Any) => {
				streamed.push({ ...opts });
				return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }], usage: {} }) };
			};
			const ctx = { ...s.ctx, modelRegistry: reg };
			const mem = new Memory(() => {});
			mem.sessionStart(ctx);
			await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
			const sentOpts = [...streamed, ...options];
			expect(sentOpts).toHaveLength(1);
			expect(sentOpts[0].reasoning).toBe(expected);
			mem.shutdown();
			rmSync(s.dir, { recursive: true, force: true });
		}
		delete process.env.PI_ZIP_JUDGE_MODEL;
	});

	test("retrieval caps maxTokens at 4000 to leave headroom for reasoning models and complete JSON", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { options, reg } = registry([ANSWER], { maxTokens: 16_384 });
		const mem = new Memory(() => {});
		mem.sessionStart({ ...s.ctx, modelRegistry: reg });
		await mem.beforeAgentStart({ ...s.ctx, modelRegistry: reg }, { messageType: "user", prompt: PROMPT });
		expect(options[0]).toMatchObject({ maxTokens: 4000 });
		mem.shutdown();
		rmSync(s.dir, { recursive: true, force: true });
	});

	test("zip off gates calls, cancels in-flight retrieval, drops ready notes, and leaves indexing active", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { reg } = registry([]), { pi, handlers } = fakePi();
		const ctx = { ...s.ctx, modelRegistry: reg, getSystemPrompt: () => "", ui: { notify: () => {} }, mode: "tui" };
		const previousWait = process.env.PI_ZIP_RETRIEVAL_WAIT_MS;
		process.env.PI_ZIP_RETRIEVAL_WAIT_MS = "1";
		let mem!: Memory, calls = 0, signal!: AbortSignal, finish!: (res: Any) => void, logged!: () => void;
		const completed = new Promise<void>((resolve) => { logged = resolve; });
		const logs: Any[] = [];
		const originalStart = Memory.prototype.sessionStart;
		const start = spyOn(Memory.prototype, "sessionStart").mockImplementation(function (this: Memory, c: Any) { mem = this; originalStart.call(this, c); });
		const ledger = spyOn(Zip.prototype, "ledger").mockImplementation((r) => { logs.push(r); if (r.type === "memory_retrieval" && r.deferred) logged(); });
		const reply = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }] };
		(reg as Any).complete = (_m: Any, _c: Any, options: Any) => {
			calls++; signal = options.signal;
			return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(reply);
		};
		try {
			piZip(pi);
			await handlers.get("session_start")!({}, ctx);
			await mem.ready;
			const cmd = (s: string) => handlers.get("cmd:zip")!.handler(s, ctx);
			const prompt = () => handlers.get("before_agent_start")!({ messageType: "user", prompt: PROMPT }, ctx);
			await cmd("off"); await prompt();
			expect(calls).toBe(0);
			await cmd("on"); await prompt();
			expect(calls).toBe(1);
			expect(signal.aborted).toBe(false);
			await cmd("off");
			expect(signal.aborted).toBe(true);
			await cmd("on"); // enabling again must not resurrect the cancelled result
			finish(reply); await completed;
			expect(mem.current(ctx)).toBeNull();
			expect(logs.find((r) => r.type === "memory_retrieval").skip).toBe("cancelled");
			await prompt();
			expect(calls).toBe(2);
			expect(mem.current(ctx)).not.toBeNull();
			await cmd("off");
			expect(mem.current(ctx)).toBeNull();
			s.state.entries.push(user("new", "om", "index while disabled")); s.state.leaf = "new";
			await handlers.get("agent_end")!({}, ctx);
			expect(mem.statusLine(ctx)).toContain(`indexed_entries=${s.state.entries.length}`);
			await prompt(); expect(calls).toBe(2);
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			start.mockRestore(); ledger.mockRestore(); rmSync(s.dir, { recursive: true, force: true });
			if (previousWait === undefined) delete process.env.PI_ZIP_RETRIEVAL_WAIT_MS;
			else process.env.PI_ZIP_RETRIEVAL_WAIT_MS = previousWait;
		}
	});

	test("slow retrieval releases the foreground, but only the current live run can receive its result", async () => {
		const prev = process.env.PI_ZIP_RETRIEVAL_WAIT_MS;
		process.env.PI_ZIP_RETRIEVAL_WAIT_MS = "5";
		try {
			for (const action of ["keep", "end", "tree", "compact", "session", "shutdown", "new-prompt"]) {
				const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
				const { reg } = registry([]);
				let finish!: (r: Any) => void;
				let signal: AbortSignal | undefined;
				(reg as Any).complete = (_m: Any, _c: Any, options: Any) => {
					signal = options.signal;
					return new Promise((resolve) => { finish = resolve; }); // deliberately ignores abort
				};
				const ctx = { ...s.ctx, modelRegistry: reg };
				const logs: Any[] = [];
				let logged!: () => void;
				const completed = new Promise<void>((resolve) => { logged = resolve; });
				const mem = new Memory((r) => { logs.push(r); if (r.type === "memory_retrieval" && r.deferred) logged(); });
				try {
					mem.sessionStart(ctx);
					await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
					expect(logs.filter((r) => r.type === "memory_deferred")).toHaveLength(1);
					expect(mem.current(ctx)).toBeNull();
					expect(signal!.aborted).toBe(false); // 5 ms wait is not the provider timeout
					if (action === "end") mem.agentEnd(ctx);
					if (action === "tree") mem.catchUp(ctx, "session_tree");
					if (action === "compact") mem.catchUp(ctx, "session_compact");
					if (action === "session") mem.sessionStart(ctx);
					if (action === "shutdown") mem.shutdown();
					if (action === "new-prompt") await mem.beforeAgentStart(ctx, { messageType: "user", prompt: "zzzqqq wwwyyy" });
					finish({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }] });
					await completed;
					if (action === "keep") expect(mem.current(ctx)).toMatchObject({ deferred: true });
					else {
						expect(signal!.aborted).toBe(true);
						expect(mem.current(ctx)).toBeNull();
						expect(logs.find((r) => r.type === "memory_retrieval" && r.deferred).skip).toBe("cancelled");
					}
				} finally { mem.shutdown(); }
			}
		} finally {
			if (prev === undefined) delete process.env.PI_ZIP_RETRIEVAL_WAIT_MS;
			else process.env.PI_ZIP_RETRIEVAL_WAIT_MS = prev;
		}
	});

	test("nothing is injected while the model still sees every output: no model call at all", async () => {
		// no fold and no compaction on the branch: the model still sees everything it indexed
		const clean = await run([ANSWER], { messageType: "user", prompt: PROMPT }, {}, fixtureEntries().slice(0, 3));
		expect([clean.sent.length, clean.note]).toEqual([0, null]);
		expect(clean.retrieval.skip).toBe("nothing hidden yet");
		// a compaction also hides what the model used to see: the gate opens on it alone, without any folded output
		const compacted = await run([ANSWER]);
		expect(compacted.sent.length).toBe(1);
		expect(compacted.retrieval.skip).not.toBe("nothing hidden yet");
	});

	test("retrieval runs on the judge's model setting; a name that is not available runs nothing", async () => {
		process.env.PI_ZIP_JUDGE_MODEL = "p/cheap";
		const chosen = await run([ANSWER]);
		expect(chosen.sent.length).toBe(1);
		process.env.PI_ZIP_JUDGE_MODEL = "other/model";
		const missing = await run([ANSWER]);
		expect(missing.sent.length).toBe(0);
		delete process.env.PI_ZIP_JUDGE_MODEL;
	});

	test("one call per prompt: the prompt's own words are the query, and a prompt that finds nothing costs none", async () => {
		const found = await run([ANSWER]);
		expect(found.sent.length).toBe(1); // no routing call in front of it
		expect(found.retrieval.terms).toContain("sockets");
		const empty = await run([ANSWER], { messageType: "user", prompt: "zzzqqq wwwyyy" });
		expect([empty.sent.length, empty.note]).toEqual([0, null]);
		expect(empty.retrieval.skip).toBe("no candidates");
	});


	test("history: search then one call; the note cites the hidden conclusion's real handle", async () => {
		const { sent, note, retrieval } = await run([ANSWER]);
		const input = sent[0].messages[0].content[0].text;
		expect(input).toContain(`E1 conclusion — answer to: "fix the retry timeout in src/retry.ts"`);
		expect(input).toContain(PROMPT);
		expect(input).not.toContain("sibling branch");
		expect(note!.text).toMatch(new RegExp(`Evidence: ${handleFor("a3")} \\([0-9.]+ (min|h|d) ago\\) \\[earlier conclusion\\]`));
		expect(note!.text).not.toContain(handleFor("a6"));
		expect(retrieval).toMatchObject({ findings: 1, folded: 0, stage: "prepared", deferred: false });
		expect(retrieval.latency.answer).toBeGreaterThanOrEqual(0);
		expect(retrieval.calls.map((c: Any) => c.step)).toEqual(["answer"]);
		expect(retrieval.evidence.find((x: Any) => x.cited)).toMatchObject({ kind: "assistant", hidden: "compacted", cited: true });
		expect(retrieval.drops).toEqual({ unknownHandle: 0, empty: 0, cap: 0, notFolded: 0, notNeeded: 0 });
		expect(retrieval.decisions).toEqual([{ ref: "E1", need: "Y", reason: "The request asks how the sockets were fixed." }]);
	});
});

describe("injection into the run's requests", () => {
	function zipWith(note: { prompt: string; text: string } | null, contextWindow = 1_000_000) {
		const prompt = "why did the mutex attempt fail?";
		const entries = [U("u1", "earlier"), A("a1"), U("u2", prompt)];
		const { pi } = fakePi();
		const { ctx } = fakeCtx(entries, { branch: entries.map((e) => e.sourceEntry) });
		ctx.model = { ...ctx.model, contextWindow };
		const zip = new Zip(pi);
		const seen = { injected: 0, reinjected: 0 };
		zip.memory = { current: () => note, injected: () => { seen.injected++; }, reinjected: () => { seen.reinjected++; }, cancelRetrieval: () => { note = null; } };
		return { zip, ctx, entries, prompt, seen: () => seen, setNote: (next: typeof note) => { note = next; } };
	}

	test("a late note first appears at the next model boundary without changing the already-sent request", async () => {
		const { zip, ctx, entries, prompt, setNote, seen } = zipWith(null);
		zip.sessionStart(ctx);
		await startZip(zip, ctx, { prompt });
		const first = flat(entries);
		const out1 = await zip.context({ messages: first }, ctx);
		const sent = structuredClone(out1?.messages ?? first);
		const note = { prompt, text: "late historical finding" };
		setNote(note);
		const later = [...first, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }];
		const out2 = await zip.context({ messages: later }, ctx);
		expect(sent).toEqual(first);
		expect(out2.messages[3].content[0].text).toBe(note.text);
		expect(out2.messages.slice(-2)).toEqual(later.slice(-2)); // tool call and result stay together
		const out3 = await zip.context({ messages: later }, ctx);
		expect(out3.messages).toEqual(out2.messages);
		expect(seen()).toEqual({ injected: 1, reinjected: 1 });
		zip.agentEnd();
		zip.shutdown();
	});

	test("the packet goes right after the run's prompt, at the same place in every request of the run", async () => {
		const note = { prompt: "why did the mutex attempt fail?", text: "[pi-zip: relevant historical findings]\n1. x" };
		const { zip, ctx, entries, prompt, seen } = zipWith(note);
		zip.sessionStart(ctx);
		await startZip(zip, ctx, { prompt });
		const first = flat(entries);
		const out1 = await zip.context({ messages: first }, ctx);
		expect(out1.messages.map((m: Any) => m.role)).toEqual(["user", "assistant", "user", "user"]);
		expect(out1.messages[3].content[0].text).toBe(note.text);
		const later = [...first, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] }, { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }];
		const out2 = await zip.context({ messages: later }, ctx);
		expect(out2.messages.slice(0, 4)).toEqual(out1.messages); // one cacheable prefix across the run
		expect(out2.messages.length).toBe(6);
		expect(seen()).toEqual({ injected: 1, reinjected: 1 }); // logged once per run, the repeat is only counted
		zip.agentEnd();
		zip.shutdown();
	});

});
