// The per-session state machine behind index.ts: cold detection, the run plan (F8), the warm valve (F10), persistence at turn_end,
// settle preparation and the away-timer for the summary (F12).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectCold, lastMessageMs, lastPrompt, modelKey, resolveTtl, ttlFor } from "./cache.ts";
import { describe, lawPrices, loadStats, pWarm, record, sample, statsPath, GAP_EDGES, type Entry } from "./learn.ts";
import { validateEdits, repairPayload } from "./guard.ts";
import { fmtK, Stats, noticeDesc, noticeText, type NoticeAction, type NoticeData, type ZipControl } from "./notice.ts";
import { applyPlanToMessages, buildBlocks, calibrate, countUserTurns, G0, keepRecentTokensFor, piCanCompact, planContext, rebaseFolds, reserveTokensFor, sizeOf, spliceNative, untouchedEst, UNIT, type Block, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import { handleFor, PH_MARK, RECALL_TOOL } from "./placeholder.ts";
import { branchOutputs, recalledHandlesFromBranch, resolveHandlesInBranch } from "./recall.ts";
import { cleanupRecall, commandNamesRecall, fileRecallFor, materialize, parseRecallPath, recallRoot, rewriteCommand, RECALL_DIR, sidDir, type FileRecall } from "./recallfile.ts";
import { buildCut } from "./summary.ts";
import { type Any, PRODUCT, textOf, tok4 } from "./util.ts";
import { CHART_COLS, chartGap, fmtLife, type CardData, type StateWord } from "./ui.ts";

export const PLAN_CUSTOM = "pi-zip/plan";
export const STATE_CUSTOM = "pi-zip/state";
export const STEER_CUSTOM = "pi-zip/steer";
const fmtAway = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(Math.round(s / 360) / 10).toFixed(1)} h`);
export const NOTICE_CUSTOM = "pi-zip/notice"; // a fold/summary notice kept in the transcript (rendered by index.ts, never sent to the model)
export const UNUSED_SUMMARY_CUSTOM = "pi-zip/unused-summary"; // a background summary nobody adopted: its cost, so the session totals stay honest
export const AWAY_FRACTION = 0.8; // the away-timer fires this far into the cache lifetime
// Other context managers rewrite the view too (F14); two writers give unpredictable results, so we pause and keep only the Guard.
const CONFLICT_RE = /billion-context|bc-pi|magic-context|smart-compact|hot-compact|context-prune|pi-vcc|context-mode|prefix-cache/i;

/** The guard's view of a candidate edit set; folds whose entry left the projection are ignored. */
export function checkEdits(blocks: Block[], userTurns: number, folds: FoldTarget[], cut: Cut | null): string | null {
	const byId = new Map(blocks.map((b) => [b.entryId, b]));
	const live = folds.filter((t) => byId.has(t.entryId));
	const cutBlock = cut ? byId.get(cut.firstKeptEntryId) : undefined;
	if (cut && !cutBlock) return `cut target ${cut.firstKeptEntryId} is not in the projection`;
	return validateEdits(blocks, { folds: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.ph])), recover: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.recover])), cut: cutBlock ? cutBlock.idx : null }, userTurns);
}

/** A summary being prepared (or finished) while the user is away. It has its own AbortController: no run owns it. */
interface Bg {
	key: string | null; // firstKeptEntryId of the cut it was written for
	done: Cut | null;
	promise: Promise<Cut | null>;
	controller: AbortController;
}

/** Resolves with the promise's value, or null as soon as the signal aborts (Esc cancels the waiting, not the work). */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(null);
		const onAbort = () => resolve(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, () => resolve(null)).finally(() => signal?.removeEventListener("abort", onAbort));
	});
}

const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** How long pi-zip waits for Pi to report its own compaction (it takes milliseconds: the summary is ready); a safety net only. */
const NATIVE_TIMEOUT_MS = 30_000;

/** The prompt Pi appends right after before_agent_start, as a projected entry without an id: the plan made before it counts its size. */
function pendingPrompt(e: Any): Any | null {
	if (typeof e?.prompt !== "string") return null;
	const m = { role: "user", content: [{ type: "text", text: e.prompt }, ...(Array.isArray(e.images) ? e.images : [])], timestamp: Date.now() };
	return { sourceEntry: { type: "message", message: m }, messages: [m] };
}

export class Zip implements ZipControl {
	off = false;
	quiet = false;
	conflict: string | null = null;
	readonly stats = new Stats();
	readonly recalled = new Set<string>();
	private cold = false;
	private coldReason = "";
	private runChecked = true; // the first request of the run has been looked at
	private runEdits = false; // this run carries an edit plan that turn_end has yet to persist
	private runPlan: RunPlan | null = null;
	private lastReqMs = 0; // the real-time cache clock: newest request start or end
	private lastModelKey = ""; // provider/model of the newest request: a cache entry belongs to one model
	private settleIds: string[] = []; // entries the settle plan folded: only used to label a plan as prepared
	private bg: Bg | null = null;
	private bgWaitMs = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private timerGen = 0;
	private wireLedgered = false;
	private model: Any;
	private conflictNoticed = false;
	private ttlNoticed = false;
	private runUserSeen = 0;
	private steerTs = new Set<number>(); // timestamps of steering/follow-up user messages not yet marked in the session
	private steerIds = new Set<string>(); // marked: user entries that are NOT new user turns
	// the law's inputs (round 5): P(warm) of this run's return, growth g, and the free cache signal of every response
	private pWarm = 1;
	private pastTtl = false; // this run is a user return after the declared TTL (the previous user turn is eligible: plan.ts PlanOpts.pastTtl)
	private survSrc = "no prior request";
	private ent: Entry | undefined; // learned class + survival of the current model (learn.ts)
	private g = G0; // EWMA(0.1) of real-token growth between consecutive responses, capped at the p90 of the last 20 deltas
	private deltas: number[] = [];
	private prevTotal = 0; // prompt size (input + cacheRead + cacheWrite) of the newest response, and its model
	private prevKey = "";
	private branchLastMs = 0; // the branch clock at run start (a fresh process knows the gap from the session)
	private nextEdit: number | null = null; // the next request is the first to carry a new edit: its untouched prefix (real tokens)
	private pending: { gapS: number; expect: number; edited: boolean; key: string } | null = null;
	private justEdited = false; // the newest response answered a request that first carried an edit: the next request gets no warm edit
	// pi-zip's own ctx.compact() in flight: the only compaction session_before_compact answers (compaction null = cancel a late ask)
	private nativeAsk: { compaction: Any | null; answered: boolean; until: number } | null = null;
	// this run's away summary went in through Pi's compaction before the run: the projection just before it, for the run plan (I1)
	private nativeRun: { key: string; cut: Cut; before: number; after: number; pre: Any[]; entryId: string } | null = null;

	constructor(private pi: ExtensionAPI) {}

	active = () => !this.off && !this.conflict;

	/** How the model gets a folded output back, checked at session start and before every run (index.ts): "tool" = zip_recall is declared;
	 *  "file" = a `--tools` allowlist hides it but read, grep or bash is active (placeholders name a recall file, written on demand);
	 *  "reread" = none of those either: only re-readable outputs fold. */
	recallMode: "tool" | "file" | "reread" = "tool";
	private recallTools = { read: false, grep: false, bash: false };
	get recallOk(): boolean {
		return this.recallMode === "tool";
	}
	/** index.ts registered the transcript renderer for NOTICE_CUSTOM (Pi versions without registerEntryRenderer fall back to a status line). */
	entryRenderer = false;
	private coldWhy = ""; // the expanded notice's "why now" for this run
	private noticed = false; // a transcript notice was written in this process (the branch may not show it yet)
	/** A summary was persisted since the last cold run start: later warm plans make none unless at the compaction room. */
	summarizedWarm = false;
	setRecallMode(mode: "tool" | "file" | "reread", tools: { read: boolean; grep: boolean; bash: boolean }, ctx?: Any) {
		if (mode !== this.recallMode) this.ledger({ type: "recall_available", ok: mode === "tool", mode, ...tools });
		this.recallMode = mode;
		this.recallTools = tools;
		if (!ctx) return;
		if (mode === "file" && this.fileRecall(ctx)) this.stateLine(ctx, "on", `a tool allowlist hides zip_recall · zipped outputs are read back from files in ${RECALL_DIR}`, true, "on:file");
		else if (mode !== "tool") this.stateLine(ctx, "reread-only", "a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more");
	}
	/** The recall files this session's placeholders name; undefined outside file mode (or without a session id: then only re-readable outputs fold). */
	private fileRecall(ctx: Any): FileRecall | undefined {
		if (this.recallMode !== "file") return undefined;
		const sid = this.sessionId(ctx);
		return sid ? fileRecallFor(sid, this.recallTools) : undefined;
	}
	private sessionId(ctx: Any): string {
		try {
			const sid = ctx?.sessionManager?.getSessionId?.();
			return typeof sid === "string" ? sid : "";
		} catch {
			return "";
		}
	}

	/** Folded tool outputs of the current branch by toolCallId -> handle (the transcript marks them). */
	readonly foldedCalls = new Map<string, string>();
	foldedHandle = (toolCallId: string): string | undefined => this.foldedCalls.get(toolCallId);
	/** handle -> what was folded ("read src/learn.ts"), from the placeholders of this branch: the recall row names it. */
	readonly labels = new Map<string, string>();
	labelOf = (handle: string): string | undefined => this.labels.get(handle);
	refreshFolded(ctx: Any) {
		const branch = this.branch(ctx);
		const byId = new Map(branch.map((e: Any) => [e?.id, e]));
		this.foldedCalls.clear();
		for (const e of branch) {
			const ph = String(e?.replacement?.content?.[0]?.text ?? "");
			if (e?.type !== "context_edit" || !ph.startsWith(PH_MARK)) continue;
			const h = handleFor(e.targetId);
			// older placeholders wrote a read slice as "offset=1 limit=2000": show it the way Pi does ("path:1-2000")
			const label = ph.slice(0, ph.indexOf("\n") >>> 0).split(" · ")[1]?.replace(/ offset=(\d+)(?: limit=(\d+))?$| limit=(\d+)$/, (_m, o, l, l2) => {
				const st = o ? +o : 1, li = l ?? l2;
				return `:${st}${li ? `-${st + +li - 1}` : ""}`;
			});
			if (label) this.labels.set(h, label);
			const id = byId.get(e.targetId)?.message?.toolCallId;
			if (typeof id === "string") this.foldedCalls.set(id, h);
		}
	}

	/** /zip output in the transcript (custom entry, never sent to the model). */
	show(ctx: Any, data: NoticeData): boolean {
		if (ctx?.mode !== "tui" || !this.entryRenderer) return false;
		try {
			this.pi.appendEntry(NOTICE_CUSTOM, data);
			return true;
		} catch {
			return false;
		}
	}

	/** A state change as one transcript line ("ƶ pi-zip  paused  …"); each word once per session unless always. */
	stateLine(ctx: Any, word: StateWord, reason: string, once = true, key: string = word) {
		const text = `${PRODUCT}  ${word}  ${reason}`;
		if (ctx?.mode !== "tui" && word !== "paused") return; // print/json/rpc (sub-agents): no transcript to keep it in
		if (once && (this.statesShown.has(key) || this.branch(ctx).some((e: Any) => e?.type === "custom" && e.customType === NOTICE_CUSTOM && e.data?.kind === "state" && (e.data?.key ?? e.data?.word) === key))) return;
		this.statesShown.add(key);
		this.ledger({ type: "state", word, reason });
		// a state is not tied to this turn's edits: append now, so it sits where it happened
		if (!this.show(ctx, { v: 2, kind: "state", word, reason, text, before: 0, after: 0, desc: "", ...(key !== word ? { key } : {}) })) this.notify(ctx, text);
	}
	private statesShown = new Set<string>();

	/** First pi-zip session on this machine: one line that sets the expectation (nothing visible happens until the cache expires). */
	welcome(ctx: Any) {
		if (ctx?.mode !== "tui" || !this.entryRenderer || this.off || this.conflict) return;
		const flag = `${dirname(process.env.PI_ZIP_CACHE_STATS || statsPath())}/welcomed`;
		try {
			if (existsSync(flag)) return;
			mkdirSync(dirname(flag), { recursive: true });
			writeFileSync(flag, new Date().toISOString() + "\n");
		} catch {
			return;
		}
		const ttl = ttlFor(ctx.model ?? this.model);
		this.stateLine(ctx, "on", `old tool output gets zipped once the prompt cache expires (${fmtLife(ttl / 1000).slice(1)} here) · /zip`);
	}

	ledger(rec: Record<string, unknown>) {
		const path = process.env.PI_ZIP_LEDGER; // test only
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec }) + "\n");
		} catch {}
	}

	/** keep = a fold/summary notice: written to the session as a custom entry, so it stays in the transcript (also after a restart)
	 *  next to Pi's own "[compaction]" block instead of a status line the next status overwrites. Custom entries never reach the model. */
	private notify(ctx: Any, text: string, keep?: NoticeData) {
		this.stats.notices++;
		this.ledger({ type: "notice", text });
		if (keep && ctx?.mode === "tui" && this.entryRenderer) {
			setTimeout(() => { // after Pi has appended this turn's edits
				try {
					this.pi.appendEntry(NOTICE_CUSTOM, keep);
				} catch {}
			}, 0);
			return;
		}
		if (ctx?.ui?.notify && (ctx.mode === "tui" || ctx.mode === "rpc")) {
			try {
				ctx.ui.notify(text, "info");
			} catch {}
		}
	}

	private branch(ctx: Any): Any[] {
		try {
			return ctx.sessionManager.getBranch() as Any[];
		} catch {
			return [];
		}
	}

	private reserve(ctx: Any): number {
		try {
			return reserveTokensFor(this.pi.getSettings?.(), ctx?.model);
		} catch {
			return reserveTokensFor(undefined, ctx?.model);
		}
	}

	/** The system prompt and the declared tools from Pi's API: only used when the transcript records no system message (plan.ts calibrate). */
	private sysInfo(ctx: Any): SysInfo {
		let text = "", tools: Any[] = [];
		try {
			text = ctx?.getSystemPrompt?.() ?? "";
		} catch {}
		try {
			const active = new Set(this.pi.getActiveTools?.() ?? []);
			tools = (this.pi.getAllTools?.() ?? []).filter((t: Any) => active.has(t?.name));
		} catch {}
		return { text, tools };
	}

	/** The token scale (O, c) read from the branch: stateless, so a fresh process calibrates exactly like a long-lived one. */
	scaleOf(ctx: Any, entries?: Any[]): Scale {
		try {
			return calibrate(entries ?? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []), this.sysInfo(ctx), this.branch(ctx), ctx?.model ? modelKey(ctx.model) : undefined);
		} catch {
			return UNIT;
		}
	}

	/** The token scale of model `key` ("provider/id"), read from the branch. */
	private scaleAt(ctx: Any, entries: Any[] | undefined, key: string): Scale {
		try {
			return calibrate(entries ?? [], this.sysInfo(ctx), this.branch(ctx), key);
		} catch {
			return UNIT;
		}
	}

	/** Plan options with the token scale read from the branch. */
	private opts(ctx: Any, pending: boolean, mode: "cold" | "warm", entries: Any[], pWarm = mode === "cold" ? 0 : 1): { o: PlanOpts; cal: Scale } {
		const cal = this.scaleOf(ctx, entries);
		const fileRecall = this.fileRecall(ctx);
		const rereadOnly = this.recallMode === "reread" || (this.recallMode === "file" && !fileRecall);
		return { cal, o: { mode, scale: cal, cwd: (ctx?.cwd as string) ?? process.cwd(), recalled: this.recalled, model: ctx?.model, promptPending: pending, rereadOnly, ...(fileRecall ? { fileRecall } : {}), noSummary: mode === "warm" && this.summarizedWarm, reserve: this.reserve(ctx), steerIds: this.steerIds, law: this.law(ctx, pWarm), trace: [] } };
	}

	private law(ctx: Any, pWarm: number): Law {
		const m = ctx?.model ?? this.model;
		const ent = this.entKey === modelKey(m) ? this.ent : undefined;
		return { pr: lawPrices(ent?.cls, resolveTtl(m, this.branch(ctx)).ms >= 3_600_000), g: this.g, pWarm };
	}
	private entKey = "";
	private loadEnt(key: string) {
		this.entKey = key;
		this.ent = loadStats().models[key];
	}

	/** Ledger form of the law's evaluations: Phi, K, eta, T next to g, w/r, P(warm) and where the inputs came from. */
	private lawLedger(where: string, o: PlanOpts) {
		const l = o.law!, pr = l.pr, rd = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x > 0 ? "inf" : null);
		this.ledger({
			type: "law", where, g: Math.round(l.g), pWarm: rd(l.pWarm), survSrc: where === "run" ? this.survSrc : "in-run", cls: pr?.cls ?? null, wr: pr ? rd(pr.w / pr.r) : null, prSrc: pr?.src ?? "legacy",
			steps: (o.trace ?? []).map((t) => ({ at: t.where, ok: t.ok, B: Math.round(t.B), A: Math.round(t.A), T: Math.round(t.T), ...(t.Tsuf !== undefined ? { Tsuf: Math.round(t.Tsuf) } : {}), phi: rd(t.phi), K: rd(t.K), eta: rd(t.eta) })),
		});
	}

	private detectConflict(ctx: Any) {
		let found: string | null = null;
		try {
			const items: Any[] = [...(this.pi.getAllTools?.() ?? []), ...(this.pi.getCommands?.() ?? [])];
			for (const it of items) {
				if (it.name === "zip_recall" || it.name === "zip") continue;
				const hay = `${it.name} ${it.sourceInfo?.path ?? ""} ${it.sourceInfo?.source ?? ""}`;
				const m = CONFLICT_RE.exec(hay);
				if (m) { found = m[0]; break; }
			}
		} catch {}
		this.conflict = found;
		if (found && !this.conflictNoticed) {
			this.conflictNoticed = true;
			this.stateLine(ctx, "paused", `${found} also manages context, so pi-zip only guards requests · to use pi-zip: pi remove the other one`, true);
		}
	}

	// ---- events ----------------------------------------------------------------------------------------------
	sessionStart(ctx: Any) {
		const branch = this.branch(ctx);
		for (let i = branch.length - 1; i >= 0; i--) {
			const en = branch[i];
			if (en?.type === "custom" && en.customType === STATE_CUSTOM) {
				this.off = !!en.data?.off;
				this.quiet = !!en.data?.quiet;
				break;
			}
		}
		for (const en of branch) if (en?.type === "custom" && en.customType === STEER_CUSTOM && Array.isArray(en.data?.ids)) for (const id of en.data.ids) if (typeof id === "string") this.steerIds.add(id);
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		this.model = ctx?.model;
		this.ttlNoticed = false;
		this.detectConflict(ctx);
		let recallFilesRemoved = 0;
		try {
			recallFilesRemoved = cleanupRecall(); // recall copies older than 14 days (they can be written again from the session)
		} catch {}
		this.ledger({ type: "session_start", off: this.off, quiet: this.quiet, conflict: this.conflict, ...(recallFilesRemoved ? { recallFilesRemoved } : {}) });
	}

	// ---- recall through files (research pi-tricks §2) -----------------------------------------------------------------------
	/** This machine's directory for this session's recall files. */
	private localRecallDir(ctx: Any): string | null {
		const sid = this.sessionId(ctx);
		return sid ? join(recallRoot(), sidDir(sid)) : null;
	}
	/** Write the originals of these handles (from the current branch) if they are not on disk yet: their local paths. */
	private materializeHandles(ctx: Any, handles: string[]): Map<string, string> {
		const sid = this.sessionId(ctx);
		if (!sid || !handles.length) return new Map();
		const { items } = resolveHandlesInBranch(this.branch(ctx), handles);
		const found = items.filter((it): it is typeof it & { text: string } => it.text !== null);
		const out = materialize(recallRoot(), sid, found.map((it) => ({ handle: it.handle, text: it.text })));
		this.ledger({ type: "recall_file", handles: found.map((it) => it.handle), missing: handles.length - found.length, chars: found.reduce((a, it) => a + it.text.length, 0) });
		return out;
	}
	/** Every output this session's model no longer sees in full (folded, or summarised away): what a grep, ls or find over the directory needs. */
	private materializeAll(ctx: Any): string | null {
		const sid = this.sessionId(ctx);
		if (!sid) return null;
		let visible = new Set<string>();
		try {
			const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
			visible = new Set(entries.filter((pe) => pe?.sourceEntry?.type === "message" && pe.messages?.[0]?.role === "toolResult" && !textOf(pe.messages[0].content).startsWith(PH_MARK)).map((pe) => pe.sourceEntry.id));
		} catch {}
		const zipped = branchOutputs(this.branch(ctx)).filter((o) => o.tool !== RECALL_TOOL && !visible.has(o.entryId));
		materialize(recallRoot(), sid, zipped.map((o) => ({ handle: o.handle, text: o.text })));
		this.ledger({ type: "recall_file", all: true, count: zipped.length, chars: zipped.reduce((a, o) => a + o.text.length, 0) });
		return join(recallRoot(), sidDir(sid));
	}
	/**
	 * tool_call: a built-in read, grep, find or ls whose path names a recall file (or this session's recall directory), or a bash command
	 * that does, gets this machine's copy, written now from the current branch if it is not on disk yet. Any prefix is accepted (another
	 * machine, another user, a forked session's id): the handle is resolved against the current branch. Never blocks a call.
	 */
	toolCall(e: Any, ctx: Any): undefined {
		try {
			const input = e?.input, name = e?.toolName;
			if (!input || typeof input !== "object") return undefined;
			if ((name === "read" || name === "grep" || name === "find" || name === "ls") && typeof input.path === "string") {
				const ref = parseRecallPath(input.path);
				if (!ref) return undefined;
				if (ref.handle) {
					const local = this.materializeHandles(ctx, [ref.handle]).get(ref.handle);
					if (local) input.path = local;
				} else if (name !== "read") {
					const dir = this.materializeAll(ctx);
					if (dir) input.path = dir;
				}
			} else if (name === "bash" && typeof input.command === "string" && commandNamesRecall(input.command)) {
				const dir = this.localRecallDir(ctx);
				if (!dir) return undefined;
				const r = rewriteCommand(input.command, dir);
				if (r.dir) this.materializeAll(ctx);
				else this.materializeHandles(ctx, r.handles);
				input.command = r.command;
			}
		} catch (err) {
			this.ledger({ type: "error", where: "tool_call", error: errText(err) });
		}
		return undefined;
	}

	shutdown() {
		this.cancelTimer();
		this.bg?.controller.abort();
		this.bg = null;
	}

	async beforeAgentStart(ctx: Any, e?: Any): Promise<void> {
		this.cancelTimer(); // the user is back: nothing is started behind their back any more
		this.model = ctx?.model;
		this.cold = false;
		this.pastTtl = false;
		this.runChecked = true;
		this.runEdits = false;
		this.runPlan = null;
		this.nativeRun = null;
		this.settleIds = [];
		this.bgWaitMs = 0;
		this.wireLedgered = false;
		this.runUserSeen = 0;
		if (!this.active()) return;
		this.detectConflict(ctx);
		if (!this.active()) return;
		const branch = this.branch(ctx);
		const key = modelKey(ctx.model);
		this.loadEnt(key);
		this.branchLastMs = lastMessageMs(branch);
		if (!this.prevKey) ({ key: this.prevKey, total: this.prevTotal } = lastPrompt(branch)); // fresh process: the session's newest response
		const { cold, reason, ttl, pWarm: p, src, gapS, pastTtl } = detectCold(ctx.model, this.lastReqMs, branch, Date.now(), this.lastModelKey, (g, prior) => pWarm(this.ent, g, prior));
		this.cold = cold;
		if (cold) this.summarizedWarm = false; // a cold return may summarise again
		this.pastTtl = pastTtl;
		this.pWarm = p;
		this.survSrc = src;
		this.runChecked = false; // the first request decides (cold: the cold plan; warm: only above the cap, if the law fires)
		this.coldReason = reason;
		this.coldWhy = src === "model switch" ? "model switched" : cold && gapS !== null ? `away ${fmtAway(gapS)}` : "";
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		for (let i = branch.length - 1; i >= 0; i--) {
			const en = branch[i];
			if (en?.type !== "custom" || en.customType !== PLAN_CUSTOM) continue;
			if (en.data?.policy === PRODUCT) {
				if (cold && Array.isArray(en.data.targets)) this.settleIds = en.data.targets.map((t: Any) => (typeof t === "string" ? t : t?.entryId)).filter((x: Any) => typeof x === "string");
			}
			break;
		}
		this.ledger({ type: "prompt", cold, reason, ttlMs: ttl.ms, ttlSource: ttl.source, settleTargets: this.settleIds.length, gapS: gapS === null ? null : Math.round(gapS), pWarm: Math.round(p * 1000) / 1000, survSrc: src, cls: this.ent?.cls ?? null });
		if (ttl.note && !this.ttlNoticed) {
			this.ttlNoticed = true; // once per session
			if (!this.quiet) this.stateLine(ctx, "cache", ttl.note.replace(`${PRODUCT} · `, ""));
		}
		if (cold && this.bg?.done) {
			try {
				await this.nativeSummary(ctx, e);
			} catch (err) {
				this.nativeAsk = null;
				this.ledger({ type: "error", where: "native_summary", error: errText(err) });
			}
		}
	}

	/** session_before_compact: answers ONLY the compaction pi-zip itself asked for a moment ago (nativeAsk): its own summary and its own
	 *  tokensBefore. Pi's threshold and overflow compactions, /compact and other extensions' compactions get undefined and run untouched. */
	sessionBeforeCompact(): Any {
		const a = this.nativeAsk;
		if (!a || a.answered || Date.now() > a.until) return undefined;
		a.answered = true;
		return a.compaction ? { compaction: a.compaction } : { cancel: true };
	}

	/** Why Pi's own compaction cannot take this summary now (null: it can). Each reason keeps today's path: the run plan carries the summary
	 *  request-locally and turn_end persists it as a draft. */
	private nativeGate(ctx: Any, branch: Any[], pre: Any[]): string | null {
		if (typeof ctx?.compact !== "function") return "no ctx.compact";
		let idle = false;
		try {
			idle = ctx.isIdle?.() === true; // compact() aborts whatever runs first: only ever called while Pi is idle (it is, here, in 1.1.0)
		} catch {}
		if (!idle) return "not idle";
		if (branch[branch.length - 1]?.type === "compaction") return "already compacted";
		let settings: Any;
		try {
			settings = this.pi.getSettings?.();
		} catch {}
		if (!piCanCompact(pre, keepRecentTokensFor(settings, ctx?.model))) return "nothing to compact";
		return null;
	}

	/**
	 * A summary prepared while the user was away goes into the session through Pi's own compaction, before the run (research pi-tricks
	 * §1b, variant 1): ctx.compact() with session_before_compact answering pi-zip's summary and pi-zip's own tokensBefore (the notice's
	 * "before", provider scale), so Pi's "[compaction] Compacted from N tokens" shows that number. It takes milliseconds: the summary is
	 * done. The run plan is then made on the projection as it was before the compaction, so the run's first request carries the same
	 * bytes as the draft path would have sent; any gate that fails keeps the draft path.
	 */
	private async nativeSummary(ctx: Any, e: Any): Promise<void> {
		const b = this.bg;
		if (!b?.done || !b.key) return;
		const branch = this.branch(ctx);
		const pre = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		const skip = (reason: string) => this.ledger({ type: "native_skip", reason });
		// the plan the first request will make: the same one, with the prompt Pi is about to append
		const pending = pendingPrompt(e);
		const entries = pending ? [...pre, pending] : pre;
		const { o } = this.opts(ctx, !pending, "cold", entries, this.pWarm);
		o.pastTtl = this.pastTtl;
		const p = planContext(entries, o);
		if (!p || p.cutIdx === null || p.firstKeptEntryId !== b.key) return skip("the summary does not fit this plan");
		const cut = b.done;
		if (checkEdits(p.blocks, p.userTurns, p.folds, cut)) return skip("guard");
		const gate = this.nativeGate(ctx, branch, pre);
		if (gate) return skip(gate);
		const before = Math.round(p.ctxTokens);
		const compaction = { summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: before, details: { by: PRODUCT, via: "native", trigger: cut.trigger }, usage: cut.usage };
		this.nativeAsk = { compaction, answered: false, until: Infinity };
		const t0 = performance.now();
		const res = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
			const timer = setTimeout(() => resolve({ ok: false, err: "timeout" }), NATIVE_TIMEOUT_MS);
			timer.unref?.();
			const done = (r: { ok: boolean; err?: string }) => (clearTimeout(timer), resolve(r));
			try {
				ctx.compact({ onComplete: () => done({ ok: true }), onError: (err: Any) => done({ ok: false, err: err instanceof Error ? err.message : String(err) }) });
			} catch (err) {
				done({ ok: false, err: errText(err) });
			}
		});
		const answered = !!this.nativeAsk?.answered;
		// a timeout before Pi asked: if it asks later after all, that compaction is cancelled (never Pi's own summary on pi-zip's behalf)
		this.nativeAsk = res.err === "timeout" && !answered ? { compaction: null, answered: false, until: Date.now() + 60_000 } : null;
		const ms = Math.round(performance.now() - t0);
		const after = this.branch(ctx);
		let entry: Any = null;
		for (let i = after.length - 1; i >= 0 && !entry; i--) if (after[i]?.type === "compaction" && after[i].details?.via === "native" && after[i].summary === cut.text) entry = after[i];
		if (!entry?.id) {
			this.ledger({ type: "native_fail", ms, answered, error: res.err ?? "no compaction entry" });
			return; // the draft path: the run plan adopts the prepared summary as before
		}
		this.bg = null; // adopted by Pi's compaction
		this.summarizedWarm = true; // one summary per warm stretch, as for a draft (commit)
		// the summary is in the session from now on, whatever the run does: book it here (commit() does not book it again)
		const cutSaved = Math.round(p.scale.c * (cut.prefixTokens - cut.summaryTokens));
		this.nativeRun = { key: b.key, cut, before, after: Math.round(p.ctxAfterFolds - cutSaved), pre, entryId: entry.id };
		const s = this.stats;
		s.summaries++;
		s.summarizedTokens += cutSaved;
		s.summaryUsd += cut.costUsd;
		s.activeSaved += cutSaved;
		s.writeSavedTokens += cutSaved;
		this.ledger({ type: "summary", via: "native", trigger: cut.trigger, source: "settle", count: cut.count, tokensBefore: before, prefixTokens: Math.round(p.scale.c * cut.prefixTokens), summaryTokens: Math.round(p.scale.c * cut.summaryTokens), ms: cut.ms, compactMs: ms, waitedMs: 0, llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
	}

	private cancelTimer() {
		this.timerGen++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** A summary nobody adopted still cost money: abort it if it is still running, book it if it finished. */
	private discardBg() {
		const b = this.bg;
		this.bg = null;
		if (!b) return;
		if (!b.done) b.controller.abort();
		b.promise.then((c) => {
			if (!c) return;
			this.stats.summaryUsd += c.costUsd;
			try {
				this.pi.appendEntry(UNUSED_SUMMARY_CUSTOM, { usd: c.costUsd });
			} catch {}
		});
	}

	async context(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		if (!this.runChecked) {
			this.runChecked = true;
			try {
				await this.computeRunPlan(ctx);
			} catch (err) {
				// no plan was sent, so none may be persisted: end the edit run here
				this.runPlan = null;
				this.runEdits = false;
				this.ledger({ type: "error", where: "context/run_plan", error: errText(err) });
			}
		}
		if (this.runPlan && !this.runPlan.persisted) {
			const out = applyPlanToMessages(e.messages, this.runPlan);
			if (out || this.runPlan.native) { // a native summary is already in the request Pi built: it still goes out with this request
				if (!this.runPlan.sent) this.nextEdit = this.runPlan.untouched ?? 0;
				this.runPlan.sent = true;
				const applied = (this.runPlan.applied = out?.applied ?? this.runPlan.applied ?? new Set<string>());
				if (!this.runPlan.noticed) { // say it where it happens: at the top of the turn, before the model answers
					this.runPlan.noticed = true;
					const live = this.runPlan.folds.filter((t) => applied.has(t.entryId));
					this.noticeFor(ctx, this.runPlan, live, this.runPlan.cut ?? this.runPlan.native ?? null, this.runPlan.ctxBefore, 0);
				}
				return out ? { messages: out.messages } : undefined;
			}
		}
		return undefined;
	}

	/** A prepared summary for this cut, or null. A summary still being written is waited for (only the remainder); Esc stops the waiting, not the work. */
	/** While the user waits for a summary, Pi's working line says what for (and that Esc skips a prepared one). */
	private async working<T>(ctx: Any, text: string, p: Promise<T>): Promise<T> {
		const ui = ctx?.mode === "tui" ? ctx?.ui : null;
		try {
			ui?.setWorkingMessage?.(text);
		} catch {}
		try {
			return await p;
		} finally {
			try {
				ui?.setWorkingMessage?.(undefined);
			} catch {}
		}
	}

	private async takeBg(key: string | null, signal?: AbortSignal, ctx?: Any): Promise<{ cut: Cut | null; adopted: boolean }> {
		const b = this.bg;
		if (!b || key === null || b.key !== key) {
			this.discardBg();
			return { cut: null, adopted: false };
		}
		const w0 = performance.now();
		const cut = b.done ?? (await this.working(ctx, `${PRODUCT}: finishing the summary it started while you were away · Esc skips it`, waitFor(b.promise, signal)));
		this.bgWaitMs = performance.now() - w0;
		if (cut) {
			this.bg = null;
			return { cut, adopted: true };
		}
		if (signal?.aborted) return { cut: null, adopted: false }; // keep it running: a retry of the prompt can still use it
		this.discardBg();
		return { cut: null, adopted: false };
	}

	/** ONE plan per edit run: computed at the first request (the new prompt is in the session), applied to every request until turn_end persists the same set. */
	private async computeRunPlan(ctx: Any) {
		const t0 = performance.now();
		const now = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		// a summary that went in through Pi's compaction before the run (nativeSummary): plan on the projection as it was right before
		// it, plus what came after, so folds, scale and placeholders are exactly what the draft path computes (the run's first request
		// carries the same bytes); the request Pi builds already starts with the summary
		const nat = this.nativeRun;
		this.nativeRun = null;
		const spliced = nat ? spliceNative(nat.pre, now, nat.entryId) : null;
		if (!this.cold && this.justEdited) { // no warm edit on the request right after an edited one (no back-to-back warm rewrites)
			this.ledger({ type: "b2b_skip", where: "run" });
			this.discardBg();
			return;
		}
		const plan = (entries: Any[]) => {
			const { o, cal } = this.opts(ctx, false, this.cold ? "cold" : "warm", entries, this.pWarm);
			o.pastTtl = this.pastTtl;
			return { o, cal, p: planContext(entries, o) };
		};
		let { o, cal, p } = plan(spliced ?? now);
		const onPre = !!nat && !!spliced && !!p && p.cutIdx !== null && p.firstKeptEntryId === nat.key;
		if (nat && !onPre) {
			// the summary is in the session, but this plan would not cut there (the prompt, or what came with it, changed the plan): plan on
			// the session as it is now, with the summary at its head
			this.ledger({ type: "native_mismatch", planned: p?.firstKeptEntryId ?? null, compacted: nat.key });
			({ o, cal, p } = plan(now));
		}
		this.lawLedger("run", o);
		const native = nat?.cut ?? null;
		if (!p && !native) {
			this.discardBg(); // the law does not fire (warm below the cap or a rewrite that does not pay back; a likely-warm cold return): a prepared summary does not pay back
			return;
		}
		this.runEdits = true;
		const trigger = this.cold ? "cold" : "valve";
		let folds: FoldTarget[] = p?.folds ?? [];
		let cut: Cut | null = null;
		let adopted = !!native; // Pi's compaction took the prepared summary
		if (!native && p && p.cutIdx !== null) {
			const got = await this.takeBg(p.firstKeptEntryId, ctx.signal, ctx);
			cut = got.cut;
			adopted = got.adopted;
		} else if (!native) {
			this.discardBg();
		}
		const sameSet = this.settleIds.length === folds.length && this.settleIds.every((id) => folds.some((u) => u.entryId === id));
		const source: RunPlan["source"] = !this.cold ? "valve" : adopted || (this.settleIds.length > 0 && sameSet) ? "settle" : "runstart";
		const foldMs = performance.now() - t0;
		if (!cut && !native && p && p.cutIdx !== null && !ctx.signal?.aborted) cut = await this.working(ctx, `${PRODUCT}: writing a summary (folding alone cannot make the context small enough)`, buildCut(p, ctx)); // produced now, before the first request: the user waits
		// a plan that cannot be persisted must never be sent: the request view would differ from what turn_end can write (I1)
		if (p) {
			const invalid = checkEdits(p.blocks, p.userTurns, folds, cut ?? (onPre ? native : null));
			if (invalid) {
				this.ledger({ type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length, summary: !!(cut ?? native) });
				if (native) folds = []; // the summary is in the session already: only the folds can be dropped
				else if (cut && checkEdits(p.blocks, p.userTurns, folds, null) === null) cut = null;
				else { folds = []; cut = null; }
			}
		}
		const sum = cut ?? (onPre ? native : null); // a summary this plan's sizes do not count yet
		let ctxBefore = p?.ctxTokens ?? 0;
		let ctxAfter = (p?.ctxAfterFolds ?? 0) - (sum ? cal.c * (sum.prefixTokens - sum.summaryTokens) : 0);
		if (nat) {
			// the notice's "before" is the number Pi's [compaction] block shows (computed with the prompt before Pi appended it)
			ctxAfter = p ? ctxAfter + (onPre ? nat.before - ctxBefore : 0) : nat.after;
			ctxBefore = nat.before;
		}
		this.runPlan = {
			source, folds: onPre ? rebaseFolds(folds, p!.cutVisibleIdx) : folds, cut, native: native ?? undefined, ctxBefore, ctxAfter, ms: foldMs, scale: cal, persisted: false,
			waitMs: cut ? (adopted ? this.bgWaitMs : cut.ms) : 0, cutVisibleIdx: p?.cutVisibleIdx ?? -1, cutKeptFirstMsg: p?.cutKeptFirstMsg, untouched: p ? sizeOf(cal, untouchedEst(p.blocks, folds, !!(cut ?? native))) : sizeOf(cal, 0),
		};
		this.ledger({ type: "cold_plan", trigger, source, folds: folds.length, summary: !!(cut ?? native), ...(native ? { via: "native", onPre } : {}), ...this.calOf(cal), ctxBefore: Math.round(ctxBefore), ctxAfter: Math.round(ctxAfter), ms: Math.round(foldMs), ...(cut ? { summaryMs: cut.ms, llmOk: cut.llmOk, waitedMs: Math.round(adopted ? this.bgWaitMs : cut.ms), ...this.usageOf(cut) } : {}) });
	}

	/** Ledger form of a calibration; ctxBefore/ctxAfter next to it are already real (O + c x estimate). */
	private calOf(cal: Scale) {
		return { O: Math.round(cal.O), c: Math.round(cal.c * 1000) / 1000, oSource: cal.oSource, calReal: cal.real, calEst: Math.round(cal.est), calSource: cal.source };
	}

	private usageOf(cut: Cut) {
		const u = cut.usage;
		return u ? { summaryUsage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } } : {};
	}

	/**
	 * Prepare the next cold return while the user is away (interactive only; print and json mode exit right after settle, so there is
	 * nothing to prepare and nothing is ever started in the background). The plan itself is local and free; only a summary needs
	 * a model call, and that is started by a timer 0.8 x TTL after the last request, if the user has not come back by then.
	 */
	async settle(e: Any, ctx: Any): Promise<Any> {
		if (!this.active() || !ctx.hasUI) return undefined;
		try {
			const t0 = performance.now();
			const { o, cal } = this.opts(ctx, true, "cold", e.context.contextEntries);
			const p = planContext(e.context.contextEntries, o);
			if (!p) return undefined;
			this.cancelTimer();
			let scheduledMs: number | null = null;
			if (p.cutIdx !== null) {
				if (this.bg && this.bg.key === p.firstKeptEntryId) {
					// the summary for this very cut is already in flight or done: keep it
				} else {
					this.discardBg();
					scheduledMs = this.scheduleSummary(p, ctx);
				}
			} else {
				this.discardBg();
			}
			this.ledger({ type: "settle_plan", folds: p.folds.length, summary: p.cutIdx !== null, timerMs: scheduledMs, ...this.calOf(cal), ctxBefore: Math.round(p.ctxTokens), ms: Math.round(performance.now() - t0) });
			if (!p.folds.length && p.cutIdx === null) return undefined;
			// ids only: placeholders and summary text are recomputed (they are pure functions of the session), never stored a second time
			const data = { policy: PRODUCT, ts: Date.now(), targets: p.folds.map((t) => t.entryId), cutKey: p.firstKeptEntryId };
			return { entries: [...e.entries, { type: "custom", customType: PLAN_CUSTOM, data }] };
		} catch (err) {
			this.ledger({ type: "error", where: "settle", error: errText(err) });
			return undefined; // never break the session
		}
	}

	/** Start the away-timer for a summary; returns the delay in ms. unref'd: it never keeps the process alive. */
	private scheduleSummary(p: PlanResult, ctx: Any): number {
		const ttl = ttlFor(ctx.model, this.branch(ctx));
		const delay = Math.max(0, (this.lastReqMs || Date.now()) + AWAY_FRACTION * ttl - Date.now());
		const gen = ++this.timerGen;
		this.timer = setTimeout(() => void this.runAway(p, ctx, gen), delay);
		this.timer.unref?.();
		return Math.round(delay);
	}

	private async runAway(p: PlanResult, ctx: Any, gen: number) {
		this.timer = null;
		if (gen !== this.timerGen || !this.active()) return; // the user came back, or we were switched off
		const controller = new AbortController();
		const bg: Bg = { key: p.firstKeptEntryId, done: null, promise: Promise.resolve(null), controller };
		bg.promise = buildCut(p, ctx, controller.signal)
			.then((c) => ((bg.done = c), this.ledger({ type: "away_summary", ms: c.ms, llmOk: c.llmOk, costUsd: c.costUsd, ...this.usageOf(c) }), c))
			.catch((err) => {
				this.ledger({ type: "error", where: "away_summary", error: err instanceof Error ? err.message : String(err) });
				return null;
			});
		this.bg = bg;
		this.ledger({ type: "away_summary_start" });
	}

	async turnEnd(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		try {
			const fresh = this.collectSteer(e); // marked before anything is validated: a steering message is part of its turn
			const out = await this.onTurnEnd(e, ctx);
			if (!fresh.length) return out;
			this.ledger({ type: "steer", ids: fresh });
			return { entries: [...(out?.entries ?? e.entries), { type: "custom", customType: STEER_CUSTOM, data: { ids: fresh } }] };
		} catch (err) {
			this.ledger({ type: "error", where: "turn_end", error: errText(err) });
			return undefined;
		}
	}

	/** Steering and follow-up user messages (typed during a run) are not new user turns; Pi does not mark them, so we persist the ids. */
	private collectSteer(e: Any): string[] {
		if (!this.steerTs.size) return [];
		const ids: string[] = [];
		for (const pe of e.context?.contextEntries ?? []) {
			const src = pe.sourceEntry;
			const m = src?.type === "message" ? src.message : null;
			if (m?.role === "user" && typeof m.timestamp === "number" && this.steerTs.has(m.timestamp) && src.id && !this.steerIds.has(src.id)) ids.push(src.id);
		}
		this.steerTs.clear();
		for (const id of ids) this.steerIds.add(id);
		return ids;
	}

	private async onTurnEnd(e: Any, ctx: Any) {
		const msg: Any = e.message;
		const failed = msg?.stopReason === "error" || msg?.stopReason === "aborted";
		const t0 = performance.now();
		const blocks = buildBlocks(e.context.contextEntries, this.steerIds);
		if (!blocks.length) return undefined;
		const userTurns = countUserTurns(blocks);
		const u = msg?.usage;
		const usageTotal = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
		const o = { t0, blocks, userTurns, usageTotal };
		if (this.runEdits) {
			this.runEdits = false;
			if (!this.runPlan?.sent && this.runPlan && (this.runPlan.folds.length || this.runPlan.cut)) {
				this.runPlan = null; // never sent (the request failed before the context hook, or nothing matched): persisting it would change a prefix nobody saw
				return undefined;
			}
			if (!this.runPlan) return undefined;
			// the run has carried its plan since the first request: persist EXACTLY it, even when this turn failed (the prefix was sent and cached)
			return this.commit(e, ctx, this.runPlan, o);
		}
		if (failed) return undefined;
		if (this.justEdited) { // the request that just ended carried a fresh edit: no warm edit on the very next one (no back-to-back warm rewrites)
			this.ledger({ type: "b2b_skip", where: "turn_end" });
			return undefined;
		}
		// warm cache (in-run, P = 1): nothing, unless the context is above the cold cap and the law fires (I6, F10): then the warm plan, from the next request on
		const { o: popts } = this.opts(ctx, false, "warm", e.context.contextEntries); // the message that just ended carries the newest usage
		const p = planContext(e.context.contextEntries, popts);
		if (popts.trace?.length) this.lawLedger("turn_end", popts);
		if (!p || (!p.folds.length && p.cutIdx === null)) return undefined;
		let cut: Cut | null = null;
		if (p.cutIdx !== null) {
			const got = await this.takeBg(p.firstKeptEntryId, ctx.signal, ctx);
			cut = got.cut ?? (await this.working(ctx, `${PRODUCT}: writing a summary (the context is close to the window)`, buildCut(p, ctx))); // the user is here and the cache is warm; the alternative is Pi's lossy compaction
		} else this.discardBg();
		const ctxAfter = p.ctxAfterFolds - (cut ? p.scale.c * (cut.prefixTokens - cut.summaryTokens) : 0);
		const plan: RunPlan = { source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter, ms: performance.now() - t0, scale: p.scale, persisted: false, untouched: sizeOf(p.scale, untouchedEst(p.blocks, p.folds, !!cut)) };
		return this.commit(e, ctx, plan, o);
	}

	/**
	 * The transcript notice for one plan. Facts only, no claims: what changed (sizes), how long it took, and, expanded, why now
	 * ("away 47 min") and what was folded. Whether the cache really was cold is learned from the response, silently (/zip shows it).
	 * `realAfter` > 0: the size the provider reported for the request that carried the plan (shown instead of the estimate).
	 */
	private noticeFor(ctx: Any, plan: RunPlan, live: FoldTarget[], cut: Cut | null, ctxTokens: number, realAfter: number) {
		if (this.quiet || (!live.length && !cut)) return;
		const { c } = plan.scale, valve = plan.source === "valve"; // amounts scale by c; sizes are O + c x content (plan.ts)
		const before = c * live.reduce((a, t) => a + t.entryTokens, 0), after = c * live.reduce((a, t) => a + t.phTokens, 0);
		const cutSaved = cut ? c * (cut.prefixTokens - cut.summaryTokens) : 0;
		const estAfter = ctxTokens - (before - after) - cutSaved;
		const waitMs = cut ? (plan.waitMs ?? (plan.source === "settle" ? this.bgWaitMs : cut.ms)) : 0;
		const notices: NoticeAction[] = [];
		if (live.length) notices.push({ kind: "fold", count: live.length, tokensBefore: ctxTokens, tokensAfter: cut || !realAfter ? ctxTokens - (before - after) : realAfter, ms: plan.ms, pressure: valve });
		if (cut) {
			const prepared = plan.source === "settle" && waitMs < 500; // finished while the user was away: report the real production time, not the zero wait
			notices.push({ kind: "summary", count: cut.count, tokensBefore: ctxTokens - (before - after), tokensAfter: realAfter || estAfter, ms: Math.max(cut.ms, waitMs), waitMs, prepared, pressure: valve });
		}
		for (const t of live) this.labels.set(handleFor(t.entryId), `${t.tool}${t.args ? " " + t.args : ""}`);
		const ITEMS = 8;
		const items = live.slice(0, ITEMS).map((t) => ({ label: `${t.tool}${t.args ? " " + t.args : ""}`, tokens: Math.round(c * t.entryTokens), handle: handleFor(t.entryId) }));
		const why = valve || !this.cold ? "cache warm · worth it at this size" : this.coldWhy;
		const data: NoticeData = { v: 2, text: noticeText(notices), before: Math.round(notices[0].tokensBefore), after: Math.round(notices[notices.length - 1].tokensAfter), desc: noticeDesc(notices), why: why || undefined, items, more: Math.max(0, live.length - ITEMS) || undefined, first: !this.noticed && !this.branch(ctx).some((en: Any) => en?.type === "custom" && en.customType === NOTICE_CUSTOM) };
		this.noticed = true;
		this.notify(ctx, data.text, data);
	}

	private commit(e: Any, ctx: Any, plan: RunPlan, o: { t0: number; blocks: Block[]; userTurns: number; usageTotal: number }) {
		plan.persisted = true;
		const sc = plan.scale, c = sc.c; // one scale for the whole run: stats, notices and the ledger agree with what the plan compared against the limits
		const ctxTokens = sizeOf(sc, o.blocks.reduce((a, b) => a + b.tokens, 0));
		const byId = new Map(o.blocks.map((b) => [b.entryId, b]));
		const wasApplied = (t: FoldTarget) => !plan.applied || plan.applied.has(t.entryId); // persist what the requests actually carried
		const live = plan.folds.filter((t) => byId.has(t.entryId) && wasApplied(t));
		const stale = plan.folds.length - live.length; // e.g. Pi auto-compaction removed them from the projection
		const cut = plan.cut && byId.has(plan.cut.firstKeptEntryId) ? plan.cut : null;
		if (!live.length && !cut) {
			this.ledger({ type: "cold_noop", turnIndex: e.turnIndex, ctx: Math.round(ctxTokens), ...(stale ? { staleTargets: stale } : {}) });
			return undefined;
		}
		const bad = checkEdits(o.blocks, o.userTurns, live, cut);
		if (!bad && cut) this.summarizedWarm = true; // one summary per warm stretch (two in a row cost two uncached calls; the second gains little)
		if (bad) {
			this.ledger({ type: "guard_drop", turnIndex: e.turnIndex, reason: bad, folds: live.length, source: plan.source });
			plan.persisted = false; // keep the request-local view: never switch the fold set mid-run
			return undefined;
		}
		if (!plan.sent) this.nextEdit = plan.untouched ?? 0; // persisted now, first sent with the next request
		const ours: Any[] = live.map((t) => ({ type: "context_edit", targetId: t.entryId, replacement: { content: [{ type: "text", text: t.ph }] } }));
		for (const t of live) if (t.toolCallId) this.foldedCalls.set(t.toolCallId, handleFor(t.entryId));
		// the compaction draft goes FIRST: Pi writes its tokensBefore from the newest usage only while no edit follows that usage, so a
		// fold drafted before it would make Pi's "Compacted from N tokens" the chars/4 of a half-applied projection (research pi-tricks §1a)
		if (cut) ours.unshift({ type: "compaction", summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, details: { by: PRODUCT, trigger: cut.trigger }, usage: cut.usage });
		const before = Math.round(c * live.reduce((a, t) => a + t.entryTokens, 0));
		const after = Math.round(c * live.reduce((a, t) => a + t.phTokens, 0));
		const cutSaved = cut ? Math.round(c * (cut.prefixTokens - cut.summaryTokens)) : 0;
		const waitMs = cut ? (plan.source === "settle" ? this.bgWaitMs : cut.ms) : 0;
		const s = this.stats;
		s.folds += live.length;
		s.foldedTokens += before - after;
		s.activeSaved += before - after + cutSaved;
		if (plan.source === "valve") {
			s.pressureEdits++;
			s.pressureRewriteTokens += ctxTokens;
		} else {
			s.writeSavedTokens += before - after + cutSaved;
		}
		if (cut) {
			s.summaries++;
			s.summarizedTokens += cutSaved;
			s.summaryMs += waitMs;
			s.summaryUsd += cut.costUsd;
		}
		if (live.length) this.ledger({
			type: "fold", trigger: plan.source, turnIndex: e.turnIndex, count: live.length, entries: live.map((t) => t.entryId), tools: live.map((t) => t.tool),
			recoverability: live.map((t) => t.recover ?? "?"), trigs: live.map((t) => t.trig), handles: live.map((t) => handleFor(t.entryId)),
			entryTokensBefore: before, entryTokensAfter: after, ctxBefore: Math.round(ctxTokens), ctxAfter: Math.round(ctxTokens - (before - after) - cutSaved), O: Math.round(sc.O), c: Math.round(sc.c * 1000) / 1000, usageTotal: o.usageTotal,
			coldReason: this.coldReason, prepared: plan.source === "settle", ...(stale ? { staleTargets: stale } : {}),
		});
		if (cut) this.ledger({ type: "summary", trigger: cut.trigger, source: plan.source, count: cut.count, prefixTokens: Math.round(c * cut.prefixTokens), summaryTokens: Math.round(c * cut.summaryTokens), ms: cut.ms, waitedMs: Math.round(waitMs), llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
		// a run plan was announced when its first request went out; a valve plan (between turns) is announced now
		if (!plan.noticed) this.noticeFor(ctx, plan, live, cut, ctxTokens, plan.source === "valve" ? 0 : o.usageTotal);
		plan.noticed = true;
		return { entries: [...e.entries, ...ours] }; // append, never overwrite other extensions' drafts
	}

	providerRequest(e: Any): Any {
		const now = Date.now(), key = modelKey(this.model), last = Math.max(this.lastReqMs, this.branchLastMs);
		const edited = this.nextEdit !== null;
		// the free cache signal: this response's cacheRead against what this request re-sent unchanged, after this gap (same model only)
		this.pending = { gapS: last && (this.lastModelKey || this.prevKey) === key ? (now - last) / 1000 : -1, expect: edited ? this.nextEdit! : this.prevTotal, edited, key };
		this.nextEdit = null;
		this.lastReqMs = now;
		this.lastModelKey = key;
		this.stats.readSavedTokens += this.stats.activeSaved;
		const p: Any = e.payload;
		if (process.env.PI_ZIP_LEDGER && this.cold && !this.wireLedgered && p && Array.isArray(p.messages)) {
			this.wireLedgered = true; // proof that the FIRST request after a cold return is already small (real scale: O + c x the wire's content)
			let tok = 0;
			for (const m of p.messages) if (m?.role !== "system" && m?.role !== "developer") tok += tok4(JSON.stringify(m?.content ?? "")) + 8;
			this.ledger({ type: "cold_wire", tokens: Math.round(sizeOf(this.runPlan?.scale ?? UNIT, tok)), messages: p.messages.length, folds: this.runPlan && !this.runPlan.persisted ? this.runPlan.folds.length : 0, summary: !!this.runPlan?.cut, source: this.runPlan?.source ?? null });
		}
		if (this.off) return undefined; // strict no-op
		const r = repairPayload(p);
		if (!r) return undefined;
		this.ledger({ type: "guard_repair", repaired: r.repaired });
		return r.payload;
	}

	messageEnd(m: Any) {
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") this.lastReqMs = Date.now(); // the response is complete: the entry was refreshed when it finished
		if (m?.role === "user" && this.active()) {
			// the first user message of a run is the prompt; later ones (steering, follow-up) are part of that run's turn. Pi does not mark them, we do.
			if (this.runUserSeen++ > 0 && typeof m.timestamp === "number") this.steerTs.add(m.timestamp);
		}
		const u = m?.usage;
		if (m?.role === "assistant" && u) this.ledger({ type: "usage", stop: m.stopReason, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output });
		if (m?.role === "assistant") this.learn(m);
	}

	/** Regime class, cache survival (persisted) and growth g (this session) from one response's usage. */
	private learn(m: Any) {
		const pend = this.pending, u = m.usage;
		this.pending = null;
		this.justEdited = !!pend?.edited;
		if (!pend || !u || m.stopReason === "error" || m.stopReason === "aborted") return;
		const cr = u.cacheRead ?? 0, cw = u.cacheWrite ?? 0, total = (u.input ?? 0) + cr + cw;
		if (!(total > 0)) return;
		const known = this.entKey === pend.key ? this.ent?.cls : undefined;
		const alive = pend.gapS >= GAP_EDGES[0] ? sample(pend.expect, cr, total, pend.edited, cw > 0 ? "explicit" : known) : null;
		if (pend.gapS >= GAP_EDGES[0]) this.ledger({ type: "cache_sample", gapS: Math.round(pend.gapS), expect: Math.round(pend.expect), cacheRead: cr, total, edited: pend.edited, alive });
		if (alive !== null || !known || (cw > 0 && known !== "explicit")) { // the file is touched only when there is something to learn
			this.ent = record(pend.key, { explicit: cw > 0, total, gapS: pend.gapS, alive });
			this.entKey = pend.key;
		}
		if (!pend.edited && this.prevKey === pend.key && this.prevTotal > 0 && total >= this.prevTotal) {
			const d = total - this.prevTotal;
			this.deltas = [...this.deltas.slice(-19), d];
			const sorted = [...this.deltas].sort((a, b) => a - b);
			this.g = 0.9 * this.g + 0.1 * Math.min(d, sorted[Math.ceil(0.9 * sorted.length) - 1]);
		}
		this.prevTotal = total;
		this.prevKey = pend.key;
	}

	onRecall = (handles: string[], chars: number, entryIds: (string | null)[]) => {
		for (const h of handles) this.recalled.add(h);
		this.stats.recalls += handles.length;
		this.stats.recallChars += chars;
		this.ledger({ type: "recall", handles, chars, entryIds });
	};

	// ---- /zip --------------------------------------------------------------------------------------------------
	private persistState() {
		try {
			this.pi.appendEntry(STATE_CUSTOM, { off: this.off, quiet: this.quiet });
		} catch {}
	}
	/** What this session carries: folds and summaries persisted in its file (they survive restarts) and the recalls in its branch. */
	private totals(ctx: Any) {
		const branch = ctx ? this.branch(ctx) : [];
		const byId = new Map(branch.map((e: Any) => [e?.id, e]));
		let folds = 0, summaries = 0, recalls = 0, usd = 0, key = "";
		let last: Any = null;
		const fileRecalls = new Set<string>(); // tool call ids of built-in reads of recall files (file recall): unzips too
		const byModel = new Map<string, number>(); // chars/4 folded, by the model of the newest response before the fold (the one that planned it)
		for (const e of branch) {
			const ph = String(e?.replacement?.content?.[0]?.text ?? "");
			if (e?.type === "message" && e.message?.role === "assistant" && (e.message.provider || e.message.model)) key = `${e.message.provider ?? ""}/${e.message.model ?? ""}`;
			if (e?.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content))
				for (const c of e.message.content) if (c?.type === "toolCall" && (c.name === "bash" ? commandNamesRecall(c.arguments?.command) : ["read", "grep", "find", "ls"].includes(c.name) && !!parseRecallPath(c.arguments?.path))) fileRecalls.add(c.id);
			if (e?.type === "context_edit" && ph.startsWith(PH_MARK)) {
				folds++;
				byModel.set(key, (byModel.get(key) ?? 0) + Math.max(0, textOf(byId.get(e.targetId)?.message?.content).length - ph.length) / 4);
			} else if (e?.type === "compaction" && e.details?.by === PRODUCT) {
				summaries++;
				usd += Number(e.usage?.cost?.total) || 0;
			} else if (e?.type === "custom" && e.customType === UNUSED_SUMMARY_CUSTOM) usd += Number(e.data?.usd) || 0;
			else if (e?.type === "custom" && e.customType === NOTICE_CUSTOM && e.data?.v === 2 && !e.data?.kind) last = e;
			else if (e?.type === "message" && e.message?.role === "toolResult" && (e.message?.toolName === RECALL_TOOL || fileRecalls.has(e.message?.toolCallId))) recalls++;
		}
		// chars/4 of the folded text, on the provider's scale: x c of the model that folded it (folded outputs are content)
		let folded = 0;
		if (folds) {
			const entries = byModel.size > 1 ? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) : undefined;
			for (const [k, v] of byModel) folded += v * (byModel.size > 1 && k ? this.scaleAt(ctx, entries, k) : this.scaleOf(ctx)).c;
		}
		return { folds, folded, summaries, recalls, usd, last };
	}
	/** What this session carries: folds and summaries persisted in its file (they survive restarts) and the recalls in its branch. */
	private sessionTotals(ctx: Any): string {
		const { folds, folded, summaries, recalls, usd } = this.totals(ctx);
		const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
		return `this session: ${folds} zipped (~${fmtK(folded)} tokens), ${n(summaries, "summary", "summaries")}${usd > 0 ? ` (summary calls $${usd.toFixed(4)})` : ""}, ${n(recalls, "unzip", "unzips")}`;
	}
	/** The /zip status card (rendered by ui.ts renderCard). */
	card(ctx?: Any): CardData {
		const t = this.totals(ctx);
		const model = ctx?.model ?? this.model;
		const key = modelKey(model), ttlS = ttlFor(model) / 1000, ent = key ? loadStats().models[key] : undefined;
		let lifeS = 0;
		for (let g = 30; g <= 7200; g += 30) if (pWarm(ent, g, ttlS).p >= 0.5) lifeS = g;
		const measured = !!ent && ent.n > 0 && pWarm(ent, Math.max(30, lifeS), ttlS).src === "learned";
		const life = key ? (lifeS >= 7200 ? "2 h+" : fmtLife(lifeS || ttlS)) : undefined;
		const alive = key ? Array.from({ length: CHART_COLS }, (_, i) => pWarm(ent, chartGap(i), ttlS).p) : undefined;
		const ts = t.last?.timestamp ? new Date(t.last.timestamp) : null;
		const hhmm = ts && !Number.isNaN(ts.getTime()) ? `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}  ` : "";
		const last = t.last ? `${hhmm}${t.last.data.desc}${t.last.data.why ? " · " + t.last.data.why : ""}` : undefined;
		const file = this.recallMode === "file" && !!this.fileRecall(ctx);
		const state = this.off ? "off" : this.conflict ? "paused" : this.recallMode === "tool" || file ? "on" : "reread-only"; // file recall is a full mode
		return {
			state, stateNote: state === "paused" ? `${this.conflict} also manages context` : state === "off" ? "/zip on to resume" : state === "reread-only" ? "a tool allowlist hides zip_recall · only re-readable outputs fold" : undefined,
			model: key || undefined, life, measured, alive, folds: t.folds, foldedTokens: fmtK(t.folded), summaries: t.summaries, summaryUsd: t.usd, recalls: t.recalls, last, quiet: this.quiet,
			...(file ? { unzip: `from files in ${RECALL_DIR} (a tool allowlist hides zip_recall)` } : {}),
		};
	}
	status(ctx?: Any): string {
		const state = this.off ? "off" : this.conflict ? `paused ("${this.conflict}" also manages context; only the request guard is on)` : "on";
		const key = modelKey(this.model), ttl = ttlFor(this.model), ent = loadStats().models[key];
		const pr = lawPrices(ent?.cls, ttl >= 3_600_000);
		const cache = !key ? "" : `\ncache ${key}: ${pr ? `${pr.cls} (from usage)` : "class unknown until the first response"}` +
			`, ${pr ? `read ${+pr.r.toFixed(4)} / write ${+pr.w.toFixed(4)} / output ${+pr.out.toFixed(4)} x input (class ratios)` : "no prices (legacy rule)"}` +
			`, ${describe(ent, ttl / 1000)}, growth ${(this.g / 1000).toFixed(1)}K/request`;
		return `${PRODUCT}: ${state}, cache TTL ${Math.round(ttl / 1000)} s, ${this.quiet ? "notices off, " : ""}${this.sessionTotals(ctx)}${cache}`;
	}
	statsLine = (ctx?: Any) => `${PRODUCT} ${this.sessionTotals(ctx)} (tokens on the provider's scale, calibrated from this session's usage)`;
	setOff(off: boolean): string {
		this.off = off;
		if (off) { this.runPlan = null; this.runEdits = false; this.cancelTimer(); this.discardBg(); }
		this.persistState();
		return off ? `${PRODUCT}: off. Nothing is folded or summarised and requests are left untouched; earlier folds stay recallable (/zip on to resume)` : `${PRODUCT}: on`;
	}
	toggleQuiet(): string {
		this.quiet = !this.quiet;
		this.persistState();
		return `${PRODUCT}: per-turn notices ${this.quiet ? "off" : "on"} (folding continues)`;
	}
}
