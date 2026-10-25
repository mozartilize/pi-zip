import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSessionProjection } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { handleFor } from "../src/handle.ts";
import { Ledger } from "../src/ledger/projector.ts";
import { readSource } from "../src/ledger/source.ts";
import { Memory } from "../src/memory.ts";
import { renderPacket, validate } from "../src/retrieval/packet.ts";
import { recordOffers, recordRests, resting } from "../src/retrieval/offers.ts";
import { resetDb } from "../src/ledger/db.ts";
import { answerInput, parseReply, recordedAt, RetrievalConversation, type NeedDecision } from "../src/retrieval/assistant.ts";
import { type Evidence, pickCandidates, queryOf, retrieve, scopeOf } from "../src/retrieval/search.ts";
import { Zip } from "../src/run.ts";
import { A, fakeCtx, fakePi, flat, startZip, U } from "./helpers.ts";
import { asst, call, fakeSession, fixtureEntries, result, type Any } from "./memory-fixture.ts";

const open: Ledger[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** The fixture plus a sibling-branch result that matches the same words as r4 (under u2, not on the active branch). */
function withSibling() {
	return [...fixtureEntries(), asst("a6", "u2", [call("c9", "bash", { command: "npm run bench" })]), result("r6", "a6", "c9", "bash", "mutex deadlock in queue.ts on the sibling branch")];
}
function indexed(entries: Any[], o: Parameters<typeof fakeSession>[1] = {}) {
	const s = fakeSession(entries, o);
	const l = Ledger.open(readSource(s.ctx)!, join(s.dir, "x.sqlite"));
	open.push(l);
	l.reconcile(readSource(s.ctx)!);
	return { s, l };
}
const q = (prompt: string) => queryOf(prompt);

describe("retrieve", () => {
	test("only the active branch is searched: the same words on a sibling branch never come back", () => {
		const { s, l } = indexed(withSibling(), { leaf: "om", folded: ["r4", "r6"] });
		const query = q("mutex deadlock");
		const onMain = retrieve(l.db, query, scopeOf(s.ctx)).evidence.map((e) => e.entryId);
		expect(onMain).toContain("r4");
		expect(onMain).not.toContain("r6");
		s.state.leaf = "r6"; // /tree to the sibling
		const onSibling = retrieve(l.db, query, scopeOf(s.ctx)).evidence.map((e) => e.entryId);
		expect(onSibling).toContain("r6");
		expect(onSibling).not.toContain("r4");
	});

	test("an output the request shows in full is not repeated; a folded one is a folded candidate with its exact excerpt", () => {
		const shown = indexed(fixtureEntries(), { leaf: "om" });
		expect(retrieve(shown.l.db, q("PASS 12 tests"), scopeOf(shown.s.ctx)).evidence.map((e) => e.entryId)).not.toContain("r3");
		const folded = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"] });
		const r3 = retrieve(folded.l.db, q("PASS 12 tests"), scopeOf(folded.s.ctx)).evidence.find((e) => e.entryId === "r3");
		expect(r3).toMatchObject({ kind: "tool_result", folded: true, handle: handleFor("r3"), excerpt: "PASS 12 tests", matched: 3 });
		expect(r3!.context).toEqual([]); // its calling assistant is still visible
		const err = indexed(fixtureEntries(), { leaf: "om", folded: ["r2"] });
		const r2 = retrieve(err.l.db, q("timeout 30000ms"), scopeOf(err.s.ctx)).evidence.find((e) => e.entryId === "r2");
		expect(r2).toMatchObject({ folded: true, isError: true });
	});

	test("only positively hidden sources seed retrieval; expansion cannot leak visible siblings or standalone thinking", () => {
		const { s, l } = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"], hidden: ["a1", "r1", "r4"] });
		const scope = scopeOf(s.ctx);
		const evidence = retrieve(l.db, q("retry PASS mutex sockets"), scope).evidence;
		expect(evidence.map((e) => e.entryId).sort()).toEqual(["r1", "r3"]);
		const old = evidence.find((e) => e.entryId === "r1")!;
		expect(old.hidden).toBe("compacted");
		expect(old.context.join("\n")).toContain("suspect connection cleanup leaks sockets");
		expect(evidence.find((e) => e.entryId === "r3")!.context).toEqual([]);
		const input = answerInput("retry", "", evidence);
		expect(input).not.toContain("timeout after 30000ms"); // visible sibling in r1's mixed segment
		expect(input).not.toContain("Fixed by closing sockets"); // visible assistant prose
		expect(input).not.toContain("mutex deadlock"); // absent after firstKept is not compacted
		expect(retrieve(l.db, q("sockets"), scope).evidence).toEqual([]); // thinking is not a seed
		const visibleThinking = indexed(fixtureEntries(), { leaf: "om", folded: ["r2"] });
		expect(retrieve(visibleThinking.l.db, q("30000ms"), scopeOf(visibleThinking.s.ctx)).evidence[0].context).toEqual([]);
		s.sm.buildSessionProjection = () => { throw new Error("projection unavailable"); };
		expect(retrieve(l.db, q("retry PASS"), scopeOf(s.ctx)).evidence).toEqual([]);
		// Check the boundary against Pi's real projection, not just the fake session's hidden list.
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const real = scopeOf(s.ctx);
		expect([...real.hidden.keys()].sort()).toEqual(["a1", "a2", "a3", "r1", "r2", "r3", "u1"]);
		expect(real.visible.has("u3")).toBe(true); // firstKept is retained
		expect(real.visible.has("r4")).toBe(true); // before compaction, but inside the retained range
		expect(retrieve(l.db, q("mutex deadlock"), real).evidence).toEqual([]);
	});

	test("assistant prose gets a quota, fills only free places, exact hits are exempt, and rank order is kept", () => {
		const it = (id: string, kind = id[0] === "A" ? "assistant" : id[0] === "T" ? "tool_result" : "user", exact = false) => ({ id, kind, exact });
		const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
		// prose outranks outputs: two prose items, then the outputs in their own rank order (not "first N then filter")
		const crowded = ["A0", "A1", "A2", "A3", "T4", "A5", "T6", "U7"].map((id) => it(id));
		expect(ids(pickCandidates(crowded, { candidates: 4, assistantSlots: 2 }))).toEqual(["A0", "A1", "T4", "T6"]);
		// too few other items: the free place goes to the next prose item instead of staying empty
		expect(ids(pickCandidates(["A0", "A1", "A2", "T3"].map((id) => it(id)), { candidates: 4, assistantSlots: 2 }))).toEqual(["A0", "A1", "A2", "T3"]);
		// a handle the user named is not prose under the quota
		const named = [it("A0", "assistant", true), it("A1"), it("A2"), it("T3")];
		expect(ids(pickCandidates(named, { candidates: 3, assistantSlots: 1 }))).toEqual(["A0", "A1", "T3"]);
	});

	test("a tool result is titled by its own call (nearest issuer of a reused id), only when that call is hidden too", () => {
		const both = indexed(fixtureEntries(), { leaf: "om", hidden: ["a1", "r1", "a2", "r3"] });
		const ev1 = retrieve(both.l.db, q("PASS retry export"), scopeOf(both.s.ctx)).evidence;
		expect(ev1.find((e) => e.entryId === "r3")!.title).toBe("bash: npm test -- retry"); // a2's c1, not a1's "cd /w && npm test"
		expect(ev1.find((e) => e.entryId === "r1")!.title).toBe("read: src/retry.ts");
		const callShown = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"] }); // a2 still visible
		const r3 = retrieve(callShown.l.db, q("PASS 12 tests"), scopeOf(callShown.s.ctx)).evidence.find((e) => e.entryId === "r3")!;
		expect(r3.title).toBe("tool result bash");
		expect(answerInput("x", "", [r3])).not.toContain("npm test -- retry");
	});

	test("an entry offered 3 times and never needed rests 3 retrievals, then returns; needed clears; named handles never rest", () => {
		const { s: sess, l } = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"] });
		const find = (prompt: string) => retrieve(l.db, q(prompt), scopeOf(sess.ctx), undefined, resting(l.db));
		const offer = (needed: boolean) => recordOffers(l.db, [{ entryId: "r3", needed }]);
		offer(false); offer(false); offer(true); // a needed verdict starts the count over
		offer(false); offer(false);
		expect(find("PASS 12 tests").evidence.map((e) => e.entryId)).toContain("r3"); // 2 offers since: not resting
		offer(false);
		resetDb(l.db); l.reconcile(readSource(sess.ctx)!); // a projection rebuild keeps the tuning state
		for (let i = 0; i < 3; i++) {
			const r = find("PASS 12 tests");
			expect(r.evidence.map((e) => e.entryId)).not.toContain("r3");
			expect(r.rested).toEqual(["r3"]);
			expect(find(handleFor("r3")).evidence.map((e) => e.entryId)).toContain("r3"); // named: exempt (and not a rest)
			recordRests(l.db, r.rested);
		}
		expect(find("PASS 12 tests").evidence.map((e) => e.entryId)).toContain("r3");
	});

	test("a loaded skill's text is not part of the query; the user's own words are", () => {
		expect(queryOf('<skill name="t" location="/x">\nalpha beta gamma\n</skill>\n\ncheck log').tokens).toEqual(["check", "log"]);
		expect(queryOf("<skill>a</skill> one <skill>b</skill> two").tokens).toEqual(["one", "two"]); // two blocks, text between kept
	});

	test("a handle in the prompt names its own output exactly, whatever the other words are", () => {
		const { s: sess, l } = indexed(fixtureEntries(), { leaf: "om", folded: ["r3"] });
		const h = handleFor("r3");
		const hit = retrieve(l.db, q(`${h} ${h}`), scopeOf(sess.ctx)).evidence.find((e) => e.entryId === "r3");
		expect(hit).toMatchObject({ exact: true, folded: true, handle: h });
	});


});

const ev = (over: Partial<Evidence>): Evidence => ({ at: 0, ref: "E1", handle: "h000000001", entryId: "x", hidden: "compacted", kind: "tool_result", tool: "bash", title: "tool result bash npm test", excerpt: "", isError: false, folded: false, matched: 2, exact: false, context: [], seq: 0, ...over });

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
		expect(text).toContain("Evidence: aaaaaaaaa1 (38 min ago), bbbbbbbbbb [earlier claim]");
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
				{ summary: "said so", sourceHandles: ["aaaaaaaaa4"], status: "bogus" as Any },
			],
			foldedCandidates: [
				{ handle: "aaaaaaaaa1", tool: "", reason: "exact log" },
				{ handle: "aaaaaaaaa1", tool: "", reason: "duplicate" },
				{ handle: "aaaaaaaaa2", tool: "", reason: "not folded" },
				{ handle: "aaaaaaaaa4", tool: "", reason: "folded but not a tool result" },
			],
		}, all);
		expect(p.findings).toEqual([
			{ summary: "passes", sourceHandles: ["aaaaaaaaa1"], status: "verified" },
			{ summary: "failed then", sourceHandles: ["aaaaaaaaa2"], status: "historical" }, // an error result does not verify
			{ summary: "maybe sockets", sourceHandles: ["aaaaaaaaa3"], status: "uncertain" }, // reasoning alone never does
			{ summary: "said so", sourceHandles: ["aaaaaaaaa4"], status: "historical" },
		]);
		expect(p.foldedCandidates).toEqual([{ handle: "aaaaaaaaa1", tool: "bash npm test", reason: "exact log" }]);
	});

});

/** A model registry that answers each call from `replies` in order and records every context it was sent. */
function registry(replies: Array<string | Error>) {
	const sent: Any[] = [];
	const model = { provider: "p", id: "cheap", contextWindow: 100_000, cost: { input: 0.1 }, maxTokens: 4000 };
	return {
		sent,
		reg: {
			getAvailable: async () => [model],
			complete: async (_m: Any, context: Any) => {
				sent.push(structuredClone(context));
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
	async function run(replies: Array<string | Error>, e: Any = { messageType: "user", prompt: "why did the mutex attempt fail?" }, o: Parameters<typeof fakeSession>[1] = { folded: ["r4"] }, entries: Any[] = withSibling()) {
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
	test("the trace keeps the note text, and agent_end records whether the run used the cited handles", async () => {
		for (const used of [true, false]) {
			const s = fakeSession(withSibling(), { leaf: "om", folded: ["r4"] });
			const { reg } = registry([ANSWER]);
			const ctx = { ...s.ctx, modelRegistry: reg };
			const logs: Any[] = [];
			const mem = new Memory((r) => logs.push(r));
			mem.sessionStart(ctx);
			await mem.beforeAgentStart(ctx, { messageType: "user", prompt: "why did the mutex attempt fail?" });
			const note = mem.current(ctx)!;
			const retrieval = logs.find((r) => r.type === "memory_retrieval");
			expect(retrieval.note).toBe(note.text);
			const h = handleFor("r4");
			mem.injected(note.text.length, 1);
			// the run: the prompt, then a recall of the cited handle (or of something else), then a final answer naming it (or not)
			const msg = (id: string, parentId: string, message: Any) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message });
			s.state.entries.push(
				msg("p1", "om", { role: "user", content: [{ type: "text", text: "why did the mutex attempt fail?" }] }),
				msg("p2", "p1", { role: "assistant", content: [{ type: "toolCall", id: "z", name: "zip_recall", arguments: { handle: used ? h : "zzzzzzzzzz" } }] }),
				msg("p3", "p2", { role: "assistant", content: [{ type: "text", text: used ? `see ${h}` : "done" }] }),
			);
			s.state.leaf = "p3";
			mem.agentEnd(ctx);
			const usage = logs.find((r) => r.type === "memory_usage");
			expect(usage).toMatchObject({ requestId: retrieval.requestId, recallCalls: 1, assistantMessages: 2, used });
			expect(usage.recalled).toEqual(used ? [h] : []);
			expect(usage.mentioned).toEqual(used ? [h] : []);
			mem.shutdown();
		}
		// a note that never went into a request gets no usage record
		const { logs } = await run([ANSWER]);
		expect(logs.some((r) => r.type === "memory_usage")).toBe(false);
	});

	test("the model's verdicts feed the rest count: three unneeded offers of r4, then the fourth prompt rests it", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", folded: ["r4"] });
		const none = '{"needed":[],"findings":[],"folded":[]}';
		const { reg, sent } = registry([none, none, none, ANSWER]);
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		for (let i = 0; i < 4; i++) await mem.beforeAgentStart(ctx, { messageType: "user", prompt: "why did the mutex attempt fail?" });
		const rets = logs.filter((r) => r.type === "memory_retrieval");
		expect(rets.slice(0, 3).map((r) => r.candidates)).toEqual([1, 1, 1]);
		expect(rets[3]).toMatchObject({ rested: [handleFor("r4")], skip: "no candidates" });
		expect(sent).toHaveLength(3); // nothing left to ask about: no call
		mem.shutdown();
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
		expect(retrieval.evidence[0]).toMatchObject({ hidden: "folded", cited: false });
		expect(retrieval.decisions[0].need).toBe("N");
		expect(retrieval.drops.notNeeded).toBe(2);
	});

	// The one call's reply: a finding that cites the retrieved bench output.
	const ANSWER = '{"needed":[{"evidence":"E1","reason":"The request asks why the mutex attempt failed."}],"findings":[{"summary":"The mutex bench deadlocked in queue.ts.","evidence":["E1"],"status":"verified"}],"folded":[{"evidence":"E1","reason":"bench log"}]}';

	test("slow retrieval releases the foreground, but only the current live run can receive its result", async () => {
		const prev = process.env.PI_ZIP_RETRIEVAL_WAIT_MS;
		process.env.PI_ZIP_RETRIEVAL_WAIT_MS = "5";
		try {
			for (const action of ["keep", "end", "tree", "compact", "session", "shutdown", "new-prompt"]) {
				const s = fakeSession(withSibling(), { leaf: "om", folded: ["r4"] });
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
					await mem.beforeAgentStart(ctx, { messageType: "user", prompt: "why did the mutex attempt fail?" });
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
		const clean = await run([ANSWER], { messageType: "user", prompt: "why did the mutex attempt fail?" }, {}, fixtureEntries().slice(0, 3));
		expect([clean.sent.length, clean.note]).toEqual([0, null]);
		expect(clean.retrieval.skip).toBe("nothing hidden yet");
		// a compaction also hides what the model used to see: the gate opens on it alone, without any folded output
		const compacted = await run([ANSWER], { messageType: "user", prompt: "timeout 30000ms" }, { hidden: ["r2"] }, withSibling());
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
		expect(found.retrieval.terms).toContain("mutex");
		const empty = await run([ANSWER], { messageType: "user", prompt: "zzzqqq wwwyyy" });
		expect([empty.sent.length, empty.note]).toEqual([0, null]);
		expect(empty.retrieval.skip).toBe("no candidates");
	});


	test("history: search then one call; the note cites the folded result's real handle", async () => {
		const { sent, note, retrieval } = await run([ANSWER]);
		expect(sent[0].messages[0].content[0].text).toContain("E1 tool_result bash folded");
		expect(sent[0].messages[0].content[0].text).toContain("why did the mutex attempt fail?");
		expect(sent[0].messages[0].content[0].text).not.toContain("sibling branch");
		expect(note!.text).toMatch(new RegExp(`Evidence: ${handleFor("r4")} \\([0-9.]+ (min|h|d) ago\\) \\[seen in output\\]`));
		expect(note!.text).toContain(`- ${handleFor("r4")} (`);
		expect(note!.text).not.toContain(handleFor("r6"));
		expect(retrieval).toMatchObject({ findings: 1, folded: 1, stage: "prepared", deferred: false });
		// the tuning fields: per-step latency, token counts, and which candidate carried the finding
		expect(retrieval.latency.answer).toBeGreaterThanOrEqual(0);
		expect(retrieval.calls.map((c: Any) => c.step)).toEqual(["answer"]);
		expect(retrieval.calls[0].replyChars).toBeGreaterThan(0);
		expect(retrieval.evidence.find((x: Any) => x.cited)).toMatchObject({ kind: "tool_result", folded: true, cited: true });
		expect(retrieval.drops).toEqual({ unknownHandle: 0, empty: 0, cap: 0, notFolded: 0, notNeeded: 0 });
		expect(retrieval.decisions).toEqual([{ ref: "E1", need: "Y", reason: "The request asks why the mutex attempt failed." }]);
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
		zip.memory = { current: () => note, injected: () => { seen.injected++; }, reinjected: () => { seen.reinjected++; } };
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
