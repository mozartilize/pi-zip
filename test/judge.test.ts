import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BoundaryIndex, Judge, judgeInput, candidateCausalTrace, supersededOutputs, parseFacts, parseEvidence, parseVerdict, judgeModelRef, judgeReasoning, hintText, requestOpen, locatorOf, citesWork, latestUserText, JUDGE_SYSTEM, NEED_CUSTOM, CATALOGUE_TOKENS, type EvidenceSpan } from "../src/judge.ts";
import { buildBlocks, countUserTurns, toolCallIndex, UNIT, type PlanOpts } from "../src/plan.ts";
import { foldCandidates, foldPlaceholder } from "../src/fold-policy.ts";
import { plan, planContext } from "../src/plan-fork.ts";
import { checkEdits, decideEdits } from "../src/core.ts";
import { handleFor, PH_MARK } from "../src/placeholder.ts";
import { resolveHandlesInBranch } from "../src/recall-extended.ts";
import { cardText } from "../src/ui.ts";
import { Zip } from "../src/run.ts";
import { lawPrices } from "../src/learn.ts";
import { A, R, U, fakeCtx, fakePi, longTurn, project, startZip, type Any } from "./helpers.ts";
import { tok4 } from "../src/util.ts";

const saved = { ...process.env };
beforeEach(() => { process.env.PI_ZIP_JUDGE = "1"; delete process.env.PI_ZIP_JUDGE_MODEL; delete process.env.PI_ZIP_JUDGE_AGE; });
afterEach(() => {
	for (const key of ["PI_ZIP_JUDGE", "PI_ZIP_JUDGE_MODEL", "PI_ZIP_JUDGE_AGE"]) {
		if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
	}
});
const h = (i: number) => handleFor(`r${i}`);
// Policy codes express mock intent; production receives independent Y/N/U facts.
const factLine = (h: string, code: string) => `${h} ${{ H: "Y N N", C: "N Y N", N: "Y N Y", U: "U U U" }[code]}`;
const textReply = (text = "zzzzzzzzzz U -") => ({ stopReason: "stop", content: [{ type: "text", text: text.replace(/^([0-9a-z]{10}) ([CHNU]) (\S+)$/gm, (_, h, code) => factLine(h, code)) }], usage: { input: 100, output: 20, cost: { total: 0.002 } } });
const model = { provider: "p", id: "cheap", contextWindow: 200_000, maxTokens: 4096, cost: { input: 1 } };
const deferred = () => {
	let resolve!: (v: Any) => void;
	const promise = new Promise<Any>((r) => { resolve = r; });
	return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(complete: Any = async () => textReply(), timeout = 30_000) {
	const records: Any[] = [], calls: Any[] = [];
	const judge = new Judge((r) => records.push(r), timeout);
	const ctx = { model, modelRegistry: { getAvailable: () => [model], complete: (...args: Any[]) => { calls.push(args); return complete(...args); } } };
	const blocks = buildBlocks(longTurn(24));
	const run = (req = 24, bs = blocks, context = 40_000, opts: Partial<PlanOpts> = {}) => judge.maybeRun(ctx, bs, toolCallIndex(bs), "task", req, context, 40_000, { cwd: "/tmp", inturnAge: 10, keepLines: 0, ...opts });
	judge.startRun();
	return { judge, records, calls, ctx, blocks, run };
}

function plannerOpts(entries: Any[], over: Partial<PlanOpts> = {}): PlanOpts {
	const size = buildBlocks(entries).reduce((n, b) => n + b.tokens, 0);
	return { cwd: "/tmp", scale: UNIT, coldCap: size - 600, keepLines: 0, ...over };
}

describe("judge input and parser", () => {
	test("catalogue bytes stay stable as age and folded status change; includes thinking and arguments", () => {
		const first = longTurn(12), bs = buildBlocks(first);
		const a = judgeInput(bs, toolCallIndex(bs), "original task", 6000, undefined, 12);
		const more = [...first, A("new", ["new-call"], true)];
		const folded = project(more, [{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip]" }] } }]);
		const next = buildBlocks(folded);
		const b = judgeInput(next, toolCallIndex(next), "original task", 6000, a.catalogue, 13);
		expect(b.prefix).toBe(a.prefix);
		expect(b.text).toContain(`${h(1)} age=13 folded turn=1/1`);
		expect(b.text).toContain("assistant: x\ncall bash ls\nhmm");
		expect(b.text).not.toContain('"type":');
		const appended = buildBlocks(longTurn(14));
		const c = judgeInput(appended, toolCallIndex(appended), "original task", 6000, b.catalogue, 14);
		expect(c.prefix.startsWith(b.prefix)).toBe(true);
		expect(c.catalogue.size).toBe(14);
	});

	test("per-candidate local causal trace records turn ratio, caller intent, turnEdits, and closing milestone", () => {
		const entries = [
			U("u1", "fix parser"),
			{
				sourceEntry: { id: "a1", type: "message", message: {} },
				messages: [{
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "thinking", thinking: "Inspecting parser token table before editing" },
						{ type: "toolCall", id: "c-r1", name: "read", arguments: { path: "src/parser.ts" } },
					],
				}],
			},
			R("r1", "c-r1", 20, "parser source"),
			{
				sourceEntry: { id: "a2", type: "message", message: {} },
				messages: [{
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "c-e1", name: "edit", arguments: { path: "src/parser.ts" } }],
				}],
			},
			R("e1", "c-e1", 20, "edited parser"),
			{
				sourceEntry: { id: "a3", type: "message", message: {} },
				messages: [{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Fixed parser token table and verified all tests." }],
				}],
			},
			U("u2", "now check lexer"),
			{
				sourceEntry: { id: "a4", type: "message", message: {} },
				messages: [{
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "text", text: "Reading lexer implementation" },
						{ type: "toolCall", id: "c-r2", name: "read", arguments: { path: "src/lexer.ts" } },
					],
				}],
			},
			R("r2", "c-r2", 20, "lexer source"),
		];
		const blocks = buildBlocks(entries);
		const input = judgeInput(blocks, toolCallIndex(blocks), "fix parser", 6000, undefined, 10, "/app");
		const stateSection = input.text.split("\nCurrent state:\n")[1].split("\nLatest request:")[0];
		expect(stateSection).toContain(`${handleFor("r1")} age=`);
		expect(stateSection).toContain(`turn=1/2 why="Inspecting parser token table before editing" turnEdits=src/parser.ts closed=1/2 ("Fixed parser token table and verified all tests.")`);
		expect(stateSection).toContain(`${handleFor("r2")} age=`);
		expect(stateSection).toContain(`turn=2/2 why="Reading lexer implementation" closed=open`);
	});

	test("thousands of outputs fit a hard catalogue budget, prioritizing citations and folded originals", () => {
		const entries = longTurn(2500, { chars: 800 });
		entries.push(U("lookup", `check ${h(1)}`));
		const folded = project(entries, [{ type: "context_edit", targetId: "r2", replacement: { content: [{ type: "text", text: "[folded by pi-zip]" }] } }]);
		const blocks = buildBlocks(folded);
		const input = judgeInput(blocks, toolCallIndex(blocks), "task", 6000, undefined, 2500);
		const catalogue = input.prefix.split("Catalogue:\n")[1];
		const state = input.text.split("Current state:\n")[1].split("\nLatest request:")[0];
		expect(tok4(catalogue + state)).toBeLessThanOrEqual(CATALOGUE_TOKENS);
		expect(input.manifest.size).toBeLessThan(2500);
		for (const handle of [h(1), h(2), h(2500)]) expect(input.manifest.has(handle)).toBe(true);
		const next = judgeInput([], new Map(), "task", 6000, input.catalogue, 2501);
		expect(next.catalogue.size).toBe(0);
		expect(next.text).not.toContain("unavailable");
	});

	test("lines only: a repeated handle is unknown, a live N is hot, a cited folded N is need", () => {
		const ev: EvidenceSpan[] = [{ id: "E1", role: "user", locators: ["/tmp/proj/a.ts"], handles: ["aaaaaaaaaa"] }];
		const known = new Set(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
		const meta = new Map([
			["aaaaaaaaaa", { folded: true, locator: "/tmp/proj/a.ts" }],
			["bbbbbbbbbb", { folded: false, locator: "/tmp/proj/a.ts" }],
			["cccccccccc", { folded: true, locator: "/tmp/other/a.ts" }],
		]);
		const parsed = parseVerdict("aaaaaaaaaa N E1\nbbbbbbbbbb N E1\ncccccccccc N E1\naaaaaaaaaa C E1", known, ev, meta);
		expect(parsed.verdicts.get("aaaaaaaaaa")).toBe("warm");
		expect(parsed.nOk.get("aaaaaaaaaa")).toBe(false);
		expect(parsed.verdicts.get("bbbbbbbbbb")).toBe("hot");
		expect(parsed.verdicts.get("cccccccccc")).toBe("warm");
		const one = parseVerdict("aaaaaaaaaa N E1", known, ev, meta);
		expect(one.verdicts.get("aaaaaaaaaa")).toBe("need");
		expect(one.nOk.get("aaaaaaaaaa")).toBe(true);
		expect(one.verdicts.get("bbbbbbbbbb")).toBe("warm");
		expect(locatorOf({ path: "a.ts" }, "/tmp")).toBeNull();
		expect(locatorOf({ path: "proj/a.ts" }, "/tmp")).toBe("/tmp/proj/a.ts");
		for (const input of ["", "oops", "{}", "[]", '{"cold":[]}']) expect(() => parseVerdict(input, known, ev, meta)).toThrow();
	});

	test("diag: raw letters before validation and why each N did not become need", () => {
		const ev: EvidenceSpan[] = [{ id: "E1", role: "user", locators: [], handles: ["aaaaaaaaaa"] }, { id: "E2", role: "toolResult", locators: [], handles: [] }];
		const known = new Set(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd", "eeeeeeeeee", "ffffffffff"]);
		const meta = new Map([...known].map((x) => [x, { folded: x !== "bbbbbbbbbb", locator: null }]));
		const reply = ["aaaaaaaaaa N E1", "bbbbbbbbbb N E1", "cccccccccc N E2", "dddddddddd N E9", "eeeeeeeeee C E1", "eeeeeeeeee H E1", "zzzzzzzzzz U -", "no idea"].join("\n");
		const d = parseVerdict(reply, known, ev, meta).diag;
		expect(d).toMatchObject({ lines: 8, malformed: 1, foreign: 1, raw: { C: 1, H: 1, N: 4, U: 0 }, missing: 1, duplicate: 1, badEvidence: 1 });
		expect(d.n).toEqual([
			{ handle: "aaaaaaaaaa", ev: "E1", result: "need" },
			{ handle: "bbbbbbbbbb", ev: "E1", result: "live" },
			{ handle: "cccccccccc", ev: "E2", result: "toolEvidence" },
			{ handle: "dddddddddd", ev: "E9", result: "badEvidence" },
		]);
		const uncited = parseVerdict("cccccccccc N E1", known, ev, meta).diag.n;
		expect(uncited).toEqual([{ handle: "cccccccccc", ev: "E1", result: "uncited" }]);
	});
});

const toolCall = (id: string, name: string, args: Any) => {
	const m = { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id, name, arguments: args }] };
	return { sourceEntry: { id: `a-${id}`, type: "message", message: m }, messages: [m] };
};
const toolResult = (id: string, name: string, text = "y".repeat(3000), isError = false) => {
	const m = { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] };
	return { sourceEntry: { id: `r-${id}`, type: "message", message: m }, messages: [m] };
};
const round = (id: string, name: string, args: Any, isError = false) => [toolCall(id, name, args), toolResult(id, name, undefined, isError)];

describe("evidence rows and supersession", () => {
	test("assistant rows show visible prose and calls before thinking without signatures, and tool rows keep head+tail outcome digests", () => {
		const m = { role: "assistant", content: [{ type: "thinking", thinking: "plan-head " + "p".repeat(3000), thinkingSignature: "S".repeat(20_000) },
			{ type: "text", text: "done" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/w/a.ts" } }] };
		const bs = buildBlocks([U("u1", "task"), { sourceEntry: { id: "a1", type: "message", message: m }, messages: [m] }]);
		const wide = judgeInput(bs, toolCallIndex(bs), "task", 6000, undefined, 1).text;
		expect(wide).toContain("E2 assistant: done\ncall read /w/a.ts");
		expect(wide).not.toContain("SSSSSSSSSS");
		expect(wide).not.toContain("thinkingSignature");
		const row = wide.split("E2 ")[1];
		expect(row.length).toBeLessThanOrEqual("assistant: ".length + 1000);
		const narrow = judgeInput(bs, toolCallIndex(bs), "task", 50, undefined, 1).text;
		expect(narrow.split("Recent work:\n")[1]).toContain("assistant: done\ncall read /w/a.ts");
		const short = { role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/w/a.ts" } }] };
		const sb = buildBlocks([U("u1", "task"), { sourceEntry: { id: "a1", type: "message", message: short }, messages: [short] }]);
		expect(judgeInput(sb, toolCallIndex(sb), "task", 6000, undefined, 1).text).toContain("E2 assistant: done\ncall read /w/a.ts");
		// Long bash toolResult keeps both opening context and tail error/exit outcome beyond byte 1200.
		const longBash = "HEADER_START\n" + "middle line\n".repeat(150) + "AssertionError: expected 200 to equal 403\nCommand exited with code 1";
		const tb = buildBlocks([U("u1", "task"), toolCall("c9", "bash", { command: "bun test" }), toolResult("c9", "bash", longBash, true)]);
		const trText = judgeInput(tb, toolCallIndex(tb), "task", 6000, undefined, 1).text;
		expect(trText).toContain("toolResult: [exit 1]");
		expect(trText).toContain("HEADER_START");
		expect(trText).toContain("AssertionError: expected 200 to equal 403");
		// Older identical tool outputs in Recent work collapse to a short repeated digest while keeping the newest full digest.
		const dup = buildBlocks([
			U("u1", "task"),
			toolCall("c1", "bash", { command: "bun test" }), toolResult("c1", "bash", longBash, true),
			toolCall("c2", "bash", { command: "bun test" }), toolResult("c2", "bash", longBash, true),
		]);
		const dupText = judgeInput(dup, toolCallIndex(dup), "task", 6000, undefined, 2).text;
		expect(dupText).toContain("repeated head+tail");
	});

	test("exact repeats and successful writes supersede; failures, other ranges and recall do not", () => {
		const entries = [U("u1", "go"),
			...round("c1", "read", { path: "/w/a.ts" }),
			...round("c2", "read", { path: "/w/a.ts", offset: 50 }),
			...round("c3", "bash", { command: "npm test" }),
			...round("c4", "edit", { path: "/w/a.ts", oldText: "a", newText: "b" }, true),
			...round("c5", "bash", { command: "npm test" }),
			...round("c6", "edit", { path: "/w/a.ts", oldText: "a", newText: "b" }),
			...round("c7", "read", { path: "/w/b.ts" }),
			...round("c8", "read", { path: "/w/b.ts" }, true),
			...round("c9", "zip_recall", { handle: "x" }),
			...round("c10", "zip_recall", { handle: "x" }),
			...round("c11", "grep", { pattern: "x", path: "/w" }),
			...round("c12", "grep", { path: "/w", pattern: "x" }),
			...round("c13", "bash", { command: "npm test -- a" }),
			A("end")];
		const bs = buildBlocks(entries), r = (id: string) => handleFor(`r-${id}`);
		const got = supersededOutputs(bs, toolCallIndex(bs), "/w");
		expect(Object.fromEntries(got)).toEqual({ [r("c3")]: r("c5"), [r("c1")]: r("c6"), [r("c2")]: r("c6"), [r("c4")]: r("c6"), [r("c11")]: r("c12") });
	});

	test("superseded outputs are cold below every gate, never sent, and a late model reply cannot replace them", async () => {
		const reply = deferred();
		const r = rig(() => reply.promise);
		r.run(); await flush();
		expect(r.calls).toHaveLength(1);
		const sent = r.calls[0][1].messages[0].content[0].text;
		expect(sent).toContain(`"handle":"${h(1)}"`);
		// While that call runs, the first command runs again: its older output is now superseded.
		const again = [...longTurn(24), A("a99", ["c99"]), R("r99", "c99", 0, "z".repeat(3000))];
		((again.at(-2) as Any).messages[0].content[1]).arguments = { command: "ls d1" };
		const bs = buildBlocks(again);
		r.run(25, bs, 1000);
		const scope = latestUserText(bs);
		expect(r.judge.labels(25, scope)?.get(h(1))).toBe("cold");
		reply.resolve(textReply(`${h(1)} H E1\n${h(2)} H E1`));
		await r.judge.running;
		expect(r.judge.labels(25, scope)?.get(h(1))).toBe("cold");
		expect(r.judge.labels(25, scope)?.get(h(2))).toBe("hot");
		// A later batch never submits it.
		r.run(40, bs, 40_000, { inturnAge: 10 }); await r.judge.running;
		for (const call of r.calls.slice(1)) expect(call[1].messages[0].content[0].text).not.toContain(`"handle":"${h(1)}"`);
		// Without the repeat (pruned), the rule no longer holds and the fixed label goes.
		r.run(41, r.blocks, 1000);
		expect(r.judge.verdicts.get(h(1))?.fixed).toBeFalsy();
	});

	test("BoundaryIndex matches full supersededOutputs across append, rewind, prefix-cut, fold, error and cwd traces", () => {
		let seed = 0x5eed1234;
		const rand = (n: number) => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
			return ((t ^ (t >>> 14)) >>> 0) % n;
		};
		const idx = new BoundaryIndex(), r = rig();
		const tools = ["read", "edit", "write", "grep", "bash", "zip_recall"] as const;
		const paths = ["/w/src/a.ts", "./src/a.ts", "/w/src/b.ts", "./src/b.ts", "/w/src/c.ts"] as const;
		let rounds: Any[][] = [[U("u0", "trace")]], cwd = "/w", nextId = 1;
		for (let step = 0; step < 120; step++) {
			const op = rand(10);
			if (op < 6 || rounds.length <= 2) {
				const id = `t${nextId++}`, tool = tools[rand(tools.length)], p = paths[rand(paths.length)];
				const flipKeys = rand(2) === 1, off = rand(3) * 20, isErr = rand(4) === 0;
				const args = tool === "bash" ? { command: `test ${off}` }
					: tool === "zip_recall" ? { handle: "aaaaaaaaaa" }
					: flipKeys ? { offset: off, path: p } : { path: p, offset: off };
				const pair = round(id, tool, args, isErr);
				rounds.push(pair);
			} else if (op === 6 && rounds.length > 3) {
				rounds = rounds.slice(0, rounds.length - (1 + rand(Math.min(4, rounds.length - 2))));
			} else if (op === 7 && rounds.length > 4) {
				rounds = [rounds[0], ...rounds.slice(2 + rand(2))];
			} else if (op === 8) {
				cwd = cwd === "/w" ? "/w/sub" : "/w";
			}
			const bs = buildBlocks(rounds.flat());
			if (op === 9 && bs.length > 2) {
				const tr = bs.filter((b) => b.kind === "toolResult");
				if (tr.length) {
					const target = tr[rand(tr.length)];
					target.edited = !target.edited;
					if (rand(2) === 1) target.ours = target.edited;
				}
			}
			const calls = toolCallIndex(bs);
			idx.sync(bs, calls, cwd);
			r.run(step + 1, bs, 1000, { cwd });
			const oracle = Object.fromEntries(supersededOutputs(bs, calls, cwd));
			expect(Object.fromEntries(idx.superseded)).toEqual(oracle);
			const fixed = Object.fromEntries([...r.judge.verdicts].filter(([, v]) => v.fixed).map(([k, v]) => [k, v.v]));
			expect(fixed).toEqual(Object.fromEntries(Object.keys(oracle).map((k) => [k, "cold"])));
		}
	});

	test("incremental append boundaries preserve fixed verdicts across prefix fold, reference shifts, scope changes and >20-req TTL", async () => {
		const r = rig(async () => textReply(`${h(1)} C E1\n${h(2)} H E1\n${h(3)} H E1\n${h(4)} H E1`));
		// Round 4 reads a file with a path locator; round 25 repeats round 1 ("ls d1"), superseding h(1).
		const entries = [...longTurn(24), A("a25", ["c25"]), R("r25", "c25", 0, "z".repeat(3000))];
		((entries[7] as Any).messages[0].content[1]).name = "read";
		((entries[7] as Any).messages[0].content[1]).arguments = { path: "/w/src/target.ts" };
		((entries.at(-2) as Any).messages[0].content[1]).arguments = { command: "ls d1" };
		let bs = buildBlocks(entries);
		r.run(25, bs, 40_000, { inturnAge: 10 }); await r.judge.running;
		expect(r.judge.verdicts.get(h(1))?.fixed).toBe(true);
		expect(r.judge.verdicts.get(h(2))?.v).toBe("hot");
		expect(r.judge.verdicts.get(h(3))?.v).toBe("hot");
		expect(r.judge.verdicts.get(h(4))?.v).toBe("hot");

		// 1. In-place prefix fold on an append boundary: h(1) is folded (edited flips, ours stays false) and h(2) is folded.
		// h(2)'s live verdict must invalidate, while h(1)'s fixed cold verdict must survive its own invalidation.
		entries.push(A("a26", ["c26"]), R("r26", "c26", 0, "z".repeat(3000)));
		bs = buildBlocks(entries);
		bs.find((b) => b.entryId === "r1")!.edited = true;
		bs.find((b) => b.entryId === "r2")!.edited = true;
		r.run(26, bs, 1000);
		expect(r.judge.verdicts.get(h(2))).toBeUndefined();
		expect(r.judge.verdicts.get(h(1))).toMatchObject({ v: "cold", fixed: true });

		// 2. Tail prose cites unchanged prefix handle h(3), locator of h(4), and superseded handle h(1) on an append boundary:
		// h(3) and h(4) live verdicts must invalidate; h(1)'s fixed cold verdict must still hold.
		entries.push(A("a27", []));
		(entries.at(-1) as Any).messages[0].content = [{ type: "text", text: `Inspect ${h(3)}, /w/src/target.ts and ${h(1)}` }];
		bs = buildBlocks(entries);
		bs.find((b) => b.entryId === "r1")!.edited = true;
		bs.find((b) => b.entryId === "r2")!.edited = true;
		r.run(27, bs, 1000);
		expect(r.judge.verdicts.get(h(3))).toBeUndefined();
		expect(r.judge.verdicts.get(h(4))).toBeUndefined();
		expect(r.judge.verdicts.get(h(1))).toMatchObject({ v: "cold", fixed: true });

		// 3. Advancing >20 requests without new superseding calls must not expire fixed cold verdicts in labels() or stale().
		r.run(60, bs, 1000);
		expect(r.judge.labels(60, latestUserText(bs))?.get(h(1))).toBe("cold");

		// 4. Appending a new user turn (scopeChanged on an append boundary) clears model verdicts but restores fixed supersession verdicts.
		entries.push(U("u2", "next task"));
		bs = buildBlocks(entries);
		bs.find((b) => b.entryId === "r1")!.edited = true;
		bs.find((b) => b.entryId === "r2")!.edited = true;
		r.run(61, bs, 1000);
		expect(r.judge.labels(61, "next task")?.get(h(1))).toBe("cold");

		// 5. citesWork shares workReferences' 24K window: folded placeholders do not push a user citation out, and assistant recall echoes do not count.
		const foldedTail = Array.from({ length: 25 }, (_, i) => [A(`af${i}`, [`cf${i}`]), R(`rf${i}`, `cf${i}`, 1500)]).flat();
		const foldedProj = project(
			[U("u1", `inspect ${h(1)} in /w/src/target.ts`), ...foldedTail],
			foldedTail.filter((e) => e.sourceEntry.message.role === "toolResult").map((e) => ({
				type: "context_edit",
				targetId: e.sourceEntry.id,
				replacement: { content: [{ type: "text", text: `${PH_MARK} · bash · 150 lines] ${handleFor(e.sourceEntry.id)}\n` + "k".repeat(1100) }] },
			})),
		);
		expect(citesWork(buildBlocks(foldedProj), h(1), "/w/src/target.ts", "/w")).toBe(true);
		const recallEcho = buildBlocks([
			U("u1", "continue"),
			{ sourceEntry: { id: "aRec", type: "message", message: { role: "assistant", content: [{ type: "text", text: `recalling ${h(1)} from /w/src/target.ts` }, { type: "toolCall", id: "cRec", name: "zip_recall", arguments: { handle: h(1) } }] } },
				messages: [{ role: "assistant", content: [{ type: "text", text: `recalling ${h(1)} from /w/src/target.ts` }, { type: "toolCall", id: "cRec", name: "zip_recall", arguments: { handle: h(1) } }] }] },
		]);
		expect(citesWork(recallEcho, h(1), "/w/src/target.ts", "/w")).toBe(false);
	});
});

describe("fact classification", () => {
	const a = "aaaaaaaaaa", b = "bbbbbbbbbb", c = "cccccccccc";
	const known = new Set([a]);
	const meta = new Map([[a, { folded: true, locator: "/w/a.ts" }]]);
	const referenced: EvidenceSpan[] = [{ id: "E7", role: "user", handles: [a], locators: [] }];

	test("all 27 three-fact combinations prioritize demand over finished and require negative dependency for cold", () => {
		// Columns: lookup N, U, Y. Rows: active/finished.
		// Lookup takes precedence when cited; active protects even when finished=Y; cold requires N Y N.
		const table = [
			["N N", ["warm", "warm", "need"]], ["N U", ["warm", "warm", "need"]], ["N Y", ["cold", "warm", "need"]],
			["U N", ["warm", "warm", "need"]], ["U U", ["warm", "warm", "need"]], ["U Y", ["warm", "warm", "need"]],
			["Y N", ["hot", "hot", "need"]], ["Y U", ["hot", "hot", "need"]], ["Y Y", ["hot", "hot", "need"]],
		] as const;
		for (const [answers, expected] of table) for (const [i, lookup] of ["N", "U", "Y"].entries()) {
			const parsed = parseFacts(`${a} ${answers} ${lookup}`, known, referenced, meta);
			expect(parsed.verdicts.get(a)).toBe(expected[i]);
			expect(parsed.nOk.get(a)).toBe(expected[i] === "need");
			// The triple survives the collapse: every combination, including a decisive row that still holds a U.
			const triple = answers.replace(" ", "") + lookup;
			expect(parsed.diag.facts).toEqual({ [triple]: 1 });
			expect(parsed.abstained).toBe(triple.includes("U") ? 1 : 0);
		}
		// Classification needs no citation; an uncited lookup does not erase active=Y.
		expect(parseFacts(`${a} N Y N`, known, [], meta).verdicts.get(a)).toBe("cold");
		expect(parseFacts(`${a} Y Y N`, known, [], meta).verdicts.get(a)).toBe("hot");
		expect(parseFacts(`${a} Y Y Y`, known, [], meta).verdicts.get(a)).toBe("hot");
		expect(parseFacts(`${a} N Y Y`, known, [], meta).verdicts.get(a)).toBe("warm");
	});

	test("lookup requires an exact non-tool reference; live outputs are hot, never recalled", () => {
		for (const evidence of [[], [{ id: "E1", role: "toolResult", handles: [a], locators: ["/w/a.ts"] }],
			[{ id: "E1", role: "assistant", handles: [b], locators: ["/other/a.ts"] }]] as EvidenceSpan[][]) {
			const parsed = parseFacts(`${a} N N Y`, known, evidence, meta);
			expect(parsed.verdicts.get(a)).toBe("warm"); expect(parsed.nOk.get(a)).toBe(false);
			expect(parsed.diag.badEvidence).toBe(1);
		}
		for (const evidence of [referenced, [{ id: "E2", role: "assistant", handles: [], locators: ["/w/a.ts"] }]] as EvidenceSpan[][]) {
			expect(parseFacts(`${a} U Y Y`, known, evidence, meta).verdicts.get(a)).toBe("need");
			const live = parseFacts(`${a} U Y Y`, known, evidence, new Map([[a, { folded: false, locator: "/w/a.ts" }]]));
			expect(live.verdicts.get(a)).toBe("hot"); expect(live.nOk.get(a)).toBe(false);
		}
	});

	test("facts keep the triples the policy code collapses, and only for rows the guards accepted", () => {
		const decisive = parseFacts(`${a} N N N`, known, referenced, meta);
		expect(decisive.diag.raw).toEqual({ C: 0, H: 0, N: 0, U: 1 }); // NNN is a policy U, but every fact was settled
		expect(decisive.diag.facts).toEqual({ NNN: 1 });
		expect(decisive.abstained).toBe(0);

		const partial = parseFacts(`${a} U Y N\n${b} Y Y N\n${c} Y Y N`, new Set([a, b, c]), referenced, meta);
		expect(partial.diag.facts).toEqual({ UYN: 1, YYN: 2 }); // repeats accumulate
		expect(partial.abstained).toBe(1);

		const broken = parseFacts(`${a} U U U\n${b} N Y ?`, new Set([a, b, c]), referenced, meta); // c missing, b malformed
		expect(broken.diag).toMatchObject({ malformed: 1, missing: 1, facts: { UUU: 1 } });
		// Decisive verdicts whose U sits outside the deciding fact: hot with an unknown finished, and with an unknown lookup.
		for (const triple of ["Y U N", "Y N U"]) {
			const hot = parseFacts(`${a} ${triple}`, known, [], meta);
			expect(hot.verdicts.get(a)).toBe("hot");
			expect(hot.abstained).toBe(1);
		}
	});

	test("missing, duplicate and malformed answers cannot acquire a cold label; old protocols are rejected", () => {
		const all = new Set([a, b, c]);
		for (const duplicate of [`${a} N Y N`, `${a} Y N N`, `${a} N maybe N`]) {
			const parsed = parseFacts(`${a} N Y N\n${duplicate}\n${b} Y N N\nzzzzzzzzzz N Y N`, all, [], meta);
			expect([...parsed.verdicts.values()]).toEqual(["warm", "hot", "warm"]);
			expect(parsed.diag).toMatchObject({ duplicate: 1, missing: 1, foreign: 1 });
			expect(parsed.diag.facts).toEqual({ YNN: 1 }); // the duplicated handle and the foreign line are not counted
		}
		expect(parseFacts(`${a} N Y ?\n${b} U U U`, all, [], meta).diag).toMatchObject({ malformed: 1, facts: { UUU: 1 } });
		for (const reply of ["", `${a} C E1`, `${a} - E1 -`, `${a} N N Y N N`, `${a} yes no no`, `[{"handle":"${a}"}]`]) {
			expect(() => parseFacts(reply, known, referenced, meta)).toThrow();
		}
	});

	test("production sends facts-v1 and protects completed but still needed results", async () => {
		const r = rig(async () => textReply(`${h(1)} N Y N\n${h(2)} Y U N`)); // h(2) is decisive but not fully attributable
		r.run(); await r.judge.running;
		expect(r.calls[0][1].systemPrompt).toBe(JUDGE_SYSTEM);
		expect(r.judge.verdicts.get(h(1))?.v).toBe("cold");
		expect(r.judge.verdicts.get(h(2))?.v).toBe("hot");
		expect(r.records.find((x) => x.type === "judge")).toMatchObject({ protocol: "facts-v1", counts: { cold: 1, hot: 1, need: 0, unknown: 1 }, diag: { raw: { C: 1, H: 1, N: 0, U: 0 }, facts: { NYN: 1, YUN: 1 } } });
		expect(r.judge.stats.unknown).toBe(1);
		// per handle: the triple ties each verdict to its output; a handle the reply skipped shows "-" and stays warm
		const rows = r.records.find((x) => x.type === "judge").verdicts as Any[];
		expect(rows.find((x) => x.h === h(1))).toMatchObject({ f: "NYN", v: "cold", folded: false });
		expect(rows.find((x) => x.h === h(2))).toMatchObject({ f: "YUN", v: "hot" });
		expect(rows.find((x) => x.h === h(1)).tool).toMatch(/^bash /);
		expect(rows.filter((x) => x.h !== h(1) && x.h !== h(2)).every((x) => x.f === "-" && x.v === "warm")).toBe(true);
	});
});

describe("historical evidence assertions", () => {
	const known = new Set([h(1), h(2)]);
	const evidence: EvidenceSpan[] = [
		{ id: "E1", role: "user", locators: [], handles: [h(1)] },
		{ id: "E2", role: "assistant", locators: [], handles: [] },
		{ id: "E3", role: "toolResult", locators: [], handles: [] },
	];
	const meta = new Map([[h(1), { folded: true, locator: null }], [h(2), { folded: false, locator: null }]]);
	test("independent assertions, conflicts, invalid citations and lookup roles", () => {
		for (const [fields, expected] of [
			["E1 - -", "hot"], ["- E2 -", "cold"], ["- - E1", "need"], ["- - -", "warm"],
			["E1 E2 -", "warm"], ["- E2 E1", "warm"], ["E1 E99 -", "warm"],
			["- - E3", "warm"], ["- - E2", "warm"],
		]) expect(parseEvidence(`${h(1)} ${fields}`, known, evidence, meta).verdicts.get(h(1))).toBe(expected);
		expect(parseEvidence(`${h(1)} - - -\n${h(2)} - - E1`, known, evidence, meta).verdicts.get(h(2))).toBe("hot");
	});
	test("omissions equal abstentions; duplicate, foreign and old-protocol rows cannot supply a decision", () => {
		const omitted = parseEvidence(`${h(1)} - E2 -`, known, evidence, meta);
		const explicit = parseEvidence(`${h(1)} - E2 -\n${h(2)} - - -`, known, evidence, meta);
		expect([...omitted.verdicts]).toEqual([...explicit.verdicts]);
		expect(parseEvidence(`${h(1)} - E2 -\n${h(1)} E1 - -`, known, evidence, meta).verdicts.get(h(1))).toBe("warm");
		expect(parseEvidence("zzzzzzzzzz - E2 -", known, evidence, meta).diag.foreign).toBe(1);
		expect(() => parseEvidence(`${h(1)} C E2`, known, evidence, meta)).toThrow();
	});
});

describe("judge folds keep the existing decision", () => {
	test("mixed verdicts cannot spend the original plan's overshoot", () => {
		const entries = longTurn(72);
		for (const [id, chars] of [["r1", 140_000], ["r2", 84_000], ["r3", 44_000]] as const) {
			entries.find((e) => e.sourceEntry.id === id)!.messages[0].content = [{ type: "text", text: "x".repeat(chars) }];
		}
		const size = buildBlocks(entries).reduce((n, b) => n + b.tokens, 0);
		for (const c of [1, 2]) {
			const opts = plannerOpts(entries, { scale: { ...UNIT, O: 1000, c }, coldCap: 1000 + c * (size - 29_000) });
			const original = planContext(entries, opts)!;
			expect(original.folds.map((f) => f.entryId)).toEqual(["r1"]);
			const judged = planContext(entries, { ...opts, verdicts: new Map([[h(1), "hot"], [h(2), "cold"], [h(3), "cold"]]) })!;
			expect(judged.folds).toEqual(original.folds);
			expect(judged.ctxAfterFolds).toBe(original.ctxAfterFolds);
		}
	});
	test("cold at age 59 does not open an early fold; age 60 stays inside the normal rule", () => {
		const entries = longTurn(72), opts = plannerOpts(entries);
		const blocks = buildBlocks(entries);
		const old = blocks.find((b) => b.kind === "toolResult" && b.age === 60)!;
		const young = blocks.find((b) => b.kind === "toolResult" && b.age === 59)!;
		expect(plan(entries, { ...opts, verdicts: new Map() })).toEqual(plan(entries, { ...opts }));
		const verdicts = new Map([[handleFor(old.entryId!), "cold" as const], [handleFor(young.entryId!), "cold" as const]]);
		const p = planContext(entries, { ...opts, verdicts })!;
		expect(p.folds.some((f) => f.entryId === young.entryId)).toBe(false);
		expect(p.folds.some((f) => f.entryId === old.entryId)).toBe(true);
		expect(p.folds.every((f) => !f.trig.includes("(judge)"))).toBe(true);
		expect(checkEdits(p.blocks, p.userTurns, p.folds, null)).toBeNull();
		const branch = entries.map((e) => e.sourceEntry);
		expect(resolveHandlesInBranch(branch, [handleFor(old.entryId!)]).items[0].text).toBe(entries.find((e) => e.sourceEntry.id === old.entryId).messages[0].content[0].text);
		for (const extra of [{ recalled: new Set([handleFor(old.entryId!)]) }, { inturnAge: 0 }]) {
			const q = planContext(entries, { ...opts, verdicts, ...extra });
			expect(q?.folds.some((f) => f.entryId === old.entryId) ?? false).toBe(false);
		}
		expect(plan(entries, { ...opts, inturnAge: 0 })?.stuck).toBe(true);
	});

	test("an output below judgeAge stays; hot and need are last, not immune", () => {
		const entries = longTurn(72), opts = plannerOpts(entries);
		const old = buildBlocks(entries).filter((b) => b.kind === "toolResult" && b.age >= 60);
		const verdicts = new Map(old.map((b) => [handleFor(b.entryId!), "hot" as const]));
		verdicts.delete(h(12));
		const v = new Map<string, "cold" | "hot" | "need">([...verdicts, [h(64), "cold"], [h(1), "need"]]);
		const p = planContext(entries, { ...opts, verdicts: v })!;
		expect(p.folds[0].entryId).toBe("r12");
		expect(p.folds.some((f) => f.entryId === "r64")).toBe(false); // age 9
		const all = planContext(entries, { ...opts, coldCap: 4000, verdicts: v })!;
		expect(all.folds.at(-1)!.entryId).toBe("r1");
		expect(all.folds.some((f) => v.get(handleFor(f.entryId)) === "hot")).toBe(true);
	});

	test("cold verdicts cannot start a rewrite, earn extra rent, or bypass b2b", () => {
		for (const rounds of [24, 72]) for (const rent of [0, 2000, 2_000_000]) for (const justEdited of [false, true]) {
			const entries = longTurn(rounds), opts = plannerOpts(entries);
			const verdicts = new Map(buildBlocks(entries).filter((b) => b.entryId).map((b) => [handleFor(b.entryId!), "cold" as const]));
			const decide = (judge: boolean) => decideEdits({ at: "turn_end", justEdited, pWarm: 1, entries, ready: [], opts: () => ({ o: { ...opts, rent,
				law: { pr: lawPrices("explicit", false), g: 2500, pWarm: 1 }, ...(judge ? { verdicts } : {}) } }) });
			const a = decide(false), b = decide(true);
			expect(!!b.p).toBe(!!a.p);
			expect(b.rentNext).toBe(a.rentNext);
			expect(b.produce).toEqual(a.produce);
			if (a.p && b.p) {
				const allow = new Set(a.p.folds.map((f) => f.entryId));
				expect(b.p.folds.every((f) => allow.has(f.entryId))).toBe(true);
				expect(b.p.ctxAfterFolds).toBeLessThanOrEqual(a.p.ctxAfterFolds);
			}
		}
	});

	test("fold diagnostics separate unscored, ineligible, guard-rejected, back-to-back and selected outputs", () => {
		const entries = longTurn(72), opts = plannerOpts(entries, { coldCap: 4000 });
		const run = (rent: number, justEdited = false) => decideEdits({
			at: "turn_end", justEdited, pWarm: 1, entries, ready: [],
			opts: () => ({ o: { ...opts, trace: [], rent, verdicts: new Map([[h(1), "cold"], [h(70), "cold"]]),
				law: { pr: lawPrices("explicit", false), g: 1_000_000_000, pWarm: 1 } } }),
		});
		const rejected = run(0);
		expect(rejected.p).toBeNull();
		expect(rejected.o.foldDecision!.reason).toBe("guard-rejected");
		expect(rejected.o.foldDecision!.outputs.find((x) => x.h === h(1))).toMatchObject({ verdict: "cold", group: 2, planned: true, selected: false });
		expect(rejected.o.foldDecision!.outputs.find((x) => x.h === h(70))).toMatchObject({ verdict: "cold", group: null, planned: false, selected: false });
		expect(rejected.o.foldDecision!.outputs.find((x) => x.h === h(2))!.verdict).toBe("unscored");
		const selected = run(1_000_000_000_000);
		expect(selected.o.foldDecision!.reason).toBe("selected");
		expect(selected.o.foldDecision!.outputs.find((x) => x.h === h(1))!.selected).toBe(true);
		const b2b = run(1_000_000_000_000, true);
		expect(b2b.o.foldDecision!.reason).toBe("back-to-back");
		expect(b2b.o.foldDecision!.outputs.every((x) => !x.selected)).toBe(true);
	});

	test("carried placeholders keep their bytes even when a verdict changes", () => {
		const entries = longTurn(72), opts = plannerOpts(entries);
		const before = planContext(entries, opts)!;
		const after = planContext(entries, { ...opts, carriedFolds: before.folds, verdicts: new Map(before.folds.map((f) => [handleFor(f.entryId), "need" as const])) })!;
		expect(after.folds).toEqual(before.folds);
	});
});

describe("incremental judge selection", () => {
	test("default protected outputs generate no call; age 60 and size boundaries use planner candidates", async () => {
		const r = rig();
		r.run(24, r.blocks, 40_000, { inturnAge: 60 });
		expect(r.calls).toHaveLength(0);
		const blocks = buildBlocks(longTurn(72));
		const opts = { cwd: "/tmp", keepLines: 0 };
		const candidates = foldCandidates(blocks, toolCallIndex(blocks), opts).flat();
		expect(candidates.map((b) => b.age)).toEqual(Array.from({ length: 13 }, (_, i) => 72 - i));
		// rig's default is intentionally age 10; override it to test the production default explicitly.
		const prod = rig(); prod.run(72, blocks, 40_000, { inturnAge: 60 }); await prod.judge.running;
		expect(prod.records[0].known).toBe(13);
		const text = prod.calls[0][1].messages[0].content[0].text;
		expect(text).toContain(`"handle":"${h(13)}"`);
		expect(text).not.toContain(`"handle":"${h(14)}"`);
	});
	test("candidate filtering preserves recent evidence and excludes recalled or non-saving outputs", async () => {
		const r = rig(), blocks = buildBlocks(longTurn(72));
		const small = blocks.find((b) => b.entryId === "r2")!;
		small.raw = small.msg = { ...small.msg, content: [{ type: "text", text: "x".repeat(2000) }] };
		const image = blocks.find((b) => b.entryId === "r3")!;
		image.msg = { ...image.msg, content: [...image.msg.content, { type: "image", data: "a", mimeType: "image/png" }] };
		image.raw = image.msg;
		const latest = blocks.at(-1)!;
		latest.msg = { ...latest.msg, content: [{ type: "text", text: "New evidence from an unselected recent output" }] };
		r.run(72, blocks, 40_000, { inturnAge: 60, recalled: new Set([h(1)]) }); await r.judge.running;
		const text = r.calls[0][1].messages[0].content[0].text;
		for (const n of [1, 2, 3, 72]) expect(text).not.toContain(`"handle":"${h(n)}"`);
		expect(text).toContain("New evidence from an unselected recent output");
		expect(foldPlaceholder(image, toolCallIndex(blocks), { cwd: "/tmp" })).toBeNull();
	});
	test("new batch updates only submitted handles and does not refresh retained timestamps", async () => {
		const r = rig(async () => textReply(`${h(1)} H E1`));
		r.run(); await r.judge.running;
		expect(r.judge.verdicts.get(h(1))?.atReq).toBe(24);
		r.run(32, buildBlocks(longTurn(32))); await r.judge.running;
		expect(r.calls).toHaveLength(2);
		const second = r.calls[1][1].messages[0].content[0].text;
		expect(second).not.toContain(`"handle":"${h(1)}"`);
		expect(second).toContain(`"handle":"${h(16)}"`);
		expect(r.records[1]).toMatchObject({ known: 8, reused: 15 });
		expect(r.judge.verdicts.get(h(1))).toMatchObject({ v: "hot", atReq: 24 });
		expect(r.judge.verdicts.get(h(16))).toMatchObject({ v: "warm", atReq: 32 });
		r.run(40, buildBlocks(longTurn(32))); await r.judge.running;
		expect(r.calls).toHaveLength(2); // neither catalogue size nor unchanged evidence starts a call
		expect(r.judge.labels(45, "do the long task")?.has(h(1))).toBe(false);
		expect(r.judge.labels(45, "do the long task")?.has(h(16))).toBe(true);
	});
	test("fresh references invalidate below pressure; a submitted omission replaces the old verdict", async () => {
		let n = 0;
		const r = rig(async () => textReply(n++ ? `${h(2)} U -` : `${h(1)} C E1`));
		r.run(); await r.judge.running;
		const entries = longTurn(24);
		entries.push(A("reference", []));
		entries.at(-1)!.messages[0].content = [{ type: "text", text: `Still need ${h(1)}` }];
		r.run(25, buildBlocks(entries), 1000);
		expect(r.judge.labels(25, "do the long task")?.has(h(1))).toBe(false);
		expect(r.calls).toHaveLength(1);
		r.run(45, buildBlocks(entries)); await r.judge.running;
		expect(r.judge.verdicts.get(h(1))).toMatchObject({ v: "warm", atReq: 45 });
	});
	test("scope changes during a call abort and reject its late reply even below pressure", async () => {
		const d = deferred(), r = rig(() => d.promise);
		r.run(); await flush();
		const entries = [...longTurn(24), U("steer", "new task")];
		r.run(25, buildBlocks(entries), 1000);
		expect(r.calls[0][2].signal.aborted).toBe(true);
		d.resolve(textReply(`${h(1)} C E1`)); await r.judge.running;
		expect(r.judge.verdicts.size).toBe(0);
		expect(r.judge.scope).toBe("new task");
	});
	test("a new explicit dependency during a call rejects that snapshot, not just changed user scopes", async () => {
		const d = deferred(), r = rig(() => d.promise);
		r.run(); await flush();
		const entries = longTurn(24);
		entries.push(A("dependency", []));
		entries.at(-1)!.messages[0].content = [{ type: "text", text: `Need ${h(1)} for the next step` }];
		r.run(25, buildBlocks(entries));
		expect(r.calls[0][2].signal.aborted).toBe(true);
		d.resolve(textReply(`${h(1)} C E1`)); await r.judge.running;
		expect(r.judge.verdicts.size).toBe(0);
		expect(r.judge.stats.errors).toBe(0); // invalidation is not a provider failure
	});
	test("live/folded transitions and pruning invalidate old judgments", async () => {
		const r = rig(async () => textReply(`${h(1)} C E1`));
		r.run(); await r.judge.running;
		const folded = buildBlocks(project(longTurn(24), [{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "folded" }] } }]));
		r.run(25, folded, 1000);
		expect(r.judge.verdicts.has(h(1))).toBe(false);
		r.run(26, [], 1000);
		expect(r.judge.verdicts.size).toBe(0);
		expect((r.judge as Any).catalogue.size).toBe(0);
	});
});

describe("background judge", () => {
	// The provider loses content on abort, so only consuming text events can retain these rows.
	function streamedRig(text: string, timeout = 30_000) {
		const r = rig(undefined, timeout), sent = deferred(), terminal = deferred();
		(r.ctx.modelRegistry as Any).streamSimple = () => ({
			async *[Symbol.asyncIterator]() {
				// Split within a handle and across row boundaries. Consume cumulative snapshots, not deltas twice.
				let cumulative = "";
				for (const part of [text.slice(0, 4), text.slice(4, 23), text.slice(23)]) {
					cumulative += part;
					yield { type: "text_delta", delta: part, partial: { content: [{ type: "text", text: cumulative }] } };
				}
				sent.resolve({});
				await terminal.promise;
			},
			result: () => terminal.promise,
		});
		return { ...r, sent: sent.promise, finish: (stopReason = "aborted") => terminal.resolve({ content: [], stopReason, usage: {} }) };
	}

	test("run end salvages complete current rows before abort; missing, malformed and duplicate rows retain previous verdicts", async () => {
		const r = streamedRig(`${h(1)} N Y N\n${h(2)} N Y N\n${h(3)} N Y\n${h(1)} N`);
		// stale previous judgments trigger re-evaluation but must survive omissions/invalid rows in an interrupted reply.
		for (const i of [1, 3, 4]) r.judge.verdicts.set(h(i), { v: "hot", atReq: 0, locator: null, nOk: false });
		r.run(); await r.sent;
		r.judge.stop("settle", true);
		expect(r.judge.verdicts.get(h(2))).toMatchObject({ v: "cold", atReq: 24 });
		for (const i of [1, 3, 4]) expect(r.judge.verdicts.get(h(i))).toMatchObject({ v: "hot", atReq: 0 });
		r.finish(); await r.judge.running;
		expect(r.records[0]).toMatchObject({ partial: true, applied: 1, resultDisposition: "partial-applied", cancelReason: "settle" });
		expect(r.records[0].verdicts.find((v: Any) => v.h === h(1))).toMatchObject({ f: "-", applied: false });
		expect(r.records[0].verdicts.find((v: Any) => v.h === h(2))).toMatchObject({ f: "NYN", v: "cold", applied: true });
	});

	test("timeout, error, and length retain newline-terminated facts, never the final unclosed row or fixed judgments", async () => {
		for (const reason of ["timeout", "error", "length"]) {
			const r = streamedRig(`${h(1)} N Y N\n${h(2)} Y N N\n${h(3)} N Y N`, reason === "timeout" ? 5 : 30_000);
			r.judge.verdicts.set(h(1), { v: "hot", atReq: 0, locator: null, nOk: false });
			r.run(); await r.sent;
			// An external fixed judgment must not be overwritten by the model's snapshot.
			r.judge.verdicts.set(h(1), { v: "hot", atReq: 24, locator: null, nOk: false, fixed: true });
			if (reason === "timeout") await new Promise((resolve) => setTimeout(resolve, 15));
			r.finish(reason === "timeout" ? "aborted" : reason); await r.judge.running;
			expect(r.judge.verdicts.get(h(1))?.v).toBe("hot");
			expect(r.judge.verdicts.get(h(2))?.v).toBe("hot");
			expect(r.judge.verdicts.has(h(3))).toBe(false); // complete-looking but no final newline
			expect(r.records[0]).toMatchObject({ partial: true, applied: 1, resultDisposition: "partial-applied" });
			expect(r.records[0].verdicts.find((v: Any) => v.h === h(1))).toMatchObject({ fixed: true, applied: false });
		}
	});

	test("scope, evidence and session invalidation log partial rows but never apply them", async () => {
		for (const reason of ["scope", "evidence", "session"]) {
			const r = streamedRig(`${h(1)} N Y N\n`);
			r.run(); await r.sent;
			if (reason === "session") r.judge.stop("session-changed");
			else {
				const entries = longTurn(24);
				if (reason === "scope") entries.push(U("steer", "a different task"));
				else {
					entries.push(A("dependency", []));
					entries.at(-1)!.messages[0].content = [{ type: "text", text: `Need ${h(1)} specifically now` }];
				}
				r.run(26, buildBlocks(entries), 0); // invalidation must work even below pressure
			}
			r.finish(); await r.judge.running;
			expect(r.judge.verdicts.has(h(1))).toBe(false);
			const record = r.records.find((x) => x.type === "judge");
			expect(record).toMatchObject({ applied: 0, resultDisposition: "stale" });
			expect(record.verdicts.find((v: Any) => v.h === h(1))).toMatchObject({ f: "NYN", applied: false });
		}
	});

	test("skip logs distinguish pressure from candidate gates and suppress repeated identical skips", () => {
		const r = rig();
		r.run(24, r.blocks, 1000);
		r.run(25, r.blocks, 1000);
		expect(r.records).toEqual([expect.objectContaining({ type: "judge_skip", reason: "below-pressure", reqCount: 24 })]);
		r.run(26, r.blocks, 40_000, { inturnAge: 0 });
		expect(r.records[1]).toMatchObject({ type: "judge_skip", reason: "batch-too-small", handles: [] });
		expect(r.calls).toHaveLength(0);
		r.judge.stop();
	});

	test("one exact folded handle triggers without a locator or five eligible outputs", async () => {
		const r = rig();
		const entries = longTurn(1);
		entries.push(U("lookup", `check output ${h(1)}`));
		const folded = project(entries, [{ type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip]" }] } }]);
		const blocks = buildBlocks(folded);
		r.run(24, blocks);
		await r.judge.running;
		expect(r.calls).toHaveLength(1);
		expect(r.records[0]).toMatchObject({ eligible: 0, foldedHit: true });
		expect(r.calls[0][1].messages[0].content[0].text).not.toContain('"locator"');
	});
	test("thresholds, request/output cadence, one in-flight call, cheapest same-provider model", async () => {
		const d = deferred(), r = rig(() => d.promise);
		r.ctx.modelRegistry.getAvailable = () => [{ ...model, provider: "foreign", cost: { input: 0 } }, { ...model, id: "expensive", cost: { input: 9 } }, model];
		r.run(24, r.blocks, 31_999);
		expect(r.judge.running).toBeNull();
		r.run(); await flush();
		r.run(32);
		expect(r.calls.length).toBe(1);
		expect(r.calls[0][0].id).toBe("cheap");
		d.resolve(textReply(`${h(1)} C E1`));
		await r.judge.running;
		expect(r.judge.labels(24, "do the long task")?.get(h(1))).toBe("cold");
		expect(r.judge.stats.costUsd).toBe(0.002);
		// A new eligible batch, less than 8 requests and less than 10K output tokens.
		const more = buildBlocks(longTurn(25));
		r.run(31, more); expect(r.calls.length).toBe(1);
		r.judge.verdicts.clear();
		r.run(32, more); await r.judge.running; expect(r.calls.length).toBe(2);
		const large = buildBlocks(longTurn(32, { chars: 10_000 }));
		r.judge.verdicts.clear();
		r.run(33, large); await r.judge.running; expect(r.calls.length).toBe(3);
		expect(r.judge.labels(54, "do the long task")).toBeUndefined();
		r.judge.stop();
	});

	test("failure keeps old verdicts, stops after two errors, and resets at the next run", async () => {
		const r = rig(async () => textReply("broken JSON"));
		r.judge.verdicts.set(h(1), { v: "hot", atReq: 0 });
		r.run(); await r.judge.running;
		r.run(32); await r.judge.running;
		r.run(40); expect(r.calls.length).toBe(2);
		expect(r.judge.verdicts.get(h(1))?.v).toBe("hot");
		expect(r.records.filter((x) => x.error).length).toBe(2);
		r.judge.startRun(); r.run(40); await r.judge.running;
		expect(r.calls.length).toBe(3);
	});

	test("timeout and stop abort the call, preserve verdicts, and ignore late results", async () => {
		const d = deferred(), r = rig(() => d.promise, 5);
		r.run(); await new Promise((res) => setTimeout(res, 15));
		expect(r.calls[0][2].signal.aborted).toBe(true);
		r.run(40); expect(r.calls.length).toBe(1); // provider has not acknowledged cancellation
		d.resolve(textReply(JSON.stringify({ cold: [h(1)], hot: [], need: [] })));
		await r.judge.running;
		expect(r.judge.verdicts.size).toBe(0);
		const record = r.records.find((x) => x.type === "judge");
		expect(record.error).toBeDefined();
		expect(record.replyHead).toBeDefined(); // keep returned bytes for tracing, even after abort
		expect(record).toMatchObject({ applied: 0, resultDisposition: "no-usable-rows" });
		expect(record).toMatchObject({ reqCount: 24, eligible: expect.any(Number), known: expect.any(Number), inputTokens: expect.any(Number) });
		expect(r.records.find((x) => x.type === "judge_skip")).toMatchObject({ reason: "pending", reqCount: 40 });
		const bad = rig(async () => textReply('{"cold":[]}'));
		bad.run(); await bad.judge.running;
		expect(bad.records[0]).toMatchObject({ error: "Judge response has no fact lines", replyHead: '{"cold":[]}' });
		const later = deferred(), s = rig(() => later.promise);
		s.run(); await flush();
		s.judge.stop(); s.judge.startRun(); s.run(32);
		expect(s.calls.length).toBe(1);
		later.resolve(textReply()); await s.judge.running;
		expect(s.judge.verdicts.size).toBe(0);
	});

	test("explicit model selection, disabled-by-default and unavailable-model no-op", async () => {
		delete process.env.PI_ZIP_JUDGE;
		const off = rig(); off.run(); expect(off.judge.running).toBeNull();
		process.env.PI_ZIP_JUDGE = "1";
		process.env.PI_ZIP_JUDGE_MODEL = "q/special";
		const r = rig(); r.ctx.modelRegistry.getAvailable = () => [model, { ...model, provider: "q", id: "special" }];
		r.run(); await r.judge.running; expect(r.calls[0][0].provider).toBe("q");
		process.env.PI_ZIP_JUDGE_MODEL = "missing/model";
		const no = rig(); no.run(); await no.judge.running; no.run(50);
		expect(no.calls.length).toBe(0); expect(no.records.length).toBe(1);
	});

	test("PI_ZIP_JUDGE_MODEL takes a :level suffix; an id containing ':' still matches whole", async () => {
		const luna = { ...model, provider: "github-copilot", id: "gpt-6-luna" }, free = { ...model, provider: "or", id: "llama:low" };
		expect(judgeModelRef("github-copilot/gpt-6-luna:low", [luna])).toEqual({ ref: "github-copilot/gpt-6-luna", level: "low" });
		expect(judgeModelRef("or/llama:low", [free])).toEqual({ ref: "or/llama:low" });
		expect(judgeModelRef("or/llama:free", [])).toEqual({ ref: "or/llama:free" });
		const simple = (level: string) => {
			process.env.PI_ZIP_JUDGE_MODEL = `github-copilot/gpt-6-luna:${level}`;
			const r = rig(), seen: Any[] = [];
			r.ctx.modelRegistry.getAvailable = () => [model, luna];
			(r.ctx.modelRegistry as Any).getSupportedThinkingLevels = () => ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			(r.ctx.modelRegistry as Any).clampThinkingLevel = (_m: Any, level: string) => level;
			(r.ctx.modelRegistry as Any).streamSimple = (m: Any, _c: Any, o: Any) => { seen.push([m.id, o]); return { result: async () => textReply() }; };
			return { ...r, seen };
		};
		const low = simple("low"); low.run(); await low.judge.running;
		expect(low.calls.length).toBe(0); expect(low.seen[0][0]).toBe("gpt-6-luna"); expect(low.seen[0][1].reasoning).toBe("low"); expect(low.records[0].error).toBeUndefined();
		const off = simple("off"); off.run(); await off.judge.running;
		expect("reasoning" in off.seen[0][1]).toBe(false);
		delete process.env.PI_ZIP_JUDGE_MODEL;
		const plain = rig(); plain.run(); await plain.judge.running;
		expect(plain.calls.length).toBe(1);
	});

	test("output cap: 16K default, env and model limits, context room; the ledger logs tokens for tuning", async () => {
		const capOf = async (m: Any, env?: string) => {
			if (env) process.env.PI_ZIP_JUDGE_MAX_TOKENS = env; else delete process.env.PI_ZIP_JUDGE_MAX_TOKENS;
			process.env.PI_ZIP_JUDGE_MODEL = "p/cheap";
			const r = rig(async () => ({ ...textReply(), usage: { input: 900, output: 700, reasoning: 500, cost: { total: 0.001 } } }));
			r.ctx.modelRegistry.getAvailable = () => [m];
			r.run(); await r.judge.running;
			return { sent: r.calls[0]?.[2].maxTokens, rec: r.records[0], input: r.calls[0] ? tok4(r.calls[0][1].messages[0].content[0].text + JUDGE_SYSTEM) : 0 };
		};
		try {
			const big = { ...model, maxTokens: 64_000 };
			const d = await capOf(big);
			expect(d.sent).toBe(16_384);
			expect(d.rec).toMatchObject({ maxTokens: 16_384, stopReason: "stop", outputTokens: 700, reasoningTokens: 500 });
			expect((await capOf(big, "30000")).sent).toBe(30_000);
			expect((await capOf(big, "10")).sent).toBe(1024);
			expect((await capOf({ ...model, maxTokens: 8192 })).sent).toBe(8192);
			expect((await capOf({ ...big, contextWindow: d.input + 5000 })).sent).toBe(5000);
			const full = await capOf({ ...big, contextWindow: d.input + 1000 });
			expect(full.sent).toBeUndefined(); expect(full.rec.error).toMatch(/context window/);
		} finally { delete process.env.PI_ZIP_JUDGE_MAX_TOKENS; }
	});

	test("no capability metadata keeps the provider default; a mandatory model is not forced off", () => {
		expect(judgeReasoning(model, "low")).toBeUndefined();
		expect(judgeReasoning({ reasoning: true })).toBeUndefined(); // Pi sends its off effort: nothing to lower
		// the provider picks the effort when none is named: the lowest supported level above off
		expect(judgeReasoning({ reasoning: true, thinkingLevelMap: { off: null } })).toBe("minimal");
		const luna = { provider: "github-copilot", api: "openai-responses", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low" } };
		expect(judgeReasoning(luna, undefined)).toBe("low");
		expect(judgeReasoning(luna, "high")).toBe("high"); // an explicit level wins
		expect(judgeReasoning({ ...luna, api: "anthropic-messages" }, undefined)).toBeUndefined(); // Pi turns thinking off there
		expect(judgeReasoning({ ...luna, reasoning: false }, undefined)).toBeUndefined();
		const registry = { getSupportedThinkingLevels: () => ["off", "medium", "high"], clampThinkingLevel: (_m: Any, l: string) => l };
		expect(judgeReasoning(luna, undefined, registry)).toBe("medium"); // the host's list, not the static map
		expect(judgeReasoning({ reasoning: true, thinkingLevelMap: { off: null } }, "off")).toBe("minimal");
		expect(judgeReasoning({ reasoning: false }, "high")).toBe("off");
	});

	test("no explicit level leaves the provider default on a reasoning model", async () => {
		process.env.PI_ZIP_JUDGE_MODEL = "p/cheap";
		const thinking = { ...model, reasoning: true };
		const r = rig();
		r.ctx.modelRegistry.getAvailable = () => [thinking];
		const streamed: Any[] = [];
		(r.ctx.modelRegistry as Any).streamSimple = (_m: Any, _c: Any, options: Any) => {
			streamed.push(options);
			return { result: async () => textReply() };
		};
		r.run(); await r.judge.running;
		expect(r.calls.length).toBe(0);
		expect(streamed).toHaveLength(1);
		expect(streamed[0].reasoning).toBeUndefined();
		expect(r.records[0].error).toBeUndefined();
	});

	test("a model that reasons by default is asked for its lowest level; without streamSimple the default stays", async () => {
		const luna = { ...model, provider: "github-copilot", id: "gpt-6-luna", api: "openai-responses", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low" } };
		process.env.PI_ZIP_JUDGE_MODEL = "github-copilot/gpt-6-luna";
		const r = rig(), streamed: Any[] = [];
		r.ctx.modelRegistry.getAvailable = () => [luna];
		(r.ctx.modelRegistry as Any).streamSimple = (_m: Any, _c: Any, o: Any) => { streamed.push(o); return { result: async () => textReply() }; };
		r.run(); await r.judge.running;
		expect(streamed.map((o) => o.reasoning)).toEqual(["low"]);
		expect(r.calls.length).toBe(0);
		expect(r.records[0]).toMatchObject({ level: "low" });
		expect(r.records[0].error).toBeUndefined();
		const bare = rig();
		bare.ctx.modelRegistry.getAvailable = () => [luna];
		bare.run(); await bare.judge.running;
		expect(bare.calls.length).toBe(1);
		expect(bare.calls[0][2].reasoning).toBeUndefined();
		expect(bare.records[0].level).toBeUndefined();
		expect(bare.records[0].error).toBeUndefined();
	});

	test("a changed user request is judged again inside the old verdict window", async () => {
		const r = rig();
		r.run(); await r.judge.running;
		expect(r.calls.length).toBe(1);
		const steered = buildBlocks(longTurn(24));
		const user = steered.find((b) => b.kind === "user")!;
		user.msg = { ...user.msg, content: "switch to the pool leak" };
		r.run(26, steered); await r.judge.running;
		expect(r.calls.length).toBe(2);
		expect(r.judge.labels(26, "do the long task")).toBeUndefined();
		expect(r.judge.labels(26, "switch to the pool leak")?.get(h(1))).toBe("warm");
	});

	test("an ended run drops lookup notes that were not sent", () => {
		const judge = new Judge(() => {});
		judge.startRun();
		judge.scope = "task";
		(judge as Any).consumed = false;
		(judge as Any).catalogue = new Map([[h(1), { label: "read file" }]]);
		judge.verdicts.set(h(1), { v: "need", atReq: 3, locator: "/tmp/proj/a.ts", nOk: true });
		const ask = { folded: new Set([h(1)]), recalled: new Set<string>(), reqCount: 3, scope: "task", cited: () => true };
		expect(judge.proposeHints(ask)?.shown).toEqual([h(1)]);
		judge.stop();
		judge.startRun();
		expect(judge.proposeHints(ask)).toBeNull();
	});

	test("the ledger says why a need gave no note, once per distinct reason", () => {
		const records: Any[] = [];
		const judge = new Judge((r) => records.push(r));
		judge.startRun();
		judge.scope = "task";
		(judge as Any).consumed = false;
		for (const i of [1, 2, 3, 4]) judge.verdicts.set(h(i), { v: "need", atReq: 3, locator: null, nOk: true });
		judge.verdicts.set(h(5), { v: "need", atReq: 1, locator: null, nOk: true });
		judge.hinted.add(h(3));
		const ask = { folded: new Set([h(1), h(3), h(4), h(5)]), recalled: new Set([h(4)]), reqCount: 22, scope: "task", cited: (x: string) => x !== h(1) };
		expect(judge.proposeHints(ask)).toBeNull();
		expect(judge.proposeHints(ask)).toBeNull();
		expect(records).toEqual([{ type: "judge_hint", blocked: { [h(1)]: "uncited", [h(2)]: "notFolded", [h(3)]: "hinted", [h(4)]: "recalled", [h(5)]: "old" } }]);
	});

	test("a citation is a recent exact path or handle", () => {
		const entries = longTurn(20);
		entries[0].messages[0].content = "remember /tmp/proj/old.ts and hhhhhhhhhh";
		entries.push(U("u9", "edit /tmp/proj/auth/session.ts"));
		const blocks = buildBlocks(entries);
		expect(citesWork(blocks, "hhhhhhhhhh", "/tmp/proj/old.ts", "/tmp")).toBe(false);
		expect(citesWork(blocks, "zzzzzzzzzz", "/tmp/proj/auth", "/tmp")).toBe(false);
		expect(citesWork(blocks, "zzzzzzzzzz", "/tmp/proj/auth/session.ts", "/tmp")).toBe(true);
		expect(citesWork(blocks, handleFor("r20"), null, "/tmp")).toBe(false);
	});

	test("a hint stops at 600 characters and an open tool call blocks it", () => {
		const packed = hintText(Array.from({ length: 5 }, (_, i) => ({ handle: String(i).padStart(10, "0"), label: "x".repeat(180) })));
		expect(packed.text.length).toBeLessThanOrEqual(600);
		expect(packed.shown.length).toBeGreaterThan(0);
		expect(packed.shown.length).toBeLessThan(5);
		const open = [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1" }] }];
		expect(requestOpen(open)).toBe(true);
		expect(requestOpen([...open, { role: "toolResult", toolCallId: "c1", content: [] }])).toBe(false);
	});
});

describe("Zip integration", () => {
	test("new evidence invalidates advice before the boundary's planner reads it", async () => {
		const r = rig(async () => textReply(`${h(1)} C E1`));
		r.run(); await r.judge.running;
		const entries = longTurn(24);
		entries.push(A("dependency", []));
		entries.at(-1)!.messages[0].content = [{ type: "text", text: `Still need ${h(1)}` }];
		const { pi } = fakePi(), { ctx } = fakeCtx(entries, { model });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx);
		(zip as Any).judge = r.judge;
		let wasCold: boolean | undefined;
		(zip as Any).onTurnEnd = async () => { wasCold = r.judge.verdicts.get(h(1))?.v === "cold"; };
		await zip.turnEnd({ message: { role: "assistant", stopReason: "toolUse" }, entries: [], context: { contextEntries: entries } }, ctx);
		expect(wasCold).toBe(false);
		zip.shutdown();
	});
	test("a need custom message never creates a user turn, including after a final answer", () => {
		const entries = [U("u", "task"), A("a")];
		const m = { role: "custom", customType: NEED_CUSTOM, content: "reminder" };
		const withHint = [...entries, { sourceEntry: { type: "custom_message", id: "hint" }, messages: [m] }];
		expect(countUserTurns(buildBlocks(withHint))).toBe(1);
		expect(countUserTurns(buildBlocks([...withHint, U("next", "new task")]))).toBe(2);
	});

	test("turnEnd does not await the judge; off and session switch discard its late answer", async () => {
		const entries = longTurn(72, { chars: 12_000 }), d = deferred(), calls: Any[] = [];
		const { pi } = fakePi({ sendMessage: (...args: Any[]) => calls.push(args) });
		const { ctx } = fakeCtx(entries, { model, modelRegistry: { getAvailable: () => [model], complete: () => d.promise } });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx);
		const records: Any[] = [];
		zip.ledger = (record) => records.push(record);
		const message = { role: "assistant", stopReason: "toolUse" };
		zip.messageEnd(message, ctx);
		await zip.turnEnd({ message, entries: [], context: { contextEntries: entries } }, ctx);
		await flush();
		expect(zip.card(ctx).judge?.calls).toBe(1);
		// Wiring check: the production shell emits the candidate diagnostics from the decision core.
		expect(records.find((r) => r.type === "law" && r.where === "turn_end").foldDecision.outputs.length).toBeGreaterThan(0);
		zip.setOff(true);
		d.resolve(textReply(JSON.stringify({ cold: [h(1)], hot: [], need: [h(2)] })));
		await flush();
		expect(calls.length).toBe(0);
		zip.sessionStart(ctx);
		expect(zip.card(ctx).judge?.calls).toBe(0);
		zip.shutdown();
	});

	test("one lookup note names at most three handles and does not steer or mark a recall", async () => {
		const base = longTurn(24, { chars: 12_000 });
		const wanted = [1, 2, 3, 4, 5].map((i) => h(i));
		const end = base[base.length - 1];
		end.messages[0].content = [{ type: "text", text: `use ${wanted.join(" ")}` }];
		end.sourceEntry.message.content = end.messages[0].content;
		const entries = project(base, wanted.map((_, i) => ({ type: "context_edit", targetId: `r${i + 1}`, replacement: { content: [{ type: "text", text: "[folded by pi-zip] old" }] } })));
		const messages: Any[] = [], appended: Any[] = [];
		const { pi } = fakePi({
			sendMessage: (...args: Any[]) => messages.push(args),
			appendEntry: (t: string, d: Any) => appended.push({ t, d }),
		});
		const branch = base.map((e) => e.sourceEntry);
		const { ctx } = fakeCtx(entries, { model, branch, modelRegistry: { getAvailable: () => [model], complete: async (_m: Any, context: Any) => {
			const text = context.messages[0].content[0].text as string;
			const line = text.split("\n").find((l: string) => l.startsWith("E") && l.includes(wanted[0]));
			const id = line?.split(" ")[0] ?? "E1";
			return textReply(wanted.map((handle) => `${handle} N ${id}`).join("\n"));
		} } });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx);
		const message = { role: "assistant", stopReason: "toolUse" };
		zip.messageEnd(message, ctx);
		await zip.turnEnd({ message, entries: [], context: { contextEntries: entries } }, ctx);
		await (zip as Any).judge.running;
		const recalled = new Set(zip.recalled);
		const first = await zip.context({ messages: [{ role: "user", content: "continue" }] }, ctx);
		expect(messages).toEqual([]);
		expect(first.messages.at(-1).content).toContain(wanted[0]);
		expect(first.messages.at(-1).content).toContain(wanted[2]);
		expect(first.messages.at(-1).content).not.toContain(wanted[3]);
		expect(zip.recalled).toEqual(recalled);
		expect(appended.filter((e) => e.t === "pi-zip/hinted").map((e) => e.d.handles)).toEqual([wanted.slice(0, 3)]);
		const second = await zip.context({ messages: [{ role: "user", content: "continue" }] }, ctx);
		expect(second.messages.at(-1).content).toContain(wanted[3]);
		expect(second.messages.at(-1).content).toContain(wanted[4]);
		expect(second.messages.at(-1).content).not.toContain(wanted[0]);
		expect(appended.filter((e) => e.t === "pi-zip/hinted").map((e) => e.d.handles)).toEqual([wanted.slice(0, 3), wanted.slice(3)]);
		const third = await zip.context({ messages: [{ role: "user", content: "continue" }] }, ctx);
		expect(third).toBeUndefined();
		zip.shutdown();
	});

	test("a judge failure never drops the turn's fold drafts", async () => {
		const entries = longTurn(100, { chars: 12_000 });
		const { pi } = fakePi({ sendMessage: () => { throw new Error("steer refused"); } });
		const { ctx } = fakeCtx(entries, { model, branch: entries.map((e) => e.sourceEntry), modelRegistry: { getAvailable: () => [model], complete: async () => textReply("not a verdict") } });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx);
		const message = { role: "assistant", stopReason: "toolUse" };
		const event = { message, entries: [], context: { contextEntries: entries } };
		zip.messageEnd(message, ctx);
		await zip.turnEnd(event, ctx);
		await flush();
		zip.messageEnd(message, ctx);
		const out = await zip.turnEnd(event, ctx);
		expect(out?.entries.some((e: Any) => e.type === "context_edit")).toBe(true);
		zip.shutdown();
	});

	test("the card shows judge counters only when enabled", () => {
		const c = { state: "on" as const, folds: 0, foldedTokens: "0K", summaries: 0, summaryUsd: 0, recalls: 0, quiet: false };
		expect(cardText(c).join("\n")).not.toContain("judge");
		expect(cardText({ ...c, judge: { calls: 2, costUsd: 0.01, unknown: 3, errors: 1 } }).join("\n")).toContain("2 calls $0.0100 · 3 unknown · 1 errors");
	});
});

function materializeFixtureSnapshot(snap: Any) {
	const resolveRef = (s: string) => s.replace(/\{handle:([^}]+)\}/g, (_, id: string) => handleFor(id));
	const entries: Any[] = [], branch: Any[] = [], steerIds = new Set<string>();
	for (const st of snap.steps) {
		if (st.kind === "user") {
			const m = { role: "user", content: resolveRef(st.text) };
			const src = { id: st.id, type: "message", message: m };
			entries.push({ sourceEntry: src, messages: [m] });
			branch.push(src);
			if (st.steer) steerIds.add(st.id);
		} else if (st.kind === "assistant") {
			const m = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: resolveRef(st.text) }] };
			const src = { id: st.id, type: "message", message: m };
			entries.push({ sourceEntry: src, messages: [m] });
			branch.push(src);
		} else if (st.kind === "custom") {
			const content = resolveRef(st.content);
			const m = { role: "custom", customType: st.customType, content };
			const src = { id: st.id, type: "custom_message", customType: st.customType, content };
			entries.push({ sourceEntry: src, messages: [m] });
			branch.push(src);
		} else if (st.kind === "toolRound") {
			const am = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: st.callId, name: st.tool, arguments: st.args }] };
			const asrc = { id: st.asstId, type: "message", message: am };
			entries.push({ sourceEntry: asrc, messages: [am] });
			branch.push(asrc);
			const rawText = resolveRef(st.text).padEnd(2400, " ");
			const rawMsg = { role: "toolResult", toolCallId: st.callId, toolName: st.tool, isError: false, content: [{ type: "text", text: rawText }] };
			const rsrc = { id: st.resultId, type: "message", message: rawMsg };
			branch.push(rsrc);
			if (st.folded) {
				const ph = `${PH_MARK}${handleFor(st.resultId)} · ${st.tool}]`;
				const editedMsg = { ...rawMsg, content: [{ type: "text", text: ph }] };
				entries.push({ sourceEntry: rsrc, messages: [editedMsg] });
				branch.push({ id: `edit_${st.resultId}`, type: "context_edit", targetId: st.resultId, replacement: { content: editedMsg.content } });
			} else {
				entries.push({ sourceEntry: rsrc, messages: [rawMsg] });
			}
		} else if (st.kind === "recallRound") {
			const th = handleFor(st.targetEntryId);
			const am = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: st.callId, name: "zip_recall", arguments: { handle: th } }] };
			const asrc = { id: st.asstId, type: "message", message: am };
			entries.push({ sourceEntry: asrc, messages: [am] });
			branch.push(asrc);
			const rm = { role: "toolResult", toolCallId: st.callId, toolName: "zip_recall", isError: false, content: [{ type: "text", text: resolveRef(st.text) }] };
			const rsrc = { id: st.resultId, type: "message", message: rm };
			entries.push({ sourceEntry: rsrc, messages: [rm] });
			branch.push(rsrc);
		}
	}
	const blocks = buildBlocks(entries, steerIds);
	for (const st of snap.steps) {
		if (st.kind === "toolRound" && typeof st.age === "number") {
			const b = blocks.find((x) => x.entryId === st.resultId);
			if (b) b.age = st.age;
		}
	}
	return { entries, branch, blocks, calls: toolCallIndex(blocks), steerIds };
}

describe("finite contract corpus (test/fixtures/judge-decisions.json)", () => {
	const corpus = JSON.parse(readFileSync(new URL("./fixtures/judge-decisions.json", import.meta.url), "utf8"));

	test("separates prompt contrastive examples from held-out eval cases and covers all 10 categories", () => {
		const requiredCategories = [
			"completed-work",
			"unresolved-error",
			"recently-edited-file",
			"exact-lookup-needed",
			"live-output-no-recall",
			"scope-changed",
			"insufficient-data",
			"same-topic-independent",
			"prompt-injection",
			"recall-echo",
		];
		expect(corpus.promptExamples.length).toBeGreaterThanOrEqual(4);
		for (const ex of corpus.promptExamples) {
			expect(ex.split).toBe("prompt");
			expect(JUDGE_SYSTEM).toContain(ex.exampleLine);
		}
		const evalCategories = corpus.evalCases.map((c: Any) => c.category);
		for (const cat of requiredCategories) expect(evalCategories).toContain(cat);
		for (const c of corpus.evalCases) {
			expect(c.split).toBe("eval");
			expect(JUDGE_SYSTEM).not.toContain(c.id);
			for (const t of c.targets) {
				const h = handleFor(t.entryId);
				expect(JUDGE_SYSTEM).not.toContain(h);
				if (c.category === "insufficient-data") expect(t.accepted).toContain("U");
			}
		}
	});

	test("replays held-out snapshots for expected labels, adversarial verdicts, and policy invariants", () => {
		let checkedTargets = 0, abstained = 0, unsupportedNeed = 0, policyViolations = 0, promptTokens = 0;

		for (const c of corpus.evalCases) {
			const s = materializeFixtureSnapshot(c.snapshot);
			const inp = judgeInput(s.blocks, s.calls, c.snapshot.firstPrompt, 6000, undefined, c.snapshot.reqCount, c.snapshot.cwd);
			promptTokens += tok4(inp.text + JUDGE_SYSTEM);
			const meta = new Map([...inp.manifest].map((h) => [h, { folded: inp.folded.has(h), locator: inp.catalogue.get(h)?.locator ?? null }]));

			if (c.category === "recall-echo") {
				expect(inp.manifest.has(handleFor("r_102_recall"))).toBe(false);
				const echoed = handleFor("r_101_echoed");
				for (const ev of inp.evidence) expect(ev.handles).not.toContain(echoed);
			}

			// 1. Expected / contract-accepted decision evaluation.
			const expectedLines = c.targets.map((t: Any) => factLine(handleFor(t.entryId), t.expected)).join("\n");
			const parsed = parseFacts(expectedLines, inp.manifest, inp.evidence, meta);
			abstained += parsed.abstained;
			const judge = new Judge(() => {});
			judge.startRun();
			judge.scope = latestUserText(s.blocks);
			(judge as Any).catalogue = inp.catalogue;
			(judge as Any).consumed = false;
			for (const [k, v] of parsed.verdicts) {
				judge.verdicts.set(k, { v, atReq: c.snapshot.reqCount, locator: parsed.locator.get(k) ?? null, nOk: parsed.nOk.get(k) ?? false });
			}
			const hint = judge.proposeHints({
				folded: inp.folded,
				recalled: new Set(),
				reqCount: c.snapshot.reqCount,
				scope: latestUserText(s.blocks),
				cited: (h, loc) => citesWork(s.blocks, h, loc, c.snapshot.cwd),
			});

			for (const t of c.targets) {
				const th = handleFor(t.entryId);
				expect(inp.manifest.has(th)).toBe(true);
				expect(t.accepted).toContain(t.expected);
				checkedTargets++;
				expect(parsed.verdicts.get(th)).toBe(t.expectedVerdict);
				expect(!!hint?.shown.includes(th)).toBe(!!t.expectHint);
				if (t.forbiddenActions.includes("fold_before_cold")) {
					const coldTarget = c.targets.find((o: Any) => o.expected === "C" && !inp.folded.has(handleFor(o.entryId)));
					if (coldTarget) {
						const p = planContext(s.entries, { cwd: c.snapshot.cwd, scale: UNIT, coldCap: 800, inturnAge: 1, keepLines: 0, steerIds: s.steerIds, verdicts: parsed.verdicts });
						if (!p || p.folds[0]?.entryId !== coldTarget.entryId) policyViolations++;
						expect(p?.folds[0]?.entryId).toBe(coldTarget.entryId);
					}
				}
			}

			// 2. Adversarial mock verdict evaluation: policy must block every forbidden action.
			const advLines = c.targets.map((t: Any) => String(t.adversarialLine).replace("{handle}", handleFor(t.entryId))).join("\n");
			const advParsed = parseVerdict(advLines, inp.manifest, inp.evidence, meta);
			const advJudge = new Judge(() => {});
			advJudge.startRun();
			advJudge.scope = latestUserText(s.blocks);
			(advJudge as Any).catalogue = inp.catalogue;
			(advJudge as Any).consumed = false;
			for (const [k, v] of advParsed.verdicts) {
				advJudge.verdicts.set(k, { v, atReq: c.snapshot.reqCount, locator: advParsed.locator.get(k) ?? null, nOk: advParsed.nOk.get(k) ?? false });
			}
			const advHint = advJudge.proposeHints({
				folded: inp.folded,
				recalled: new Set(),
				reqCount: c.snapshot.reqCount,
				scope: latestUserText(s.blocks),
				cited: (h, loc) => citesWork(s.blocks, h, loc, c.snapshot.cwd),
			});

			for (const t of c.targets) {
				const th = handleFor(t.entryId);
				if (String(t.adversarialLine).includes(" N ") && !advParsed.nOk.get(th)) unsupportedNeed++;
				if (t.forbiddenActions.includes("hint") && (advParsed.nOk.get(th) || advHint?.shown.includes(th))) policyViolations++;
				if (t.forbiddenActions.includes("early_fold")) {
					const p = planContext(s.entries, { cwd: c.snapshot.cwd, scale: UNIT, coldCap: 100, keepLines: 0, steerIds: s.steerIds, verdicts: advParsed.verdicts });
					if (p?.folds.some((f) => f.entryId === t.entryId)) policyViolations++;
				}
			}
		}

		const report = {
			cases: corpus.evalCases.length,
			checkedTargets,
			abstained,
			unsupportedNeed,
			policyViolations,
			promptTokens,
			costUsd: 0,
			latencyMs: 0,
			semanticQualityEvaluated: false,
			note: "Contract fixtures and adversarial policy checks only; no model accuracy measurement.",
		};
		expect(report.cases).toBe(10);
		expect(report.abstained).toBeGreaterThanOrEqual(1);
		expect(report.unsupportedNeed).toBeGreaterThanOrEqual(7);
		expect(report.policyViolations).toBe(0);
		expect(report.promptTokens).toBeGreaterThan(0);
		expect(report.semanticQualityEvaluated).toBe(false);
	});
});

