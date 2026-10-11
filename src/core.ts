// The decision core: view, clock, law, plan and decide as pure functions of the session branch, what pi-zip has learned (Λ) and
// the time. Nothing here reads a file, Pi or the clock, and nothing here has an effect: run.ts (the shell) gathers the inputs at Pi's
// events, keeps what only the process holds (the summary call in the background, the timers) and carries out what these return.
import { detectCold, modelKey, resolveTtl, type ColdInfo } from "./cache.ts";
import { validateEdits } from "./guard.ts";
import { lawPrices, pWarm, type Entry } from "./learn.ts";
import { calibrate, planContext, rebaseFolds, sizeOf, spliceNative, untouchedEst, UNIT, type Block, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
import type { FileRecall } from "./recallfile.ts";
import { PRODUCT, type Any } from "./util.ts";

export const SUMMARY_CUSTOM = "pi-zip/summary"; // a summary call pi-zip made in the background: what it produced (or that it was lost) and its cost

/** A `pi-zip/summary` entry: the summary written for the cut at entry `key` of the projection whose head is `head` (the id of the
 *  branch's newest compaction, "" before any), and what the call cost. Without `cut`, a call that ended without a summary it could
 *  hand over (aborted when it was replaced or pi-zip was switched off, or still running when the process exited): unused, its cost
 *  `estimated` from the input it is billed for. A summary is READY while its head is the branch's head; using it (a compaction with its
 *  text) or any other compaction moves the head, so it is never taken twice. */
export interface Artifact {
	head: string;
	key: string;
	cut?: Cut;
	usd: number;
	estimated?: boolean;
	lost?: string;
}

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
	return validateEdits(blocks, { folds: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.ph])), recover: new Map(live.map((t) => [byId.get(t.entryId)!.idx, t.recover])), cut: cutBlock ? cutBlock.idx : null }, userTurns);
}

// ---- clock --------------------------------------------------------------------------------------------------------------------

/** The return a request sent at `nowMs` would be: P(warm) (cold = P < 0.5), the gap and whether the absence was a pause.
 *  `last`: the shell's own clock of the newest request and its model (0 and "" read both from the branch). */
export const clock = (branch: Any[], lam: Pick<Learned, "model" | "ent" | "tier">, nowMs: number, last: { reqMs: number; modelKey: string } = { reqMs: 0, modelKey: "" }): ColdInfo =>
	detectCold(lam.model, last.reqMs, branch, nowMs, last.modelKey, (g, prior) => pWarm(lam.ent, g, prior), lam.tier);

/** P(warm) inside a run, at a turn_end: the same learned curve, at the gap since the newest response (the last touch of the cache;
 *  the tool results after it touched nothing), so a long tool call counts as the absence it is. Never a pause (nobody left). */
export function inRunClock(branch: Any[], lam: Pick<Learned, "model" | "ent" | "tier">, nowMs: number, last: { reqMs: number; modelKey: string }): ColdInfo {
	let n = branch.length;
	while (n > 0 && !(branch[n - 1]?.type === "message" && branch[n - 1].message?.role === "assistant")) n--;
	return { ...clock(branch.slice(0, n), lam, nowMs, last), pause: false };
}

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

/** The head of the projection the branch builds: the id of its newest compaction, "" before any. */
export function headOf(branch: Any[]): string {
	for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.type === "compaction") return String(branch[i].id ?? "");
	return "";
}

/** The `pi-zip/summary` entries of the branch, oldest first. */
export const artifactsOf = (branch: Any[]): Artifact[] =>
	branch.filter((e) => e?.type === "custom" && e.customType === SUMMARY_CUSTOM && typeof e.data?.key === "string").map((e) => e.data as Artifact);

/** The READY summaries: produced for the projection the branch builds now (its head), from the branch's entries and `extra` (those
 *  this process produced, written or not yet), one per cut (the newest). */
export function readyOf(branch: Any[], extra: readonly Artifact[] = []): Artifact[] {
	const head = headOf(branch);
	const byKey = new Map<string, Artifact>();
	for (const a of [...artifactsOf(branch), ...extra]) if (a.cut && a.head === head) byKey.set(a.key, a);
	return [...byKey.values()];
}

/** The summary calls of the branch that no compaction used (a summary nobody took, or a call that ended without one), and their cost:
 *  what keeps the session totals honest. */
export function unusedOf(branch: Any[]): { n: number; usd: number } {
	const used = new Set(branch.filter((e) => e?.type === "compaction" && e.details?.by === PRODUCT).map((e) => `${e.firstKeptEntryId}\u0000${e.summary}`));
	let n = 0, usd = 0;
	for (const a of artifactsOf(branch)) {
		if (a.cut && used.has(`${a.key}\u0000${a.cut.text}`)) continue;
		n++;
		usd += Number(a.usd) || 0;
	}
	return { n, usd };
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

/** Plan options for `entries` (`pending`: the next prompt is not in them yet) at P(warm) `pWarm`, after a pause or not, with the token
 *  scale read from the branch. P goes into the law only; the one exception until it is dropped is the one summary per warm stretch
 *  (noSummary: at P >= 0.5, once a summary was made since the last cold return, until the context has grown back). */
export function planOpts(entries: Any[], branch: Any[], env: Env, lam: Learned, pending: boolean, pWarm: number, pause: boolean, cutAt?: string): { o: PlanOpts; cal: Scale } {
	const cal = scaleOf(entries, branch, env.sys, env.model ? modelKey(env.model) : undefined);
	const warmAgain = pWarm >= 0.5 && lam.summarizedWarm;
	return { cal, o: { pause, scale: cal, cwd: env.cwd, recalled: env.recalled, model: env.model, promptPending: pending, rereadOnly: env.rereadOnly, ...(env.fileRecall ? { fileRecall: env.fileRecall } : {}), noSummary: warmAgain, ...(warmAgain && lam.summaryRegrow ? { regrowAt: lam.summaryRegrow } : {}), reserve: env.reserve, steerIds: env.steerIds, law: lawOf(branch, lam, pWarm), trace: [], ...(cutAt !== undefined ? { cutAt } : {}) } };
}

/** A summary a plan may take: produced and ready (`running` false), or still being written. */
export interface Avail { key: string; running: boolean }

/** The plan `first`, or, when a summary produced or being produced (`avail`) cuts no deeper than its cut, the plan cutting at the
 *  deepest such summary (plan.ts cutAt) if the law accepts it: a call already paid for is used instead of a new one, and never for a
 *  cut deeper than the plan asks for. `note`: the adoption, for the ledger (`running`: the summary is not written yet). */
export function adopt<T extends { p: PlanResult | null }>(first: T, mk: (cutAt: string) => T, avail: readonly Avail[], where: string): { r: T; note?: Note } {
	const p = first.p;
	if (!avail.length || !p || p.cutIdx === null) return { r: first };
	let at = -1, pick: Avail | null = null;
	for (const a of avail) {
		const i = p.blocks.findIndex((b) => b.entryId === a.key);
		if (i >= 0 && i <= p.cutIdx && i > at) [at, pick] = [i, a];
	}
	if (!pick || pick.key === p.firstKeptEntryId) return { r: first };
	const q = mk(pick.key);
	const ok = !!q.p && q.p.cutIdx !== null && q.p.firstKeptEntryId === pick.key;
	return { r: ok ? q : first, note: { type: "pin", where, from: p.firstKeptEntryId, to: pick.key, ok, ...(pick.running ? { running: true } : {}) } };
}

// ---- decide -------------------------------------------------------------------------------------------------------------------

/**
 * Rule B: a warm plan that summarises, while the user is here. "take": the summary for this cut is ready. "running": it is being
 * written: nothing now. "start": nothing now, the summary is written in the background. "wait": written now while the user waits:
 * without a UI, or at Pi's compaction room (judged on the context as it is: nothing applied sends the request unchanged).
 */
export function ruleB(p: PlanResult, hasUI: boolean, avail: readonly Avail[]): "wait" | "take" | "running" | "start" {
	if (!hasUI || p.atRoom || p.atRoomUnedited) return "wait";
	const a = avail.find((x) => x.key === p.firstKeptEntryId);
	return a ? (a.running ? "running" : "take") : "start";
}

/** The native summary of this run, as the run decision sees it: the projection right before Pi's compaction and that entry. */
export interface NativeIn { key: string; pre: Any[]; entryId: string }

/**
 * The run plan decision at a run's first request (one plan per edit run). `opts` gives the plan options of this run for some entries
 * (the shell's P(warm) and pause). b2b: a warm return right after an edited request makes no edit (unless Pi's compaction already put
 * this run's summary in). Otherwise the plan, taking the summary in the session (`nat`) or a produced one (`avail`, adopt);
 * a summary Pi's compaction put in is planned on the projection before it (`onPre`), or on the session as it is when that plan cuts
 * elsewhere. `foreign`: another extension's compaction just went in: folds only.
 */
export function decideRun(x: { cold: boolean; justEdited: boolean; nat: NativeIn | null; foreign: boolean; now: Any[]; avail: readonly Avail[]; opts: (entries: Any[], cutAt?: string) => { o: PlanOpts; cal: Scale } }):
	{ kind: "b2b" } | { kind: "plan"; o: PlanOpts; cal: Scale; p: PlanResult | null; onPre: boolean; notes: Note[] } {
	const { cold, nat } = x;
	const spliced = nat ? spliceNative(nat.pre, x.now, nat.entryId) : null;
	if (!cold && x.justEdited && !nat) return { kind: "b2b" };
	const notes: Note[] = [];
	const plan = (entries: Any[], cutAt?: string, asNative = false) => {
		const { o, cal } = x.opts(entries, cutAt);
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
	const adopted = (entries: Any[]) => {
		const first = plan(entries, undefined, !!nat);
		const { r, note } = adopt(first, (k) => plan(entries, k, !!nat), nat ? [{ key: nat.key, running: false }] : x.avail, "run");
		if (note) notes.push(note);
		return r;
	};
	let { o, cal, p } = adopted(spliced ?? x.now);
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

/** The decision at a turn_end that has no run plan to persist: none after a failed turn, nothing right after an edited request while
 *  the cache is believed warm (b2b), else the plan at the in-run P(warm) `pWarm` (core.ts inRunClock), taking a produced summary
 *  (adopt); `p` null when it changes nothing. */
export function decideTurnEnd(x: { failed: boolean; justEdited: boolean; pWarm: number; avail: readonly Avail[]; opts: (cutAt?: string) => { o: PlanOpts }; entries: Any[] }): { kind: "none" } | { kind: "b2b" } | { kind: "plan"; o: PlanOpts; p: PlanResult | null; notes: Note[] } {
	if (x.failed) return { kind: "none" };
	if (x.justEdited && x.pWarm >= 0.5) return { kind: "b2b" };
	const mk = (cutAt?: string) => {
		const { o } = x.opts(cutAt);
		return { o, p: planContext(x.entries, o) };
	};
	const { r, note } = adopt(mk(), mk, x.avail, "turn_end");
	const p = r.p && (r.p.folds.length || r.p.cutIdx !== null) ? r.p : null;
	return { kind: "plan", o: r.o, p, notes: note ? [note] : [] };
}

/** The valve plan of a turn_end (persisted at once; `cut`: its summary, adopted or written now). */
export const valvePlanOf = (p: PlanResult, cut: Cut | null, adopted: boolean, bgWaitMs: number, ms: number): RunPlan => ({
	source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds - (cut ? p.scale.c * (cut.prefixTokens - cut.summaryTokens) : 0), ms, scale: p.scale, persisted: false,
	untouched: sizeOf(p.scale, untouchedEst(p.blocks, p.folds, !!cut)), ...(cut ? { waitMs: adopted ? bgWaitMs : cut.ms } : {}), ...(cut && adopted ? { ready: "background" as const } : {}),
});

/** The plans at settle: the return after a pause (`cold`: P = 0, pause) and, unless the newest request carried an edit (b2b), the
 *  return within the cache life (`warm`: P = 1), each taking a produced summary (adopt). */
export function decideSettle(x: { justEdited: boolean; avail: readonly Avail[]; entries: Any[]; cold: (cutAt?: string) => { o: PlanOpts; cal: Scale }; warm: (cutAt?: string) => { o: PlanOpts } }): { p: PlanResult | null; cal: Scale; w: PlanResult | null; notes: Note[] } {
	const notes: Note[] = [];
	const mc = (cutAt?: string) => {
		const { o, cal } = x.cold(cutAt);
		return { cal, p: planContext(x.entries, o) };
	};
	const c = adopt(mc(), mc, x.avail, "settle_cold");
	if (c.note) notes.push(c.note);
	const { p, cal } = c.r;
	let w: PlanResult | null = null;
	if (!x.justEdited) {
		const mk = (cutAt?: string) => ({ p: planContext(x.entries, x.warm(cutAt).o) });
		const { r, note } = adopt(mk(), mk, x.avail, "settle");
		if (note) notes.push(note);
		w = r.p;
	}
	return { p, cal, w, notes };
}
