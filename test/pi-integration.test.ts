// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, getCurrentSystemMessage, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { collapseSystem } from "../src/plan.ts";
import type { Any } from "./helpers.ts";
// Pi's own draft application (AgentSession._applyBoundaryDrafts uses no instance state): the order of the drafts and the
// tokensBefore Pi writes for a compaction draft are Pi's, not a re-implementation
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
import { estimateProjectedContextTokens, prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

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
}

async function rig(setup: (sm: SessionManager) => void = populate, opts: RigOpts = {}) {
	const sm = opts.file ? SessionManager.inMemory(CWD, undefined, structuredClone(opts.file)) : SessionManager.inMemory(CWD); // the manager appends to the array it is given
	if (!opts.file) setup(sm);
	// the real loader, from the real entry file: exactly how `pi -e` loads the extension
	const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL("../src/index.ts", import.meta.url))], CWD, "/tmp/pi-zip-integration-agent", createEventBus());
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	const narrativeCalls: Any[] = [];
	const registry: Any = {
		complete: async (_m: Any, c: Any) => (narrativeCalls.push(c), { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0 } } }),
	};
	const runner = new ExtensionRunner(loaded.extensions, runtime, CWD, sm, registry);
	const noop = () => {};
	const compactions: Any[] = [];
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (minus the abort of an idle session and the UI events): Pi's own
	 *  prepareCompaction decides "Already compacted" / "Nothing to compact", session_before_compact supplies the result, appendCompaction. */
	const piCompact = (options: Any) => {
		void (async () => {
			try {
				const branch = sm.getBranch();
				const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: opts.settings?.compaction?.keepRecentTokens ?? 20_000 };
				const preparation = prepareCompaction(branch as Any, settings);
				if (!preparation) throw new Error(branch[branch.length - 1]?.type === "compaction" ? "Already compacted" : "Nothing to compact (session too small)");
				const result: Any = await runner.emit({ type: "session_before_compact", preparation, branchEntries: branch, reason: "manual", willRetry: false, signal: new AbortController().signal } as Any);
				if (result?.cancel) throw new Error("Compaction cancelled");
				if (!result?.compaction) throw new Error("rig: Pi would write its own summary with the model here");
				const c = result.compaction;
				sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
				compactions.push(c);
				options?.onComplete?.({ ...c });
			} catch (err) {
				options?.onError?.(err instanceof Error ? err : new Error(String(err)));
			}
		})();
	};
	runner.bindCore(
		{ sendMessage: noop, sendUserMessage: noop, appendEntry: (t: string, d: Any) => sm.appendCustomEntry(t, d), setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => ["read", "bash", "zip_recall"], getAllTools: () => [], getSettings: () => opts.settings ?? {}, setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop } as Any,
		{ getModel: () => MODEL, getScopedModels: () => [], isIdle: () => opts.idle !== false, isProjectTrusted: () => true, getSignal: () => undefined, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: opts.native ? piCompact : (o: Any) => o?.onError?.(new Error("rig: no compaction")), getSystemPrompt: () => "You are a coding agent." } as Any,
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
	return { sm, runner, request, turnEnd, settle, beforeAgentStart, narrativeCalls, projectionMessages, compactions };
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
		const drafts = await r.turnEnd(a, { ...asst([call("c8")], "toolUse"), usage: real });
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
			x.drafts = await x.r.turnEnd(id, asst([call("c9")], "toolUse"));
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
