// The per-session shell behind index.ts: Pi's events, the run plan (F8) and the warm valve (F10) carried out and persisted at
// turn_end, settle preparation and the away-timer for the summary (F12). The decisions themselves are pure functions in core.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lastMessageMs, lastPrompt, modelKey, payloadRetention, refused, ttlFor } from "./cache.ts";
import { agentDir, curve, describe, lawPrices, loadStats, pWarm, record, sample, statsPath, GAP_EDGES, type Entry } from "./learn.ts";
import { repairPayload } from "./guard.ts";
import { adopt, checkEdits, clock, decideRun, inRunClock, decideSettle, decideTurnEnd, grow, headOf, lastRegrow, planOpts, readyOf, runPlanOf, scaleOf, summarizedSince, unusedOf, valvePlanOf, SUMMARY_CUSTOM, type Artifact, type Avail, type Env, type Learned } from "./core.ts";
import { fmtK, Stats, noticeDesc, noticeText, type NoticeAction, type NoticeData, type ZipControl } from "./notice.ts";
import { applyPlanToMessages, buildBlocks, countUserTurns, G0, keepRecentTokensFor, piCanCompact, planContext, reserveTokensFor, sizeOf, UNIT, type Block, type Cut, type FoldTarget, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import { handleFor, PH_MARK, RECALL_TOOL } from "./placeholder.ts";
import { branchOutputs, recalledHandlesFromBranch, resolveHandlesInBranch } from "./recall.ts";
import { cleanupRecall, commandNamesRecall, fileRecallFor, materialize, parseRecallPath, recallRoot, recallRootShown, rewriteCommand, sidDir, type FileRecall } from "./recallfile.ts";
import { buildCut } from "./summary.ts";
import { type Any, COMMIT_CUSTOM, envInt, isKeystroke, PRODUCT, textOf, tok4 } from "./util.ts";
import { replayGrowth } from "./state.ts";
import { fmtLife, type CardData, type ChartBin, type StateWord } from "./ui.ts";

export const PLAN_CUSTOM = "pi-zip/plan";
export const STATE_CUSTOM = "pi-zip/state";
export const STEER_CUSTOM = "pi-zip/steer";
const fmtAway = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(Math.round(s / 360) / 10).toFixed(1)} h`);
export const NOTICE_CUSTOM = "pi-zip/notice"; // a fold/summary notice kept in the transcript (rendered by index.ts, never sent to the model)
export { checkEdits, SUMMARY_CUSTOM };
/** Written by 0.3.x for a background summary nobody adopted: still read, so the totals of an older session stay honest. */
const LEGACY_UNUSED_CUSTOM = "pi-zip/unused-summary";
export const AWAY_FRACTION = 0.8; // the away-timer fires this far into the cache lifetime
/** Pi's idle cache warmer decides before each refresh at 0.9 x TTL, at least 10 s before expiry (core/cache-warmer.js getCacheWarmingDelayMs);
 *  undefined: a lifetime of 10 s or less, which Pi never warms. */
export const warmingDelayMs = (ttlMs: number): number | undefined => (ttlMs <= 10_000 ? undefined : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000))));
/** How long after a due warming decision pi-zip concludes that none is coming (15 s at a 5-minute TTL). */
const warmingMargin = (ttlMs: number): number => Math.max(1_000, Math.min(15_000, 0.05 * ttlMs));
/** A refresh lands this soon after a "warm" decision (it is one tiny request): 10 s at a 5-minute TTL. */
const warmCheckMs = (ttlMs: number): number => Math.min(10_000, ttlMs / 8);
// Other context managers rewrite the view too (F14); two writers give unpredictable results, so we pause and keep only the Guard.
const CONFLICT_RE = /billion-context|bc-pi|magic-context|smart-compact|hot-compact|context-prune|pi-vcc|context-mode|prefix-cache/i;

/** The summary call in flight in the background (the user away, or working on while it is written): at most one. It has its own
 *  AbortController: no run owns it. When it ends with a summary, that summary is recorded (a pi-zip/summary entry, Artifact) and is
 *  ready for any plan whose cut is not shallower (core.ts adopt); the call itself is gone. */
interface Bg {
	key: string; // firstKeptEntryId of the cut it is written for
	head: string; // the head of the projection it reads (core.ts headOf)
	aborted: boolean;
	promise: Promise<Cut | null>;
	controller: AbortController;
	estUsd: number; // what the call is billed for its input if it is aborted after the provider took it: the prefix it reads, uncached
}

const errText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
/** A compaction another extension supplied (through session_before_compact): not Pi's own summary, not pi-zip's. */
const foreignCompaction = (e: Any): boolean => e?.type === "compaction" && !!e.fromHook && e.details?.by !== PRODUCT;

/** pi-zip's own compaction takes milliseconds: the summary is done. Pi runs every extension's session_before_compact handler for it, so
 *  one that is not finished by this deadline has another handler at work (writing its own summary, say): pi-zip cancels it then, so it
 *  can never land during the run, and the draft path takes the summary. */
const nativeDeadlineMs = () => envInt("NATIVE_MS", 2_000);
/** A compaction slower than this (or half the deadline) had another handler at work too: the native path ends for the process, so its
 *  work (a model call, say) is not paid for, and waited for, at every cold return. */
const NATIVE_SLOW_MS = 250;
/** The customInstructions pi-zip passes on its own ctx.compact() (Pi hands them to every session_before_compact handler as
 *  event.customInstructions). A handler that supplies its own summaries for every compaction (a model call, say) should return undefined
 *  when event.customInstructions starts with this: pi-zip answers this one itself, and its summary is already written. pi-zip answers or
 *  cancels every compaction that carries it, so Pi's default summariser never receives it as an instruction. */
export const NATIVE_MARKER = "[pi-zip native compaction: handlers of session_before_compact return undefined, pi-zip answers this one]";

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
	private reqMsBefore = 0; // the clock before the request in flight started: what a refused request gives back
	private lastModelKey = ""; // provider/model of the newest request: a cache entry belongs to one model
	private settleIds: string[] = []; // entries the settle plan folded: only used to label a plan as prepared
	private bg: Bg | null = null;
	private mine: Artifact[] = []; // the pi-zip/summary records this process made (the branch has them once written)
	private unwritten: Artifact[] = []; // ... made inside a run: written as drafts at its next turn_end or at settle
	private inRun = false; // from the start of a run to its settle (or agent_end)
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
	private pause = false; // this run is a return after a pause or a model switch (the previous user turn's re-readables may fold: plan.ts PlanOpts.pause)
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
	private nativeAsk: { compaction: Any | null; answered: boolean; askedAt: number; askedWall: number; until: number } | null = null;
	/** What became of the native path for this run, for the notice (the session file alone says why a summary went the draft way). */
	private nativeNote: { native: string; ms?: number; askMs?: number } | null = null;
	// the native path ended for this process, and why: another extension took part in pi-zip's compaction (answered, cancelled or
	// replaced it, or took its time), or Pi's compaction failed. Summaries then ride along with the first request (the draft path).
	private nativeOff: string | null = null;
	// this run's return went in through another extension's compaction (it answered pi-zip's): the run plan adds no summary on top of
	// it (folds only, a summary only at Pi's compaction room), and the summary prepared for the context it replaced is discarded
	private foreignRun = false;
	// this run's away summary went in through Pi's compaction before the run: the projection just before it, for the run plan (I1)
	private nativeRun: { key: string; cut: Cut; before: number; after: number; pre: Any[]; entryId: string } | null = null;
	// the cache tier (PI_CACHE_RETENTION) of the current model's requests: the payload of its newest request when seen, else the
	// provider-scoped env resolved once per run (research pi-tricks §3.1); null = nothing known, the process env decides (cache.ts)
	private retention: { key: string; tier: "short" | "long"; src: "env" | "provider env" | "payload" } | null = null;

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
	/** A summary was persisted since the last cold run start: later warm plans make none unless at the compaction room, or until the
	 *  context has grown back to the size that summary started from (`summaryRegrow`, real tokens after folds; plan.ts regrowAt). */
	summarizedWarm = false;
	summaryRegrow: number | undefined = undefined;
	setRecallMode(mode: "tool" | "file" | "reread", tools: { read: boolean; grep: boolean; bash: boolean }, ctx?: Any) {
		if (mode !== this.recallMode) this.ledger({ type: "recall_available", ok: mode === "tool", mode, ...tools });
		this.recallMode = mode;
		this.recallTools = tools;
		if (!ctx) return;
		if (mode === "file" && this.fileRecall(ctx)) this.stateLine(ctx, "on", `a tool allowlist hides zip_recall · zipped outputs are read back from files in ${recallRootShown()}`, true, "on:file");
		else if (mode === "file") this.stateLine(ctx, "reread-only", "a tool allowlist hides zip_recall · only re-readable outputs fold · no session file (--no-session), so no recall copies are written either", true, "reread-only:no-session");
		else if (mode !== "tool") this.stateLine(ctx, "reread-only", "a tool allowlist hides zip_recall · only re-readable outputs fold · allow zip_recall, read, grep or bash to fold more");
	}
	/** The recall files this session's placeholders name; undefined outside file mode, and without a session file (`--no-session`: the
	 *  outputs are in no file, so none is written for them either): then only re-readable outputs fold. */
	private fileRecall(ctx: Any): FileRecall | undefined {
		if (this.recallMode !== "file") return undefined;
		const sid = this.recallSid(ctx);
		return sid ? fileRecallFor(sid, this.recallTools) : undefined;
	}
	/** The session id recall copies are written under: none without a session file (`pi --no-session` keeps the session in memory). */
	private recallSid(ctx: Any): string {
		try {
			return typeof ctx?.sessionManager?.getSessionFile?.() === "string" ? this.sessionId(ctx) : "";
		} catch {
			return "";
		}
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

	// ---- the real size of the request that carried a plan (notices, research pi-tricks §3.4) ---------------------------------------
	private liveCtx: Any = null; // the newest handler context: its sessionManager resolves to the current session at call time
	private realMemo = new Map<number, { real: number | undefined } | { n: number }>();
	/** input + cacheRead + cacheWrite of the first assistant message stamped at or after reqTs (errors and aborts skipped): the request
	 *  that carried the plan. undefined until that response exists (the notice keeps its estimate); 0 when it reports no usage. A user
	 *  message stamped after reqTs before it ends the search for good: what follows answers a later run (a valve plan committed at a run's
	 *  last turn_end, a plan whose request failed), so the estimate stays. The run's own prompt is stamped before reqTs (its millisecond at
	 *  the latest). A found value is kept; a miss is looked at again only when the session has grown. */
	realSizeAfter(reqTs: number): number | undefined {
		const memo = this.realMemo.get(reqTs);
		if (memo && "real" in memo) return memo.real;
		let sm: Any = null, n = -1;
		try {
			sm = this.liveCtx?.sessionManager;
			n = typeof sm?.getEntryCount === "function" ? sm.getEntryCount() : -1;
		} catch {
			return undefined;
		}
		if (memo && n >= 0 && memo.n === n) return undefined;
		let branch: Any[] = [];
		try {
			branch = sm?.getBranch?.() ?? [];
		} catch {}
		for (const e of branch) {
			const m = e?.type === "message" ? e.message : null;
			if (m?.role === "user" && Number(m.timestamp) > reqTs) {
				this.realMemo.set(reqTs, { real: undefined }); // a later prompt came first: no response can be this plan's any more
				return undefined;
			}
			if (m?.role !== "assistant" || !(Number(m.timestamp) >= reqTs) || m.stopReason === "error" || m.stopReason === "aborted") continue;
			const u = m.usage, real = u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
			this.realMemo.set(reqTs, { real });
			return real;
		}
		this.realMemo.set(reqTs, { n });
		return undefined;
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
		const ttl = ttlFor(ctx.model ?? this.model, [], this.tier(ctx.model ?? this.model));
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

	/** The cache tier of `model`'s requests, when known (see `retention`). */
	private tier(model?: Any): "short" | "long" | undefined {
		const r = this.retention;
		return r && r.key === modelKey(model ?? this.model) ? r.tier : undefined;
	}
	/** Once per run: PI_CACHE_RETENTION as Pi resolves it for this model's provider (the credential's env in auth.json first, then the
	 *  process env). A tier read from this model's newest request payload is the truth about that request and stays. */
	private async resolveRetention(ctx: Any): Promise<void> {
		const key = modelKey(ctx?.model);
		if (!key || (this.retention?.key === key && this.retention.src === "payload")) return;
		let scoped: string | undefined;
		try {
			const r = await ctx?.modelRegistry?.getApiKeyAndHeaders?.(ctx.model);
			const v = r?.env?.PI_CACHE_RETENTION;
			if (typeof v === "string" && v) scoped = v;
		} catch {}
		const v = scoped ?? process.env.PI_CACHE_RETENTION;
		const next = { key, tier: v === "long" ? ("long" as const) : ("short" as const), src: scoped ? ("provider env" as const) : ("env" as const) };
		if (next.tier !== this.retention?.tier || next.key !== this.retention?.key || next.src !== this.retention?.src) this.ledger({ type: "retention", ...next });
		this.retention = next;
	}

	/** The token scale (O, c) read from the branch: stateless, so a fresh process calibrates exactly like a long-lived one. */
	scaleOf(ctx: Any, entries?: Any[]): Scale {
		try {
			return scaleOf(entries ?? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []), this.branch(ctx), this.sysInfo(ctx), ctx?.model ? modelKey(ctx.model) : undefined);
		} catch {
			return UNIT;
		}
	}

	/** The token scale of model `key` ("provider/id"), read from the branch. */
	private scaleAt(ctx: Any, entries: Any[] | undefined, key: string): Scale {
		return scaleOf(entries ?? [], this.branch(ctx), this.sysInfo(ctx), key);
	}

	/** What the planner reads of Pi besides the branch (core.ts Env). */
	private env(ctx: Any): Env {
		const fileRecall = this.fileRecall(ctx);
		const rereadOnly = this.recallMode === "reread" || (this.recallMode === "file" && !fileRecall);
		return { model: ctx?.model, cwd: (ctx?.cwd as string) ?? process.cwd(), sys: this.sysInfo(ctx), reserve: this.reserve(ctx), recalled: this.recalled, steerIds: this.steerIds, rereadOnly, ...(fileRecall ? { fileRecall } : {}) };
	}
	/** Λ for the model of `ctx` (core.ts Learned): its learned entry once loaded (loadEnt), its tier, growth and the session facts. */
	private lam(ctx: Any): Learned {
		const m = ctx?.model ?? this.model;
		return { model: m, ent: this.entKey === modelKey(m) ? this.ent : undefined, tier: this.tier(m), g: this.g, justEdited: this.justEdited, summarizedWarm: this.summarizedWarm, summaryRegrow: this.summaryRegrow };
	}

	/** Plan options at P(warm) `pWarm`, after a pause or not, with the token scale read from the branch (core.ts planOpts). */
	private opts(ctx: Any, pending: boolean, entries: Any[], pWarm: number, pause: boolean, cutAt?: string, foldsOnly = false, ready?: readonly string[]): { o: PlanOpts; cal: Scale } {
		return planOpts(entries, this.branch(ctx), this.env(ctx), this.lam(ctx), pending, pWarm, pause, cutAt, foldsOnly, ready);
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
			type: "law", where, g: Math.round(l.g), pWarm: rd(l.pWarm), survSrc: where === "run" ? this.survSrc : "in-run", cls: pr.cls, wr: rd(pr.w / pr.r), prSrc: pr.src,
			steps: (o.trace ?? []).map((t) => ({ at: t.where, ok: t.ok, B: Math.round(t.B), A: Math.round(t.A), T: Math.round(t.T), ...(t.Tsuf !== undefined ? { Tsuf: Math.round(t.Tsuf) } : {}), phi: rd(t.phi), K: rd(t.K), eta: rd(t.eta) })),
		});
	}

	/** Ledger only (research pi-tricks §3.5): entries another context manager wrote into this branch, each logged once: a context_edit
	 *  that is neither pi-zip's placeholder nor Pi's own omission (null), or a compaction an extension other than pi-zip supplied.
	 *  Nothing is decided from it. */
	private foreignSeen = new Set<string>();
	private logForeign(ctx: Any, where: string) {
		if (!process.env.PI_ZIP_LEDGER || this.off) return; // the ledger is the only reader
		for (const e of this.branch(ctx)) {
			if (typeof e?.id !== "string" || this.foreignSeen.has(e.id)) continue;
			let rec: Record<string, unknown> | null = null;
			if (e.type === "context_edit" && e.replacement != null) {
				const text = textOf(e.replacement.content);
				if (!text.startsWith(PH_MARK)) rec = { kind: "context_edit", targetId: e.targetId ?? null, chars: text.length, head: text.slice(0, 60) };
			} else if (foreignCompaction(e)) rec = { kind: "compaction", by: e.details?.by ?? null, firstKeptEntryId: e.firstKeptEntryId ?? null, chars: String(e.summary ?? "").length };
			if (!rec) continue;
			this.foreignSeen.add(e.id);
			this.ledger({ type: "foreign_edit", where, id: e.id, ...rec });
		}
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
		this.liveCtx = ctx;
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
		this.restoreState(branch);
		this.detectConflict(ctx);
		let recallFilesRemoved = 0;
		try {
			recallFilesRemoved = cleanupRecall(); // recall copies older than 14 days (they can be written again from the session)
		} catch {}
		this.ledger({ type: "session_start", off: this.off, quiet: this.quiet, conflict: this.conflict, ...(recallFilesRemoved ? { recallFilesRemoved } : {}) });
	}

	/** A resumed (or restarted, reloaded, forked) process arms the away timer from the branch's last request, as `settle` would have after
	 *  it (formal TRIAGE (a) 7): the summary for the next cold return is prepared while the user is away, not while they wait. Only when
	 *  the session ended on a finished response (a run cut off mid-tool has no settle point) and the plan for it has a cut. Called after
	 *  the recall mode is known (it decides which outputs fold, so which plan the return will make). */
	resumeAway(ctx: Any) {
		try {
			const branch = this.branch(ctx);
			if (!this.active() || !ctx?.hasUI || !ctx?.model) return;
			const last = [...branch].reverse().find((en: Any) => en?.type === "message" && en.message);
			const m = last?.message;
			if (m?.role !== "assistant" || m.stopReason === "toolUse") return;
			const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
			if (!entries.length) return;
			this.loadEnt(modelKey(ctx.model));
			const { o } = this.opts(ctx, true, entries, 0, true);
			const p = planContext(entries, o);
			const now = this.judgeNow(ctx, branch);
			let delayMs: number | null = null;
			if (p && p.cutIdx !== null) {
				const at = lastMessageMs(branch);
				// only while the cache the session left is not yet dead (a restart between the 0.8 mark and the TTL starts the call at once, as
				// the live process's timer would have already): a session left longer than that returns cold, and the run plan of its next
				// prompt handles it. Opening or /resuming an old session to browse it must not start a paid summary call.
				delayMs = this.scheduleSummary(p, ctx, at || undefined, true);
				this.ledger({ type: "away_resumed", timerMs: delayMs, lastRequestMs: at });
			}
			// the cache is already dead: opening the session costs nothing, but a prompt being typed says the user is here to work, and that
			// prompt's plan wants exactly this summary; start it then so the typing time is not wasted. Only when the prompt itself will
			// judge the return cold (learned survival, as beginRun): a cache that outlives its declared TTL gets a warm return, whose plan
			// would throw a summary started here away.
			if (delayMs !== null && delayMs < 0 && now.cold) this.armOnFirstKey(ctx);
			// rule A after a restart: the cache is still alive and the warm return would summarise. The live process started that summary
			// when the run ended; a reopened one starts it on the first key of a prompt (opening and closing the session costs nothing)
			else if (!now.cold && this.warmCutNow(ctx, entries, now)) this.armOnFirstKey(ctx);
		} catch (err) {
			this.ledger({ type: "error", where: "resume_away", error: errText(err) });
		}
	}

	/** What a process that never left would know: growth g, "the newest response carried an edit" and "a summary was made in this warm
	 *  stretch" are functions of the session, rebuilt from the branch (state.ts; a restart, a resume or a fork plans like the live process),
	 *  and so are the summaries produced in the background (pi-zip/summary entries, read where they are used). */
	private restoreState(branch: Any[]) {
		try {
			const r = replayGrowth(branch, G0);
			this.g = r.g;
			this.deltas = r.deltas;
			this.justEdited = r.justEdited;
			const models = loadStats().models, tierOf = (m: Any) => this.tier(m);
			this.summarizedWarm = summarizedSince(branch, this.steerIds, models, tierOf);
			this.summaryRegrow = this.summarizedWarm ? lastRegrow(branch) : undefined;
			const ready = readyOf(branch).length;
			if (branch.length) this.ledger({ type: "state_restored", g: Math.round(this.g), justEdited: this.justEdited, summarizedWarm: this.summarizedWarm, ...(ready ? { ready } : {}) });
		} catch (err) {
			this.ledger({ type: "error", where: "restore_state", error: errText(err) });
		}
	}

	// ---- recall through files (research pi-tricks §2) -----------------------------------------------------------------------
	/** This machine's directory for this session's recall files. */
	private localRecallDir(ctx: Any): string | null {
		const sid = this.recallSid(ctx);
		return sid ? join(recallRoot(), sidDir(sid)) : null;
	}
	/** Write the originals of these handles (from the current branch) if they are not on disk as they are: their local paths. */
	private materializeHandles(ctx: Any, handles: string[]): Map<string, string> {
		const sid = this.recallSid(ctx);
		if (!sid || !handles.length) return new Map();
		const { items } = resolveHandlesInBranch(this.branch(ctx), handles);
		const found = items.filter((it): it is typeof it & { text: string } => it.text !== null);
		const out = materialize(recallRoot(), sid, found.map((it) => ({ handle: it.handle, text: it.text })));
		this.ledger({ type: "recall_file", handles: found.map((it) => it.handle), missing: handles.length - found.length, chars: found.reduce((a, it) => a + it.text.length, 0) });
		return out;
	}
	/** Every output this session's model no longer sees in full (folded, or summarised away): what a grep, ls or find over the directory needs. */
	private materializeAll(ctx: Any): string | null {
		const sid = this.recallSid(ctx);
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
		this.disarmKey();
		this.cancelTimer();
		// a call still running is lost with the process: aborted, recorded as one unused call at the input it is billed for (a restarted
		// process decides without it, as without any summary in flight); finished summaries are in the session already, or written now
		this.discardBg("shutdown");
		this.writeUnwritten();
	}

	/** True from before_agent_start to the agent_start that follows it: that run's start has been handled (Pi's prompt() path). A run started
	 *  by an extension's message (sendMessage with triggerTurn: pi-runway's owed-drive, durable-subagents' attention) emits agent_start only. */
	private startHandled = false;
	private starting: Promise<void> | null = null;

	async beforeAgentStart(ctx: Any, e?: Any): Promise<void> {
		this.startHandled = true;
		await this.beginRun(ctx, e, true);
	}

	/** agent_start: handled already by before_agent_start (a prompt), else a run an extension's message started: the same start-of-run
	 *  handling, minus Pi's compaction (ctx.compact() aborts the run that is starting): the prepared summary is adopted by the run plan. */
	async agentStart(ctx: Any): Promise<void> {
		if (this.startHandled) {
			this.startHandled = false;
			this.promptStart = true; // its first message says whether it really is the prompt's run (messageEnd)
			return;
		}
		await this.drivenStart(ctx);
	}

	private drivenStart(ctx: Any): Promise<void> {
		this.starting = this.beginRun(ctx, undefined, false)
			.catch((err) => this.ledger({ type: "error", where: "agent_start", error: errText(err) }))
			.then(() => {
				this.runUserSeen = 1; // no prompt in this run: a user message that comes later is steering
				this.ledger({ type: "driven_run" });
			});
		return this.starting;
	}

	/** Set at an agent_start taken for the prompt's run: before_agent_start fired, but a prompt can still fail before its run starts (Pi's
	 *  image normalisation), and then the next agent_start belongs to a run an extension's message starts. A prompt's run begins with
	 *  the user message; a driven run with the custom message: seen at that first message_end, before the run's first request. */
	private promptStart = false;

	agentEnd() {
		this.startHandled = false;
		this.promptStart = false;
		this.inRun = false;
		this.writeUnwritten();
	}

	private async beginRun(ctx: Any, e: Any, viaPrompt: boolean): Promise<void> {
		this.liveCtx = ctx;
		this.inRun = true;
		this.cancelTimer(); // the user is back: nothing is started behind their back any more
		this.disarmKey();
		this.model = ctx?.model;
		this.cold = false;
		this.pause = false;
		this.runChecked = true;
		this.runEdits = false;
		this.runPlan = null;
		this.nativeRun = null;
		this.foreignRun = false;
		this.settleIds = [];
		this.wireLedgered = false;
		this.runUserSeen = 0;
		this.logForeign(ctx, "run");
		if (!this.active()) return;
		this.detectConflict(ctx);
		if (!this.active()) return;
		const branch = this.branch(ctx);
		const key = modelKey(ctx.model);
		this.loadEnt(key);
		this.branchLastMs = lastMessageMs(branch);
		if (!this.prevKey) ({ key: this.prevKey, total: this.prevTotal } = lastPrompt(branch)); // fresh process: the session's newest response
		await this.resolveRetention(ctx);
		const { cold, reason, ttl, pWarm: p, src, gapS, pause } = clock(branch, { model: ctx.model, ent: this.ent, tier: this.tier(ctx.model) }, Date.now(), { reqMs: this.lastReqMs, modelKey: this.lastModelKey });
		this.cold = cold;
		if (cold) {
			this.summarizedWarm = false; // a cold return may summarise again
			this.summaryRegrow = undefined;
		}
		this.pause = pause;
		this.pWarm = p;
		this.survSrc = src;
		this.runChecked = false; // the first request decides (cold: the cold plan; warm: only above the cap, if the law fires)
		this.coldReason = reason;
		this.coldWhy = src === "model switch" ? "cache cold · model switched" : cold && gapS !== null ? `cache cold · away ${fmtAway(gapS)}` : ""; // the warm form says "cache warm · worth it at this size"
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
		this.nativeNote = null;
		const ready = readyOf(branch, this.mine).length > 0;
		if ((ready || this.bg) && !viaPrompt) this.nativeNote = { native: "run started by an extension's message: draft path (compact() would abort it)" };
		else if (cold && this.bg && !ready) this.nativeNote = { native: "summary not finished when the prompt came" };
		// a summary written in the background goes in through Pi's compaction, cold return or warm: one place, before the prompt,
		// with pi-zip's own size before
		if (ready && viaPrompt) {
			try {
				await this.nativeSummary(ctx, e);
			} catch (err) {
				const a = this.nativeAsk;
				if (a && !a.answered) a.compaction = null; // a late ask of pi-zip's compaction is cancelled, never left to Pi's own summary
				this.ledger({ type: "error", where: "native_summary", error: errText(err) });
			}
		}
	}

	/** session_before_compact: answers ONLY the compaction pi-zip itself asked for a moment ago (nativeAsk): its own summary and its own
	 *  tokensBefore. Pi's threshold and overflow compactions, /compact and other extensions' compactions get undefined and run untouched.
	 *  Once pi-zip has given up on its compaction (compaction null), a late ask of it is cancelled, never one with a live signal: that is
	 *  another compaction (pi-zip's own was aborted). */
	sessionBeforeCompact(e?: Any): Any {
		const a = this.nativeAsk;
		if (typeof e?.customInstructions === "string" && e.customInstructions.startsWith(NATIVE_MARKER)) {
			// pi-zip's own compaction: answered, once, while its ask is open; cancelled otherwise (never left to Pi's default summariser, which
			// would write a summary of the whole transcript with the marker as its instruction)
			if (a && !a.answered && a.compaction && Date.now() <= a.until) {
				a.answered = true;
				a.askedAt = performance.now();
				a.askedWall = Date.now();
				return { compaction: a.compaction };
			}
			if (a && !a.answered) {
				a.answered = true;
				a.askedAt = performance.now();
				a.askedWall = Date.now();
			}
			return { cancel: true };
		}
		if (!a || a.answered || Date.now() > a.until) return undefined;
		if (e?.reason !== undefined && e.reason !== "manual") return undefined; // ctx.compact() is a manual compaction
		if (!a.compaction && e?.signal && e.signal.aborted !== true) return undefined;
		a.answered = true;
		a.askedAt = performance.now();
		a.askedWall = Date.now();
		return a.compaction ? { compaction: a.compaction } : { cancel: true };
	}

	/** The native path ends for the rest of the process (logged once): from now on summaries ride along with the first request. */
	private endNative(reason: string) {
		if (this.nativeOff) return;
		this.nativeOff = reason;
		this.ledger({ type: "native_off", reason });
	}

	/** Why Pi's own compaction cannot take this summary now (null: it can). Each reason keeps today's path: the run plan carries the summary
	 *  request-locally and turn_end persists it as a draft. */
	private nativeGate(ctx: Any, branch: Any[], pre: Any[]): string | null {
		if (this.nativeOff) return "off for this process";
		if (typeof ctx?.compact !== "function") return "no ctx.compact";
		if (typeof ctx?.abort !== "function") return "no ctx.abort"; // what cancels a compaction another handler holds up
		// another extension supplies compactions in this session: its session_before_compact handler would run for pi-zip's too
		if (branch.some(foreignCompaction)) return "another extension's compaction is in this branch";
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
	 * Pi runs every extension's session_before_compact handler for it (the last answer wins, a cancel stops it): unless pi-zip's own
	 * entry is the one that went in, fast, the native path ends for the process (endNative). A compaction not finished by the deadline
	 * is cancelled first, and a summary prepared for a context another extension's compaction has replaced is never used (its head is gone).
	 */
	private async nativeSummary(ctx: Any, e: Any): Promise<void> {
		const branch = this.branch(ctx);
		const pre = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		const skip = (reason: string) => {
			this.nativeNote = { native: reason };
			this.ledger({ type: "native_skip", reason });
		};
		// a warm return right after a request that carried an edit makes none (b2b): the run plan would not adopt it either
		if (!this.cold && this.justEdited) return skip("a warm return right after an edited request makes no edit (b2b)");
		// the plan the first request will make: the same one (cold or warm, cutting where a produced summary cuts if it is not deeper and
		// the law accepts that: computeRunPlan adopts it the same way), with the prompt Pi is about to append
		const pending = pendingPrompt(e);
		const entries = pending ? [...pre, pending] : pre;
		const mk = (cutAt?: string) => {
			const { o } = this.opts(ctx, !pending, entries, this.pWarm, this.pause, cutAt);
			return { p: planContext(entries, o) };
		};
		const p = this.adopted(mk(), mk, "native", this.ready(branch)).p;
		const art = p && p.cutIdx !== null ? readyOf(branch, this.mine).find((a) => a.key === p.firstKeptEntryId) : undefined;
		if (!p || !art?.cut) return skip(!p || p.cutIdx === null ? "the summary does not fit this plan: the plan at the prompt has no cut" : this.bg?.key === p.firstKeptEntryId ? "summary not finished when the prompt came" : "the summary does not fit this plan: the plan at the prompt cuts elsewhere");
		const cut = art.cut;
		if (checkEdits(p.blocks, p.userTurns, p.folds, cut)) return skip("guard");
		const gate = this.nativeGate(ctx, branch, pre);
		if (gate) return skip(gate);
		const before = Math.round(p.ctxTokens);
		const regrow = Math.round(p.ctxAfterFolds); // the context this summary starts from (folds applied): see summaryRegrow
		const trigger: Cut["trigger"] = this.cold ? "cold" : "valve"; // the return that adopts it labels it (written early for a warm one, say)
		const compaction = { summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: before, details: { by: PRODUCT, via: "native", trigger, regrow }, usage: cut.usage };
		const known = new Set(branch.map((en: Any) => en?.id));
		const ask = { compaction: compaction as Any | null, answered: false, askedAt: 0, askedWall: 0, until: Infinity };
		this.nativeAsk = ask;
		const deadline = nativeDeadlineMs(), t0 = performance.now();
		const res = await new Promise<{ ok: boolean; err?: string; late?: boolean }>((resolve) => {
			let settled = false;
			const finish = (r: { ok: boolean; err?: string; late?: boolean }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(r);
			};
			const timer = setTimeout(() => {
				if (!ask.answered) ask.compaction = null; // asked after this, pi-zip cancels: never Pi's own summary on pi-zip's behalf
				ask.until = Date.now() + 60_000;
				finish({ ok: false, late: true });
			}, deadline);
			timer.unref?.();
			const done = (r: { ok: boolean; err?: string }) => {
				if (this.nativeAsk === ask) this.nativeAsk = null; // pi-zip's compaction is over: nothing is answered for it any more
				finish(r);
			};
			try {
				ctx.compact({ customInstructions: NATIVE_MARKER, onComplete: () => done({ ok: true }), onError: (err: Any) => done({ ok: false, err: err instanceof Error ? err.message : String(err) }) });
			} catch (err) {
				done({ ok: false, err: errText(err) });
			}
		});
		const ms = Math.round(performance.now() - t0), askMs = ask.askedAt ? Math.round(ask.askedAt - t0) : null;
		// what went in: compactions added since the call (pi-zip's is the one carrying its summary; Pi keeps the last handler's answer)
		const added = this.branch(ctx).filter((en: Any) => en?.type === "compaction" && !known.has(en?.id));
		const last = added[added.length - 1] ?? null;
		const entry = last && last.summary === cut.text ? last : null;
		// still pending at the deadline: cancel it now, before the run starts (Pi checks its abort signal right before it appends)
		if (res.late && !last) {
			try {
				ctx.abort?.();
			} catch {}
		}
		// "another handler at work" is measured over the time other handlers can occupy: before ours (askMs) and, for handlers after ours, from
		// our answer to the entry's own append (appendCompaction stamps it). Pi's work after the append (the refresh of its context, the
		// projection and token estimate, session_compact, compaction_end and the chat rebuild) grows with the branch and is nobody's handler:
		// on a 500K-token branch it alone can pass 250 ms.
		const appendedAt = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
		const handlerMs = entry && askMs !== null ? askMs + (Number.isFinite(appendedAt) && ask.askedWall ? Math.max(0, appendedAt - ask.askedWall) : 0) : ms;
		const off = entry
			? added.length > 1 ? "another compaction went in as well" : handlerMs > Math.min(NATIVE_SLOW_MS, deadline / 2) ? `Pi's compaction spent ${handlerMs} ms in session_before_compact handlers: another handler at work` : null
			: last ? "another extension's compaction went in instead of pi-zip's"
			: res.late ? (ask.answered ? `Pi's compaction was not done ${deadline} ms after pi-zip answered (cancelled)` : `another session_before_compact handler ran before pi-zip's (cancelled after ${deadline} ms)`)
			: `Pi's compaction failed: ${res.err ?? "no compaction entry"}`;
		if (off) this.endNative(off);
		this.nativeNote = { native: entry && !off ? "ok" : (off ?? "failed"), ms, ...(askMs !== null ? { askMs } : {}) };
		if (!entry?.id) {
			this.ledger({ type: "native_fail", ms, askMs, handlerMs, answered: ask.answered, error: res.late ? "deadline" : (res.err ?? "no compaction entry"), foreign: !!last });
			if (last) {
				// another extension's compaction replaced the context this summary was written for: adopting it, or writing a new one on
				// top of it, would summarise twice. It is this stretch's summary (summarizedWarm, as after a pi-zip summary).
				this.discardBg("replaced");
				this.foreignRun = true;
				this.summarizedWarm = true;
				this.summaryRegrow = undefined; // its size is not known: this stretch ends at the next cold return
			}
			return; // nothing went in: the draft path, the run plan adopts the prepared summary as before
		}
		this.summarizedWarm = true; // one summary per warm stretch, as for a draft (commit)
		this.summaryRegrow = regrow;
		// the summary is in the session from now on, whatever the run does: book it here (commit() does not book it again), the way a
		// draft of the same kind is booked: a cold return's saves a rewrite, a warm one is a valve edit of the warm cache
		const cutSaved = Math.round(p.scale.c * (cut.prefixTokens - cut.summaryTokens));
		this.nativeRun = { key: art.key, cut, before, after: Math.round(p.ctxAfterFolds - cutSaved), pre, entryId: entry.id };
		const s = this.stats;
		s.summaries++;
		s.summarizedTokens += cutSaved;
		s.activeSaved += cutSaved;
		if (this.cold) s.writeSavedTokens += cutSaved;
		else {
			s.pressureEdits++;
			s.pressureRewriteTokens += before;
		}
		this.ledger({ type: "summary", via: "native", handlerMs, trigger, source: this.cold ? "settle" : "valve", count: cut.count, tokensBefore: before, prefixTokens: Math.round(p.scale.c * cut.prefixTokens), summaryTokens: Math.round(p.scale.c * cut.summaryTokens), ms: cut.ms, compactMs: ms, askMs, waitedMs: 0, llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
	}

	/** The unsubscribe of the first-keystroke listener (resumeAway), null when none is armed. */
	private keyOff: (() => void) | null = null;
	private disarmKey() {
		const off = this.keyOff;
		this.keyOff = null;
		try {
			off?.();
		} catch {}
	}

	/** The return a prompt typed now would be, judged as beginRun judges it (learned survival, the request's tier). */
	private judgeNow(ctx: Any, branch: Any[]): { cold: boolean; pWarm: number; pause: boolean } {
		this.loadEnt(modelKey(ctx.model));
		const d = clock(branch, { model: ctx.model, ent: this.ent, tier: this.tier(ctx.model) }, Date.now(), { reqMs: this.lastReqMs, modelKey: this.lastModelKey });
		return { cold: d.cold, pWarm: d.pWarm, pause: d.pause };
	}

	/** The plan a warm prompt typed now would make, when it summarises (null: it makes none, or no edit at all right after an edited
	 *  request), with the P(warm) and pause that prompt's run plan will use. */
	private warmCutNow(ctx: Any, entries: Any[], now: { pWarm: number; pause: boolean }): PlanResult | null {
		if (this.justEdited) return null;
		const mk = (cutAt?: string) => {
			const { o } = this.opts(ctx, true, entries, now.pWarm, now.pause, cutAt);
			return { p: planContext(entries, o) };
		};
		const p = this.adopted(mk(), mk, "key", this.avail(this.branch(ctx))).p;
		return p && p.cutIdx !== null ? p : null;
	}

	/** A reopened session whose cache is dead and whose cold plan would summarise, or whose cache is still alive and whose warm plan would
	 *  (rule A: the live process would have started it when the run ended): start that summary once the user is typing a prompt
	 *  (Pi API ctx.ui.onTerminalInput; never consumes or alters the data). A key alone is not enough: Ctrl+C, Ctrl+D, Esc, arrows and
	 *  `/quit` or `/resume` are how a session is left without working in it. After each key (once Pi's editor has taken it) the editor
	 *  text decides: non-empty and not a command (`/...`). The prompt that follows takes the summary if it is ready, else its folds
	 *  alone; the call goes on and a later decision takes it (no second call). A session opened and closed without typing a prompt makes no
	 *  call (shutdown unsubscribes). Nothing without a UI (`pi -p`, a subagent) or without ctx.ui.getEditorText. */
	private armOnFirstKey(ctx: Any) {
		this.disarmKey();
		const ui = ctx?.ui;
		if (!ctx?.hasUI || typeof ui?.onTerminalInput !== "function" || typeof ui?.getEditorText !== "function") return;
		let queued = false;
		try {
			const off = ui.onTerminalInput((data: string) => {
				if (queued || !isKeystroke(data)) return undefined; // a terminal report (focus, cursor position, cell size, ...) is not the user
				queued = true;
				// after Pi's editor handled this key (the listener runs before it), off the input path: the planning below must not delay the key
				setImmediate(() => {
					queued = false;
					if (this.keyOff !== off) return; // disarmed meanwhile (a prompt, a run, shutdown)
					let text = "";
					try {
						text = String(ui.getEditorText() ?? "");
					} catch {}
					const t = text.trimStart();
					if (!t || t.startsWith("/")) return; // nothing typed yet, or a command (/quit, /resume, /model, ...): stay armed
					this.disarmKey();
					this.startOnKey(ctx);
				});
				return undefined; // the input goes on to Pi untouched
			});
			this.keyOff = off;
			this.ledger({ type: "key_armed" });
		} catch (err) {
			this.ledger({ type: "error", where: "arm_key", error: errText(err) });
		}
	}

	/** The user is typing a prompt: plan the return again on the session as it is now (a /model or /tree before it may have changed
	 *  it), judged cold or warm as the prompt will judge it, with the P(warm) and pause its own run plan will use, and, when that plan
	 *  has a cut, write the summary in the background, as the away timer (cold) or the end of the run (warm, rule A) would have. */
	private startOnKey(ctx: Any) {
		try {
			if (!this.active() || this.bg) return;
			const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
			if (!entries.length || !ctx?.model) return;
			const now = this.judgeNow(ctx, this.branch(ctx));
			if (!now.cold) {
				const w = this.warmCutNow(ctx, entries, now);
				if (!w) return;
				this.startBg(w, ctx);
				this.ledger({ type: "key_start", key: w.firstKeptEntryId, warm: true });
				return;
			}
			const { o } = this.opts(ctx, true, entries, now.pWarm, now.pause);
			const p = planContext(entries, o);
			if (!p || p.cutIdx === null) return;
			this.awaySig = this.contextSig(ctx);
			this.startBg(p, ctx);
			this.ledger({ type: "key_start", key: p.firstKeptEntryId });
		} catch (err) {
			this.ledger({ type: "error", where: "start_on_key", error: errText(err) });
		}
	}

	private cancelTimer() {
		this.timerGen++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.awayPlan = null;
	}

	/** The call in flight, if any, ends unused: aborted, and recorded at once (in the session it belongs to, whatever the aborted call
	 *  does later) as a pi-zip/summary entry without a summary, at the input it is billed for (estimated). */
	private discardBg(why: "replaced" | "shutdown" | "off") {
		const b = this.bg;
		this.bg = null;
		if (!b) return;
		b.aborted = true;
		b.controller.abort();
		this.stats.summaryUsd += b.estUsd;
		this.ledger({ type: "unused_summary", key: b.key, why });
		this.record({ head: b.head, key: b.key, usd: b.estUsd, estimated: true, lost: why });
	}

	/** A pi-zip/summary record: written now between runs (custom entry, never in the context); inside a run it waits for the run's next
	 *  turn_end or settle, where it goes with the drafts. Either way this process reads it from `mine` at once. */
	private record(a: Artifact) {
		this.mine.push(a);
		if (this.inRun) this.unwritten.push(a);
		else this.write(a);
	}
	private write(a: Artifact) {
		try {
			this.pi.appendEntry(SUMMARY_CUSTOM, a);
		} catch {}
	}
	private writeUnwritten() {
		for (const a of this.unwritten.splice(0)) this.write(a);
	}
	/** The records made inside the run, as drafts of a turn_end or settle. */
	private drafts(): Any[] {
		return this.unwritten.splice(0).map((a) => ({ type: "custom", customType: SUMMARY_CUSTOM, data: a }));
	}

	/** The summaries a plan of this branch may take: the ready ones, and the call in flight when it reads this branch's projection. */
	private avail(branch: Any[]): Avail[] {
		const out: Avail[] = readyOf(branch, this.mine).map((a) => ({ key: a.key, running: false }));
		const b = this.bg;
		if (b && b.head === headOf(branch) && !out.some((a) => a.key === b.key)) out.push({ key: b.key, running: true });
		return out;
	}

	/** The plan `first`, or the plan cutting where a produced summary cuts that is not deeper (core.ts adopt), logged. */
	private adopted<T extends { p: PlanResult | null }>(first: T, mk: (cutAt: string) => T, where: string, avail: Avail[]): T {
		const { r, note } = adopt(first, mk, avail, where);
		if (note) this.ledger(note);
		return r;
	}

	/** The ready summaries of this branch, as plans take them (a call still running is not ready: nobody waits for it). */
	private ready(branch: Any[]): Avail[] {
		return readyOf(branch, this.mine).map((a) => ({ key: a.key, running: false }));
	}

	/** produce(c) (theory 1.4 R8): the summary for this plan's cut is written in the background, unless a call is running (one call at
	 *  a time; it is used once ready, if a plan then still wants it) or the summary is ready already. A running call whose range is no
	 *  longer the session's prefix (the branch builds another projection, or its cut left it) is void: it is ended first (startBg). */
	private produce(p: PlanResult, ctx: Any, where: "run" | "turn_end") {
		const b = this.bg, head = headOf(this.branch(ctx));
		const running = !!b && b.head === head && p.blocks.some((x) => x.entryId === b.key);
		if (!running) this.startBg(p, ctx);
		this.ledger({ type: "produce", where, key: p.firstKeptEntryId, ...(running ? { running: b!.key } : {}) });
	}

	/**
	 * The one wait (theory 1.4, R9): at a turn_end whose view after the decision's edit is still at Pi's compaction room, the plan's own
	 * cut is summarised while the turn waits (Pi would stop for its own, lossy compaction otherwise). A call running for that very cut
	 * is awaited; any other call is ended first, so there is never a second one in flight. null: the call failed or was cancelled.
	 */
	private async roomWait(c: PlanResult, ctx: Any): Promise<{ cut: Cut; ms: number } | null> {
		const head = headOf(this.branch(ctx)), key = c.firstKeptEntryId, b = this.bg, w0 = performance.now();
		const running = !!b && b.key === key && b.head === head;
		this.ledger({ type: "room_wait", key, running });
		let cut: Cut | null = null;
		try {
			if (running) {
				const got = await this.working(ctx, `${PRODUCT}: finishing a summary (the context is close to the window)`, b!.promise);
				cut = got ? { ...got, trigger: "valve", prepared: true } : null; // booked when it was produced
			} else {
				this.discardBg("replaced");
				cut = await this.working(ctx, `${PRODUCT}: writing a summary (the context is close to the window)`, buildCut(c, ctx));
			}
		} catch (err) {
			this.ledger({ type: "error", where: "room_wait", error: errText(err) });
		}
		return cut ? { cut, ms: performance.now() - w0 } : null;
	}

	async context(e: Any, ctx: Any): Promise<Any> {
		if (!this.active()) return undefined;
		if (this.starting) await this.starting; // agent_start's start-of-run handling of a driven run
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
		if (ctx?.signal?.aborted) return undefined; // Esc (Pi cancelled the prompt): this request never goes out, so nothing is applied or announced
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

	/** While the user waits for a summary, Pi's working line says what for. */
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

	/** ONE plan per edit run: computed at the first request (the new prompt is in the session), applied to every request until turn_end persists the same set. */
	private async computeRunPlan(ctx: Any) {
		const t0 = performance.now();
		const now = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
		// a summary that went in through Pi's compaction before the run (nativeSummary): plan on the projection as it was right before
		// it, plus what came after, so folds, scale and placeholders are exactly what the draft path computes (the run's first request
		// carries the same bytes); the request Pi builds already starts with the summary
		const nat = this.nativeRun, foreign = this.foreignRun;
		this.nativeRun = null;
		this.foreignRun = false;
		const d = decideRun({
			cold: this.cold, justEdited: this.justEdited, nat, foreign, now, ready: this.ready(this.branch(ctx)),
			opts: (entries, cutAt, foldsOnly, ready) => this.opts(ctx, false, entries, this.pWarm, this.pause, cutAt, foldsOnly, ready),
		});
		// no warm edit on the request right after an edited one (no back-to-back warm rewrites); the summary the plan wants is still
		// produced. A summary Pi's compaction already put in the session (nativeSummary skips such a return, so only defensively) is
		// never dropped here: the run plan below carries it
		if (d.kind === "b2b") {
			this.ledger({ type: "b2b_skip", where: "run" });
			if (d.produce) this.produce(d.produce, ctx, "run");
			return;
		}
		for (const n of d.notes) this.ledger(n);
		const { o, cal, p, onPre } = d;
		this.lawLedger("run", o);
		// a cut with no ready summary: the plan is its folds alone (by the law), and the summary is written in the background
		if (d.produce) this.produce(d.produce, ctx, "run");
		const native = nat?.cut ?? null;
		if (!p && !native) return; // the law does not fire (below the working view, or a rewrite that does not pay back)
		this.runEdits = true;
		const trigger = this.cold ? "cold" : "valve";
		let cut: Cut | null = null;
		if (!native && p && p.cutIdx !== null) {
			const art = readyOf(this.branch(ctx), this.mine).find((a) => a.key === p.firstKeptEntryId);
			cut = art?.cut ? { ...art.cut, trigger, prepared: true } : null; // labelled by the return that adopts it (written early for a warm one, say)
			if (cut) this.ledger({ type: "take", where: "run", key: p.firstKeptEntryId }); // a ready summary: its call is spent (priced 0)
		}
		if (cut || native) this.discardBg("replaced"); // a summary goes in: a call still running reads a projection that is about to end
		const foldMs = performance.now() - t0, settleIds = this.settleIds;
		// a plan that cannot be persisted must never be sent: the request view would differ from what turn_end can write (I1)
		const r = runPlanOf({ p, cal, cold: this.cold, onPre, native, nat, folds: p?.folds ?? [], cut, adopted: !!(cut || native), settleIds, ms: foldMs });
		if (r.drop) this.ledger(r.drop);
		const { folds } = r;
		cut = r.cut;
		this.runPlan = r.plan;
		const { source, ctxBefore, ctxAfter } = r.plan;
		this.ledger({ type: "cold_plan", trigger, source, folds: folds.length, summary: !!(cut ?? native), ...(native ? { via: "native", onPre } : {}), ...this.calOf(cal), ctxBefore: Math.round(ctxBefore), ctxAfter: Math.round(ctxAfter), ms: Math.round(foldMs), ...(cut ? { summaryMs: cut.ms, llmOk: cut.llmOk, waitedMs: 0, ...this.usageOf(cut) } : {}) });
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
	 * Prepare the next return while the user is away (interactive only; print and json mode exit right after settle, so there is
	 * nothing to prepare and nothing is ever started in the background). The plans themselves are local and free; only a summary needs
	 * a model call. Rule A: when even a warm return (the next prompt within the cache's lifetime) would summarise, that summary is
	 * started now: it is needed either way, and the user does not wait for it at the return. A cold plan that cuts elsewhere (or not at
	 * all) gets the away timer: its summary is started 0.8 x TTL after the last request, if the user has not come back by then.
	 */
	async settle(e: Any, ctx: Any): Promise<Any> {
		this.inRun = false;
		const recs = this.drafts(); // summaries recorded during the run go with the settle drafts
		const out = await this.prepare(e, ctx);
		return recs.length ? { entries: [...(out?.entries ?? e.entries), ...recs] } : out;
	}
	private async prepare(e: Any, ctx: Any): Promise<Any> {
		if (!this.active() || !ctx.hasUI) return undefined;
		try {
			const t0 = performance.now();
			const entries = e.context.contextEntries;
			// rule A: the plan a warm return would make (none right after an edited request: that return makes no edit, b2b). If it summarises,
			// the summary is needed whether the user comes back warm or not at all soon, so it is written now, not at 0.8 x TTL
			const { p, cal, w, notes } = decideSettle({
				justEdited: this.justEdited, avail: this.avail(this.branch(ctx)), entries,
				cold: (cutAt) => this.opts(ctx, true, entries, 0, true, cutAt), warm: (cutAt) => this.opts(ctx, true, entries, 1, false, cutAt),
			});
			for (const n of notes) this.ledger(n);
			this.cancelTimer();
			const cKey = p && p.cutIdx !== null ? p.firstKeptEntryId : null;
			const wKey = w && w.cutIdx !== null ? w.firstKeptEntryId : null;
			// a call for neither return's cut is never used
			if (this.bg && this.bg.key !== cKey && this.bg.key !== wKey) this.discardBg("replaced");
			const early = !!wKey && this.startBg(w!, ctx);
			// the away timer, always: for a cold plan with a cut no summary covers yet it starts that summary; for one an early summary
			// already covers it does nothing (startBg keeps it); for one without a cut, or no plan at all (below the working view), it does
			// nothing either. In every case, if Pi's own compaction or another extension's edit rewrites the context while the user is away,
			// runAway plans again on the context as it is and drops a summary (an early one too) written for the old one
			const scheduledMs = this.scheduleSummary(p ?? w, ctx);
			this.ledger({ type: "settle_plan", folds: p?.folds.length ?? 0, summary: cKey !== null, timerMs: scheduledMs, ...(cKey ? { coldCut: cKey } : {}), ...(wKey ? { warmCut: wKey, early } : {}), ...this.calOf(cal), ctxBefore: Math.round(p?.ctxTokens ?? w?.ctxTokens ?? 0), ms: Math.round(performance.now() - t0) });
			if (!p || (!p.folds.length && p.cutIdx === null)) return undefined;
			// ids only: placeholders and summary text are recomputed (they are pure functions of the session), never stored a second time
			const data = { policy: PRODUCT, ts: Date.now(), targets: p.folds.map((t) => t.entryId), cutKey: p.firstKeptEntryId };
			return { entries: [...e.entries, { type: "custom", customType: PLAN_CUSTOM, data }] };
		} catch (err) {
			this.ledger({ type: "error", where: "settle", error: errText(err) });
			return undefined; // never break the session
		}
	}

	/** Start the away-timer for a summary; returns the delay in ms (-1: `alive` was asked for and the cache is already dead, nothing is armed).
	 *  `alive` (a resumed process): arm only while the last request's cache has not expired yet (now < last + TTL; the delay is 0 from the
	 *  0.8 mark on, where the live process's timer would already have fired). unref'd: it never keeps the process alive. */
	private scheduleSummary(p: PlanResult | null, ctx: Any, lastMs?: number, alive = false): number {
		const ttl = ttlFor(ctx.model, this.branch(ctx), this.tier(ctx.model));
		const last = lastMs ?? (this.lastReqMs || Date.now());
		const warm = this.idleWarming() ? warmingDelayMs(ttl) : undefined;
		if (warm !== undefined) {
			// Pi keeps the cache warm between runs (cacheWarming "idle") and decides before each refresh, at its warming delay: a summary
			// written now would be thrown away at a warm return, so it waits for Pi's decision (cacheWarmingDecision); should none come
			// (Pi is not warming this request after all), it starts just after the decision was due
			const due = last + warm + warmingMargin(ttl) - Date.now();
			if (alive && Date.now() >= last + ttl) return -1;
			this.awaySig = this.contextSig(ctx);
			this.awayPlan = { p, ctx };
			const delay = Math.max(0, due);
			this.armAway(delay, () => this.startAway("no warming decision"));
			return Math.round(delay);
		}
		const due = last + AWAY_FRACTION * ttl - Date.now();
		if (alive && Date.now() >= last + ttl) return -1;
		this.awaySig = this.contextSig(ctx);
		const delay = Math.max(0, due);
		this.armAway(delay, () => void this.runAway(p, ctx));
		return Math.round(delay);
	}

	/** What the model would see of the branch, by its newest context entry: a message, edit, compaction or summary (our own bookkeeping
	 *  entries and other extensions' custom entries change nothing). A different one at the timer than at settle means something
	 *  rewrote the context in between (Pi's compaction, another extension's edit). */
	private awaySig = "";
	private contextSig(ctx: Any): string {
		const branch = this.branch(ctx);
		for (let i = branch.length - 1; i >= 0; i--) {
			const t = branch[i]?.type;
			if (t === "message" || t === "context_edit" || t === "compaction" || t === "branch_summary" || t === "custom_message") return `${t}:${branch[i].id}`;
		}
		return "";
	}

	/** One timer for the away summary (unref'd: it never keeps the process alive); a newer one, or the user's return, cancels it. */
	private armAway(delayMs: number, fn: () => void) {
		if (this.timer) clearTimeout(this.timer);
		const gen = ++this.timerGen;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (gen === this.timerGen && this.active()) fn(); // else the user came back, or we were switched off
		}, Math.max(0, delayMs));
		this.timer.unref?.();
	}

	// ---- Pi's own idle cache warming (research pi-tricks §3.3): observed, never answered ----------------------------------------
	private awayPlan: { p: PlanResult | null; ctx: Any } | null = null; // a summary (or none: a re-plan if the context changes) waiting for Pi's warming decision
	/** Does Pi refresh the cache between runs by itself? (settings cacheWarming "idle"; the default "streaming" warms only during a run)
	 *  Pi reads it from the global settings only (settings-manager getCacheWarmingMode: warming costs money), so a project-level "idle"
	 *  in the merged settings warms nothing: the global file decides; only when it cannot be read do the merged settings. */
	private idleWarming(): boolean {
		try {
			if (this.pi.getSettings?.()?.cacheWarming !== "idle") return false;
		} catch {
			return false;
		}
		try {
			const global = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
			return global?.cacheWarming === "idle";
		} catch {
			return true;
		}
	}
	private startAway(reason: string) {
		const a = this.awayPlan;
		this.awayPlan = null;
		if (!a) return;
		this.ledger({ type: "away_unblocked", reason });
		void this.runAway(a.p, a.ctx);
	}
	/** cache_warming_decision: Pi is about to refresh the cache ("warm") or to let it expire ("stop"). Only observed: never answered.
	 *  While Pi warms, the away summary waits; once Pi stops, it is prepared as without warming (the cache now expires on its own). */
	cacheWarmingDecision(e: Any): undefined {
		const action = e?.action;
		this.ledger({ type: "cache_warming", action, warmCost: e?.warmCost, missCost: e?.missCost, p: e?.continuationProbability, waiting: !!this.awayPlan });
		const a = this.awayPlan;
		if (!a || !this.active()) return undefined;
		if (action === "stop") {
			this.armAway(0, () => {
				this.awayPlan = a;
				this.startAway("Pi stopped warming");
			});
			return undefined;
		}
		if (action !== "warm") return undefined;
		// Pi refreshes now, unless another extension overrides the decision (its answer is not visible here): a refresh shows up as a
		// cache_warm usage entry within seconds. With one, wait for the next decision; without one, Pi stopped: prepare the summary now.
		const t = Date.now(), ttl = ttlFor(a.ctx.model, this.branch(a.ctx), this.tier(a.ctx.model));
		this.ledger({ type: "away_postponed", reason: "Pi warms the cache" });
		this.armAway(warmCheckMs(ttl), () => {
			this.awayPlan = a;
			let done = NaN; // when the refresh finished: its cache_warm entry is appended right before Pi schedules the next decision
			for (const en of this.branch(a.ctx)) if (en?.type === "usage" && en.kind === "cache_warm" && Date.parse(en.timestamp) >= t) done = Date.parse(en.timestamp);
			if (Number.isNaN(done)) return this.startAway("no refresh after a warm decision");
			// Pi's next decision is due one warming delay after the refresh finished (cache-warmer.js schedule), not after the decision
			this.armAway(done + (warmingDelayMs(ttl) ?? ttl) + warmingMargin(ttl) - Date.now(), () => {
				this.awayPlan = a;
				this.startAway("no warming decision");
			});
		});
		return undefined;
	}

	private async runAway(p0: PlanResult | null, ctx: Any) {
		if (!this.active()) return;
		let p = p0;
		if (this.contextSig(ctx) === this.awaySig && (!p0 || p0.cutIdx === null)) return; // nothing was planned and nothing changed
		if (this.contextSig(ctx) !== this.awaySig) {
			// something rewrote the context since the plan was made (Pi's own compaction, another extension's edit): the summary prepared
			// for the old plan would be discarded at the return (its cut is not this plan's). Plan again on the session as it is now.
			try {
				const entries = ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) as Any[];
				const { o } = this.opts(ctx, true, entries, 0, true);
				const q = entries.length ? planContext(entries, o) : null;
				this.ledger({ type: "away_replan", from: p0?.firstKeptEntryId ?? null, to: q?.firstKeptEntryId ?? null });
				// a call started before (an early one, rule A) reads a context that no longer exists: never used, whatever its cut
				this.discardBg("replaced");
				if (!q || q.cutIdx === null) return;
				p = q;
			} catch (err) {
				this.ledger({ type: "error", where: "away_replan", error: errText(err) });
				return;
			}
		}
		if (p) this.startBg(p, ctx); // keeps a summary for this very cut (an early one, say); ends any other call
	}

	/** Write the summary for `p` in the background (its own abort signal: nothing is running, so the run's would be stale). Nothing
	 *  when one for the same cut of the same projection is ready or being written (false); any other call in flight is ended first. */
	private startBg(p: PlanResult, ctx: Any): boolean {
		const branch = this.branch(ctx), head = headOf(branch), key = p.firstKeptEntryId;
		if (key === null) return false;
		if (this.bg && this.bg.key === key && this.bg.head === head) return false;
		if (readyOf(branch, this.mine).some((a) => a.key === key)) return false;
		this.discardBg("replaced");
		const controller = new AbortController();
		const prevSum = p.blocks[0]?.kind === "summary" ? p.blocks[0].tokens : 0;
		const estUsd = (p.scale.c * Math.max(0, p.prefixTokens - prevSum) * (Number(ctx?.model?.cost?.input) || 0)) / 1e6;
		const bg: Bg = { key, head, aborted: false, promise: Promise.resolve(null), controller, estUsd };
		const end = () => { if (this.bg === bg) this.bg = null; };
		bg.promise = buildCut(p, ctx, controller.signal)
			.then((c) => {
				end();
				if (bg.aborted) return null; // recorded as unused when it was ended
				this.stats.summaryUsd += c.costUsd;
				this.ledger({ type: "away_summary", key, ms: c.ms, llmOk: c.llmOk, costUsd: c.costUsd, ...this.usageOf(c) });
				this.record({ head, key, cut: c, usd: c.costUsd });
				return c;
			})
			.catch((err) => {
				end();
				if (!bg.aborted) this.ledger({ type: "error", where: "away_summary", error: err instanceof Error ? err.message : String(err) });
				return null;
			});
		this.bg = bg;
		this.ledger({ type: "away_summary_start", key });
		return true;
	}

	async turnEnd(e: Any, ctx: Any): Promise<Any> {
		this.logForeign(ctx, "turn_end");
		if (!this.active()) return undefined;
		try {
			const fresh = this.collectSteer(e); // marked before anything is validated: a steering message is part of its turn
			const out = await this.onTurnEnd(e, ctx);
			const recs = this.drafts(); // summaries recorded during the run, after the turn's edits (a compaction goes first)
			if (!fresh.length && !recs.length) return out;
			if (fresh.length) this.ledger({ type: "steer", ids: fresh });
			return { entries: [...(out?.entries ?? e.entries), ...(fresh.length ? [{ type: "custom", customType: STEER_CUSTOM, data: { ids: fresh } }] : []), ...recs] };
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
		// P(warm) in-run: the learned curve at the time since the newest response (a long tool call is an absence like any other)
		const m = ctx?.model ?? this.model, branch = this.branch(ctx);
		// a recall made in this run by a built-in tool on a recall file (file recall) is in the branch only: zip_recall's own hook
		// marks its handles at once, a read, grep or bash of a recall file would otherwise be folded again at this turn_end (RC)
		for (const h of recalledHandlesFromBranch(branch)) this.recalled.add(h);
		const touch = Math.max(this.lastReqMs, msg?.stopReason === "error" ? 0 : Number(msg?.timestamp) || 0); // the response that ended this turn is the newest touch
		const pIn = inRunClock(branch, { model: m, ent: this.entKey === modelKey(m) ? this.ent : undefined, tier: this.tier(m) }, Date.now(), { reqMs: touch, modelKey: this.lastModelKey }).pWarm;
		const ents = e.context.contextEntries;
		const d = decideTurnEnd({ failed, justEdited: this.justEdited, pWarm: pIn, ready: this.ready(branch), entries: ents, opts: (cutAt, foldsOnly, ready) => this.opts(ctx, false, ents, pIn, false, cutAt, foldsOnly, ready) });
		if (d.kind === "none") return undefined;
		if (d.kind === "b2b") { // the request that just ended carried a fresh edit: no warm edit on the very next one (no back-to-back warm rewrites)
			this.ledger({ type: "b2b_skip", where: "turn_end" });
			if (d.produce) this.produce(d.produce, ctx, "turn_end");
			return undefined;
		}
		// nothing below the working view; above it the plan the law accepts at the in-run P (I6, F10), from the next request on: with a
		// ready summary, or its folds alone while the summary is written in the background
		for (const n of d.notes) this.ledger(n);
		if (d.o.trace?.length) this.lawLedger("turn_end", d.o);
		if (d.produce) this.produce(d.produce, ctx, "turn_end");
		let p = d.p, cut: Cut | null = null, ready = false, waitMs = 0;
		if (d.room) { // still at Pi's compaction room after this edit: the one wait
			const got = await this.roomWait(d.room, ctx);
			if (got) [p, cut, waitMs] = [d.room, got.cut, got.ms];
		}
		if (!cut && p && p.cutIdx !== null) {
			const art = readyOf(branch, this.mine).find((a) => a.key === p!.firstKeptEntryId);
			if (!art?.cut) return undefined; // decideTurnEnd takes only a ready one
			[cut, ready] = [{ ...art.cut, trigger: "valve", prepared: true }, true];
			this.ledger({ type: "take", where: "turn_end", key: p.firstKeptEntryId }); // a ready summary: its call is spent (priced 0)
		}
		if (!p) return undefined;
		if (cut) this.discardBg("replaced"); // a summary goes in: a call still running reads a projection that is about to end
		const plan = valvePlanOf(p, cut, ready, waitMs, performance.now() - t0);
		return this.commit(e, ctx, plan, o);
	}

	/**
	 * The transcript notice for one plan. Facts only, no claims: what changed (sizes), how long it took, and, expanded, why now
	 * ("cache cold · away 47 min") and what was folded. Whether the cache really was cold is learned from the response, silently (/zip shows it).
	 * `realAfter` > 0: the size the provider reported for the request that carried the plan (shown instead of the estimate).
	 */
	private noticeFor(ctx: Any, plan: RunPlan, live: FoldTarget[], cut: Cut | null, ctxTokens: number, realAfter: number) {
		if (this.quiet || (!live.length && !cut)) return;
		const { c } = plan.scale, valve = plan.source === "valve"; // amounts scale by c; sizes are O + c x content (plan.ts)
		const before = c * live.reduce((a, t) => a + t.entryTokens, 0), after = c * live.reduce((a, t) => a + t.phTokens, 0);
		const cutSaved = cut ? c * (cut.prefixTokens - cut.summaryTokens) : 0;
		const estAfter = ctxTokens - (before - after) - cutSaved;
		const waitMs = cut ? (plan.waitMs ?? 0) : 0;
		const notices: NoticeAction[] = [];
		if (live.length) notices.push({ kind: "fold", count: live.length, tokensBefore: ctxTokens, tokensAfter: cut || !realAfter ? ctxTokens - (before - after) : realAfter, ms: plan.ms, pressure: valve });
		if (cut) {
			// finished while the user was away (or while the run went on): report the real production time, not the zero wait
			const prepared = (plan.source === "settle" || plan.ready === "away") && waitMs < 500;
			const background = !prepared && plan.ready === "background" && waitMs < 500;
			notices.push({ kind: "summary", count: cut.count, tokensBefore: ctxTokens - (before - after), tokensAfter: realAfter || estAfter, ms: Math.max(cut.ms, waitMs), waitMs, prepared, ...(background ? { background } : {}), pressure: valve });
		}
		for (const t of live) this.labels.set(handleFor(t.entryId), `${t.tool}${t.args ? " " + t.args : ""}`);
		const ITEMS = 8;
		const items = live.slice(0, ITEMS).map((t) => ({ label: `${t.tool}${t.args ? " " + t.args : ""}`, tokens: Math.round(c * t.entryTokens), handle: handleFor(t.entryId) }));
		const why = valve || !this.cold ? "cache warm · worth it at this size" : this.coldWhy;
		// reqTs: a run plan is announced as its first request goes out, a valve plan at turn_end, before the next request that first carries
		// it; either way the first assistant message stamped at or after this moment answered the request that carried the plan
		const data: NoticeData = { v: 2, text: noticeText(notices), before: Math.round(notices[0].tokensBefore), after: Math.round(notices[notices.length - 1].tokensAfter), desc: noticeDesc(notices), why: why || undefined, items, more: Math.max(0, live.length - ITEMS) || undefined, first: !this.noticed && !this.branch(ctx).some((en: Any) => en?.type === "custom" && en.customType === NOTICE_CUSTOM), reqTs: Date.now(), ...(cut && (!valve || plan.native) && this.nativeNote ? { native: this.nativeNote.native, ...(this.nativeNote.ms !== undefined ? { nativeMs: this.nativeNote.ms } : {}), ...(this.nativeNote.askMs !== undefined ? { nativeAskMs: this.nativeNote.askMs } : {}) } : {}) };
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
		const regrow = cut ? Math.round(plan.ctxAfter + c * (cut.prefixTokens - cut.summaryTokens)) : 0; // the context the summary started from
		if (!bad && cut) {
			// one summary per warm stretch (two in a row cost two uncached calls; the second gains little), until the context has grown back
			// to the size this one started from: a second summary then gains what this one did, and the law alone decides
			this.summarizedWarm = true;
			this.summaryRegrow = regrow;
		}
		if (bad) {
			this.ledger({ type: "guard_drop", turnIndex: e.turnIndex, reason: bad, folds: live.length, source: plan.source });
			plan.persisted = false; // keep the request-local view: never switch the fold set mid-run
			return undefined;
		}
		if (!plan.sent) this.nextEdit = plan.untouched ?? 0; // persisted now, first sent with the next request
		const sentBefore = !!plan.sent;
		const ours: Any[] = live.map((t) => ({ type: "context_edit", targetId: t.entryId, replacement: { content: [{ type: "text", text: t.ph }] } }));
		for (const t of live) if (t.toolCallId) this.foldedCalls.set(t.toolCallId, handleFor(t.entryId));
		// the compaction draft goes FIRST: Pi writes its tokensBefore from the newest usage only while no edit follows that usage, so a
		// fold drafted before it would make Pi's "Compacted from N tokens" the chars/4 of a half-applied projection (research pi-tricks §1a)
		if (cut) ours.unshift({ type: "compaction", summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, details: { by: PRODUCT, trigger: cut.trigger, carried: sentBefore, regrow }, usage: cut.usage });
		ours.push({ type: "custom", customType: COMMIT_CUSTOM, data: { carried: sentBefore } }); // says who first carried these edits (state.ts, plan.ts calibrate)
		const before = Math.round(c * live.reduce((a, t) => a + t.entryTokens, 0));
		const after = Math.round(c * live.reduce((a, t) => a + t.phTokens, 0));
		const cutSaved = cut ? Math.round(c * (cut.prefixTokens - cut.summaryTokens)) : 0;
		const waitMs = cut ? (plan.waitMs ?? 0) : 0;
		const s = this.stats;
		s.folds += live.length;
		s.foldedTokens += before - after;
		s.activeSaved += before - after + cutSaved;
		if (plan.source === "valve") {
			if (!plan.native) { // a warm native summary booked this valve edit already (nativeSummary)
				s.pressureEdits++;
				s.pressureRewriteTokens += ctxTokens;
			}
		} else {
			s.writeSavedTokens += before - after + cutSaved;
		}
		if (cut) {
			s.summaries++;
			s.summarizedTokens += cutSaved;
			s.summaryMs += waitMs;
			if (!cut.prepared) s.summaryUsd += cut.costUsd; // a prepared one was counted when it was produced
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
		this.reqMsBefore = this.lastReqMs;
		this.lastReqMs = now;
		this.lastModelKey = key;
		this.stats.readSavedTokens += this.stats.activeSaved;
		const p: Any = e.payload;
		const seen = payloadRetention(p); // what this very request asked the provider for: it wins over any environment
		if (seen && key && (seen !== this.retention?.tier || this.retention?.key !== key || this.retention?.src !== "payload")) {
			this.retention = { key, tier: seen, src: "payload" };
			this.ledger({ type: "retention", ...this.retention });
		}
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

	messageEnd(m: Any, ctx?: Any) {
		if (this.promptStart) {
			this.promptStart = false;
			if (m?.role === "custom" && ctx) void this.drivenStart(ctx); // the agent_start was a driven run's: its start of run, now
		}
		if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") this.lastReqMs = Date.now(); // the response is complete: the entry was refreshed when it finished
		else if (refused(m)) this.lastReqMs = this.reqMsBefore; // the provider refused the request: it touched no cache (cache.ts lastMessageMs reads the branch the same way)
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
		if (!pend.edited && this.prevKey === pend.key && this.prevTotal > 0 && total >= this.prevTotal) ({ g: this.g, deltas: this.deltas } = grow(this.g, this.deltas, total - this.prevTotal));
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
			} else if (e?.type === "custom" && e.customType === LEGACY_UNUSED_CUSTOM) usd += Number(e.data?.usd) || 0;
			else if (e?.type === "custom" && e.customType === NOTICE_CUSTOM && e.data?.v === 2 && !e.data?.kind) last = e;
			else if (e?.type === "message" && e.message?.role === "toolResult" && (e.message?.toolName === RECALL_TOOL || fileRecalls.has(e.message?.toolCallId))) recalls++;
		}
		// chars/4 of the folded text, on the provider's scale: x c of the model that folded it (folded outputs are content)
		let folded = 0;
		if (folds) {
			const entries = byModel.size > 1 ? ((ctx.sessionManager.buildSessionProjection() as Any)?.entries ?? []) : undefined;
			for (const [k, v] of byModel) folded += v * (byModel.size > 1 && k ? this.scaleAt(ctx, entries, k) : this.scaleOf(ctx)).c;
		}
		usd += unusedOf(branch).usd; // background summaries no compaction used, and calls lost or ended before they wrote one
		return { folds, folded, summaries, recalls, usd, last };
	}
	/** What this session carries: folds and summaries persisted in its file (they survive restarts) and the recalls in its branch. */
	private sessionTotals(ctx: Any): string {
		const { folds, folded, summaries, recalls, usd } = this.totals(ctx);
		const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
		return `this session: ${folds} zipped (~${fmtK(folded)} tokens), ${n(summaries, "summary", "summaries")}${usd > 0 ? ` (summary calls $${usd.toFixed(4)})` : ""}, ${n(recalls, "unzip", "unzips")}`;
	}
	/** The /zip card (rendered by ui.ts renderCard). */
	card(ctx?: Any): CardData {
		const t = this.totals(ctx);
		const model = ctx?.model ?? this.model;
		const key = modelKey(model), ttlS = ttlFor(model, [], this.tier(model)) / 1000, ent = key ? loadStats().models[key] : undefined;
		let lifeS = 0;
		for (let g = 30; g <= 7200; g += 30) if (pWarm(ent, g, ttlS).p >= 0.5) lifeS = g;
		const life = key ? (lifeS >= 7200 ? "2 h+" : fmtLife(lifeS || ttlS)) : undefined;
		// the chart: every learned bin that still rounds to a return (the weights are decayed), and where the learned curve says
		// "still there" ends (s1) and "gone" starts (s2); never the declared TTL
		const bins: ChartBin[] = Object.entries(ent?.bins ?? {})
			.map(([b, [a, d]]) => ({ lo: GAP_EDGES[Number(b)], hi: GAP_EDGES[Number(b) + 1] ?? 7200, alive: Math.round(a), gone: Math.round(d) }))
			.filter((x) => x.lo !== undefined && x.alive + x.gone > 0)
			.sort((x, y) => x.lo - y.lo);
		const cur = (ent ? curve(ent, ttlS) : []).map((x) => ({ lo: GAP_EDGES[x.bin], hi: GAP_EDGES[x.bin + 1] ?? 7200, p: x.p }));
		let s1 = GAP_EDGES[0];
		for (const x of cur) { if (x.p >= 0.8) s1 = x.hi; else break; }
		const s2 = cur.find((x) => x.lo >= s1 && x.p <= 0.2)?.lo ?? 7200;
		const usually = cur.some((x) => x.hi <= s1 && x.p < 0.95);
		const ts = t.last?.timestamp ? new Date(t.last.timestamp) : null;
		const hhmm = ts && !Number.isNaN(ts.getTime()) ? `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}  ` : "";
		const last = t.last ? `${hhmm}${t.last.data.desc}${t.last.data.why ? " · " + t.last.data.why : ""}` : undefined;
		const file = this.recallMode === "file" && !!this.fileRecall(ctx);
		const state = this.off ? "off" : this.conflict ? "paused" : this.recallMode === "tool" || file ? "on" : "reread-only"; // file recall is a full mode
		const rereadWhy = this.recallMode === "file" ? "a tool allowlist hides zip_recall · no session file, so no recall copies" : "a tool allowlist hides zip_recall · only re-readable outputs fold";
		return {
			state, stateNote: state === "paused" ? `${this.conflict} also manages context` : state === "off" ? "/zip on to resume" : state === "reread-only" ? rereadWhy : undefined,
			model: key || undefined, life, ...(bins.length ? { bins, s1, s2, usually } : {}), folds: t.folds, foldedTokens: fmtK(t.folded), summaries: t.summaries, summaryUsd: t.usd, recalls: t.recalls, last, quiet: this.quiet,
			...(file ? { unzip: `from files in ${recallRootShown()} (a tool allowlist hides zip_recall)` } : {}),
		};
	}
	status(ctx?: Any): string {
		const state = this.off ? "off" : this.conflict ? `paused ("${this.conflict}" also manages context; only the request guard is on)` : "on";
		const key = modelKey(this.model), ttl = ttlFor(this.model, [], this.tier()), ent = loadStats().models[key];
		const pr = lawPrices(ent?.cls, ttl >= 3_600_000);
		const cache = !key ? "" : `\ncache ${key}: ${pr.src === "class" ? `${pr.cls} (from usage)` : "class unknown until the first response (explicit ratios meanwhile)"}` +
			`, read ${+pr.r.toFixed(4)} / write ${+pr.w.toFixed(4)} / output ${+pr.out.toFixed(4)} x input (class ratios)` +
			`, ${describe(ent, ttl / 1000)}, growth ${(this.g / 1000).toFixed(1)}K/request`;
		return `${PRODUCT}: ${state}, cache TTL ${Math.round(ttl / 1000)} s, ${this.quiet ? "notices off, " : ""}${this.sessionTotals(ctx)}${cache}`;
	}
	statsLine = (ctx?: Any) => `${PRODUCT} ${this.sessionTotals(ctx)} (tokens on the provider's scale, calibrated from this session's usage)`;
	setOff(off: boolean): string {
		this.off = off;
		if (off) { this.runPlan = null; this.runEdits = false; this.cancelTimer(); this.discardBg("off"); }
		this.persistState();
		return off ? `${PRODUCT}: off. Nothing is folded or summarised and requests are left untouched; earlier folds stay recallable (/zip on to resume)` : `${PRODUCT}: on`;
	}
	toggleQuiet(): string {
		this.quiet = !this.quiet;
		this.persistState();
		return `${PRODUCT}: per-turn notices ${this.quiet ? "off" : "on"} (folding continues)`;
	}
}
