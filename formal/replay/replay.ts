// Replay of the real planner over recorded sessions, to compare two sources (for example rc030 at 7182b25 and its fixed successor).
//
//   PZ_SRC=/path/to/src bun formal/replay/replay.ts --tag T [--out rows.json] session.jsonl ...
//
// The planner of PZ_SRC (plan.ts, learn.ts, placeholder.ts; the view and growth from core.ts when present) is run at every request of every session, on the session as the transcript
// recorded it with pi-zip's own edits and summaries removed (the same pristine conversation for every source): at the prompt of a turn
// (a cold plan when the gap since the previous request exceeds the TTL, else a warm one) and at every later request of the turn (the
// warm valve at turn_end), with the folds and summaries the source itself chose before applied. Nothing is called: a summary is a
// synthetic summary entry of the planned size, a recorded response stands in for the model's answer, so the replay is an estimate of
// what the policy would have done on the same work, not a rerun of the session.
//
// Per session and in total (aggregates only; rows carry the position of the file in the argument list, never a name or any content):
//   summaries     planned summaries (cold = at a cold return, warm = a run plan at a warm return or a turn_end valve)
//   warmEdits     warm requests that carry an edit (each rewrites the cache), rewriteK: tokens rewritten by them (thousands, real)
//   waitS         seconds the user waits for a summary call that was not prepared while away (a warm summary; a cold return's summary is
//                 prepared by the away timer, which fires at 0.8 x TTL, before any gap that counts as cold), modelled as the bench's
//                 latency fit: 3.2 s + 0.031 s per 1K uncached input + 0.0093 s per output token (bench math_renewal.py LAT)
//   costM         estimated cost in millions of input-token equivalents: every request at the class prices (r, w of the cache class read
//                 from the transcript's usage), the whole context written at a cold return, the suffix after an edit written at a
//                 warm one, plus the summary calls priced as the planner prices them (uncached input of the prefix without the
//                 previous summary, plus the narrative written)
//   lost          tool outputs a summary replaced that the transcript later asks for again (an identical call issued later): needed
//                 again after being summarised away. recalls: the same for an output that was folded (recoverable by zip_recall or a
//                 re-run); refetchK: tokens of both, real, in thousands
//   digest        sha256 (first 16 hex) of the per-request decisions: request index, cold or warm plan, whether a plan ran, the cut
//                 (index, first kept entry id, planned summary tokens), the folded entry ids, and the request's estimated size and cost.
//                 Two sources with the same digest made the same decision at every request (the reference for a refactor).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.PZ_SRC;
if (!SRC) throw new Error("PZ_SRC=/path/to/src is required");
const P: any = await import(join(SRC, "plan.ts"));
const L: any = await import(join(SRC, "learn.ts"));
const PH: any = await import(join(SRC, "placeholder.ts"));
const PI: any = await import(join(SRC, "../node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
// 0.4.0 step 1 on: the view (token scale) and the growth step come from the pure core (core.ts); an older source has them in plan.ts
// and run.ts (the same functions before the move)
const C: any = existsSync(join(SRC, "core.ts")) ? await import(join(SRC, "core.ts")) : null;
const scaleOf = (entries: any[], branch: any[], key: string) => (C ? C.scaleOf(entries, branch, undefined, key) : P.calibrate(entries, undefined, branch, key));
const grow = (g: number, deltas: number[], d: number): { g: number; deltas: number[] } => {
	if (C) return C.grow(g, deltas, d);
	const next = [...deltas.slice(-19), d], s = [...next].sort((a, b) => a - b);
	return { g: 0.9 * g + 0.1 * Math.min(d, s[Math.ceil(0.9 * s.length) - 1]), deltas: next };
};

const TTL_S = 300;
const LAT = { c0: 3.2, perKUncached: 0.031, perOut: 0.0093 };
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const tag = flag("--tag") ?? "replay";
const outPath = flag("--out");
const files = args;

const ms = (e: any) => Date.parse(e?.timestamp) || Number(e?.message?.timestamp) || 0;
const isMsg = (e: any, role?: string) => e?.type === "message" && (!role || e.message?.role === role);
const okAsst = (e: any) => isMsg(e, "assistant") && e.message.stopReason !== "error" && e.message.stopReason !== "aborted" && e.message.usage;
const total = (u: any) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
const keyOf = (m: any) => `${m.provider ?? ""}/${m.model ?? ""}`;
const sigOf = (part: any) => `${part.name}|${JSON.stringify(part.arguments)}`;

interface Cut { firstKept: string; chars: number }

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
	const rP = pr.r, wP = pr.w;

	// requests, turns, gaps
	const reqs: { bi: number; ts: number; total: number; key: string; turn: number; first: boolean; gap: number }[] = [];
	let turn = 0, lastTs = 0, newTurn = false, lastReqTs = 0;
	branch.forEach((e, bi) => {
		if (isMsg(e, "user") && !steer.has(e.id)) { turn++; newTurn = true; }
		if (okAsst(e)) {
			const leaf = branch[bi - 1];
			reqs.push({ bi, ts: ms(e), total: total(e.message.usage), key: keyOf(e.message), turn, first: newTurn, gap: lastReqTs ? (ms(leaf) - lastReqTs) / 1000 : 0 });
			newTurn = false;
			lastReqTs = ms(e);
		}
		if (isMsg(e) && e.message.role !== "system") lastTs = ms(e);
	});
	void lastTs;
	// g as run.ts learns it (EWMA of the growth between consecutive responses, capped at the p90 of the last 20)
	const gAt: number[] = [];
	{
		let g = P.G0, prev = 0, deltas: number[] = [];
		reqs.forEach((q, i) => {
			gAt[i] = g;
			if (prev > 0 && q.total >= prev) ({ g, deltas } = grow(g, deltas, q.total - prev));
			prev = q.total;
		});
	}

	// what the source chose so far
	const folds = new Map<string, { ph: string; tokens: number; handle: string; sig: string | null }>(); // entry id -> fold
	const cuts: Cut[] = [];
	const lostIds = new Map<string, { tokens: number; sig: string | null; at: number }>(); // summarised away
	const foldedIds = new Map<string, { tokens: number; sig: string | null; at: number; handle: string }>();
	const out: any = { requests: reqs.length, turns: turn, coldReturns: 0, summaries: 0, coldSummaries: 0, warmSummaries: 0, foldsCold: 0, foldsWarm: 0, warmEdits: 0, rewriteK: 0, waitS: 0, cost: 0, callCost: 0, lost: 0, recalls: 0, refetchK: 0, planErrors: 0 };
	let justEdited = false, prevSize = 0;
	const decisions: string[] = [];

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
	const estTokens = (entries: any[]) => entries.reduce((a, pe) => a + (pe.messages ?? []).reduce((b: number, m: any) => b + P.wireTokensOf(m), 0), 0);

	reqs.forEach((q, i) => {
		const leaf = branch[q.bi - 1];
		if (!leaf) return;
		const cold = q.gap > TTL_S;
		const coldPlan = q.first && cold;
		if (coldPlan) out.coldReturns++;
		const proj = PI.buildSessionProjection(all, leaf.id, byId);
		const br = branch.slice(0, q.bi);
		const [provider, ...idp] = q.key.split("/");
		const model = { provider, id: idp.join("/"), contextWindow: 200_000 };
		const scale = scaleOf(proj.entries, br, q.key);
		const view = apply(proj.entries);
		let plan: any = null;
		const mayPlan = coldPlan || !justEdited; // no warm edit on the request right after an edited one
		if (mayPlan && view.length) {
			// mode and pastTtl drive a source before 0.4.0 step 3 (one planner); pause (a return after the TTL) and P in the law drive a later one
			const o: any = { mode: coldPlan ? "cold" : "warm", pause: coldPlan, scale, cwd: header?.cwd ?? "/tmp", model, promptPending: false, steerIds: steer, law: { pr, g: gAt[i] ?? P.G0, pWarm: coldPlan ? 0 : 1 }, trace: [], pastTtl: coldPlan, recalled: new Set<string>() };
			try { plan = P.planContext(view, o); } catch { out.planErrors++; }
		}
		const edited = !!plan && (plan.folds.length > 0 || plan.cutIdx !== null);
		let untouchedReal = 0;
		if (edited) {
			const calls = P.toolCallIndex(plan.blocks);
			if (plan.cutIdx !== null) {
				const prevSum = plan.blocks[0]?.kind === "summary" ? plan.blocks[0].tokens : 0;
				const X = scale.c * plan.prefixTokens, S = scale.c * plan.summaryTokensPlanned;
				const call = pr.input * scale.c * Math.max(plan.prefixTokens - prevSum, 0) + pr.out * scale.c * Math.min(plan.summaryTokensPlanned, P.NARRATIVE_MAX ?? 4000);
				out.callCost += call;
				out.summaries++;
				if (coldPlan) out.coldSummaries++; else out.warmSummaries++;
				if (!coldPlan) {
					const uncachedK = scale.c * Math.max(plan.prefixTokens - prevSum, 0) / 1000;
					const outTok = Math.min(Math.max(0.1 * (X / scale.c - prevSum), 1000), 4000) * scale.c;
					out.waitS += LAT.c0 + LAT.perKUncached * uncachedK + LAT.perOut * outTok;
				}
				void S;
				// the summarised items: outputs before the cut that were not already folded away or replaced by an earlier summary
				for (const b of plan.blocks) {
					if (b.idx >= plan.cutIdx) break;
					if (b.kind !== "toolResult" || !b.entryId) continue;
					const call = calls.get(b.msg.toolCallId);
					lostIds.set(b.entryId, { tokens: scale.c * b.tokens, sig: call ? `${call.name}|${JSON.stringify(call.args)}` : null, at: i });
					folds.delete(b.entryId);
					foldedIds.delete(b.entryId);
				}
				cuts.push({ firstKept: plan.firstKeptEntryId, chars: 4 * plan.summaryTokensPlanned });
			}
			for (const t of plan.folds) {
				const call = calls.get(t.toolCallId);
				folds.set(t.entryId, { ph: t.ph, tokens: t.entryTokens, handle: PH.handleFor(t.entryId), sig: call ? `${call.name}|${JSON.stringify(call.args)}` : null });
				foldedIds.set(t.entryId, { tokens: scale.c * t.entryTokens, sig: call ? `${call.name}|${JSON.stringify(call.args)}` : null, at: i, handle: PH.handleFor(t.entryId) });
			}
			if (coldPlan) out.foldsCold += plan.folds.length; else out.foldsWarm += plan.folds.length;
			untouchedReal = P.sizeOf(scale, P.untouchedEst(plan.blocks, plan.folds, plan.cutIdx !== null));
		}
		// the request: the view with this plan applied
		const sizeEst = estTokens(apply(proj.entries));
		const size = P.sizeOf(scale, sizeEst);
		let cost: number;
		if (i === 0 || cold) cost = wP * size; // a cold cache writes everything (the first request, a return after the TTL)
		else if (edited) {
			const keep = Math.min(untouchedReal, prevSize, size);
			cost = rP * keep + wP * (size - keep);
			out.warmEdits++;
			out.rewriteK += Math.max(0, prevSize - untouchedReal) / 1000;
		} else cost = rP * Math.min(prevSize, size) + wP * Math.max(0, size - prevSize);
		out.cost += cost;
		decisions.push([i, coldPlan ? "c" : "w", mayPlan && view.length ? 1 : 0, plan ? 1 : 0, edited && plan.cutIdx !== null ? `${plan.cutIdx}:${plan.firstKeptEntryId}:${plan.summaryTokensPlanned}` : "-", edited ? plan.folds.map((t: any) => t.entryId).sort().join(",") : "-", size, cost].join(" "));
		justEdited = edited && !coldPlan;
		prevSize = size;
	});
	out.cost += out.callCost;
	out.digest = createHash("sha256").update(decisions.join("\n")).digest("hex").slice(0, 16);

	// what the transcript asks for again after an output was folded or summarised away
	const later: { req: number; sig: string; handle?: string }[] = [];
	branch.forEach((e, bi) => {
		if (!isMsg(e, "assistant")) return;
		const ri = reqs.findIndex((q) => q.bi === bi);
		if (ri < 0) return;
		for (const part of e.message.content ?? []) if (part?.type === "toolCall") later.push(part.name === "zip_recall" ? { req: ri, sig: "recall", handle: String(part.arguments?.handle ?? "") } : { req: ri, sig: sigOf(part) });
	});
	for (const [, f] of lostIds) if (later.some((x) => x.req > f.at && f.sig && x.sig === f.sig)) { out.lost++; out.refetchK += f.tokens / 1000; }
	for (const [, f] of foldedIds) if (later.some((x) => x.req > f.at && ((f.sig && x.sig === f.sig) || (x.sig === "recall" && x.handle === f.handle)))) { out.recalls++; out.refetchK += f.tokens / 1000; }
	return out;
}

const rows: any[] = [];
files.forEach((f, n) => {
	try { rows.push({ session: n + 1, ...run(f) }); } catch (err) { console.error("skip", n + 1, String(err).slice(0, 160)); }
});
const sum = (k: string) => rows.reduce((a, x) => a + (x[k] ?? 0), 0);
const KEYS = ["requests", "turns", "coldReturns", "summaries", "coldSummaries", "warmSummaries", "foldsCold", "foldsWarm", "warmEdits", "rewriteK", "waitS", "cost", "lost", "recalls", "refetchK", "planErrors"];
const fmt = (k: string, v: number) => (k === "cost" ? (v / 1e6).toFixed(3) : k === "waitS" || k === "rewriteK" || k === "refetchK" ? v.toFixed(0) : String(v));
const table = [...rows.map((r) => ({ session: String(r.session), ...Object.fromEntries(KEYS.map((k) => [k, fmt(k, r[k])])), digest: r.digest })), { session: "total", ...Object.fromEntries(KEYS.map((k) => [k, fmt(k, sum(k))])) }];
console.log(JSON.stringify({ tag, src: SRC, rows: table }));
if (outPath) writeFileSync(outPath, JSON.stringify({ tag, rows }, null, 1));
