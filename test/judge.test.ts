import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Judge, judgeInput, parseVerdict, judgeModelRef, judgeReasoning, hintText, requestOpen, locatorOf, citesWork, latestUserText, JUDGE_SYSTEM, NEED_CUSTOM, type EvidenceSpan } from "../src/judge.ts";
import { buildBlocks, countUserTurns, plan, planContext, toolCallIndex, UNIT, type PlanOpts } from "../src/plan.ts";
import { checkEdits, decideEdits } from "../src/core.ts";
import { handleFor, PH_MARK } from "../src/placeholder.ts";
import { resolveHandlesInBranch } from "../src/recall.ts";
import { cardText } from "../src/ui.ts";
import { Zip } from "../src/run.ts";
import { lawPrices } from "../src/learn.ts";
import { A, U, fakeCtx, fakePi, longTurn, project, startZip, type Any } from "./helpers.ts";
import { tok4 } from "../src/util.ts";

const saved = { ...process.env };
beforeEach(() => { process.env.PI_ZIP_JUDGE = "1"; delete process.env.PI_ZIP_JUDGE_MODEL; delete process.env.PI_ZIP_JUDGE_AGE; });
afterEach(() => {
	for (const key of ["PI_ZIP_JUDGE", "PI_ZIP_JUDGE_MODEL", "PI_ZIP_JUDGE_AGE"]) {
		if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
	}
});
const h = (i: number) => handleFor(`r${i}`);
const textReply = (text = "zzzzzzzzzz U -") => ({ stopReason: "stop", content: [{ type: "text", text }], usage: { input: 100, output: 20, cost: { total: 0.002 } } });
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
	const run = (req = 24, bs = blocks, context = 40_000) => judge.maybeRun(ctx, bs, toolCallIndex(bs), "task", req, context, 40_000);
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
		expect(b.text).toContain(`${h(1)} age=13 folded`);
		expect(b.text).toContain('"thinking":"hmm"');
		expect(b.text).toContain('"command":"ls"');
		const appended = buildBlocks(longTurn(14));
		const c = judgeInput(appended, toolCallIndex(appended), "original task", 6000, b.catalogue, 14);
		expect(c.prefix.startsWith(b.prefix)).toBe(true);
		expect(c.catalogue.size).toBe(14);
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

describe("judge folds keep the existing decision", () => {
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
		verdicts.delete(h(2));
		const v = new Map<string, "cold" | "hot" | "need">([...verdicts, [h(64), "cold"], [h(1), "need"]]);
		const p = planContext(entries, { ...opts, verdicts: v })!;
		expect(p.folds[0].entryId).toBe("r2");
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

	test("carried placeholders keep their bytes even when a verdict changes", () => {
		const entries = longTurn(72), opts = plannerOpts(entries);
		const before = planContext(entries, opts)!;
		const after = planContext(entries, { ...opts, carriedFolds: before.folds, verdicts: new Map(before.folds.map((f) => [handleFor(f.entryId), "need" as const])) })!;
		expect(after.folds).toEqual(before.folds);
	});
});

describe("background judge", () => {
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
		expect(r.records[0].error).toBeDefined();
		expect(r.records[0].replyHead).toBeUndefined(); // aborted before the reply was read
		expect(r.records[0]).toMatchObject({ reqCount: 24, eligible: expect.any(Number), known: expect.any(Number), inputTokens: expect.any(Number) });
		const bad = rig(async () => textReply('{"cold":[]}'));
		bad.run(); await bad.judge.running;
		expect(bad.records[0]).toMatchObject({ error: "Judge response must be verdict lines", replyHead: '{"cold":[]}' });
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
		expect(judgeReasoning({ reasoning: true })).toBeUndefined();
		expect(judgeReasoning({ reasoning: true, thinkingLevelMap: { off: null } })).toBeUndefined();
		expect(judgeReasoning({ reasoning: true, thinkingLevelMap: { off: null } }, "off")).toBe("minimal");
		expect(judgeReasoning({ reasoning: false }, "high")).toBe("off");
	});

	test("no explicit level leaves the provider default on a reasoning model", async () => {
		process.env.PI_ZIP_JUDGE_MODEL = "p/cheap";
		const thinking = { ...model, reasoning: true };
		const r = rig();
		r.ctx.modelRegistry.getAvailable = () => [thinking];
		(r.ctx.modelRegistry as Any).streamSimple = () => { throw new Error("default must not set a level"); };
		r.run(); await r.judge.running;
		expect(r.calls.length).toBe(1);
		expect(r.calls[0][2].reasoning).toBeUndefined();
		expect(r.records[0].error).toBeUndefined();
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
	test("a need custom message never creates a user turn, including after a final answer", () => {
		const entries = [U("u", "task"), A("a")];
		const m = { role: "custom", customType: NEED_CUSTOM, content: "reminder" };
		const withHint = [...entries, { sourceEntry: { type: "custom_message", id: "hint" }, messages: [m] }];
		expect(countUserTurns(buildBlocks(withHint))).toBe(1);
		expect(countUserTurns(buildBlocks([...withHint, U("next", "new task")]))).toBe(2);
	});

	test("turnEnd does not await the judge; off and session switch discard its late answer", async () => {
		const entries = longTurn(24, { chars: 12_000 }), d = deferred(), calls: Any[] = [];
		const { pi } = fakePi({ sendMessage: (...args: Any[]) => calls.push(args) });
		const { ctx } = fakeCtx(entries, { model, modelRegistry: { getAvailable: () => [model], complete: () => d.promise } });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx);
		const message = { role: "assistant", stopReason: "toolUse" };
		zip.messageEnd(message, ctx);
		await zip.turnEnd({ message, entries: [], context: { contextEntries: entries } }, ctx);
		await flush();
		expect(zip.card(ctx).judge?.calls).toBe(1);
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
		expect(appended.some((e) => e.t === "pi-zip/hinted" && e.d.handles.length === 5)).toBe(true);
		const second = await zip.context({ messages: [{ role: "user", content: "continue" }] }, ctx);
		expect(second).toBeUndefined();
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

describe("finite semantic eval corpus (test/fixtures/judge-decisions.json)", () => {
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
		const codes = ["C", "H", "N", "U"] as const;
		const confusion: Record<string, Record<string, number>> = Object.fromEntries(codes.map((a) => [a, Object.fromEntries(codes.map((b) => [b, 0]))]));
		let abstained = 0, unsupportedNeed = 0, policyViolations = 0, promptTokens = 0;

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
			const expectedLines = c.targets.map((t: Any) => `${handleFor(t.entryId)} ${t.expected} ${t.validEvidence[0]}`).join("\n");
			const parsed = parseVerdict(expectedLines, inp.manifest, inp.evidence, meta);
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
				confusion[t.expected][t.expected]++;
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
			confusion,
			abstained,
			unsupportedNeed,
			policyViolations,
			promptTokens,
			costUsd: 0,
			latencyMs: 0,
			semanticQualityEvaluated: process.env.PI_ZIP_JUDGE_EVAL_LIVE === "1",
			note: process.env.PI_ZIP_JUDGE_EVAL_LIVE === "1"
				? "live model semantic evaluation enabled"
				: "live LLM semantic quality not evaluated (no API credentials configured); deterministic and adversarial policy checks only",
		};
		expect(report.cases).toBe(10);
		expect(report.abstained).toBeGreaterThanOrEqual(1);
		expect(report.unsupportedNeed).toBeGreaterThanOrEqual(7);
		expect(report.policyViolations).toBe(0);
		expect(report.promptTokens).toBeGreaterThan(0);
		expect(report.semanticQualityEvaluated).toBe(false);
	});
});

