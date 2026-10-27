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
import { ANSWER_INSTRUCTIONS, answerInput, buildAnswerInput, EVIDENCE_CHARS, parseReply, recordedAt, requestText, RetrievalConversation, type NeedDecision } from "../src/retrieval/assistant.ts";
import { conclusionsOf, DEFAULT_LIMITS, type Evidence, GRAPH_REFERENCE_LIMIT, queryOf, retrieve, scopeOf } from "../src/retrieval/search.ts";
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

	test("every text before the latest compaction on the active branch is a candidate (requests, mid-turn text, reasoning, outputs); sibling-branch text is not", () => {
		const { s, l } = indexed(withSibling(), { leaf: "om", hidden: [...COMPACTED, "a6"] });
		const ids = (prompt: string) => retrieve(l.db, q(prompt), scopeOf(s.ctx)).evidence.map((e) => e.entryId);
		expect(ids("how were the sockets fixed")).toContain("a3");
		expect(ids("how were the sockets fixed")).not.toContain("a6"); // a6 matches too, on the sibling branch
		expect(retrieve(l.db, q("running first"), scopeOf(s.ctx)).evidence.map((e) => [e.entryId, e.kind])).toEqual([["a1", "assistant_text"]]); // mid-turn text
		expect(ids("PASS 12 tests")[0]).toBe("r3"); // a hidden tool output on the active branch is a candidate
		s.state.leaf = "a6"; // /tree to the sibling: no compaction on that branch, so nothing there is hidden
		expect(ids("how were the sockets fixed")).toEqual([]);
		const shown = indexed(fixtureEntries().slice(0, 7)); // no compaction and no fold: nothing is searchable
		expect(retrieve(shown.l.db, q("how were the sockets fixed"), scopeOf(shown.s.ctx)).evidence).toEqual([]);
	});

	test("referential graph traversal links file paths and symbols in the prompt to hidden tool outputs and merges multi-chunk passages", () => {
		const chunk0 = "# CUTOVER VERSION of cloudformation-v0.yml\n" + "header_line: true\n".repeat(170);
		const chunk1 = "Parameters:\n  CreateServer:\n    Default: 'true'\n";
		const entries: Any[] = [
			user("u1", null, "read cutover template"),
			asst("a1", "u1", [call("c1", "read", { path: "sftp_auth_migration/cloudformation.cutover.yml" })]),
			result("r_cfn", "a1", "c1", "read", chunk0 + chunk1),
			asst("a2", "r_cfn", [{ type: "text", text: "Cutover template inspected." }]),
		];
		let parent = "a2";
		for (let i = 1; i <= 6; i++) {
			entries.push(
				user(`u_p${i}`, parent, `sftp_auth_migration check ${i}`),
				asst(`a_p${i}`, `u_p${i}`, [{ type: "text", text: `Everything in sftp_auth_migration is working fine without surprise (${i}).` }]),
			);
			parent = `a_p${i}`;
		}
		// Even identical commands/outputs are separate executions with their own handles and timestamps.
		entries.push(
			user("u_dup", parent, "run status"),
			asst("a_dup", "u_dup", [
				call("cd1", "bash", { command: "git status" }),
				call("cd2", "bash", { command: "git status" }),
				call("cd3", "write", { path: "src/a.ts" }),
				call("cd4", "write", { path: "src/b.ts" }),
			]),
			result("r_dup1", "a_dup", "cd1", "bash", "nothing to commit, working tree clean"),
			result("r_dup2", "r_dup1", "cd2", "bash", "nothing to commit, working tree clean"),
			result("r_write_a", "r_dup2", "cd3", "write", "Successfully wrote 128 bytes"),
			result("r_write_b", "r_write_a", "cd4", "write", "Successfully wrote 128 bytes"),
			E("cm", "r_write_b", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1000 }),
		);
		const { s: sess, l } = indexed(entries);
		sess.sm.buildSessionProjection = () => buildSessionProjection(sess.state.entries, sess.state.leaf);
		const ev = retrieve(
			l.db,
			q("reevaluate @sftp_auth_migration/cloudformation-v0.yml, make sure everything is working fine without surprise"),
			scopeOf(sess.ctx),
		).evidence;
		const cfn = ev.find((e) => e.entryId === "r_cfn");
		expect(cfn).toBeDefined();
		expect(ev.indexOf(cfn!)).toBeLessThan(3); // promoted to the top by referential graph traversal
		expect(cfn!.excerpt).toContain("cloudformation-v0.yml");
		expect(cfn!.excerpt).toContain("Default: 'true'"); // second chunk merged into the same evidence item

		const dupEv = retrieve(l.db, q("nothing to commit working tree clean"), scopeOf(sess.ctx)).evidence;
		expect(dupEv.filter((e) => e.entryId === "r_dup1" || e.entryId === "r_dup2")).toHaveLength(2);

		const diffProvEv = retrieve(l.db, q("Successfully wrote 128 bytes"), scopeOf(sess.ctx)).evidence;
		expect(diffProvEv.filter((e) => e.entryId === "r_write_a" || e.entryId === "r_write_b")).toHaveLength(2);
	});

	test("per-entry FTS diversity prevents a few multi-chunk tool outputs from crowding out a relevant short entry, and path traversal returns multiple versions and deep chunks", () => {
		const noisyBlock = ("retry connection pool saturation log line\n".repeat(90) + "\n").repeat(6); // >6 chunks per noisy output
		const entries: Any[] = [
			user("u0", null, "read old and new config"),
			asst("a0", "u0", [
				call("c_old", "read", { path: "config/app.yml" }),
				call("c_new", "read", { path: "config/app.yml" }),
			]),
			result("r_old", "a0", "c_old", "read", "version: 1\nlegacy_flag: enabled\n"),
			result(
				"r_new",
				"r_old",
				"c_new",
				"read",
				"version: 2\n" + "padding_line: 0\n".repeat(450) + "deep_setting:\n  rollout_percentage: 42\n",
			),
		];
		let parent = "r_new";
		for (let i = 1; i <= 4; i++) {
			entries.push(
				asst(`an_${i}`, parent, [call(`cn_${i}`, "bash", { command: `run-bench-${i}` })]),
				result(`rn_${i}`, `an_${i}`, `cn_${i}`, "bash", noisyBlock),
			);
			parent = `rn_${i}`;
		}
		entries.push(
			asst("a_target", parent, [call("c_target", "bash", { command: "check-backoff" })]),
			result("r_target", "a_target", "c_target", "bash", "retry backoff cap is 1500ms"),
			E("cm", "r_target", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1000 }),
		);
		const { s: sess, l } = indexed(entries);
		sess.sm.buildSessionProjection = () => buildSessionProjection(sess.state.entries, sess.state.leaf);

		// Even with small ftsRows=15, 4 noisy outputs (each with >6 matching chunks) cannot crowd out r_target because perEntry=3 caps each at 3 rows.
		const divEv = retrieve(l.db, q("retry"), scopeOf(sess.ctx), { candidates: 8, expand: 6, excerptChars: 1500, ftsRows: 15 }).evidence;
		expect(divEv.some((e) => e.entryId === "r_target")).toBe(true);

		// Path traversal over config/app.yml surfaces both r_old and r_new; even when the prompt has no keyword from the deep chunk,
		// the deep chunk of r_new is still reachable when the prompt asks about rollout_percentage, and a path-only prompt still merges
		// the continuation chunk (chunk 1) of a multi-chunk file read.
		const pathEv = retrieve(l.db, q("check config/app.yml rollout_percentage and legacy_flag"), scopeOf(sess.ctx)).evidence;
		const oldHit = pathEv.find((e) => e.entryId === "r_old");
		const newHit = pathEv.find((e) => e.entryId === "r_new");
		expect(oldHit?.excerpt).toContain("legacy_flag: enabled");
		expect(newHit?.excerpt).toContain("rollout_percentage: 42");
	});

	test("graph traversal does not scan unrelated tool_result rows in search_docs, and a path with no keyword match still merges its continuation chunk", () => {
		const chunk0 = "# File: config/service.yml\n" + "header_line: 1\n".repeat(220);
		const chunk1 = "second_chunk_marker: 9001\n";
		const entries: Any[] = [
			user("u1", null, "read service config"),
			asst("a1", "u1", [call("c1", "read", { path: "config/service.yml" })]),
			result("r_svc", "a1", "c1", "read", chunk0 + chunk1),
			// Visible unrelated tool result: must never be scanned or returned
			user("u_vis", "r_svc", "unrelated"),
			asst("a_vis", "u_vis", [call("c_vis", "read", { path: "config/other.yml" })]),
			result("r_vis", "a_vis", "c_vis", "read", "other_file_body: true"),
			E("cm", "r_svc", { type: "compaction", summary: "s", firstKeptEntryId: "u_vis", tokensBefore: 1000 }),
		];
		const { s: sess, l } = indexed(entries);
		sess.sm.buildSessionProjection = () => buildSessionProjection(sess.state.entries, sess.state.leaf);

		// Prompt mentions ONLY the path config/service.yml (no words from chunk1): graph traversal still pulls chunk0 + chunk1.
		const ev = retrieve(l.db, q("inspect @config/service.yml again"), scopeOf(sess.ctx)).evidence;
		const svc = ev.find((e) => e.entryId === "r_svc");
		expect(svc?.excerpt).toContain("second_chunk_marker: 9001");
		expect(ev.some((e) => e.entryId === "r_vis")).toBe(false);

		const plans = (
			l.db
				.prepare(
					`EXPLAIN QUERY PLAN
					 SELECT DISTINCT r.entry_id AS entry_id, MAX(r.tool = 'read') AS is_read, MAX(r.seq) AS seq
					 FROM nodes f
					 JOIN edges t ON t.dst_id = f.id AND t.type = 'touches_file'
					 JOIN edges a ON a.src_id = t.src_id AND a.type = 'answered_by'
					 JOIN search_docs r ON r.entry_id = substr(a.dst_id, 7) AND r.object_type = 'chunk' AND r.kind = 'tool_result'
					 JOIN search_scope s ON s.entry_id = r.entry_id
					 WHERE f.kind = 'file' AND (f.canonical_key = ? COLLATE NOCASE OR f.canonical_key LIKE ? ESCAPE '\\')
					 GROUP BY r.entry_id ORDER BY is_read DESC, seq DESC LIMIT 3`,
				)
				.all("config/service.yml", "%/config/service.yml") as Array<{ detail: string }>
		).map((r) => r.detail);
		expect(plans.some((d) => /SCAN r\b|SCAN search_docs/i.test(d))).toBe(false);
		expect(plans.some((d) => /SEARCH r USING INDEX search_docs_entry/i.test(d))).toBe(true);
	});

	test("long pasted code cannot exhaust graph lookups or displace explicit references in the new request", () => {
		const code = Array.from({ length: 1000 }, (_, i) => `const pastedSymbol${i} = read('src/pasted_${i}.ts');`).join("\n");
		const parsed = q(`\`\`\`ts\n${code}\n\`\`\`\nCompare \`getUserId\` in @src/auth.ts with \`oldUserId\`.`);
		expect(parsed.paths).toContain("src/auth.ts");
		expect(parsed.symbols?.slice(0, 2)).toEqual(["olduserid", "getuserid"]);
		expect(parsed.paths!.length).toBeLessThanOrEqual(GRAPH_REFERENCE_LIMIT);
		expect(parsed.symbols!.length).toBeLessThanOrEqual(GRAPH_REFERENCE_LIMIT);

		const { s, l } = indexed(fixtureEntries(), { leaf: "om", hidden: COMPACTED });
		const queries: string[] = [];
		// Count SQL executions, not prepares: the path statement is prepared once but executed per reference.
		const db = {
			exec: l.db.exec.bind(l.db), close: l.db.close.bind(l.db),
			prepare(sql: string) {
				const st = l.db.prepare(sql);
				return { run: st.run.bind(st), get: st.get.bind(st), all: (...params: unknown[]) => {
					queries.push(sql + JSON.stringify(params));
					return st.all(...params);
				} };
			},
		};
		// Bypass queryOf: the traversal boundary itself must cap and deduplicate a manually constructed Query too.
		const paths = ["src/missing.ts", "SRC\\missing.ts", ...Array.from({ length: 1000 }, (_, i) => `src/missing${i}.ts`)];
		const symbols = ["missingSymbol", "MISSINGSYMBOL", ...Array.from({ length: 1000 }, (_, i) => `missingSymbol${i}`)];
		retrieve(db, { tokens: [], handles: [], paths, symbols }, scopeOf(s.ctx));
		expect(queries.filter((sql) => sql.includes("FROM nodes f"))).toHaveLength(GRAPH_REFERENCE_LIMIT);
		expect(queries.filter((sql) => sql.includes("{body identifiers}"))).toHaveLength(GRAPH_REFERENCE_LIMIT);
		expect(queries.filter((sql) => sql.includes("FROM search_fts"))).toHaveLength(GRAPH_REFERENCE_LIMIT * 2);
	});

	test("symbol boost accepts body-only and identifier-only matches without requiring the call title to contain the symbol", () => {
		const entries = [
			user("u", null, "inspect auth"),
			asst("a", "u", [call("c1", "read", { path: "src/auth.ts" }), call("c2", "read", { path: "src/getUserId.ts" })]),
			result("body", "a", "c1", "read", "function getUserId() { return 17; }"),
			result("identifier", "body", "c2", "read", "export default 42;"),
			E("cm", "identifier", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1 }),
		];
		const { s, l } = indexed(entries);
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const evidence = retrieve(l.db, { tokens: [], handles: [], symbols: ["getUserId"] }, scopeOf(s.ctx)).evidence;
		// No lexical query: these can only come from symbol-specific lookup.
		expect(evidence.map((e) => e.entryId).sort()).toEqual(["body", "identifier"]);
	});

	test("Windows graph keys in existing databases match slash, backslash and absolute prompt paths", () => {
		const entries = [
			user("u", null, "inspect config"),
			asst("a", "u", [call("c", "read", { path: "config/service.yml" })]),
			result("r", "a", "c", "read", "port: 9021"),
			E("cm", "r", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1 }),
		];
		const { s, l } = indexed(entries);
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		// Simulate an existing DB produced on Windows; edge IDs are opaque and do not need to be rewritten.
		l.db.prepare("UPDATE nodes SET canonical_key = ? WHERE kind = 'file'").run(String.raw`C:\Users\dev\project\config\service.yml`);
		// Disable lexical/fallback matches so success proves traversal through the stored Windows file node.
		l.db.exec("INSERT INTO search_fts(search_fts) VALUES('delete-all')");
		for (const path of ["config/service.yml", String.raw`config\service.yml`, String.raw`C:\Users\dev\project\config\service.yml`]) {
			const query = q(`inspect @${path}`);
			expect(query.paths).toEqual([path.replace(/\\/g, "/").toLowerCase()]);
			expect(retrieve(l.db, { ...query, tokens: [] }, scopeOf(s.ctx)).evidence.map((e) => e.entryId)).toEqual(["r"]);
		}
	});

	test("equal excerpts from repeated commands retain both execution times, handles and whole-output outcomes", () => {
		const prefix = "retry regression summary\n" + "padding\n".repeat(600);
		const entries = [
			user("u", null, "test twice"),
			asst("a1", "u", [call("c1", "bash", { command: "bun test" })]),
			{ ...result("old", "a1", "c1", "bash", prefix + "21 pass\n1 fail"), timestamp: "2026-01-01T00:00:00Z" },
			asst("a2", "old", [call("c2", "bash", { command: "bun test" })]),
			{ ...result("new", "a2", "c2", "bash", prefix + "22 pass\n0 fail"), timestamp: "2026-01-02T00:00:00Z" },
			E("cm", "new", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1 }),
		];
		const { s, l } = indexed(entries);
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const evidence = retrieve(l.db, q("retry"), scopeOf(s.ctx), { ...DEFAULT_LIMITS, excerptChars: 120 }).evidence;
		const old = evidence.find((e) => e.entryId === "old")!, newer = evidence.find((e) => e.entryId === "new")!;
		expect(old).toBeDefined(); expect(newer).toBeDefined();
		expect(old.excerpt).toBe(newer.excerpt); // identical passage, but the rest of each output is different
		expect(old.at).toBe(Date.UTC(2026, 0, 1)); expect(newer.at).toBe(Date.UTC(2026, 0, 2));
		expect(old.outcome).toBe("exit 0, 21 passed, 1 failed"); expect(newer.outcome).toBe("exit 0, 22 passed, 0 failed");
		expect(old.handle).toBe(handleFor("old")); expect(newer.handle).toBe(handleFor("new"));
		const input = answerInput("compare old and new tests", "", evidence);
		expect(input).toContain(`${old.ref} tool_result bash`); expect(input).toContain(`${newer.ref} tool_result bash`);
		expect(input).toContain("21 passed, 1 failed"); expect(input).toContain("22 passed");
	});

	test("a conclusion is quoted from its own text and titled by the request it answered", () => {
		const { s, l } = indexed(fixtureEntries(), { leaf: "om", hidden: COMPACTED });
		const a3 = retrieve(l.db, q("sockets"), scopeOf(s.ctx)).evidence.find((e) => e.entryId === "a3")!;
		expect(a3).toMatchObject({ kind: "assistant", hidden: "compacted", handle: handleFor("a3"), folded: false, excerpt: "Fixed by closing sockets in the pool.",
			title: 'answer to: "fix the retry timeout in src/retry.ts"' });
		expect(answerInput("x", "", [{ ...a3, ref: "E1" }])).toContain(`E1 conclusion [handle ${handleFor("a3")}] — answer to: "fix the retry timeout in src/retry.ts"`);
	});

	test("the hidden boundary follows Pi's own projection; with no projection nothing is hidden", () => {
		const s = fakeSession(fixtureEntries(), { leaf: "om" });
		s.sm.buildSessionProjection = () => buildSessionProjection(s.state.entries, s.state.leaf);
		const real = scopeOf(s.ctx);
		// everything before the compaction record, also the kept part from firstKept u3 on (still visible, but searchable)
		expect([...real.hidden.keys()].sort()).toEqual(["a1", "a2", "a3", "a4", "r1", "r2", "r3", "r4", "u1", "u3"]);
		expect(real.visible.has("u3")).toBe(true);
		const l = Ledger.open(readSource(s.ctx)!, join(s.dir, "x.sqlite"));
		open.push(l);
		l.reconcile(readSource(s.ctx)!);
		expect(retrieve(l.db, q("sockets fixed"), real).evidence.map((e) => e.entryId).sort()).toEqual(["a1", "a3"]); // a1: its reasoning names sockets; a5 (after the compaction) is not searched
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

	test("entries after the latest compaction record are not candidates, even when they rank higher", () => {
		const entries: Any[] = [user("u1", null, "start"), asst("a1", "u1", [{ type: "text", text: "retry happened once" }])];
		entries.push(E("cm", "a1", { type: "compaction", summary: "s", firstKeptEntryId: "a1", tokensBefore: 1 }));
		let parent = "cm";
		for (let i = 2; i <= 6; i++) { // five later conclusions that rank higher for "retry"
			entries.push(user(`u${i}`, parent, "again"), asst(`a${i}`, `u${i}`, [{ type: "text", text: "retry retry retry retry" }]));
			parent = `a${i}`;
		}
		const { s: sess, l } = indexed(entries, { hidden: ["u1"] });
		const ev = retrieve(l.db, q("retry"), scopeOf(sess.ctx), { ...DEFAULT_LIMITS, ftsRows: 2 }).evidence;
		expect(ev.map((e) => e.entryId)).toEqual(["a1"]); // a1 is kept in view by the compaction, and still searchable
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

	test("planner keyword sets merge round-robin (an entry one facet finds is not buried), and a matched call brings its result", () => {
		const entries: Any[] = [user("u1", null, "start")];
		let parent = "u1";
		for (const id of ["a1", "a2", "a3"]) { // match two sets each: summed fusion would rank all three above y
			entries.push(asst(id, parent, [{ type: "text", text: "alpha beta alpha beta" }]));
			parent = id;
		}
		entries.push(asst("y", parent, [{ type: "text", text: "the gamma decision was taken because of the outage" }]),
			asst("c", "y", [call("k1", "bash", { command: "deployxyz --prod" })]), result("r", "c", "k1", "bash", "ok done"),
			E("cm", "r", { type: "compaction", summary: "s", firstKeptEntryId: "cm", tokensBefore: 1 }));
		const { s: sess, l } = indexed(entries);
		sess.sm.buildSessionProjection = () => buildSessionProjection(sess.state.entries, sess.state.leaf);
		const ids = retrieve(l.db, { tokens: [], handles: [], sets: [{ keywords: ["alpha"] }, { keywords: ["beta"] }, { keywords: ["gamma"] }] }, scopeOf(sess.ctx)).evidence.map((e) => e.entryId);
		expect(ids.indexOf("y")).toBeGreaterThanOrEqual(0);
		expect(ids.indexOf("y")).toBeLessThan(ids.indexOf("a3"));
		const hop = retrieve(l.db, { tokens: [], handles: [], sets: [{ keywords: ["deployxyz"] }] }, scopeOf(sess.ctx)).evidence;
		expect(hop.map((e) => [e.entryId, e.kind])).toEqual([["c", "tool_call"], ["r", "tool_result"]]); // "ok done" matches nothing itself
	});

	test("handles in the prompt name their outputs exactly, each kept, also two results of one step", () => {
		const { s: sess, l } = indexed(fixtureEntries(), { leaf: "om", folded: ["r1", "r2"] });
		const [h1, h2, h3] = [handleFor("r1"), handleFor("r2"), handleFor("r3")]; // r1, r2: both results of a1's calls
		const ev = retrieve(l.db, q(`compare ${h2} with ${h1} and ${h3}`), scopeOf(sess.ctx)).evidence;
		expect(ev.map((e) => [e.entryId, e.exact, e.folded])).toEqual([["r2", true, true], ["r1", true, true], ["r3", true, true]]); // r3: before the compaction
	});


});

const ev = (over: Partial<Evidence>): Evidence => ({ at: 0, outcome: "", ref: "E1", handle: "h000000001", entryId: "x", hidden: "compacted", kind: "tool_result", tool: "bash", title: "tool result bash npm test", excerpt: "", isError: false, folded: false, matched: 2, exact: false, context: [], seq: 0, ...over });

describe("evidence packing", () => {
	test("packs sources before extra passages/thinking and skips oversized items without blocking later evidence", () => {
		const n = Math.floor(EVIDENCE_CHARS * 0.37); // two primaries fit, a third passage does not
		const first = "primary_a " + "a".repeat(n), extra = "optional_a " + "b".repeat(n);
		const second = "primary_b " + "c".repeat(n);
		const evidence = [
			ev({ excerpt: [first, extra].join(" … "), passages: [first, extra], context: ["unverified " + "d".repeat(n)] }),
			ev({ ref: "E2", handle: "second0000", entryId: "second", excerpt: second, passages: [second] }),
			ev({ ref: "E3", handle: "huge000000", entryId: "huge", excerpt: "x".repeat(EVIDENCE_CHARS + 4000) }),
			ev({ ref: "E4", handle: "last000000", entryId: "last", excerpt: "small_late_fact: 719" }),
		];
		const packed = buildAnswerInput("compare results", "recent task", evidence);
		expect(packed.sent.map((e) => e.ref)).toEqual(["E1", "E2", "E4"]);
		expect(packed.sent[0].excerpt).toBe(first);
		expect(packed.sent[0].context).toEqual([]);
		expect(packed.text).toContain("small_late_fact: 719");
		expect(packed.text).not.toContain(extra);
		expect(packed.text).not.toContain("E3 tool_result");
		expect(packed.evidenceChars).toBeLessThanOrEqual(EVIDENCE_CHARS);
		expect(evidence[0].excerpt).toBe([first, extra].join(" … ")); // no mutation of the retrieved source
	});

	test("shares a common passage once while retaining per-execution handles, times, outcomes and independent citations", () => {
		const common = "identical_quoted_body " + "shared ".repeat(350);
		const evidence = [
			ev({ ref: "E1", handle: "old0000000", entryId: "old", at: Date.UTC(2026, 0, 1), outcome: "exit 1, 1 failed", isError: true,
				excerpt: [common, "old_only_detail"].join(" … "), passages: [common, "old_only_detail"] }),
			ev({ ref: "E2", handle: "new0000000", entryId: "new", at: Date.UTC(2026, 0, 2), outcome: "exit 0, 2 passed", folded: true,
				excerpt: [common, "new_only_detail"].join(" … "), passages: [common, "new_only_detail"] }),
			ev({ ref: "E3", handle: "other00000", entryId: "other", excerpt: common, passages: [common] }),
			ev({ ref: "E99", handle: "shown00000", entryId: "shown", hidden: undefined as Any, excerpt: common }),
		];
		const packed = buildAnswerInput("compare executions", "", evidence, Date.UTC(2026, 0, 3));
		expect(packed.sharedPassages).toBe(1);
		expect(packed.text.split(common)).toHaveLength(2); // once in the actual serialized payload, not just in an internal group map
		expect(packed.text).toContain("excerpt for E1, E2, E3:");
		expect(packed.text).toContain("[handle old0000000]"); expect(packed.text).toContain("[handle new0000000]");
		expect(packed.text).toContain("recorded 2026-01-01 00:00 UTC"); expect(packed.text).toContain("recorded 2026-01-02 00:00 UTC");
		expect(packed.text).toContain("exit 1, 1 failed"); expect(packed.text).toContain("exit 0, 2 passed");
		expect(packed.text).toContain("old_only_detail"); expect(packed.text).toContain("new_only_detail");
		expect(packed.text).not.toContain("E99");
		expect(packed.sent.map((e) => e.handle)).toEqual(["old0000000", "new0000000", "other00000"]);
		const packet = parseReply(JSON.stringify({ needed: [{ evidence: "E2", reason: "new run is needed" }], findings: [
			{ summary: "new result", evidence: ["E2"] }, { summary: "old must not be implicitly granted", evidence: ["E1"] },
		], folded: [{ evidence: "E2", reason: "exact new run" }] }), packed.sent, "r", "v")!;
		expect(packet.findings.map((f) => f.sourceHandles)).toEqual([["new0000000"]]);
		expect(packet.foldedCandidates.map((f) => f.handle)).toEqual(["new0000000"]);
		const comparison = parseReply(JSON.stringify({ needed: [
			{ evidence: "E1", reason: "compare the old run" }, { evidence: "E2", reason: "compare the new run" },
		], findings: [{ summary: "outcome changed", evidence: ["E1", "E2"] }] }), packed.sent, "r", "v")!;
		expect(comparison.findings[0].sourceHandles).toEqual(["old0000000", "new0000000"]);
	});

	test("the evidence budget excludes the separately bounded request/recent header", () => {
		const quote = "large_complete_quote " + "x".repeat(EVIDENCE_CHARS - 600);
		const packed = buildAnswerInput("long_request ".repeat(1000), "recent_context ".repeat(1000), [ev({ excerpt: quote })]);
		expect(packed.sent.map((e) => e.ref)).toEqual(["E1"]);
		expect(packed.text).toContain(quote);
		expect(packed.evidenceChars).toBeLessThanOrEqual(EVIDENCE_CHARS);
		expect(packed.text.length).toBeGreaterThan(EVIDENCE_CHARS);
	});

	test("text sharing preserves case and punctuation differences in code, and bounds the header separately from evidence", () => {
		const packed = buildAnswerInput("p".repeat(100_000), "r".repeat(100_000), [
			ev({ excerpt: "return getUserId(a);" }),
			ev({ ref: "E2", handle: "different0", excerpt: "return getUserid(a);" }), // case alone differs
			ev({ ref: "E3", handle: "punct00000", excerpt: "return getUserId(a)!" }), // punctuation alone differs
		]);
		expect(packed.passages).toBe(3); expect(packed.sharedPassages).toBe(0);
		expect(packed.text).toContain("return getUserId(a);"); expect(packed.text).toContain("return getUserid(a);");
		expect(packed.text).toContain("return getUserId(a)!");
		expect(packed.text).not.toContain("r".repeat(1801));
		expect(packed.text.length).toBeLessThanOrEqual(EVIDENCE_CHARS + ANSWER_INSTRUCTIONS.length + 4000 + 1800 + 512);
	});
});

describe("packet validation", () => {
	test("each item and each cited handle says when it was recorded, against the request time", () => {
		const now = Date.UTC(2026, 9, 25, 21, 33);
		const input = answerInput("check the new log", "", [
			ev({ ref: "E1", at: Date.UTC(2026, 9, 25, 20, 55) }),
			ev({ ref: "E2", handle: "bbbbbbbbbb", at: Date.UTC(2026, 9, 24, 21, 33) }),
			ev({ ref: "E3", handle: "cccccccccc", at: 0 }),
		], now);
		expect(input).toContain("NEW USER REQUEST (2026-10-25 21:33 UTC)");
		expect(input).toContain("E1 tool_result bash [handle h000000001] — tool result bash npm test (recorded 2026-10-25 20:55 UTC, 38 min before this request)");
		expect(input).toContain("(recorded 2026-10-24 21:33 UTC, 24 h before this request)");
		expect(input).toContain("E3 tool_result bash [handle cccccccccc] — tool result bash npm test (recorded at an unknown time)");
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
		const evidence = [ev({ excerpt: "small" }), ev({ ref: "E2", handle: "bbbbbbbbbb", excerpt: "x".repeat(EVIDENCE_CHARS) })];
		const packet = await conv.answer("request", "", evidence, "r", "v");
		expect(sent[0].messages[0].content[0].text).not.toContain("E2 tool_result");
		expect(conv.stats.evidenceItems).toBe(1);
		expect(conv.stats.sentRefs).toEqual(["E1"]);
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
	// The planner's reply, then the answer call's reply: a finding from the earlier conclusion.
	const PLAN = JSON.stringify({ continue: false, queries: [{ facet: "how", lang: "en", keywords: ["sockets", "fixed"] }] });
	const ANSWER = '{"needed":[{"evidence":"E1","reason":"The request asks how the sockets were fixed."}],"findings":[{"summary":"Earlier the retry timeout was fixed by closing sockets in the pool.","evidence":["E1"],"status":"historical"}],"folded":[]}';
	const isPlan = (context: Any) => String(context?.messages?.[0]?.content?.[0]?.text ?? "").startsWith("You prepare keyword searches");

	async function run(replies: Array<string | Error>, e: Any = { messageType: "user", prompt: PROMPT }, o: Parameters<typeof fakeSession>[1] = { hidden: COMPACTED }, entries: Any[] = withSibling()) {
		const s = fakeSession(entries, { leaf: "om", ...o });
		const { sent, reg } = registry(replies);
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		await mem.beforeAgentStart(ctx, e);
		await mem.settled();
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

	test("plan, then search, then the answer: the planner's keywords are the query and the note cites the real handle", async () => {
		const { sent, note, retrieval } = await run([PLAN, ANSWER]);
		expect(sent.map(isPlan)).toEqual([true, false]);
		expect(sent[0].messages[0].content[0].text).toContain(PROMPT);
		const input = sent[1].messages[0].content[0].text;
		expect(input).toContain(`conclusion [handle ${handleFor("a3")}] — answer to: "fix the retry timeout in src/retry.ts"`);
		expect(input).not.toContain("sibling branch");
		expect(retrieval.queries).toEqual([{ facet: "how", lang: "en", keywords: ["sockets", "fixed"] }]);
		expect(retrieval.calls.map((c: Any) => c.step)).toEqual(["plan", "answer"]);
		expect(note).toMatchObject({ found: true });
		expect(note!.text).toMatch(new RegExp(`Evidence: ${handleFor("a3")} \\([0-9.]+ (min|h|d) ago\\) \\[earlier conclusion\\]`));
		expect(note!.text).not.toContain(handleFor("a6"));
		expect(retrieval).toMatchObject({ findings: 1, folded: 0, stage: "prepared" });
	});

	test("a continuation ends after the plan; an invalid plan falls back to the request's words; nothing found costs no answer call", async () => {
		const cont = await run(['{"continue":true,"queries":[]}']);
		expect([cont.sent.length, cont.note, cont.retrieval.skip]).toEqual([1, null, "continuation"]);
		const fallback = await run(["not json", ANSWER]);
		expect(fallback.sent.length).toBe(2);
		expect(fallback.retrieval.terms).toContain("sockets");
		const none = await run([JSON.stringify({ continue: false, queries: [{ keywords: ["zzzqqq"] }] })]);
		expect([none.sent.length, none.note, none.retrieval.skip]).toEqual([1, null, "no candidates"]);
	});

	test("the main model waits for the plan and the search only; the answer runs on, and only the current live run receives it", async () => {
		for (const action of ["keep", "end", "tree", "compact", "session", "shutdown", "new-prompt"]) {
			const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
			const { reg } = registry([]);
			const finishers: Array<(r: Any) => void> = [];
			const finish = (r: Any) => finishers.forEach((f) => f(r));
			let signal: AbortSignal | undefined;
			(reg as Any).complete = (_m: Any, context: Any, options: Any) => {
				if (isPlan(context)) return Promise.resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: PLAN }] });
				signal ??= options.signal; // the first run's answer call
				return new Promise((resolve) => { finishers.push(resolve); }); // deliberately ignores abort
			};
			const ctx = { ...s.ctx, modelRegistry: reg };
			const mem = new Memory(() => {});
			try {
				mem.sessionStart(ctx);
				await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
				const settled = mem.settled();
				expect(mem.current(ctx)).toMatchObject({ text: null, pending: expect.stringContaining("zip_recall") });
				if (action === "end") mem.agentEnd(ctx);
				if (action === "tree") mem.catchUp(ctx, "session_tree");
				if (action === "compact") mem.catchUp(ctx, "session_compact");
				if (action === "session") mem.sessionStart(ctx);
				if (action === "shutdown") mem.shutdown();
				if (action === "new-prompt") await mem.beforeAgentStart(ctx, { messageType: "user", prompt: "zzzqqq wwwyyy" });
				finish({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }] });
				await settled;
				if (action === "keep") expect(mem.current(ctx)).toMatchObject({ found: true });
				else {
					expect(signal!.aborted).toBe(true);
					expect(mem.current(ctx)?.prompt ?? null).not.toBe(PROMPT); // a new prompt may have its own note, never this one
				}
			} finally { mem.shutdown(); }
		}
	});

	test("zip_recall with no arguments waits for the findings, which then are not injected again", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { reg } = registry([]);
		let finish!: (r: Any) => void;
		(reg as Any).complete = (_m: Any, context: Any) => isPlan(context)
			? Promise.resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: PLAN }] })
			: new Promise((resolve) => { finish = resolve; });
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
		const waiting = mem.awaitNote(ctx);
		finish({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: ANSWER }] });
		const text = await waiting;
		expect(text).toContain(handleFor("a3"));
		expect(mem.current(ctx)).toMatchObject({ delivered: true });
		expect(logs.find((r) => r.type === "memory_wait")).toMatchObject({ ready: true, found: true });
		mem.shutdown();
	});

	test("findings that never reached the model are logged as dropped, with no usage record", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { reg } = registry([PLAN, ANSWER]);
		const ctx = { ...s.ctx, modelRegistry: reg };
		const logs: Any[] = [];
		const mem = new Memory((r) => logs.push(r));
		mem.sessionStart(ctx);
		await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
		await mem.settled();
		mem.agentEnd(ctx); // no injected() call
		const id = logs.find((r) => r.type === "memory_retrieval").requestId;
		expect(logs.filter((r) => r.type === "memory_dropped")).toEqual([expect.objectContaining({ requestId: id })]);
		expect(logs.some((r) => r.type === "memory_usage")).toBe(false);
		mem.shutdown();
	});

	test("the trace keeps the note text, and agent_end records whether the run used the cited handles", async () => {
		for (const [used, recall, name] of [[true, true, true], [false, false, false], [false, false, true]] as const) {
			const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
			const { reg } = registry([PLAN, ANSWER]);
			const ctx = { ...s.ctx, modelRegistry: reg };
			const logs: Any[] = [];
			const mem = new Memory((r) => logs.push(r));
			mem.sessionStart(ctx);
			await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
			await mem.settled();
			const note = mem.current(ctx)!;
			const retrieval = logs.find((r) => r.type === "memory_retrieval");
			expect(retrieval.note).toBe(note.text);
			const h = handleFor("a3");
			mem.injected(note.text!.length, 1);
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
	});

	test("rejected items stay in the trace but never enter the note", async () => {
		const reply = JSON.stringify({ needed: [], findings: [{ summary: "must not inject", evidence: ["E1"] }], folded: [{ evidence: "E1", reason: "must not inject" }] });
		const { sent, note, retrieval } = await run([PLAN, reply]);
		expect(sent).toHaveLength(2);
		expect(note).toMatchObject({ found: false, text: expect.not.stringContaining("must not inject") });
		expect(retrieval.skip).toBe("nothing relevant");
		expect(retrieval.evidence[0]).toMatchObject({ hidden: "compacted", cited: false });
		expect(retrieval.decisions.every((d: Any) => d.need === "N")).toBe(true);
		expect(retrieval.drops.notNeeded).toBe(2);
	});

	test("reasoning: the planner at the lowest level, the answer low by default; explicit level wins; non-reasoning models send none", async () => {
		const cases: Array<[Partial<Any>, string | undefined, string | undefined, string | undefined]> = [
			[{ reasoning: true }, undefined, "off", "low"],
			[{ reasoning: true }, "p/cheap:high", "off", "high"],
			[{ reasoning: false }, undefined, undefined, undefined],
			[{}, undefined, undefined, undefined], // no capability metadata: provider default
		];
		for (const [over, setting, plan, answer] of cases) {
			if (setting) process.env.PI_ZIP_JUDGE_MODEL = setting; else delete process.env.PI_ZIP_JUDGE_MODEL;
			const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
			const { options, reg } = registry([PLAN, ANSWER], over);
			const streamed: Any[] = [];
			(reg as Any).streamSimple = (_m: Any, c: Any, opts: Any) => {
				streamed.push({ ...opts });
				return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: isPlan(c) ? PLAN : ANSWER }], usage: {} }) };
			};
			const ctx = { ...s.ctx, modelRegistry: reg };
			const mem = new Memory(() => {});
			mem.sessionStart(ctx);
			await mem.beforeAgentStart(ctx, { messageType: "user", prompt: PROMPT });
			await mem.settled();
			const sentOpts = [...streamed, ...options];
			expect(sentOpts.map((o) => o.reasoning)).toEqual([plan, answer]);
			expect(sentOpts.map((o) => o.maxTokens)).toEqual([1500, 4000]);
			mem.shutdown();
			rmSync(s.dir, { recursive: true, force: true });
		}
		delete process.env.PI_ZIP_JUDGE_MODEL;
	});

	test("zip off gates calls, cancels in-flight retrieval, drops ready notes, and leaves indexing active", async () => {
		const s = fakeSession(withSibling(), { leaf: "om", hidden: COMPACTED });
		const { reg } = registry([]), { pi, handlers } = fakePi();
		const ctx = { ...s.ctx, modelRegistry: reg, getSystemPrompt: () => "", ui: { notify: () => {} }, mode: "tui" };
		let mem!: Memory, calls = 0, answers = 0, signal!: AbortSignal, hang = true, finish!: (res: Any) => void;
		const originalStart = Memory.prototype.sessionStart;
		const start = spyOn(Memory.prototype, "sessionStart").mockImplementation(function (this: Memory, c: Any) { mem = this; originalStart.call(this, c); });
		const logs: Any[] = [];
		const ledger = spyOn(Zip.prototype, "ledger").mockImplementation((r) => { logs.push(r); });
		const reply = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
		(reg as Any).complete = (_m: Any, context: Any, options: Any) => {
			calls++;
			if (isPlan(context)) return Promise.resolve(reply(PLAN));
			answers++; signal = options.signal;
			return hang ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(reply(ANSWER));
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
			expect([calls, answers, signal.aborted]).toEqual([2, 1, false]);
			const pending = mem.settled();
			await cmd("off");
			expect(signal.aborted).toBe(true);
			await cmd("on"); // enabling again must not resurrect the cancelled result
			finish(reply(ANSWER)); await pending;
			expect(mem.current(ctx)).toBeNull();
			expect(logs.find((r) => r.type === "memory_retrieval").skip).toBe("cancelled");
			hang = false;
			await prompt(); await mem.settled();
			expect(answers).toBe(2);
			expect(mem.current(ctx)).toMatchObject({ found: true });
			await cmd("off");
			expect(mem.current(ctx)).toBeNull();
			s.state.entries.push(user("new", "om", "index while disabled")); s.state.leaf = "new";
			await handlers.get("agent_end")!({}, ctx);
			expect(mem.statusLine(ctx)).toContain(`indexed_entries=${s.state.entries.length}`);
			await prompt(); expect(answers).toBe(2);

			// Extension conflict ("paused"): no retrieval call, and one in flight from before is aborted when the conflict is detected.
			await cmd("on");
			hang = true;
			await prompt();
			expect([answers, signal.aborted]).toEqual([3, false]);
			(pi as Any).getAllTools = () => [{ name: "context_prune", sourceInfo: { path: "/ext/context-prune/index.ts" } }];
			const before = calls;
			await prompt();
			expect(signal.aborted).toBe(true);
			expect(calls).toBe(before);
			finish(reply(ANSWER));
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			start.mockRestore(); ledger.mockRestore(); rmSync(s.dir, { recursive: true, force: true });
		}
	});

	test("nothing is searched while the branch has no compaction and no fold: no model call at all", async () => {
		const clean = await run([PLAN, ANSWER], { messageType: "user", prompt: PROMPT }, {}, fixtureEntries().slice(0, 3));
		expect([clean.sent.length, clean.note]).toEqual([0, null]);
		expect(clean.retrieval.skip).toBe("nothing hidden yet");
		const compacted = await run([PLAN, ANSWER]);
		expect(compacted.sent.length).toBe(2);
	});

	test("retrieval runs on the judge's model setting; a name that is not available runs nothing", async () => {
		process.env.PI_ZIP_JUDGE_MODEL = "p/cheap";
		expect((await run([PLAN, ANSWER])).sent.length).toBe(2);
		process.env.PI_ZIP_JUDGE_MODEL = "other/model";
		expect((await run([PLAN, ANSWER])).sent.length).toBe(0);
		delete process.env.PI_ZIP_JUDGE_MODEL;
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

	test("a late note is appended at the next model boundary, after everything the run already sent", async () => {
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
		expect(out2.messages.slice(0, 5)).toEqual(later); // what the run already sent keeps its place: one cacheable prefix
		expect(out2.messages[5].content[0].text).toBe(note.text); // appended after the tool call and its result
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
