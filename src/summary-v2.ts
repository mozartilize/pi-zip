// Format v2 summary: the conversation as epochs, oldest first. Each epoch owns the user requests made in it (verbatim), the model's
// findings for it and the tool evidence it produced. A list of validated user quotes (current intent) and the assistant's current state
// come first. Identities (request numbers, executions, results) are rebuilt from the raw session branch; the summary text carries what
// the branch cannot give back: the prose, the grouping and what was left out. The next summary parses this text and carries every old
// epoch as written; only its prose is ever merged by a model call, its requests and evidence are joined by code.
import { classifySummaryRead } from "./classify.ts";
import { blockTime, cdAliases, handleFor, keyTexts, outcomeHint, RECALL_TOOL, shortArgs, whenLabel } from "./placeholder.ts";
import type { Block } from "./plan.ts";
import { assistantVisibleText, branchRequests, type BranchRequest } from "./recall.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { BUDGET, bashCommands, type EpochBlock, legacyNarrative, mkEpoch, parseSummary, prose, SHORT_MARK } from "./summary.ts";
import { type Any, clip, textOf, tok4 } from "./util.ts";

export const SUMMARY_V2_MARK = "[pi-zip summary · format v2 · request numbering: raw-branch-v2]";
export const SUMMARY_V2_DISCLAIMER = "Historical record: what was said or observed, not automatic verification or standing authorization.";

const QUOTE = "  > ";
const NONE = "(none)";
const SUB = {
	requests: "Requests — user said",
	prose: "Decisions / findings — assistant interpretation",
	commitments: "Commitments — assistant said, not verified completion",
	evidence: "Activity / evidence — tool observations",
} as const;
const SUBS = new Set<string>(Object.values(SUB));
const INTENT_HEAD = "## Current intent — selected user quotes, scope not inferred";
const INTENT_NONE = "(none selected; see the verbatim requests in History)";
const STATE_PREFIX = "## Current state — assistant interpretation";
const STATE_RE = /^## Current state — assistant interpretation(?: \((?:carried forward(?: from ([^;]*))?; possibly stale: (.*)|as of (.*))\))?$/;
const HISTORY_HEAD = "## History";
const ALIASES_PREFIX = "Command directory aliases: ";
const LEGACY_ID = "Earlier history — epoch attribution unavailable";
const EPOCH_HEAD_RE = /^### (?:Epochs? (\d+)(?:–(\d+))?|Earlier history — epoch attribution unavailable) · source interval (\S+) · ([^·]+?) · (.+)$/;
const TIER_RE = /^consolidated, tier (\d+)$/;
const REQ_HEAD_RE = /^- (?:R(\d+)|legacy R(\d+)|legacy request)(?: · handle ([0-9a-z]{10}))? · (verbatim|source incomplete)(?: · continuation of R(\d+))?$/;
const INTENT_ROW_RE = /^- R(\d+) · source ([0-9a-z]{10})$/;
const OMIT_RE = /^Catalogue omissions: (\d+) routine-read-filtered; (\d+) budget-omitted(?:; sources (?:… )?(.*))?$/;
const OMITTED_REQ_RE = /(?:whole request: handle |\[… middle of this request omitted \(handle )([0-9a-z]{10})/;
const MAX_INTENTS = 8;
const MAX_OMIT_SOURCES = 12;

/** One line: a newline in a tool output, a command or a hint is shown as ⏎, so a record stays one record however it is parsed. */
const flat = (s: unknown) => String(s ?? "").replace(/\s*\n\s*/g, " ⏎ ").trim();
const quoteLines = (t: string) => String(t ?? "").split("\n").map((l) => QUOTE + l).join("\n");
const unquote = (lines: string[]) => lines.map((l) => (l.startsWith(QUOTE) ? l.slice(QUOTE.length) : l)).join("\n");
/** Prose lines that would read as structure (a heading, a sub-section title, an omissions line) are indented; idempotent. */
const safeProse = (t: string) =>
	String(t ?? "")
		.split("\n")
		.map((l) => (/^#/.test(l) || SUBS.has(l) || OMIT_RE.test(l) ? `  ${l}` : l))
		.join("\n")
		.trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, token: string) => !!token && new RegExp(`(^|[^\\w./-])${esc(token)}($|[^\\w-])`).test(text);

// ---------------------------------------------------------------------------------------------------------------
// intent quotes
// ---------------------------------------------------------------------------------------------------------------

/** A proposed user quote checked against the raw request text: exact substring after NFC (accents are never stripped). The span is
 *  returned from the source, never the model's string. null: not in the request. */
export function validateUserIntentQuote(rawUserText: string, proposedQuote: string): string | null {
	const raw = String(rawUserText ?? "").normalize("NFC");
	const q = String(proposedQuote ?? "").trim().normalize("NFC");
	if (!q) return null;
	const i = raw.indexOf(q);
	return i < 0 ? null : raw.slice(i, i + q.length);
}

export interface V2Intent {
	requestNumber: number;
	handle: string;
	quote: string;
}
export interface IntentProposal {
	quote: string;
	requestNumber?: number;
	handle?: string;
	role?: string;
}

/** Proposed quotes resolved to user requests: by handle or number when given, else the newest request whose text holds the quote.
 *  A quote from any other role, or found in no request, is rejected (tool output or assistant text never becomes user intent). */
export function resolveIntents(props: readonly IntentProposal[], requests: readonly V2Request[]): { intents: V2Intent[]; accepted: number; rejected: number; roleMismatch: number } {
	const intents: V2Intent[] = [];
	let accepted = 0, rejected = 0, roleMismatch = 0;
	const usable = requests.filter((r) => r.number > 0 && r.handle);
	for (const p of props) {
		if (p.role && p.role !== "user") {
			roleMismatch++;
			rejected++;
			continue;
		}
		const targets = p.handle ? usable.filter((r) => r.handle === p.handle) : p.requestNumber ? usable.filter((r) => r.number === p.requestNumber) : [...usable].reverse();
		let hit: V2Intent | null = null;
		for (const t of targets) {
			const span = validateUserIntentQuote(t.text, p.quote);
			if (span) {
				hit = { requestNumber: t.number, handle: t.handle!, quote: span };
				break;
			}
		}
		if (!hit) {
			rejected++;
			continue;
		}
		accepted++;
		if (!intents.some((x) => x.handle === hit!.handle && x.quote === hit!.quote) && intents.length < MAX_INTENTS) intents.push(hit);
	}
	return { intents, accepted, rejected, roleMismatch };
}

/** Assistant statements of what it will do, from visible prose only (never hidden reasoning): a commitment, not a completion. */
export function collectAssistantCommitments(blocks: Block[], maxItems = 4): Array<{ sourceHandle: string; quote: string }> {
	const out: Array<{ sourceHandle: string; quote: string }> = [];
	const COMMIT_RE = /\b(?:i will|i'll|next i will|next i'll|we will|todo:|sẽ |tiếp theo (?:tôi|tao|mình) sẽ)\b/i;
	for (const b of blocks) {
		if (b.kind !== "assistant" || !b.entryId) continue;
		const vis = assistantVisibleText((b.raw ?? b.msg)?.content);
		for (const line of vis.split("\n")) {
			const t = line.trim();
			if (t && COMMIT_RE.test(t)) {
				out.push({ sourceHandle: handleFor(b.entryId), quote: clip(t, 200) });
				break;
			}
		}
	}
	return out.slice(-maxItems);
}

// ---------------------------------------------------------------------------------------------------------------
// executions
// ---------------------------------------------------------------------------------------------------------------

export interface ExecutionResultRef {
	resultEntryId: string;
	handle: string;
	at?: number;
	turn?: number;
	isError: boolean;
	outcome: string;
	rawText: string;
	errorExcerpt?: string;
	hint?: string;
}

export interface ExecutionRecord {
	executionId: string; // `${assistantEntryId}:${content-block position}`, or `orphan-result:${resultEntryId}`
	assistantEntryId: string | null;
	toolCallPosition: number;
	toolCallId: string | null;
	tool: string;
	args: Any;
	command?: string;
	path?: string;
	requestNumber?: number;
	results: ExecutionResultRef[]; // in source order, one per resultEntryId
	orphan?: boolean;
	associationUnresolved?: boolean;
	/** The call was made in an earlier epoch (its record there says "no result"): this record only carries the late result. */
	priorEpoch?: boolean;
	routineReadEligible?: boolean;
	routineReadReason?: string;
	referenced?: boolean;
}

export interface CollectExecutionsResult {
	records: ExecutionRecord[];
	routineReadFiltered: number;
	associationUnresolved: number;
	kept: ExecutionRecord[];
	filtered: ExecutionRecord[];
}

function toolOutcome(tool: string, rawText: string, isError: boolean): string {
	if (tool === "bash") {
		const m = /Command exited with code (\d+)/.exec(rawText);
		if (m) return `exit ${m[1]}`;
		if (isError) return "error";
		return outcomeHint(rawText, tool, false) || "exit 0";
	}
	if (isError) return "error";
	const oh = outcomeHint(rawText, tool, false);
	if (oh) return oh;
	return rawText.trim() ? (tool === "read" || tool === "edit" || tool === "write" ? "success" : "completed") : "unknown";
}

/** True when `text` points at this execution: its execution id, a result handle, its path (or the path's file name) or its command. */
export function referencesSource(text: string, rec: Pick<ExecutionRecord, "executionId" | "results" | "path" | "command">): boolean {
	if (!text) return false;
	if (!rec.executionId.startsWith("orphan-") && mentions(text, rec.executionId)) return true;
	if (rec.results.some((r) => text.includes(r.handle))) return true;
	const p = rec.path?.trim();
	if (p) {
		if (mentions(text, p)) return true;
		const base = p.split(/[\\/]/).pop() ?? "";
		if (base.length >= 3 && /[.\-_]/.test(base) && mentions(text, base)) return true;
	}
	const cmd = rec.command?.trim();
	return !!cmd && cmd.length >= 6 && text.includes(cmd);
}

/**
 * Tool executions of a block slice in source order. Identity: (assistant entry, content-block position), known as soon as the call is
 * issued. A result belongs to the newest call issued before it with its id; one message issuing an id twice, or no issuer at all, makes
 * it an orphan with its association unresolved (never guessed from a tool name or command). `priorIssuers` (call id -> execution id,
 * "" when one message issued it twice) are the calls before the slice, from the raw branch: a result in the slice whose newest issuer
 * came before it belongs to that earlier execution. Several results of one execution are kept, one per result entry.
 * `requestNumbers` (user entry id -> raw-branch-v2 number) and `startRequest` (the request in effect when the slice begins) give each
 * execution the request it was made under; without them the slice's own user messages are counted from 1.
 */
export function collectExecutions(
	blocks: Block[],
	opts: {
		cwd?: string;
		referenceText?: string;
		referencedHandles?: ReadonlySet<string>;
		referencedExecutions?: ReadonlySet<string>;
		filterRoutineReads?: boolean;
		priorIssuers?: ReadonlyMap<string, string>;
		requestNumbers?: ReadonlyMap<string, number>;
		startRequest?: number;
	} = {},
): CollectExecutionsResult {
	const cwd = opts.cwd ?? ".";
	const records: ExecutionRecord[] = [];
	const byId = new Map<string, ExecutionRecord>();
	const issued = new Map<string, { execId: string; ambiguous: boolean; prior?: boolean }>();
	for (const [cid, execId] of opts.priorIssuers ?? []) issued.set(cid, { execId, ambiguous: !execId, prior: true });
	let req = opts.startRequest ?? 0;
	for (const b of blocks) {
		if (b.kind === "user") {
			req = (b.entryId ? opts.requestNumbers?.get(b.entryId) : undefined) ?? req + 1;
			continue;
		}
		if (b.kind === "assistant") {
			const content: Any[] = Array.isArray(b.msg?.content) ? b.msg.content : [];
			const counts = new Map<string, number>();
			for (const c of content) if (c?.type === "toolCall" && c.id) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
			const aid = b.entryId ?? `asst-${b.idx}`;
			content.forEach((c, pos) => {
				if (c?.type !== "toolCall" || String(c.name) === RECALL_TOOL) return;
				const a = c.arguments ?? {};
				const rec: ExecutionRecord = {
					executionId: `${aid}:${pos}`,
					assistantEntryId: b.entryId,
					toolCallPosition: pos,
					toolCallId: c.id ? String(c.id) : null,
					tool: String(c.name ?? "tool"),
					args: a,
					...(c.name === "bash" && typeof a.command === "string" ? { command: a.command } : {}),
					...(typeof a.path === "string" || typeof a.file_path === "string" ? { path: String(a.path ?? a.file_path) } : {}),
					...(req > 0 ? { requestNumber: req } : {}),
					results: [],
				};
				records.push(rec);
				byId.set(rec.executionId, rec);
				if (c.id) issued.set(String(c.id), { execId: rec.executionId, ambiguous: (counts.get(c.id) ?? 0) > 1 });
			});
			continue;
		}
		if (b.kind !== "toolResult") continue;
		const toolName = String(b.msg?.toolName ?? "tool");
		if (toolName === RECALL_TOOL) continue;
		const cid = b.msg?.toolCallId ? String(b.msg.toolCallId) : "";
		const m = cid ? issued.get(cid) : undefined;
		const raw = (b.raw ?? b.msg)?.content;
		const rawText = textOf(raw);
		const isError = !!b.msg?.isError || /Command exited with code [1-9]\d*/.test(rawText);
		const rid = b.entryId ?? `res-${b.idx}`;
		const owner = m && !m.ambiguous ? byId.get(m.execId) : undefined;
		const tool = owner?.tool ?? toolName;
		const key = keyTexts(rawText, 4)[0];
		const ref: ExecutionResultRef = {
			resultEntryId: rid,
			handle: handleFor(rid),
			at: blockTime(b),
			turn: b.userTurn,
			isError,
			outcome: toolOutcome(tool, rawText, isError),
			rawText,
			...(isError ? { errorExcerpt: clip(flat(rawText), 200) } : {}),
			...(key ? { hint: clip(flat(key), 90) } : {}),
		};
		if (m?.prior && !m.ambiguous && !owner) {
			// the call is in an earlier epoch: this record carries the result back to it
			let rec = byId.get(m.execId);
			if (!rec) {
				const at = m.execId.lastIndexOf(":");
				rec = { executionId: m.execId, assistantEntryId: m.execId.slice(0, at), toolCallPosition: Number(m.execId.slice(at + 1)), toolCallId: cid, tool: toolName, args: {}, ...(req > 0 ? { requestNumber: req } : {}), results: [], priorEpoch: true };
				records.push(rec);
				byId.set(rec.executionId, rec);
			}
			if (!rec.results.some((r) => r.resultEntryId === rid)) rec.results.push(ref);
			continue;
		}
		if (!owner) {
			const orphan: ExecutionRecord = { executionId: `orphan-result:${rid}`, assistantEntryId: null, toolCallPosition: -1, toolCallId: cid || null, tool: toolName, args: {}, ...(req > 0 ? { requestNumber: req } : {}), results: [ref], orphan: true, associationUnresolved: true };
			records.push(orphan);
			byId.set(orphan.executionId, orphan);
			continue;
		}
		if (!owner.results.some((r) => r.resultEntryId === rid)) owner.results.push(ref);
	}
	let routineReadFiltered = 0, associationUnresolved = 0;
	const kept: ExecutionRecord[] = [], filtered: ExecutionRecord[] = [];
	for (const rec of records) {
		if (rec.associationUnresolved) associationUnresolved++;
		rec.referenced =
			!!opts.referencedExecutions?.has(rec.executionId) || rec.results.some((r) => opts.referencedHandles?.has(r.handle)) || referencesSource(opts.referenceText ?? "", rec);
		if (rec.orphan || rec.priorEpoch || rec.results.length !== 1) {
			rec.routineReadEligible = false;
			rec.routineReadReason = rec.orphan ? "association-unresolved" : rec.priorEpoch ? "earlier-epoch-call" : rec.results.length ? "multiple-results" : "no-result";
		} else {
			const r0 = rec.results[0];
			const d = classifySummaryRead(rec.tool, rec.args, r0.rawText, cwd, r0.isError);
			rec.routineReadEligible = d.eligible && !rec.referenced;
			rec.routineReadReason = rec.referenced ? "referenced" : d.reason;
		}
		if (opts.filterRoutineReads && rec.routineReadEligible) {
			routineReadFiltered++;
			filtered.push(rec);
		} else kept.push(rec);
	}
	return { records, routineReadFiltered, associationUnresolved, kept, filtered };
}

const callHeadOf = (rec: ExecutionRecord, aliases?: Map<string, string>) => {
	const arg = rec.tool === "bash" && rec.command !== undefined ? `\`${shortArgs({ command: rec.command }, BUDGET.cmdChars, aliases)}\`` : rec.path !== undefined ? rec.path : shortArgs(rec.args, 60, aliases);
	return flat(`${rec.tool}${arg ? " " + arg : ""}`);
};
const resultSub = (r: ExecutionResultRef, label = "") => (r.isError && r.errorExcerpt ? `  Error${label}: ${r.errorExcerpt}` : r.hint ? `  Evidence${label}: ${r.hint}` : "");

/** One execution as one record: a first line (identity, handle(s), call, when, outcome) and indented error or evidence lines. */
export function formatExecutionRecord(rec: ExecutionRecord, aliases?: Map<string, string>): string {
	const head = callHeadOf(rec, aliases);
	// the request it was made under (raw-branch-v2 number); with it, the slice-local turn count is not shown
	const R = rec.requestNumber ? `R${rec.requestNumber} · ` : "";
	const when = (r?: ExecutionResultRef) => {
		const w = whenLabel(r?.at, R ? undefined : r?.turn);
		return w ? ` · ${w}` : "";
	};
	if (rec.orphan) {
		const r = rec.results[0];
		return [`- ${R}handle ${r?.handle ?? "unknown"} · ${head}${when(r)} · ${r?.outcome ?? "unknown"} · association unresolved`, r ? resultSub(r) : ""].filter(Boolean).join("\n");
	}
	if (!rec.results.length) return `- ${R}execution ${rec.executionId} · ${head} · no result`;
	if (rec.results.length === 1) {
		const r = rec.results[0];
		return [`- ${R}execution ${rec.executionId} · handle ${r.handle} · ${head}${when(r)} · ${r.outcome}`, resultSub(r)].filter(Boolean).join("\n");
	}
	return [
		`- ${R}execution ${rec.executionId} · handles ${rec.results.map((r) => r.handle).join(", ")} · ${head} · ${rec.results.map((r) => `${r.handle}:${r.outcome}`).join(", ")}`,
		...rec.results.map((r) => resultSub(r, ` (${r.handle})`)).filter(Boolean),
	].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// the v2 document: parse and render
// ---------------------------------------------------------------------------------------------------------------

export interface V2Request {
	number: number; // raw-branch-v2 ordinal; 0: an older summary's request no raw entry could be matched to
	legacyNumber?: number; // that older summary's own number, shown as "legacy R<n>", never read as a v2 number
	handle?: string;
	entryId?: string;
	text: string;
	sourceIncomplete?: boolean;
	continuationOf?: number;
}

export interface V2Epoch {
	block: EpochBlock; // id, request span, time, tier and the model-written prose
	interval: string; // "<first entry id>..<last entry id>" of the conversation it covers; "unknown" when not known
	legacy?: boolean; // the requests, narrative and lists of an older-format or foreign summary, kept as one epoch
	requests: V2Request[];
	commitments: string[]; // rendered rows
	evidence: string[]; // rendered records, each one or more lines
	omitted: { routine: number; budget: number; sources: string[] };
}

export interface V2State {
	intents: V2Intent[];
	activeState: string;
	activeAt?: string;
	activeStale?: string;
	aliases: Map<string, string>; // dir -> alias
	epochs: V2Epoch[];
}

const requestRow = (r: V2Request) =>
	`- ${r.number > 0 ? `R${r.number}` : r.legacyNumber ? `legacy R${r.legacyNumber}` : "legacy request"}${r.handle ? ` · handle ${r.handle}` : ""} · ${r.sourceIncomplete ? "source incomplete" : "verbatim"}${r.continuationOf ? ` · continuation of R${r.continuationOf}` : ""}\n${quoteLines(r.text)}`;

const epochHeading = (e: V2Epoch) => {
	const b = e.block;
	const extra = [(b.level ?? 1) > 1 ? `consolidated, tier ${b.level}` : "", b.note ?? ""].filter(Boolean);
	return `### ${e.legacy ? LEGACY_ID : b.id} · source interval ${e.interval} · ${b.turns} · ${b.timestamp}${extra.map((x) => ` · ${x}`).join("")}`;
};

const omissionRow = (o: V2Epoch["omitted"]) =>
	o.routine || o.budget
		? `Catalogue omissions: ${o.routine} routine-read-filtered; ${o.budget} budget-omitted${o.sources.length ? `; sources ${o.sources.length > MAX_OMIT_SOURCES ? "… " : ""}${o.sources.slice(-MAX_OMIT_SOURCES).join(", ")}` : ""}`
		: "";

export function renderEpoch(e: V2Epoch): string {
	const out = [epochHeading(e), SUB.requests, ...(e.requests.length ? e.requests.map(requestRow) : [NONE]), "", SUB.prose, safeProse(e.block.durableProse) || NONE];
	if (e.commitments.length) out.push("", SUB.commitments, ...e.commitments);
	out.push("", SUB.evidence, ...(e.evidence.length ? e.evidence : [NONE]));
	const om = omissionRow(e.omitted);
	if (om) out.push(om);
	return out.join("\n");
}

const stateHead = (s: V2State) =>
	s.activeStale ? `${STATE_PREFIX} (carried forward${s.activeAt ? ` from ${s.activeAt}` : ""}; possibly stale: ${flat(s.activeStale)})` : `${STATE_PREFIX}${s.activeAt ? ` (as of ${s.activeAt})` : ""}`;

const recallLine = (file?: FileRecall) =>
	file
		? `Recall: ${file.dir}/<handle>.txt holds each original output or request; ${file.dir}/requests.txt lists every user request (${fileRecallHow(file)}).`
		: `Recall: call ${RECALL_TOOL} with handle/handles, requests="M-N", or grep with scope="outputs"|"requests"|"assistant"|"all".`;

/** The whole v2 text. The alias legend names only aliases its records use. */
export function renderV2(s: V2State, file?: FileRecall): string {
	const epochs = s.epochs.map(renderEpoch);
	const used = new Set([...epochs.join("\n").matchAll(/\[([a-z]{1,3})\] /g)].map((m) => m[1]));
	const legend = [...s.aliases].filter(([, a]) => used.has(a)).sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1])).map(([d, a]) => `${a}=${d}`);
	const header = [SUMMARY_V2_MARK, SUMMARY_V2_DISCLAIMER, recallLine(file), ...(legend.length ? [ALIASES_PREFIX + legend.join(", ")] : [])].join("\n");
	const intent = [INTENT_HEAD, ...(s.intents.length ? s.intents.map((i) => `- R${i.requestNumber} · source ${i.handle}\n${quoteLines(i.quote)}`) : [INTENT_NONE])].join("\n");
	const state = [stateHead(s), safeProse(s.activeState) || NONE].join("\n");
	return [header, intent, state, HISTORY_HEAD, ...epochs].join("\n\n");
}

/** Parse a v2 text back (null for any other text). Every old epoch comes back with its requests, prose, commitments, evidence records
 *  and omission counts, so the next summary can carry it as written. */
export function parseSummaryV2(text: string | null): V2State | null {
	if (!text || !text.trimStart().startsWith(SUMMARY_V2_MARK)) return null;
	const st: V2State = { intents: [], activeState: "", aliases: new Map(), epochs: [] };
	let sec: "" | "intent" | "state" | "history" = "";
	let sub: "" | "requests" | "prose" | "commitments" | "evidence" = "";
	type Head = { first: number; last: number; legacy: boolean; interval: string; turns: string; timestamp: string; level: number; note?: string };
	let head: Head | null = null;
	let ep: Omit<V2Epoch, "block"> | null = null;
	let proseLines: string[] = [];
	let req: V2Request | null = null, reqLines: string[] = [];
	let intent: V2Intent | null = null, intentLines: string[] = [];
	let group: string[] = []; // the record (or commitment) being read
	const state: string[] = [];
	const flushGroup = () => {
		if (ep && group.length) (sub === "commitments" ? ep.commitments : ep.evidence).push(group.join("\n"));
		group = [];
	};
	const flushReq = () => {
		if (req && ep) ep.requests.push({ ...req, text: unquote(reqLines) });
		req = null;
		reqLines = [];
	};
	const flushIntent = () => {
		if (intent) st.intents.push({ ...intent, quote: unquote(intentLines) });
		intent = null;
		intentLines = [];
	};
	const flushEpoch = () => {
		flushReq();
		flushGroup();
		if (ep && head) {
			const p = proseLines.join("\n").trim();
			const block = mkEpoch(head.first, head.last, head.turns, head.timestamp, head.level, p && p !== NONE ? p : NONE, head.note);
			st.epochs.push({ ...ep, block, interval: head.interval, ...(head.legacy ? { legacy: true } : {}) });
		}
		ep = null;
		head = null;
		proseLines = [];
	};
	for (const l of text.split("\n")) {
		if (sec !== "history" && l.startsWith(ALIASES_PREFIX)) {
			for (const pair of l.slice(ALIASES_PREFIX.length).split(/, (?=[a-z]{1,3}=)/)) {
				const m = /^([a-z]{1,3})=(.+)$/.exec(pair);
				if (m) st.aliases.set(m[2], m[1]);
			}
			continue;
		}
		if (l === INTENT_HEAD) {
			sec = "intent";
			continue;
		}
		const sm = STATE_RE.exec(l);
		if (sm) {
			flushIntent();
			sec = "state";
			if (sm[2] !== undefined) {
				st.activeStale = sm[2];
				if (sm[1]) st.activeAt = sm[1];
			} else if (sm[3]) st.activeAt = sm[3];
			continue;
		}
		if (l === HISTORY_HEAD) {
			flushIntent();
			sec = "history";
			continue;
		}
		if (sec === "intent") {
			const m = INTENT_ROW_RE.exec(l);
			if (m) {
				flushIntent();
				intent = { requestNumber: Number(m[1]), handle: m[2], quote: "" };
			} else if (intent && l.startsWith(QUOTE)) intentLines.push(l);
			continue;
		}
		if (sec === "state") {
			state.push(l);
			continue;
		}
		if (sec !== "history") continue;
		const eh = EPOCH_HEAD_RE.exec(l);
		if (eh) {
			flushEpoch();
			const parts = eh[5].split(" · ");
			let level = 1;
			const notes: string[] = [];
			for (const p of parts.slice(1)) {
				const t = TIER_RE.exec(p);
				if (t) level = Number(t[1]);
				else notes.push(p);
			}
			const legacy = eh[1] === undefined;
			head = { first: legacy ? 0 : Number(eh[1]), last: legacy ? 0 : Number(eh[2] ?? eh[1]), legacy, interval: eh[3], turns: eh[4].trim(), timestamp: parts[0].trim(), level, ...(notes.length ? { note: notes.join(" - ") } : {}) };
			ep = { interval: eh[3], requests: [], commitments: [], evidence: [], omitted: { routine: 0, budget: 0, sources: [] } };
			sub = "";
			continue;
		}
		if (!ep) continue;
		if (SUBS.has(l)) {
			flushReq();
			flushGroup();
			sub = l === SUB.requests ? "requests" : l === SUB.prose ? "prose" : l === SUB.commitments ? "commitments" : "evidence";
			continue;
		}
		if (sub === "requests") {
			const m = REQ_HEAD_RE.exec(l);
			if (m) {
				flushReq();
				req = {
					number: m[1] ? Number(m[1]) : 0,
					...(m[2] ? { legacyNumber: Number(m[2]) } : {}),
					...(m[3] ? { handle: m[3] } : {}),
					text: "",
					...(m[4] === "source incomplete" ? { sourceIncomplete: true } : {}),
					...(m[5] ? { continuationOf: Number(m[5]) } : {}),
				};
			} else if (req && l.startsWith(QUOTE)) reqLines.push(l);
			continue;
		}
		if (sub === "prose") {
			proseLines.push(l);
			continue;
		}
		const om = OMIT_RE.exec(l);
		if (om) {
			flushGroup();
			ep.omitted = { routine: Number(om[1]), budget: Number(om[2]), sources: om[3] ? om[3].split(", ").filter(Boolean) : [] };
			continue;
		}
		if (l.startsWith("- ")) {
			flushGroup();
			group.push(l);
		} else if (l.startsWith("  ") && group.length) group.push(l);
		else if (l.trim() && l.trim() !== NONE) {
			flushGroup();
			group.push(l);
		}
	}
	flushIntent();
	flushEpoch();
	const a = state.join("\n").trim();
	st.activeState = a === NONE ? "" : a;
	return st;
}

// ---------------------------------------------------------------------------------------------------------------
// building a summary
// ---------------------------------------------------------------------------------------------------------------

export interface PrepareV2Options {
	prefix: Block[]; // the newest slice (no summary block)
	previous?: string | null; // the previous summary's text, any format
	branch?: Any[]; // the raw ancestor branch (request numbers, verbatim text, earlier calls)
	cwd?: string;
	activeState?: string;
	activeAt?: string;
	activeStale?: string;
	durableProse?: string;
	/** Quotes the narrative proposes for current intent. Absent: the previous intents are kept (re-checked against the requests). */
	proposedIntents?: IntentProposal[];
	referencedHandles?: ReadonlySet<string>;
	referencedExecutions?: ReadonlySet<string>;
	epochId?: number;
	sourceInterval?: string;
	timestamp?: string;
}

export interface PreparedV2 {
	state: V2State;
	referenceText: string; // what the retained narrative, state, commitments and intents say (evidence they point at is kept first)
	stats: { quoteAccepted: number; quoteRejected: number; roleMismatch: number; routineReadFiltered: number; associationUnresolved: number; executionCount: number; resultCount: number; lateResults: number };
}

const fromRaw = (r: BranchRequest): V2Request => ({ number: r.number, handle: r.handle, entryId: r.entryId, text: r.text });

/** An older-format or foreign previous summary as one epoch: its requests (verbatim from the branch when the branch has them), its
 *  narrative and its lists, without claiming which of its parts came when. */
function legacyEpoch(previous: string, branch: Any[], raw: BranchRequest[], sliceFirst: string | undefined): { epoch: V2Epoch; activeState: string; activeAt?: string } {
	const pp = parseSummary(previous);
	const at = branch.findIndex((e) => e?.id === sliceFirst);
	const before = new Set(at >= 0 ? branch.slice(0, at).map((e) => e?.id) : []);
	let requests: V2Request[];
	if (at >= 0 && raw.length) requests = raw.filter((r) => before.has(r.entryId)).map(fromRaw);
	else {
		const byHandle = new Map(raw.map((r) => [r.handle, r]));
		const nums = pp.users.nums ?? pp.users.items.map((_, i) => pp.users.omitted + i + 1);
		requests = pp.users.items.map((t, i) => {
			const h = OMITTED_REQ_RE.exec(t)?.[1];
			const hit = h ? byHandle.get(h) : undefined;
			if (hit) return fromRaw(hit);
			const short = t.startsWith(SHORT_MARK) || OMITTED_REQ_RE.test(t);
			return { number: 0, legacyNumber: nums[i], ...(h ? { handle: h } : {}), text: t.startsWith(SHORT_MARK) ? t.slice(SHORT_MARK.length) : t, ...(short ? { sourceIncomplete: true } : {}) };
		});
	}
	const struct = pp.epochs ?? legacyNarrative(previous, 0, requests.length);
	const proseText = struct.epochs.map((e) => `${e.id} - ${e.turns} - ${e.timestamp}:\n${e.durableProse}`).join("\n\n");
	const lists = [...pp.cmds.items, ...pp.others.items, ...pp.errors.items, ...pp.table.items].map((i) => `- legacy · ${flat(i.replace(/^- /, ""))}`);
	const nums = requests.map((r) => r.number).filter((n) => n > 0);
	const turns = nums.length ? (nums.length > 1 ? `requests ${nums[0]}–${nums.at(-1)}` : `request ${nums[0]}`) : requests.length ? `${requests.length} earlier requests` : "no user request";
	const block = mkEpoch(0, 0, turns, struct.activeAt ?? pp.narrativeAt ?? "time unknown", 1, proseText || NONE);
	return {
		epoch: { block, interval: "unknown", legacy: true, requests, commitments: [], evidence: [...new Set(lists)], omitted: { routine: 0, budget: 0, sources: [] } },
		activeState: struct.activeState,
		...(struct.activeAt ? { activeAt: struct.activeAt } : {}),
	};
}

/**
 * The summary's content before any budget: the carried epochs (parsed from a v2 previous summary, or an older/foreign one as a single
 * legacy epoch), their requests restored from the branch when they were incomplete, a result that arrived for an earlier epoch's call
 * attached to that call's record, and the new epoch for this slice: its requests verbatim, its prose, its commitments and its evidence.
 */
export function prepareEpochV2(o: PrepareV2Options): PreparedV2 {
	const branch = o.branch ?? [];
	const raw = branch.length ? branchRequests(branch) : [];
	const rawById = new Map(raw.map((r) => [r.entryId, r]));
	const rawByHandle = new Map(raw.map((r) => [r.handle, r]));
	const sliceFirst = o.prefix.find((b) => b.entryId)?.entryId;
	const prevV2 = parseSummaryV2(o.previous ?? null);
	let carried: V2Epoch[] = [];
	let prevIntents: V2Intent[] = [];
	let prevActive = "", prevActiveAt: string | undefined;
	const aliases0 = new Map<string, string>();
	if (prevV2) {
		carried = prevV2.epochs.map((e) => ({ ...e, requests: e.requests.map((r) => {
			const hit = r.handle ? rawByHandle.get(r.handle) : undefined; // an incomplete or legacy request the branch still has: verbatim again
			return hit && (r.sourceIncomplete || r.number === 0) ? { ...fromRaw(hit), ...(r.continuationOf ? { continuationOf: r.continuationOf } : {}) } : r;
		}), evidence: [...e.evidence], commitments: [...e.commitments], omitted: { ...e.omitted, sources: [...e.omitted.sources] } }));
		prevIntents = prevV2.intents;
		prevActive = prevV2.activeState;
		prevActiveAt = prevV2.activeAt;
		for (const [d, a] of prevV2.aliases) aliases0.set(d, a);
	} else if (o.previous) {
		const l = legacyEpoch(o.previous, branch, raw, sliceFirst);
		carried = [l.epoch];
		prevActive = l.activeState;
		prevActiveAt = l.activeAt;
		for (const [d, a] of parseSummary(o.previous).cmdAliases) aliases0.set(d, a);
	}
	// this slice's requests
	const seen = new Set(carried.flatMap((e) => e.requests.map((r) => r.entryId).filter(Boolean) as string[]));
	let maxNo = carried.reduce((m, e) => e.requests.reduce((n, r) => Math.max(n, r.number), m), 0);
	const posOf = new Map(branch.map((e, i) => [e?.id, i]));
	const startAt = sliceFirst !== undefined ? posOf.get(sliceFirst) : undefined;
	// the request in effect when the slice begins (it may begin inside one): the newest raw request before it
	const startRequest = startAt !== undefined ? raw.reduce((n, r) => ((posOf.get(r.entryId) ?? Infinity) < startAt ? Math.max(n, r.number) : n), 0) : maxNo;
	const requests: V2Request[] = [];
	for (const b of o.prefix) {
		if (b.kind !== "user") continue;
		const r = b.entryId ? rawById.get(b.entryId) : undefined;
		const id = r?.entryId ?? b.entryId ?? `user-${maxNo + 1}`;
		if (seen.has(id)) continue;
		seen.add(id);
		if (r) {
			requests.push(fromRaw(r));
			maxNo = Math.max(maxNo, r.number);
			continue;
		}
		const content = (b.raw ?? b.msg)?.content;
		const t = textOf(content);
		const nonText = Array.isArray(content) && content.some((x: Any) => x?.type && x.type !== "text");
		maxNo++;
		requests.push({ number: maxNo, handle: handleFor(id), entryId: id, text: t || (nonText ? "[non-text user content]" : "[empty user message]") });
	}
	// calls made before the slice, from the raw branch in source order (the newest issuer of an id wins; "" = one message issued it twice):
	// a result in the slice for one of them belongs to that earlier execution, whether or not its record is still in the summary
	const priorIssuers = new Map<string, string>();
	if (startAt !== undefined)
		for (const e of branch.slice(0, startAt)) {
			const msg = e?.type === "message" ? e.message : null;
			if (msg?.role !== "assistant" || !Array.isArray(msg.content) || !e.id) continue;
			const counts = new Map<string, number>();
			for (const c of msg.content) if (c?.type === "toolCall" && c.id) counts.set(String(c.id), (counts.get(String(c.id)) ?? 0) + 1);
			msg.content.forEach((c: Any, pos: number) => {
				if (c?.type === "toolCall" && c.id) priorIssuers.set(String(c.id), (counts.get(String(c.id)) ?? 0) > 1 ? "" : `${e.id}:${pos}`);
			});
		}
	// the carried records still waiting for a result, by execution id
	const waiting = new Map<string, { epoch: V2Epoch; index: number }>();
	for (const e of carried)
		e.evidence.forEach((rec, index) => {
			const m = /^- (?:R\d+ · )?execution (\S+) · .* · no result$/.exec(rec.split("\n")[0]);
			if (m) waiting.set(m[1], { epoch: e, index });
		});
	const commitments = collectAssistantCommitments(o.prefix);
	const commitmentRows = commitments.map((c) => `- source ${c.sourceHandle}\n${quoteLines(c.quote)}`);
	// intents: proposed quotes, else the previous ones; checked against every request the summary keeps
	const allRequests = [...carried.flatMap((e) => e.requests), ...requests];
	const props: IntentProposal[] = o.proposedIntents ?? prevIntents.map((i) => ({ quote: i.quote, handle: i.handle, role: "user" }));
	const ri = resolveIntents(props, allRequests);
	const activeState = o.activeState ?? prevActive;
	const referenceText = [o.durableProse ?? "", activeState, ...commitments.map((c) => c.quote), ...ri.intents.map((i) => i.quote)].join("\n");
	const requestNumbers = new Map(requests.filter((r) => r.entryId).map((r) => [r.entryId!, r.number]));
	const col = collectExecutions(o.prefix, { cwd: o.cwd, referenceText, referencedHandles: o.referencedHandles, referencedExecutions: o.referencedExecutions, filterRoutineReads: true, priorIssuers, requestNumbers, startRequest });
	const aliases = cdAliases(bashCommands(o.prefix), aliases0);
	const nextId = o.epochId ?? carried.reduce((m, e) => Math.max(m, e.block.last ?? 0), 0) + 1;
	const evidence: string[] = [];
	let lateResults = 0;
	for (const rec of col.kept) {
		if (!rec.priorEpoch) {
			evidence.push(formatExecutionRecord(rec, aliases));
			continue;
		}
		// a late result joins its call's record in the earlier epoch and this epoch points at it; when that record was left out of the
		// summary, this epoch's row carries the result itself (still that execution, never an orphan)
		const w = waiting.get(rec.executionId);
		const R = rec.requestNumber ? `R${rec.requestNumber} · ` : "";
		rec.results.forEach((r, k) => {
			lateResults++;
			if (w && k === 0) {
				const old = w.epoch.evidence[w.index].split("\n")[0].replace(/ · no result$/, "");
				w.epoch.evidence[w.index] = [`${old.replace(/^(- (?:R\d+ · )?execution \S+ · )/, `$1handle ${r.handle} · `)} · ${r.outcome} · result in Epoch ${nextId}`, resultSub(r)].filter(Boolean).join("\n");
				evidence.push(`- ${R}result for execution ${rec.executionId} (call in an earlier epoch) · handle ${r.handle} · ${r.outcome}`);
			} else {
				const note = w ? "call in an earlier epoch" : "call in an earlier epoch; its record there is not in this summary";
				evidence.push([`- ${R}result for execution ${rec.executionId} (${note}) · handle ${r.handle} · ${r.outcome}`, resultSub(r)].filter(Boolean).join("\n"));
			}
		});
	}
	const ids = o.prefix.map((b) => b.entryId).filter(Boolean) as string[];
	const nums = requests.map((r) => r.number);
	const turns = nums.length > 1 ? `requests ${nums[0]}–${nums.at(-1)}` : nums.length === 1 ? `request ${nums[0]}` : maxNo > 0 ? `within request ${maxNo}` : "no user request";
	const durable = o.durableProse && o.durableProse.trim() ? o.durableProse : NONE;
	const fresh: V2Epoch = {
		block: mkEpoch(nextId, nextId, turns, o.timestamp ?? "time unknown", 1, durable),
		interval: o.sourceInterval ?? (ids.length ? `${ids[0]}..${ids.at(-1)}` : "unknown"),
		requests,
		commitments: commitmentRows,
		evidence,
		omitted: { routine: col.routineReadFiltered, budget: 0, sources: col.filtered.flatMap((r) => r.results.map((x) => x.handle)) },
	};
	return {
		state: {
			intents: ri.intents,
			activeState,
			...((o.activeAt ?? prevActiveAt) ? { activeAt: o.activeAt ?? prevActiveAt } : {}),
			...(o.activeStale ? { activeStale: o.activeStale } : {}),
			aliases,
			epochs: [...carried, fresh],
		},
		referenceText,
		stats: {
			quoteAccepted: ri.accepted,
			quoteRejected: ri.rejected,
			roleMismatch: ri.roleMismatch,
			routineReadFiltered: col.routineReadFiltered,
			associationUnresolved: col.associationUnresolved,
			executionCount: col.records.filter((r) => !r.priorEpoch).length,
			resultCount: col.records.reduce((n, r) => n + r.results.length, 0),
			lateResults,
		},
	};
}

/** After the prose of neighbouring epochs was merged (consolidateEpochs / boundEpochs: blocks covering epoch number ranges), join each
 *  merged range's requests, commitments, evidence and omission counts by code, in order. An epoch no block covers (its prose did not fit
 *  at all) is kept with its prose marked omitted: requests and evidence never go with the prose. */
export function regroupEpochsV2(epochs: readonly V2Epoch[], blocks: readonly EpochBlock[]): V2Epoch[] {
	const out: V2Epoch[] = [];
	const done = new Set<EpochBlock>();
	for (const e of epochs) {
		const lo0 = e.block.first ?? 0, hi0 = e.block.last ?? lo0;
		const b = blocks.find((x) => (x.first ?? 0) <= lo0 && hi0 <= (x.last ?? x.first ?? 0));
		if (!b) {
			out.push({ ...e, block: { ...e.block, durableProse: PROSE_OMITTED } });
			continue;
		}
		if (done.has(b)) continue;
		done.add(b);
		const lo = b.first ?? 0, hi = b.last ?? lo;
		const members = epochs.filter((x) => (x.block.first ?? 0) >= lo && (x.block.last ?? 0) <= hi);
		if (members.length === 1) {
			out.push({ ...members[0], block: b });
			continue;
		}
		const start = members[0].interval.split("..")[0], end = members.at(-1)!.interval.split("..").pop()!;
		out.push({
			block: b,
			interval: start === "unknown" && end === "unknown" ? "unknown" : `${start}..${end}`,
			requests: members.flatMap((x) => x.requests),
			commitments: members.flatMap((x) => x.commitments),
			evidence: members.flatMap((x) => x.evidence),
			omitted: { routine: members.reduce((n, x) => n + x.omitted.routine, 0), budget: members.reduce((n, x) => n + x.omitted.budget, 0), sources: members.flatMap((x) => x.omitted.sources) },
		});
	}
	return out;
}

export interface EpochSummaryV2 {
	text: string;
	ok: boolean;
	reason?: "request-budget-overflow";
	overflow?: { requiredTokens: number; availableTokens: number };
	diagnostics: {
		formatVersion: "v2";
		numbering: "raw-branch-v2";
		epochs: number;
		requestCount: number;
		verbatimCount: number;
		sourceIncompleteCount: number;
		executionCount: number;
		resultCount: number;
		lateResults: number;
		routineReadFiltered: number;
		budgetOmitted: number;
		associationUnresolved: number;
		quoteAccepted: number;
		quoteRejected: number;
		roleMismatch: number;
		proseOmitted: number;
		intentsOmitted: number;
		tokens: { requests: number; intent: number; state: number; prose: number; commitments: number; evidence: number; overhead: number; total: number };
	};
}

const isErrorRecord = (rec: string) => /\n {2}Error|^- [^\n]* · (?:exit [1-9]\d*|error)(?: ·|$)/m.test(rec);
/** Handles a record names on its first line: "handle X", "handles X, Y", or an older summary's row ("- legacy · X · …", "…, X)"). */
const recordHandles = (rec: string) => {
	const l = rec.split("\n")[0];
	const out = (/handles? ([0-9a-z]{10}(?:, [0-9a-z]{10})*)/.exec(l)?.[1] ?? "").split(", ").filter(Boolean);
	if (l.startsWith("- legacy · ")) for (const m of l.matchAll(/(?:^- legacy · |, )([0-9a-z]{10})(?=[ )·]|$)/g)) out.push(m[1]);
	return out;
};
const PROSE_OMITTED = "(omitted to fit the summary room; this epoch's requests and evidence remain, and its sources are recallable)";

/**
 * Fit the prepared summary. `soft`: the size the plan priced; evidence nobody points at (no error, not named by the retained prose, state,
 * commitments or intents) is dropped, oldest epoch first, whole records only, until the text fits it. `hard`: the size beyond which the
 * compacted view would not fit the model's room; above it the other evidence goes, then commitments, then the intent quotes (the
 * requests keep those words), then the prose of old epochs and last of the newest, then the state. User requests are never dropped: when
 * they and the summary's fixed structure alone exceed `hard` the result is `request-budget-overflow`.
 */
export function renderEpochSummaryV2(prep: PreparedV2, opts: { soft: number; hard: number; file?: FileRecall }): EpochSummaryV2 {
	const s: V2State = { ...prep.state, epochs: prep.state.epochs.map((e) => ({ ...e, evidence: [...e.evidence], commitments: [...e.commitments], omitted: { ...e.omitted, sources: [...e.omitted.sources] } })) };
	// what the kept text says, after any prose merge: every epoch's prose and commitments, the state and the intents. An old epoch's
	// evidence stays pinned while that epoch's own findings name it.
	const ref = [prep.referenceText, s.activeState, ...s.intents.map((i) => i.quote), ...s.epochs.flatMap((e) => [e.block.durableProse, ...e.commitments])].join("\n");
	const hard = Math.max(0, opts.hard), soft = Math.min(Math.max(0, opts.soft), hard);
	let size = tok4(renderV2(s, opts.file));
	let budgetOmitted = 0, proseOmitted = 0;
	const drop = (pick: (rec: string) => boolean, bound: number) => {
		for (const e of s.epochs) {
			for (let i = 0; i < e.evidence.length && size > bound; ) {
				const rec = e.evidence[i];
				if (!pick(rec)) {
					i++;
					continue;
				}
				e.evidence.splice(i, 1);
				e.omitted.budget++;
				e.omitted.sources.push(...recordHandles(rec));
				budgetOmitted++;
				size -= tok4(rec) + 1;
			}
			if (size <= bound) break;
		}
		size = tok4(renderV2(s, opts.file));
	};
	const pinned = (rec: string) => {
		if (isErrorRecord(rec) || recordHandles(rec).some((h) => ref.includes(h))) return true;
		const x = /^- (?:R\d+ · )?(?:result for )?execution (\S+)/.exec(rec)?.[1];
		if (x && mentions(ref, x)) return true;
		// a path or file name in the record's call ("read src/a.ts", "bash `cat a.ts`") named by the retained text: the referencesSource rule
		const line = rec.split("\n")[0].split(" · ").filter((p) => !/^(?:- )?(?:execution|handles?|result for) /.test(p));
		for (const t of line.join(" ").split(/\s+/)) {
			const tok = t.replace(/^[`'"(]+|[`'",;:)]+$/g, "");
			if (tok.length < 3 || !/[./]/.test(tok)) continue;
			const base = tok.split(/[\\/]/).pop() ?? "";
			if (mentions(ref, tok) || (base.length >= 3 && /[.\-_]/.test(base) && mentions(ref, base))) return true;
		}
		return false;
	};
	if (size > soft) drop((rec) => !pinned(rec), soft);
	if (size > hard) drop(() => true, hard);
	if (size > hard) {
		for (const e of s.epochs) if (e.commitments.length) e.commitments = [];
		size = tok4(renderV2(s, opts.file));
	}
	// the intent quotes repeat words the requests in History keep verbatim: they go before any prose, and before declaring overflow
	let intentsOmitted = 0;
	if (size > hard && s.intents.length) {
		intentsOmitted = s.intents.length;
		s.intents = [];
		size = tok4(renderV2(s, opts.file));
	}
	for (let i = 0; i < s.epochs.length && size > hard; i++) {
		const e = s.epochs[i];
		if (e.block.durableProse.length <= PROSE_OMITTED.length) continue; // the marker would not make it shorter
		e.block = { ...e.block, durableProse: PROSE_OMITTED };
		proseOmitted++;
		size = tok4(renderV2(s, opts.file));
	}
	if (size > hard && s.activeState.trim()) {
		s.activeState = "(omitted to fit the summary room)";
		size = tok4(renderV2(s, opts.file));
	}
	const text = renderV2(s, opts.file);
	const total = tok4(text);
	const reqs = s.epochs.flatMap((e) => e.requests);
	const sum = (f: (e: V2Epoch) => string) => tok4(s.epochs.map(f).join("\n"));
	const tokens = {
		requests: sum((e) => e.requests.map(requestRow).join("\n")),
		intent: tok4(s.intents.map((i) => i.quote).join("\n")),
		state: tok4(s.activeState),
		prose: sum((e) => e.block.durableProse),
		commitments: sum((e) => e.commitments.join("\n")),
		evidence: sum((e) => e.evidence.join("\n")),
		overhead: 0,
		total,
	};
	tokens.overhead = Math.max(0, total - tokens.requests - tokens.intent - tokens.state - tokens.prose - tokens.commitments - tokens.evidence);
	const over = total > hard;
	return {
		text,
		ok: !over,
		...(over ? { reason: "request-budget-overflow" as const, overflow: { requiredTokens: total, availableTokens: hard } } : {}),
		diagnostics: {
			formatVersion: "v2",
			numbering: "raw-branch-v2",
			epochs: s.epochs.length,
			requestCount: reqs.length,
			verbatimCount: reqs.filter((r) => !r.sourceIncomplete).length,
			sourceIncompleteCount: reqs.filter((r) => r.sourceIncomplete).length,
			executionCount: prep.stats.executionCount,
			resultCount: prep.stats.resultCount,
			lateResults: prep.stats.lateResults,
			routineReadFiltered: prep.stats.routineReadFiltered,
			budgetOmitted,
			associationUnresolved: prep.stats.associationUnresolved,
			quoteAccepted: prep.stats.quoteAccepted,
			quoteRejected: prep.stats.quoteRejected,
			roleMismatch: prep.stats.roleMismatch,
			proseOmitted,
			intentsOmitted,
			tokens,
		},
	};
}

/** prepareEpochV2 then renderEpochSummaryV2, without model calls (no prose merge). `maxSummaryTokens`: the hard bound; `targetTokens`:
 *  the soft one (defaults to the hard bound). */
export function buildEpochSummaryV2(o: PrepareV2Options & { file?: FileRecall; maxSummaryTokens?: number; targetTokens?: number }): EpochSummaryV2 {
	const hard = o.maxSummaryTokens ?? Infinity;
	return renderEpochSummaryV2(prepareEpochV2(o), { soft: o.targetTokens ?? hard, hard, file: o.file });
}

/** Quotes from the narrative reply's INTENT part: one per line, "- " and surrounding quote marks removed. */
export function intentQuotesOf(lines: readonly string[]): string[] {
	const out: string[] = [];
	for (const l of lines) {
		const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
		if (!m) continue;
		let q = m[1].trim();
		const pair = /^(["“”'‘’`])([\s\S]*)(["“”'‘’`])$/.exec(q);
		if (pair) q = pair[2];
		if (q && !/^\(?none\.?\)?$/i.test(q)) out.push(q);
	}
	return out;
}
