#!/usr/bin/env bun
// Conformance bridge: drives the REAL pi-zip extension (src/index.ts -> run.ts -> plan.ts) through abstract traces and reports what it
// decided, as JSON lines.  Usage:  bun bridge.ts <pi-zip src dir> [--pi <pi-coding-agent package dir>]
// stdin: one trace per line   {"id", "world": {...}, "events": [...], "probes": {...}}
// stdout: one observation per line   {"id", "ok", "blocks": [...], "ticks": [...], "end": {...}}
//
// What is REAL here: pi-zip's index.ts wiring, run.ts (cold detection, run plan, valve, b2b skip, summarizedWarm, away timer, native
// compaction gate, persistence at turn_end, learning of g / class / survival), plan.ts, summary.ts, recall.ts, guard.ts; Pi's own
// SessionManager (projection of context_edit and compaction entries) and Pi's own draft application (AgentSession._applyBoundaryDrafts),
// Pi's prepareCompaction for ctx.compact.
// What is MIRRORED (not callable without a live model): Pi's agent loop event order (before_agent_start, prompt appended, per request
// context_with_system -> before_provider_request -> assistant message_end -> tool results -> turn_end, then agent_before_settle), the
// provider (a prefix cache with a TTL that produces usage reports), the narrative model call (a fixed text), the clock and timers
// (virtual), and pi-zip's index.ts is called as is (only the Zip instance is captured to read its state).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
for (const k of ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_FOLD_MIN", "PI_ZIP_KEEP_LINES", "PI_ZIP_MIN_GAIN", "PI_ZIP_INTURN_AGE", "PI_ZIP_OFF", "PI_CACHE_RETENTION"]) delete process.env[k];

type Any = any;
const { SessionManager } = await import(join(PI, "dist/core/session-manager.js"));
const { AgentSession } = await import(join(PI, "dist/core/agent-session.js"));
const { convertToLlm } = await import(join(PI, "dist/core/messages.js"));
const { prepareCompaction } = await import(join(PI, "dist/core/compaction/compaction.js"));
const piZip = (await import(join(SRC, "index.ts"))).default;
const { Zip } = await import(join(SRC, "run.ts"));
const plan = await import(join(SRC, "plan.ts"));
const { handleFor, PH_MARK } = await import(join(SRC, "placeholder.ts"));
const { resolveHandlesInBranch } = await import(join(SRC, "recall.ts"));
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
type Timer = { id: number; due: number; fn: () => void; dead: boolean };
let timers: Timer[] = [];
let tid = 0;
function fakeSetTimeout(fn: Any, ms?: number, ...a: Any[]) {
	const t: Timer = { id: ++tid, due: clock + Math.max(0, Number(ms) || 0), fn: () => fn(...a), dead: false };
	timers.push(t);
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
async function drain(z?: Any) {
	for (let i = 0; i < 4; i++) await tick();
	const bg = z?.bg;
	if (bg?.promise) await bg.promise;
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
let narrativeCalls: { phase: string; at: number }[] = [];
let captured: Any = null;
const origSessionStart = Zip.prototype.sessionStart;
Zip.prototype.sessionStart = function (this: Any, ctx: Any) {
	captured = this;
	return origSessionStart.call(this, ctx);
};
Zip.prototype.ledger = function (rec: Any) {
	(this.__sink ?? sink).push(rec);
};
const origOpts = Zip.prototype.opts;
Zip.prototype.opts = function (this: Any, ...a: Any[]) {
	const r = origOpts.apply(this, a);
	// planner options a run may set (PZF_PLAN_OPTS, e.g. {"lookahead":true} for coldwarm's F2): merged into what run.ts passes to planContext
	if (PLAN_OPTS) Object.assign(r.o, PLAN_OPTS);
	// the P-grid re-plans in exactly this state: the recalled set is a snapshot (the live one grows when zip_recall runs later)
	if (optsSink && !this.__probe) optsSink.push({ pending: a[1], mode: a[2], entries: a[3], o: { ...r.o, recalled: new Set(r.o.recalled ?? []) }, live: r.o, sw: !!this.summarizedWarm });
	return r;
};

const PLAN_OPTS: Any = process.env.PZF_PLAN_OPTS ? JSON.parse(process.env.PZF_PLAN_OPTS) : null;
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const noTs = (k: string, v: Any) => (k === "timestamp" ? undefined : v);
const llmJson = (m: Any) => JSON.stringify(convertToLlm([m]), noTs);
const textOfMsg = (m: Any): string => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: Any) => c?.text ?? c?.thinking ?? "").join("\n") : "");

function body(tag: string, tokens: number): string {
	const lines: string[] = [];
	let chars = 0, i = 0;
	while (chars < tokens * 4) {
		const l = `${tag} line ${i}: value=${(i * 7919 + tag.length * 104729) % 1000003} ${"lorem ipsum dolor sit amet ".repeat(3)}`;
		lines.push(l);
		chars += l.length + 1;
		i++;
	}
	return lines.join("\n");
}

/** The provider and the setup: cache class (the truth) and whether pi-zip already knows it (learned in an earlier session), declared TTL
 *  and true TTL (s), learned survival (none, or "outlives": read in full up to 600 s), real tokens per chars/4 token, system prompt size,
 *  context window, Pi's ctx.compact available (native summary path), interactive (away timer). */
interface World { cls: "explicit" | "automatic"; known: boolean; ttl: number; ttlTrue: number; survival: "none" | "outlives"; c: number; sys: number; window: number; native: boolean; interactive: boolean }
const DEFAULT_WORLD: World = { cls: "explicit", known: true, ttl: 300, ttlTrue: 300, survival: "none", c: 1, sys: 3000, window: 200_000, native: true, interactive: true };

function seedStats(w: World) {
	const models: Any = {};
	for (const id of ["m1", "m2"]) {
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
	narrativeCalls = [];
	sink = [];
	captured = null;
	rmSync(join(WORK, "xdg"), { recursive: true, force: true });
	seedStats(w);
	const models = ["m1", "m2"].map((id) => ({ provider: "p", id, api: "anthropic-messages", contextWindow: w.window, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: w.ttl } }));
	let mi = 0;
	const sysText = body("SYSTEM", w.sys);
	const sm = SessionManager.inMemory(CWD);
	const blocks: Any[] = [];
	const ticks: Any[] = [];
	const errors: string[] = [];
	const cache = new Map<string, { msgs: { h: string; tok: number }[]; expires: number }>();
	let lastResp = 0; // ms of the newest response (any model)
	let turn = 0;
	let reqNo = 0;
	let runNo = -1;
	let runOpen = false;
	let reqInRun = 0;
	let envSince: string[] = [];
	let lastView: Any[] | null = null;
	let callNo = 0;
	const foreignDropped = new Set<string>(); // user entries a foreign compaction removed (not pi-zip's to keep)
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
			appendEntry: (t: string, d: Any) => { if (!probe) manager.appendCustomEntry(t, d); },
			getAllTools: () => [],
			getCommands: () => [],
			getActiveTools: () => ["read", "bash", "zip_recall"],
			getSettings: () => ({}),
		};
		piZip(pi);
		const ctx: Any = {
			mode: w.interactive ? "tui" : "print", hasUI: w.interactive, cwd: CWD, ui: { notify: () => {}, setWorkingMessage: () => {}, setStatus: () => {} },
			getSystemPrompt: () => sysText, sessionManager: manager, isIdle: () => true,
			modelRegistry: { complete: async () => { narrativeCalls.push({ phase: probe ? "probe" : phase, at: clock }); return { stopReason: "stop", content: [{ type: "text", text: "## Decisions and rationale\nnarrative (formal bridge)" }], usage: { input: 0, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }; } },
		};
		Object.defineProperty(ctx, "model", { get: () => models[mi], enumerable: true });
		if (w.native) ctx.compact = (opts: Any) => void piCompact(manager, handlers, opts);
		return { handlers, tools, zip: null, ctx, probe };
	}
	/** AgentSession.compact() as Pi 1.1.0 runs it for an extension (the integration test's rig): Pi's prepareCompaction decides
	 *  "Already compacted" / "Nothing to compact", session_before_compact supplies the result, appendCompaction. */
	async function piCompact(manager: Any, handlers: Map<string, Any>, options: Any) {
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
	let live = makeInst(sm);
	const fire = async (inst: Inst, name: string, e: Any) => {
		const h = inst.handlers.get(name);
		if (name === "session_start") captured = null;
		const r = h ? await h(e, inst.ctx) : undefined;
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
	const boundaryCtx = (manager: Any) => {
		const p = manager.buildSessionProjection();
		return { contextEntries: p.entries, contextMessages: p.messages, llmMessages: convertToLlm(p.messages), pendingMessages: [], canContinue: false };
	};

	// ---- views and the world's cache -----------------------------------------------------------------------------------------
	function describeView(view: Any[], manager: Any) {
		const proj = manager.buildSessionProjection();
		// entry id of a sent message: by identity, else by content (Pi's projection may hand out new message objects after edits)
		const byMsg = new Map<Any, string>(), byCall = new Map<string, string>(), byHash = new Map<string, string>();
		for (const e of manager.getBranch()) if (e.type === "message" && e.message) byHash.set(sha(llmJson(e.message)), e.id);
		for (const pe of proj.entries) for (const m of pe.messages ?? []) {
			if (pe.sourceEntry?.id) byMsg.set(m, pe.sourceEntry.id);
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
		const warm = !!ent && clock <= ent.expires;
		let read = 0;
		if (warm) for (let i = 0; i < desc.length && i < ent!.msgs.length && ent!.msgs[i].h === desc[i].h; i++) read += desc[i].tok;
		const total = desc.reduce((a: number, d: Any) => a + d.tok, 0);
		const explicit = w.cls === "explicit";
		const u = explicit ? { input: 0, cacheRead: read, cacheWrite: total - read } : { input: total - read, cacheRead: read, cacheWrite: 0 };
		return { warm, read, total, u: { ...u, output: outTok, totalTokens: total + outTok, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	}
	const mods = (desc: Any[]) => new Set(desc.filter((d) => d.ph || d.sum === "zip").map((d) => (d.ph ? `f:${d.id}` : `s:${d.h}`)));

	// ---- probes --------------------------------------------------------------------------------------------------------------
	function gridFor(cap: Any) {
		const out: Any[] = [];
		const actual = Number(cap.o.law?.pWarm ?? (cap.mode === "cold" ? 0 : 1));
		const ps = [...new Set([...(probes.pgrid as number[]), actual])].sort((a, b) => a - b);
		for (const p of ps) {
			// mode is a function of P exactly as run.ts derives it (detectCold: cold = P(warm) < 0.5); at the actual P it is the actual mode
			const mode = p === actual ? cap.mode : p < 0.5 ? "cold" : "warm";
			const sw = cap.mode === "warm" ? !!cap.o.noSummary : false;
			const o = { ...cap.o, pastTtl: cap.live?.pastTtl ?? cap.o.pastTtl, mode, law: { ...cap.o.law, pWarm: p }, noSummary: mode === "warm" && sw, trace: [] };
			let r: Any = null;
			try {
				r = plan.planContext(cap.entries, o);
			} catch (err) {
				out.push({ p, mode, error: String(err) });
				continue;
			}
			const c = r ? (r.scale?.c ?? r.k ?? 1) : 1;
			const after = r ? r.ctxAfterFolds - (r.cutIdx !== null ? c * (r.prefixTokens - r.summaryTokensPlanned) : 0) : null;
			out.push({ p, actual: p === actual, mode, plan: !!r, ahead: !!r?.ahead, folds: r ? r.folds.map((f: Any) => f.entryId) : [], cut: r?.firstKeptEntryId ?? null, prefix: r ? c * r.prefixTokens : 0, sum: r ? c * r.summaryTokensPlanned : 0, before: r?.ctxTokens ?? null, afterFolds: r ? r.ctxAfterFolds : null, after, law: o.trace.map((t: Any) => ({ at: t.where, ok: t.ok, B: t.B, A: t.A, T: t.T, K: t.K, phi: t.phi, eta: t.eta })) });
		}
		return { at: cap.at, mode: cap.mode, p: actual, pastTtl: !!(cap.live?.pastTtl ?? cap.o.pastTtl), noSummary: !!cap.o.noSummary, g: cap.o.law?.g ?? null, pr: cap.o.law?.pr ?? null, grid: out };
	}

	function lossless(desc: Any[] | null, view: Any[] | null): string[] {
		const issues: string[] = [];
		const branch = sm.getBranch();
		const originals = new Map<string, Any>();
		for (const e of branch) if (e.type === "message") originals.set(e.id, e.message);
		const origHashes = new Set([...originals.values()].map((m) => sha(llmJson(m))));
		const visible = new Set<string>();
		if (desc) for (const d of desc) {
			if (d.role === "toolResult") {
				const o = d.id ? originals.get(d.id) : null;
				if (!o) issues.push(`toolResult without an original (${d.id})`);
				else if (d.ph) { /* a placeholder of this very call: its original is checked below */ }
				else if (sha(llmJson(o)) !== d.h) issues.push(`toolResult ${d.id} rewritten but not a pi-zip placeholder`);
				else visible.add(d.id);
			} else if (d.role === "user" || d.role === "assistant" || d.role === "system") {
				if (!origHashes.has(d.h)) issues.push(`${d.role} message rewritten (${d.id ?? "?"})`);
				if (d.id) visible.add(d.id);
			}
		}
		// every tool output the model does not see verbatim is recallable byte for byte
		const hidden = branch.filter((e: Any) => e.type === "message" && e.message?.role === "toolResult" && !visible.has(e.id));
		if (hidden.length) {
			const hs = hidden.map((e: Any) => handleFor(e.id));
			const { items } = resolveHandlesInBranch(branch, hs);
			hidden.forEach((e: Any, i: number) => {
				if (items[i]?.text !== textOfMsg(e.message)) issues.push(`recall ${hs[i]} (${e.id}) does not return the original bytes`);
			});
		}
		// user requests pi-zip summarised away are quoted verbatim by its summary (the README's promise)
		if (desc) {
			const sumText = (view ?? []).filter((m: Any) => m.role === "compactionSummary" && !String(m.summary).startsWith("FOREIGN")).map((m: Any) => String(m.summary)).join("\n");
			const users = branch.filter((e: Any) => e.type === "message" && e.message?.role === "user" && !visible.has(e.id) && !foreignDropped.has(e.id));
			for (const e of users) if (!sumText.includes(textOfMsg(e.message))) issues.push(`user request ${e.id} summarised away and not quoted verbatim`);
		}
		// the system prompt is never rewritten
		if (desc && !desc.some((d) => d.role === "system" && d.h === sha(llmJson(sysMsg)))) issues.push("system prompt missing or rewritten");
		return issues;
	}

	// in-memory Zip state a restart loses, transplanted one group at a time into a fresh process to find which one makes the difference
	const TRANSPLANT: Record<string, string[]> = {
		g: ["g", "deltas"],
		justEdited: ["justEdited"],
		summarizedWarm: ["summarizedWarm"],
		clock: ["lastReqMs", "lastModelKey", "prevTotal", "prevKey"],
		learned: ["ent", "retention"],
	};
	async function freshProbe(snapshot: Any[], userMsg: Any, liveDesc: Any[], liveState?: Any) {
		const base = await freshOnce(snapshot, userMsg, liveDesc, null);
		if (base.same || !liveState) return base;
		const fixedBy: string[] = [];
		for (const [name, fields] of Object.entries(TRANSPLANT)) {
			const r = await freshOnce(snapshot, userMsg, liveDesc, Object.fromEntries(fields.map((f) => [f, liveState[f]])));
			if (r.same) fixedBy.push(name);
		}
		const all = Object.fromEntries(Object.values(TRANSPLANT).flat().map((f) => [f, liveState[f]]));
		const allSame = (await freshOnce(snapshot, userMsg, liveDesc, all)).same;
		return { ...base, fixedBy, fixedByAll: allSame };
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
	let statsAtPrompt = "";
	async function freshInner(snapshot: Any[], userMsg: Any, liveDesc: Any[], transplant: Any | null) {
		const sm2 = SessionManager.inMemory(CWD, undefined, structuredClone(snapshot));
		const saved = { sink, optsSink, phase };
		optsSink = null;
		const inst = makeInst(sm2, true);
		try {
			await fire(inst, "session_start", { type: "session_start", reason: "resume" });
			if (transplant && inst.zip) Object.assign(inst.zip, structuredClone(transplant));
			await fire(inst, "before_agent_start", { type: "before_agent_start", prompt: userMsg.content, images: [] });
			sm2.appendMessage(structuredClone(userMsg));
			await fire(inst, "message_end", { message: userMsg });
			const raw = sm2.buildSessionContext().messages;
			const out = await fire(inst, "context_with_system", { type: "context_with_system", messages: raw });
			const view = out?.messages ?? raw;
			const desc = describeView(view, sm2);
			const a = liveDesc.map((d) => d.h).join(","), b = desc.map((d: Any) => d.h).join(",");
			const ledger = inst.zip?.__sink ?? [];
			return { same: a === b, live: liveDesc.length, fresh: desc.length, liveMods: [...mods(liveDesc)].length, freshMods: [...mods(desc)].length, freshPlan: ledger.filter((r: Any) => r.type === "cold_plan" || r.type === "b2b_skip").map(slim) };
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
	async function request(resp: { call?: { tool: string; size: number }; say?: number }, ev: number, firstProbe?: { snapshot: Any[]; userMsg: Any; liveState?: Any }) {
		await runDue();
		const z = live.zip;
		const gapMs = lastResp ? clock - lastResp : null;
		const t0 = (clock - T0) / 1000;
		const runStart = reqInRun === 0;
		const state0 = runStart ? { cold: !!z?.cold, pWarm: z?.pWarm ?? null, pastTtl: !!z?.pastTtl, summarizedWarm: !!z?.summarizedWarm } : null;
		sink = [];
		optsSink = [];
		const nc0 = narrativeCalls.length;
		const raw = sm.buildSessionContext().messages;
		const out = await fire(live, "context_with_system", { type: "context_with_system", messages: raw });
		const view = out?.messages ?? raw;
		await fire(live, "before_provider_request", { type: "before_provider_request", payload: {} });
		const desc = describeView(view, sm);
		const rawDesc = out ? describeView(raw, sm) : desc;
		const prevMods = lastView ? mods(describeView(lastView, sm)) : new Set<string>();
		const curMods = mods(desc);
		const zipNew = [...curMods].filter((m) => !prevMods.has(m));
		// A1 on this request as sent: whenever it carries something new from pi-zip, and at every run start
		const lossIssues = probes.lossless && (zipNew.length || runStart) ? lossless(desc, view) : [];
		const runPlan = z?.runPlan;
		const planGrids = optsSink.filter((c: Any) => !c.pending).map((c: Any) => gridFor({ ...c, at: "run" }));
		const runLedger = sink.map(slim);
		// the world answers
		const outTok = resp.say ?? 50;
		const wu = usageFor(desc, outTok);
		clock += LAT_MS;
		const callId = resp.call ? `call${++callNo}` : null;
		let recallOf: string | null = null;
		let args: Any = null;
		if (resp.call) {
			if (resp.call.tool === "recall") {
				// zip_recall of the newest output the model sees folded (else the oldest output it no longer sees, else the newest output)
				const folded = desc.filter((d: Any) => d.ph && d.id).map((d: Any) => d.id);
				const vis = new Set(desc.map((d: Any) => d.id));
				const outs = sm.getBranch().filter((e: Any) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName !== "zip_recall");
				recallOf = folded.at(-1) ?? outs.find((e: Any) => !vis.has(e.id))?.id ?? outs.at(-1)?.id ?? null;
				args = { handle: recallOf ? handleFor(recallOf) : "0000000000" };
			} else args = { command: resp.call.tool === "cat" ? `cat src/file${callNo}.ts` : "npm test" };
		}
		const name = resp.call ? (resp.call.tool === "recall" ? "zip_recall" : "bash") : null;
		const content: Any[] = [{ type: "text", text: resp.say ? body(`A${reqNo}`, resp.say) : `working on it (${reqNo})` }];
		if (callId) content.push({ type: "toolCall", id: callId, name, arguments: args });
		const asst = { role: "assistant", content, api: "anthropic-messages", provider: "p", model: models[mi].id, usage: wu.u, stopReason: callId ? "toolUse" : "stop", timestamp: clock };
		const aid = sm.appendMessage(asst);
		blocks.push({ id: aid, ev, kind: "assistant", tok: tokW(asst), est: 0, turn, tool: null, req: reqNo });
		await fire(live, "message_end", { type: "message_end", message: asst });
		lastResp = clock;
		const t1 = (clock - T0) / 1000;
		cache.set(key(), { msgs: desc.map((d: Any) => ({ h: d.h, tok: d.tok })), expires: clock + w.ttlTrue * 1000 });
		const toolResults: Any[] = [];
		if (callId) {
			clock += TOOL_MS;
			let text: string;
			if (resp.call!.tool === "recall") {
				const tool = live.tools.get("zip_recall");
				const r = tool ? await tool.execute(callId, args, undefined, undefined, live.ctx) : { content: [{ type: "text", text: "no zip_recall" }] };
				text = textOfMsg(r);
				envSince.push("recall");
			} else text = body(`OUT${callNo}`, resp.call!.size);
			const tr = { role: "toolResult", toolCallId: callId, toolName: name, isError: false, content: [{ type: "text", text }], timestamp: clock };
			const rid = sm.appendMessage(tr);
			toolResults.push(tr);
			blocks.push({ id: rid, ev, kind: "toolResult", tok: tokW(tr), est: Math.ceil(text.length / 4), turn, tool: resp.call!.tool, req: reqNo, recallOf });
			await fire(live, "message_end", { type: "message_end", message: tr });
		}
		// turn_end: the boundary handlers propose drafts, Pi applies them
		sink = [];
		optsSink = [];
		const nc1 = narrativeCalls.length;
		const rp = z?.runPlan, rpWasPersisted = !!rp?.persisted, rpSent = !!rp?.sent;
		const te = await fire(live, "turn_end", { type: "turn_end", turnIndex: reqInRun, message: asst, toolResults, messageEntryId: aid, toolResultEntryIds: [], context: boundaryCtx(sm), entries: [] });
		const drafts: Any[] = te?.entries ?? [];
		const teGrids = optsSink.filter((c: Any) => !c.pending).map((c: Any) => gridFor({ ...c, at: "turn_end" }));
		const teLedger = sink.map(slim);
		optsSink = null;
		applyDrafts(sm, drafts);
		// I1: what turn_end persisted equals what was sent (the projection now starts with the view of this request)
		let persistOk: boolean | null = null;
		const committedSent = !!rp && rpSent && !rpWasPersisted && !!rp.persisted;
		if (committedSent && drafts.some((d: Any) => d.type === "context_edit" || d.type === "compaction")) {
			const now = describeView(sm.buildSessionContext().messages, sm).map((d: Any) => d.h);
			persistOk = desc.every((d: Any, i: number) => now[i] === d.h);
		}
		const t: Any = {
			req: reqNo, ev, run: runNo, n: reqInRun, t0, t1, gap: gapMs === null ? null : gapMs / 1000, model: key(),
			warm: wu.warm, total: wu.total, read: wu.read, out: outTok, rawTok: rawDesc.reduce((a: number, d: Any) => a + d.tok, 0),
			view: desc, zipNew, env: envSince, state0, lossless: lossIssues,
			runPlan: runStart && runPlan ? { source: runPlan.source, folds: runPlan.folds.map((f: Any) => f.entryId), cut: runPlan.cut?.firstKeptEntryId ?? runPlan.native?.firstKeptEntryId ?? null, native: !!runPlan.native } : null,
			runLedger, teLedger,
			drafts: drafts.map((d: Any) => (d.type === "context_edit" ? { type: d.type, target: d.targetId } : d.type === "compaction" ? { type: d.type, firstKept: d.firstKeptEntryId } : { type: d.type, customType: d.customType })),
			persistOk, teValve: !committedSent && drafts.some((d: Any) => d.type === "context_edit" || d.type === "compaction"),
			waitRun: narrativeCalls.slice(nc0, nc1).filter((c) => c.phase === "present").length,
			waitTe: narrativeCalls.slice(nc1).filter((c) => c.phase === "present").length,
			grids: [...planGrids, ...teGrids],
			zip: { g: z?.g ?? null, justEdited: !!z?.justEdited, summarizedWarm: !!z?.summarizedWarm },
		};
		probeAt = T0 + t0 * 1000;
		if (firstProbe && probes.fresh) t.fresh = await freshProbe(firstProbe.snapshot, firstProbe.userMsg, desc, firstProbe.liveState);
		envSince = [];
		lastView = view;
		ticks.push(t);
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
	}

	let pendingProbe: { snapshot: Any[]; userMsg: Any; liveState?: Any } | null = null;
	install();
	try {
		await fire(live, "session_start", { type: "session_start", reason: "startup" });
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
					await fire(live, "before_agent_start", { type: "before_agent_start", prompt: text, images: [] });
					const userMsg = { role: "user", content: text, timestamp: clock };
					const uid = sm.appendMessage(userMsg);
					blocks.push({ id: uid, ev, kind: "user", tok: tokW(userMsg), est: Math.ceil(text.length / 4), turn, tool: null, req: reqNo });
					await fire(live, "message_end", { type: "message_end", message: userMsg });
					const z0: Any = live.zip ?? {};
					const liveState = Object.fromEntries(Object.values(TRANSPLANT).flat().map((f) => [f, z0[f]]));
					pendingProbe = lastResp ? { snapshot, userMsg, liveState: structuredClone(liveState) } : null;
					break;
				}
				case "call":
				case "say": {
					if (!runOpen) throw new Error(`event ${ev} (${e.e}) outside a run`);
					const probe = pendingProbe;
					pendingProbe = null;
					await request(e.e === "call" ? { call: { tool: e.tool ?? "npm", size: e.size ?? 1000 } } : { say: e.size ?? 100 }, ev, probe ?? undefined);
					if (e.e === "say") await closeRun(ev);
					break;
				}
				case "switch":
					await closeRun(ev);
					mi = 1 - mi;
					envSince.push("switch");
					break;
				case "restart": {
					await closeRun(ev);
					await fire(live, "session_shutdown", {});
					timers = [];
					live = makeInst(sm);
					await fire(live, "session_start", { type: "session_start", reason: "resume" });
					envSince.push("restart");
					break;
				}
				case "foreign": {
					await closeRun(ev);
					const br = sm.getBranch();
					const lastUser = [...br].reverse().find((x: Any) => x.type === "message" && x.message?.role === "user");
					if (lastUser) {
						for (const x of br) if (x.type === "message" && x.message?.role === "user" && x.id !== lastUser.id) foreignDropped.add(x.id);
						const sumText = `FOREIGN SUMMARY by another extension\n${body("FOREIGN", e.size ?? 2000)}`;
						sm.appendCompaction(sumText, lastUser.id, 0, { by: "other-extension" }, true);
						blocks.push({ id: sm.getLeafId(), ev, kind: "foreignSummary", tok: Math.ceil(sumText.length / 4), est: Math.ceil(sumText.length / 4), turn, tool: null, req: reqNo });
						envSince.push("foreign");
					}
					break;
				}
				default:
					throw new Error(`unknown event ${JSON.stringify(e)}`);
			}
		}
		await closeRun(events.length);
	} catch (err) {
		errors.push(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
	} finally {
		await fire(live, "session_shutdown", {}).catch(() => {});
		timers = [];
		uninstall();
	}
	return { id: tr.id, ok: errors.length === 0, errors, world: w, blocks, ticks };
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

