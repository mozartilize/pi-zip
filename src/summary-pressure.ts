// Fork application/preparation thresholds, in real tokens. The preparation cap uses a 200K window and Pi's default reserves.
import { envInt } from "./util.ts";
export const DEFAULT_SUMMARY_WINDOW = 200_000;
export const SUMMARY_PRESSURE_CAP = 0.8 * (DEFAULT_SUMMARY_WINDOW - 16_384 - 8_192); // 140,339.2

/** Summary application threshold: 80% of the active model's safe compaction room, capped at 400K tokens.
 * Unknown windows cannot establish pressure unless PI_ZIP_SUMMARY_AT overrides the real-token threshold. */
export const summaryThreshold = (room: number | null): number => {
	const over = envInt("SUMMARY_AT", -1);
	if (over >= 0) return over;
	return room === null ? Infinity : Math.min(0.8 * room, 400_000);
};

/** Background summary preparation threshold: min(0.8 * room, 200K-window pressure cap).
 * On large windows (e.g. 1M), background summaries are prepared from 140.3K without applying them until the active window's own
 * min(0.8 * room, 400K) is reached. A switch can reuse a prepared prefix only if the summary plus untouched suffix fits the new window. */
export const summaryPrepareThreshold = (room: number | null): number => {
	const over = envInt("SUMMARY_AT", -1);
	if (over >= 0) return over;
	return room === null ? Infinity : Math.min(0.8 * room, SUMMARY_PRESSURE_CAP);
};


export function recordSummaryPressure(o: { foldsOnly?: boolean; summaryGate?: SummaryGate }, before: number, after: number, target: number, room: number | null): void {
	const threshold = summaryThreshold(room), prep = summaryPrepareThreshold(room);
	const prepareEligible = !o.foldsOnly && Number.isFinite(prep) && after > target && after >= prep;
	const eligible = !o.foldsOnly && Number.isFinite(threshold) && after > target && after >= threshold;
	const reason = o.foldsOnly ? "folds-only" : !Number.isFinite(threshold) ? "unknown-window" : after <= target ? "below-target" : eligible ? "pressure" : prepareEligible ? "prepare-only" : "below-pressure";
	o.summaryGate = { before, afterFolds: after, target, threshold: Number.isFinite(threshold) ? threshold : null, prepareThreshold: Number.isFinite(prep) ? prep : null, room, eligible, prepareEligible, reason };
}
export interface SummaryGate {
	before: number; afterFolds: number; target: number; threshold: number | null; prepareThreshold: number | null; room: number | null;
	eligible: boolean; prepareEligible: boolean; checkpoint?: { key: string; after: number; advance: number; refresh: boolean };
	reason: "folds-only" | "unknown-window" | "below-target" | "below-pressure" | "prepare-only" | "pressure";
}
