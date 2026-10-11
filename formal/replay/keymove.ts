// How often does the warm valve's cut key move while a summary for it is being written? (round 5, rules A and B)
//
//   PZ_SRC=/path/to/src bun formal/replay/keymove.ts [--policy v030|naive|stretch1|pin-naive|pin] [--lat S] session.jsonl ...
//
// The planner of PZ_SRC is replayed over recorded sessions the way replay.ts does (pi-zip's own edits removed, the source's own folds
// and summaries applied as it makes them), with the summary call taking real time: a background summary started at time t for cut key
// K is ready at t + its latency (the bench's latency fit, as replay.ts's waitS, or --lat seconds flat). Rules (a summary at
// Pi's compaction room is always waited for):
//   A  at a run's end, the warm plan a warm return would make (prompt pending, P = 1, nothing if the last request carried an edit) with a
//      cut starts its summary at once; the cold plan's cut, if elsewhere, replaces it at 0.8 x TTL if the user is still away.
//   B  a warm decision (a warm prompt or a turn_end) whose plan cuts at K: a finished summary for K is adopted; one running for K is
//      left to run and nothing is applied; otherwise one is started for K and nothing is applied. A plan without a cut applies its
//      folds and (as run.ts) discards a running summary; at a prompt a plan that does not fire discards it too.
// Policies for a running/finished summary whose key no longer matches the plan:
//   naive     discard it and start one for the new key (every move costs a call)
//   stretch1  at most one unused summary call per warm stretch (cold return to cold return): once one was discarded unused, a
//             warm decision that would start another one instead writes it while the user waits (0.3.0's behaviour)
//   pin-naive naive, but a warm plan whose cut moved is first planned again cutting where the running summary cuts (plan.ts cutAt):
//             taken when the law accepts it
//   pin       pin + stretch1 (v031 as first shipped)
//   pinB      pin, and once the stretch's unused background summary is spent a warm decision that would summarise applies nothing and
//             starts nothing (the context grows until Pi's compaction room, where the summary is waited for): review P1 #2, option (b)
//   v030      0.3.0 for comparison: no early start, no deferral (every warm summary is written while the user waits)
// cost: input-token equivalents at the session's cache-class prices, as replay.ts prices them: every request (a cold cache writes all
// of it, a warm edit rewrites what follows the first edit, otherwise the growth is written and the rest read), plus every summary call
// started (used or not, at its full price: an aborted one is billed at most that) at the uncached read of its prefix plus the narrative.
// waitS: seconds the user waits for summaries below Pi's compaction room, waitRoomS at it (the latency fit; a running summary's
// remainder). The counters starting with "wasted"
// are discarded summaries by cause; unusedAB counts those rules A/B started, unusedAway the away timer's (0.3.0's own).
// Aggregates only (no names, no content). Each row: counts per session; total.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.PZ_SRC;
if (!SRC) throw new Error("PZ_SRC=/path/to/src is required");
const P: any = await import(join(SRC, "plan.ts"));
const L: any = await import(join(SRC, "learn.ts"));
const PI: any = await import(join(SRC, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"));

const TTL_S = 300;
const LAT = { c0: 3.2, perKUncached: 0.031, perOut: 0.0093 };
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const policy = flag("--policy") ?? "naive";
const PIN = policy.startsWith("pin");
const V030 = policy === "v030"; // 0.3.0: no early start, every warm summary written while the user waits (a finished away summary for its cut is taken)
const BUDGET = policy === "stretch1" || policy === "pin" || policy === "pinB";
const SKIP = policy === "pinB"; // review P1 #2 (b): once the budget is spent, a warm summary is neither waited for nor started: nothing is applied
const latFlat = flag("--lat");
const files = args;

const ms = (e: any) => Date.parse(e?.timestamp) || Number(e?.message?.timestamp) || 0;
const isMsg = (e: any, role?: string) => e?.type === "message" && (!role || e.message?.role === role);
const okAsst = (e: any) => isMsg(e, "assistant") && e.message.stopReason !== "error" && e.message.stopReason !== "aborted" && e.message.usage;
const total = (u: any) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
const keyOf = (m: any) => `${m.provider ?? ""}/${m.model ?? ""}`;

type Bg = { key: string; readyAt: number; origin: "early" | "defer-prompt" | "defer-te" | "away"; startedAt: number; seen: number; moved: number; stretch: number };

function run(path: string) {
	const file: any[] = PI.parseSessionEntries(readFileSync(path, "utf8"));
	PI.migrateSessionEntries(file);
	const header = file.find((e) => e.type === "session");
	const inert = (e: any) => ({ type: "custom", customType: "x", id: e.id, parentId: e.parentId, timestamp: e.timestamp, data: {} });
	const all = file.filter((e) => e.type !== "session").map((e) => (e.type === "context_edit" || (e.type === "compaction" && e.details?.by === "pi-zip") ? inert(e) : e));
	const byId = new Map(all.map((e) => [e.id, e]));
	const branch: any[] = [];
	for (let e: any = all[all.length - 1]; e; e = e.parentId ? byId.get(e.parentId) : null) branch.unshift(e);
	const steer = new Set<string>();
	for (const e of branch) if (e.type === "custom" && e.customType === "pi-zip/steer") for (const id of e.data?.ids ?? []) steer.add(id);
	const explicit = branch.some((e) => okAsst(e) && (e.message.usage.cacheWrite ?? 0) > 0);
	const pr = L.lawPrices(explicit ? "explicit" : "automatic", false);

	const reqs: { bi: number; ts: number; leafTs: number; total: number; key: string; turn: number; first: boolean; gap: number }[] = [];
	let turn = 0, newTurn = false, lastReqTs = 0;
	branch.forEach((e, bi) => {
		if (isMsg(e, "user") && !steer.has(e.id)) { turn++; newTurn = true; }
		if (okAsst(e)) {
			const leaf = branch[bi - 1];
			reqs.push({ bi, ts: ms(e), leafTs: ms(leaf), total: total(e.message.usage), key: keyOf(e.message), turn, first: newTurn, gap: lastReqTs ? (ms(leaf) - lastReqTs) / 1000 : 0 });
			newTurn = false;
			lastReqTs = ms(e);
		}
	});
	const gAt: number[] = [];
	{
		let g = P.G0, prev = 0, deltas: number[] = [];
		reqs.forEach((q, i) => {
			gAt[i] = g;
			if (prev > 0 && q.total >= prev) {
				deltas = [...deltas.slice(-19), q.total - prev];
				const s = [...deltas].sort((a, b) => a - b);
				g = 0.9 * g + 0.1 * Math.min(q.total - prev, s[Math.ceil(0.9 * s.length) - 1]);
			}
			prev = q.total;
		});
	}

	const folds = new Map<string, { ph: string }>();
	const cuts: { firstKept: string; chars: number }[] = [];
	const out: any = {
		requests: reqs.length, coldReturns: 0, warmPrompts: 0, stretches: 1,
		starts: 0, startsEarly: 0, startsDeferPrompt: 0, startsDeferTe: 0, startsAway: 0,
		usedNative: 0, usedTe: 0, usedCold: 0, usedEarly: 0,
		wastedMoved: 0, wastedNoCut: 0, wastedNoPlan: 0, wastedCold: 0, wastedEnd: 0, wastedTimer: 0,
		firstFirings: 0, firingsMovedBeforeUse: 0, teSeenPending: 0, teMovedPending: 0, keyMoves: 0,
		waits: 0, waitsAtRoom: 0, pinned: 0, pinFailed: 0, unusedAB: 0, unusedAway: 0, waitS: 0, waitRoomS: 0, maxWastedPerStretch: 0, deferredUnadoptedAtRunEnd: 0,
		skips: 0, calls: 0, cost: 0, callCost: 0,
	};
	let summarizedWarm = false, regrow = 0, justEdited = false;
	let bg: Bg | null = null;
	let stretch = 0, wastedInStretch = 0;
	// the budget counts summaries rules A and B started (at a run's end, or deferred at a warm decision); the away timer's (0.3.0's own)
	// are reported apart
	const waste = (kind: string, count = true) => {
		out[kind]++;
		if (count && bg && bg.origin !== "away") {
			wastedInStretch++;
			out.unusedAB++;
			out.maxWastedPerStretch = Math.max(out.maxWastedPerStretch, wastedInStretch);
		} else out.unusedAway++;
	};
	const estTokens = (entries: any[]) => entries.reduce((a, pe) => a + (pe.messages ?? []).reduce((b: number, m: any) => b + P.wireTokensOf(m), 0), 0);
	const apply = (entries: any[]): any[] => {
		let es = entries;
		for (const c of cuts) {
			const at = es.findIndex((pe) => pe.sourceEntry?.id === c.firstKept);
			if (at < 0) continue;
			const syn = { sourceEntry: { type: "compaction", id: `syn_${c.firstKept}`, details: { by: "pi-zip" } }, messages: [{ role: "compactionSummary", summary: "x".repeat(c.chars), tokensBefore: 0, timestamp: 0 }] };
			es = [syn, ...es.slice(at)];
		}
		return es.map((pe) => {
			const f = folds.get(pe.sourceEntry?.id);
			if (!f || !pe.messages?.length) return pe;
			return { ...pe, messages: [{ ...pe.messages[0], content: [{ type: "text", text: f.ph }] }] };
		});
	};
	const latOf = (plan: any, c: number) => {
		if (latFlat) return Number(latFlat) * 1000;
		const prevSum = plan.blocks[0]?.kind === "summary" ? plan.blocks[0].tokens : 0;
		const uncachedK = (c * Math.max(plan.prefixTokens - prevSum, 0)) / 1000;
		const outTok = Math.min(Math.max(0.1 * (plan.prefixTokens - prevSum), 1000), 4000) * c;
		return (LAT.c0 + LAT.perKUncached * uncachedK + LAT.perOut * outTok) * 1000;
	};
	const planAt = (leafId: string, i: number, mode: "cold" | "warm", pending: boolean, uptoBi: number, cutAt?: string) => {
		const proj = PI.buildSessionProjection(all, leafId, byId);
		const br = branch.slice(0, uptoBi);
		const q = reqs[Math.min(i, reqs.length - 1)];
		const [provider, ...idp] = q.key.split("/");
		const model = { provider, id: idp.join("/"), contextWindow: 200_000 };
		const scale = P.calibrate(proj.entries, undefined, br, q.key);
		const view = apply(proj.entries);
		if (!view.length) return null;
		const cold = mode === "cold";
		const o: any = { mode, scale, cwd: header?.cwd ?? "/tmp", model, promptPending: pending, steerIds: steer, law: { pr, g: gAt[i] ?? P.G0, pWarm: cold ? 0 : 1 }, trace: [], pastTtl: cold, noSummary: !cold && summarizedWarm, ...(!cold && summarizedWarm && regrow > 0 ? { regrowAt: regrow } : {}), recalled: new Set<string>(), ...(cutAt ? { cutAt } : {}) };
		try { return { plan: P.planContext(view, o), scale, trace: o.trace }; } catch { return null; }
	};
	const pay = (plan: any, c: number) => {
		const prevSum = plan.blocks[0]?.kind === "summary" ? plan.blocks[0].tokens : 0;
		const call = pr.input * c * Math.max(plan.prefixTokens - prevSum, 0) + pr.out * c * Math.min(plan.summaryTokensPlanned, P.NARRATIVE_MAX ?? 4000);
		out.callCost += call;
		out.calls++;
	};
	let reqPlan: any = null; // the plan this request carries new (its edits), for the request's price
	const adopt = (plan: any) => {
		reqPlan = plan;
		const calls = P.toolCallIndex(plan.blocks);
		void calls;
		if (plan.cutIdx !== null) {
			for (const b of plan.blocks) { if (b.idx >= plan.cutIdx) break; if (b.entryId) folds.delete(b.entryId); }
			cuts.push({ firstKept: plan.firstKeptEntryId, chars: 4 * plan.summaryTokensPlanned });
			summarizedWarm = true;
			regrow = plan.ctxAfterFolds;
		}
		for (const t of plan.folds) folds.set(t.entryId, { ph: t.ph });
	};
	const start = (key: string, now: number, plan: any, c: number, origin: Bg["origin"]) => {
		pay(plan, c);
		bg = { key, readyAt: now + latOf(plan, c), origin, startedAt: now, seen: 0, moved: 0, stretch };
		out.starts++;
		out[{ early: "startsEarly", "defer-prompt": "startsDeferPrompt", "defer-te": "startsDeferTe", away: "startsAway" }[origin]]++;
		if (origin !== "away") out.firstFirings++;
	};
	const used = (kind: string) => {
		if (bg && bg.moved > 0) out.firingsMovedBeforeUse++;
		out[kind]++;
		if (bg?.origin === "early") out.usedEarly++;
		bg = null;
	};

	let prevSize = 0;
	reqs.forEach((q, i) => {
		const leaf = branch[q.bi - 1];
		if (!leaf) return;
		const cold = q.first && q.gap > TTL_S;
		const now = q.leafTs;
		reqPlan = null;
		const usedCold0 = out.usedCold;
		if (cold) {
			out.coldReturns++;
			summarizedWarm = false;
			regrow = 0;
			const r = planAt(leaf.id, i, "cold", false, q.bi);
			const plan = r?.plan;
			if (bg) { if (plan && plan.cutIdx !== null && plan.firstKeptEntryId === bg.key) used("usedCold"); else { waste("wastedCold"); bg = null; } }
			if (!bg && plan && plan.cutIdx !== null && out.usedCold === usedCold0) pay(plan, r!.scale.c); // not prepared: written at the return
			if (i > 0) out.stretches++;
			stretch++;
			wastedInStretch = 0;
			if (plan) adopt(plan);
			justEdited = false;
		} else if (justEdited) {
			justEdited = false; // b2b: the request right after an edited one gets no warm edit
		} else {
			if (q.first) out.warmPrompts++;
			let r = planAt(leaf.id, i, "warm", false, q.bi);
			let plan = r?.plan;
			let edited = false;
			// pin: a summary is already being written (or done) for bg.key; the plan cutting there instead, if the law accepts it
			if (PIN && bg && plan && plan.cutIdx !== null && plan.firstKeptEntryId !== bg.key) {
				const r2 = planAt(leaf.id, i, "warm", false, q.bi, bg.key);
				if (r2?.plan && r2.plan.cutIdx !== null && r2.plan.firstKeptEntryId === bg.key) { out.pinned++; r = r2; plan = r2.plan; }
				else {
					out.pinFailed++;
				}
			}
			if (!plan) {
				if (q.first && bg) { waste("wastedNoPlan"); bg = null; }
			} else if (plan.cutIdx === null) {
				if (plan.folds.length) { if (bg) { waste("wastedNoCut"); bg = null; } adopt(plan); edited = true; }
			} else {
				const K = plan.firstKeptEntryId;
				if (bg && bg.key !== K) {
					out.keyMoves++;
					bg.moved++;
				}
				if (bg) { bg.seen++; out.teSeenPending++; if (bg.key !== K) out.teMovedPending++; }
				if (plan.atRoom || V030) {
					if (plan.atRoom) out.waitsAtRoom++; else out.waits++;
					const wk = plan.atRoom ? "waitRoomS" : "waitS";
					if (bg && bg.key === K) { out[wk] += Math.max(0, bg.readyAt - now) / 1000; used(q.first ? "usedNative" : "usedTe"); }
					else { if (bg) { waste("wastedMoved"); bg = null; } out[wk] += latOf(plan, r!.scale.c) / 1000; pay(plan, r!.scale.c); }
					adopt(plan);
					edited = true;
				} else if (bg && bg.key === K && now >= bg.readyAt) {
					used(q.first ? "usedNative" : "usedTe");
					adopt(plan);
					edited = true;
				} else if (bg && bg.key === K) {
					// running for this key: let it run, apply nothing
				} else {
					// run.ts abRoom: the unused summaries of this stretch plus the A/B one a start would discard
					const overBudget = BUDGET && wastedInStretch + (bg && bg.origin !== "away" ? 1 : 0) >= 1;
					if (overBudget && SKIP) out.skips++; // (b): nothing applied, nothing started; a running summary is left alone
					else {
						if (bg) { waste("wastedMoved"); bg = null; }
						if (overBudget) { out.waits++; out.waitS += latOf(plan, r!.scale.c) / 1000; pay(plan, r!.scale.c); adopt(plan); edited = true; }
						else start(K, now, plan, r!.scale.c, q.first ? "defer-prompt" : "defer-te");
					}
				}
			}
			justEdited = edited; // a warm edit (prompt or turn_end) blocks the next request
		}
		// the request's price (replay.ts): the view with every adopted edit applied
		{
			const proj = PI.buildSessionProjection(all, leaf.id, byId);
			const scale = P.calibrate(proj.entries, undefined, branch.slice(0, q.bi), q.key);
			const size = P.sizeOf(scale, estTokens(apply(proj.entries)));
			let cost: number;
			if (i === 0 || q.gap > TTL_S) cost = pr.w * size;
			else if (reqPlan) {
				const untouched = P.sizeOf(scale, P.untouchedEst(reqPlan.blocks, reqPlan.folds, reqPlan.cutIdx !== null));
				const keep = Math.min(untouched, prevSize, size);
				cost = pr.r * keep + pr.w * (size - keep);
			} else cost = pr.r * Math.min(prevSize, size) + pr.w * Math.max(0, size - prevSize);
			out.cost += cost;
			prevSize = size;
		}
		// the run's end: settle (A), then the away timer (cold plan elsewhere) if the user stays away past 0.8 x TTL
		const next = reqs[i + 1];
		const runEnds = !next || next.first;
		if (runEnds) {
			const endEntry = branch[q.bi];
			if (bg && bg.origin.startsWith("defer")) out.deferredUnadoptedAtRunEnd++;
			if (!justEdited && !V030) {
				let w = planAt(endEntry.id, i + 1, "warm", true, q.bi + 1)?.plan;
				if (PIN && bg && w && w.cutIdx !== null && w.firstKeptEntryId !== bg.key) {
					const w2 = planAt(endEntry.id, i + 1, "warm", true, q.bi + 1, bg.key)?.plan;
					if (w2 && w2.cutIdx !== null && w2.firstKeptEntryId === bg.key) { out.pinned++; w = w2; } else out.pinFailed++;
				}
				const wKey = w && w.cutIdx !== null ? w.firstKeptEntryId : null;
				if (wKey && bg?.key !== wKey) {
					if (bg && bg.origin !== "away") { waste("wastedMoved"); bg = null; }
					const overBudget = BUDGET && wastedInStretch >= 1;
					if (!overBudget) {
						if (bg) { waste("wastedMoved"); bg = null; }
						start(wKey, q.ts, w, P.calibrate(PI.buildSessionProjection(all, endEntry.id, byId).entries, undefined, branch.slice(0, q.bi + 1), q.key).c, "early");
					}
				}
			}
			const awayLong = !next || next.gap > 0.8 * TTL_S;
			if (awayLong) {
				const c = planAt(endEntry.id, i + 1, "cold", true, q.bi + 1)?.plan;
				const cKey = c && c.cutIdx !== null ? c.firstKeptEntryId : null;
				if (cKey && bg?.key !== cKey) {
					if (bg) { waste("wastedTimer", false); bg = null; } // review P1 #1: the away timer's replacement is not thrash
					start(cKey, q.ts + 0.8 * TTL_S * 1000, c, 1, "away");
				}
			}
		}
	});
	if (bg) waste("wastedEnd");
	out.cost += out.callCost;
	return out;
}

const rows: any[] = [];
files.forEach((f, n) => {
	try { rows.push({ session: n + 1, ...run(f) }); } catch (err) { console.error("skip", n + 1, String(err).slice(0, 200)); }
});
const keys = Object.keys(rows[0] ?? {}).filter((k) => k !== "session");
const tot: any = { session: "total" };
for (const k of keys) tot[k] = k === "maxWastedPerStretch" ? Math.max(...rows.map((r) => r[k])) : rows.reduce((a, r) => a + r[k], 0);
console.log(JSON.stringify({ policy, lat: latFlat ?? "fit", rows: [...rows, tot] }));
