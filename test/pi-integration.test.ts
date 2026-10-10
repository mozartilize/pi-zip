// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, getCurrentSystemMessage, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { collapseSystem } from "../src/plan.ts";
import type { Any } from "./helpers.ts";
// Pi's own draft application (AgentSession._applyBoundaryDrafts uses no instance state): the order of the drafts and the
// tokensBefore Pi writes for a compaction draft are Pi's, not a re-implementation
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
import { estimateProjectedContextTokens, prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
// another extension, loaded through Pi's own loader from a factory, before or after pi-zip (the runner calls handlers in load order)
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const CWD = "/tmp/pi-zip-integration";
const T0 = Date.now() - 3 * 3_600_000; // every message is hours old: the cache is cold
const MODEL: Any = { provider: "p", id: "m", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 } };

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const asst = (content: Any[], stopReason = "stop", ts = 0): Any => ({ role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage, stopReason, timestamp: T0 + ts });
const call = (id: string, command = "ls -la"): Any => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const result = (id: string, text: string, ts = 0): Any => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text }], timestamp: T0 + ts });
const user = (text: string, ts = 0): Any => ({ role: "user", content: text, timestamp: T0 + ts });
const bulk = (tag: string, lines = 400) => Array.from({ length: lines }, (_, i) => `${tag} line ${i} some filler text to make it big`).join("\n");

/** A session shaped like a real Pi one: the initial system message, a mid-conversation system update, an aborted tool-call turn. */
function populate(sm: SessionManager, prose = 0) {
	sm.appendMessage({ role: "system", content: "You are a coding agent.", toolsAdded: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }], timestamp: T0 } as Any);
	let t = 1;
	const turn = (n: number, withTool = true) => {
		sm.appendMessage(user(`request ${n}`, t++));
		if (withTool) {
			sm.appendMessage(asst([{ type: "text", text: `working ${n}` }, call(`c${n}`)], "toolUse", t++));
			sm.appendMessage(result(`c${n}`, bulk(`out${n}`), t++));
		}
		sm.appendMessage(asst([{ type: "text", text: `done ${n} ${"explanation ".repeat(prose)}` }], "stop", t++));
	};
	turn(1);
	sm.appendMessage({ role: "system", content: "", sections: { env: "the environment changed" }, timestamp: T0 + t++ } as Any); // mid-conversation system update
	turn(2);
	sm.appendMessage(user("request 3", t++));
	sm.appendMessage(asst([{ type: "text", text: "start" }, call("x1")], "aborted", t++)); // saved WITHOUT a result
	turn(4);
	turn(5);
	turn(6);
}

const sendPrompt = (sm: SessionManager, text: string) => sm.appendMessage(user(text, 10_000_000));
// timestamps are bookkeeping: no provider puts them in a request payload
const llm = (messages: Any[], mid: boolean) => JSON.stringify(resolveTranscript(normalizeContext({ messages: convertToLlm(messages) }), mid).messages, (k, v) => (k === "timestamp" ? undefined : v));

interface RigOpts {
	file?: Any[]; // start from these session file entries (same entry ids in every rig built from them)
	tui?: boolean; // an interactive session (settle prepares, the away timer runs)
	native?: boolean; // ctx.compact is Pi's compaction path (prepareCompaction, session_before_compact, appendCompaction)
	idle?: boolean; // ctx.isIdle() (default true)
	start?: boolean; // emit before_agent_start right away (default true)
	settings?: Any;
	// another extension's session_before_compact handler (Pi runs every extension's for pi-zip's compaction too), loaded before or after pi-zip
	foreign?: { at: "before" | "after"; on: (e: Any, ctx: Any) => Any };
}

async function rig(setup: (sm: SessionManager) => void = populate, opts: RigOpts = {}) {
	const sm = opts.file ? SessionManager.inMemory(CWD, undefined, structuredClone(opts.file)) : SessionManager.inMemory(CWD); // the manager appends to the array it is given
	if (!opts.file) setup(sm);
	// the real loader, from the real entry file: exactly how `pi -e` loads the extension
	const bus = createEventBus();
	const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], CWD, "/tmp/pi-zip-integration-agent", bus);
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	let extensions = loaded.extensions;
	const foreignCalls: string[] = [];
	if (opts.foreign) {
		const f = opts.foreign;
		const other = await loadExtensionFromFactory((api: Any) => api.on("session_before_compact", async (e: Any, c: Any) => (foreignCalls.push(e.reason), f.on(e, c))), CWD, bus, runtime, "<other-compactor>");
		extensions = f.at === "before" ? [other, ...extensions] : [...extensions, other];
	}
	const narrativeCalls: Any[] = [];
	const registry: Any = {
		complete: async (_m: Any, c: Any) => (narrativeCalls.push(c), { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0 } } }),
	};
	const runner = new ExtensionRunner(extensions, runtime, CWD, sm, registry);
	const noop = () => {};
	const compactions: Any[] = [];
	const compactCalls = { n: 0, ended: 0 };
	let compacting: AbortController | null = null; // Pi's _compactionAbortController: ctx.abort() reaches it (abort -> abortCompaction)
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (minus the abort of an idle session and the UI events): Pi's own
	 *  prepareCompaction decides "Already compacted" / "Nothing to compact", session_before_compact supplies the result (every extension's
	 *  handler in load order: the last answer wins, a cancel stops it), the abort signal is checked right before appendCompaction. */
	const piCompact = (options: Any) => {
		void (async () => {
			const controller = new AbortController();
			compacting = controller;
			compactCalls.n++;
			try {
				const branch = sm.getBranch();
				const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: opts.settings?.compaction?.keepRecentTokens ?? 20_000 };
				const preparation = prepareCompaction(branch as Any, settings);
				if (!preparation) throw new Error(branch[branch.length - 1]?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)");
				const result: Any = await runner.emit({ type: "session_before_compact", preparation, branchEntries: branch, reason: "manual", willRetry: false, signal: controller.signal } as Any);
				if (result?.cancel) throw new Error("Compaction cancelled");
				if (!result?.compaction) throw new Error("rig: Pi would write its own summary with the model here");
				if (controller.signal.aborted) throw new Error("Compaction cancelled");
				const c = result.compaction;
				sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
				compactions.push(c);
				options?.onComplete?.({ ...c });
			} catch (err) {
				options?.onError?.(err instanceof Error ? err : new Error(String(err)));
			} finally {
				if (compacting === controller) compacting = null;
				compactCalls.ended++;
			}
		})();
	};
	runner.bindCore(
		{ sendMessage: noop, sendUserMessage: noop, appendEntry: (t: string, d: Any) => sm.appendCustomEntry(t, d), setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => ["read", "bash", "zip_recall"], getAllTools: () => [], getSettings: () => opts.settings ?? {}, setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop } as Any,
		{ getModel: () => MODEL, getScopedModels: () => [], isIdle: () => opts.idle !== false && !compacting, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => compacting?.abort(), hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: opts.native ? piCompact : (o: Any) => o?.onError?.(new Error("rig: no compaction")), getSystemPrompt: () => "You are a coding agent." } as Any,
	);
	if (opts.tui) runner.setUIContext({ notify: noop, setWorkingMessage: noop, setStatus: noop, setWidget: noop } as Any, "tui");
	const projectionMessages = () => sm.buildSessionContext().messages as Any[];
	/** One request as Pi sends it: the agent state is the session projection; the extension transforms it. */
	const request = async () => (await runner.emitContext(projectionMessages())) as Any[];
	const build = (drafts: Any[]) => {
		const preview = SessionManager.inMemory(CWD, undefined, [sm.getHeader() as Any, ...sm.getBranch()]);
		apply(preview, drafts);
		const projection = preview.buildSessionProjection();
		return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: convertToLlm(projection.messages), pendingMessages: [], canContinue: false };
	};
	/** What Pi's agent session does at turn_end: boundary handlers propose entries, the drafts are applied to the real session. */
	const turnEnd = async (assistantEntryId: string, message: Any) => {
		const out = await runner.emitBoundary({ type: "turn_end", turnIndex: 1, message, toolResults: [], messageEntryId: assistantEntryId, toolResultEntryIds: [], outcome: message.stopReason === "aborted" ? "aborted" : "completed" } as Any, build as Any);
		apply(sm, out.entries as Any[]);
		return out.entries as Any[];
	};
	/** The end of a run: agent_before_settle (pi-zip plans the next cold return and, interactive, arms the away timer). */
	const settle = async () => {
		const out = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" } as Any, build as Any);
		apply(sm, out.entries as Any[]);
		return out.entries as Any[];
	};
	const apply = (manager: SessionManager, drafts: Any[]) => (AgentSession.prototype as Any)._applyBoundaryDrafts.call({}, manager, drafts) as Any[];
	const beforeAgentStart = (text = "next request") => runner.emitBeforeAgentStart(text, undefined, { cwd: CWD } as Any);
	await runner.emit({ type: "session_start", reason: "startup" } as Any);
	if (opts.start !== false) await beforeAgentStart();
	return { sm, runner, request, turnEnd, settle, beforeAgentStart, narrativeCalls, projectionMessages, compactions, compactCalls, foreignCalls };
}

const saved: Record<string, string | undefined> = {};
const ENV = { PI_ZIP_COLD_CAP: "3000", PI_ZIP_MIN_GAIN: "1000", PI_ZIP_TTL_SECS: "300" };
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const isFolded = (m: Any) => m.role === "toolResult" && JSON.stringify(m.content).includes("[folded by pi-zip");

describe("real Pi: the request view is identical before and after turn_end persists the edits (I1)", () => {
	test("folds: system update stays in place, aborted turn does not block the save, request N+1 starts with request N's bytes", async () => {
		const r = await rig();
		sendPrompt(r.sm, "next request");
		const raw = r.projectionMessages();
		const req1 = await r.request();
		expect(req1.some(isFolded)).toBe(true);
		expect(req1.length).toBe(raw.length); // folds replace in place: nothing added, nothing removed
		// the mid-conversation system update is exactly where Pi put it (not merged into the leading message)
		const sysAt = (ms: Any[]) => ms.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
		expect(sysAt(req1)).toEqual(sysAt(raw));
		expect(sysAt(req1).length).toBe(2);
		expect(req1[0]).toEqual(raw[0]);

		// request 2 of the same run: the assistant answered with a tool call and its result came back
		const a = r.sm.appendMessage(asst([call("c7")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("c7", "short output", 10_000_002));
		const req2 = await r.request();
		for (const mid of [true, false]) expect(llm(req2.slice(0, req1.length), mid)).toBe(llm(req1, mid));

		// turn_end persists the plan, then request 3 is built from the persisted projection
		const entries = await r.turnEnd(a, asst([call("c7")], "toolUse"));
		expect(entries.filter((e: Any) => e.type === "context_edit").length).toBeGreaterThan(0);
		r.sm.appendMessage(asst([{ type: "text", text: "ok" }], "stop", 10_000_003));
		const req3 = await r.request();
		for (const mid of [true, false]) {
			expect(llm(req3.slice(0, req2.length), mid)).toBe(llm(req2, mid));
			expect(llm(req3.slice(0, req1.length), mid)).toBe(llm(req1, mid));
		}
		expect(req3.filter(isFolded).length).toBe(req1.filter(isFolded).length);
		expect(sysAt(req3)).toEqual(sysAt(req1)); // still in place after persisting
	});

	test("a summary cut: request N equals request N+1 (replayed system message, summary, kept messages)", async () => {
		const r = await rig((sm) => populate(sm, 6000)); // long assistant prose: folds alone cannot reach the cap, so a summary is planned (and its uncached call pays: X ~ 70K)
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(r.narrativeCalls.length).toBe(1);
		expect(req1.filter((m) => m.role === "system").length).toBe(1); // collapsed, exactly like Pi's compaction projection
		const a = r.sm.appendMessage(asst([call("c8")], "toolUse", 10_000_001));
		r.sm.appendMessage(result("c8", "tiny", 10_000_002));
		const req2 = await r.request();
		await r.turnEnd(a, asst([call("c8")], "toolUse"));
		const req3 = await r.request();
		for (const mid of [true, false]) {
			expect(llm(req2.slice(0, req1.length), mid)).toBe(llm(req1, mid));
			expect(llm(req3, mid)).toBe(llm(req2, mid));
		}
	});

	test("a summary and a fold persisted together: Pi's 'Compacted from N' is its usage-based size before the edits, not chars/4 of a half-applied batch", async () => {
		const r = await rig((sm) => populate(sm, 6000));
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
		// the response that carried the plan reports a real prompt size; the turn's tool result follows it
		const real = { ...usage, input: 40_000, totalTokens: 40_050 };
		const a = r.sm.appendMessage({ ...asst([call("c8")], "toolUse", 10_000_001), usage: real });
		r.sm.appendMessage(result("c8", "y".repeat(4_000), 10_000_002));
		const piBefore = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens; // what Pi reads before any draft
		expect(piBefore).toBe(40_050 + Math.ceil(4_000 / 4)); // usage + the trailing tool result at chars/4
		const all = await r.turnEnd(a, { ...asst([call("c8")], "toolUse"), usage: real });
		expect(all.at(-1)).toMatchObject({ type: "custom", customType: "pi-zip/commit", data: { carried: true } }); // a run plan: the run's requests had carried these edits
		const drafts = all.filter((d: Any) => d.type !== "custom");
		expect(drafts.map((d: Any) => d.type)).toEqual(["compaction", ...drafts.slice(1).map(() => "context_edit")]);
		expect(drafts.length).toBeGreaterThan(1); // a fold in the kept part rides along
		const comp = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
		expect(comp.tokensBefore).toBe(piBefore);
	});

	test("our replayed system message equals pi-ai's getCurrentSystemMessage", async () => {
		const r = await rig();
		const msgs = r.projectionMessages();
		const ours = collapseSystem(msgs);
		const theirs = getCurrentSystemMessage(msgs as Any);
		expect(ours).toEqual(theirs as Any);
		const collapsed = collapseSystemMessages({ messages: convertToLlm(msgs) as Any });
		expect(collapsed.messages[0]).toMatchObject({ role: "system" });
	});

	test("aborted turn: the tool call without a result does not make the guard reject the save", async () => {
		const r = await rig();
		sendPrompt(r.sm, "next request");
		await r.request();
		const a = r.sm.appendMessage(asst([{ type: "text", text: "hm" }], "stop", 10_000_001));
		const entries = await r.turnEnd(a, asst([{ type: "text", text: "hm" }], "stop"));
		expect(entries.some((e: Any) => e.type === "context_edit")).toBe(true);
	});
});

describe("real Pi: a summary prepared while the user was away goes in through Pi's own compaction (pi-tricks §1b, variant 1)", () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = () => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		return [sm.getHeader() as Any, ...sm.getEntries()];
	};
	/** The end of the previous run, the user away past the TTL (the away timer prepares the summary), then the cold return. */
	async function coldReturn(file: Any[], native: boolean, settings?: Any) {
		const r = await rig(undefined, { file, tui: true, native, idle: native, start: false, settings }); // not idle: the draft path
		await r.settle();
		await sleep(250); // the timer fired at 0.8 x 100 ms and the (stubbed) narrative call returned
		await r.beforeAgentStart("next request");
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		await sleep(5); // the notice is appended right after the request view (setTimeout 0)
		return { r, req1, drafts: [] as Any[] };
	}
	const lastNotice = (sm: SessionManager) => (sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "0.1"; });

	test("the run's first request carries exactly the bytes of the draft path; Pi's [compaction] figure is the notice's before", async () => {
		const file = template();
		const a = await coldReturn(file, false), b = await coldReturn(file, true);
		expect(a.r.narrativeCalls.length).toBe(1); // prepared while away, once, on both paths
		expect(b.r.narrativeCalls.length).toBe(1);
		// native: Pi's compaction entry is in the session before the prompt; draft path: nothing until turn_end
		const branchB = b.r.sm.getBranch() as Any[];
		const comp = branchB.filter((e) => e.type === "compaction");
		expect(comp).toHaveLength(1);
		expect(comp[0]).toMatchObject({ fromHook: true, details: { by: "pi-zip", via: "native", trigger: "cold" } });
		expect(branchB.indexOf(comp[0])).toBeLessThan(branchB.findIndex((e) => e.type === "message" && e.message.content === "next request"));
		expect(a.r.sm.getBranch().some((e: Any) => e.type === "compaction")).toBe(false);
		expect(a.req1.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(a.req1.some(isFolded)).toBe(true); // a fold in the kept part rides along
		for (const mid of [true, false]) expect(llm(b.req1, mid)).toBe(llm(a.req1, mid));
		const nb = lastNotice(b.r.sm);
		expect(nb.before).toBe(comp[0].tokensBefore);
		expect(nb.before).toBe(lastNotice(a.r.sm).before);
		expect(nb.desc).toContain("ready while you were away");
		// turn_end: the draft path persists the compaction (first) and the folds, the native path only the folds; request 2 is identical
		for (const x of [a, b]) {
			const id = x.r.sm.appendMessage(asst([call("c9")], "toolUse", 10_000_001));
			x.r.sm.appendMessage(result("c9", "tiny", 10_000_002));
			x.drafts = (await x.r.turnEnd(id, asst([call("c9")], "toolUse"))).filter((d: Any) => d.type !== "custom"); // (the commit marker is not an edit)
		}
		expect(a.drafts.map((d) => d.type)).toEqual(["compaction", ...a.drafts.slice(1).map(() => "context_edit")]);
		expect(b.drafts.map((d) => d.type)).toEqual(a.drafts.slice(1).map(() => "context_edit"));
		expect(b.drafts.map((d) => d.targetId)).toEqual(a.drafts.slice(1).map((d) => d.targetId));
		const a2 = await a.r.request(), b2 = await b.r.request();
		for (const mid of [true, false]) expect(llm(b2, mid)).toBe(llm(a2, mid));
	});

	test("Pi would find nothing to compact (its keepRecentTokens): pi-zip does not ask, and the draft path carries the summary", async () => {
		const b = await coldReturn(template(), true, { compaction: { keepRecentTokens: 10_000_000 } });
		expect(b.r.compactions).toHaveLength(0);
		expect(b.r.sm.getBranch().some((e: Any) => e.type === "compaction")).toBe(false);
		expect(b.req1.some((m) => m.role === "compactionSummary")).toBe(true); // request-local, as before
	});

	test("session_before_compact answers only pi-zip's own request: Pi's or /compact's compaction gets undefined", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: true });
		const branch = r.sm.getBranch();
		const preparation = prepareCompaction(branch as Any, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 2_000 });
		expect(preparation).toBeDefined();
		const out = await r.runner.emit({ type: "session_before_compact", preparation, branchEntries: branch, reason: "threshold", willRetry: false, signal: new AbortController().signal } as Any);
		expect(out).toBeUndefined();
	});
});

describe("real Pi: another extension's session_before_compact handler takes part in pi-zip's compaction (Pi runs them all)", () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = (extra?: (sm: SessionManager) => void) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		extra?.(sm);
		return [sm.getHeader() as Any, ...sm.getEntries()];
	};
	const moreTurns = (sm: SessionManager, ts: number, n: number) => {
		for (let i = 0; i < n; i++) {
			sm.appendMessage(user(`later ${i}`, ts + 2 * i));
			sm.appendMessage(asst([{ type: "text", text: `later done ${i} ${"explanation ".repeat(6000)}` }], "stop", ts + 2 * i + 1));
		}
	};
	const OTHER = (e: Any) => ({ compaction: { summary: "OTHER SUMMARY", firstKeptEntryId: e.preparation.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore, details: { by: "other" } } });
	/** Another extension's own keep policy: it keeps the last three turns (from "request 4"), more than Pi's 20K tokens would. */
	const OTHER_KEEPS_MORE = (e: Any) => ({ compaction: { ...OTHER(e).compaction, firstKeptEntryId: e.branchEntries.find((x: Any) => x.type === "message" && x.message.content === "request 4").id } });
	const PIZIP = "[summary of earlier conversation by pi-zip]";
	let ledger = "";
	beforeEach(() => {
		process.env.PI_ZIP_TTL_SECS = "0.1";
		process.env.PI_ZIP_NATIVE_MS = "200"; // the deadline of pi-zip's own compaction (2 s in production)
		ledger = `/tmp/pi-zip-coexist-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`;
		process.env.PI_ZIP_LEDGER = ledger;
	});
	afterEach(() => {
		delete process.env.PI_ZIP_NATIVE_MS;
		delete process.env.PI_ZIP_LEDGER;
		rmSync(ledger, { force: true });
	});
	const rows = (type: string): Any[] => {
		try {
			return readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === type);
		} catch {
			return [];
		}
	};
	/** Away past the TTL: settle plans, the timer prepares the summary (stubbed narrative call). */
	const away = async (r: Any) => {
		await r.settle();
		await sleep(250);
	};
	/** The return: before_agent_start (timed: the user's prompt waits for it), Pi appends the prompt, the run's first request. */
	const back = async (r: Any, text = "next request", ts = 10_000_000) => {
		const t0 = performance.now();
		await r.beforeAgentStart(text);
		const waited = performance.now() - t0;
		r.sm.appendMessage(user(text, ts));
		const req1 = (await r.request()) as Any[];
		await sleep(5);
		return { req1, waited };
	};
	const finishTurn = async (r: Any, ts = 10_000_001) => {
		const id = r.sm.appendMessage(asst([call("c9")], "toolUse", ts));
		r.sm.appendMessage(result("c9", "tiny", ts + 1));
		return (await r.turnEnd(id, asst([call("c9")], "toolUse"))) as Any[];
	};
	const comps = (r: Any) => (r.sm.getBranch() as Any[]).filter((e) => e.type === "compaction");
	const summaries = (req: Any[]) => req.filter((m) => m.role === "compactionSummary").map((m) => String(m.summary));

	test("loaded after pi-zip, it answers with its own summary (Pi keeps the last answer): that compaction stays the only one; pi-zip neither adopts its prepared summary nor writes one on top", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at: "after", on: OTHER_KEEPS_MORE } });
		await away(r);
		const { req1 } = await back(r);
		expect(r.foreignCalls).toEqual(["manual"]); // Pi ran it for pi-zip's compaction
		expect(comps(r).map((c) => c.summary)).toEqual(["OTHER SUMMARY"]);
		expect(summaries(req1)).toEqual(["OTHER SUMMARY"]); // nothing of pi-zip's on top of it
		const drafts = await finishTurn(r);
		expect(drafts.filter((d) => d.type === "compaction")).toEqual([]);
		expect(comps(r)).toHaveLength(1);
		expect(r.narrativeCalls.length).toBe(1); // the summary prepared while away, and no second one
		expect((r.sm.getBranch() as Any[]).some((e) => e.type === "custom" && e.customType === "pi-zip/unused-summary")).toBe(true); // discarded: its cost is booked
		expect(rows("native_off").map((x) => x.reason)).toEqual(["another extension's compaction went in instead of pi-zip's"]);
	});

	test("loaded before pi-zip, it answers at once: pi-zip's answer comes last and wins; the native path stays on", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at: "before", on: OTHER } });
		await away(r);
		const { req1 } = await back(r);
		expect(r.foreignCalls).toEqual(["manual"]);
		expect(comps(r)).toHaveLength(1);
		expect(comps(r)[0]).toMatchObject({ fromHook: true, details: { by: "pi-zip", via: "native" } });
		expect(summaries(req1)).toHaveLength(1);
		expect(summaries(req1)[0]).toContain(PIZIP);
		expect(rows("native_off")).toEqual([]);
	});

	test("loaded before pi-zip, it takes its time (it writes its own summary, ignoring the abort): cancelled at the deadline, the prompt goes on at once, nothing lands later, the draft path carries pi-zip's summary", async () => {
		const seen: Any = {};
		const slow = async (e: Any) => {
			await sleep(1_000);
			seen.aborted = e.signal.aborted;
			return OTHER(e);
		};
		const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at: "before", on: slow } });
		await away(r);
		const { req1, waited } = await back(r);
		expect(waited).toBeLessThan(600); // the deadline (200 ms here), not the 1 s the other handler takes
		expect(comps(r)).toEqual([]);
		expect(summaries(req1)).toHaveLength(1);
		expect(summaries(req1)[0]).toContain(PIZIP); // request-local, as on the draft path
		await sleep(1_100); // the other handler has answered by now; Pi's compaction ends, cancelled
		expect(seen.aborted).toBe(true);
		expect(r.compactCalls).toEqual({ n: 1, ended: 1 });
		expect(comps(r)).toEqual([]); // nothing went in during the run
		const drafts = await finishTurn(r);
		expect(drafts.filter((d) => d.type === "compaction").map((d) => d.details)).toEqual([{ by: "pi-zip", trigger: "cold", carried: true }]);
		expect(comps(r)).toHaveLength(1);
		expect(rows("native_off").map((x) => x.reason)).toEqual(["another session_before_compact handler ran before pi-zip's (cancelled after 200 ms)"]);
	});

	test("loaded before pi-zip, it finishes in time but not at once (a model call, say): pi-zip's answer wins this once, then the native path ends, so that call is not paid for and waited for at every cold return", async () => {
		process.env.PI_ZIP_NATIVE_MS = "2000"; // the production deadline: 400 ms is inside it, and over the 250 ms of a compaction that is pi-zip's alone
		const modelCall = async (e: Any) => (await sleep(400), OTHER(e));
		const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at: "before", on: modelCall } });
		await away(r);
		const first = await back(r);
		expect(comps(r).map((c) => c.details)).toEqual([{ by: "pi-zip", via: "native", trigger: "cold" }]);
		expect(summaries(first.req1)[0]).toContain(PIZIP);
		expect(rows("native_off").map((x) => x.reason)).toEqual([expect.stringMatching(/^Pi's compaction took \d+ ms: another session_before_compact handler at work$/)]);
		await finishTurn(r);
		moreTurns(r.sm, 10_100_000, 3);
		await away(r);
		const second = await back(r, "and again", 10_200_000);
		expect(second.waited).toBeLessThan(300);
		expect(r.compactCalls.n).toBe(1);
		expect(r.foreignCalls).toEqual(["manual"]);
		expect(rows("native_skip").map((x) => x.reason)).toEqual(["off for this process"]);
		expect(summaries(second.req1)).toHaveLength(1);
		expect(summaries(second.req1)[0]).toContain(PIZIP); // the draft path carries it, as before
	});

	test("loaded after pi-zip, it takes its time: pi-zip does not wait past the deadline, and Pi's compaction is cancelled, so its late result never lands during the run", async () => {
		const seen: Any = {};
		const slow = async (e: Any) => {
			await sleep(1_000);
			seen.aborted = e.signal.aborted;
			return undefined; // pi-zip's answer would stand
		};
		const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at: "after", on: slow } });
		await away(r);
		const { req1, waited } = await back(r);
		expect(waited).toBeLessThan(600);
		expect(comps(r)).toEqual([]);
		expect(summaries(req1)[0]).toContain(PIZIP);
		await sleep(1_100);
		expect(seen.aborted).toBe(true);
		expect(r.compactCalls).toEqual({ n: 1, ended: 1 });
		expect(comps(r)).toEqual([]); // pi-zip's answer was the last one, but Pi saw its abort signal before appending
		const drafts = await finishTurn(r);
		expect(drafts.filter((d) => d.type === "compaction")).toHaveLength(1);
		expect(comps(r)).toHaveLength(1);
		expect(rows("native_off").map((x) => x.reason)).toEqual(["Pi's compaction was not done 200 ms after pi-zip answered (cancelled)"]);
	});

	for (const at of ["before", "after"] as const) {
		test(`loaded ${at} pi-zip, it cancels manual compactions: the draft path takes the summary, and the next cold return does not ask Pi again`, async () => {
			const cancels = (e: Any) => (e.reason === "manual" ? { cancel: true } : undefined);
			const r = await rig(undefined, { file: template(), tui: true, native: true, start: false, foreign: { at, on: cancels } });
			await away(r);
			const first = await back(r);
			expect(r.compactCalls.n).toBe(1);
			expect(comps(r)).toEqual([]);
			expect(summaries(first.req1)[0]).toContain(PIZIP);
			const drafts = await finishTurn(r);
			expect(drafts[0]).toMatchObject({ type: "compaction", details: { by: "pi-zip" } });
			expect(rows("native_off").map((x) => x.reason)).toEqual(["Pi's compaction failed: Compaction cancelled"]);
			// the next cold return in this process: no second ctx.compact (Pi's red "Compaction cancelled" at most once)
			moreTurns(r.sm, 10_100_000, 3); // still in the past: every message is hours old, so this return is cold too
			await away(r);
			const second = await back(r, "and again", 10_200_000);
			expect(r.narrativeCalls.length).toBe(2);
			expect(r.compactCalls.n).toBe(1);
			expect(r.foreignCalls).toEqual(["manual"]);
			expect(summaries(second.req1)).toHaveLength(1);
			expect(summaries(second.req1)[0]).toContain(PIZIP);
			expect(rows("native_skip").map((x) => x.reason)).toEqual(["off for this process"]);
		});
	}

	test("a compaction another extension supplied is already in the branch: pi-zip does not ask Pi at all (that extension's handler would run for pi-zip's too)", async () => {
		const file = template((sm) => {
			const kept = sm.getBranch().filter((e: Any) => e.type === "message" && e.message.role === "user").at(1) as Any;
			sm.appendCompaction("EARLIER OTHER SUMMARY", kept.id, 50_000, { by: "other" }, true);
			moreTurns(sm, 9_000_000, 3);
		});
		const r = await rig(undefined, { file, tui: true, native: true, start: false });
		await away(r);
		const { req1 } = await back(r);
		expect(r.compactCalls.n).toBe(0);
		expect(rows("native_skip").map((x) => x.reason)).toEqual(["another extension's compaction is in this branch"]);
		expect(summaries(req1)).toHaveLength(1);
		expect(summaries(req1)[0]).toContain(PIZIP); // the draft path, as before
	});
});

describe("real Pi: pi-zip predicts Pi's 'Nothing to compact' exactly (piCanCompact against Pi's own prepareCompaction)", () => {
	test("small, large, after a compaction, every keepRecentTokens", async () => {
		const { piCanCompact } = await import("../src/plan.ts");
		const sessions: Array<[string, SessionManager]> = [];
		const mk = (name: string, fill: (sm: SessionManager) => void) => {
			const sm = SessionManager.inMemory(CWD);
			fill(sm);
			sessions.push([name, sm]);
		};
		mk("empty", () => {});
		mk("one prompt", (sm) => sm.appendMessage(user("hi", 1)));
		mk("one turn", (sm) => { sm.appendMessage(user("hi", 1)); sm.appendMessage(asst([{ type: "text", text: "hello" }], "stop", 2)); });
		mk("populated", (sm) => populate(sm));
		mk("prose", (sm) => populate(sm, 6000));
		mk("compacted then one turn", (sm) => {
			populate(sm, 2000);
			const kept = sm.getBranch().filter((e: Any) => e.type === "message" && e.message.role === "user").at(-2) as Any;
			sm.appendCompaction("S".repeat(4_000), kept.id, 0, {}, false);
			sm.appendMessage(user("after", 9_000_000));
			sm.appendMessage(asst([{ type: "text", text: "x ".repeat(3_000) }], "stop", 9_000_001));
		});
		mk("ends with a compaction", (sm) => {
			populate(sm);
			const kept = sm.getBranch().filter((e: Any) => e.type === "message" && e.message.role === "user").at(-1) as Any;
			sm.appendCompaction("S", kept.id, 0, {}, false);
		});
		let checked = 0;
		const seen = new Set<boolean>();
		for (const [name, sm] of sessions) {
			for (const keepRecent of [0, 500, 2_000, 20_000, 60_000, 10_000_000]) {
				const branch = sm.getBranch();
				const pi = !!prepareCompaction(branch as Any, { enabled: true, reserveTokens: 16_384, keepRecentTokens: keepRecent });
				const last = branch[branch.length - 1] as Any;
				const ours = last?.type !== "compaction" && piCanCompact(sm.buildSessionProjection().entries as Any[], keepRecent);
				expect([name, keepRecent, ours]).toEqual([name, keepRecent, pi]);
				seen.add(pi);
				checked++;
			}
		}
		expect(checked).toBe(42);
		expect([...seen].sort()).toEqual([false, true]); // both answers occur
	});
});

describe("real Pi: the idle cache warmer's timing", () => {
	test("warmingDelayMs is Pi's own getCacheWarmingDelayMs", async () => {
		const { getCacheWarmingDelayMs } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js");
		const { warmingDelayMs } = await import("../src/run.ts");
		for (const ttl of [1_000, 10_000, 10_001, 10_200, 15_000, 60_000, 100_000, 300_000, 3_600_000]) expect([ttl, warmingDelayMs(ttl)]).toEqual([ttl, getCacheWarmingDelayMs(ttl)]);
	});
});

// formal/TRIAGE.md (a) 7 and 8 (A3, RDr): the summary prepared while the user is away must exist for a process that was restarted in
// between, and must be for the context the user comes back to, not the one settle saw
describe("the away summary survives a restart and a rewrite of the context while away", () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = () => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		return [sm.getHeader() as Any, ...sm.getEntries()];
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "0.1"; });

	test("a resumed process arms the away timer from the branch's last request: the summary is ready before the return (7)", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: false, idle: false, start: false }); // session_start only: no settle ever ran in this process
		await sleep(250);
		expect(r.narrativeCalls.length).toBe(1); // old code: 0 (armAway was reached only from settle)
		await r.beforeAgentStart("next request");
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(r.narrativeCalls.length).toBe(1); // adopted at the return, not written again while the user waits
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	test("a process that is not interactive, or a session that ended mid-run, prepares nothing", async () => {
		const quiet = await rig(undefined, { file: template(), tui: false, start: false });
		await sleep(250);
		expect(quiet.narrativeCalls.length).toBe(0);
		const file = template();
		file.push({ type: "message", id: "tail", parentId: file.at(-1).id, timestamp: new Date(T0).toISOString(), message: asst([call("zz")], "toolUse", 99) });
		const cut = await rig(undefined, { file, tui: true, start: false });
		await sleep(250);
		expect(cut.narrativeCalls.length).toBe(0);
	});

	test("Pi's compaction while the user is away: the timer plans again on the context as it is, the summary is for the return (8)", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: false, idle: false, start: false });
		r.narrativeCalls.length = 0;
		await r.settle(); // the plan made now has a cut at the old context
		const branch = r.sm.getBranch() as Any[];
		const keep = branch.filter((e) => e.type === "message" && e.message.role === "user")[3]; // Pi's own compaction keeps from the 4th prompt on
		r.sm.appendCompaction("Pi's own summary of the early part", keep.id, 12_000, undefined, false);
		await sleep(250); // the timer fires at 0.8 x 100 ms
		await r.beforeAgentStart("next request");
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		const summaries = req1.filter((m) => m.role === "compactionSummary");
		expect(summaries).toHaveLength(1);
		expect(JSON.stringify(summaries[0])).toContain("narrative"); // pi-zip's summary of the new context, prepared while away (old code: Pi's, then a second call while the user waits)
		expect(r.narrativeCalls.length).toBe(1); // one call, made while away
		// ... for the context as it is: what Pi's compaction replaced (the first prompts) is not in what the call reads (old code: it is)
		const read = JSON.stringify(r.narrativeCalls[0]);
		expect(read).toContain("request 4");
		expect(read).not.toContain("request 1");
		expect(read).not.toContain("request 2");
	});
});

describe("B2 for folds through the real extension: the cold return leaves its mark, the next warm prompt holds back what it protected", () => {
	test("a cold return writes pi-zip/cold right before its prompt; a warm return writes none", async () => {
		const r = await rig(); // every message is hours old: a cold return
		sendPrompt(r.sm, "next request");
		const branch = r.sm.getBranch() as Any[];
		const mark = branch.findIndex((e) => e.type === "custom" && e.customType === "pi-zip/cold");
		expect(mark).toBeGreaterThan(-1); // old code: none
		expect(branch[mark + 1]).toMatchObject({ type: "message", message: { role: "user", content: "next request" } });
		const w = await rig((sm) => { populate(sm); sm.appendMessage(asst([{ type: "text", text: "just now" }], "stop", 0)); (sm.getBranch().at(-1) as Any).message.timestamp = Date.now(); }, { start: false });
		await w.beforeAgentStart("warm");
		expect((w.sm.getBranch() as Any[]).some((e) => e.type === "custom" && e.customType === "pi-zip/cold")).toBe(false);
	});
});

describe("the notice's why line says the cache was judged cold, as the warm one says it was warm", () => {
	test("a cold return: 'cache cold · away ...'", async () => {
		const r = await rig(undefined, { tui: true }); // every message is hours old
		sendPrompt(r.sm, "next request");
		await r.request();
		await new Promise((res) => setTimeout(res, 5));
		const notice = (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
		expect(notice?.why).toMatch(/^cache cold · away [\d.]+ (s|min|h)$/); // old code: "away 3.0 h"
	});
});
