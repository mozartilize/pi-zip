// The decision core: view, clock, law, plan and decide as pure functions of the session branch, what pi-zip has learned (Λ) and
// the time. Nothing here reads a file, Pi or the clock, and nothing here has an effect: run.ts (the shell) gathers the inputs at Pi's
// events, keeps what only the process holds (the summary call in the background, the timers) and carries out what these return.
import { detectCold, modelKey, resolveTtl, type ColdInfo } from "./cache.ts";
import { validateEdits } from "./guard.ts";
import { GAP_EDGES, lawPrices, pWarm, type Entry } from "./learn.ts";
import { buildBlocks, calibrate, compactionRoom, planContext, sizeOf, untouchedEst, UNIT, type Block, type Cut, type FoldTarget, type Law, type PlanOpts, type PlanResult, type RunPlan, type Scale, type SysInfo } from "./plan.ts";
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
export function planOpts(entries: Any[], branch: Any[], env: Env, lam: Learned, pending: boolean, pWarm: number, pause: boolean, cutAt?: string, foldsOnly = false, ready?: readonly string[]): { o: PlanOpts; cal: Scale } {
	const cal = scaleOf(entries, branch, env.sys, env.model ? modelKey(env.model) : undefined);
	const warmAgain = pWarm >= 0.5 && lam.summarizedWarm;
	return { cal, o: { pause, scale: cal, cwd: env.cwd, recalled: env.recalled, model: env.model, promptPending: pending, rereadOnly: env.rereadOnly, ...(env.fileRecall ? { fileRecall: env.fileRecall } : {}), noSummary: warmAgain, ...(warmAgain && lam.summaryRegrow ? { regrowAt: lam.summaryRegrow } : {}), reserve: env.reserve, steerIds: env.steerIds, law: lawOf(branch, lam, pWarm), trace: [], ...(cutAt !== undefined ? { cutAt } : {}), ...(foldsOnly ? { foldsOnly } : {}), ...(ready?.length ? { ready } : {}) } };
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

/** An unready summary (theory 1.4 decide): a plan whose cut is not ready (no produced summary for it in `ready`) gives way to the plan
 *  of its folds alone, judged by the law with no call (`foldsOnly`: null when the law refuses them), and its cut is produced in the
 *  background (`produce`). Nobody waits for it: the next decision after it is ready takes it. */
export function unready<T extends { p: PlanResult | null }>(r: T, ready: readonly Avail[], foldsOnly: () => T): { r: T; produce: PlanResult | null } {
	const p = r.p;
	if (!p || p.cutIdx === null || ready.some((a) => !a.running && a.key === p.firstKeptEntryId)) return { r, produce: null };
	return { r: foldsOnly(), produce: p };
}

/** One candidate search and ready-summary adoption, shared by decisions and production. */
export function candidateOf(entries: Any[], opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal?: Scale }, avail: readonly Avail[], where: string, foldsOnly = false) {
	const mk = (cutAt?: string) => {
		const { o, cal } = opts(cutAt, foldsOnly, avail.map((a) => a.key));
		return { o, cal: o.scale ?? cal ?? UNIT, p: planContext(entries, o) };
	};
	return adopt(mk(), mk, avail, where);
}

/** The application rules have one implementation for prompts, first requests and boundaries. First requests defer summaries;
 *  native first requests retain the prompt's already priced decision. b2b blocks application only, never production or the room. */
export function decideEdits(x: { at: "native" | "run" | "turn_end"; justEdited: boolean; pWarm: number; entries: Any[]; ready: readonly Avail[];
	opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal?: Scale } }) {
	const { r: first, note } = candidateOf(x.entries, x.opts, x.ready.filter((a) => !a.running), x.at);
	const p = first.p, has = p && p.cutIdx !== null && x.ready.some((a) => a.key === p.firstKeptEntryId);
	const produce = p && p.cutIdx !== null && !has ? p : null;
	if (x.justEdited && x.pWarm >= 0.5) return { kind: "b2b" as const, ...first, p: null, notes: [], produce };
	const deferred = x.at === "run" && p && p.cutIdx !== null;
	const u = unready(first, deferred ? [] : x.ready, () => candidateOf(x.entries, x.opts, [], x.at, true).r);
	return { kind: "plan" as const, ...u.r, notes: [...(note ? [note] : []), ...(deferred && has ? [{ type: "defer", key: p.firstKeptEntryId } as Note] : [])], produce };
}

/** A native prompt carries its jointly priced folds; other first requests defer summaries to turn_end. */
export function decideRun(x: { cold: boolean; justEdited: boolean; nat: { o: PlanOpts; cal: Scale; p: PlanResult } | null; foreign: boolean; now: Any[]; ready: readonly Avail[]; opts: (entries: Any[], cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts; cal: Scale } }) {
	if (x.nat) return { kind: "plan" as const, ...x.nat, notes: [], produce: null };
	return decideEdits({ at: "run", justEdited: x.justEdited, pWarm: x.cold ? 0 : 1, entries: x.now, ready: x.ready,
		opts: (cutAt, foldsOnly, ready) => {
			const r = x.opts(x.now, cutAt, foldsOnly, ready);
			if (x.foreign) r.o.noSummary = true;
			return r;
		} });
}

/** Native folds retain the prompt decision and use entry IDs to find their positions; other folds are guarded before sending. */
export function runPlanOf(x: { p: PlanResult | null; cal: Scale; cold: boolean; native: Cut | null; nat: { before: number; after: number } | null; folds: FoldTarget[]; settleIds: string[]; ms: number; now?: Any[] }): { plan: RunPlan; folds: FoldTarget[]; drop?: Note } {
	const { p, cal, cold, native, nat } = x;
	let folds = x.folds, drop: Note | undefined;
	const sameSet = x.settleIds.length === folds.length && x.settleIds.every((id) => folds.some((u) => u.entryId === id));
	const source: RunPlan["source"] = !cold ? "valve" : native || (x.settleIds.length > 0 && sameSet) ? "settle" : "runstart";
	if (native && p) {
		const positions = new Map((x.now ?? []).flatMap((e) => (e.messages ?? []).filter((m: Any) => m.role !== "system").map(() => e.sourceEntry?.id)).map((id, visIdx) => [id, visIdx]));
		folds = folds.map((t) => {
			const visIdx = positions.get(t.entryId);
			if (visIdx === undefined) throw new Error("native fold target must be kept after the cut");
			return { ...t, visIdx };
		});
	} else if (p) {
		const invalid = checkEdits(p.blocks, p.userTurns, folds, null);
		if (invalid) {
			drop = { type: "guard_drop", where: "run_plan", reason: invalid, folds: folds.length, summary: false };
			folds = [];
		}
	}
	const plan: RunPlan = {
		source, folds, cut: null, native: native ?? undefined, ctxBefore: nat?.before ?? p?.ctxTokens ?? 0,
		ctxAfter: nat?.after ?? p?.ctxAfterFolds ?? 0, ms: x.ms, scale: cal, persisted: false,
		...(!cold && native ? { ready: "away" as const } : {}), waitMs: 0,
		untouched: p ? sizeOf(cal, untouchedEst(p.blocks, folds, !!native)) : sizeOf(cal, 0),
	};
	return { plan, folds, ...(drop ? { drop } : {}) };
}

/** Reconcile carried folds before selection: the planner keeps their exact placeholders and prices the resulting union.
 *  The same selected edit supplies the single post-edit room judgement and the boundary commit. */
export function decideTurnEnd(x: { failed: boolean; justEdited: boolean; pWarm: number; ready: readonly Avail[]; opts: (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => { o: PlanOpts }; entries: Any[]; runPlan?: RunPlan | null }) {
	const blocks = buildBlocks(x.entries), live = new Set(blocks.filter((b) => !b.edited).map((b) => b.entryId));
	const carried = x.runPlan ? { ...x.runPlan, folds: x.runPlan.folds.filter((t) => live.has(t.entryId) && (!x.runPlan!.applied || x.runPlan!.applied.has(t.entryId))) } : null;
	if (x.failed) return { kind: "none" as const, runPlan: carried };
	const opts = (cutAt?: string, foldsOnly?: boolean, ready?: readonly string[]) => {
		const r = x.opts(cutAt, foldsOnly, ready);
		if (carried) { r.o.scale = carried.scale; r.o.carriedFolds = carried.folds; }
		return r;
	};
	const d = decideEdits({ ...x, at: "turn_end", opts });
	const before = sizeOf(d.cal, blocks.reduce((n, b) => n + b.tokens, 0));
	const after = d.p ? d.p.ctxAfterFolds - d.p.scale.c * (d.p.prefixTokens - d.p.summaryTokensPlanned)
		: before - d.cal.c * (d.o.carriedFolds ?? []).reduce((n, t) => n + t.entryTokens - t.phTokens, 0);
	const room = roomOf(after, d.o, () => candidateOf(x.entries, opts, [], "room").r.p, d.p?.firstKeptEntryId ?? undefined);
	return { ...d, produce: room ? null : d.produce, room, runPlan: carried };
}

/** The one wait (theory 1.4 R9): when the view after a turn_end's edit (`after`) is still at Pi's compaction room, the plan at the
 *  in-run p with no pause and no ready summaries (`plan`: every call priced), if it has a cut c′ (which then passed the law with its
 *  call) other than the one the edit takes already (`taken`); else null. `o`: the decision's options (model, reserve). */
export function roomOf(after: number, o: PlanOpts, plan: () => PlanResult | null, taken?: string): PlanResult | null {
	const room = compactionRoom(o.model, o.reserve);
	if (room === null || after < room) return null;
	const c = plan();
	return c && c.cutIdx !== null && c.firstKeptEntryId !== taken ? c : null;
}

/** The valve plan of a turn_end (persisted at once; `cut`: its summary, ready, or the room wait's; `waitMs`: the room wait). */
export const valvePlanOf = (p: PlanResult, cut: Cut | null, ready: boolean, waitMs: number, ms: number): RunPlan => ({
	source: "valve", folds: p.folds, cut, ctxBefore: p.ctxTokens, ctxAfter: p.ctxAfterFolds - (cut ? p.scale.c * (cut.prefixTokens - cut.summaryTokens) : 0), ms, scale: p.scale, persisted: false,
	untouched: sizeOf(p.scale, untouchedEst(p.blocks, p.folds, !!cut)), ...(cut ? { waitMs } : {}), ...(cut && ready ? { ready: "background" as const } : {}),
});

/** One producer rule, triggered by a decision, settle, or the timer. Decisions supply the cut their call-priced plan wants.
 *  Settle also asks about a return at 30 s; the timer asks only about the first paying pause. Produced/running cuts are never
 *  produced again. The timer's deadline remains relative to the last touch, so re-planning cannot slide it into the future. */
export function want(x: { at: "decision" | "settle" | "timer"; now: number; lastTouch: number; ttlMs: number; survival: (gapS: number) => number;
	avail: readonly Avail[]; candidate?: PlanResult | null; plan: (p: number, pause: boolean, avail: readonly Avail[]) => PlanResult | null;
	latency: (p: PlanResult) => number }): { p: PlanResult; start: number; gapS?: number } | null {
	const fresh = (p: PlanResult | null | undefined) => p && p.cutIdx !== null && !x.avail.some((a) => a.key === p.firstKeptEntryId) ? p : null;
	if (x.at === "decision") {
		const p = fresh(x.candidate);
		return p ? { p, start: x.now } : null;
	}
	if (!x.lastTouch) return null;
	if (x.at === "settle") {
		const p = fresh(x.plan(x.survival(30), false, x.avail));
		if (p && !x.avail.some((a) => a.running)) return { p, start: x.now };
	}
	// A summary already produced (or running) that the cold return can take covers that return.
	const cold = x.plan(0, true, x.avail);
	if (cold?.cutIdx !== null && cold && x.avail.some((a) => a.key === cold.firstKeptEntryId)) return null;
	const tau = x.ttlMs / 1000;
	const gaps = [...new Set([tau, tau + 1, ...GAP_EDGES.filter((g) => g >= tau).flatMap((g) => [g, g + 1]), 7200])].sort((a, b) => a - b);
	for (const gapS of gaps) {
		const p = x.plan(x.survival(gapS), true, []);
		if (!p || p.cutIdx === null) continue;
		if (!fresh(p)) return null;
		return { p, start: x.lastTouch + gapS * 1000 - 1.5 * x.latency(p), gapS };
	}
	return null;
}
