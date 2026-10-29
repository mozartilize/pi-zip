// Fork runtime: inherit the upstream lifecycle/producer and implement only the extension policies.
import { Zip, errText, waitFor, type NativeRun } from "./run.ts";
import { type Any, PRODUCT, textOf } from "./util.ts";
import { lastPrompt, modelKey } from "./cache.ts";
import { candidateOf, checkEdits, headOf, readyOf, type Avail } from "./core.ts";
import { buildBlocks, coldTarget, compactionRoom, settings, sizeOf, toolCallIndex, wireTokensOf,
	type Block, type Cut, type FoldTarget, type PlanOpts, type PlanResult, type RunPlan, type Scale } from "./plan.ts";
import { formatRequestsLedger, branchOutputs, recalledHandlesFromBranch, resolveHandlesInBranch } from "./recall-extended.ts";
import { materialize, recallRoot } from "./recallfile.ts";
import { buildCut } from "./summary-engine.ts";
import { plan } from "./plan-fork.ts";
import { Judge, HINT_CUSTOM, JUDGE_CUSTOM, latestProjectedUser } from "./judge.ts";
import { DecisionLog } from "./decision-log.ts";
import { RequestNotes, type RequestMemory } from "./request-notes.ts";
import { fitModelSwitch } from "./model-switch.ts";
import { recoverLength } from "./length-recovery.ts";

export class ZipFork extends Zip {

	private judge = new Judge((rec) => this.ledger(rec));
	private judgeReq = 0;
	private judgePrompt = "";
	private stuckNoted = false;
	// model switch: the folds-only plan a cancelled threshold compaction hands this run, the compaction Pi is committing, the rescue folds
	// allowed in protected turns until committed, and the newest request's model (its larger window reads a prefix the new one cannot)
	private switchRun: { o: PlanOpts; cal: Scale; p: PlanResult } | null = null;
	private switchPending: (NativeRun & { key: string; waitMs: number }) | null = null;
	private overflowFailedKeys = new Set<string>();
	private rescueIds = new Set<string>();
	private lastReqModel: Any = null;
	private decisionLog = new DecisionLog();
	get ledgerSid() { return this.decisionLog.sid; }
	set ledgerSid(sid: string) { this.decisionLog.sid = sid; }
	override ledgerOn() { return this.decisionLog.enabled(); }
	private rotateLedger() { this.decisionLog.rotate(); }
	/** Fork ledger fields of a law record: the summary pressure gate and the fold decision. */
	protected override lawFields(o: PlanOpts): Record<string, unknown> {
		const sg = o.summaryGate ? { before: Math.round(o.summaryGate.before), afterFolds: Math.round(o.summaryGate.afterFolds), target: Math.round(o.summaryGate.target), threshold: o.summaryGate.threshold === null ? null : Math.round(o.summaryGate.threshold), prepareThreshold: o.summaryGate.prepareThreshold === null ? null : Math.round(o.summaryGate.prepareThreshold), room: o.summaryGate.room === null ? null : Math.round(o.summaryGate.room), eligible: o.summaryGate.eligible, prepareEligible: o.summaryGate.prepareEligible, reason: o.summaryGate.reason, ...(o.summaryGate.checkpoint ? { checkpoint: o.summaryGate.checkpoint } : {}) } : undefined;
		return { ...(sg ? { summaryGate: sg } : {}), ...(o.foldDecision ? { foldDecision: o.foldDecision } : {}) };
	}
	protected override onSessionStart(ctx: Any) {
		this.judge.stop("session-changed");
		const judge = this.judge = new Judge((rec) => this.ledger(rec));
		// A call of a replaced judge (an earlier session) settling late must not write into this one.
		judge.persistStats = (delta) => { if (this.judge === judge) this.pi.appendEntry(JUDGE_CUSTOM, delta); };
		this.ledgerSid = this.sessionId(ctx); // this session's ledger file, before the first record names it
		this.rotateLedger();
		this.judgeReq = 0;
		this.judgePrompt = "";
	}
	/** Write `requests.txt` (raw-branch-v2 request ledger) for file-based recall when `zip_recall` is hidden. */
	protected override materializeRequests(ctx: Any): string | null {
		const sid = this.recallSid(ctx);
		if (!sid) return null;
		const text = formatRequestsLedger(this.branch(ctx));
		const out = materialize(recallRoot(), sid, [{ handle: "requests", text }]);
		this.ledger({ type: "recall_file", requests: true, chars: text.length });
		return out.get("requests") ?? null;
	}
	protected override onBeforeAgentStart(ctx: Any, e?: Any) {
		this.judgePrompt = typeof e?.prompt === "string" ? e.prompt : "";
	}
	protected override onAgentEnd() {
		this.judge.stop("run-ended", true);
		this.notes.resetMemory();
	}
	protected override onBeginRun(ctx: Any) {
		this.stuckNoted = false;
		this.judge.startRun();
		this.notes.resetLookup(); // a cue is request-local: a new run with the same text gets it again
		if (!this.judgePrompt) this.judgePrompt = textOf([...this.branch(ctx)].reverse().find((e) => e.message?.role === "user")?.message?.content);
	}
	private switchedModel(ctx: Any): boolean {
		// Pi may check compaction before the first agent_start after reopening a session restores prevKey.
		const previous = this.lastModelKey || this.prevKey || lastPrompt(this.branch(ctx)).key;
		return !!previous && !!ctx?.model && previous !== modelKey(ctx.model);
	}

	private stopSwitch(ctx: Any, reason: string) {
		this.ledger({ type: "model_switch_blocked", model: modelKey(ctx.model), reason });
		this.notify(ctx, `${PRODUCT}: the context does not fit ${ctx.model?.id ?? "the selected model"} (${reason}); the run stopped with the history intact. Select a larger-window model, or shorten the latest request.`);
		// Awaiting abort from an active hook deadlocks: Pi waits for this handler before it can settle.
		void Promise.resolve(ctx.abort?.()).catch((err) => this.ledger({ type: "error", where: "switch_abort", error: errText(err) }));
		return { cancel: true };
	}

	/** The next request of this run plans again: its run plan was made for the previous model's window. */
	private replan() {
		this.runPlan = null;
		this.runEdits = false;
		this.runChecked = false;
	}

	/** The newest request's model when its window is larger: it can still read a prefix the new model cannot. */
	private summaryModel(ctx: Any): Any {
		const old = this.lastReqModel;
		return old && modelKey(old) !== modelKey(ctx.model) && Number(old.contextWindow) > Number(ctx.model?.contextWindow) ? old : ctx.model;
	}


	/**
	 * Pi checks its compaction threshold before context hooks, so a switch to a smaller window is fitted here, least loss first:
	 * 1. folds alone fit: cancel Pi's compaction; this run's next request carries the folds;
	 * 2. a READY prefix summary fits with the kept turns after their folds: Pi compacts with it;
	 * 3. a summary being written: wait for it, then 2;
	 * 4. write the cut this window needs now, its narrative read by the previous model when that window is larger;
	 * 5. the two protected turns alone are too big: cut up to the current user message, then fold its biggest outputs as needed.
	 * The run stops only when even the current request cannot fit. Folds ride the run plan (nativeRun); Pi's entry is the summary.
	 */
	private async switchCompact(e: Any, ctx: Any): Promise<Any> {
		return fitModelSwitch(e, ctx, {
			reserve: this.reserve(ctx), branch: () => this.branch(ctx), ready: () => readyOf(this.branch(ctx), this.mine),
			planFor: (entries, rescue) => {
				const avail = this.ready(this.branch(ctx)).filter(a => !a.running);
				const { o, cal } = this.opts(ctx, false, entries, 0, true, undefined, false, avail.map(a => a.key));
				o.readySizes = Object.fromEntries(avail.filter(a => a.summaryTokens !== undefined).map(a => [a.key, a.summaryTokens!]));
				if (rescue) o.rescue = rescue;
				return { o, cal, q: plan(entries, o) };
			},
			useFolds: p => { this.switchRun = p; this.replan(); },
			background: (head, signal) => {
				const bg = this.bg;
				return bg && !bg.aborted && bg.head === head
					? this.working(ctx, `${PRODUCT}: finishing a summary for ${ctx.model?.id ?? modelKey(ctx.model)}`, waitFor(bg.promise, signal)) : null;
			},
			roomWait: (p, c) => this.roomWait(p, c), summaryModel: () => this.summaryModel(ctx),
			overflowed: (head, key) => this.overflowFailedKeys.has(`${head}:${key}`), active: () => this.active(),
			stop: reason => this.stopSwitch(ctx, reason), ledger: rec => this.ledger(rec),
			install: (pending, forced) => { this.cancelTimer(); this.rescueIds = new Set(forced ?? []); this.switchPending = pending; },
		});
	}

	/** Book only the switch compaction Pi actually committed (another extension can replace or cancel it); its folds ride the run plan. */
	sessionCompact(e: Any, _ctx: Any) {
		const entry = e.compactionEntry, s = this.switchPending;
		this.switchPending = null;
		if (!s || entry?.details?.by !== PRODUCT || entry.details.door !== "model-switch" || entry.firstKeptEntryId !== s.key || entry.summary !== s.cut.text) {
			if (s) this.rescueIds.clear();
			return;
		}
		const { cut } = s, c = s.p.scale.c, saved = Math.round(c * (cut.prefixTokens - cut.summaryTokens));
		this.stats.summaries++;
		this.stats.summarizedTokens += saved;
		this.stats.activeSaved += saved;
		this.stats.writeSavedTokens += saved;
		this.rent = 0;
		this.nextEdit = 0;
		this.discardBg("replaced");
		this.replan();
		this.nativeRun = { cut, before: s.before, after: s.after, o: s.o, cal: s.cal, p: s.p, waitMs: s.waitMs };
		this.ledger({ type: "summary", via: "native", door: "model-switch", trigger: "cold", count: cut.count, tokensBefore: entry.tokensBefore,
			prefixTokens: Math.round(c * cut.prefixTokens), summaryTokens: Math.round(c * cut.summaryTokens), waitedMs: Math.round(s.waitMs),
			ms: cut.ms, llmOk: cut.llmOk, llmError: cut.llmError, costUsd: cut.costUsd, ...this.usageOf(cut) });
	}
	/** A cut whose summary overflowed its request budget counts as running: no plan waits for it or starts it again. */
	protected override extendAvailability(branch: Any[], out: Avail[]) {
		const head = headOf(branch);
		for (const k of this.overflowFailedKeys) {
			if (!k.startsWith(`${head}:`)) continue;
			const fk = k.slice(head.length + 1);
			if (!out.some((a) => a.key === fk)) out.push({ key: fk, running: true });
		}
	}
	/** A switch can land after Pi's pre-request compaction check. Context hooks cannot persist a summary: fail closed. */
	protected override contextBlocked(ctx: Any, messages: Any[]): boolean {
		if (!this.switchedModel(ctx)) return false;
		const room = compactionRoom(ctx.model, this.reserve(ctx));
		const tokens = sizeOf(this.scaleOf(ctx), messages.filter((m: Any) => m.role !== "system").reduce((n: number, m: Any) => n + wireTokensOf(m), 0));
		if (room === null || tokens < room) return false;
		this.stopSwitch(ctx, "the request still exceeds the new model's safe room");
		return true;
	}
	memory: RequestMemory | null = null;
	private notes = new RequestNotes(rec => this.ledger(rec));
	retrievalNote = (ctx: Any, signal?: AbortSignal): Promise<string | null> =>
		this.memory?.awaitNote && this.inRun ? this.memory.awaitNote(ctx, signal) : Promise.resolve(null);

	private noteHost() {
		return { inRun: this.inRun, recallMode: this.recallMode, steerIds: this.steerIds, foldedCalls: this.foldedCalls,
			recalled: this.recalled, judgeReq: this.judgeReq, judge: this.judge,
			branch: (ctx: Any) => this.branch(ctx), scaleOf: (ctx: Any, entries?: Any[]) => this.scaleOf(ctx, entries),
			reserve: (ctx: Any) => this.reserve(ctx), appendHint: (handles: string[]) => this.pi.appendEntry(HINT_CUSTOM, { handles }) };
	}
	private withMemory(messages: Any[], ctx: Any) { return this.notes.withMemory(messages, ctx, this.memory, this.noteHost()); }
	private withHint(messages: Any[], ctx: Any) { return this.notes.withHint(messages, ctx, this.noteHost()); }

	/** Request-local lookup/judge hint, then the retrieval note after the prompt; null: nothing to add. */
	protected override requestNotes(messages: Any[], ctx: Any): Any[] | null {
		const hinted = this.withHint(messages, ctx);
		return this.withMemory(hinted ?? messages, ctx) ?? hinted;
	}
	/** A repaired length stop has one chance to take its summary at this boundary (length-recovery.ts). */
	protected override async recoverBoundary(e: Any, ctx: Any): Promise<Any> {
		const recovered = await recoverLength(e, ctx, {
			steerIds: this.steerIds, branch: () => this.branch(ctx), active: () => this.active(),
			candidate: (entries, branch) => candidateOf(entries, (cutAt, foldsOnly, ready) => this.opts(ctx, true, entries, 1, false, cutAt, foldsOnly, ready), this.avail(branch), "length").r.p,
			prepare: (p, branch) => {
				if (this.bg && (this.bg.head !== headOf(branch) || this.bg.key !== p.firstKeptEntryId)) this.discardBg("replaced");
				const cut = readyOf(branch, this.mine).find(a => a.key === p.firstKeptEntryId)?.cut;
				if (!cut && (!this.bg || this.bg.aborted)) this.startBg(p, ctx, true);
				const bg = this.bg;
				return { cut, promise: !cut && bg && !bg.aborted && bg.key === p.firstKeptEntryId ? bg.promise : null };
			},
			wait: async promise => {
				this.inRun = true;
				try { return await this.working(ctx, `${PRODUCT}: recovering from the context limit`, promise); }
				finally { this.inRun = false; }
			},
			commit: (e, ctx, plan, o) => this.commit(e, ctx, plan, o),
		});
		if (!recovered) return null;
		this.rent = 0;
		this.cancelTimer();
		this.cancelDoor();
		return { entries: [...recovered.entries, ...this.drafts()], continue: true };
	}
	/** A summary over its request budget is never adopted: its key is not produced again for this head. */
	private forkBgOverflow(c: Cut, head: string, key: string, estUsd: number, room: unknown): null {
		this.overflowFailedKeys.add(`${head}:${key}`);
		const usd = c.costUsd || estUsd;
		this.stats.summaryUsd += usd;
		this.record({ head, key, usd, ...(c.costUsd ? {} : { estimated: true }), lost: "request-budget-overflow", error: "request-budget-overflow" });
		this.ledger({ type: "summary_overflow", where: room ? "room" : "background", key, reason: c.reason, ...(c.overflow ?? {}) });
		return null;
	}
	/** Invalidate old judge advice before this boundary's planner reads it; never drop this turn's edits for an optional hint. */
	protected override beforeTurnEnd(e: Any, ctx: Any) {
		if (!this.judge.enabled || !this.inRun || !this.active() || e.message?.stopReason !== "toolUse") return;
		try {
			for (const h of recalledHandlesFromBranch(this.branch(ctx))) this.recalled.add(h);
			this.judgeBoundary(e, ctx, buildBlocks(e.context?.contextEntries ?? [], this.steerIds));
		} catch (err) {
			this.ledger({ type: "error", where: "judge", error: errText(err) });
		}
	}
	private judgeBoundary(e: Any, ctx: Any, blocks: Block[]) {
		if (!this.judge.enabled || !this.inRun || !this.active() || e.message?.stopReason !== "toolUse") return;
		const entries = e.context.contextEntries;
		const { o, cal: sc } = this.opts(ctx, false, entries, 1, false);
		this.judge.maybeRun(ctx, blocks, toolCallIndex(blocks), this.judgePrompt, this.judgeReq,
			sizeOf(sc, blocks.reduce((n, b) => n + b.tokens, 0)), coldTarget(settings().coldCap, sc.O, compactionRoom(ctx.model, this.reserve(ctx))), o);
	}
	/** Once per run: over the working size with nothing left to fold or summarise. */
	protected override afterTurnDecision(ctx: Any, d: Any, runPlan: RunPlan | null) {
		const carriedWork = !!(runPlan && (runPlan.folds.length || runPlan.cut || runPlan.native));
		if (d.stuck && !d.room && !d.produce && !carriedWork && !(d.p && (d.p.folds.length || d.p.cutIdx != null)) && !this.quiet && !this.stuckNoted) {
			this.stuckNoted = true;
			this.notify(ctx, `${PRODUCT}: context is still over the working size, and no further fold or summary is available`);
	}
	}
	/** At a repaired length stop there is no upcoming prompt: the recovery cut may keep only the current runnable turn. Fold protections
	 *  and all structural/pairing checks stay; only the two-turn margin is relaxed for that cut. Rescue folds may enter protected turns. */
	protected override validateEdits(o: { blocks: Block[]; userTurns: number; allowLatestCut?: boolean }, live: FoldTarget[], cut: Cut | null) {
		return o.allowLatestCut && cut
			? checkEdits(o.blocks, o.userTurns, live, null, this.rescueIds) ?? checkEdits(o.blocks, o.userTurns + 2, [], cut)
			: checkEdits(o.blocks, o.userTurns, live, cut, this.rescueIds);
	}
	protected override onModelSelect() {
		this.judge.stop("model-changed");
		this.judge.verdicts.clear();
		if (this.inRun) this.judge.startRun();
	}
	protected override onSetOff(off: boolean) {
		if (!off && this.inRun) this.judge.startRun();
		if (off) {
			this.memory?.cancelRetrieval();
			this.judge.stop("disabled");
		}
	}
	override ledger(rec: Record<string, unknown>) { this.decisionLog.write(rec); }
	protected override configurePlan(o: PlanOpts, entries: Any[]) {
		if (this.inRun && this.active()) o.verdicts = this.judge.labels(this.judgeReq, latestProjectedUser(entries));
	}
	protected override onConflict() { this.memory?.cancelRetrieval(); }
	protected override restoreExtensionState(branch: Any[]) {
		for (const en of branch) {
			if (en?.type !== "custom") continue;
			if (en.customType === HINT_CUSTOM && Array.isArray(en.data?.handles)) this.judge.restoreHinted(en.data.handles);
			else if (en.customType === JUDGE_CUSTOM) this.judge.restoreStats(en.data);
		}
	}
	protected override onShutdown() { this.judge.stop("shutdown"); }
	protected override thresholdCompaction(e: Any, ctx: Any): Any {
		if (e?.reason === "threshold" && ctx && this.active() && this.switchedModel(ctx)) return this.switchCompact(e, ctx);
	}
	protected override takeRunOverride() { const p = this.switchRun; this.switchRun = null; return p; }
	protected override forcedFolds() { return this.rescueIds; }
	protected override onSettle() { this.judge.stop("settle", true); }
	protected override canProduce(head: string, key: string, room: boolean) { return room || !this.overflowFailedKeys.has(`${head}:${key}`); }
	protected override rejectSummary(c: Cut, head: string, key: string, estUsd: number, room: boolean): boolean {
		if (c.reason !== "request-budget-overflow") return false;
		this.forkBgOverflow(c, head, key, estUsd, room);
		return true;
	}
	protected override onFoldsCommitted(folds: FoldTarget[]) { for (const t of folds) this.rescueIds.delete(t.entryId); }
	protected override onRequestModel(model: Any) { this.lastReqModel = model; }
	protected override onMessageEnd(m: Any) { if (m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") this.judgeReq++; }
	protected override cardExtras() { return this.judge.enabled ? { judge: { ...this.judge.stats } } : {}; }
	protected override statusExtra(): string {
		return this.judge.enabled ? `\njudge ${this.judge.stats.calls} calls $${this.judge.stats.costUsd.toFixed(4)} · ${this.judge.stats.unknown} unknown · ${this.judge.stats.errors} errors` : "";
	}
	protected override buildSummary(p: PlanResult, ctx: Any, signal: AbortSignal) { return buildCut(p, ctx, signal); }
	protected override outputs(branch: Any[]) { return branchOutputs(branch); }
	protected override recalledInBranch(branch: Any[]) { return recalledHandlesFromBranch(branch); }
	protected override resolveHandles(branch: Any[], handles: string[]) { return resolveHandlesInBranch(branch, handles); }

}
