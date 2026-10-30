// Fork planner: plan(), selectPlan() and planContext() with the summary pressure gates, judge reordering, tier-merge reserve,
// checkpoint refresh and model-switch rescue. Upstream's planner in plan.ts is kept unmodified (unused at runtime) so upstream
// syncs merge cleanly; port wanted upstream planner fixes here.
import { ACTIVE_INPUT_TOKENS, estimateMergeWork, type MergeWork } from "./summary-engine.ts";
import { classifyRecoverability, type Recover } from "./read-policy.ts";
import { handleFor, shortArgs } from "./fold-format.ts";
import { callOf, foldCandidates, foldPlaceholder, type Call } from "./fold-policy.ts";
import { recordSummaryPressure, summaryPrepareThreshold, type SummaryGate } from "./summary-pressure.ts";
import { lawPrices } from "./learn.ts";
import {
	buildBlocks, coldTarget, compactionRoom, contentKeyOf, countUserTurns, G0, guardTerms, isCutBlock, lawTerms, NARRATIVE_MAX, openStarter,
	PI_KEEP_RECENT, settings, sizeOf, toolCallIndex, UNIT, untouchedEst, type Block, type FoldTarget, type Law, type PlanOpts, type PlanResult,
} from "./plan.ts";
import { type Any, clamp, textOf } from "./util.ts";

export type Verdict = "cold" | "warm" | "hot" | "need";

// Fork fields on upstream's planner types (module augmentation: plan.ts stays byte-identical in these declarations).
declare module "./plan.ts" {
	interface Cut {
		predictedMergeCostUsd?: number;
		actualMergeCostUsd?: number;
		reason?: string; // e.g. "request-budget-overflow" when protected user requests exceed the available summary budget/room
		overflow?: { requiredTokens: number; availableTokens: number };
		summaryDiagnostics?: Record<string, unknown>;
	}
	interface PlanOpts {
		verdicts?: ReadonlyMap<string, Verdict>;
		/** Ledger only: candidate eligibility and the final application decision, populated by core.decideEdits. */
		foldDecision?: {
			reason: "selected" | "back-to-back" | "guard-rejected" | "no-plan";
			outputs: Array<{ h: string; age: number; verdict: Verdict | "unscored"; group: number | null; planned: boolean; selected: boolean }>;
		};
		/** Output diagnostic, overwritten on each plan; sizes are calibrated whole-context tokens. */
		summaryGate?: SummaryGate;
		/** Newest message time (ms) in the view this plan was made from, stamped into new placeholders: every request before it saw the
		 *  output in full. Taken from the session, not the clock, so the same view always renders the same placeholder bytes. */
		foldedAt?: number;
		/** Model-switch rescue: the context must fit a smaller window, and the alternative is Pi's own summary or an overflow, so the
		 *  law's price never refuses the cut. `cutLatest`: a cut may enter the protected turns, up to and keeping the current user
		 *  message. `force`: these outputs fold whatever their turn or age (chosen by the caller, biggest first, only as needed). */
		rescue?: { cutLatest?: boolean; force?: ReadonlySet<string> };
	}
	interface PlanResult {
		judged?: { folds: FoldTarget[]; ctxAfterFolds: number }; // alternate folds, applied only AFTER the unchanged law accepts this plan
		/** Hard bound (estimate units): the largest summary whose compacted view still stays below the model's room. Absent: no known window. */
		summaryRoomTokens?: number;
		mergeWork?: MergeWork; // reserved tier-merge input/output tokens for production, not a ready summary's sunk cost
	}
}

const PROTECT_USER_TURNS = 2; // as plan.ts
const SUMMARY_FLOOR = 1000; // as plan.ts
const SUMMARY_CAP = 8000; // as plan.ts
const SUMMARY_RATIO = 0.1; // as plan.ts
export { DEFAULT_SUMMARY_WINDOW, SUMMARY_PRESSURE_CAP, summaryThreshold, summaryPrepareThreshold } from "./summary-pressure.ts";
export type { Call };

/** The planner: one plan, whatever the cache is believed to be. Below the working view W (the cold target) it plans nothing. Above
 *  it, eligible outputs fold biggest first, class by class, until the view is at W: those of user turns older than the previous one;
 *  after a pause (PlanOpts.pause), the previous turn's re-readable outputs; those of the protected turns at least INTURN_AGE requests
 *  old. Only at min(80% of Pi's compaction room, 400K) after folds, one summary: the first cut from the one reaching W whose summary pays with its call, and with
 *  which the whole plan pays (folds inside the prefix are void). Then the whole plan must pay. P(warm) enters only the law (o.law), so
 *  a lower P never plans less. The target never exceeds Pi's compaction room. null: nothing to plan, or the law refuses. */
export function plan(entries: Any[], o: PlanOpts): { f: PlanResult; c: PlanResult | null; a: PlanResult | null; stuck?: boolean } | null {
	const s = settings();
	// limits are in real tokens; the plan works in content estimate units (real = O + c x estimate), so they are converted once, here.
	// The cold cap is on the whole context, but leaves at least half of itself for the conversation above O (coldTarget): a cap the
	// fixed prefix alone fills is out of reach, and every return then folds all it may and summarises. The compaction room is Pi's
	// trigger on the whole context.
	const { O, c } = o.scale ?? UNIT;
	const real = (est: number) => O + c * est;
	const room = compactionRoom(o.model, o.reserve);
	const coldCap = (coldTarget(o.coldCap ?? s.coldCap, O, room) - O) / c;
	const law: Law = o.law ?? { pr: lawPrices(undefined, false), g: G0, pWarm: 0 };
	// `cut`: a whole-plan step records whether the plan it judges has a cut (and so carries its summary call); the formal checker pins the
	// call to 0 for a folds-only plan and to the summary step's call for a cut; `ready`: the cut's summary is ready (its call is 0);
	// `key`: a summary step's cut (its first kept entry)
	const gate = (where: "summary" | "plan" | "guard", B: number, A: number, r: number | null, call: number, T: number, Tsuf?: number, cut?: boolean, isReady?: boolean, key?: string): boolean => {
		const t = lawTerms(B, A, law.pWarm, r, law.pr, law.g, call, T, o.keep);
		o.trace?.push({ where, ...t, ...(r !== null ? { keep: o.keep } : {}), ...(Tsuf !== undefined ? { Tsuf } : {}), ...(cut !== undefined ? { cut } : {}), ...(isReady ? { ready: true } : {}), ...(key !== undefined ? { key } : {}) });
		return t.ok;
	};
	let judging = false, target = coldCap, minIdx = 0;
	delete o.summaryGate;
	const blocks = buildBlocks(entries, o.steerIds);
	if (!blocks.length) return null;
	const userTurns = countUserTurns(blocks) + (o.promptPending && !openStarter(blocks) ? 1 : 0); // the upcoming prompt is a new user turn (unless it joins an open starter)
	const calls = toolCallIndex(blocks);
	const recalled = o.recalled ?? new Set<string>();
	const ctxEst = blocks.reduce((a, b) => a + b.tokens, 0); // content
	const recordPressure = (after: number) => recordSummaryPressure(o, real(ctxEst), real(after), real(coldCap), room);
	recordPressure(ctxEst);
	let tail = 0;
	for (let i = blocks.length - 1; i >= 0 && tail < PI_KEEP_RECENT; i--) tail += c * blocks[i].tokens;
	o.keep = tail;
	if (!(ctxEst > coldCap)) return null; // below the working view nothing is planned (I6)
	const trig = law.pWarm < 0.5 ? "cold" : "valve"; // a label for the ledger and the summary's trigger only
	const tokOverride = new Map<number, number>();
	const folds: FoldTarget[] = [...(o.carriedFolds ?? [])];
	for (const t of folds) tokOverride.set(blocks.findIndex((b) => b.entryId === t.entryId), t.phTokens);
	const visOfBlock: number[] = []; // block idx -> index among the non-system projected messages (the numbering a request view uses)
	{
		let vis = 0;
		for (const pe of entries) {
			const msgs: Any[] = pe.messages ?? [];
			if (!msgs.length) continue;
			visOfBlock.push(vis);
			for (const m of msgs) if (String(m?.role ?? "") !== "system") vis++;
		}
	}
	const classify = (b: Block): Recover => {
		const call = callOf(calls, b.msg);
		return classifyRecoverability(call?.name ?? b.msg.toolName ?? "", call?.args, textOf((b.raw ?? b.msg).content), o.cwd, (b.raw ?? b.msg).content);
	};
	const addFold = (b: Block, trig: string): boolean => {
		if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false; // F4: never refold what the model recalled
		const replacement = foldPlaceholder(b, calls, o);
		if (!replacement) return false;
		const { ph, phTok } = replacement;
		tokOverride.set(b.idx, phTok);
		const call = callOf(calls, b.msg);
		folds.push({ entryId: b.entryId!, toolCallId: b.msg.toolCallId, visIdx: visOfBlock[b.idx] ?? -1, contentKey: contentKeyOf(b.msg.content), tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", entryTokens: b.tokens, phTokens: phTok, ph, trig, recover: classify(b), ...(o.verdicts?.size ? { verdict: verdict(b) ?? "unscored" } : {}) });
		return true;
	};
	const candidates = foldCandidates(blocks, calls, o);
	const protectedTurn = (b: Block) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1;
	const savings = () => folds.reduce((a, t) => a + t.entryTokens - t.phTokens, 0);
	// the eligible outputs, class by class, each biggest first, until the view is at the working size: inside one rewrite a fold beyond
	// it would hide work for no saving the law asked for
	let est = ctxEst - savings();
	const verdict = (b: Block) => o.verdicts?.get(handleFor(b.entryId!));
	const rank = (b: Block) => ({ cold: 0, warm: 1, hot: 2, need: 3 }[verdict(b) ?? "warm"]);
	const take = (list: Block[], tag: string) => {
		for (const b of list.filter((b) => b.idx >= minIdx).sort((x, y) => (judging ? rank(x) - rank(y) : 0) || y.tokens - x.tokens)) {
			if (est <= target) return;
			if (addFold(b, tag)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
		}
	};
	const choose = () => {
	// outputs of the user turns before the previous one
	take(candidates[0], trig);
	// the protected window = the new prompt + the previous user turn; after a pause (or a model switch) the user comes back to a cache
	// that is gone, and that turn's big re-readable reads are what makes the return expensive: they come back exactly
	take(candidates[1], `${trig}(relax)`);
	// in-turn: outputs of the protected turns that are many requests old, whatever their recoverability class (every fold stays
	// recallable). Age = assistant requests since the call was issued (the newest outputs, age < inturnAge, always stay).
	take(candidates[2], `${trig}(inturn)`);
	};
	choose();
	// Rent, production, cuts and the permission to rewrite always use the original plan. Reorder only its accepted folds.
	const capReal = coldTarget(o.coldCap ?? s.coldCap, O, room);
	const finish = (q: { f: PlanResult; c: PlanResult | null; a: PlanResult | null }, cutsLeft = false) => {
		if (o.verdicts?.size) for (const p of [q.f, q.a]) {
			if (!p || !p.folds.length) continue;
			const before = p.folds.reduce((n, t) => n + t.entryTokens - t.phTokens, 0);
			folds.splice(0, folds.length, ...(o.carriedFolds ?? []));
			tokOverride.clear();
			for (const t of folds) tokOverride.set(blocks.findIndex((b) => b.entryId === t.entryId), t.phTokens);
			judging = true;
			minIdx = p.cutIdx ?? 0;
			target = coldCap; // stay at the working-size cap; chasing the last fold's overshoot takes later hot folds
			est = ctxEst - savings();
			choose();
			// The original overshoot helped pay for this rewrite. Never spend that saving on a ranking preference.
			if (savings() >= before) p.judged = { folds: [...folds], ctxAfterFolds: p.ctxAfterFolds - c * (savings() - before) };
		}
		const carried = new Set((o.carriedFolds ?? []).map((t) => t.entryId));
		const foldLeft = q.f.folds.some((t) => !carried.has(t.entryId));
		// Over the cap with nothing left to fold or cut. A price, rent, or back-to-back deferral of a fold or cut that still exists is not this case.
		return !q.c && !q.a && !foldLeft && !cutsLeft && q.f.ctxAfterFolds > capReal ? { ...q, stuck: true as const } : q;
	};
	const ctxAfterFolds = ctxEst - savings();
	// what no summary can remove (besides O): the protected turns (after their folds) and the previous summary, which the next one
	// carries forward; the cap is never chased below it (a context that is mostly this floor would be re-summarised for nothing)
	const prevSum = blocks[0]?.kind === "summary" ? blocks[0].tokens : 0;
	// The skeleton can leave as little as 300 narrative tokens. Reserve merges at that smallest possible epoch budget.
	recordPressure(ctxAfterFolds);
	const canApplySummary = o.summaryGate!.eligible;
	const canPrepareSummary = o.summaryGate!.prepareEligible;
	const mergeWork: MergeWork = prevSum && !o.foldsOnly && canPrepareSummary && ctxAfterFolds > coldCap
		? estimateMergeWork(String(blocks[0].msg.summary ?? ""), 300, c, o.model)
		: { inputTokens: 0, outputTokens: 0, merges: 0 };
	const mergeCall = law.pr.w * mergeWork.inputTokens + law.pr.out * mergeWork.outputTokens;
	const activeInput = prevSum ? c * (ACTIVE_INPUT_TOKENS + 128) : 0;
	const atRoom = room !== null && real(ctxAfterFolds) >= room;
	const atRoomUnedited = room !== null && real(ctxEst) >= room;
	const sumTrigger: "cold" | "valve" | null = !o.foldsOnly && canPrepareSummary && ctxAfterFolds > coldCap ? trig : null;
	const minCut = blocks[0].kind === "summary" ? 2 : 1; // never re-summarise a prefix that is only the previous summary
	const pre: number[] = [];
	const S = (x: number) => Math.max(clamp(SUMMARY_RATIO * c * x, SUMMARY_FLOOR, SUMMARY_CAP), c * prevSum) / c; // the next summary carries the previous one forward
	const result = (pick: number | null, summary = pick === null ? 0 : S(pre[pick])): PlanResult => ({
		blocks, calls, folds: pick === null ? [...folds] : folds.filter((t) => blocks.findIndex((b) => b.entryId === t.entryId) >= pick || o.carriedFolds?.some((u) => u.entryId === t.entryId)),
		cutIdx: pick, firstKeptEntryId: pick === null ? null : blocks[pick].entryId, prefixTokens: pick === null ? 0 : pre[pick],
		summaryTokensPlanned: summary, ...(pick !== null ? { mergeWork } : {}), sumTrigger, scale: o.scale ?? UNIT,
		...(pick !== null && room !== null ? { summaryRoomTokens: Math.max(0, Math.floor((room - real(ctxAfterFolds)) / c + pre[pick])) } : {}),
		ctxTokens: real(ctxEst), ctxAfterFolds: real(ctxAfterFolds), userTurns, ...(o.fileRecall ? { fileRecall: o.fileRecall } : {}),
		...(atRoom ? { atRoom } : {}), ...(atRoomUnedited ? { atRoomUnedited } : {}),
	});
	const f = result(null);
	if (!sumTrigger) return finish({ f, c: null, a: null });
	let acc = 0;
	for (const b of blocks) { pre[b.idx] = acc; acc += tokOverride.get(b.idx) ?? b.tokens; }
	const limit = o.rescue?.cutLatest ? blocks.findIndex((b) => b.userTurn >= userTurns) : blocks.findIndex(protectedTurn), cuts: number[] = [];
	for (let i = minCut; i < blocks.length && (limit < 0 || i <= limit); i++) if (isCutBlock(blocks[i])) cuts.push(i);
	if (!cuts.length) return finish({ f, c: null, a: null });
	const cw = cuts.findIndex((k) => ctxAfterFolds - pre[k] + S(pre[k]) <= coldCap);
	const first = cw < 0 ? cuts.length - 1 : cw;
	const paying = cuts.slice(first).find((k) => {
		const X = c * pre[k], Sr = c * S(pre[k]);
		if (o.rescue) return X > Sr; // any shrinking cut: the window, not the price, decides
		if (X < 2 * Sr) return false;
		const call = law.pr.w * (c * Math.max(0, pre[k] - prevSum) + activeInput) + law.pr.out * Math.min(c * S(pre[k]), NARRATIVE_MAX) + mergeCall;
		return gate("summary", X, Sr, null, call, Sr, undefined, undefined, false, blocks[k].entryId ?? undefined)
			&& gate("plan", real(ctxEst), real(ctxAfterFolds - pre[k] + S(pre[k])), room, call, real(ctxAfterFolds - pre[k] + S(pre[k])), undefined, true);
	});
	const bound = paying ?? cuts[first], ready = new Set(o.ready ?? []);
	const readySize = (k: number) => o.readySizes?.[blocks[k].entryId!] ?? S(pre[k]);
	const checkpoint = cuts.filter((k) => ready.has(blocks[k].entryId!) && pre[k] >= 2 * readySize(k)).pop();
	const have = (!o.application || canApplySummary)
		? cuts.filter((k) => k <= bound && ready.has(blocks[k].entryId!) && pre[k] >= 2 * readySize(k)).pop()
		: undefined;
	// A speculative checkpoint does not shorten the live prefix. Re-reading it for a new cut ID alone wastes a full summary call.
	// Refresh only near the preparation limit, with at least a quarter-threshold of newly covered real tokens (35K by default).
	const prep = summaryPrepareThreshold(room);
	const refresh = canApplySummary || checkpoint === undefined || (paying !== undefined
		&& real(ctxAfterFolds - pre[checkpoint] + readySize(checkpoint)) >= prep
		&& c * (pre[paying] - pre[checkpoint]) >= prep / 4);
	if (!canApplySummary && checkpoint !== undefined) o.summaryGate!.checkpoint = {
		key: blocks[checkpoint].entryId!, after: Math.round(real(ctxAfterFolds - pre[checkpoint] + readySize(checkpoint))),
		advance: Math.round(paying === undefined ? 0 : c * (pre[paying] - pre[checkpoint])), refresh,
	};
	return finish({ f, c: paying === undefined || !refresh ? null : result(paying), a: have === undefined ? null : result(have, readySize(have)) }, true);
}

/** Select from the planner's tuple: production uses the plain law; application uses G_{1/10} and takes only READY summaries. */
export function selectPlan(q: ReturnType<typeof plan>, o: PlanOpts): PlanResult | null {
	if (!q) return null;
	const law = o.law ?? { pr: lawPrices(undefined, false), g: G0, pWarm: 0 };
	const test = (p: PlanResult, ready = false) => {
		const A = p.ctxAfterFolds - p.scale.c * (p.prefixTokens - p.summaryTokensPlanned), room = compactionRoom(o.model, o.reserve);
		const t = o.application ? guardTerms(p.ctxTokens, A, law.pWarm, room, law.pr, law.g, o.rent ?? 0, o.keep)
			: lawTerms(p.ctxTokens, A, law.pWarm, room, law.pr, law.g, 0, A, o.keep);
		o.trace?.push({ ...t, keep: o.keep, Tsuf: A - sizeOf(p.scale, untouchedEst(p.blocks, p.folds, p.cutIdx !== null)), where: o.application ? "guard" : "plan", ...(o.application ? { rent: o.rent ?? 0 } : {}), cut: p.cutIdx !== null, ...(ready ? { ready: true } : {}) });
		return t.ok && (p.cutIdx !== null || p.folds.length > 0);
	};
	const a = o.cutAt === undefined ? q.a : q.a?.firstKeptEntryId === o.cutAt ? q.a : null;
	const judged = (p: PlanResult) => p.judged ? { ...p, ...p.judged, judged: undefined } : p;
	if (a && !o.deferSummary && test(a, true)) return judged(a);
	if (!o.application && !o.foldsOnly && o.cutAt === undefined && q.c && o.summaryGate?.eligible) return q.c;
	return test(q.f) ? judged(q.f) : null;
}

/** Compatibility projection for planner callers; the decision core also reads the unfiltered tuple for rent and production. */
export function planContext(entries: Any[], o: PlanOpts): PlanResult | null {
	return selectPlan(plan(entries, o), o);
}
