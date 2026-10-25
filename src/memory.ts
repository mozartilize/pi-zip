// Session memory: the deterministic ledger of the opened session (src/ledger) and retrieval at new user prompts (src/retrieval).
// Always on, and free until the session has something hidden: every persisted entry is projected (no model call), but retrieval
// runs only when a fold or a compaction left earlier output that the model view no longer shows in full. Nothing is injected before
// that. Nothing here consults the judge, and nothing here changes folding or compaction. Every failure is logged and skipped.
import { randomUUID } from "node:crypto";
import { Ledger, type LedgerCounts } from "./ledger/projector.ts";
import { readSource, type SessionSource, visibleText } from "./ledger/source.ts";
import { sqliteAvailable } from "./ledger/db.ts";
import { ageOf, type CallInfo, memoryTraceEnabled, RetrievalConversation } from "./retrieval/assistant.ts";
import { type DropStats, PACKET_LIMITS, renderPacket } from "./retrieval/packet.ts";
import { DEFAULT_LIMITS, hiddenOutputs, queryOf, retrieve, scopeOf } from "./retrieval/search.ts";
import { handleFor } from "./handle.ts";
import { recordOffers, recordRests, resting } from "./retrieval/offers.ts";
import type { Any } from "./util.ts";

export type LedgerState = "idle" | "indexing" | "ready" | "error";

/** The run's packet: bound to the session and the prompt it was made for. */
export interface Note { sessionId: string; requestId: string; prompt: string; text: string; deferred: boolean; cited: string[] }
interface RetrievalJob { requestId: string; controller: AbortController; deferred: boolean }

/** Foreground wait only. The provider has a separate hard timeout. */
export const retrievalWaitMs = () => {
	const n = Number(process.env.PI_ZIP_RETRIEVAL_WAIT_MS);
	return Number.isFinite(n) && n >= 0 && process.env.PI_ZIP_RETRIEVAL_WAIT_MS?.trim() ? n : 5000;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** PI_ZIP_RETRIEVAL_TIMEOUT_MS, also echoed in the memory_config record. */
export const retrievalTimeoutMs = () => (Number(process.env.PI_ZIP_RETRIEVAL_TIMEOUT_MS) > 0 ? Number(process.env.PI_ZIP_RETRIEVAL_TIMEOUT_MS) : 20_000);
const clip = (s: string, n: number) => {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
/** Consecutive ledger failures after which this session stops trying until it is opened again. */
const MAX_FAILURES = 3;
/** Entries projected per transaction while a first backfill is spread across ticks (a long session must not freeze Pi). */
const BACKFILL_ENTRIES = 500;

export class Memory {
	private ledger: Ledger | null = null;
	private sid = "";
	state: LedgerState = "idle";
	error = "";
	private failures = 0;
	private gen = 0;
	private backfill: ReturnType<typeof setTimeout> | null = null;
	private runBackfill: (() => void) | null = null;
	/** Resolves when the deferred session-start backfill has run (tests and diagnostics). */
	ready: Promise<void> = Promise.resolve();
	/** The knobs this session runs with, written once so one log can be compared against another configuration. */
	private configLogged = false;
	private note: Note | null = null;
	private noteShown = false;
	private job: RetrievalJob | null = null;
	/** The ledger has caught up with the session's persisted entries. */
	private ledgerDone = true;
	private backfillSrc: SessionSource | null = null;
	private pumping = false;
	stats = { prompts: 0, calls: 0, injected: 0, reinjected: 0, costUsd: 0 };

	constructor(private log: (rec: Record<string, unknown>) => void) {}

	/** session_start: forget the previous session at once; backfill only this session, right after the handler returns. */
	sessionStart(ctx: Any) {
		this.release();
		this.configLogged = false;
		this.gen++;
		this.failures = 0;
		this.error = "";
		this.state = "idle";
		this.ledgerDone = true;
		this.backfillSrc = null;
		this.sid = attempt(() => String(ctx?.sessionManager?.getSessionId?.() ?? ""), "");
		const gen = this.gen;
		this.ready = new Promise((done) => {
			const run = () => {
				if (this.backfill) clearTimeout(this.backfill);
				this.backfill = null;
				this.runBackfill = null;
				if (gen === this.gen) this.ensure(ctx, "session_start");
				done();
			};
			this.runBackfill = run;
			this.backfill = setTimeout(run, 0);
		});
	}

	/**
	 * Bring the ledger up to the session's persisted entries (open + reconcile the first time, append after). Fail open: null.
	 * A first open projects the history in batches across ticks (BACKFILL_ENTRIES per transaction), so opening a long session does
	 * not freeze Pi; retrieval skips until the ledger has caught up with its source.
	 */
	ensure(ctx: Any, why: string): Ledger | null {
		const led = this.ensureSync(ctx, why);
		if (led && !this.ledgerDone) this.pumpBackfill(ctx, led, why);
		return led;
	}

	/** The synchronous part of ensure(): open, and project one batch when the ledger is new or behind. */
	private ensureSync(ctx: Any, why: string): Ledger | null {
		if (!sqliteAvailable() || this.failures >= MAX_FAILURES) return null;
		try {
			const src = readSource(ctx);
			if (!src || !src.entries.length) return this.ledger; // nothing persisted yet: the first persisted entry starts the ledger
			if (src.sessionId !== this.sid) {
				this.release();
				this.sid = src.sessionId;
			}
			if (!this.ledger) {
				this.state = "indexing";
				const led = Ledger.open(src);
				try {
					const head = { ...src, entries: src.entries.slice(0, BACKFILL_ENTRIES) };
					const r = led.reconcile(head);
					this.ledger = led;
					this.backfillSrc = src;
					this.ledgerDone = led.current(src);
					this.log({ type: "memory_backfill", why, reconcile: r.mode, projected: r.projected, ms: Math.round(r.ms), entries: src.entries.length, done: this.ledgerDone });
				} catch (err) {
					led.close();
					throw err;
				}
			} else if (this.ledgerDone) {
				const n = this.ledger.catchUp(src);
				this.backfillSrc = src;
				if (n) this.log({ type: "memory_ingest", why, projected: n });
			} else this.backfillSrc = src;
			this.state = this.ledgerDone ? "ready" : "indexing";
			this.failures = 0;
			if (!this.configLogged) {
				this.configLogged = true;
				this.log({
					type: "memory_config", why,
					modelRef: process.env.PI_ZIP_JUDGE_MODEL ?? "(cheapest 32K model of the current provider)",
					timeoutMs: retrievalTimeoutMs(), waitMs: retrievalWaitMs(), trace: memoryTraceEnabled(),
					limits: DEFAULT_LIMITS, packet: PACKET_LIMITS, backfillBatch: BACKFILL_ENTRIES,
				});
			}
			return this.ledger;
		} catch (err) {
			this.failures++;
			this.state = "error";
			this.error = errText(err);
			this.release();
			this.log({ type: "error", where: `memory/${why}`, error: this.error, failures: this.failures });
			return null;
		}
	}

	/** Project the rest of a large first open, one batch per tick. */
	private pumpBackfill(ctx: Any, led: Ledger, why: string) {
		if (this.pumping) return;
		this.pumping = true;
		const t0 = Date.now();
		let projected = 0;
		const step = () => {
			const src = this.backfillSrc ?? attempt(() => readSource(ctx), null); // the newest read: the session keeps growing
			try {
				if (!src) return finish();
				projected += led.catchUp({ ...src, entries: src.entries.slice(0, Math.min(src.entries.length, led.projectedCount + BACKFILL_ENTRIES)) });
				if (!led.current(src)) return void setImmediate(step);
			} catch (err) {
				this.error = errText(err);
				this.log({ type: "error", where: `memory/${why}`, error: this.error });
			}
			finish();
		};
		const finish = () => {
			this.pumping = false;
			this.ledgerDone = true;
			this.state = "ready";
			if (projected) this.log({ type: "memory_ingest", why: `${why}_backfill`, projected, ms: Date.now() - t0 });
		};
		setImmediate(step);
	}

	/** turn_end, session_compact, session_tree, agent_end: live ingestion of newly persisted entries. */
	catchUp(ctx: Any, why: string) {
		if (why === "session_tree" || why === "session_compact") this.cancelRetrieval();
		if (this.backfill) return; // the session-start backfill has not run yet; it reads everything then
		this.ensure(ctx, why);
	}

	/**
	 * before_agent_start of a prompt-started run: nothing is injected until the branch has output the model no longer sees in full
	 * (a fold, or a compaction). Search hidden sources, then judge need and summarize in one model call. Never throws.
	 */
	async beforeAgentStart(ctx: Any, e: Any) {
		this.cancelRetrieval();
		if (e?.messageType !== "user" || typeof e.prompt !== "string" || !e.prompt.trim()) return;
		const job: RetrievalJob = { requestId: randomUUID(), controller: new AbortController(), deferred: false };
		this.job = job;
		const started = Date.now();
		// Own the eventual rejection even when the foreground stops waiting.
		const work = this.prepare(ctx, e, job).catch((err) => {
			try { this.log({ type: "error", where: "memory/background", requestId: job.requestId, error: errText(err) }); } catch {}
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waitMs = retrievalWaitMs();
		try {
			await Promise.race([work, new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					if (this.job === job && !job.controller.signal.aborted) {
						job.deferred = true;
						try { this.log({ type: "memory_deferred", requestId: job.requestId, waitMs, ms: Date.now() - started }); } catch {}
					}
					resolve();
				}, Math.max(0, waitMs - (Date.now() - started)));
			})]);
		} finally { if (timer !== undefined) clearTimeout(timer); }
	}

	private async prepare(ctx: Any, e: Any, job: RetrievalJob) {
		const t0 = Date.now();
		const requestId = job.requestId;
		const signal = AbortSignal.any([job.controller.signal, ...(ctx?.signal ? [ctx.signal] : [])]);
		const conv = new RetrievalConversation(ctx, signal);
		// One record per prompt, joined to its calls and its injection by requestId. `stage` says where a skipped run stopped, so a
		// log can be read without replaying the session; `latency` and `evidence` are what tuning needs (which candidate carried a
		// finding, and how long each step took). Nothing here changes behaviour.
		const rec: Record<string, unknown> = { type: "memory_retrieval", requestId, stage: "start" };
		const latency: Record<string, number> = {};
		let drops: DropStats | null = null;
		try {
			// nothing can be indexed without a persisted session (an in-memory one, or a new one before Pi's first flush): no call
			const src0 = readSource(ctx);
			if (!src0 || !src0.entries.length) return void (rec.skip = "no persisted session");
			const scope = scopeOf(ctx);
			const hidden = hiddenOutputs(scope);
			if (!hidden) return void (rec.skip = "nothing hidden yet");
			rec.hidden = hidden;
			this.stats.prompts++;
			rec.promptChars = e.prompt.length;
			const query = queryOf(e.prompt);
			Object.assign(rec, { terms: query.tokens, handles: query.handles.length ? query.handles : undefined });
			if (!query.tokens.length) return void (rec.skip = "no search terms");
			this.runBackfill?.(); // a prompt sent before the deferred backfill ran: backfill now, then search
			const led = this.ensure(ctx, "before_agent_start");
			const src = readSource(ctx);
			if (!led || !src || !led.current(src)) return void (rec.skip = led ? "ledger behind its session" : `ledger ${this.state}`);
			let t = Date.now();
			const r = retrieve(led.db, query, scope, DEFAULT_LIMITS, resting(led.db));
			recordRests(led.db, r.rested);
			if (r.rested.length) rec.rested = r.rested.map(handleFor);
			latency.search = Date.now() - t;
			Object.assign(rec, { hits: r.hits, inBranch: r.inBranch, candidates: r.evidence.length, expand: DEFAULT_LIMITS.expand });
			const evidenceLog = r.evidence.map((x) => ({
				ref: x.ref, handle: x.handle, kind: x.kind, hidden: x.hidden, tool: x.tool ?? undefined,
				error: x.isError || undefined, folded: x.folded || undefined, exact: x.exact || undefined,
				matched: x.matched, chars: x.excerpt.length, thinkingItems: x.context.length, cited: false,
			}));
			rec.evidence = evidenceLog;
			if (!r.evidence.length) return void (rec.skip = "no candidates");
			const revision = `${src.entries.length}:${src.entries[src.entries.length - 1]?.id ?? ""}`;
			this.stats.calls++;
			t = Date.now();
			drops = { unknownHandle: 0, empty: 0, cap: 0, notFolded: 0, notNeeded: 0 };
			const packet = await conv.answer(e.prompt, recentContext(ctx), r.evidence, requestId, revision, drops);
			latency.answer = Date.now() - t;
			if (conv.decisions.length) {
				const byRef = new Map(r.evidence.map((x) => [x.ref, x.entryId]));
				recordOffers(led.db, conv.decisions.flatMap((d) => (byRef.has(d.ref) ? [{ entryId: byRef.get(d.ref)!, needed: d.need === "Y" }] : [])));
			}
			// A provider may ignore abort. Never publish its late response into another run or branch.
			if (signal.aborted || this.job !== job || String(ctx?.sessionManager?.getSessionId?.() ?? "") !== src.sessionId) return void (rec.skip = "cancelled");
			if (!packet) return void (rec.skip = "answer failed");
			const now = scopeOf(ctx);
			if ([...scope.hidden.keys()].some((id) => !now.hidden.has(id))) return void (rec.skip = "source visibility changed");
			const ages = new Map(r.evidence.filter((x) => x.at).map((x) => [x.handle, `${ageOf(x.at, Date.now())} ago`]));
			const text = renderPacket(packet, ages);
			if (!text) return void (rec.skip = "nothing relevant");
			const cited = new Set([...packet.findings.flatMap((x) => x.sourceHandles), ...packet.foldedCandidates.map((x) => x.handle)]);
			this.note = { sessionId: src.sessionId, requestId, prompt: e.prompt, text, deferred: job.deferred, cited: [...cited] };
			if (memoryTraceEnabled()) rec.note = text; // the exact text the main model will read, for judging quality later
			for (const x of evidenceLog) x.cited = cited.has(x.handle);
			Object.assign(rec, { findings: packet.findings.length, folded: packet.foldedCandidates.length, chars: text.length, revision });
		} catch (err) {
			rec.error = errText(err);
		} finally {
			rec.stage = rec.error ? "error" : rec.skip ? String(rec.skip) : "prepared";
			rec.deferred = job.deferred;
			rec.decisions = conv.decisions;
			rec.latency = latency;
			rec.ms = Date.now() - t0;
			rec.input = conv.stats;
			rec.drops = drops ?? undefined;
			rec.calls = conv.calls.map((c: CallInfo) => ({
				step: c.step, model: c.model, level: c.level, ms: c.ms, costUsd: c.costUsd,
				inTokens: c.inTokens, outTokens: c.outTokens, cacheReadTokens: c.cacheReadTokens,
				stopReason: c.stopReason, replyChars: c.replyChars, thinkingChars: c.thinkingChars,
				...(c.error ? { error: c.error } : {}), ...(c.reply !== undefined ? { reply: c.reply } : {}),
			}));
			for (const c of conv.calls) this.stats.costUsd += c.costUsd;
			this.log(rec);
		}
	}

	/** The packet of the current run, when it still belongs to the open session; consumed by run.ts on every request of the run. */
	current(ctx: Any): Note | null {
		const n = this.note;
		if (!n || this.job?.controller.signal.aborted) return null;
		const sid = attempt(() => String(ctx?.sessionManager?.getSessionId?.() ?? ""), "");
		if (sid !== n.sessionId) {
			this.note = null;
			return null;
		}
		return n;
	}
	/** run.ts put the packet into a request (logged once per run, for the first request it went into). */
	injected(chars: number, at: number) {
		if (this.noteShown) return;
		this.noteShown = true;
		this.stats.injected++;
		this.log({ type: "memory_inject", requestId: this.note?.requestId, chars, at, deferred: this.note?.deferred ?? false });
	}

	/** One later request of the same run carried the note again (the run's cacheable prefix held). Counted, not logged one by one. */
	reinjected() {
		this.stats.reinjected++;
	}

	/** agent_end: the run's packet ends with it; the final entries are ingested. */
	agentEnd(ctx: Any) {
		try { this.logUsage(ctx); } catch (err) { this.log({ type: "error", where: "memory/usage", error: errText(err) }); }
		this.cancelRetrieval();
		this.catchUp(ctx, "agent_end");
	}

	shutdown() {
		this.gen++;
		this.note = null;
		this.release();
	}

	/**
	 * Did the run use the injected note? Read the run's own entries (everything after its last user message) and record which cited
	 * handles the model recalled with zip_recall or named in its own text. Only for a note that actually went into a request.
	 */
	private logUsage(ctx: Any) {
		const note = this.note;
		if (!note || !this.noteShown) return;
		const branch: Any[] = ctx?.sessionManager?.getBranch?.() ?? [];
		let start = branch.length;
		while (start > 0 && branch[start - 1]?.message?.role !== "user") start--;
		const run = branch.slice(start);
		const recalled = new Set<string>(), mentioned = new Set<string>();
		let recallCalls = 0, assistantMessages = 0;
		for (const e of run) {
			const m = e?.message;
			if (m?.role !== "assistant") continue;
			assistantMessages++;
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "toolCall" && b.name === "zip_recall") {
					recallCalls++;
					const args = JSON.stringify(b.arguments ?? {});
					for (const h of note.cited) if (args.includes(h)) recalled.add(h);
				}
				if (b?.type === "text" && typeof b.text === "string") for (const h of note.cited) if (b.text.includes(h)) mentioned.add(h);
			}
		}
		this.log({
			type: "memory_usage", requestId: note.requestId, deferred: note.deferred, cited: note.cited,
			recalled: [...recalled], mentioned: [...mentioned], recallCalls, assistantMessages,
			used: recalled.size > 0 || mentioned.size > 0,
		});
	}

	private cancelRetrieval() {
		this.job?.controller.abort();
		this.job = null;
		this.note = null;
		this.noteShown = false;
	}

	private release() {
		this.cancelRetrieval();
		this.pumping = false;
		this.backfillSrc = null;
		this.ledgerDone = true;
		const pending = this.runBackfill;
		if (pending) {
			this.gen++; // the pending backfill belongs to a session being left: it resolves `ready` without indexing
			pending();
		}
		this.ledger?.close();
		this.ledger = null;
	}

	/** One diagnostic line for the opened session only. */
	statusLine(ctx: Any): string {
		const src = attempt(() => readSource(ctx), null);
		const sid = src?.sessionId ?? this.sid;
		if (!sqliteAvailable()) return `ledger: session=${sid} status=error error="node:sqlite unavailable"`;
		let c: LedgerCounts | null = null;
		if (this.ledger) c = attempt(() => this.ledger!.counts(src?.entries.length ?? 0), null);
		const cov = c && c.rawChars ? ` coverage=${((100 * c.indexedChars) / c.rawChars).toFixed(1)}% truncated_blocks=${c.truncatedBlocks}` : "";
		return `ledger: session=${sid} status=${this.state}` +
			(c ? ` source_entries=${c.sourceEntries} indexed_entries=${c.indexedEntries} fts_docs=${c.ftsDocs} segments=${c.segments} nodes=${c.nodes} edges=${c.edges}${cov}` : "") +

			` retrieval: prompts=${this.stats.prompts} calls=${this.stats.calls} injected=${this.stats.injected} (in ${this.stats.reinjected} later requests) cost=$${this.stats.costUsd.toFixed(4)}` +
			(this.error ? ` error="${clip(this.error, 160)}"` : "");
	}
}

function attempt<T>(f: () => T, fallback: T): T {
	try { return f(); } catch { return fallback; }
}

/** The previous user request and the newest assistant reply on the active branch, clipped: enough to resolve "fix it again". */
export function recentContext(ctx: Any): string {
	const branch: Any[] = attempt(() => ctx?.sessionManager?.getBranch?.() ?? [], []);
	let user = "", asst = "";
	for (let i = branch.length - 1; i >= 0 && (!user || !asst); i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (!asst && m?.role === "assistant") asst = visibleText(m);
		if (!user && m?.role === "user") user = visibleText(m);
	}
	return [user && `previous user request: ${clip(user, 500)}`, asst && `latest assistant reply: ${clip(asst, 1200)}`].filter(Boolean).join("\n");
}
