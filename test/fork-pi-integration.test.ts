// Fork-only real-Pi integration cases: model switch, length recovery, summary pressure. The rig below is a copy of
// test/pi-integration.test.ts's harness (that file must not be imported: its tests would run twice). Keep the two in step.
// Integration with Pi itself: the real SessionManager, the real ExtensionRunner (emitContext, emitBoundary) and the real
// projection of persisted edits. test/helpers.ts' own projector is NOT used here, so Pi's behaviour decides what is right.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseSystemMessages, getCurrentSystemMessage, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { buildBlocks, calibrate, collapseSystem, editAllowed, UNIT, wireTokensOf } from "../src/plan.ts";
import { planContext } from "../src/plan-fork.ts";
import { decideRun, decideTurnEnd, planOpts, rentOf, unusedOf } from "../src/core.ts";
import { lawPrices, loadStats, record } from "../src/learn.ts";
import { type Any, narrativeReply } from "./helpers.ts";
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

/** Pi's event order at the start of a run. "1.1": input, before_agent_start (prompts only) and agent_start, all idle until the run is
 *  active; "1.2": input idle, then busy from before_agent_start on, which also fires (messageType "custom") for a run an extension's
 *  message starts. */
type PiOrder = "1.1" | "1.2";
const PI_ORDER: PiOrder = process.env.PZ_PI_ORDER === "1.2" ? "1.2" : "1.1";
const ORDERS: PiOrder[] = ["1.1", "1.2"];
let rigOrder: PiOrder = PI_ORDER; // the order of rigs built without one (a describe run under both orders sets it)
/** A populated session file whose newest response is `agoMs` old. */
const shiftedFile = (agoMs: number, prose: number, early?: (sm: Any) => void) => {
	const sm = SessionManager.inMemory(CWD);
	early?.(sm); // entries before the populated history (old compactions, say)
	populate(sm, prose);
	const file = [sm.getHeader() as Any, ...sm.getEntries()];
	const newest = Math.max(...file.map((e) => e.message?.timestamp ?? 0));
	const shift = Date.now() - agoMs - newest;
	for (const e of file) {
		if (typeof e.message?.timestamp === "number") e.message.timestamp += shift;
		if (typeof e.timestamp === "string" && e.type !== undefined && e.type !== "session") e.timestamp = new Date(Date.parse(e.timestamp) + shift).toISOString();
	}
	return file;
};

interface RigOpts {
	file?: Any[]; // start from these session file entries (same entry ids in every rig built from them)
	tui?: boolean; // an interactive session (settle prepares, the away timer runs)
	native?: boolean; // ctx.compact is Pi's compaction path (prepareCompaction, session_before_compact, appendCompaction)
	idle?: boolean; // ctx.isIdle() while no run is active (default true)
	start?: boolean; // start a prompt right away (default true)
	pi?: PiOrder; // the event order of Pi's run start (default PI_ORDER)
	settings?: Any;
	model?: Any;
	// another extension's session_before_compact handler (Pi runs every extension's for pi-zip's compaction too), loaded before or after pi-zip
	boundary?: (e: Any, ctx: Any) => Any; // a preceding extension drafts edits at turn_end
	foreign?: { at: "before" | "after"; on: (e: Any, ctx: Any) => Any };
	input?: (e: Any, ctx: Any) => Any; // another extension's input handler, loaded after pi-zip
	latencyMs?: number; // the summary's model call takes this long
	onAbort?: () => void; // connect abort to the real agent loop in request-safety tests
}

async function rig(setup: (sm: SessionManager) => void = populate, opts: RigOpts = {}) {
	const sm = opts.file ? SessionManager.inMemory(CWD, undefined, structuredClone(opts.file)) : SessionManager.inMemory(CWD); // the manager appends to the array it is given
	if (!opts.file) setup(sm);
	// the real loader, from the real entry file: exactly how `pi -e` loads the extension
	const bus = createEventBus();
	const source = process.env.PI_ZIP_TEST_SRC ?? fileURLToPath(new URL("../src", import.meta.url));
	const { ZipFork: Zip } = await import(join(source, "run-fork.ts"));
	const loaded = await discoverAndLoadExtensions([join(source, "index.ts")], CWD, "/tmp/pi-zip-integration-agent", bus);
	expect(loaded.errors).toEqual([]);
	const runtime = loaded.runtime;
	let extensions = loaded.extensions;
	const foreignCalls: string[] = [];
	const abortsInRun = { n: 0 }; // ctx.abort() while a run is starting or running: it would abort that run
	if (opts.foreign) {
		const f = opts.foreign;
		const other = await loadExtensionFromFactory((api: Any) => api.on("session_before_compact", async (e: Any, c: Any) => (foreignCalls.push(e.reason), f.on(e, c))), CWD, bus, runtime, "<other-compactor>");
		extensions = f.at === "before" ? [other, ...extensions] : [...extensions, other];
	}
	if (opts.input) extensions = [...extensions, await loadExtensionFromFactory((api: Any) => api.on("input", opts.input), CWD, bus, runtime, "<other-input>")];
	if (opts.boundary) {
		const other = await loadExtensionFromFactory((api: Any) => api.on("turn_end", opts.boundary), CWD, bus, runtime, "<other-editor>");
		extensions = [other, ...extensions];
	}
	const narrativeCalls: Any[] = [], narrativeModels: Any[] = [];
	const registry: Any = {
		complete: async (_m: Any, c: Any) => {
			narrativeCalls.push(c);
			narrativeModels.push(_m);
			if (opts.latencyMs) await new Promise((res) => setTimeout(res, opts.latencyMs));
			return { stopReason: "stop", content: [{ type: "text", text: narrativeReply(c) }], usage: { cost: { total: 0 } } };
		},
	};
	const runner = new ExtensionRunner(extensions, runtime, CWD, sm, registry);
	const noop = () => {};
	const checks = { carry: [] as string[], notices: [] as string[], sizes: [] as string[] };
	const reports: { after: number; scale: { O: number; c: number }; kind: string }[] = [];
	// Count the resulting Pi messages, independently of the selected edit and its savings arithmetic.
	const checkSizes = (messages: Any[]) => {
		for (const report of reports.splice(0)) {
			const actual = report.scale.O + report.scale.c * messages.filter((m) => m.role !== "system").reduce((n, m) => n + wireTokensOf(m), 0);
			if (!Number.isFinite(report.after) || report.after < 0 || Math.abs(report.after - actual) > Math.max(2, actual * 0.1)) checks.sizes.push(`${report.kind}: ${report.after} differs from resulting context ${actual}`);
		}
	};
	integrationChecks.push(checks);
	let zip: Any;
	let actualRequest: Any[] | null = null;
	let turn = 0, ended = false;
	const noticeCounts = new Map<number, number>();
	const appendEntry = (type: string, data: Any) => {
		if (type === "pi-zip/notice" && !data?.kind) {
			const count = (noticeCounts.get(turn) ?? 0) + 1;
			noticeCounts.set(turn, count);
			if (count > 1) checks.notices.push(`turn ${turn}: ${count} notices`);
		}
		sm.appendCustomEntry(type, data);
	};
	const containsCut = (messages: Any[] | null, cut: Any) => !!messages?.some((m) => m.role === "compactionSummary" && m.summary === (cut.text ?? cut.summary));
	const containsFold = (messages: Any[] | null, targetId: string, content: Any) => {
		const target = sm.getBranch().find((e: Any) => e.id === targetId) as Any;
		return !!messages?.some((m) => m.role === target?.message?.role && m.toolCallId === target?.message?.toolCallId && JSON.stringify(m.content) === JSON.stringify(content));
	};
	const compactions: Any[] = [];
	const compactCalls = { n: 0, ended: 0 };
	let compacting: AbortController | null = null; // Pi's _compactionAbortController: ctx.abort() reaches it (abort -> abortCompaction)
	let busy = false; // a run is active (Pi's _isAgentRunActive): from agent_start, on Pi 1.2.0 from before_agent_start, to settle
	const order: PiOrder = opts.pi ?? rigOrder;
	let model = opts.model ?? MODEL; // Pi's current model (an extension may choose another, at before_agent_start say)
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (minus the abort of an idle session and the UI events): Pi's own
	 *  prepareCompaction decides "Already compacted" / "Nothing to compact", session_before_compact supplies the result (every extension's
	 *  handler in load order: the last answer wins, a cancel stops it), the abort signal is checked right before appendCompaction. */
	const piCompact = (options: Any) => {
		void (async () => {
			await Promise.resolve(); // compact() awaits abort() before it sets its controller: Pi is idle until then
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
		{ sendMessage: noop, sendUserMessage: noop, appendEntry, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => ["read", "bash", "zip_recall"], getAllTools: () => [], getSettings: () => opts.settings ?? {}, setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop } as Any,
		{ getModel: () => model, getScopedModels: () => [], isIdle: () => opts.idle !== false && !compacting && !busy, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { if (busy) abortsInRun.n++; compacting?.abort(); opts.onAbort?.(); }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: opts.native ? piCompact : (o: Any) => o?.onError?.(new Error("rig: no compaction")), getSystemPrompt: () => "You are a coding agent." } as Any,
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
	const request = async () => {
		if (ended) { turn++; ended = false; }
		const messages = await runner.emitContext(projectionMessages()) as Any[];
		actualRequest = structuredClone(messages);
		const plan = zip.runPlan;
		if (plan && !plan.persisted) {
			let carriesView = !!(plan.cut || plan.native) && containsCut(messages, plan.cut ?? plan.native);
			for (const fold of plan.folds) {
				const carried = containsFold(messages, fold.entryId, [{ type: "text", text: fold.ph }]);
				carriesView ||= carried;
				if (!!plan.applied?.has(fold.entryId) !== carried) checks.carry.push("applied fold flag disagrees with request");
			}
			if (!!plan.sent !== carriesView) checks.carry.push("sent flag disagrees with request");
			if (plan.sent && (plan.cut || plan.native) && !containsCut(messages, plan.cut ?? plan.native)) checks.carry.push("sent summary absent from request");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		checkSizes(messages);
		assertIntegrationChecks();
		return messages;
	};
	const build = (drafts: Any[]) => {
		const preview = SessionManager.inMemory(CWD, undefined, [sm.getHeader() as Any, ...sm.getBranch()]);
		apply(preview, drafts);
		const projection = preview.buildSessionProjection(), llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages.at(-1)?.role;
		return { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages, pendingMessages: [], canContinue: llmMessages.some((m: Any) => m.role !== "system") && finalRole !== "assistant" };
	};
	/** What Pi's agent session does at turn_end: boundary handlers propose entries, the drafts are applied to the real session. */
	const turnEnd = async (assistantEntryId: string, message: Any) => {
		const out = await runner.emitBoundary({ type: "turn_end", turnIndex: 1, message, toolResults: [], messageEntryId: assistantEntryId, toolResultEntryIds: [], outcome: message.stopReason === "aborted" ? "aborted" : "completed" } as Any, build as Any);
		const drafts = out.entries as Any[];
		const marker = drafts.find((d) => d.type === "custom" && d.customType === "pi-zip/commit");
		for (const draft of drafts) {
			if (draft.type === "compaction" && draft.details?.by === "pi-zip" && draft.details.carried !== containsCut(actualRequest, draft)) checks.carry.push("summary carried flag disagrees with request");
			if (draft.type === "context_edit" && JSON.stringify(draft.replacement).includes("[folded by pi-zip") && marker && (marker.data.carried && (!marker.data.carriedIds || marker.data.carriedIds.includes(draft.targetId))) !== containsFold(actualRequest, draft.targetId, draft.replacement.content)) checks.carry.push("fold carried flag disagrees with request");
		}
		apply(sm, drafts);
		await new Promise((resolve) => setTimeout(resolve, 5));
		checkSizes(projectionMessages());
		assertIntegrationChecks();
		ended = true;
		return drafts;
	};
	/** The end of a run: agent_before_settle (pi-zip plans the next cold return and, interactive, arms the away timer). */
	const settle = async (full = false) => {
		const out = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" } as Any, build as Any);
		apply(sm, out.entries as Any[]);
		busy = false;
		return full ? out : out.entries as Any[];
	};
	const apply = (manager: SessionManager, drafts: Any[]) => (AgentSession.prototype as Any)._applyBoundaryDrafts.call({}, manager, drafts) as Any[];
	/** A prompt as Pi runs it (AgentSession.prompt): the input handlers while Pi is idle (it waits for them), then before_agent_start and
	 *  agent_start in the rig's order. `fail`: the prompt throws between before_agent_start and agent_start (Pi's image normalisation).
	 *  `afterInput` runs between the input handlers and before_agent_start (Pi's own threshold compaction, say), `afterStart` between
	 *  before_agent_start and agent_start (a steer typed into the starting run, a handler choosing another model). */
	const prompt = async (text = "next request", o: { fail?: boolean; afterInput?: () => Any; afterStart?: () => Any } = {}) => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		busy = false; // the previous run is over
		turn++; ended = false;
		await runner.emitInput(text, undefined, "interactive", undefined);
		await o.afterInput?.();
		if (order === "1.2") busy = true;
		const r = order === "1.2"
			? await runner.emit({ type: "before_agent_start", messageType: "user", prompt: text, systemPromptOptions: { cwd: CWD } } as Any)
			: runner.emitBeforeAgentStart.length === 2
				? await runner.emitBeforeAgentStart({ messageType: "user", prompt: text }, { cwd: CWD })
				: await (runner.emitBeforeAgentStart as Any)(text, undefined, { cwd: CWD });
		await o.afterStart?.();
		busy = !o.fail;
		if (!o.fail) await runner.emit({ type: "agent_start" } as Any);
		return r;
	};
	/** Text typed while the run streams (a steer or a follow-up): Pi hands it to the input handlers with its delivery. */
	const steer = (text: string, behavior: "steer" | "followUp" = "steer") => runner.emitInput(text, undefined, "interactive", behavior);
	/** A run an extension's message starts (sendMessage with triggerTurn on an idle session): Pi 1.1.0 emits agent_start only, 1.2.0
	 *  before_agent_start with messageType "custom" first. The custom message is appended and its message_end fired. */
	const drive = async (text = "drive the owed work") => {
		busy = false;
		const message = { role: "custom", customType: "owed-drive", content: text, display: true, timestamp: Date.now() };
		if (order === "1.2") {
			busy = true;
			await runner.emit({ type: "before_agent_start", messageType: "custom", message, systemPromptOptions: { cwd: CWD } } as Any);
		}
		busy = true;
		await runner.emit({ type: "agent_start" } as Any);
		sm.appendCustomMessageEntry(message.customType, message.content, message.display);
		await runner.emit({ type: "message_end", message } as Any);
	};
	const ownStart = Object.getOwnPropertyDescriptor(Zip.prototype, "sessionStart");
	const start = (Zip.prototype as Any).sessionStart;
	(Zip.prototype as Any).sessionStart = function (this: Any, ...args: Any[]) { zip = this; return start.apply(this, args); };
	try { await runner.emit({ type: "session_start", reason: "startup" } as Any); }
	finally {
		if (ownStart) Object.defineProperty(Zip.prototype, "sessionStart", ownStart);
		else delete (Zip.prototype as Any).sessionStart;
	}
	let noticeScale = UNIT;
	const noticeFor = zip.noticeFor.bind(zip), notify = zip.notify.bind(zip), ledger = zip.ledger.bind(zip);
	zip.noticeFor = (...args: Any[]) => { noticeScale = args[1].scale; return noticeFor(...args); };
	zip.notify = (ctx: Any, text: string, data: Any) => {
		if (data && !data.kind) reports.push({ after: data.after, scale: noticeScale, kind: "notice" });
		return notify(ctx, text, data);
	};
	zip.ledger = (rec: Any) => {
		if (rec.type === "fold") reports.push({ after: rec.ctxAfter, scale: { O: rec.O, c: rec.c }, kind: "fold ledger" });
		return ledger(rec);
	};
	if (opts.start !== false) await prompt();
	const shutdown = () => runner.emit({ type: "session_shutdown" } as Any);
	const setModel = (m: Any) => { model = m; };
	return { sm, runner, request, turnEnd, settle, prompt, steer, drive, order, setModel, narrativeCalls, narrativeModels, projectionMessages, compactions, compactCalls, foreignCalls, abortsInRun, inputListeners, typeKey, editor, shutdown, zip, checks, noticeCounts };
}

// These checks observe Pi's actual request messages and emitted transcript entries, independently of plan flags.
const integrationChecks: { carry: string[]; notices: string[]; sizes: string[] }[] = [];
const assertIntegrationChecks = () => {
	for (const check of integrationChecks) {
		expect(check.carry, "request carry metadata must match the actual request view").toEqual([]);
		expect(check.notices, "one turn emits at most one pi-zip notice").toEqual([]);
		expect(check.sizes, "reported after-size must be non-negative and match the resulting Pi context within 10%").toEqual([]);
	}
};
const saved: Record<string, string | undefined> = {};
const ENV = { PI_ZIP_COLD_CAP: "3000", PI_ZIP_TTL_SECS: "300", PI_ZIP_IDLE_DOOR: "", PI_ZIP_SUMMARY_AT: "0" }; // lifecycle fixtures exercise cuts directly; pressure threshold has dedicated tests
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => {
	try { assertIntegrationChecks(); }
	finally {
		integrationChecks.length = 0;
		for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
	}
});


describe("model-switch checkpoints through Pi hooks", () => {
	const setup = (sm: SessionManager) => {
		for (let i = 1; i <= 4; i++) {
			sm.appendMessage(user(`switch turn ${i}`));
			if (i < 3) sm.appendMessage({ ...asst([{ type: "text", text: "prefix ".repeat(57_000) }]), usage: undefined });
			else if (i === 3) sm.appendMessage({ ...asst([{ type: "text", text: "keep this exact suffix" }]), usage: undefined });
		}
	};
	const defaults = () => { delete process.env.PI_ZIP_SUMMARY_AT; process.env.PI_ZIP_COLD_CAP = "40000"; };
	const switchTo = async (r: Awaited<ReturnType<typeof rig>>, contextWindow: number) => {
		const model = { ...MODEL, id: `small-${contextWindow}`, contextWindow };
		r.setModel(model);
		await r.runner.emit({ type: "model_select", model, previousModel: MODEL, source: "set" });
		return model;
	};
	// Run Pi's real pre-next-request threshold check. Only its summarizer/storage shell is replaced by the rig's real runner and manager.
	const threshold = async (r: Awaited<ReturnType<typeof rig>>) => {
		let cancelled = false;
		const host: Any = {
			model: r.runner.createContext().model, sessionManager: r.sm,
			settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }) },
			_exceedsCompactionThreshold: (AgentSession.prototype as Any)._exceedsCompactionThreshold,
			_runAutoCompaction: async () => {
				const result: Any = await r.runner.emit({ type: "session_before_compact", reason: "threshold", willRetry: false,
					preparation: prepareCompaction(r.sm.getBranch() as Any, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
					branchEntries: r.sm.getBranch(), signal: new AbortController().signal } as Any);
				if (result?.cancel) { cancelled = true; return; }
				expect(result?.compaction, "must not fall through to Pi's summarizer").toBeDefined();
				const c = result.compaction;
				const id = r.sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
				await r.runner.emit({ type: "session_compact", compactionEntry: r.sm.getEntry(id), fromExtension: true, reason: "threshold", willRetry: false } as Any);
			},
		};
		await (AgentSession.prototype as Any)._compactBeforeNextAssistantResponse.call(host, { messages: r.projectionMessages() });
		return cancelled;
	};

	test("reopened history -> 272K before the first request: pi-zip supplies the threshold summary", async () => {
		defaults();
		const sm = SessionManager.inMemory(CWD);
		setup(sm);
		sm.appendMessage({ ...asst([{ type: "text", text: "suffix ".repeat(48_000) }]), usage: undefined });
		sm.appendMessage(user("latest unsummarised request"));
		// Selection and failed responses are not evidence that the smaller model read this history.
		sm.appendModelChange(MODEL.provider, "small-272000");
		sm.appendMessage({ ...asst([], "error"), model: "small-272000", usage: undefined });
		const r = await rig(setup, { file: [sm.getHeader(), ...sm.getEntries()], start: false });
		try {
			await switchTo(r, 272_000);
			// Pi checks the threshold before agent_start restores prevKey.
			expect(r.zip.lastModelKey).toBe(""); // no context hook/request has run in this process
			expect(r.zip.prevKey).toBe("");
			expect(await threshold(r)).toBe(false);
			const c = r.sm.getBranch().find((e: Any) => e.type === "compaction");
			expect(c?.details).toMatchObject({ by: "pi-zip", door: "model-switch" });
			expect(r.narrativeCalls.length).toBe(1);
			await r.prompt();
			expect((await r.request()).some((m: Any) => m.role === "compactionSummary" && m.summary === c.summary)).toBe(true);
			expect(r.abortsInRun.n).toBe(0);
		} finally { await r.shutdown(); }
	});

	test("reopened history already read by the selected model is not a model switch", async () => {
		defaults();
		const model = { ...MODEL, id: "small-272000", contextWindow: 272_000 };
		const r = await rig((sm) => {
			setup(sm);
			sm.appendMessage({ ...asst([{ type: "text", text: "already read on this model" }]), model: model.id });
		}, { model, start: false });
		try {
			expect(r.zip.switchedModel(r.runner.createContext())).toBe(false);
			const out = await r.runner.emit({ type: "session_before_compact", reason: "threshold", signal: new AbortController().signal } as Any);
			expect(out?.compaction).toBeUndefined();
			expect(r.narrativeCalls.length).toBe(0);
		} finally { await r.shutdown(); }
	});

	for (const window of [200_000, 272_000]) test(`1M -> ${window}: real background artifact replaces only its prefix before the next request`, async () => {
		defaults();
		const r = await rig(setup);
		try {
			await r.request();
			await r.zip.bg?.promise;
			expect(r.narrativeCalls.length).toBe(1);
			const cut = r.zip.mine.find((a: Any) => a.cut)?.cut;
			expect(cut).toBeDefined();
			expect(r.sm.getBranch().some((e) => e.type === "compaction")).toBe(false);
			r.sm.appendMessage({ ...asst([{ type: "text", text: "suffix ".repeat(48_000) }]), usage: undefined });
			r.sm.appendMessage(user("latest unsummarised request"));
			const entries = r.sm.buildSessionProjection().entries;
			const suffix = entries.slice(entries.findIndex((e: Any) => e.sourceEntry?.id === cut.firstKeptEntryId)).flatMap((e: Any) => e.messages);
			await switchTo(r, window);
			const decisions: Any[] = [], ledger = r.zip.ledger.bind(r.zip);
			r.zip.ledger = (rec: Any) => { decisions.push(rec); ledger(rec); };
			expect(await threshold(r), JSON.stringify(decisions)).toBe(false);
			const sent = await r.request();
			expect(sent.some((m: Any) => m.role === "compactionSummary" && m.summary === cut.text)).toBe(true);
			expect(sent.slice(-suffix.length)).toEqual(suffix);
			expect(r.narrativeCalls.length).toBe(1); // no synchronous resummary of the suffix
			expect(r.abortsInRun.n).toBe(0);
			expect(r.zip.stats.summaries).toBe(1);
		} finally { await r.shutdown(); }
	});

	test("an oversized kept turn is summarised up to the current request, its narrative read by the larger previous model", async () => {
		defaults();
		const r = await rig(setup);
		try {
			await r.request(); await r.zip.bg?.promise;
			expect(r.narrativeCalls.length).toBe(1);
			// ~210K tokens in the previous user turn: no cut outside the two protected turns can fit 200K
			r.sm.appendMessage({ ...asst([{ type: "text", text: "suffix ".repeat(120_000) }]), usage: undefined });
			const latest = r.sm.appendMessage(user("latest"));
			await switchTo(r, 200_000);
			expect(await threshold(r)).toBe(false);
			expect(r.abortsInRun.n).toBe(0);
			expect(r.narrativeCalls.length).toBe(2); // written at the switch
			expect(r.narrativeModels[1].id).toBe("m"); // the 1M model read the ~410K prefix the 200K model cannot
			expect(JSON.stringify(r.narrativeCalls[1])).toContain("suffix suffix");
			const comp = r.sm.getBranch().filter((e: Any) => e.type === "compaction");
			expect(comp.length).toBe(1);
			expect(comp[0].firstKeptEntryId).toBe(latest); // the current request itself is kept verbatim
			const sent = await r.request();
			expect(sent.at(-1)).toMatchObject({ role: "user", content: "latest" });
			expect(sent.some((m: Any) => m.role === "compactionSummary")).toBe(true);
			expect(r.abortsInRun.n).toBe(0);
			expect(r.zip.stats.summaries).toBe(1);
		} finally { await r.shutdown(); }
	});

	test("a running summary is waited for, then compacts its prefix without a second call", async () => {
		defaults();
		const r = await rig(setup, { latencyMs: 100 });
		try {
			await r.request();
			expect(r.zip.bg).not.toBeNull();
			const key = r.zip.bg.key;
			await switchTo(r, 200_000);
			expect(await threshold(r)).toBe(false);
			expect(r.abortsInRun.n).toBe(0);
			expect(r.narrativeCalls.length).toBe(1);
			expect(r.sm.getBranch().find((e: Any) => e.type === "compaction")?.firstKeptEntryId).toBe(key);
		} finally { await r.shutdown(); }
	});

	test("folds alone fit: Pi's compaction is cancelled without abort and the next request carries the folds", async () => {
		defaults();
		const tools = (sm: SessionManager) => {
			for (let i = 1; i <= 6; i++) {
				sm.appendMessage(user(`tool turn ${i}`));
				sm.appendMessage({ ...asst([{ type: "text", text: "reading" }, call(`t${i}`, `cat big-${i}.log`)], "toolUse"), usage: undefined });
				sm.appendMessage(result(`t${i}`, `big ${i}\n` + bulk(`log${i}`, 3_200)));
				sm.appendMessage({ ...asst([{ type: "text", text: `read ${i}` }]), usage: undefined });
			}
			sm.appendMessage(user("now"));
		};
		const r = await rig(tools);
		try {
			await r.request();
			await switchTo(r, 200_000);
			const room = 200_000 - 16_384 - 8_192;
			expect(await threshold(r)).toBe(true); // true only when Pi's own threshold check fired and pi-zip cancelled it
			expect(r.abortsInRun.n).toBe(0);
			expect(r.sm.getBranch().some((e: Any) => e.type === "compaction")).toBe(false);
			const sent = await r.request();
			expect(sent.filter(isFolded).length).toBeGreaterThan(0);
			expect(sent.filter((m: Any) => m.role !== "system").reduce((n: number, m: Any) => n + wireTokensOf(m), 0)).toBeLessThan(room);
			expect(r.abortsInRun.n).toBe(0);
			expect(r.narrativeCalls.length).toBe(0);
		} finally { await r.shutdown(); }
	});

	test("current turn too big: fold only as many of its outputs as the window needs, and persist them at turn_end", async () => {
		defaults();
		const r = await rig(setup);
		try {
			await r.request(); await r.zip.bg?.promise;
			const latest = r.sm.appendMessage(user("latest"));
			r.sm.appendMessage({ ...asst([{ type: "text", text: "reading both" }, call("huge", "cat huge.log"), call("big", "cat big.log")], "toolUse"), usage: undefined });
			const huge = r.sm.appendMessage(result("huge", "huge\n" + bulk("huge", 9_000)));
			const big = r.sm.appendMessage(result("big", "big\n" + bulk("big", 6_500)));
			await switchTo(r, 200_000);
			const decisions: Any[] = [], ledger = r.zip.ledger.bind(r.zip);
			r.zip.ledger = (rec: Any) => { decisions.push(rec); ledger(rec); };
			expect(await threshold(r), JSON.stringify(decisions.filter((d) => d.type?.startsWith("model_switch")))).toBe(false);
			expect(decisions.find((d) => d.type === "model_switch")).toMatchObject({ stage: "rescue-folds", forced: 1 });
			expect(r.sm.getBranch().find((e: Any) => e.type === "compaction")?.firstKeptEntryId).toBe(latest);
			const sent = await r.request();
			const folded = (id: string) => sent.some((m: Any) => m.role === "toolResult" && m.toolCallId === id && isFolded(m));
			expect(folded("huge")).toBe(true); // the biggest output alone was enough
			expect(folded("big")).toBe(false);
			const reply = { ...asst([{ type: "text", text: "done" }]), timestamp: Date.now(), usage: undefined };
			const drafts = await r.turnEnd(r.sm.appendMessage(reply), reply);
			expect(decisions.some((d) => d.type === "guard_drop")).toBe(false);
			expect(drafts.some((d: Any) => d.type === "context_edit" && d.targetId === huge)).toBe(true);
			expect(drafts.some((d: Any) => d.type === "context_edit" && d.targetId === big)).toBe(false);
		} finally { await r.shutdown(); }
	});

	test("the current request alone exceeds the new window: stop with the history intact and no summary call", async () => {
		defaults();
		const r = await rig(setup);
		try {
			await r.request(); await r.zip.bg?.promise;
			r.sm.appendMessage(user("paste ".repeat(130_000)));
			await switchTo(r, 200_000);
			const before = r.projectionMessages();
			expect(await threshold(r)).toBe(true);
			expect(r.abortsInRun.n).toBe(1);
			expect(r.projectionMessages()).toEqual(before);
			expect(r.narrativeCalls.length).toBe(1);
		} finally { await r.shutdown(); }
	});

	test("format v2: requests above the planned summary size but inside the new window's room compact verbatim (the plan is a soft target)", async () => {
		defaults();
		process.env.PI_ZIP_SUMMARY_V2 = "1";
		const ask = (i: number) => `ACTIVE-CONSTRAINT-${i}: ` + "keep every user instruction verbatim without silent dropping ".repeat(900); // ~14K tokens each
		const r = await rig((sm: SessionManager) => {
			for (let i = 1; i <= 5; i++) {
				sm.appendMessage(user(ask(i)));
				sm.appendMessage({ ...asst([{ type: "text", text: "ok " + "pad ".repeat(48_000) }]), usage: undefined });
			}
			sm.appendMessage(user("latest short prompt"));
		});
		try {
			await switchTo(r, 200_000);
			expect(await threshold(r)).toBe(false);
			expect(r.abortsInRun.n).toBe(0);
			const comp: Any = r.sm.getBranch().find((e: Any) => e.type === "compaction");
			expect(comp?.summary.startsWith("[pi-zip summary · format v2")).toBe(true);
			expect(comp.summary).toContain(ask(1)); // summarised requests are whole, never shortened
			const kept = JSON.stringify(r.projectionMessages());
			for (let i = 1; i <= 5; i++) expect(comp.summary.includes(ask(i)) || kept.includes(ask(i))).toBe(true);
		} finally {
			delete process.env.PI_ZIP_SUMMARY_V2;
			await r.shutdown();
		}
	});

	test("format v2: model-switch adopts emergency excerpt summary when user requests exceed verbatim room but fit under emergency excerpt", async () => {
		defaults();
		process.env.PI_ZIP_SUMMARY_V2 = "1";
		// User requests in prefix exceed the verbatim room for 70K window, but easily fit with emergency excerpts
		const ask = (i: number) => `ACTIVE-CONSTRAINT-${i}: ` + "yêu cầu kiểm tra logic bảo mật hệ thống ".repeat(700);
		const r = await rig((sm: SessionManager) => {
			for (let i = 1; i <= 5; i++) {
				sm.appendMessage(user(ask(i)));
				sm.appendMessage({ ...asst([{ type: "text", text: "ok " + "pad ".repeat(15_000) }]), usage: undefined });
			}
			sm.appendMessage(user("latest short prompt"));
		});
		try {
			await switchTo(r, 70_000);
			expect(await threshold(r)).toBe(false);
			expect(r.abortsInRun.n).toBe(0);
			const comp: Any = r.sm.getBranch().find((e: Any) => e.type === "compaction");
			expect(comp?.summary.startsWith("[pi-zip summary · format v2")).toBe(true);
			expect(comp.summary).toContain("Requests: emergency excerpts — ");
			expect(comp.summary).toContain("emergency excerpt · original ");
		} finally {
			delete process.env.PI_ZIP_SUMMARY_V2;
			await r.shutdown();
		}
	});

	test("format v2 request-budget-overflow: retention safety wins over model switch when minimal representation exceeds the new window's room", async () => {
		defaults();
		process.env.PI_ZIP_SUMMARY_V2 = "1";
		// The planner must accept the cut while the v2 builder finds that the minimal request ledger exceeds the 4096 room of a
		// 20K window. Measured window: at 60 requests every row fits verbatim (4095/4096), from ~64 the builder overflows, and by
		// 120 the planner already rejects the switch as too big. 80 keeps a margin on both sides. One epoch only: E2 never archives
		// the newest request-bearing epoch, so the cut must fail closed.
		const manyUserSetup = (sm: SessionManager) => {
			for (let i = 1; i <= 80; i++) {
				sm.appendMessage(user(`ACTIVE-CONSTRAINT-${i}: keep every user constraint verbatim without dropping`));
				sm.appendMessage({ ...asst([{ type: "text", text: "pad ".repeat(250) }]), usage: undefined });
			}
			sm.appendMessage(user("latest short prompt"));
		};
		const r = await rig(manyUserSetup);
		try {
			await switchTo(r, 20_000);
			const before = r.projectionMessages();
			const decisions: Any[] = [], ledger = r.zip.ledger.bind(r.zip);
			r.zip.ledger = (rec: Any) => { decisions.push(rec); ledger(rec); };
			expect(await threshold(r)).toBe(true); // cancelled, never fell through to Pi's summarizer
			expect(r.abortsInRun.n).toBe(1);
			expect(r.projectionMessages()).toEqual(before);
			expect(r.sm.getBranch().some((e: Any) => e.type === "compaction")).toBe(false);
			expect(decisions.some((d) => d.type === "summary_overflow" && d.reason === "request-budget-overflow")).toBe(true);
			expect(decisions.find((d) => d.type === "model_switch_blocked")?.reason).toContain("protected user requests exceed the summary budget");
		} finally {
			delete process.env.PI_ZIP_SUMMARY_V2;
			await r.shutdown();
		}
	});

	test("switch after Pi's threshold check aborts before network I/O in the real agent loop", async () => {
		defaults();
		let agent: Agent | undefined, sends = 0;
		const r = await rig(setup, { onAbort: () => agent?.abort() });
		try {
			await r.request(); await r.zip.bg?.promise;
			r.sm.appendMessage({ ...asst([{ type: "text", text: "suffix ".repeat(75_000) }]), usage: undefined });
			r.sm.appendMessage(user("latest"));
			const model = await switchTo(r, 200_000);
			agent = new Agent({ initialState: { model, messages: r.projectionMessages() },
				transformContext: (messages) => r.runner.emitContext(messages),
				streamFn: (_model, _context, options) => {
					// Pi still invokes the transport with an aborted signal; providers must honor it before network I/O.
					options?.signal?.throwIfAborted();
					sends++;
					throw new Error("unsafe provider call");
				} });
			await agent.continue();
			expect(sends).toBe(0);
			expect(r.abortsInRun.n).toBe(1);
			expect(r.zip.lastModelKey).toBe("p/m"); // an aborted preflight is not a request to the smaller model
		} finally { await r.shutdown(); }
	});
});


const isFolded = (m: Any) => m.role === "toolResult" && JSON.stringify(m.content).includes("[folded by pi-zip");

for (const mode of ["unrepaired", "queued", "repaired"] as const) test(`a length stop ${mode === "repaired" ? "compacts at the open settle boundary and continues" : `does not recover from ${mode} context`}`, async () => {
	const repaired = mode === "repaired";
	const staged = SessionManager.inMemory(CWD, undefined, shiftedFile(0, 9000));
	for (let i = 0; i < 3; i++) {
		const at = Date.now() - 10_000 + i * 10;
		staged.appendMessage({ ...user(`recent request ${i}`), timestamp: at });
		staged.appendMessage({ ...asst([call(`recent-${i}`)], "toolUse"), timestamp: at + 1 });
		staged.appendMessage({ ...result(`recent-${i}`, bulk("recent output", 100)), timestamp: at + 2 });
		staged.appendMessage({ ...asst([{ type: "text", text: "recent answer" }]), timestamp: at + 3 });
	}
	const file = [staged.getHeader(), ...staged.getEntries()];
	const r = await rig(undefined, { file, tui: true, start: true, latencyMs: 10, model: { ...MODEL, contextWindow: 90_000 } });
	const ctx = r.runner.createContext(), complete = ctx.modelRegistry.complete;
	if (repaired) ctx.modelRegistry.complete = async () => ({ stopReason: "error", content: [], errorMessage: "403 FreeTierError", usage: { cost: { total: 0 } } });
	try {
		const now = Date.now();
		r.sm.appendMessage({ ...user("current request"), timestamp: now });
		r.sm.appendMessage({ ...asst([call("current")], "toolUse"), timestamp: now + 1 });
		r.sm.appendMessage({ ...result("current", bulk("current output", 200)), timestamp: now + 2 });
		const truncated = { ...asst([{ type: "text", text: "truncated answer" }], "length"), timestamp: now + 3 };
		const truncatedId = r.sm.appendMessage(truncated);
		await r.runner.emit({ type: "message_end", message: truncated } as Any);
		if (repaired) r.sm.appendContextEdit(truncatedId, null);
		if (mode === "queued") r.sm.appendMessage({ ...user("queued follow-up"), timestamp: now + 4 }); // runnable, but not Pi's length repair

		const out = await r.settle(true) as Any;
		const compaction = out.entries.find((d: Any) => d.type === "compaction" && d.details?.recovery === "length");
		expect(out.continue).toBe(repaired);
		expect(!!compaction).toBe(repaired);
		if (repaired) {
			expect(compaction.details).toMatchObject({ by: "pi-zip", trigger: "valve", recovery: "length" });
			expect(r.compactCalls.n).toBe(0); // a boundary draft, not an idle ctx.compact()
			const messages = r.projectionMessages();
			expect(messages.some((m: Any) => m.role === "compactionSummary" && m.summary === compaction.summary)).toBe(true);
			expect(JSON.stringify(messages)).not.toContain("truncated answer");
			expect((await r.settle(true) as Any).continue).toBe(false); // the recovery marker makes continuation one-shot
		}
	} finally {
		ctx.modelRegistry.complete = complete;
		await r.shutdown();
	}
});


for (const order of ORDERS) describe(`real Pi: a summary prepared while the user was away goes in through Pi's own compaction (pi-tricks §1b, variant 1) (Pi ${order} order)`, () => {
	beforeEach(() => { rigOrder = order; });
	afterEach(() => { rigOrder = PI_ORDER; });
	const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
	/** The session as a file whose newest response is `agoMs` old (the rig of every other test is hours old: a cold session). */
	const template = (agoMs = 0) => {
		const sm = SessionManager.inMemory(CWD);
		populate(sm, 9000); // long prose: folds alone cannot reach the cap, so the cold return needs a summary
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

	test("in real Pi, a cold return above 40K but below 80% of the compaction room folds without starting a summary and logs summaryGate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pz-pressure-gate-")), ledger = join(dir, "ledger.jsonl");
		const prevLedger = process.env.PI_ZIP_LEDGER, prevAt = process.env.PI_ZIP_SUMMARY_AT, prevCap = process.env.PI_ZIP_COLD_CAP;
		process.env.PI_ZIP_LEDGER = ledger;
		delete process.env.PI_ZIP_SUMMARY_AT;
		process.env.PI_ZIP_COLD_CAP = "40000";
		try {
			// template(240 min) is ~90K calibrated real tokens; on a 200K window room is 175,424 and pressure starts at ~140,339.
			const r = await rig(undefined, { file: template(240 * 60_000), tui: true, native: true, idle: true, start: false, model: { ...MODEL, contextWindow: 200_000 } });
			await r.prompt("next request");
			sendPrompt(r.sm, "next request");
			const req = await r.request();
			await sleep(50);
			expect(req.some(isFolded)).toBe(true);
			expect(req.some((m: Any) => m.role === "compactionSummary")).toBe(false);
			expect(r.narrativeCalls).toHaveLength(0);
			const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
			const law = rows.find((x) => x.type === "law" && x.where === "run");
			expect(law?.summaryGate).toMatchObject({ eligible: false, reason: "below-pressure", room: 175_424, threshold: 140_339 });
			expect(law.summaryGate.afterFolds).toBeGreaterThan(law.summaryGate.target);
			expect(law.summaryGate.afterFolds).toBeLessThan(law.summaryGate.threshold);
			await r.shutdown();
		} finally {
			if (prevLedger === undefined) delete process.env.PI_ZIP_LEDGER; else process.env.PI_ZIP_LEDGER = prevLedger;
			if (prevAt === undefined) delete process.env.PI_ZIP_SUMMARY_AT; else process.env.PI_ZIP_SUMMARY_AT = prevAt;
			if (prevCap === undefined) delete process.env.PI_ZIP_COLD_CAP; else process.env.PI_ZIP_COLD_CAP = prevCap;
			rmSync(dir, { recursive: true, force: true });
		}
	});

});
