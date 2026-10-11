// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	latencyMs?: number; // the summary's model call takes this long
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
		complete: async (_m: Any, c: Any) => {
			narrativeCalls.push(c);
			if (opts.latencyMs) await new Promise((res) => setTimeout(res, opts.latencyMs));
			return { stopReason: "stop", content: [{ type: "text", text: "## Decisions\nnarrative" }], usage: { cost: { total: 0 } } };
		},
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
	// Pi's TUI hands raw input to the extensions' listeners in order (TuiBase.handleTerminalInput): one may consume it or replace the data
	const inputListeners = new Set<(data: string) => Any>();
	// Pi's editor after the listeners, reduced to what pi-zip reads (getEditorText): printable text and pastes are typed in, Backspace
	// deletes, Ctrl+C clears, Enter submits (clears); other control keys and escape sequences (Esc, arrows, Ctrl+D) change no text
	const editor = { text: "" };
	const edit = (data: string) => {
		if (data === "\x03" || data === "\r") editor.text = "";
		else if (data === "\x7f") editor.text = editor.text.slice(0, -1);
		else if (data.startsWith("\x1b[200~")) editor.text += data.slice(6).replace(/\x1b\[201~$/, "");
		else if (!data.startsWith("\x1b")) editor.text += [...data].filter((ch) => ch >= " ").join("");
	};
	const typeKey = (data: string): string | null => {
		let cur = data;
		for (const h of [...inputListeners]) {
			const r = h(cur);
			if (r?.consume) return null;
			if (r?.data !== undefined) cur = r.data;
		}
		edit(cur);
		return cur;
	};
	if (opts.tui) runner.setUIContext({ notify: noop, setWorkingMessage: noop, setStatus: noop, setWidget: noop, getEditorText: () => editor.text, onTerminalInput: (h: (data: string) => Any) => (inputListeners.add(h), () => inputListeners.delete(h)) } as Any, "tui");
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
	const shutdown = () => runner.emit({ type: "session_shutdown" } as Any);
	return { sm, runner, request, turnEnd, settle, beforeAgentStart, narrativeCalls, projectionMessages, compactions, compactCalls, foreignCalls, inputListeners, typeKey, editor, shutdown };
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
		expect(comp.details.regrow).toBeGreaterThan(0); // the size the summary started from: a restart restores when the warm-stretch flag lapses
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
	/** The session as a file whose newest response is `agoMs` old (the rig of every other test is hours old: a cold session). */
	const template = (agoMs = 0) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		return file;
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; });

	test("a resumed process arms the away timer from the branch's last request: the summary is ready before the return (7)", async () => {
		const r = await rig(undefined, { file: template(), tui: true, native: false, idle: false, start: false }); // session_start only: no settle ever ran in this process
		await sleep(1_300); // the timer fires at 0.8 x the 1 s TTL after the last response
		expect(r.narrativeCalls.length).toBe(1); // old code: 0 (armAway was reached only from settle)
		await r.beforeAgentStart("next request");
		sendPrompt(r.sm, "next request");
		const req1 = await r.request();
		expect(r.narrativeCalls.length).toBe(1); // adopted at the return, not written again while the user waits
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	test("opening an old session starts no summary call: its return is a cold return, the run plan of its next prompt handles it (review P1-1)", async () => {
		for (const agoMs of [5_000, 240 * 60_000, 7_200 * 60_000]) { // all past the 1 s TTL: the cache the session left is dead
			const r = await rig(undefined, { file: template(agoMs), tui: true, native: false, idle: false, start: false });
			await sleep(300);
			expect([agoMs, r.narrativeCalls.length]).toEqual([agoMs, 0]); // old code: 1 within ms of session_start (delay max(0, last + 0.8 TTL - now) = 0)
		}
	});

	// Restart speed: opening an old session costs nothing (above), but the user's first prompt then waits for the whole summary. The first
	// raw keystroke says they are here to work: start the summary then, so the typing time is not wasted.
	test("a reopened session whose cache is dead starts its cold summary on the first keystroke, never consumes or alters it, and unsubscribes", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		await sleep(300);
		expect(r.narrativeCalls.length).toBe(0); // opened, not typed: no call (and one listener waits)
		expect(r.inputListeners.size).toBe(1);
		expect(r.typeKey("\x1b[I")).toBe("\x1b[I"); // a focus report is not the user
		expect(r.typeKey("\x1b[?0u")).toBe("\x1b[?0u"); // nor is a kitty-keyboard reply
		await sleep(50);
		expect(r.narrativeCalls.length).toBe(0);
		// the planning (projection, planContext, the summary's synchronous part) runs after the key reached the editor, never inside the
		// input listener, where it would delay the key on a big session (review P2, first-key latency; old code: inside it)
		const proj = r.sm.buildSessionProjection.bind(r.sm);
		let inListener = 0, typing = false;
		(r.sm as Any).buildSessionProjection = (...a: Any[]) => { if (typing) inListener++; return (proj as Any)(...a); };
		typing = true;
		expect(r.typeKey("h")).toBe("h"); // the data goes on to Pi untouched
		typing = false;
		expect(inListener).toBe(0);
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(1);
		expect(r.inputListeners.size).toBe(0); // unsubscribed at the first key of a prompt
		r.typeKey("i");
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(1);
	});

	test("the prompt after the first key takes the running call: no second call, the summary is in the request, the wait is the remainder", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false, latencyMs: 2_000 });
		r.typeKey("h");
		await sleep(1_000); // typing the prompt takes 1 s of the 2 s call
		const t0 = performance.now();
		await r.beforeAgentStart("hello");
		sendPrompt(r.sm, "hello");
		const req1 = await r.request();
		const waited = performance.now() - t0;
		expect(r.narrativeCalls.length).toBe(1); // the call the key started, not a second one
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
		// it still waited for the rest of the call (~1 s), not all of it (2 s for a call started at the prompt); bounds with ~0.8 s of slack
		// either way for a loaded machine (review P2: the old 150-500 ms window on a 600 ms call was flaky)
		expect(waited).toBeGreaterThan(200);
		expect(waited).toBeLessThan(1_800);
	});

	// 0.3.1 live, first restart: durable-subagents posted a display-only note at session start ("1 workflow was paused"). After the final
	// answer it opened a turn (it could have started a run), so the first-key plan, counting the prompt as one more turn on top, protected
	// only the note and cut there; the real prompt joins the note's turn (a prompt right after its starter is one turn) and the run plan
	// cut one turn earlier: the key's summary was thrown away (booked unused) and the user waited for a second one, in full.
	test("a display-only custom message after the final answer: the first-key summary cuts where the prompt's run plan cuts (no second call)", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false, latencyMs: 300 });
		r.sm.appendCustomMessageEntry("dsa-note", "1 subagent workflow was paused when pi quit", true);
		r.typeKey("h");
		await sleep(50);
		expect(r.narrativeCalls.length).toBe(1);
		await r.beforeAgentStart("hello");
		sendPrompt(r.sm, "hello");
		const req1 = await r.request();
		expect(req1.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(r.narrativeCalls.length).toBe(1); // old code: 2 (the key's call cut at the note, the run plan one turn earlier)
		expect(r.sm.getEntries().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/summary" && !e.data?.cut)).toEqual([]); // no call ended unused
	});

	// review P1-1: the usual "open, look, leave" (Ctrl+D, Ctrl+C twice, Esc, arrows, /quit, /resume to another session) is not typing a
	// prompt; the old code started the paid call at the first of those keys (isKeystroke accepts control keys and "/")
	test("keys that do not type a prompt start nothing: Ctrl+C, Ctrl+D, Esc, arrows, /quit, /resume; the listener stays until a prompt is typed", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		for (const k of ["\x04", "\x03", "\x03", "\x1b", "\x1b[A", "\x1b[B", "\r", "/", "q", "u", "i", "t"]) {
			r.typeKey(k);
			await sleep(5);
		}
		await sleep(100);
		expect(r.editor.text).toBe("/quit");
		expect(r.narrativeCalls.length).toBe(0); // old code: 1, started by Ctrl+D
		expect(r.inputListeners.size).toBe(1);
		r.typeKey("\x03"); // cleared; then /resume pasted
		r.typeKey("\x1b[200~/resume\x1b[201~");
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(0);
		await r.shutdown(); // left without typing a prompt: no call, no listener
		expect(r.inputListeners.size).toBe(0);
		expect(r.narrativeCalls.length).toBe(0);
	});

	// review P1-2: arming used the declared TTL and the key planned with P(warm) = 0, while the prompt judges the return with the learned
	// survival; a restart inside a learned-warm window paid for a summary the warm prompt then threw away
	test("a cache learned to outlive its declared TTL: a restart past the TTL but inside the learned window arms nothing and typing starts no call", async () => {
		const savedTtl = process.env.PI_ZIP_TTL_SECS, savedStats = process.env.PI_ZIP_CACHE_STATS;
		delete process.env.PI_ZIP_TTL_SECS; // the learned survival is used only without the test override (cache.ts detectCold)
		process.env.PI_ZIP_CACHE_STATS = join(mkdtempSync(join(tmpdir(), "pi-zip-learned-")), "cache-survival.json");
		// p/m (declared 300 s) was read in full four times after gaps of 360-420 s (GLM-like)
		writeFileSync(process.env.PI_ZIP_CACHE_STATS, JSON.stringify({ v: 1, models: { "p/m": { cls: "explicit", bins: { "6": [4, 0], "7": [4, 0] }, n: 8 } } }));
		try {
			const r = await rig(undefined, { file: template(380_000), tui: true, native: false, idle: false, start: false }); // 380 s: past 300 s
			// the return is warm: no cold summary is armed. Rule A arms the summary the WARM plan makes (this context is big enough for one),
			// and the warm prompt then uses it (old code: a summary planned at P(warm) = 0, thrown away by the warm prompt)
			expect(r.inputListeners.size).toBe(1);
			r.typeKey("h");
			await sleep(150);
			expect(r.narrativeCalls.length).toBe(1);
			await r.beforeAgentStart("hello");
			sendPrompt(r.sm, "hello");
			const req = await r.request();
			expect(req.some((m) => m.role === "compactionSummary")).toBe(true); // the summary the key started, adopted
			expect(r.narrativeCalls.length).toBe(1); // ... not written a second time
			// the same session past the learned window (bin 8, 420-480 s, never observed: the declared TTL's prior decides): armed, and typing starts it
			const late = await rig(undefined, { file: template(2 * 3_600_000), tui: true, native: false, idle: false, start: false });
			expect(late.inputListeners.size).toBe(1);
			late.typeKey("h");
			await sleep(150);
			expect(late.narrativeCalls.length).toBe(1);
		} finally {
			if (savedTtl === undefined) delete process.env.PI_ZIP_TTL_SECS; else process.env.PI_ZIP_TTL_SECS = savedTtl;
			process.env.PI_ZIP_CACHE_STATS = savedStats;
		}
	});

	test("a command typed and erased, then a prompt: the first character of the prompt starts the summary", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		for (const k of ["/", "m", "\x7f", "\x7f"]) r.typeKey(k);
		await sleep(50);
		expect(r.narrativeCalls.length).toBe(0);
		r.typeKey(" "); // whitespace alone is not a prompt
		await sleep(50);
		expect(r.narrativeCalls.length).toBe(0);
		r.typeKey("f");
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(1);
		expect(r.inputListeners.size).toBe(0);
	});

	test("a session opened and closed without typing makes no call; one with no UI (pi -p, a subagent) never listens", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		expect(r.inputListeners.size).toBe(1);
		await r.shutdown();
		expect(r.inputListeners.size).toBe(0);
		r.typeKey("h");
		await sleep(150);
		expect(r.narrativeCalls.length).toBe(0);
		const quiet = await rig(undefined, { file: template(240 * 60_000), tui: false, start: false });
		expect(quiet.inputListeners.size).toBe(0);
		quiet.typeKey("h");
		await sleep(150);
		expect(quiet.narrativeCalls.length).toBe(0);
	});

	test("a key when the cold plan has no summary starts nothing; a prompt without any key leaves no listener behind", async () => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 0); // short prose: folds reach the cap, no cut
		const small = [sm.getHeader() as Any, ...sm.getEntries()];
		const shift = Date.now() - 240 * 60_000 - Math.max(...small.map((e) => e.message?.timestamp ?? 0));
		for (const e of small) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		const a = await rig(undefined, { file: small, tui: true, native: false, idle: false, start: false });
		a.typeKey("h");
		await sleep(100);
		expect(a.narrativeCalls.length).toBe(0);
		const b = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false, latencyMs: 50 });
		expect(b.inputListeners.size).toBe(1);
		await b.beforeAgentStart("typed elsewhere"); // a prompt that did not come through the keyboard: the listener goes away
		expect(b.inputListeners.size).toBe(0);
	});

	test("a restart between the 0.8 mark and the TTL starts the call at once, as the live process's timer would have (formal A3)", async () => {
		process.env.PI_ZIP_TTL_SECS = "30";
		const r = await rig(undefined, { file: template(27_000), tui: true, native: false, idle: false, start: false }); // 27 s of 30: past 24 s (0.8), before 30 s
		await sleep(400);
		expect(r.narrativeCalls.length).toBe(1); // the user may come back after the TTL: the summary is ready
		const early = await rig(undefined, { file: template(5_000), tui: true, native: false, idle: false, start: false }); // before the mark: a timer, not a call
		await sleep(400);
		expect(early.narrativeCalls.length).toBe(0);
	});

	test("a process that is not interactive, or a session that ended mid-run, prepares nothing", async () => {
		const quiet = await rig(undefined, { file: template(), tui: false, start: false });
		await sleep(1_300);
		expect(quiet.narrativeCalls.length).toBe(0);
		const file = template();
		file.push({ type: "message", id: "tail", parentId: file.at(-1).id, timestamp: new Date().toISOString(), message: asst([call("zz")], "toolUse", 99) });
		const cut = await rig(undefined, { file, tui: true, start: false });
		await sleep(1_300);
		expect(cut.narrativeCalls.length).toBe(0);
	});

	test("Pi's compaction while the user is away: the timer plans again on the context as it is, the summary is for the return (8)", async () => {
		process.env.PI_ZIP_TTL_SECS = "0.1";
		const r = await rig(undefined, { file: template(3_600_000), tui: true, native: false, idle: false, start: false });
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
		// two calls, both while away: rule A's early one at settle (a warm return would have summarised the old context too), dropped when
		// the timer found the context rewritten, and the away timer's, adopted (0.3.0: the timer's only)
		expect(r.narrativeCalls.length).toBe(2);
		// ... for the context as it is: what Pi's compaction replaced (the first prompts) is not in what the call reads (old code: it is)
		const read = JSON.stringify(r.narrativeCalls.at(-1));
		expect(read).toContain("request 4");
		expect(read).not.toContain("request 1");
		expect(read).not.toContain("request 2");
	});
});
describe("item 5: a run an extension's message starts (sendMessage with triggerTurn) never fires before_agent_start; agent_start does", () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = (agoMs: number) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		return file;
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "1"; });
	/** What Pi does for sendCustomMessage({ ..., triggerTurn: true }) on an idle session: agent_start, the message appended, the first request. */
	const drive = async (r: Any, text = "drive the owed work") => {
		await r.runner.emit({ type: "agent_start" } as Any);
		r.sm.appendCustomMessageEntry("owed-drive", text, true);
		return r.request();
	};

	test("a driven run after a gap longer than the TTL gets the cold plan (old code: no plan, a full cold rewrite of the whole context)", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		const req = await drive(r);
		expect(req.some((m) => m.role === "compactionSummary")).toBe(true); // the summary the folds alone could not replace
		expect(r.narrativeCalls.length).toBe(1);
		expect(req.some(isFolded) || req.some((m) => m.role === "compactionSummary")).toBe(true);
		expect(req.some((m) => m.role === "custom")).toBe(true); // the message that started the run is kept
	});

	test("a summary prepared while away is adopted by the driven run (one call), and ctx.compact() is never called: it would abort the run that is starting", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false });
		r.typeKey("h"); // the first key of the reopened session starts the summary
		await sleep(150);
		expect(r.narrativeCalls.length).toBe(1);
		const req = await drive(r);
		expect(r.narrativeCalls.length).toBe(1); // adopted, not written again
		expect(r.compactCalls.n).toBe(0);
		expect(req.some((m) => m.role === "compactionSummary")).toBe(true);
	});

	test("a prompt still goes through before_agent_start once: agent_start after it does not start the run a second time", async () => {
		const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: false, idle: false, start: false });
		await r.beforeAgentStart("next request");
		await r.runner.emit({ type: "agent_start" } as Any);
		sendPrompt(r.sm, "next request");
		const req = await r.request();
		expect(r.narrativeCalls.length).toBe(1);
		expect(req.filter((m) => m.role === "compactionSummary")).toHaveLength(1);
	});

	// review P2: before_agent_start fired, then the prompt failed before its run started (Pi's image normalisation throws between the two):
	// no agent_start, no agent_end. The old code kept startHandled and took the next driven run's agent_start for the prompt's: that run
	// was planned on the stale start (warm, minutes ago), never as the cold return it is
	test("a prompt that fails before its run starts does not swallow the next driven run's start", async () => {
		const r = await rig(undefined, { file: template(0), tui: true, native: false, idle: false, start: false });
		await r.beforeAgentStart("look at this image"); // warm (the session's last response is 0 s old); then the prompt throws
		await sleep(1_300); // past the 1 s TTL
		await r.runner.emit({ type: "agent_start" } as Any);
		r.sm.appendCustomMessageEntry("owed-drive", "drive the owed work", true);
		await r.runner.emit({ type: "message_end", message: { role: "custom", customType: "owed-drive", content: "drive the owed work", display: true, timestamp: Date.now() } } as Any);
		await r.request();
		await sleep(5);
		const notice = (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
		expect(notice?.why).toMatch(/^cache cold/); // old code: a warm plan ("cache warm · ...") or none
	});

	test("a warm driven run (inside the TTL) is planned exactly as a warm prompt is (the valve), not as a cold return", async () => {
		process.env.PI_ZIP_TTL_SECS = "300";
		const driven = await rig(undefined, { file: template(2_000), tui: true, native: false, idle: false, start: false });
		const dReq = await drive(driven);
		const prompted = await rig(undefined, { file: template(2_000), tui: true, native: false, idle: false, start: false });
		await prompted.beforeAgentStart("next request");
		sendPrompt(prompted.sm, "next request");
		const pReq = await prompted.request();
		await new Promise((res) => setTimeout(res, 50)); // a summary either starts in the background (rule B): its call is made off the request path
		expect(driven.narrativeCalls.length).toBe(prompted.narrativeCalls.length);
		expect(dReq.some(isFolded)).toBe(pReq.some(isFolded));
		expect(dReq.some((m) => m.role === "compactionSummary")).toBe(pReq.some((m) => m.role === "compactionSummary"));
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

// Round 5: the incident (0.3.0, a warm prompt 1 min 48 s after a run that ended at 111.5K; the user waited 39 s for a summary, which went in
// as a draft whose "Compacted from N" Pi took from the post-summary request). Rules A and B against Pi's own session and draft code.
describe("round 5 on real Pi: rule A starts the warm summary early, rule B never makes the user wait for it while the cache is warm", () => {
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const template = (agoMs: number) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 6000); // long prose: folds alone cannot reach the cap, so a warm return would summarise too
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) {
			if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
			if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
		}
		return file;
	};
	const noticeOf = (r: Any) => (r.sm.getBranch().filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/notice" && !e.data?.kind).at(-1) as Any)?.data;
	const prompt = async (r: Any, text = "next request") => {
		const t0 = performance.now();
		await r.beforeAgentStart(text);
		r.sm.appendMessage(user(text, Date.now() - T0));
		const req = await r.request();
		return { req, waited: performance.now() - t0 };
	};
	beforeEach(() => { process.env.PI_ZIP_TTL_SECS = "300"; });

	test("A after a restart: a reopened session whose cache is alive and whose warm plan cuts starts that summary on the first key; opening alone costs nothing", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: true, native: false, idle: false, start: false }); // 1 min after the run: warm
		await sleep(200);
		expect(r.narrativeCalls.length).toBe(0); // opened, nothing typed
		expect(r.inputListeners.size).toBe(1); // 0.3.0: 0 (only a dead cache armed the key)
		r.typeKey("h");
		await sleep(100);
		expect(r.narrativeCalls.length).toBe(1);
		const shut = await rig(undefined, { file: template(60_000), tui: true, native: false, idle: false, start: false });
		await shut.shutdown(); // opened and closed without typing
		await sleep(100);
		expect(shut.narrativeCalls.length).toBe(0);
		expect(shut.inputListeners.size).toBe(0);
	});

	// the second case: the prompt Pi appends comes out smaller than what before_agent_start announced (pendingPrompt's estimate). The
	// warm plan must still cut where Pi's compaction just cut (review P2 #5: it hung on real(ctxAfterFolds) >= regrowAt holding with
	// equality, fell into native_mismatch and dropped the folds priced with the summary)
	for (const [label, announced] of [["same prompt", "next request"], ["real prompt smaller than announced", `next request ${"with an expanded template ".repeat(400)}`]] as const) {
		test(`warm native adoption (${label}): an early summary goes in through Pi's compaction before the prompt, Pi's 'Compacted from N' is the notice's before, no wait, the plan on the pre-compaction projection`, async () => {
			const ledger = join(mkdtempSync(join(tmpdir(), "pz-r5-native-")), "ledger.jsonl");
			const before = process.env.PI_ZIP_LEDGER;
			process.env.PI_ZIP_LEDGER = ledger;
			try {
				const r = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
				await r.settle(); // the run ends: rule A starts the warm return's summary now
				await sleep(400);
				expect(r.narrativeCalls.length).toBe(1); // 0.3.0: 0 here, then a 300 ms wait at the prompt
				const t0 = performance.now();
				await r.beforeAgentStart(announced);
				r.sm.appendMessage(user("next request", Date.now() - T0));
				const req = await r.request();
				expect(performance.now() - t0).toBeLessThan(250);
				expect(r.narrativeCalls.length).toBe(1);
				expect(r.compactCalls.n).toBe(1); // 0.3.0: 0 (a warm return never took the native path)
				expect(r.compactions).toHaveLength(1);
				const branch = r.sm.getBranch() as Any[];
				const at = branch.findIndex((e) => e.type === "compaction");
				const promptAt = branch.findIndex((e) => e.type === "message" && e.message.role === "user" && e.message.content === "next request");
				expect(at).toBeGreaterThan(-1);
				expect(at).toBeLessThan(promptAt); // one place, before the prompt
				expect(branch[at].details).toMatchObject({ by: "pi-zip", via: "native", trigger: "valve" });
				expect(req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
				const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
				expect(rows.filter((x) => x.type === "native_mismatch")).toEqual([]);
				expect(rows.find((x) => x.type === "cold_plan")).toMatchObject({ via: "native", onPre: true });
				await sleep(5);
				const n = noticeOf(r);
				expect(n.before).toBe(branch[at].tokensBefore);
				expect(n.native).toBe("ok");
				expect(n.desc).toMatch(/ready while you were away$/);
			} finally {
				if (before === undefined) delete process.env.PI_ZIP_LEDGER;
				else process.env.PI_ZIP_LEDGER = before;
			}
		});
	}

	test("B on real Pi: no wait at the warm prompt, nothing applied; a later turn_end commits the summary as a draft the next request first carries, so Pi's tokensBefore is the size before", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 600 });
		const raw = r.projectionMessages().length + 1;
		const { req, waited } = await prompt(r); // no settle ran in this process and no key was typed: nothing was started
		expect(waited).toBeLessThan(300); // 0.3.0: the whole 600 ms call (39 s in the incident)
		expect(req === undefined || (!req.some(isFolded) && !req.some((m: Any) => m.role === "compactionSummary"))).toBe(true);
		expect(r.projectionMessages().length).toBe(raw);
		await sleep(20);
		expect(r.narrativeCalls.length).toBe(1); // started in the background
		const big = (input: number): Any => ({ ...usage, input, totalTokens: input });
		// the first turn: the summary is still being written: turn_end persists nothing and does not wait
		const a1 = r.sm.appendMessage({ ...asst([call("w1")], "toolUse", 20_000_001), usage: big(110_000) });
		r.sm.appendMessage(result("w1", "small", 20_000_002));
		const t1 = performance.now();
		expect((await r.turnEnd(a1, { ...asst([call("w1")], "toolUse"), usage: big(110_000) })).filter((d: Any) => d.type === "compaction")).toEqual([]);
		expect(performance.now() - t1).toBeLessThan(200);
		await sleep(700);
		// a later turn, once it is done: the valve adopts it at turn_end
		const a2 = r.sm.appendMessage({ ...asst([call("w2")], "toolUse", 20_000_003), usage: big(111_500) });
		r.sm.appendMessage(result("w2", "y".repeat(2_000), 20_000_004));
		const piBefore = estimateProjectedContextTokens(r.sm.buildSessionProjection(), r.sm.getBranch()).tokens;
		const drafts = await r.turnEnd(a2, { ...asst([call("w2")], "toolUse"), usage: big(111_500) });
		expect(drafts.filter((d: Any) => d.type === "compaction")).toHaveLength(1);
		const comp = r.sm.getBranch().find((e: Any) => e.type === "compaction") as Any;
		expect(comp.tokensBefore).toBe(piBefore); // the size before (0.3.0's run-plan draft got the size after: "Compacted from 52,519")
		expect(comp.tokensBefore).toBe(111_500 + 500);
		expect(r.narrativeCalls.length).toBe(1);
		const next = await r.request();
		expect(next === undefined || next.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		await sleep(5);
		const n = noticeOf(r);
		expect(n.desc).toMatch(/summarized \d+ requests in [\d.]+ m?s · written while you worked$/);
		expect(Math.abs(n.before - comp.tokensBefore) / comp.tokensBefore).toBeLessThan(0.05); // the notice's before is pi-zip's estimate of the same request
	});

	test("no UI on real Pi (pi -p, json): the warm prompt waits for the summary in the request, as in 0.3.0", async () => {
		const r = await rig(undefined, { file: template(60_000), tui: false, native: true, idle: true, start: false, latencyMs: 300 });
		const { req, waited } = await prompt(r);
		expect(waited).toBeGreaterThanOrEqual(280);
		expect(req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		expect(r.compactCalls.n).toBe(0);
		const ui = await rig(undefined, { file: template(60_000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
		expect((await prompt(ui)).waited).toBeLessThan(250); // 0.3.0: the same 300 ms
	});
});

// Round 5: without a UI (pi -p, --mode json; rpc binds one on Pi 1.1) nothing runs in the background, so rules A and B change nothing there. Every request
// and every session entry of three no-UI scenarios (a warm return that summarises, a warm turn_end valve that summarises, a cold return
// that summarises), normalised only for what differs from run to run (entry ids and the handles made from them, timestamps, measured
// durations), hash to the digest 0.3.0's decision code gives with 0.3.1's summary and placeholder format: the sumfmt branch (0.3.0 plus
// the format changes, without rules A/B; head 343615f) with this test copied in, run with R5_PRINT_DIGEST=1. Before the format merge
// the same scenarios hashed to 0.3.0's own digest (d7d6ff5: bb2e4238ae92a40c61f71564ae7a465d). The claim covers the session and the
// requests only: the ledger's waitedMs changed as a fix (README, CHANGELOG; test "ledger fix" in invariants.test.ts).
describe("round 5: no UI (pi -p, json) sends the same requests and writes the same session as 0.3.0, byte for byte", () => {
	const NOUI_DIGEST_030 = "0907ceeacca2be4a8b8f684dd6a47a96"; // printed by this test on sumfmt 343615f (0.3.0 + 0.3.1 format; R5_PRINT_DIGEST=1)
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	const shifted = (agoMs: number, prose: number) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, prose);
		const file = [sm.getHeader() as Any, ...sm.getEntries()];
		const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
		const shift = Date.now() - agoMs - newest;
		for (const e of file) if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
		return file;
	};
	const big = (input: number): Any => ({ ...usage, input, totalTokens: input });
	const transcript = async (scenario: (r: Any, log: (x: Any) => void) => Promise<void>, file: Any[]) => {
		const r = await rig(undefined, { file, tui: false, native: true, idle: true, start: false });
		const out: Any[] = [];
		await scenario(r, (x) => out.push(x));
		out.push({ entries: r.sm.getEntries(), narrativeCalls: r.narrativeCalls.length });
		// normalise: entry ids (and the fold handles made from them) to ordinals, timestamps and measured durations out
		let s = JSON.stringify(out, (k, v) => (k === "timestamp" || k === "reqTs" || /(^|[a-z])(ms|Ms)$/.test(k) ? undefined : v));
		const { handleFor } = await import("../src/placeholder.ts");
		r.sm.getEntries().forEach((e: Any, i: number) => {
			s = s.split(e.id).join(`#${i}`).split(handleFor(e.id)).join(`@${i}`);
		});
		// 0.3.1 rows and placeholders carry the local time of the output (MM-DD HH:MM), which moves with the clock
		return s.replace(/\b\d\d-\d\d \d\d:\d\d\b/g, "D").replace(/\d+(\.\d+)? ?(ms|s)\b/g, "T").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "U");
	};
	const prompt = async (r: Any, log: (x: Any) => void, text: string) => {
		await r.beforeAgentStart(text);
		r.sm.appendMessage(user(text, Date.now() - T0));
		log(await r.request());
	};
	const step = async (r: Any, log: (x: Any) => void, n: number, input: number, out: string, prose = "") => {
		const a = r.sm.appendMessage({ ...asst([...(prose ? [{ type: "text", text: prose }] : []), call(`s${n}`)], "toolUse", 30_000_000 + 2 * n), usage: big(input) });
		r.sm.appendMessage(result(`s${n}`, out, 30_000_001 + 2 * n));
		log(await r.turnEnd(a, { ...asst([call(`s${n}`)], "toolUse"), usage: big(input) }));
		log(await r.request());
	};
	const scenarios = async () => {
		const parts: string[] = [];
		// warm return 60 s after a big run: the warm run plan summarises (the user waits, as in 0.3.0), drafts at the first turn_end
		parts.push(await transcript(async (r, log) => {
			await prompt(r, log, "warm return");
			await step(r, log, 1, 110_000, "small");
			await step(r, log, 2, 111_000, "y".repeat(2_000));
			log(await r.settle());
		}, shifted(60_000, 6000)));
		// a warm prompt right after a request that carried an edit (b2b: no warm edit at the prompt; the state a restarted process
		// restores, set here directly): its first turn_end valve summarises, and the user waits for it, as in 0.3.0
		parts.push(await transcript(async (r, log) => {
			const { Zip } = await import("../src/run.ts");
			const orig = (Zip.prototype as Any).beginRun;
			let zip: Any = null;
			(Zip.prototype as Any).beginRun = async function (this: Any, ...a: Any[]) {
				(Zip.prototype as Any).beginRun = orig;
				zip = this;
				this.justEdited = true;
				return orig.apply(this, a);
			};
			try {
				await prompt(r, log, "right after an edit");
			} finally {
				(Zip.prototype as Any).beginRun = orig;
			}
			zip.justEdited = false; // the prompt's response answered a request without a fresh edit (message_end, which this rig does not fire)
			await step(r, log, 1, 110_000, "small");
			await step(r, log, 2, 111_000, "small");
			log(await r.settle());
		}, shifted(60_000, 6000)));
		// a cold return (past the TTL) that summarises
		parts.push(await transcript(async (r, log) => {
			await prompt(r, log, "cold return");
			await step(r, log, 1, 110_000, "small");
			log(await r.settle());
		}, shifted(400_000, 6000)));
		return parts;
	};

	test("three no-UI scenarios hash to 0.3.0's digest; with a UI the warm return of the first one does not wait", async () => {
		const parts = await scenarios();
		const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
		if (process.env.R5_PRINT_DIGEST) console.log("R5 NO-UI DIGEST", digest, parts.map((p) => createHash("sha256").update(p).digest("hex").slice(0, 12)).join(" "));
		// every scenario summarises (a compaction draft: the warm run plan's, the warm turn_end valve's, the cold run plan's), each with one
		// narrative call made inside the hook (waited for)
		for (const p of parts) expect([p.includes('"type":"compaction"'), /"narrativeCalls":1\b/.test(p)]).toEqual([true, true]);
		expect(parts[1]).toContain('"trigger":"valve"');
		expect(digest).toBe(NOUI_DIGEST_030);
		// the same warm return with a UI: no summary in its first request (0.3.0: the summary, after the wait)
		const ui = await rig(undefined, { file: shifted(60_000, 6000), tui: true, native: true, idle: true, start: false, latencyMs: 300 });
		await ui.beforeAgentStart("warm return");
		ui.sm.appendMessage(user("warm return", Date.now() - T0));
		const t0 = performance.now();
		const req = await ui.request();
		expect(performance.now() - t0).toBeLessThan(250);
		expect(req === undefined || !req.some((m: Any) => m.role === "compactionSummary")).toBe(true);
		await sleep(400);
	});
});
