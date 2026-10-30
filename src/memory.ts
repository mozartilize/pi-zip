// Session memory: the deterministic ledger of the opened session (src/ledger) and retrieval at new user prompts (src/retrieval).
// Always on, and free until the session has something hidden: every persisted entry is projected (no model call), but retrieval
// runs only when a fold or a compaction left earlier output that the model view no longer shows in full. Nothing is injected before
// that. Nothing here consults the judge, and nothing here changes folding or compaction. Every failure is logged and skipped.
// Per prompt: a local search of the prompt's own words (awaited) while the planner call runs; then, in the background, the search with
// the planner's keywords and the answer call, delivered by a later request or zip_recall. Findings a run ended before showing go to
// the next prompt when it is related.
import { randomUUID } from "node:crypto";
import { Ledger, type LedgerCounts } from "./ledger/projector.ts";
import { readSource, visibleText } from "./ledger/source.ts";
import { sqliteAvailable } from "./ledger/db.ts";
import { ageOf, type CallInfo, memoryTraceEnabled, requestText, RetrievalConversation } from "./retrieval/assistant.ts";
import { type DropStats, PACKET_LIMITS, renderPacket } from "./retrieval/packet.ts";
import { type Plan, visibleTail } from "./retrieval/planner.ts";
import { DEFAULT_LIMITS, hiddenOutputs, type Query, queryOf, retrieve, type Scope, scopeOf } from "./retrieval/search.ts";
import { noteTerms, reusedTerms, written } from "./retrieval/usage.ts";
import type { Any } from "./util.ts";

export type LedgerState = "idle" | "indexing" | "ready" | "error";

/**
 * The run's note: bound to the session and the prompt it was made for. `pending` is shown while the answer call runs; `text` is the
 * findings (or NOTHING_NOTE) once it has finished, null before. `delivered`: zip_recall already returned the findings.
 */
export interface Note { sessionId: string; requestId: string; prompt: string; pending: string; text: string | null; found: boolean; cited: string[]; delivered: boolean }
interface RetrievalJob { requestId: string; controller: AbortController; answer: Promise<void> | null; ctx: Any }
/** Findings of a run that ended before any request showed them, kept for the next prompt. */
interface Carry { sessionId: string; requestId: string; text: string; cited: string[] }
type Retrieved = ReturnType<typeof retrieve>;
const LATE_HEADER = "[pi-zip: the findings below were prepared for the previous request, which ended before they were shown]";

/**
 * PI_ZIP_RETRIEVAL_MIN_HITS (default 11): a search with fewer full-text rows than this skips the answer call. In the recorded logs,
 * 26 searches had at most 10 rows; the answer call kept nothing for 21 of them. 0 turns the gate off.
 */
export const retrievalMinHits = () => {
	const v = process.env.PI_ZIP_RETRIEVAL_MIN_HITS;
	return v !== undefined && v !== "" && Number(v) >= 0 ? Number(v) : 11;
};

export const pendingNote = (n: number) =>
	`[pi-zip: a historical retrieval is reading ${n} earlier records of this session that are hidden from your view, for this request. ` +
	"Its findings will appear in a later message when ready. If you need earlier session history before you finish, call zip_recall with no " +
	"arguments to wait for the findings; otherwise continue without them.]";
export const NOTHING_NOTE = "[pi-zip: the historical retrieval for this request found nothing relevant in earlier session records.]";

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
	private backfillStep: ReturnType<typeof setImmediate> | null = null;
	private runBackfill: (() => void) | null = null;
	/** Resolves when the deferred session-start backfill has run (tests and diagnostics). */
	ready: Promise<void> = Promise.resolve();
	/** The knobs this session runs with, written once so one log can be compared against another configuration. */
	private configLogged = false;
	private note: Note | null = null;
	private noteShown = false;
	private pendingShown = false;
	private deliveryEntries: Set<string> | null = null;
	private deliveryBaseline = "";
	private job: RetrievalJob | null = null;
	/** A previous run's job still finishing after its run ended, and the findings such a run left: both for the next prompt only. */
	private carryJob: RetrievalJob | null = null;
	private carry: Carry | null = null;
	/** The ledger has caught up with the session's persisted entries. */
	private ledgerDone = true;
	private pumping = false;
	stats = { prompts: 0, calls: 0, injected: 0, reinjected: 0, costUsd: 0 };

	constructor(private log: (rec: Record<string, unknown>) => void) {}

	/** session_start: forget the previous session at once; backfill only this session, right after the handler returns. */
	sessionStart(ctx: Any) {
		this.release();
		this.configLogged = false;
		this.failures = 0;
		this.error = "";
		this.state = "idle";
		this.ledgerDone = false;
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
					const r = led.reconcile(src, BACKFILL_ENTRIES); // validates the whole source, projects at most one batch
					this.ledger = led;
					this.ledgerDone = led.current(src);
					this.log({ type: "memory_backfill", why, reconcile: r.mode, projected: r.projected, ms: Math.round(r.ms), entries: src.entries.length, done: this.ledgerDone });
				} catch (err) {
					led.close();
					throw err;
				}
			} else if (this.ledgerDone) {
				const n = this.ledger.catchUp(src);
				if (n) this.log({ type: "memory_ingest", why, projected: n });
			}
			this.state = this.ledgerDone ? "ready" : "indexing";
			if (this.ledgerDone) { this.failures = 0; this.error = ""; }
			if (!this.configLogged) {
				this.configLogged = true;
				this.log({
					type: "memory_config", why,
					modelRef: process.env.PI_ZIP_JUDGE_MODEL ?? "(cheapest 32K model of the current provider)",
					timeoutMs: retrievalTimeoutMs(), minHits: retrievalMinHits(), trace: memoryTraceEnabled(),
					limits: DEFAULT_LIMITS, packet: PACKET_LIMITS, backfillBatch: BACKFILL_ENTRIES,
				});
			}
			return this.ledger;
		} catch (err) {
			this.ledgerError(err, why);
			return null;
		}
	}

	/** Project the rest of a large first open, one batch per tick. Every callback belongs to one ledger generation. */
	private pumpBackfill(ctx: Any, led: Ledger, why: string) {
		if (this.pumping) return;
		this.pumping = true;
		const gen = this.gen, sid = this.sid, t0 = Date.now();
		const owns = () => gen === this.gen && this.ledger === led && this.sid === sid;
		let projected = 0;
		const step = () => {
			if (!owns()) return; // check before clearing a handle that may now belong to another session
			this.backfillStep = null;
			try {
				const src = readSource(ctx); // read again each tick: entries may arrive without a catchUp event
				if (!src || src.sessionId !== sid) {
					this.release();
					this.state = "idle";
					return;
				}
				projected += led.catchUp({ ...src, entries: src.entries.slice(0, Math.min(src.entries.length, led.projectedCount + BACKFILL_ENTRIES)) });
				if (!owns()) return;
				if (!led.current(src)) { this.backfillStep = setImmediate(step); return; }
				this.pumping = false;
				this.ledgerDone = true;
				this.state = "ready";
				this.failures = 0;
				this.error = "";
				if (projected) this.log({ type: "memory_ingest", why: `${why}_backfill`, sessionId: sid, projected, ms: Date.now() - t0 });
			} catch (err) {
				if (owns()) this.ledgerError(err, `${why}_backfill`);
			}
		};
		this.backfillStep = setImmediate(step);
	}

	/** A failed attempt is not completion. Reopening reconciles the committed prefix and resumes in bounded batches. */
	private ledgerError(err: unknown, why: string) {
		this.failures++;
		this.state = "error";
		this.error = errText(err);
		this.release();
		this.log({ type: "error", where: `memory/${why}`, sessionId: this.sid, error: this.error, failures: this.failures });
	}

	/** turn_end, session_compact, session_tree, agent_end: live ingestion of newly persisted entries. */
	catchUp(ctx: Any, why: string) {
		if (why === "session_tree" || why === "session_compact") this.cancelRetrieval();
		if (this.backfill) return; // the session-start backfill has not run yet; it reads everything then
		this.ensure(ctx, why);
	}

	/**
	 * before_agent_start of a prompt-started run: nothing is searched until the branch has output the model no longer sees in full
	 * (a fold, or a compaction). The main model waits only for a local search of the prompt's own words, which runs while the planner
	 * call is in flight. The planner, the search with its keywords and the answer call then run in the background: the run's requests
	 * carry a pending note once a search has candidates, and the findings when they are ready; zip_recall with no arguments waits for
	 * them. Never throws.
	 */
	async beforeAgentStart(ctx: Any, e: Any) {
		this.cancelCurrent();
		if (e?.messageType !== "user" || typeof e.prompt !== "string" || !e.prompt.trim()) return void this.dropCarry("next prompt had no retrieval");
		const job: RetrievalJob = { requestId: randomUUID(), controller: new AbortController(), answer: null, ctx };
		this.job = job;
		try {
			await this.prepare(ctx, e, job);
		} catch (err) {
			try { this.log({ type: "error", where: "memory/prepare", requestId: job.requestId, error: errText(err) }); } catch {}
		}
	}

	/** The background work of the current run and of a previous run still finishing, settled (tests and diagnostics). */
	async settled(): Promise<void> {
		await Promise.all([this.job?.answer, this.carryJob?.answer]);
	}

	/** The job may still publish: the current run's, or the previous run's that is finishing for the next prompt. */
	private live(job: RetrievalJob) { return !job.controller.signal.aborted && (this.job === job || this.carryJob === job); }

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
		let background = false;
		try {
			// nothing can be indexed without a persisted session (an in-memory one, or a new one before Pi's first flush): no call
			const src0 = readSource(ctx);
			if (!src0 || !src0.entries.length) return void (rec.skip = "no persisted session");
			const scope = scopeOf(ctx);
			const hidden = hiddenOutputs(scope);
			if (!hidden) return void (rec.skip = "nothing hidden yet");
			rec.hidden = hidden;
			this.runBackfill?.(); // a prompt sent before the deferred backfill ran: backfill now, then search
			const led = this.ensure(ctx, "before_agent_start");
			const src = readSource(ctx);
			if (!led || !src || !led.current(src)) return void (rec.skip = led ? "ledger behind its session" : `ledger ${this.state}`);
			this.stats.prompts++;
			rec.promptChars = e.prompt.length;
			const query = queryOf(e.prompt);
			const planned = conv.plan(requestText(e.prompt), visibleTail(ctx, e.prompt));
			planned.catch(() => {}); // owned by the background step
			// The prompt's own words are searched while the planner call is in flight: the main model waits for this only.
			let t = Date.now();
			const early = query.tokens.length || query.handles.length ? retrieve(led.db, query, scope, DEFAULT_LIMITS) : null;
			latency.early = Date.now() - t;
			if (early) rec.early = { hits: early.hits, candidates: early.evidence.length, handles: early.evidence.map((x) => x.handle) };
			const revision = `${src.entries.length}:${src.entries[src.entries.length - 1]?.id ?? ""}`;
			this.note = { sessionId: src.sessionId, requestId, prompt: e.prompt, pending: early?.evidence.length ? pendingNote(early.evidence.length) : "", text: null, found: false, cited: [], delivered: false };
			background = true;
			latency.foreground = Date.now() - t0;
			job.answer = this.background(ctx, e, job, signal, conv, planned, query, early, led, scope, src.sessionId, revision, rec, latency, t0)
				.catch((err) => { try { this.log({ type: "error", where: "memory/background", requestId, error: errText(err) }); } catch {} });
		} catch (err) {
			rec.error = errText(err);
		} finally {
			if (!background) {
				this.logRetrieval(rec, conv, latency, null, t0);
				this.dropCarry("next prompt had no retrieval");
			}
		}
	}

	private async background(ctx: Any, e: Any, job: RetrievalJob, signal: AbortSignal, conv: RetrievalConversation, planned: Promise<Plan | null>,
		query: Query, early: Retrieved | null, led: Ledger, scope: Scope, sessionId: string, revision: string, rec: Record<string, unknown>, latency: Record<string, number>, t0: number) {
		const drops: DropStats = { unknownHandle: 0, empty: 0, cap: 0, notFolded: 0, notNeeded: 0 };
		let own: { text: string; cited: string[] } | null = null, related: (cited: string[]) => boolean = () => false;
		const stale = () => signal.aborted || !this.live(job) || this.ledger !== led || String(ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId;
		try {
			let t = Date.now();
			const plan = await planned;
			latency.plan = Date.now() - t;
			if (stale()) return void (rec.skip = "cancelled");
			const handlesOf = (r: Retrieved | null) => new Set(r?.evidence.map((x) => x.handle) ?? []);
			const earlyHandles = handlesOf(early);
			related = (cited) => cited.some((h) => earlyHandles.has(h));
			// a continuation is the same topic as the request before it: what that request found is wanted here
			if (plan?.continue) { related = () => true; return void (rec.skip = "continuation"); }
			if (plan) query = { ...query, sets: plan.queries };
			else rec.plan = "failed: searching the request's own words";
			Object.assign(rec, { queries: query.sets, terms: query.sets ? undefined : query.tokens, handles: query.handles.length ? query.handles : undefined });
			if (!query.tokens.length && !query.sets?.length && !query.handles.length) return void (rec.skip = "no search terms");
			t = Date.now();
			const r = plan ? retrieve(led.db, query, scope, DEFAULT_LIMITS) : early!;
			latency.search = Date.now() - t;
			const found = handlesOf(r);
			related = (cited) => cited.some((h) => earlyHandles.has(h) || found.has(h));
			Object.assign(rec, { hits: r.hits, inBranch: r.inBranch, candidates: r.evidence.length, expand: DEFAULT_LIMITS.expand });
			const evidenceLog = r.evidence.map((x) => ({
				ref: x.ref, handle: x.handle, kind: x.kind, hidden: x.hidden, tool: x.tool ?? undefined,
				error: x.isError || undefined, folded: x.folded || undefined, exact: x.exact || undefined,
				matched: x.matched, chars: x.excerpt.length, thinkingItems: x.context.length, cited: false,
			}));
			rec.evidence = evidenceLog;
			if (!r.evidence.length) return void (rec.skip = "no candidates");
			// few full-text rows: in this session's logs most such searches found nothing the answer call kept; a handle the prompt names
			// always goes on
			// logged on every record that reaches the gate, passed or not, so a log alone shows what the threshold kept and skipped
			const minHits = retrievalMinHits(), weak = r.hits < minHits && !r.named;
			rec.gate = { minHits, hits: r.hits, named: r.named, maxMatched: Math.max(...r.evidence.map((x) => x.matched)), skipped: weak };
			if (weak) return void (rec.skip = "weak search");
			const note = this.job === job ? this.note : null;
			if (note && !note.pending && !this.pendingShown) note.pending = pendingNote(r.evidence.length); // shown text never changes
			this.stats.calls++;
			t = Date.now();
			const packet = await conv.answer(e.prompt, recentContext(ctx), r.evidence, job.requestId, revision, drops);
			latency.answer = Date.now() - t;
			// A provider may ignore abort. Never publish its late response into another run or branch.
			if (stale()) return void (rec.skip = "cancelled");
			if (!packet) return void (rec.skip = "answer failed");
			const now = scopeOf(ctx);
			if ([...scope.hidden.keys()].some((id) => !now.hidden.has(id))) return void (rec.skip = "source visibility changed");
			const ages = new Map(r.evidence.filter((x) => x.at).map((x) => [x.handle, `${ageOf(x.at, Date.now())} ago`]));
			const text = renderPacket(packet, ages);
			if (!text) return void (rec.skip = "nothing relevant");
			const cited = new Set([...packet.findings.flatMap((x) => x.sourceHandles), ...packet.foldedCandidates.map((x) => x.handle)]);
			own = { text, cited: [...cited] };
			if (memoryTraceEnabled()) rec.note = text; // the exact text the main model will read, for judging quality later
			for (const x of evidenceLog) x.cited = cited.has(String(x.handle));
			Object.assign(rec, { findings: packet.findings.length, folded: packet.foldedCandidates.length, chars: text.length, revision });
		} catch (err) {
			rec.error = errText(err);
		} finally {
			await this.publish(job, sessionId, own, related, rec, stale);
			this.logRetrieval(rec, conv, latency, drops, t0);
		}
	}

	/**
	 * The job's outcome goes into its note. A previous run's findings that never reached the model join it when this request is
	 * related (a continuation, or its searches found a handle those findings cite); otherwise they are dropped. A job whose run has
	 * ended keeps its findings for the next prompt instead.
	 */
	private async publish(job: RetrievalJob, sessionId: string, own: { text: string; cited: string[] } | null, related: (cited: string[]) => boolean,
		rec: Record<string, unknown>, stale: () => boolean) {
		if (stale()) return;
		if (this.carryJob === job) {
			this.carryJob = null;
			if (own) { this.carry = { sessionId, requestId: job.requestId, ...own }; rec.carriedOver = true; }
			return;
		}
		const prev = await this.takeCarry(job);
		if (stale()) return;
		// The run may have ended while takeCarry waited. Preserve this answer for its successor, not the removed note.
		if (this.carryJob === job) {
			this.carryJob = null;
			if (own) { this.carry = { sessionId, requestId: job.requestId, ...own }; rec.carriedOver = true; }
			return;
		}
		if (this.job !== job || this.note?.requestId !== job.requestId) return;
		let text = own?.text ?? null, cited = own?.cited ?? [];
		if (prev && related(prev.cited)) {
			const late = `${LATE_HEADER}\n${prev.text}`;
			text = text ? `${text}\n\n${late}` : late;
			cited = [...new Set([...cited, ...prev.cited])];
			rec.carried = prev.requestId;
		} else if (prev) this.log({ type: "memory_dropped", requestId: prev.requestId, found: true, reason: "next request unrelated" });
		Object.assign(this.note, text ? { text, found: true, cited } : { text: NOTHING_NOTE, found: false });
	}

	/** The previous run's findings, waiting for its background job first. Taken once: the next prompt has its own run. */
	private async takeCarry(job: RetrievalJob): Promise<Carry | null> {
		const running = this.carryJob;
		if (running && running !== job) await running.answer;
		if (this.job !== job) return null;
		const c = this.carry;
		this.carry = null;
		if (this.carryJob && this.carryJob !== job) { this.carryJob.controller.abort(); this.carryJob = null; }
		return c && c.sessionId === this.note?.sessionId ? c : null;
	}

	private dropCarry(reason: string) {
		if (this.carry) this.log({ type: "memory_dropped", requestId: this.carry.requestId, found: true, reason });
		this.carry = null;
		this.carryJob?.controller.abort();
		this.carryJob = null;
	}

	private logRetrieval(rec: Record<string, unknown>, conv: RetrievalConversation, latency: Record<string, number>, drops: DropStats | null, t0: number) {
		rec.stage = rec.error ? "error" : rec.skip ? String(rec.skip) : "prepared";
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

	/** The note of the current run, when it still belongs to the open session; read by run.ts on every request of the run. */
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

	/**
	 * zip_recall with no arguments: wait for the run's background answer (or `signal`) and return its findings, which then are not
	 * injected again. Null when this run has no retrieval.
	 */
	async awaitNote(ctx: Any, signal?: AbortSignal): Promise<string | null> {
		const job = this.job;
		if (!job || !this.current(ctx)) return null;
		const t0 = Date.now();
		if (job.answer) {
			await Promise.race([job.answer, new Promise<void>((resolve) => {
				if (signal?.aborted) return resolve();
				signal?.addEventListener("abort", () => resolve(), { once: true });
			})]);
		}
		const n = this.current(ctx);
		const text = n?.text ?? null;
		this.log({ type: "memory_wait", requestId: job.requestId, ms: Date.now() - t0, ready: text !== null, found: !!n?.found });
		if (!n || text === null) return "[pi-zip: the historical retrieval for this request did not finish; continue without it]";
		this.recordDelivery();
		n.delivered = true;
		return text;
	}

	private recordDelivery() {
		if (this.deliveryEntries || !this.job) return;
		const ctx = this.job.ctx;
		this.deliveryEntries = new Set((ctx?.sessionManager?.getBranch?.() ?? []).map((e: Any) => e.id));
		const messages = attempt(() => (ctx?.sessionManager?.buildSessionProjection?.()?.entries ?? []).flatMap((e: Any) => e.messages ?? []), []);
		const text = messages.map((m: Any) => m?.role === "assistant" ? written(m) : visibleText(m)).join("\n");
		this.deliveryBaseline = noteTerms(this.note?.text ?? "", this.note?.cited ?? []).filter((term) => text.includes(term)).join("\n");
	}

	/** run.ts put a note into a request: the pending note, or the findings (each logged once per run, for the first request). */
	injected(chars: number, at: number, kind: "pending" | "final" = "final") {
		if (kind === "pending" ? this.pendingShown : this.noteShown) return;
		if (kind === "pending") this.pendingShown = true;
		else { this.recordDelivery(); this.noteShown = true; this.stats.injected++; }
		this.log({ type: "memory_inject", requestId: this.note?.requestId, kind, chars, at });
	}

	/** One later request of the same run carried the note again (the run's cacheable prefix held). Counted, not logged one by one. */
	reinjected() {
		this.stats.reinjected++;
	}

	/** agent_end: the run's note ends with it (findings it never showed are kept for the next prompt); the final entries are ingested. */
	agentEnd(ctx: Any) {
		try { this.logUsage(ctx); } catch (err) { this.log({ type: "error", where: "memory/usage", error: errText(err) }); }
		this.cancelCurrent();
		this.catchUp(ctx, "agent_end");
	}

	shutdown() {
		this.release();
		this.state = "idle";
	}

	/**
	 * Did the run use the injected note? Read the run's own entries (everything after its last user message): which cited handles the
	 * model recalled with zip_recall or named after delivery, and which distinctive finding terms it repeated before another source showed them.
	 * Findings that never reached the model are kept for the next prompt (or logged as dropped when there were none).
	 */
	private logUsage(ctx: Any) {
		const note = this.note, job = this.job;
		if (!note) return;
		if (!this.noteShown && !note.delivered) {
			if (note.text === null && job && !job.controller.signal.aborted) {
				// still searching or answering: let it finish for the next prompt (an older run's findings not taken yet give way)
				if (this.carryJob !== job) this.dropCarry("a later run ended before it was taken");
				this.carryJob = job;
				this.log({ type: "memory_carried", requestId: note.requestId, ready: false });
				return;
			}
			if (note.found && note.text) {
				this.carry = { sessionId: note.sessionId, requestId: note.requestId, text: note.text, cited: note.cited };
				this.log({ type: "memory_carried", requestId: note.requestId, ready: true });
				return;
			}
			if (note.text === null) this.log({ type: "memory_dropped", requestId: note.requestId, pendingShown: this.pendingShown, found: false, reason: "run ended before the answer call finished" });
			return;
		}
		if (!note.found) return;
		const branch: Any[] = ctx?.sessionManager?.getBranch?.() ?? [];
		// the run starts after its own prompt; a steer is a later user message inside the run, not its start
		let start = branch.findLastIndex((e) => e?.message?.role === "user" && visibleText(e.message).trim() === note.prompt.trim()) + 1;
		if (start === 0) { start = branch.length; while (start > 0 && branch[start - 1]?.message?.role !== "user") start--; }
		const run = branch.slice(start).filter((e) => !this.deliveryEntries?.has(e.id)).map((e) => e?.message).filter(Boolean);
		const recalled = new Set<string>(), mentioned = new Set<string>();
		let recallCalls = 0, assistantMessages = 0;
		for (const m of run) {
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
		const terms = noteTerms(note.text ?? "", note.cited);
		const reused = terms.length ? reusedTerms(terms, `${note.prompt}\n${this.deliveryBaseline}\n${viewBefore(ctx, note.prompt)}`, run) : [];
		const usedBy = [...(recalled.size ? ["recall"] : []), ...(reused.length ? ["terms"] : [])];
		this.log({
			type: "memory_usage", requestId: note.requestId, delivered: note.delivered ? "zip_recall" : "request", cited: note.cited,
			recalled: [...recalled], mentioned: [...mentioned], recallCalls, assistantMessages, terms: terms.length, reused,
			// naming a handle is not using it (the model may name it to say the note is wrong); a recall, or a finding's own term
			// repeated before anything else in the run showed it, is
			used: usedBy.length > 0, usedBy,
		});
	}

	/** The current run's retrieval ends (a new prompt, or the run's end). A job kept for the next prompt is not aborted. */
	private cancelCurrent() {
		if (this.job && this.job !== this.carryJob) this.job.controller.abort();
		this.job = null;
		this.note = null;
		this.noteShown = false;
		this.pendingShown = false;
		this.deliveryEntries = null;
		this.deliveryBaseline = "";
	}

	/** Discard only retrieval work and its note, and findings kept for the next prompt; deterministic indexing continues while /zip is off. */
	cancelRetrieval() {
		this.cancelCurrent();
		this.carry = null;
		this.carryJob?.controller.abort();
		this.carryJob = null;
	}
	private release() {
		this.gen++; // invalidate both the initial timer and every queued pump tick, even when no timer remains
		this.cancelRetrieval();
		if (this.backfillStep !== null) clearImmediate(this.backfillStep);
		this.backfillStep = null;
		this.pumping = false;
		this.ledgerDone = false;
		const pending = this.runBackfill;
		if (pending) pending(); // resolves `ready` without indexing: its generation is no longer current
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

/** The model view's text before the run of `prompt` (its last user message with that text): what the model could read already. */
function viewBefore(ctx: Any, prompt: string): string {
	const messages: Any[] = attempt(() => (ctx?.sessionManager?.buildSessionProjection?.()?.entries ?? []).flatMap((e: Any) => e.messages ?? []), []);
	let at = messages.findLastIndex((m: Any) => m?.role === "user" && visibleText(m).trim() === prompt.trim());
	if (at < 0) at = messages.findLastIndex((m: Any) => m?.role === "user");
	// tool-call arguments are in view too (a path the model called earlier is not news to it)
	return messages.slice(0, Math.max(0, at)).map((m) => (m?.role === "assistant" ? written(m) : visibleText(m))).join("\n");
}

/** The previous user request and the newest assistant reply on the active branch, clipped: enough to resolve "fix it again". */
export function recentContext(ctx: Any): string {
	// Redundancy is judged against the model view, not raw history that compaction may have removed or replaced.
	const messages: Any[] = attempt(() => (ctx?.sessionManager?.buildSessionProjection?.()?.entries ?? []).flatMap((e: Any) => e.messages ?? []), []);
	let user = "", asst = "";
	for (let i = messages.length - 1; i >= 0 && (!user || !asst); i--) {
		const m = messages[i];
		if (!asst && m?.role === "assistant") asst = visibleText(m);
		if (!user && m?.role === "user") user = visibleText(m);
	}
	return [user && `previous user request: ${clip(user, 500)}`, asst && `latest assistant reply: ${clip(asst, 1200)}`].filter(Boolean).join("\n");
}
