// Model-switch fitting is fork policy. The runtime supplies planning, background work and commit hooks.
import { modelKey } from "./cache.ts";
import { headOf, checkEdits, type Artifact } from "./core.ts";
import { compactionRoom, foldPlaceholder, type Cut, type PlanOpts, type PlanResult, type Scale, type plan } from "./plan.ts";
import { type Any, PRODUCT, tokensOf } from "./util.ts";
const errText = (err: unknown) => err instanceof Error ? err.message : String(err);
export interface SwitchPlan { o: PlanOpts; cal: Scale; p: PlanResult }
export interface SwitchPending extends SwitchPlan { key: string; cut: Cut; before: number; after: number; waitMs: number }
interface SwitchHost {
	reserve: number;
	branch(): Any[];
	ready(): Artifact[];
	planFor(entries: Any[], rescue?: PlanOpts["rescue"]): { o: PlanOpts; cal: Scale; q: ReturnType<typeof plan> };
	useFolds(plan: SwitchPlan): void;
	background(head: string, signal?: AbortSignal): Promise<unknown> | null;
	roomWait(p: PlanResult, ctx: Any): Promise<{ cut: Cut; ms: number } | null>;
	summaryModel(): Any;
	overflowed(head: string, key: string): boolean;
	active(): boolean;
	stop(reason: string): Any;
	install(pending: SwitchPending, forced?: ReadonlySet<string>): void;
	ledger(rec: Record<string, unknown>): void;
}

/** The fewest biggest outputs kept after `p`'s cut whose folds lower the view by `excess` real tokens. */
export function rescueFolds(p: PlanResult, o: PlanOpts, excess: number): Set<string> {
	const out = new Set<string>(), done = new Set(p.folds.map((t) => t.entryId));
	const kept = p.blocks.slice(p.cutIdx ?? 0).filter((b) => b.kind === "toolResult" && b.entryId && !b.edited && !done.has(b.entryId)).sort((x, y) => y.tokens - x.tokens);
	let saved = 0;
	for (const b of kept) {
		if (saved >= excess) break;
		const r = foldPlaceholder(b, p.calls, o);
		if (!r) continue;
		out.add(b.entryId!);
		saved += p.scale.c * (b.tokens - r.phTok);
	}
	return out;
}


export async function fitModelSwitch(e: Any, ctx: Any, host: SwitchHost): Promise<Any> {
	const room = compactionRoom(ctx.model, host.reserve);
	if (room === null) return undefined; // no window to fit: Pi's own handling stands
	const key = modelKey(ctx.model), head = headOf(host.branch()), t0 = performance.now();
	const entries = ctx.sessionManager.buildSessionProjection().entries;
	const fit = 0.9 * room; // planned sizes are estimates: headroom for the summary's real size and the next reply
	const afterOf = (p: PlanResult, summaryTokens: number) => p.cutIdx === null ? p.ctxAfterFolds : p.ctxAfterFolds - p.scale.c * (p.prefixTokens - summaryTokens);
	const planFor = (rescue?: PlanOpts["rescue"]) => host.planFor(entries, rescue);
	const log = (stage: string, extra: Any = {}) => host.ledger({ type: "model_switch", stage, model: key, room, ms: Math.round(performance.now() - t0), ...extra });
	try {
		let { o, cal, q } = planFor();
		if (!q) return { cancel: true }; // below the working view: nothing to compact
		if (q.f.ctxAfterFolds < fit) {
			host.useFolds({ o, cal, p: q.f });
			log("folds", { before: Math.round(q.f.ctxTokens), after: Math.round(q.f.ctxAfterFolds), folds: q.f.folds.length });
			return { cancel: true };
		}
		const readyFit = (): { p: PlanResult; cut: Cut } | null => {
			const p = q?.a;
			const cut = p ? host.ready().find((x) => x.key === p.firstKeptEntryId)?.cut : undefined;
			return p && cut && afterOf(p, tokensOf({ role: "compactionSummary", summary: cut.text })) < room ? { p, cut } : null;
		};
		let got = readyFit(), waitMs = 0, stage = "ready";
		const pending = !got ? host.background(head, e.signal) : null;
		if (pending) {
			const w0 = performance.now();
			await pending;
			waitMs = performance.now() - w0;
			if (e.signal?.aborted) return { cancel: true };
			({ o, cal, q } = planFor());
			if (!q) return { cancel: true };
			[got, stage] = [readyFit(), "waited"];
		}

		let rescue: PlanOpts["rescue"] | undefined;
		if (!got) {
			let p = q.c;
			if (!p || afterOf(p, p.summaryTokensPlanned) >= fit) {
				rescue = { cutLatest: true };
				({ o, cal, q } = planFor(rescue));
				p = q?.c ?? null;
				if (p && afterOf(p, p.summaryTokensPlanned) >= fit) {
					const force = rescueFolds(p, o, afterOf(p, p.summaryTokensPlanned) - fit);
					if (force.size) {
						rescue = { cutLatest: true, force };
						({ o, cal, q } = planFor(rescue));
						p = q?.c ?? null;
					}
				}
			}
			if (!p || afterOf(p, p.summaryTokensPlanned) >= room) {
				log("too-big", { after: p ? Math.round(afterOf(p, p.summaryTokensPlanned)) : null });
				return host.stop("even the current request with a summary of everything before it is over its safe room");
			}
			const sumModel = host.summaryModel();
			const call = (model: Any) => Object.create(ctx, { model: { value: model }, signal: { value: e.signal } });
			let w = await host.roomWait(p, call(sumModel));
			// The larger model failed (auth, quota): the new one still writes it when the prefix fits its window.
			if (w && !w.cut.llmOk && w.cut.reason !== "request-budget-overflow" && sumModel !== ctx.model && p.scale.c * p.prefixTokens < room) w = (await host.roomWait(p, call(ctx.model))) ?? w;
			const overflowed = w?.cut.reason === "request-budget-overflow" || host.overflowed(head, p.firstKeptEntryId!);
			if (!w || overflowed) {
				return e.signal?.aborted
					? { cancel: true }
					: host.stop(overflowed ? "protected user requests exceed the summary budget for the new window" : "its summary could not be written");
			}
			got = { p, cut: w.cut };
			waitMs += w.ms;
			stage = rescue?.force ? "rescue-folds" : rescue ? "rescue-cut" : "summary";
		}
		if (e.signal?.aborted) return { cancel: true };
		if (!host.active() || modelKey(ctx.model) !== key || headOf(host.branch()) !== head) return host.stop("the model or session changed while its summary was written");
		const { p, cut } = got;
		const after = afterOf(p, tokensOf({ role: "compactionSummary", summary: cut.text }));
		// a rescue cut may enter the protected turns (the length-recovery relaxation); every structural and pairing check stays
		const invalid = checkEdits(p.blocks, p.userTurns, p.folds, null, rescue?.force) ?? checkEdits(p.blocks, p.userTurns + (rescue?.cutLatest ? 2 : 0), [], cut);
		log(stage, { key: cut.firstKeptEntryId, before: Math.round(p.ctxTokens), after: Math.round(after), folds: p.folds.length, forced: rescue?.force?.size ?? 0, waitedMs: Math.round(waitMs), llmOk: cut.llmOk, ...(invalid ? { invalid } : {}) });
		if (after >= room || invalid) return host.stop(invalid ?? "its summary came out larger than planned");
		host.install({ key: cut.firstKeptEntryId, cut, before: p.ctxTokens, after, o, cal, p, waitMs }, rescue?.force);
		return { compaction: { summary: cut.text, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: p.ctxTokens,
			details: { by: PRODUCT, via: "native", door: "model-switch", trigger: "cold", waitedMs: Math.round(waitMs) }, usage: cut.usage } };
	} catch (err) {
		return host.stop(`summary preparation failed: ${errText(err)}`);
	}
}
