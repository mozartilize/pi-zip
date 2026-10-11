// The decision core: view, clock, law, plan and decide as pure functions of the session branch, what pi-zip has learned (Λ) and
// the time. Nothing here reads a file, Pi or the clock, and nothing here has an effect: run.ts (the shell) gathers the inputs at Pi's
// events, keeps what only the process holds (the summary call in the background, the timers) and carries out what these return.
import { detectCold, modelKey, resolveTtl, type ColdInfo } from "./cache.ts";
import { validateEdits } from "./guard.ts";
import { lawPrices, pWarm, type Entry } from "./learn.ts";
import { calibrate, planContext, rebaseFolds, sizeOf, spliceNative, untouchedEst, UNIT, type Block, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import type { FileRecall } from "./recallfile.ts";
import { PRODUCT, type Any } from "./util.ts";

export const UNUSED_SUMMARY_CUSTOM = "pi-zip/unused-summary"; // a background summary nobody adopted: its cost, so the session totals stay honest

/** Λ for the model a decision is about: its learned class and survival (learn.ts), the cache tier its requests ask for (when known),
 *  growth per request, and the facts of the session state.ts rebuilds from the branch. */
export interface Learned {
	model: Any;
	ent?: Entry;
	tier?: "short" | "long";
	g: number;
	justEdited: boolean; // the newest response answered a request that first carried an edit (no back-to-back warm rewrites)
	summarizedWarm: boolean; // a summary was persisted since the last cold return
	summaryRegrow?: number; // ... and the real context (after folds) it started from
}

/** What the planner reads besides the branch: the model, the working directory, the system prompt and tools, Pi's compaction reserve,
 *  the recalled handles, the steering marks and how a folded output comes back (run.ts recallMode). */
export interface Env {
	model: Any;
	cwd: string;
	sys: SysInfo;
	reserve: number;
	recalled: Set<string>;
	steerIds: Set<string>;
	rereadOnly: boolean;
	fileRecall?: FileRecall;
}

/** A record for the ledger, returned by a decision for the shell to write (in order). */
export type Note = Record<string, unknown>;

// ---- view ---------------------------------------------------------------------------------------------------------------------

/** The token scale (O, c) of model `key` read from the branch (UNIT when it cannot be read). */
export function scaleOf(entries: Any[], branch: Any[], sys: SysInfo, key?: string): Scale {
	try {
		return calibrate(entries, sys, branch, key);
	} catch {
		return UNIT;
	}
}

/** The guard's view of a candidate edit set; folds whose entry left the projection are ignored. */
export function checkEdits(blocks: Block[], userTurns: number, folds: FoldTarget[], cut: Cut | null): string | null {
	const byId = new Map(blocks.map((b) => [b.entryId, b]));
	const live = folds.filter((t) => byId.has(t.entryId));
	const cutBlock = cut ? byId.get(cut.firstKeptEntryId) : undefined;
	if (cut && !cutBlock) return `cut target ${cut.firstKeptEntryId} is not in the projection`;
	return validateEdits(blocks, { folds: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.ph])), recover: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.recover])), cut: cutBlock ? cutBlock.idx : null, ahead: !!cut?.ahead }, userTurns);
}

// ---- clock --------------------------------------------------------------------------------------------------------------------

/** The return a request sent at `nowMs` would be: cold or warm, P(warm), the gap and whether it lies past the declared TTL.
 *  `last`: the shell's own clock of the newest request and its model (0 and "" read both from the branch). */
export const clock = (branch: Any[], lam: Pick<Learned, "model" | "ent" | "tier">, nowMs: number, last: { reqMs: number; modelKey: string } = { reqMs: 0, modelKey: "" }): ColdInfo =>
	detectCold(lam.model, last.reqMs, branch, nowMs, last.modelKey, (g, prior) => pWarm(lam.ent, g, prior), lam.tier);

/** stopReasons of an assistant message that does not end a run (buildBlocks' afterAnswer: a failed or aborted request ends it too). */
const STOP_NOT_FINAL = new Set(["toolUse"]);

/** Index of the first return after branch[at] that the clock judges cold, -1 when there is none. A return is a user prompt, or a
 *  custom message that follows a final answer (a run an extension's message started); a prompt and the custom messages stored right
 *  next to it are one return, exactly as buildBlocks counts turns. Each return is judged from the branch before it, with the learned
 *  entry of the model that answered it (`models`) and that model's tier (`tierOf`). `skip`: the first return after branch[at] is the
 *  one that made it, and is not judged. */
export function coldReturnAfter(branch: Any[], at: number, skip: boolean, steerIds: Set<string>, models: Record<string, Entry>, tierOf: (model: Any) => "short" | "long" | undefined): number {
	// afterAnswer: the newest message is a final answer (as buildBlocks); a summary ends no run, so the state before it carries over
	let afterAnswer = false, starter = false;
	for (let i = 0; i < at; i++) {
		const e = branch[i];
		if (e?.type === "custom_message") { afterAnswer = false; continue; }
		const r = e?.type === "message" ? e.message?.role : null;
		if (r === "assistant") afterAnswer = !STOP_NOT_FINAL.has(e.message.stopReason);
		else if (r === "user" || r === "toolResult") afterAnswer = false;
	}
	for (let i = at + 1; i < branch.length; i++) {
		const e = branch[i];
		let m: Any = null;
		if (e?.type === "custom_message") {
			if (!afterAnswer) continue; // mid-run, or riding with the prompt just before it
			afterAnswer = false;
			starter = true;
			m = { timestamp: Date.parse(e.timestamp) };
		} else {
			const x = e?.type === "message" ? e.message : null;
			if (x?.role === "assistant") { afterAnswer = !STOP_NOT_FINAL.has(x.stopReason); starter = false; continue; }
			if (x?.role === "toolResult") { afterAnswer = false; starter = false; continue; }
			if (x?.role !== "user") continue;
			afterAnswer = false;
			const follows = starter; // a prompt right after the custom message that started its run: the same return
			starter = false;
			if (follows || steerIds.has(e.id)) continue;
			m = x;
		}
		if (skip) { skip = false; continue; }
		let a: Any;
		for (let j = i + 1; j < branch.length && !a; j++) if (branch[j]?.type === "message" && branch[j].message?.role === "assistant" && branch[j].message.provider) a = branch[j].message;
		if (!a) continue; // a prompt nothing answered
		const model = { provider: a.provider, id: a.model };
		const ts = Number(m.timestamp) || Date.parse(e.timestamp) || 0;
		// the clock reads only the newest messages before the prompt (the last touch, the last model, the last few cache writes): a window
		// of them gives its answer (the whole prefix when the window holds no response), and the walk stays linear in a very long session
		let before = branch.slice(Math.max(0, i - 256), i);
		if (!before.some((x: Any) => x?.type === "message" && x.message?.role === "assistant")) before = branch.slice(0, i);
		if (clock(before, { model, ent: models[modelKey(model)], tier: tierOf(model) }, ts).cold) return i;
	}
	return -1;
}

/** Is the newest pi-zip summary of the branch newer than the last cold return? (`summarizedWarm`: set when a summary is persisted,
 *  cleared at a cold return.) The prompt after a native summary is the very return that made it. */
export function summarizedSince(branch: Any[], steerIds: Set<string>, models: Record<string, Entry>, tierOf: (model: Any) => "short" | "long" | undefined): boolean {
	let at = -1;
	branch.forEach((e, i) => { if (e?.type === "compaction" && e.details?.by === PRODUCT) at = i; });
	if (at < 0) return false;
	return coldReturnAfter(branch, at, branch[at].details?.via === "native", steerIds, models, tierOf) < 0;
}

/** `regrow` of the newest pi-zip summary on the branch (undefined: none, or one written before 0.3.0 kept no size). */
export const lastRegrow = (branch: Any[]): number | undefined => {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type === "compaction" && e.details?.by === PRODUCT) return typeof e.details.regrow === "number" && e.details.regrow > 0 ? e.details.regrow : undefined;
	}
	return undefined;
};

/** Summaries rules A/B started that went unused since the last cold return (their marker entries): what a process that never left
 *  would have counted. */
export function unusedSince(branch: Any[], steerIds: Set<string>, models: Record<string, Entry>, tierOf: (model: Any) => "short" | "long" | undefined): number {
	let n = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type !== "custom" || e.customType !== UNUSED_SUMMARY_CUSTOM || !e.data?.ab) continue;
		if (coldReturnAfter(branch, i, false, steerIds, models, tierOf) >= 0) break;
		n++;
	}
	return n;
}

/** One step of the growth estimate g: EWMA(0.1) of the prompt growth `d` between consecutive unedited responses of one model, each
 *  capped at the p90 of the last 20 deltas (run.ts learn and state.ts replayGrowth share it). */
export function grow(g: number, deltas: number[], d: number): { g: number; deltas: number[] } {
	const next = [...deltas.slice(-19), d];
	const sorted = [...next].sort((a, b) => a - b);
	return { g: 0.9 * g + 0.1 * Math.min(d, sorted[Math.ceil(0.9 * sorted.length) - 1]), deltas: next };
}

// ---- law ----------------------------------------------------------------------------------------------------------------------

/** The law's inputs at P(warm) `pWarm`: the class prices of Λ's model (its tier decides the 1-hour premium), growth g, P. */
export const lawOf = (branch: Any[], lam: Learned, pWarm: number): Law => ({ pr: lawPrices(lam.ent?.cls, resolveTtl(lam.model, branch, lam.tier).ms >= 3_600_000), g: lam.g, pWarm });

// ---- plan ---------------------------------------------------------------------------------------------------------------------

/** Plan options for `entries` (`pending`: the next prompt is not in them yet), with the token scale read from the branch. */
export function planOpts(entries: Any[], branch: Any[], env: Env, lam: Learned, pending: boolean, mode: "cold" | "warm", pWarm = mode === "cold" ? 0 : 1, cutAt?: string): { o: PlanOpts; cal: Scale } {
	const cal = scaleOf(entries, branch, env.sys, env.model ? modelKey(env.model) : undefined);
	const warmAgain = mode === "warm" && lam.summarizedWarm;
	return { cal, o: { mode, scale: cal, cwd: env.cwd, recalled: env.recalled, model: env.model, promptPending: pending, rereadOnly: env.rereadOnly, ...(env.fileRecall ? { fileRecall: env.fileRecall } : {}), noSummary: warmAgain, ...(warmAgain && lam.summaryRegrow ? { regrowAt: lam.summaryRegrow } : {}), reserve: env.reserve, steerIds: env.steerIds, law: lawOf(branch, lam, pWarm), trace: [], ...(cutAt !== undefined ? { cutAt } : {}) } };
}

/** The warm plan `first`, or, when it cuts elsewhere than the summary for `key` (written or being written), the plan cutting there
 *  (plan.ts cutAt) if the law accepts it: the summary already paid for is used instead of a new one. `note`: the pin, for the ledger. */
export function pin<T extends { p: PlanResult | null }>(first: T, mk: (cutAt: string) => T, key: string | null | undefined, where: string): { r: T; note?: Note } {
	const p = first.p;
	if (!key || !p || p.cutIdx === null || p.firstKeptEntryId === key) return { r: first };
	const q = mk(key);
	const ok = !!q.p && q.p.cutIdx !== null && q.p.firstKeptEntryId === key;
	return { r: ok ? q : first, note: { type: "pin", where, from: p.firstKeptEntryId, to: key, ok } };
}

// ---- decide -------------------------------------------------------------------------------------------------------------------

/** The background summary as a decision sees it: the cut it was written for, finished or not, failed. */
export interface BgView { key: string | null; done: unknown; failed: boolean }

/**
 * Rule B: a warm plan that summarises, while the user is here. "take": a finished summary for this cut is there. "running": one for
 * it is being written: nothing now. "start": nothing now, the summary is written in the background. "spent": nothing now and nothing
 * started (the warm stretch's budget of unused background summaries is spent, `room` false). "wait": written now while the user
 * waits: without a UI, or at Pi's compaction room (judged on the context as it is: nothing applied sends the request unchanged).
 */
export function ruleB(p: PlanResult, hasUI: boolean, bg: BgView | null, room: boolean): "wait" | "take" | "running" | "start" | "spent" {
	if (!hasUI || p.atRoom || p.atRoomUnedited) return "wait";
	if (bg && bg.key === p.firstKeptEntryId && !bg.failed) return bg.done ? "take" : "running";
	return room ? "start" : "spent";
}

/** The native summary of this run, as the run decision sees it: the projection right before Pi's compaction and that entry. */
export interface NativeIn { key: string; pre: Any[]; entryId: string }

/**
 * The run plan decision at a run's first request (one plan per edit run). `opts` gives the plan options of this run for some entries
 * (the shell's mode and P(warm)). b2b: a warm return right after an edited request makes no edit (unless Pi's compaction already put
 * this run's summary in). Otherwise the plan, pinned to the summary in the session (`nat`) or in the background (`bgKey`) when warm;
 * a summary Pi's compaction put in is planned on the projection before it (`onPre`), or on the session as it is when that plan cuts
 * elsewhere. `foreign`: another extension's compaction just went in: folds only.
 */
export function decideRun(x: { cold: boolean; pastTtl: boolean; justEdited: boolean; nat: NativeIn | null; foreign: boolean; now: Any[]; bgKey: string | null; opts: (entries: Any[], cutAt?: string) => { o: PlanOpts; cal: Scale } }):
	{ kind: "b2b" } | { kind: "plan"; o: PlanOpts; cal: Scale; p: PlanResult | null; onPre: boolean; notes: Note[] } {
	const { cold, nat } = x;
	const spliced = nat ? spliceNative(nat.pre, x.now, nat.entryId) : null;
	if (!cold && x.justEdited && !nat) return { kind: "b2b" };
	const notes: Note[] = [];
	const plan = (entries: Any[], cutAt?: string, asNative = false) => {
		const { o, cal } = x.opts(entries, cutAt);
		o.pastTtl = x.pastTtl;
		// the plan that carries the summary Pi's compaction just put in is made in the state nativeSummary planned it in: before that
		// summary, so it is not "a second summary in this warm stretch" (noSummary, regrowAt). Otherwise a real prompt a token smaller
		// than before_agent_start's estimate falls below regrowAt, the plan does not cut and the folds priced with it are dropped
		if (asNative) {
			o.noSummary = false;
			delete o.regrowAt;
		}
		if (x.foreign) o.noSummary = true; // another extension's compaction just went in: folds only (a summary only at Pi's compaction room)
		return { o, cal, p: planContext(entries, o) };
	};
	const warmPlan = (entries: Any[]) => {
		const first = plan(entries, undefined, !!nat);
		if (cold) return first;
		const { r, note } = pin(first, (k) => plan(entries, k, !!nat), nat ? nat.key : x.bgKey, "run");
		if (note) notes.push(note);
		return r;
	};
	let { o, cal, p } = warmPlan(spliced ?? x.now);
	const onPre = !!nat && !!spliced && !!p && p.cutIdx !== null && p.firstKeptEntryId === nat.key;
	if (nat && !onPre) {
		// the summary is in the session, but this plan would not cut there (the prompt, or what came with it, changed the plan): plan on
		// the session as it is now, with the summary at its head
		notes.push({ type: "native_mismatch", planned: p?.firstKeptEntryId ?? null, compacted: nat.key });
		({ o, cal, p } = plan(x.now));
	}
	return { kind: "plan", o, cal, p, onPre, notes };
}

/**
 * The run plan itself, once its summary is known (`cut`: adopted or written now; `native`: Pi's compaction took it). A plan that
 * cannot be persisted is never sent (I1): the guard drops the summary, or everything. Sizes: the notice's "before" is the number Pi's
 * compaction block shows when the summary went in natively.
 */
export function runPlanOf(x: { p: PlanResult | null; cal: Scale; cold: boolean; onPre: boolean; native: Cut | null; nat: { before: number; after: number } | null; folds: FoldTarget[]; cut: Cut | null; adopted: boolean; settleIds: string[]; ms: number; bgWaitMs: number }): { plan: RunPlan; folds: FoldTarget[]; cut: Cut | null; drop?: Note } {
	const { p, cal, cold, onPre, native, nat } = x;
	let folds = x.folds, cut = x.cut, drop: Note | undefined;
	const sameSet = x.settleIds.length === folds.length && x.settleIds.every((id) => folds.some((u) => u.entryId === id));
	const source: RunPlan["source"] = !cold ? "valve" : x.adopted || (x.settleIds.length > 0 && sameSet) ? "settle" : "runstart";
	if (p) {
		const invalid = checkEdits(p.blocks, p.userTurns, folds, cut ?? (onPre ? native : null));
		if (invalid) {
			drop = { type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length, summary: !!(cut ?? native) };
			if (native) folds = []; // the summary is in the session already: only the folds can be dropped
			else if (cut && checkEdits(p.blocks, p.userTurns, folds, null) === null) cut = null;
			else { folds = []; cut = null; }
		}
	}
	const sum = cut ?? (onPre ? native : null); // a summary this plan's sizes do not count yet
	let ctxBefore = p?.ctxTokens ?? 0;
	let ctxAfter = (p?.ctxAfterFolds ?? 0) - (sum ? cal.c * (sum.prefixTokens - sum.summaryTokens) : 0);
	if (nat) {
		ctxAfter = p ? ctxAfter + (onPre ? nat.before - ctxBefore : 0) : nat.after;
		ctxBefore = nat.before;
	}
	const plan: RunPlan = {
		source, folds: onPre ? rebaseFolds(folds, p!.cutVisibleIdx) : folds, cut, native: native ?? undefined, ctxBefore, ctxAfter, ms: x.ms, scale: cal, persisted: false,
		...(!cold && (native || (cut && x.adopted)) ? { ready: "away" as const } : {}),
		waitMs: cut ? (x.adopted ? x.bgWaitMs : cut.ms) : 0, cutVisibleIdx: p?.cutVisibleIdx ?? -1, cutKeptFirstMsg: p?.cutKeptFirstMsg, untouched: p ? sizeOf(cal, untouchedEst(p.blocks, folds, !!(cut ?? native))) : sizeOf(cal, 0),
	};
	return { plan, folds, cut, ...(drop ? { drop } : {}) };
}

/** The warm decision at a turn_end that has no run plan to persist: none after a failed turn or right after an edited request (b2b),
 *  else the warm plan (P = 1 in-run), pinned to the background summary; `p` null when it changes nothing. */
export function decideTurnEnd(x: { failed: boolean; justEdited: boolean; bgKey: string | null; opts: (cutAt?: string) => { o: PlanOpts }; entries: Any[] }): { kind: "none" } | { kind: "b2b" } | { kind: "plan"; o: PlanOpts; p: PlanResult | null; notes: Note[] } {
	if (x.failed) return { kind: "none" };
	if (x.justEdited) return { kind: "b2b" };
	const mk = (cutAt?: string) => {
		const { o } = x.opts(cutAt);
		return { o, p: planContext(x.entries, o) };
	};
	const { r, note } = pin(mk(), mk, x.bgKey, "turn_end");
	const p = r.p && (r.p.folds.length || r.p.cutIdx !== null) ? r.p : null;
	return { kind: "plan", o: r.o, p, notes: note ? [note] : [] };
}

/** The valve plan of a turn_end (persisted at once; `cut`: its summary, adopted or written now). */
export const valvePlanOf = (p: PlanResult, cut: Cut | null, adopted: boolean, bgWaitMs: number, ms: number): RunPlan => ({
	source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds - (cut ? p.scale.c * (cut.prefixTokens - cut.summaryTokens) : 0), ms, scale: p.scale, persisted: false,
	untouched: sizeOf(p.scale, untouchedEst(p.blocks, p.folds, !!cut)), ...(cut ? { waitMs: adopted ? bgWaitMs : cut.ms } : {}), ...(cut && adopted ? { ready: "background" as const } : {}),
});

/** The plans at settle: the cold return's (`cold`) and, unless the newest request carried an edit (b2b), the warm return's (`warm`,
 *  pinned to the background summary). */
export function decideSettle(x: { justEdited: boolean; bgKey: string | null; entries: Any[]; cold: () => { o: PlanOpts; cal: Scale }; warm: (cutAt?: string) => { o: PlanOpts } }): { p: PlanResult | null; cal: Scale; w: PlanResult | null; notes: Note[] } {
	const { o, cal } = x.cold();
	const p = planContext(x.entries, o);
	let w: PlanResult | null = null;
	const notes: Note[] = [];
	if (!x.justEdited) {
		const mk = (cutAt?: string) => ({ p: planContext(x.entries, x.warm(cutAt).o) });
		const { r, note } = pin(mk(), mk, x.bgKey, "settle");
		if (note) notes.push(note);
		w = r.p;
	}
	return { p, cal, w, notes };
}
