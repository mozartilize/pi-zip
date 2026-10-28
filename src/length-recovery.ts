// Fork recovery for Pi's repaired length-stop boundary. Never recover twice in the same user turn.
import { type Any, PRODUCT } from "./util.ts";
import { buildBlocks, countUserTurns, type Block, type Cut, type PlanResult, type RunPlan } from "./plan.ts";
import { valvePlanOf } from "./core.ts";
interface LengthHost {
	steerIds: Set<string>;
	branch(): Any[];
	candidate(entries: Any[], branch: Any[]): PlanResult | null;
	prepare(p: PlanResult, branch: Any[]): { cut: Cut | null | undefined; promise: Promise<Cut | null> | null };
	wait(promise: Promise<Cut | null>): Promise<Cut | null>;
	active(): boolean;
	commit(e: Any, ctx: Any, plan: RunPlan, o: { t0: number; blocks: Block[]; userTurns: number; usageTotal: number; allowLatestCut: boolean }): Any;
}
export async function recoverLength(e: Any, ctx: Any, host: LengthHost): Promise<Any> {
	const branch = host.branch(), entries = e.context.contextEntries;
	const latestIdx = branch.findLastIndex((en: Any) => en?.type === "message" && en.message?.role === "assistant");
	const latestEntry = branch[latestIdx], latest = latestEntry?.message;
	const repair = latestIdx < 0 ? undefined : [...branch.slice(latestIdx + 1)].reverse().find((en: Any) => en?.type === "context_edit" && en.targetId === latestEntry.id);
	let recovered = false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const en = branch[i];
		if (en?.type === "message" && en.message?.role === "user") break;
		if (en?.type === "compaction" && en.details?.by === PRODUCT && en.details?.recovery === "length") { recovered = true; break; }
	}
	if (latest?.stopReason === "length" && repair?.replacement === null && e.context?.canContinue === true && !recovered) {
		const blocks = buildBlocks(entries, host.steerIds), userTurns = countUserTurns(blocks);
		// Price the same cut ordinary settle prepares for the next prompt; recovery uses it now with the current repaired turn as its runnable suffix.
		const p = host.candidate(entries, branch);
		if (p && p.cutIdx !== null) {
			const prepared = host.prepare(p, branch);
			const t0 = performance.now();
			let cut: Cut | null = prepared.cut ? { ...prepared.cut, prepared: true } : null;
			if (!cut && prepared.promise) cut = await host.wait(prepared.promise);

			if (cut && cut.reason !== "request-budget-overflow" && host.active()) {
				const waitMs = performance.now() - t0;
				const plan = valvePlanOf(p, { ...cut, trigger: "valve", prepared: true }, true, waitMs, waitMs);
				const out = host.commit(e, ctx, plan, { t0, blocks, userTurns, usageTotal: 0, allowLatestCut: true });
				if (out) {
					const compaction = out.entries.find((d: Any) => d.type === "compaction" && d.summary === cut!.text);
					if (compaction) compaction.details = { ...compaction.details, recovery: "length" };
					return out;
				}
			}
		}
	}
return null;
}
