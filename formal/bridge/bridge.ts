#!/usr/bin/env bun
// Conformance bridge: drives the REAL pi-zip extension (src/index.ts -> run.ts -> plan.ts) through abstract traces and reports what it
// decided, as JSON lines.  Usage:  bun bridge.ts <pi-zip src dir> [--pi <pi-coding-agent package dir>]
// stdin: one trace per line   {"id", "world": {...}, "events": [...], "probes": {...}}
// stdout: one observation per line   {"id", "ok", "blocks": [...], "ticks": [...], "refreshes": [...]}
//
// What is REAL here: pi-zip's index.ts wiring, run.ts (cold detection, run plan, valve, b2b skip, summarizedWarm, away timer, native
// compaction gate, persistence at turn_end, learning of g / class / survival, steering marks, the tool_call hook, the payload tier),
// plan.ts, summary.ts, recall.ts (zip_recall as the model calls it), recallfile.ts, guard.ts (repairPayload on a real Anthropic-shaped
// payload); Pi's own SessionManager (projection of context_edit and compaction entries), Pi's draft application
// (AgentSession._applyBoundaryDrafts), Pi's prepareCompaction (pi-zip's ctx.compact and Pi's own compaction), Pi's CacheWarmer (idle
// cache warming, with its own economics and timers).
// What is MIRRORED (not callable without a live model): Pi's agent loop event order (before_agent_start, prompt appended, per request
// context_with_system -> before_provider_request -> assistant message_end -> tool_call -> tool results -> turn_end, then
// agent_before_settle), the provider (a prefix cache with a TTL that produces usage reports), the narrative model call (a fixed text),
// the clock and timers (virtual), and pi-zip's index.ts is called as is (only the Zip instance is captured to read its state).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
if (!argv[0]) {
	console.error("usage: bun bridge.ts <pi-zip src dir> [--pi <pi-coding-agent dir>]");
	process.exit(2);
}
const SRC = resolve(argv[0]);
const PI = resolve(argv.includes("--pi") ? argv[argv.indexOf("--pi") + 1] : join(SRC, "../node_modules/@earendil-works/pi-coding-agent"));
const WORK = process.env.PZF_WORK ?? `/tmp/pz-formal-bridge-${process.pid}`;
mkdirSync(WORK, { recursive: true });
const STATS = join(WORK, "cache-survival.json");
// isolation: nothing the extension writes leaves WORK (stats, welcome flag, recall copies); the ledger is tapped in memory
Object.assign(process.env, { PI_ZIP_CACHE_STATS: STATS, PI_ZIP_LEDGER: "/dev/null", XDG_CACHE_HOME: join(WORK, "xdg"), PI_CODING_AGENT_DIR: join(WORK, "agent") });
for (const k of ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_FOLD_MIN", "PI_ZIP_KEEP_LINES", "PI_ZIP_INTURN_AGE", "PI_ZIP_OFF", "PI_CACHE_RETENTION"]) delete process.env[k];

type Any = any;
const { SessionManager } = await import(join(PI, "dist/core/session-manager.js"));
const { AgentSession } = await import(join(PI, "dist/core/agent-session.js"));
const { convertToLlm } = await import(join(PI, "dist/core/messages.js"));
const { prepareCompaction, estimateProjectedContextTokens } = await import(join(PI, "dist/core/compaction/compaction.js"));
const { CacheWarmer } = await import(join(PI, "dist/core/cache-warmer.js"));
const piZip = (await import(join(SRC, "index.ts"))).default;
const { Zip } = await import(join(SRC, "run.ts"));
const plan = await import(join(SRC, "plan.ts"));
const core = await import(join(SRC, "core.ts"));
const { previousNarrative } = await import(join(SRC, "summary.ts"));
const { handleFor, PH_MARK } = await import(join(SRC, "placeholder.ts"));
const applyDrafts = (sm: Any, drafts: Any[]) => (AgentSession.prototype as Any)._applyBoundaryDrafts.call({}, sm, drafts) as Any[];
// warm the lazy import summary.ts makes for its serializer (it would otherwise race the virtual clock once)
await import(join(PI, "dist/index.js")).catch(() => {});

// ---- virtual clock and timers ----------------------------------------------------------------------------------------------
const RealDate = Date;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realSetImmediate = globalThis.setImmediate;
let clock = 0;
class FakeDate extends RealDate {
	constructor(...a: Any[]) {
		if (a.length === 0) super(clock);
		else super(...(a as [Any]));
	}
	static now() {
		return clock;
	}
}
let producer = { calls: 0, timers: 0, writes: 0 };
let timerFiring = false;
const producerOwner = new AsyncLocalStorage<Any>();
const activeCalls = new Set<object>();
type Timer = { owner?: Any; id: number; due: number; fn: () => void; dead: boolean };
let timers: Timer[] = [];
let tid = 0;
function fakeSetTimeout(fn: Any, ms?: number, ...a: Any[]) {
	const owner = producerOwner.getStore();
	const t: Timer = { owner, id: ++tid, due: clock + Math.max(0, Number(ms) || 0), fn: () => {
		const before = timerFiring;
		timerFiring = !!owner;
		try { fn(...a); } finally { timerFiring = before; }
	}, dead: false };
	timers.push(t);
	if (owner) producer.timers = Math.max(producer.timers, timers.filter((t) => !t.dead && t.owner === owner).length);
	return { _t: t, unref() { return this; }, ref() { return this; }, hasRef: () => false, [Symbol.toPrimitive]: () => t.id };
}
function fakeClearTimeout(h: Any) {
	if (h && h._t) h._t.dead = true;
}
function install() {
	(globalThis as Any).Date = FakeDate;
	(globalThis as Any).setTimeout = fakeSetTimeout;
	(globalThis as Any).clearTimeout = fakeClearTimeout;
}
function uninstall() {
	(globalThis as Any).Date = RealDate;
	(globalThis as Any).setTimeout = realSetTimeout;
	(globalThis as Any).clearTimeout = realClearTimeout;
}
const tick = () => new Promise<void>((r) => realSetImmediate(r));
/** World `slow`: the background summary calls still running (each answers when the clock reaches its due time; restart drops them). */
const slowCalls = new Set<() => void>();
const SLOW_MS = 120_000;
async function drain(z?: Any) {
	for (let i = 0; i < 4; i++) await tick();
	const bg = z?.bg;
	if (bg?.promise && !slowCalls.size) await bg.promise;
	for (let i = 0; i < 4; i++) await tick();
}

// ---- trace state -------------------------------------------------------------------------------------------------------------
const CWD = "/tmp/pz-formal-cwd";
const T0 = 1_760_000_000_000; // a fixed epoch: every trace starts at the same instant
const LAT_MS = 5_000; // one request + its response
const TOOL_MS = 1_000;
let phase: "present" | "away" = "present";
let sink: Any[] = []; // the ledger of the instance being driven
let optsSink: Any[] | null = null; // opts() calls of the instance being driven (the P-grid probe)
let narrativeCalls: { phase: string; at: number; input: number; output: number }[] = []; // phase: present (waited for), away, background, probe
let captured: Any = null;
const origSessionStart = Zip.prototype.sessionStart;
Zip.prototype.sessionStart = function (this: Any, ctx: Any) {
	captured = this;
	return origSessionStart.call(this, ctx);
};
Zip.prototype.ledger = function (rec: Any) {
	(this.__sink ?? sink).push(rec);
};
// A summary written in the background (Zip.startBg: the shared producer) is no wait, whenever it runs: its model
// call is tagged through the async context it was started in (the bridge's narrative model answers at once, so timing cannot tell)
const bgCall = new AsyncLocalStorage<boolean>();
const origStartBg = (Zip.prototype as Any).startBg;
(Zip.prototype as Any).startBg = function (this: Any, ...a: Any[]) {
	return bgCall.run(true, () => origStartBg.apply(this, a));
};
const origWant = (Zip.prototype as Any).want;
if (origWant) (Zip.prototype as Any).want = function (this: Any, ...a: Any[]) {
	return this.__probe ? origWant.apply(this, a) : producerOwner.run(this, () => origWant.apply(this, a));
};
const origOpts = Zip.prototype.opts;
Zip.prototype.opts = function (this: Any, ...a: Any[]) {
	const r = origOpts.apply(this, a);
	// planner options a run may set (PZF_PLAN_OPTS, e.g. {"inturnAge":20}): merged into what run.ts passes to planContext
	if (PLAN_OPTS) Object.assign(r.o, PLAN_OPTS);
	// the P-grid re-plans in exactly this state: the recalled set is a snapshot (the live one grows when zip_recall runs later). opts is
	// (ctx, pending, entries, pWarm, pause, cutAt): P enters the law only; `mode` is a label (P < 0.5: "cold"), and the one summary per
	// warm stretch (summarizedWarm, summaryRegrow: the flag a plan at P >= 0.5 gets) is captured for the grid's higher P
	if (optsSink && !this.__probe) optsSink.push({ room: /at roomOf \(/.test(new Error().stack ?? ""), pending: a[1], entries: a[2], mode: Number(a[3]) < 0.5 ? "cold" : "warm", sw: !!this.summarizedWarm, regrow: this.summaryRegrow, o: { ...r.o, recalled: new Set(r.o.recalled ?? []) }, live: r.o });
	return r;
};

const PLAN_OPTS: Any = process.env.PZF_PLAN_OPTS ? JSON.parse(process.env.PZF_PLAN_OPTS) : null;
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const noTs = (k: string, v: Any) => (k === "timestamp" ? undefined : v);
const llmJson = (m: Any) => JSON.stringify(convertToLlm([m]), noTs);
const textOfMsg = (m: Any): string => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: Any) => c?.text ?? c?.thinking ?? "").join("\n") : "");
/** placeholder.ts / util.ts clip: whitespace collapsed, cut to n chars with an ellipsis. */
const clip = (s: string, n: number) => {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const ERROR_LINE = /error|fail|exception|warning/i; // placeholder.ts ERROR_LINE_RE: the key lines a placeholder must show

/** Synthetic tool output or prose of about `tokens` chars/4 tokens. A command output (`fail`) carries one failing-test line in the
 *  middle, the kind of line README rule 1 says a folded block keeps. */
function body(tag: string, tokens: number, fail = false): string {
	const lines: string[] = [];
	let chars = 0, i = 0;
	const failAt = fail ? Math.max(1, Math.floor((tokens * 4) / 220)) : -1;
	while (chars < tokens * 4) {
		const l = i === failAt ? `FAIL test/case${i}.test.ts > expected ${i * 7} received ${i * 7 + 1}` : `${tag} line ${i}: value=${(i * 7919 + tag.length * 104729) % 1000003} ${"lorem ipsum dolor sit amet ".repeat(3)}`;
		lines.push(l);
		chars += l.length + 1;
		i++;
	}
	return lines.join("\n");
}

/** A session that reports a session file (as every session started without `--no-session` does; pi-zip's recall through files
 *  needs one), kept in memory: nothing is written there. */
function withFile(manager: Any): Any {
	const file = join(WORK, "session.jsonl");
	manager.getSessionFile = () => file;
	return manager;
}

/** The provider and the setup: cache class (the truth) and whether pi-zip already knows it (learned in an earlier session), declared TTL
 *  and true TTL (s), learned survival (none, or "outlives": read in full up to 600 s), real tokens per chars/4 token, system prompt size,
 *  context window, Pi's ctx.compact available (native summary path), interactive (away timer), the cache tier (short, or long:
 *  PI_CACHE_RETENTION=long, a 1-hour cache_control in every payload), the tool selection (full: zip_recall declared; file: a `--tools
 *  read,bash` allowlist, recall through files; reread: an allowlist without read, grep, bash or zip_recall) and Pi's idle cache warming. */
interface World { cls: "explicit" | "automatic"; known: boolean; ttl: number; ttlTrue: number; survival: "none" | "outlives"; c: number; sys: number; window: number; native: boolean; interactive: boolean; tier: "short" | "long"; tools: "full" | "file" | "reread"; warming: boolean; slow: boolean }
const DEFAULT_WORLD: World = { cls: "explicit", known: true, ttl: 300, ttlTrue: 300, survival: "none", c: 1, sys: 3000, window: 200_000, native: true, interactive: true, tier: "short", tools: "full", warming: false, slow: false };
const LONG_TTL = 3600; // the 1-hour tier
// the two models a switch moves between: one vendor's family (the world has one tokenizer scale c), so pi-zip may carry the session's
// scale across a switch (plan.ts sameTokenizer)
const MODEL_IDS = ["claude-m1", "claude-m2"];

function seedStats(w: World) {
	const models: Any = {};
	for (const id of MODEL_IDS) {
		const e: Any = { bins: {}, n: 0 };
		if (w.known) e.cls = w.cls;
		if (w.survival === "outlives") {
			// learned: the cache read in full up to 600 s, dead after (GLM-like: outlives its declared 300 s)
			for (const b of [3, 4, 5, 6, 7, 8, 9]) e.bins[b] = [4, 0];
			e.bins[10] = [0, 4];
			e.n = 32;
		}
		models[`p/${id}`] = e;
	}
	writeFileSync(STATS, JSON.stringify({ v: 1, models }));
}

async function runTrace(tr: Any): Promise<Any> {
	const w: World = { ...DEFAULT_WORLD, ...(tr.world ?? {}) };
	const probes = { pgrid: [0, 0.25, 0.49, 0.51, 0.75, 1], fresh: true, lossless: true, ...(tr.probes ?? {}) };
	clock = T0;
	timers = [];
	slowCalls.clear();
	narrativeCalls = [];
	producer = { calls: 0, timers: 0, writes: 0 };
	activeCalls.clear();
	sink = [];
	captured = null;
	rmSync(join(WORK, "xdg"), { recursive: true, force: true });
	seedStats(w);
	if (w.tier === "long") process.env.PI_CACHE_RETENTION = "long";
	else delete process.env.PI_CACHE_RETENTION;
	const long = w.tier === "long";
	// the cache lifetime the provider really keeps: on the long tier the declared hour, scaled like the short tier's truth
	const ttlTrueS = long ? Math.round((LONG_TTL * w.ttlTrue) / w.ttl) : w.ttlTrue;
	const cost = w.warming ? { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
	const models = MODEL_IDS.map((id) => ({ provider: "p", id, api: "anthropic-messages", contextWindow: w.window, maxTokens: 8192, reasoning: false, input: ["text"], cost, promptCache: { short: w.ttl, long: LONG_TTL } }));
	let mi = 0;
	const sysText = body("SYSTEM", w.sys);
	const sm = withFile(SessionManager.inMemory(CWD));
	const blocks: Any[] = [];
	const ticks: Any[] = [];
	const refreshes: Any[] = [];
	const errors: string[] = [];
	const cache = new Map<string, { msgs: { h: string; tok: number }[]; expires: number }>();
	let lastResp = 0; // ms of the newest response that reached the provider's cache (any model)
	let turn = 0;
	let reqNo = 0;
	let runNo = -1;
	let runOpen = false;
	let reqInRun = 0;
	let envSince: string[] = [];
	let envNext: string[] = []; // happened after a request was sent (a zip_recall its response called): new for the NEXT request
	let lastView: Any[] | null = null;
	let lastDesc: Any[] = [];
	let callNo = 0;
	let steerNo = 0;
	const foreignDropped = new Set<string>(); // user entries a foreign compaction removed (not pi-zip's to keep)
	const foreignEdited = new Set<string>(); // tool outputs another extension's context_edit rewrote (not pi-zip's)
	const nativeIssues: string[] = [];
	let nativeAllowed = false;
	const hijacked: string[] = []; // compactions pi-zip answered without having asked for them
	const toolOf = new Map<string, string>(); // tool result entry id -> npm | cat | recall
	const activeTools = w.tools === "full" ? ["read", "bash", "zip_recall"] : w.tools === "file" ? ["read", "bash"] : ["edit", "write"];
	const sysMsg = { role: "system", content: sysText, toolsAdded: [{ name: "bash", description: "run a command", parameters: { type: "object", properties: {} } }], timestamp: clock };
	sm.appendMessage(sysMsg);
	blocks.push({ id: sm.getLeafId(), ev: -1, kind: "system", tok: tokW(sysMsg), est: 0, turn: 0, tool: null, req: -1 });

	function tokW(m: Any): number {
		return Math.ceil((w.c * llmJson(m).length) / 4);
	}
	const key = () => `p/${models[mi].id}`;
	// ---- the fake Pi -------------------------------------------------------------------------------------------------------
	interface Inst { handlers: Map<string, Any>; tools: Map<string, Any>; zip: Any; ctx: Any; probe: boolean }
	function makeInst(manager: Any, probe = false): Inst {
		const handlers = new Map<string, Any>();
		const tools = new Map<string, Any>();
		const pi: Any = {
			on: (n: string, h: Any) => handlers.set(n, h),
			registerTool: (t: Any) => tools.set(t.name, t),
			registerCommand: () => {},
			registerEntryRenderer: () => {},
			registerToolRenderer: () => {},
			appendEntry: (t: string, d: Any) => { if (!probe) { if (timerFiring) producer.writes++; manager.appendCustomEntry(t, d); } },
			getAllTools: () => [],
			getCommands: () => [],
			getActiveTools: () => activeTools,
			getSettings: () => (w.warming ? { cacheWarming: "idle" } : {}),
		};
		piZip(pi);
		const ctx: Any = {
			mode: w.interactive ? "tui" : "print", hasUI: w.interactive, cwd: CWD,
			// pi-zip waits for a call still running (it says so in the working line): in a slow world that call answers now
			ui: { notify: () => {}, setWorkingMessage: (text?: string) => { if (text) for (const f of [...slowCalls]) f(); }, setStatus: () => {} },
			getSystemPrompt: () => sysText, sessionManager: manager, isIdle: () => true,
			// Pi provides abort() even while idle; native compaction is instant here, with no foreign handler to cancel.
			abort: () => {},
			modelRegistry: {
				complete: async (_m: Any, req: Any, options?: Any) => {
					const call = {}, end = () => activeCalls.delete(call);
					if (!probe) {
						activeCalls.add(call);
						producer.calls = Math.max(producer.calls, activeCalls.size);
						options?.signal?.addEventListener("abort", end, { once: true });
					}
					try {
					const r = narrativeOf(req);
					// the call's real tokens (the world's c per chars/4 token): an uncached read of the prompt, the narrative written
					narrativeCalls.push({ phase: probe ? "probe" : bgCall.getStore() && phase === "present" ? "background" : phase, at: clock, input: Math.ceil(w.c * r.usage.input), output: Math.ceil(w.c * r.usage.output) });
					if (w.slow && !probe && bgCall.getStore()) {
						// a slow world: the background call answers SLOW_MS later on the clock (or at once when pi-zip waits for it)
						await new Promise<void>((resolve) => {
							const done = () => { if (slowCalls.delete(done)) resolve(); };
							slowCalls.add(done);
							producerOwner.run(undefined, () => fakeSetTimeout(done, SLOW_MS));
						});
					}
					return r;
					} finally { end(); options?.signal?.removeEventListener("abort", end); }
				},
			},
		};
		Object.defineProperty(ctx, "model", { get: () => models[mi], enumerable: true });
		if (w.native) ctx.compact = (opts: Any) => void piCompact(manager, handlers, opts);
		return { handlers, tools, zip: null, ctx, probe };
	}
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (the integration test's rig): Pi's prepareCompaction decides
	 *  "Already compacted" / "Nothing to compact", session_before_compact supplies the result, appendCompaction. */
	async function piCompact(manager: Any, handlers: Map<string, Any>, options: Any) {
		if (manager === sm && !nativeAllowed) nativeIssues.push("native compaction outside the typed idle prompt");
		try {
			const branch = manager.getBranch();
			const prep = prepareCompaction(branch, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
			if (!prep) throw new Error("Nothing to compact");
			const h = handlers.get("session_before_compact");
			const res = h ? await h({ type: "session_before_compact", preparation: prep, branchEntries: branch, reason: "manual", willRetry: false, signal: new AbortController().signal }) : undefined;
			if (res?.cancel) throw new Error("Compaction cancelled");
			if (!res?.compaction) throw new Error("no extension compaction");
			const c = res.compaction;
			manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
			options?.onComplete?.({ ...c });
		} catch (err) {
			options?.onError?.(err instanceof Error ? err : new Error(String(err)));
		}
	}
	/** The narrative model: instant, and as long as summary.ts asks ("Stay under about N words": N words, the size the planner's
	 *  summary budget planned), its usage the prompt read uncached and the text written. */
	function narrativeOf(req: Any) {
		const prompt = textOfMsg(req?.messages?.[0]);
		const words = Number(/Stay under about (\d+) words/.exec(prompt)?.[1] ?? 300);
		const lines: string[] = ["## Decisions and rationale"];
		for (let k = 0; k < words; k += 14) lines.push(`- point ${k / 14}: the work goes on as decided, values kept exactly, nothing else to add here`);
		const text = lines.join("\n");
		return { stopReason: "stop", content: [{ type: "text", text }], usage: { input: Math.ceil(prompt.length / 4), output: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	}
	let live = makeInst(sm);
	const fire = async (inst: Inst, name: string, e: Any) => {
		const h = inst.handlers.get(name);
		if (name === "session_start") captured = null;
		let r: Any;
		nativeAllowed = !inst.probe && name === "before_agent_start";
		try { r = h ? await h(e, inst.ctx) : undefined; }
		finally { nativeAllowed = false; }
		if (name === "session_start") {
			// the Zip instance index.ts created (captured by the sessionStart wrapper): only its state is read, never written
			inst.zip = captured;
			if (inst.probe && inst.zip) { inst.zip.__probe = true; inst.zip.__sink = []; }
		}
		await drain(inst.zip);
		return r;
	};
	const runDue = async () => {
		for (;;) {
			timers = timers.filter((t) => !t.dead);
			const t = timers.filter((x) => x.due <= clock).sort((a, b) => a.due - b.due || a.id - b.id)[0];
			if (!t) return;
			t.dead = true;
			t.fn();
			await drain(live.zip);
		}
	};
	async function advance(ms: number) {
		const end = clock + ms;
		phase = "away";
		for (;;) {
			timers = timers.filter((t) => !t.dead);
			const t = timers.filter((x) => x.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
			if (!t) break;
			clock = Math.max(clock, t.due);
			t.dead = true;
			const before = narrativeCalls.length;
			t.fn();
			await drain(live.zip);
			if (narrativeCalls.length > before) envSince.push("away-summary");
		}
		clock = end;
		phase = "present";
	}
	let incomingDrafts: Any[] = [];
	const boundaryCtx = (manager: Any) => {
		const p = manager.buildSessionProjection();
		return { contextEntries: p.entries, contextMessages: p.messages, llmMessages: convertToLlm(p.messages), pendingMessages: [], canContinue: false };
	};

	// ---- Pi's idle cache warming (the real CacheWarmer; its refresh is one tiny request to the world's provider) -------------------
	function refreshResponse(model: Any) {
		const k = `p/${model.id}`;
		const ent = cache.get(k);
		const warm = !!ent && clock < ent.expires;
		const total = lastDesc.reduce((a: number, d: Any) => a + d.tok, 0);
		let read = 0;
		if (warm) for (let i = 0; i < lastDesc.length && i < ent!.msgs.length && ent!.msgs[i].h === lastDesc[i].h; i++) read += lastDesc[i].tok;
		cache.set(k, { msgs: lastDesc.map((d: Any) => ({ h: d.h, tok: d.tok })), expires: clock + ttlTrueS * 1000 });
		refreshes.push({ model: k, t: (clock - T0) / 1000, alive: warm });
		const explicit = w.cls === "explicit";
		const usage = { input: explicit ? 0 : total - read, cacheRead: read, cacheWrite: explicit ? total - read : 0, output: 1, totalTokens: total + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		return { role: "assistant", content: [{ type: "text", text: "." }], api: "anthropic-messages", provider: "p", model: model.id, usage, stopReason: "length", timestamp: clock };
	}
	const newWarmer = () =>
		w.warming
			? new CacheWarmer({ streamSimple: (model: Any) => ({ result: async () => refreshResponse(model) }) }, sm, () => "idle", async (event: Any) => {
					const h = live.handlers.get("cache_warming_decision");
					const r = h ? await h(event, live.ctx) : undefined;
					return r?.action ?? event.action;
				})
			: null;
	let warmer: Any = newWarmer();

	// ---- views and the world's cache -----------------------------------------------------------------------------------------
	function describeView(view: Any[], manager: Any) {
		const proj = manager.buildSessionProjection();
		// entry id of a sent message: by identity, else by content (Pi's projection may hand out new message objects after edits)
		const byMsg = new Map<Any, string>(), byCall = new Map<string, string>(), byHash = new Map<string, string>();
		for (const e of manager.getBranch()) if (e.type === "message" && e.message) byHash.set(sha(llmJson(e.message)), e.id);
		for (const pe of proj.entries) for (const m of pe.messages ?? []) {
			if (pe.sourceEntry?.id) byMsg.set(m, pe.sourceEntry.id);
			if (pe.sourceEntry?.type === "custom_message") byHash.set(sha(llmJson(m)), pe.sourceEntry.id); // an extension's message (drive, nextturn)
			const src = pe.sourceEntry;
			if (src?.type === "message" && src.message?.role === "toolResult") byCall.set(src.message.toolCallId, src.id);
		}
		for (const e of manager.getBranch()) if (e.type === "message" && e.message?.role === "toolResult") byCall.set(e.message.toolCallId, e.id);
		return view.map((m: Any) => {
			const ph = m.role === "toolResult" && textOfMsg(m).startsWith(PH_MARK);
			const sum = m.role === "compactionSummary" ? (String(m.summary ?? "").startsWith("FOREIGN") ? "foreign" : "zip") : null;
			const h = sha(llmJson(m));
			const id = m.role === "toolResult" ? (byCall.get(m.toolCallId) ?? null) : (byMsg.get(m) ?? byHash.get(h) ?? null);
			return { h, tok: tokW(m), role: m.role, id, ph, sum };
		});
	}
	function usageFor(desc: Any[], outTok: number) {
		const k = key();
		const ent = cache.get(k);
		const warm = !!ent && clock < ent.expires;
		let read = 0;
		if (warm) for (let i = 0; i < desc.length && i < ent!.msgs.length && ent!.msgs[i].h === desc[i].h; i++) read += desc[i].tok;
		const total = desc.reduce((a: number, d: Any) => a + d.tok, 0);
		const explicit = w.cls === "explicit";
		const u = explicit ? { input: 0, cacheRead: read, cacheWrite: total - read } : { input: total - read, cacheRead: read, cacheWrite: 0 };
		return { warm, read, total, u: { ...u, output: outTok, totalTokens: total + outTok, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	}
	const mods = (desc: Any[]) => new Set(desc.filter((d) => d.ph || d.sum === "zip").map((d) => (d.ph ? `f:${d.id}` : `s:${d.h}`)));

	/** The request as the provider gets it (Anthropic messages, the shape guard.ts repairs): system blocks, tools, messages with
	 *  tool_use / tool_result pairs, errored and aborted assistant messages dropped (pi-ai transform-messages), and the cache tier in
	 *  cache_control (1 hour on the long tier, which pi-zip reads back: cache.ts payloadRetention). */
	function payloadOf(view: Any[]): Any {
		const llm = convertToLlm(view);
		const cc = long ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
		const system: Any[] = llm.filter((m: Any) => m.role === "system").map((m: Any) => ({ type: "text", text: textOfMsg(m) }));
		const messages: Any[] = [];
		for (const m of llm) {
			if (m.role === "system") continue;
			if (m.role === "toolResult") {
				const block = { type: "tool_result", tool_use_id: m.toolCallId, content: textOfMsg(m), ...(m.isError ? { is_error: true } : {}) };
				const last = messages.at(-1);
				if (last?.role === "user" && last.content.every((b: Any) => b.type === "tool_result")) last.content.push(block);
				else messages.push({ role: "user", content: [block] });
			} else if (m.role === "assistant") {
				if (m.stopReason === "error" || m.stopReason === "aborted") continue;
				messages.push({ role: "assistant", content: (m.content ?? []).map((c: Any) => (c.type === "toolCall" ? { type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} } : { type: "text", text: c.text ?? c.thinking ?? "" })) });
			} else messages.push({ role: "user", content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []).map((c: Any) => ({ type: "text", text: c.text ?? "" })) });
		}
		if (system.length) system[system.length - 1].cache_control = cc;
		const lastMsg = messages.at(-1);
		if (lastMsg?.content?.length) lastMsg.content[lastMsg.content.length - 1].cache_control = cc;
		return { model: models[mi].id, max_tokens: 8192, stream: true, system, tools: [{ name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } }], messages };
	}

	// ---- probes --------------------------------------------------------------------------------------------------------------
	// pi-zip's state just before the run's before_agent_start: what a WARM return would have planned with (a cold return resets
	// summarizedWarm, and the b2b rule applies only to warm returns)
	let preRun: { sw: boolean; je: boolean } | null = null;
	/** The decisions of one hook, as run.ts made them. A warm plan whose cut moved away from a summary written in the background is
	 *  planned once more with `cutAt` (run.ts pinned): when that plan cuts there, it is the decision and the first plan is not; when it does
	 *  not, the first plan stands and the pinned attempt is dropped. */
	function decisions(caps: Any[], room = false): Any[] {
		const out: Any[] = [];
		for (const captured of caps) {
			const c = { ...captured, o: { ...captured.o, scale: captured.live.scale, carriedFolds: captured.live.carriedFolds } };
			// a cut with no ready summary gives way to its folds alone (core.ts unready): that plan is the decision, except at the room
			// wait (a turn_end still at Pi's compaction room), whose decision is the plan with its own cut
			if (c.o.foldsOnly && room) continue;
			if (c.o.foldsOnly) {
				// the plan it replaced is the production decision (its cut is written in the background): kept as its own decision point
				// ("produce"), so the law that priced that call is checked too (LW, PW, RC, MP)
				const k = out.findLastIndex((x: Any) => x.pending === c.pending && x.mode === c.mode && !x.o.foldsOnly && !x.produce);
				if (k >= 0) out[k] = { ...out[k], produce: true };
				out.push(c);
				continue;
			}
			if (c.o.cutAt === undefined) {
				out.push(c);
				continue;
			}
			let r: Any = null;
			try {
				r = plan.planContext(c.entries, { ...c.o, trace: [] });
			} catch {}
			if (r?.firstKeptEntryId !== c.o.cutAt) continue;
			const k = out.findLastIndex((x: Any) => x.pending === c.pending && x.mode === c.mode && x.o.cutAt === undefined);
			if (k >= 0) out.splice(k, 1);
			out.push(c);
		}
		return out;
	}
	function gridFor(cap: Any) {
		const out: Any[] = [];
		const actual = Number(cap.o.law?.pWarm ?? 0);
		const ps = [...new Set([...(probes.pgrid as number[]), actual])].sort((a, b) => a - b);
		const pre = (cap.at === "run" || cap.at === "native") && actual < 0.5 ? preRun : null;
		// one planner (0.4.0): everything but P is the captured decision's (the pause too); P enters the law, and the two rules that read
		// P >= 0.5 outside it: b2b and the one summary per warm stretch
		const sw = pre ? !!pre.sw : !!cap.sw;
		for (const p of ps) {
			const mode = p < 0.5 ? "cold" : "warm"; // a label (run.ts: cold = P(warm) < 0.5)
			// a warm plan at an actual cold return: the state a warm return would have seen (summarizedWarm not reset; b2b skip)
			if (pre && mode === "warm" && pre.je) {
				out.push({ p, actual: false, mode, plan: false, b2b: true, folds: [], cut: null, prefix: 0, sum: 0, before: null, afterFolds: null, after: null, law: [] });
				continue;
			}
			const noSummary = mode !== "warm" ? false : actual >= 0.5 ? !!cap.o.noSummary : sw;
			const regrowAt = noSummary ? (actual >= 0.5 ? cap.o.regrowAt : cap.regrow || undefined) : undefined;
			const o = { ...cap.o, law: { ...cap.o.law, pWarm: p }, noSummary, regrowAt, trace: [] };
			let r: Any = null;
			try {
				r = plan.planContext(cap.entries, o);
			} catch (err) {
				out.push({ p, mode, error: String(err) });
				continue;
			}
			const c = r ? (r.scale?.c ?? r.k ?? 1) : 1;
			const after = r ? r.ctxAfterFolds - (r.cutIdx !== null ? c * (r.prefixTokens - r.summaryTokensPlanned) : 0) : null;
			out.push({ p, actual: p === actual, mode, plan: !!r, folds: r ? r.folds.map((f: Any) => f.entryId) : [], cut: r?.firstKeptEntryId ?? null, prefix: r ? c * r.prefixTokens : 0, sum: r ? c * r.summaryTokensPlanned : 0, before: r?.ctxTokens ?? null, afterFolds: r ? r.ctxAfterFolds : null, after, law: o.trace.map((t: Any) => ({ at: t.where, ok: t.ok, B: t.B, A: t.A, T: t.T, K: t.K, phi: t.phi, eta: t.eta, ...(t.cut !== undefined ? { cut: t.cut } : {}), ...(t.ready ? { ready: true } : {}), ...(t.key ? { key: t.key } : {}) })) });
		}
		// WL's oracle: a warm decision the one-summary-per-warm-stretch flag constrained, planned again at the actual P with the flag lifted
		// (everything else as captured): the summary the flag kept out, if any, and the law's verdict on it
		let free: Any = null;
		if (actual >= 0.5 && cap.o.noSummary) {
			const o = { ...cap.o, law: { ...cap.o.law, pWarm: actual }, noSummary: false, regrowAt: undefined, trace: [] };
			try {
				const r = plan.planContext(cap.entries, o);
				free = { plan: !!r, cut: r?.firstKeptEntryId ?? null, folds: r ? r.folds.map((f: Any) => f.entryId) : [], afterFolds: r ? r.ctxAfterFolds : null, law: o.trace.map((t: Any) => ({ at: t.where, ok: t.ok, B: t.B, A: t.A, T: t.T, K: t.K, phi: t.phi, eta: t.eta, ...(t.cut !== undefined ? { cut: t.cut } : {}), ...(t.ready ? { ready: true } : {}), ...(t.key ? { key: t.key } : {}) })) };
			} catch (err) {
				free = { error: String(err) };
			}
		}
		return { room: !!cap.room, at: cap.at, mode: cap.mode, p: actual, pause: !!cap.o.pause, noSummary: !!cap.o.noSummary, regrowAt: cap.o.regrowAt ?? null, g: cap.o.law?.g ?? null, pr: cap.o.law?.pr ?? null, grid: out, free };
	}

	// A second pi-zip instance on the live session, never driven: the model's way back to a folded output (its zip_recall, its
	// tool_call hook for recall files), called without touching the live instance's state.
	let recallInst: Inst | null = null;
	/** zip_recall(handle) as the model calls it, every page (offset, limit 50000), with the section header, page header and the
	 *  "more chars" hint taken off: the bytes the model gets back. null: the tool says it cannot. */
	async function recallByTool(handle: string): Promise<string | null> {
		const tool = recallInst?.tools.get("zip_recall");
		if (!tool) return null;
		let out = "";
		let offset = 0;
		for (let k = 0; k < 64; k++) {
			const r = await tool.execute("probe", { handle, offset, limit: 50_000 }, undefined, undefined, recallInst!.ctx);
			if (r?.isError) return null;
			const text = textOfMsg(r);
			// recall.ts sliceRecall: section head line, then "[chars a-b of n]\n" when paged, the page, and the "more chars" hint when
			// more is left (the page itself may contain anything, a zip_recall result included: only the framing is parsed)
			let rest = text.slice(text.indexOf("\n") + 1);
			const page = /^\[chars (\d+)-(\d+) of (\d+)\]\n/.exec(rest);
			if (!page) return out + rest;
			rest = rest.slice(page[0].length);
			const end = Number(page[2]), n = Number(page[3]);
			if (end >= n) return out + rest;
			const hint = rest.lastIndexOf(`\n[… ${n - end} more chars: call zip_recall again with offset=${end} `);
			if (hint < 0) return null;
			out += rest.slice(0, hint);
			offset = end;
		}
		return out;
	}
	/** A built-in read of a recall file as the model calls it: Pi fires tool_call (pi-zip writes this machine's copy and points the
	 *  path at it), then read returns the file. null: no such file. */
	async function recallByFile(inst: Inst, path: string): Promise<string | null> {
		const input = { path };
		await fire(inst, "tool_call", { type: "tool_call", toolName: "read", toolCallId: "probe", input });
		try {
			return readFileSync(input.path, "utf8");
		} catch {
			return null;
		}
	}
	const handleIn = (ph: string) => /· handle ([0-9a-z]{10})\]/.exec(ph.slice(0, ph.indexOf("\n") >>> 0))?.[1] ?? null;
	const recallPathIn = (ph: string) => / in (\S+\/[0-9a-z]{10}\.txt):/.exec(ph)?.[1] ?? null;

	/** A1 on one request as sent. Cheap structural checks every time; the recall round trips when `deep`. */
	async function lossless(desc: Any[], view: Any[], guardRewrote: string | null, deep: boolean): Promise<string[]> {
		const issues: string[] = [...hijacked.splice(0)];
		const branch = sm.getBranch();
		const originals = new Map<string, Any>();
		for (const e of branch) if (e.type === "message") originals.set(e.id, e.message);
		const origHashes = new Set([...originals.values()].map((m) => sha(llmJson(m))));
		// extensions' messages (a run's starter, a prompt's nextTurn message) as Pi projects them: pi-zip never rewrites them
		for (const pe of sm.buildSessionProjection().entries) if (pe.sourceEntry?.type === "custom_message") for (const m of pe.messages ?? []) origHashes.add(sha(llmJson(m)));
		const visible = new Set<string>();
		const folded: { id: string; text: string }[] = [];
		desc.forEach((d: Any, k: number) => {
			if (d.role === "toolResult") {
				const o = d.id ? originals.get(d.id) : null;
				if (!o) issues.push(`toolResult without an original (${d.id})`);
				else if (d.ph) folded.push({ id: d.id, text: textOfMsg(view[k]) });
				else if (sha(llmJson(o)) !== d.h) { if (!foreignEdited.has(d.id)) issues.push(`toolResult ${d.id} rewritten but not a pi-zip placeholder`); }
				else visible.add(d.id);
			} else if (d.role === "user" || d.role === "assistant" || d.role === "system" || d.role === "custom") {
				if (!origHashes.has(d.h)) issues.push(`${d.role} message rewritten (${d.id ?? "?"})`);
				if (d.id) visible.add(d.id);
			}
		});
		// by position: the conversation the request carries is the session's, from its first kept message to the newest, one to one
		// and in order (a summary may stand for a prefix; nothing in between may go missing)
		const convo = branch.filter((e: Any) => (e.type === "message" && e.message?.role !== "system") || e.type === "custom_message").map((e: Any) => e.id);
		const kept = desc.filter((d: Any) => d.role !== "system" && !d.sum);
		if (kept.some((d: Any) => !d.id)) issues.push(`the request carries ${kept.filter((d: Any) => !d.id).length} message(s) the session does not hold`);
		else if (kept.length) {
			const k0 = convo.indexOf(kept[0].id);
			const want = k0 < 0 ? [] : convo.slice(k0);
			const miss = want.findIndex((id: string, j: number) => kept[j]?.id !== id);
			if (k0 < 0) issues.push(`the request starts with ${kept[0].id}, which is not in the session`);
			else if (miss >= 0) issues.push(`message ${want[miss]} of the session is missing from the request at position ${miss} of the kept part (it sends ${kept[miss]?.id ?? "nothing"} there)`);
			else if (kept.length > want.length) issues.push(`the request carries ${kept.length - want.length} message(s) after the session's newest`);
			else if (k0 > 0 && !desc.some((d: Any) => d.sum)) issues.push(`the request drops the session's first ${k0} message(s) and no summary stands for them`);
		}
		// the system prompt is never rewritten
		if (!desc.some((d: Any) => d.role === "system" && d.h === sha(llmJson(sysMsg)))) issues.push("system prompt missing or rewritten");
		if (guardRewrote) issues.push(guardRewrote);
		// README rule 1: every folded block carries a handle and shows its key lines (first, last, the error line)
		for (const f of folded) {
			const o = textOfMsg(originals.get(f.id));
			const h = handleIn(f.text);
			if (!h) issues.push(`the placeholder of ${f.id} names no handle`);
			const lines = o.split("\n");
			const need = [1, lines.length];
			const err = lines.findIndex((l, i) => i > 0 && i < lines.length - 1 && ERROR_LINE.test(l));
			if (err >= 0) need.push(err + 1);
			for (const no of need) if (lines[no - 1]?.trim() && !f.text.includes(`${no}: ${clip(lines[no - 1], 160)}`)) issues.push(`the placeholder of ${f.id} does not show key line ${no}`);
			// the way back the placeholder names: zip_recall(handle) (only where the model has it), a read of the recall file it names
			// (only where it has read), or a re-read of the source (only for an output that can be re-read)
			const reread = f.text.includes(`(${"zip_recall"} is not enabled in this session)`);
			if (reread) {
				if (toolOf.get(f.id) !== "cat") issues.push(`${f.id} folded with "re-read the source", but it cannot be re-read`);
				continue;
			}
			if (w.tools === "reread") { issues.push(`reread-only mode folded ${f.id} with a way back the model does not have`); continue; }
			if (!deep || !h) continue;
			const path = w.tools === "file" ? recallPathIn(f.text) : null;
			if (w.tools === "file" && !path) { issues.push(`the placeholder of ${f.id} names no recall file`); continue; }
			const got = w.tools === "file" ? await recallByFile(recallInst!, path!) : await recallByTool(h);
			if (got !== o) issues.push(`${w.tools === "file" ? `reading ${path}` : `zip_recall("${h}")`} does not return the original bytes of ${f.id} (${got === null ? "nothing" : `${got.length} of ${o.length} chars`})`);
		}
		// every other output the model does not see verbatim (summarised or compacted away) comes back by its handle
		if (deep && w.tools !== "reread") {
			const isFolded = new Set(folded.map((f) => f.id));
			const hidden = branch.filter((e: Any) => e.type === "message" && e.message?.role === "toolResult" && !visible.has(e.id) && !isFolded.has(e.id));
			const sid = sm.getSessionId();
			for (const e of hidden) {
				const h = handleFor(e.id);
				const got = w.tools === "file" ? await recallByFile(recallInst!, `~/.cache/pi-zip/recall/${sid}/${h}.txt`) : await recallByTool(h);
				if (got !== textOfMsg(e.message)) issues.push(`the hidden output ${e.id} does not come back byte for byte by its handle ${h}`);
			}
		}
		// user requests pi-zip summarised away are quoted verbatim by its summary (the README's promise)
		const sumText = view.filter((m: Any) => m.role === "compactionSummary" && !String(m.summary).startsWith("FOREIGN")).map((m: Any) => String(m.summary)).join("\n");
		const users = branch.filter((e: Any) => e.type === "message" && e.message?.role === "user" && !visible.has(e.id) && !foreignDropped.has(e.id));
		for (const e of users) if (!sumText.includes(textOfMsg(e.message))) issues.push(`user request ${e.id} summarised away and not quoted verbatim`);
		return issues;
	}
	/** After someone else's compaction: the user messages it took out of the view are not pi-zip's to quote. */
	function markForeignDropped() {
		const shown = new Set(sm.buildSessionProjection().entries.map((pe: Any) => pe.sourceEntry?.id));
		for (const e of sm.getBranch()) if (e.type === "message" && e.message?.role === "user" && !shown.has(e.id)) foreignDropped.add(e.id);
	}

	// in-memory Zip state a restart loses, transplanted one group at a time into a fresh process to find which one makes the difference
	// (the learned class and survival and the cache tier are not in this list: beforeAgentStart reloads them from disk and env)
	const TRANSPLANT: Record<string, string[]> = {
		g: ["g", "deltas"],
		justEdited: ["justEdited"],
		summarizedWarm: ["summarizedWarm", "summaryRegrow"],
		clock: ["lastReqMs", "lastModelKey", "prevTotal", "prevKey"],
	};
	const KNOWN = ["g", "justEdited", "summarizedWarm"]; // TRIAGE (a) 1: the three fields the session does not carry
	async function freshProbe(snapshot: Any[], userMsg: Any, liveDesc: Any[], liveState?: Any) {
		const base = await freshOnce(snapshot, userMsg, liveDesc, null);
		if (base.same || !liveState) return base;
		const fixedBy: string[] = [];
		for (const [name, fields] of Object.entries(TRANSPLANT)) {
			const r = await freshOnce(snapshot, userMsg, liveDesc, Object.fromEntries(fields.map((f) => [f, liveState[f]])));
			if (r.same) fixedBy.push(name);
		}
		const pick = (groups: string[]) => Object.fromEntries(groups.flatMap((g) => TRANSPLANT[g]).map((f) => [f, liveState[f]]));
		const fixedByKnown = (await freshOnce(snapshot, userMsg, liveDesc, pick(KNOWN))).same;
		const fixedByAll = fixedByKnown || (await freshOnce(snapshot, userMsg, liveDesc, pick(Object.keys(TRANSPLANT)))).same;
		return { ...base, fixedBy, fixedByKnown, fixedByAll };
	}
	async function freshOnce(snapshot: Any[], userMsg: Any, liveDesc: Any[], transplant: Any | null) {
		// the fresh process plans at the instant the live request was sent (probeAt), and its timers never outlive the probe
		const savedClock = clock, firstTid = tid;
		clock = probeAt;
		// ... and knows only what the stats file held then (the live response has since recorded its own observation)
		const probeStats = join(WORK, "probe-stats.json");
		writeFileSync(probeStats, statsAtPrompt);
		process.env.PI_ZIP_CACHE_STATS = probeStats;
		try {
			return await freshInner(snapshot, userMsg, liveDesc, transplant);
		} finally {
			process.env.PI_ZIP_CACHE_STATS = STATS;
			clock = savedClock;
			timers = timers.filter((t) => t.id <= firstTid);
		}
	}
	let probeAt = 0;
	let probeNextTurn: Any[] = []; // custom messages that rode with the prompt of the run the fresh probe replays (nextturn)
	let ncSeen = 0;
	let statsAtPrompt = "";
	async function freshInner(snapshot: Any[], userMsg: Any, liveDesc: Any[], transplant: Any | null) {
		const sm2 = withFile(SessionManager.inMemory(CWD, undefined, structuredClone(snapshot)));
		const saved = { sink, optsSink, phase };
		optsSink = null;
		const inst = makeInst(sm2, true);
		try {
			await fire(inst, "session_start", { type: "session_start", reason: "resume" });
			if (transplant && inst.zip) Object.assign(inst.zip, structuredClone(transplant));
			if (userMsg.role === "custom") {
				// a run an extension's message starts: agent_start only, then the message (Pi 1.1.0 _runAgentPrompt)
				await fire(inst, "agent_start", { type: "agent_start" });
				sm2.appendCustomMessageEntry(userMsg.customType, userMsg.content, userMsg.display);
				await fire(inst, "message_end", { message: userMsg });
			} else {
				await fire(inst, "before_agent_start", { type: "before_agent_start", prompt: userMsg.content, images: [] });
				await fire(inst, "agent_start", { type: "agent_start" }); // Pi emits it right after before_agent_start (a run an extension's message starts emits only this one)
				sm2.appendMessage(structuredClone(userMsg));
				await fire(inst, "message_end", { message: userMsg });
				for (const c of probeNextTurn) {
					sm2.appendCustomMessageEntry(c.customType, c.content, c.display);
					await fire(inst, "message_end", { message: c });
				}
			}
			const raw = sm2.buildSessionContext().messages;
			const out = await fire(inst, "context_with_system", { type: "context_with_system", messages: raw });
			const view = out?.messages ?? raw;
			const desc = describeView(view, sm2);
			const a = liveDesc.map((d) => d.h).join(","), b = desc.map((d: Any) => d.h).join(",");
			const ledger = inst.zip?.__sink ?? [];
			// 0.4.0: a summary is used only when ready, and a ready one is a pi-zip/summary entry the fresh process reads too (round 5's
			// excuse for a fresh process that deferred the live cut is gone)
			return { same: a === b, live: liveDesc.length, fresh: desc.length, liveMods: [...mods(liveDesc)].length, freshMods: [...mods(desc)].length, freshPlan: ledger.filter((r: Any) => r.type === "cold_plan" || r.type === "b2b_skip" || r.type === "produce").map(slim) };
		} finally {
			await fire(inst, "session_shutdown", {});
			({ sink, optsSink, phase } = saved);
		}
	}
	const slim = (r: Any) => {
		const { ts, pid, ...rest } = r;
		return rest;
	};

	// ---- one request -------------------------------------------------------------------------------------------------------------
	type Resp = { call?: { tool: string; size: number }; say?: number; fail?: "error" | "aborted" };
	/** The tool the model calls for `recall`, in the world's tool selection: zip_recall of the newest output it sees folded; a read of
	 *  that output's recall file (file mode); a re-run of its read-only command (reread mode). */
	function recallCall(desc: Any[]): { name: string; args: Any; of: string | null } {
		const foldedIds = desc.filter((d: Any) => d.ph && d.id).map((d: Any) => d.id);
		const vis = new Set(desc.map((d: Any) => d.id));
		const outs = sm.getBranch().filter((e: Any) => e.type === "message" && e.message?.role === "toolResult" && !["recall"].includes(toolOf.get(e.id) ?? ""));
		const of: string | null = foldedIds.at(-1) ?? outs.find((e: Any) => !vis.has(e.id))?.id ?? outs.at(-1)?.id ?? null;
		const h = of ? handleFor(of) : "0000000000";
		if (w.tools === "full") return { name: "zip_recall", args: { handle: h }, of };
		if (w.tools === "file") return { name: "read", args: { path: `~/.cache/pi-zip/recall/${sm.getSessionId()}/${h}.txt` }, of };
		const orig = of ? sm.getBranch().find((e: Any) => e.id === of) : null;
		const callOf = orig ? sm.getBranch().flatMap((e: Any) => (e.type === "message" && e.message?.role === "assistant" ? e.message.content ?? [] : [])).find((c: Any) => c?.type === "toolCall" && c.id === orig.message.toolCallId) : null;
		return { name: "bash", args: { command: callOf?.arguments?.command ?? "cat src/file0.ts" }, of };
	}

	async function request(resp: Resp, ev: number, firstProbe?: { snapshot: Any[]; userMsg: Any; liveState?: Any }) {
		await runDue();
		const z = live.zip;
		const gapMs = lastResp ? clock - lastResp : null;
		const t0 = (clock - T0) / 1000;
		const runStart = reqInRun === 0;
		const state0 = runStart ? { cold: !!z?.cold, pWarm: z?.pWarm ?? null, pause: !!z?.pause, summarizedWarm: !!z?.summarizedWarm } : null;
		envSince.push(...envNext.splice(0));
		sink = [];
		optsSink = [];
		const nc0 = narrativeCalls.length;
		const raw = sm.buildSessionContext().messages;
		const out = await fire(live, "context_with_system", { type: "context_with_system", messages: raw });
		const view = out?.messages ?? raw;
		const payload = payloadOf(view);
		const before = JSON.stringify(payload);
		const sent = await fire(live, "before_provider_request", { type: "before_provider_request", payload });
		// a well-formed request goes out as built: the guard rewriting it means an edit broke the tool_use / tool_result pairing
		const guardRewrote = sent !== undefined && JSON.stringify(sent) !== before ? `the request guard rewrote the request (${(sent?.messages ?? []).filter((m: Any, k: number) => JSON.stringify(m) !== JSON.stringify(payload.messages[k])).length} message(s)): an edit broke the tool_use / tool_result pairing` : null;
		const desc = describeView(view, sm);
		const rawDesc = out ? describeView(raw, sm) : desc;
		const prevMods = lastView ? mods(describeView(lastView, sm)) : new Set<string>();
		const curMods = mods(desc);
		const zipNew = [...curMods].filter((m) => !prevMods.has(m));
		// A1 on this request as sent: structure every time; the recall round trips whenever it carries something new from pi-zip, at
		// every run start, and after anything someone else changed
		const lossIssues = probes.lossless ? await lossless(desc, view, guardRewrote, zipNew.length > 0 || runStart || envSince.some((e) => e === "compact" || e === "edit" || e === "foreign")) : [];
		const runPlan = z?.runPlan;
		const planGrids = decisions(optsSink.filter((c: Any) => !c.pending)).map((c: Any) => gridFor({ ...c, at: c.produce ? "produce" : "run" }));
		const runLedger = [...(runStart ? nativeLedger : []), ...sink.map(slim)];
		// Pi's cache warmer restarts from every session request (sdk.ts streamFn): it keeps this request's prefix warm while the
		// session still extends it and the model is the same
		if (warmer) {
			const m0 = mi, hs = desc.map((d: Any) => d.h);
			warmer.start({ model: models[mi], context: { messages: view }, options: {} }, () => {
				if (mi !== m0) return false;
				const now = describeView(sm.buildSessionContext().messages, sm);
				return hs.every((h: string, k: number) => now[k]?.h === h);
			});
		}
		// the world answers
		const fail = resp.fail ?? null;
		const outTok = fail ? 0 : (resp.say ?? 50);
		const wu = usageFor(desc, outTok);
		clock += LAT_MS;
		const callId = resp.call && !fail ? `call${++callNo}` : null;
		let recallOf: string | null = null;
		let name: string | null = null;
		let args: Any = null;
		if (callId) {
			if (resp.call!.tool === "recall") {
				const rc = recallCall(desc);
				({ name, args } = rc);
				recallOf = rc.of;
			} else {
				name = "bash";
				args = { command: resp.call!.tool === "cat" ? `cat src/file${callNo}.ts` : "npm test" };
			}
		}
		const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const content: Any[] = fail === "error" ? [] : [{ type: "text", text: fail ? `partial answer (${reqNo})` : resp.say ? body(`A${reqNo}`, resp.say) : `working on it (${reqNo})` }];
		if (callId) content.push({ type: "toolCall", id: callId, name, arguments: args });
		const asst = { role: "assistant", content, api: "anthropic-messages", provider: "p", model: models[mi].id, usage: fail ? zeroUsage : wu.u, stopReason: fail ?? (callId ? "toolUse" : "stop"), ...(fail === "error" ? { errorMessage: "overloaded_error" } : {}), timestamp: clock };
		const aid = sm.appendMessage(asst);
		blocks.push({ id: aid, ev, kind: "assistant", tok: tokW(asst), est: 0, turn, tool: null, req: reqNo });
		await fire(live, "message_end", { type: "message_end", message: asst });
		const t1 = (clock - T0) / 1000;
		// an error is the provider refusing the request (overloaded): its cache is not touched; an abort (Esc) comes after the
		// provider read and wrote the prompt
		if (fail !== "error") {
			lastResp = clock;
			cache.set(key(), { msgs: desc.map((d: Any) => ({ h: d.h, tok: d.tok })), expires: clock + ttlTrueS * 1000 });
		}
		lastDesc = desc;
		const toolResults: Any[] = [];
		if (callId) {
			clock += TOOL_MS;
			// Pi fires tool_call before it runs any tool (pi-zip points recall-file paths at this machine's copy there)
			const input = structuredClone(args);
			await fire(live, "tool_call", { type: "tool_call", toolName: name, toolCallId: callId, input });
			let text: string;
			if (resp.call!.tool === "recall") {
				if (name === "zip_recall") {
					const tool = live.tools.get("zip_recall");
					const r = tool ? await tool.execute(callId, input, undefined, undefined, live.ctx) : { content: [{ type: "text", text: "no zip_recall" }] };
					text = textOfMsg(r);
				} else if (name === "read") {
					try {
						text = readFileSync(input.path, "utf8");
					} catch {
						text = `ENOENT: ${input.path}`;
					}
				} else {
					// reread mode: the model re-runs the command (a re-read of the same file returns the same bytes)
					const orig = recallOf ? sm.getBranch().find((e: Any) => e.id === recallOf) : null;
					const cat = String(input.command).startsWith("cat ");
					text = orig && cat && toolOf.get(recallOf!) === "cat" ? textOfMsg(orig.message) : body(`OUT${callNo}`, 2000, !cat);
				}
				envNext.push("recall");
			} else text = body(`OUT${callNo}`, resp.call!.size, resp.call!.tool === "npm");
			const tr = { role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text }], timestamp: clock };
			const rid = sm.appendMessage(tr);
			toolResults.push(tr);
			const kind = resp.call!.tool === "recall" ? (name === "bash" ? (String(args.command).startsWith("cat ") ? "cat" : "npm") : "recall") : resp.call!.tool;
			toolOf.set(rid, kind);
			blocks.push({ id: rid, ev, kind: "toolResult", tok: tokW(tr), est: Math.ceil(text.length / 4), turn, tool: kind, req: reqNo, recallOf: kind === "recall" ? recallOf : null });
			await fire(live, "message_end", { type: "message_end", message: tr });
		}
		// turn_end: the boundary handlers propose drafts, Pi applies them
		sink = [];
		optsSink = [];
		const nc1 = narrativeCalls.length;
		const rp = z?.runPlan, rpWasPersisted = !!rp?.persisted, rpSent = !!rp?.sent;
		const incoming = incomingDrafts.splice(0);
		const staged = incoming.length ? SessionManager.inMemory(WORK, undefined, [sm.getHeader(), ...sm.getBranch()]) : sm;
		applyDrafts(staged, incoming);
		const te = await fire(live, "turn_end", { type: "turn_end", turnIndex: reqInRun, message: asst, toolResults, messageEntryId: aid, toolResultEntryIds: [], context: boundaryCtx(staged), entries: incoming });
		const drafts: Any[] = te?.entries ?? incoming;
		const ours = drafts.slice(incoming.length);
		const exactIssues: string[] = nativeIssues.splice(0);
		const compaction = drafts.find((d: Any) => d.type === "compaction" && d.details?.by === "pi-zip");
		const piBefore = estimateProjectedContextTokens(staged.buildSessionProjection(), staged.getBranch()).tokens;
		if (compaction && drafts[incoming.length] !== compaction) exactIssues.push("the compaction was not the first boundary draft");
		if (runStart && runPlan?.cut && !runPlan.native) exactIssues.push("a summary was applied request-locally");
		const teGrids = decisions(optsSink.filter((c: Any) => !c.pending), sink.some((x: Any) => x.type === "room_wait")).map((c: Any) => gridFor({ ...c, at: c.produce ? "produce" : "turn_end" }));
		const teLedger = sink.map(slim);
		optsSink = null;
		applyDrafts(sm, drafts);
		if (compaction) {
			const written = sm.getBranch().findLast((d: Any) => d.type === "compaction" && d.summary === compaction.summary);
			const reported = sink.find((x: Any) => x.type === "summary" && x.via !== "native")?.tokensBefore;
			if (written?.tokensBefore !== piBefore || reported !== piBefore) exactIssues.push("Pi's boundary number differs from pi-zip's before");
		}
		// I1: what turn_end persisted equals what was sent (the projection now starts with the view of this request)
		let persistOk: boolean | null = null;
		const committedSent = !!rp && rpSent && !rpWasPersisted && !!rp.persisted;
		const roomCut = sink.some((x: Any) => x.type === "room_wait") ? compaction?.firstKeptEntryId : undefined;
		const boundaryCut = compaction?.firstKeptEntryId;
		// The boundary may add folds that became eligible since the request; compare their declared replacements too.
		const expected = new Map<string, string>();
		for (const d of drafts) if (d.type === "context_edit" && !rp?.applied?.has(d.targetId)) {
			const original = sm.getBranch().find((e: Any) => e.id === d.targetId)?.message;
			if (original) expected.set(d.targetId, sha(llmJson({ ...original, content: d.replacement.content })));
		}
		if (committedSent && boundaryCut) {
			// the room wait's summary went in with the run plan (the unified turn_end decision): what it keeps must be exactly what the request sent
			const now = describeView(sm.buildSessionContext().messages, sm);
			const k = desc.findIndex((d: Any) => d.id === boundaryCut), off = now.findIndex((d: Any) => d.id === boundaryCut);
			persistOk = k >= 0 && off >= 0 && desc.slice(k).every((d: Any, i: number) => now[off + i]?.h === (expected.get(d.id) ?? d.h));
		} else if (committedSent && drafts.some((d: Any) => d.type === "context_edit" || d.type === "compaction")) {
			const now = describeView(sm.buildSessionContext().messages, sm).map((d: Any) => d.h);
			persistOk = desc.every((d: Any, i: number) => now[i] === (expected.get(d.id) ?? d.h));
		}
		const t: Any = {
			exactIssues,
			nativeDoor: runStart ? pendingNative : null,
			req: reqNo, ev, run: runNo, n: reqInRun, t0, t1, gap: gapMs === null ? null : gapMs / 1000, model: key(), failed: fail,
			warm: wu.warm, total: wu.total, read: wu.read, out: outTok, rawTok: rawDesc.reduce((a: number, d: Any) => a + d.tok, 0),
			view: desc, zipNew, env: envSince, state0, lossless: lossIssues,
			runPlan: runStart && runPlan ? { source: runPlan.source, folds: runPlan.folds.map((f: Any) => f.entryId), cut: runPlan.cut?.firstKeptEntryId ?? runPlan.native?.firstKeptEntryId ?? null, native: !!runPlan.native } : null,
			runLedger, teLedger,
			drafts: ours.map((d: Any) => (d.type === "context_edit" ? { type: d.type, target: d.targetId } : d.type === "compaction" ? { type: d.type, firstKept: d.firstKeptEntryId } : { type: d.type, customType: d.customType })),
			persistOk, teValve: (!committedSent || !!boundaryCut) && ours.some((d: Any) => d.type === "context_edit" || d.type === "compaction"), runRoom: committedSent && !!roomCut,
			// the narrative model calls since the previous request's turn_end (away, at the previous turn_end, in this run plan)
			narr: narrativeCalls.slice(ncSeen, nc1).filter((c) => c.phase !== "probe").map((c) => ({ input: c.input, output: c.output, away: c.phase === "away" })),
			waitRun: narrativeCalls.slice(nc0, nc1).filter((c) => c.phase === "present").length,
			waitTe: narrativeCalls.slice(nc1).filter((c) => c.phase === "present").length,
			grids: [...(runStart ? nativeGrids : []), ...planGrids, ...teGrids],
			zip: { g: z?.g ?? null, justEdited: !!z?.justEdited, summarizedWarm: !!z?.summarizedWarm, summaryRegrow: z?.summaryRegrow ?? null },
		};
		ncSeen = nc1;
		probeAt = T0 + t0 * 1000;
		if (firstProbe && probes.fresh) t.fresh = await freshProbe(firstProbe.snapshot, firstProbe.userMsg, desc, firstProbe.liveState);
		envSince = [];
		lastView = view;
		ticks.push(t);
		pendingNative = null;
		reqNo++;
		reqInRun++;
	}

	async function closeRun(ev: number) {
		if (!runOpen) return;
		if (reqInRun === 0) await request({ say: 100 }, ev);
		runOpen = false;
		if (w.interactive) {
			sink = [];
			const out = await fire(live, "agent_before_settle", { type: "agent_before_settle", outcome: "completed", context: boundaryCtx(sm), entries: [] });
			applyDrafts(sm, out?.entries ?? []);
		}
		warmer?.onAgentSettled();
	}

	/** Pi's own compaction (its threshold, an overflow, or /compact): Pi's cut, Pi's summary; pi-zip may only watch. */
	async function piOwnCompaction(ev: number) {
		const branch = sm.getBranch();
		const prep = prepareCompaction(branch, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
		if (!prep) return;
		const h = live.handlers.get("session_before_compact");
		const res = h ? await h({ type: "session_before_compact", preparation: prep, branchEntries: branch, reason: "threshold", willRetry: false, signal: new AbortController().signal }, live.ctx) : undefined;
		if (res !== undefined) hijacked.push(`pi-zip answered Pi's own compaction (${JSON.stringify(res).slice(0, 80)}), which it did not ask for`);
		const sumText = `FOREIGN SUMMARY by Pi's own compaction\n${body("PISUM", 1500)}`;
		sm.appendCompaction(sumText, prep.firstKeptEntryId, prep.tokensBefore, { readFiles: [], modifiedFiles: [] }, false);
		blocks.push({ id: sm.getLeafId(), ev, kind: "foreignSummary", tok: Math.ceil(sumText.length / 4), est: Math.ceil(sumText.length / 4), turn, tool: null, req: reqNo });
		markForeignDropped();
		envSince.push("compact");
	}
	/** Another context manager prunes the oldest output the model still sees verbatim (a context_edit that is not pi-zip's). */
	function foreignEdit(boundary = false) {
		const proj = sm.buildSessionProjection();
		for (const pe of proj.entries) {
			const src = pe.sourceEntry;
			const m = pe.messages?.[0];
			if (src?.type !== "message" || m?.role !== "toolResult" || textOfMsg(m).startsWith(PH_MARK) || foreignEdited.has(src.id) || toolOf.get(src.id) === "recall") continue;
			const replacement = { content: [{ type: "text", text: `[pruned by another extension: ${textOfMsg(m).length} chars]` }] };
			if (boundary) incomingDrafts.push({ type: "context_edit", targetId: src.id, replacement });
			else sm.appendContextEdit(src.id, replacement);
			foreignEdited.add(src.id);
			envSince.push("edit");
			return;
		}
	}

	// Native completeness observes the session BEFORE the idle door, not opts() or its ledger. Only folding/guard mechanics
	// are shared with the source; Rust selects the allowed ready cut and evaluates both laws with its own class prices.
	let pendingNative: Any = null;
	let nativeGrids: Any[] = [];
	let nativeLedger: Any[] = [];
	function nativeSnapshot(text: string): Any {
		const z = live.zip, branch = sm.getBranch(), pre = sm.buildSessionProjection().entries;
		if (!z || !w.native) return null;
		const stored = existsSync(STATS) ? JSON.parse(readFileSync(STATS, "utf8")) : {};
		const learned = { ...z.lam(live.ctx), ent: stored.models?.[key()] };
		const now = core.clock(branch, learned, clock, { reqMs: z.lastReqMs, modelKey: z.lastModelKey });
		const prompt = { role: "user", content: text };
		const entries = [...pre, { sourceEntry: { id: "pending-native", type: "message", message: prompt }, messages: [prompt] }];
		const { o } = core.planOpts(entries, branch, z.env(live.ctx), learned, false, now.pWarm, now.pause);
		// Obtain F without asking whether a summary pays. No ready argument or captured live opts participates in this probe.
		const folded = plan.planContext(entries, { ...o, foldsOnly: true, law: { ...o.law, pWarm: 0 }, trace: [] });
		const bs = folded?.blocks ?? plan.buildBlocks(entries, o.steerIds);
		const folds = folded?.folds ?? [], byId = new Map(folds.map((f: Any) => [f.entryId, f]));
		const c = o.scale.c, O = o.scale.O, room = plan.compactionRoom(live.ctx.model, o.reserve);
		const cap = plan.coldTarget(40_000, O, room), total = bs.reduce((a: number, b: Any) => a + (byId.get(b.entryId)?.phTokens ?? b.tokens), 0);
		const prev = bs[0]?.kind === "summary" ? bs[0].tokens : 0;
		const turns = plan.countUserTurns(bs), protectedAt = bs.findIndex((b: Any) => b.userTurn >= turns - 1);
		const floor = prev + bs.reduce((a: number, b: Any) => a + (b.userTurn >= turns - 1 ? byId.get(b.entryId)?.phTokens ?? b.tokens : 0), 0);
		const head = branch.filter((e: Any) => e.type === "compaction").at(-1)?.id ?? "";
		const artifacts = branch.filter((e: Any) => e.type === "custom" && e.customType === "pi-zip/summary" && e.data?.cut && e.data.head === head).map((e: Any) => e.data);
		let prefix = 0;
		const cuts: Any[] = [];
		for (let i = 0; i < bs.length; i++) {
			const b = bs[i];
			if (i >= (prev ? 2 : 1) && (protectedAt < 0 || i <= protectedAt) && plan.isCutBlock(b)) {
				const sum = Math.max(Math.min(Math.max(prefix / 10, 1000), 8000), prev);
				const art = artifacts.findLast((a: Any) => a.key === b.entryId && a.cut.firstKeptEntryId === b.entryId);
				const keptFolds = folds.filter((f: Any) => bs.findIndex((x: Any) => x.entryId === f.entryId) >= i);
				cuts.push({ key: b.entryId, prefix: c * prefix, summary: c * sum, read: c * (Math.max(prefix - prev, 0) + (prev ? Math.ceil((previousNarrative(String(bs[0].msg?.summary ?? ""))?.text ?? "").length / 4) : 0)), written: c * Math.min(sum, 4000), ready: !!art, guard: !core.checkEdits(bs, turns, keptFolds, { firstKeptEntryId: b.entryId }), hash: art ? sha(art.cut.text) : null });
			}
			prefix += byId.get(b.entryId)?.phTokens ?? b.tokens;
		}
		const foreign = branch.some((e: Any) => e.type === "compaction" && e.details?.by !== "pi-zip");
		return {
			open: live.ctx.isIdle() && !z.nativeOff && !foreign && branch.at(-1)?.type !== "compaction" && !!prepareCompaction(branch, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
			p: now.pWarm, g: learned.g, known: !!learned.ent?.cls,
			b2b: now.pWarm >= 0.5 && learned.justEdited,
			noSummary: now.pWarm >= 0.5 && learned.summarizedWarm && !(learned.summaryRegrow > 0 && O + c * total >= learned.summaryRegrow) && O + c * total < room,
			before: O + c * bs.reduce((a: number, b: Any) => a + b.tokens, 0),
			afterFolds: O + c * total, target: cap, floor: O + c * (floor + 1000), cuts, applied: null,
		};
	}

	let pendingProbe: { snapshot: Any[]; userMsg: Any; liveState?: Any } | null = null;
	install();
	try {
		await fire(live, "session_start", { type: "session_start", reason: "startup" });
		recallInst = makeInst(sm, true);
		await fire(recallInst, "session_start", { type: "session_start", reason: "resume" });
		const events: Any[] = tr.events ?? [];
		for (let ev = 0; ev < events.length; ev++) {
			const e = events[ev];
			switch (e.e) {
				case "prompt": {
					await closeRun(ev);
					if (lastResp) await advance((e.gap ?? 60) * 1000);
					turn++;
					runNo++;
					reqInRun = 0;
					runOpen = true;
					const text = `request ${turn}: ${e.text ?? "please continue with the task"}`;
					const snapshot = [sm.getHeader(), ...sm.getEntries()];
					statsAtPrompt = existsSync(STATS) ? readFileSync(STATS, "utf8") : "";
					const z0: Any = live.zip ?? {};
					preRun = { sw: !!z0.summarizedWarm, je: !!z0.justEdited };
					pendingNative = nativeSnapshot(text);
					const nativeIds = new Set(sm.getBranch().map((x: Any) => x.id));
					optsSink = [];
					sink = [];
					await fire(live, "before_agent_start", { type: "before_agent_start", prompt: text, images: [] });
					const applied = sm.getBranch().findLast((x: Any) => x.type === "compaction" && !nativeIds.has(x.id) && x.details?.by === "pi-zip" && x.details?.via === "native");
					nativeLedger = sink.map(slim);
					nativeGrids = applied ? decisions(optsSink ?? []).map((c: Any) => gridFor({ ...c, at: "native" })) : [];
					optsSink = null;
					if (pendingNative && applied) pendingNative.applied = { key: applied.firstKeptEntryId, hash: sha(applied.summary), tokensBefore: applied.tokensBefore, idle: live.ctx.isIdle() };
					await fire(live, "agent_start", { type: "agent_start" });
					const userMsg = { role: "user", content: text, timestamp: clock };
					const uid = sm.appendMessage(userMsg);
					blocks.push({ id: uid, ev, kind: "user", tok: tokW(userMsg), est: Math.ceil(text.length / 4), turn, tool: null, req: reqNo });
					await fire(live, "message_end", { type: "message_end", message: userMsg });
					const liveState = Object.fromEntries(Object.values(TRANSPLANT).flat().map((f) => [f, z0[f]]));
					probeNextTurn = [];
					pendingProbe = lastResp ? { snapshot, userMsg, liveState: structuredClone(liveState) } : null;
					break;
				}
				case "drive": {
					nativeGrids = [];
					nativeLedger = [];
					// a run an extension's message starts (Pi 1.1.0 sendCustomMessage(..., { triggerTurn: true }) -> _runAgentPrompt):
					// agent_start, the custom message appended, its message_end, the first request; never before_agent_start
					await closeRun(ev);
					if (lastResp) await advance((e.gap ?? 60) * 1000);
					turn++;
					runNo++;
					reqInRun = 0;
					runOpen = true;
					const snapshot = [sm.getHeader(), ...sm.getEntries()];
					statsAtPrompt = existsSync(STATS) ? readFileSync(STATS, "utf8") : "";
					const z0: Any = live.zip ?? {};
					preRun = { sw: !!z0.summarizedWarm, je: !!z0.justEdited };
					await fire(live, "agent_start", { type: "agent_start" });
					const text = `owed work ${turn}: continue with what was left open`;
					const cm = { role: "custom", customType: "owed-drive", content: text, display: true, timestamp: clock };
					const cid = sm.appendCustomMessageEntry(cm.customType, cm.content, cm.display);
					blocks.push({ id: cid, ev, kind: "custom", starts: true, tok: tokW(cm), est: Math.ceil(text.length / 4), turn, tool: null, req: reqNo });
					await fire(live, "message_end", { type: "message_end", message: cm });
					const liveState = Object.fromEntries(Object.values(TRANSPLANT).flat().map((f) => [f, z0[f]]));
					probeNextTurn = [];
					pendingProbe = lastResp ? { snapshot, userMsg: cm, liveState: structuredClone(liveState) } : null;
					break;
				}
				case "nextturn": {
					// a custom message Pi stores right after the prompt (a nextTurn message, a before_agent_start handler's message): the
					// prompt's turn
					if (!runOpen || reqInRun > 0) throw new Error(`event ${ev} (nextturn) not right after a prompt`);
					const text = `context for request ${turn}: the notes the user keeps`;
					const cm = { role: "custom", customType: "topping-prompt", content: text, display: false, timestamp: clock };
					const cid = sm.appendCustomMessageEntry(cm.customType, cm.content, cm.display);
					blocks.push({ id: cid, ev, kind: "custom", starts: false, tok: tokW(cm), est: Math.ceil(text.length / 4), turn, tool: null, req: reqNo });
					await fire(live, "message_end", { type: "message_end", message: cm });
					probeNextTurn.push(cm);
					break;
				}
				case "call":
				case "say":
				case "fail": {
					if (!runOpen) throw new Error(`event ${ev} (${e.e}) outside a run`);
					const probe = pendingProbe;
					pendingProbe = null;
					await request(e.e === "call" ? { call: { tool: e.tool ?? "npm", size: e.size ?? 1000 } } : e.e === "say" ? { say: e.size ?? 100 } : { fail: e.abort ? "aborted" : "error" }, ev, probe ?? undefined);
					if (e.e !== "call") await closeRun(ev);
					break;
				}
				case "steer": {
					// a message typed while the agent runs: Pi delivers it after the tool results, before the next request
					if (!runOpen) throw new Error(`event ${ev} (steer) outside a run`);
					const text = `steer ${++steerNo}: also look at the logs`;
					const m = { role: "user", content: text, timestamp: clock };
					const id = sm.appendMessage(m);
					blocks.push({ id, ev, kind: "user", steer: true, tok: tokW(m), est: Math.ceil(text.length / 4), turn, tool: null, req: reqNo });
					await fire(live, "message_end", { type: "message_end", message: m });
					break;
				}
				case "wait":
					// the user stays away without a prompt (the next event may happen at the return: a restart, a switch)
					await closeRun(ev);
					if (lastResp) await advance((e.gap ?? 60) * 1000);
					break;
				case "switch":
					await closeRun(ev);
					mi = 1 - mi;
					envSince.push("switch");
					break;
				case "restart": {
					await closeRun(ev);
					await fire(live, "session_shutdown", {});
					warmer?.cancel();
					timers = [];
					slowCalls.clear(); // a call still running is lost with the process
					live = makeInst(sm);
					await fire(live, "session_start", { type: "session_start", reason: "resume" });
					warmer = newWarmer();
					envSince.push("restart");
					break;
				}
				case "compact":
					await piOwnCompaction(ev);
					break;
				case "boundaryedit":
					foreignEdit(true);
					break;
				case "edit":
					foreignEdit();
					break;
				case "foreign": {
					await closeRun(ev);
					const br = sm.getBranch();
					const lastUser = [...br].reverse().find((x: Any) => x.type === "message" && x.message?.role === "user");
					if (lastUser) {
						const sumText = `FOREIGN SUMMARY by another extension\n${body("FOREIGN", e.size ?? 2000)}`;
						sm.appendCompaction(sumText, lastUser.id, 0, { by: "other-extension" }, true);
						blocks.push({ id: sm.getLeafId(), ev, kind: "foreignSummary", tok: Math.ceil(sumText.length / 4), est: Math.ceil(sumText.length / 4), turn, tool: null, req: reqNo });
						markForeignDropped();
						envSince.push("foreign");
					}
					break;
				}
				default:
					throw new Error(`unknown event ${JSON.stringify(e)}`);
			}
		}
		await closeRun(events.length);
		if (process.env.PZF_CALLS_LOG) {
			// summary calls made (probes excluded) and pi-zip compactions in the session: calls - used = unused calls (one line a trace)
			const made = narrativeCalls.filter((c) => c.phase !== "probe").length;
			const used = sm.getEntries().filter((x: Any) => x.type === "compaction" && x.details?.by === "pi-zip").length;
			appendFileSync(process.env.PZF_CALLS_LOG, JSON.stringify({ id: tr.id, made, used }) + "\n");
		}
	} catch (err) {
		errors.push(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
	} finally {
		await fire(live, "session_shutdown", {}).catch(() => {});
		warmer?.cancel();
		timers = [];
		uninstall();
	}
	return { id: tr.id, producer, ok: errors.length === 0, errors, world: w, blocks, ticks, refreshes };
}

/** The real lawTerms on a list of numeric points (the symbolic lemmas are also checked against the code itself). */
function lawGrid(tr: Any) {
	const res = (tr.lawgrid as Any[]).map((q: Any) => {
		const t = plan.lawTerms(q.B, q.A, q.P, q.room ?? null, q.pr ?? null, q.g, q.call ?? 0, q.T ?? q.A);
		const num = (x: number) => (Number.isFinite(x) ? x : x > 0 ? "inf" : x < 0 ? "-inf" : null);
		return { ok: t.ok, K: num(t.K), eta: num(t.eta), phi: num(t.phi) };
	});
	return { id: tr.id, ok: true, lawgrid: res };
}

// ---- the line protocol -------------------------------------------------------------------------------------------------------
const decoder = new TextDecoder();
let buf = "";
const queue: string[] = [];
let busy = false;
async function pump() {
	if (busy) return;
	busy = true;
	while (queue.length) {
		const line = queue.shift()!;
		let out: Any;
		try {
			const tr = JSON.parse(line);
			out = tr.lawgrid ? lawGrid(tr) : await runTrace(tr);
		} catch (err) {
			out = { id: null, ok: false, errors: [String(err instanceof Error ? err.stack : err)] };
		}
		process.stdout.write(JSON.stringify(out) + "\n");
	}
	busy = false;
}
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let i: number;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (line) queue.push(line);
	}
	await pump();
}
if (buf.trim()) queue.push(buf.trim());
await pump();
rmSync(WORK, { recursive: true, force: true });
