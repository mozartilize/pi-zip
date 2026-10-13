// Planner state that is a function of the session: rebuilt from the branch at session start (a restart, a resume, a fork), so a fresh
// process plans exactly like one that never left: growth g and "the newest response carried an edit" are read from the session,
// while completed summary calls are persisted artifacts.
import { grow } from "./core.ts";
import { COMMIT_CUSTOM, PRODUCT, type Any } from "./util.ts";

/** A pi-zip summary that went in through Pi's compaction before a run (the run's first request is the first to carry it). */
const nativeSummary = (e: Any): boolean => e?.type === "compaction" && e.details?.by === PRODUCT && e.details?.via === "native";

/** For each assistant message of the branch (by branch index): was it the first response to carry a pi-zip edit? A run plan is sent from
 *  the run's first request and persisted after its response (the commit entry says `carried`); a warm-valve plan, or a summary that went
 *  in through Pi's compaction, is first carried by the next request. A mixed room batch marks both requests (`carried` and `next`).
 *  Errors and aborts count: the request was made. */
export function carriedEdits(branch: Any[]): Set<number> {
	const edited = new Set<number>();
	let next = false, last = -1;
	branch.forEach((e, i) => {
		if (e?.type === "message" && e.message?.role === "assistant") {
			if (next) edited.add(i);
			next = false;
			last = i;
		} else if (nativeSummary(e)) next = true;
		else if (e?.type === "custom" && e.customType === COMMIT_CUSTOM) {
			if (e.data?.carried && last >= 0) edited.add(last);
			if (!e.data?.carried || e.data?.next) next = true;
		}
	});
	return edited;
}

/** A persisted summary has no response yet: the next request first carries its rewrite, including after a restart. */
export function pendingSummary(branch: Any[]): boolean {
	let pending = false;
	for (const e of branch) {
		if (e?.type === "message" && e.message?.role === "assistant") pending = false;
		else if (e?.type === "compaction") pending = nativeSummary(e) || (e.details?.by === PRODUCT && e.details?.carried === false);
	}
	return pending;
}

/** Growth per request, as run.ts `learn` accumulates it: EWMA(0.1) of the growth between consecutive responses of one model that
 *  carried no edit of ours, each capped at the p90 of the last 20 deltas; and whether the newest response was the first to carry an edit. */
export function replayGrowth(branch: Any[], g0: number): { g: number; deltas: number[]; justEdited: boolean } {
	const edited = carriedEdits(branch);
	let g = g0, deltas: number[] = [], prevKey = "", prevTotal = 0, justEdited = false;
	branch.forEach((e, i) => {
		const m = e?.type === "message" ? e.message : null;
		if (m?.role !== "assistant") return;
		justEdited = edited.has(i);
		const u = m.usage;
		if (!u || m.stopReason === "error" || m.stopReason === "aborted") return;
		const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (!(total > 0)) return;
		const key = `${m.provider ?? ""}/${m.model ?? ""}`;
		if (!edited.has(i) && prevKey === key && prevTotal > 0 && total >= prevTotal) ({ g, deltas } = grow(g, deltas, total - prevTotal));
		prevTotal = total;
		prevKey = key;
	});
	return { g, deltas, justEdited };
}
