// Fork summary engine: v2 epochs, v3 dispatch, and migration from persisted older summaries.
// Private thinking is stripped except for bounded, labeled tentative excerpts on tool-only assistant steps (corroborated against actions/results).
import * as upstream from "./summary.ts";
import { SUMMARY_MARK, INDEX_TOKENS, BUDGET, SHORT_CHARS, SHORT_MARK, PREV_NARRATIVE_CHARS,
	bashCommands, mergeItems, excerpt, serialize, complete, addUsage, list, FILE_ROW, TABLE_ROW, INDEX_HINT, USERS_HEAD, USERS_HEAD_SHORT, NONE_ROW,
	NARRATIVE_SYSTEM, needsLowEffort, type HandleRow, type IndexRow, type Items, type FileRow, type Narrative, type PrevNarrative } from "./summary.ts";
export { SUMMARY_MARK, TABLE_ROWS, INDEX_TOKENS, BUDGET, FIRST_REQUESTS, SHORT_CHARS, SHORT_MARK, PREV_NARRATIVE_CHARS,
	bashCommands, excerpt, serialize, complete, addUsage, EFFORT_REFUSED_RE, type HandleRow, type Narrative, type PrevNarrative } from "./summary.ts";
import { reasonsByDefault } from "./reasoning-policy.ts";
import { classifySummaryRead } from "./read-policy.ts";
import { blockTime, cdAliases, distinctLines, handleFor, keyTexts, outcomeHint, RECALL_TOOL, shortArgs, whenLabel } from "./fold-format.ts";
import { type Block, type Cut, type PlanResult, NARRATIVE_MAX, settings } from "./plan.ts";
import { callOf } from "./fold-policy.ts";

import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { type EvidenceProposal, type CommitmentProposal, type IntentProposal, intentQuotesOf, parseSummaryV2, prepareEpochV2, referencesSource, regroupEpochsV2, renderEpochSummaryV2 } from "./summary-v2.ts";
import { buildCutV3, parseSummaryV3, sectionText } from "./summary-v3.ts";
import { type Any, attempt, clamp, clip, envInt, fmtWhen, textOf, tok4 } from "./util.ts";

export {
	SUMMARY_V2_DISCLAIMER, SUMMARY_V2_MARK, buildEpochSummaryV2, collectAssistantCommitments, collectExecutions, formatExecutionRecord,
	formatRequestExcerpt, MIN_EXCERPT_CHARS, parseSummaryV2, prepareEpochV2, referencesSource, regroupEpochsV2, renderEpochSummaryV2,
	resolveIntents, validateUserIntentQuote, waterFillChars,
	type EpochSummaryV2, type ExecutionRecord, type ExecutionResultRef, type V2Epoch, type V2State,
} from "./summary-v2.ts";

/**
 * Compact table appended to every summary so handles survive it: this prefix's rows merged with the rows of the previous summary's
 * table(s) (hints and outcomes kept), newest TABLE_ROWS rows, each handle once, and a count of the older rows left out.
 */
export function handleTable(rows: HandleRow[], previous: string | null = null, file?: FileRecall): string | null {
	return upstream.handleTable(rows, previous, file, parseSummary);
}

const H = "[0-9a-z]{10}"; // a handle, see handleFor
/** Row time: UTC for new rows, with local times and turn numbers accepted from older persisted summaries. */
const W = "turn \\d+|\\d\\d-\\d\\d \\d\\d:\\d\\d(?: UTC)?";
const V2_EXEC_ROW = new RegExp(`^- (?:execution \\S+ · )?handle (${H}) · (\\S+)((?: [^·]*?)?)(?: · (${W}))? · (.*)$`);
const INDEX_HEAD = "## Handle index";

/**
 * Handle rows (oldest first) recorded in an earlier summary, read from every section that carries them: the commands, files and
 * other-calls lists, the folded-outputs table and an earlier handle index. Works on the whole text, nested carried-forward blocks
 * included, so the clip applied to the carried-forward text cannot lose them.
 */
export function handleRowsOf(text: string | null): IndexRow[] {
	return upstream.handleRowsOf(text, line => {
		const match = V2_EXEC_ROW.exec(line);
		return match ? { handle: match[1], tool: match[2], args: match[3].trim(), ...(match[4] ? { when: match[4] } : {}) } : undefined;
	});
}

/**
 * Handles of the tool results the summary would otherwise lose: this prefix's results and the earlier summary's rows, newest first,
 * minus handles already written elsewhere in the summary, under a token budget. Says how many rows did not fit.
 */
function handleIndex(now: IndexRow[], previous: string | null, listed: string, budgetTokens: number, file?: FileRecall): string | null {
	return upstream.handleIndex(now, previous, listed, budgetTokens, file, handleRowsOf);
}

// ---------------------------------------------------------------------------------------------------------------
// Sectioned carry-forward. A summary is parsed into its sections; each section of the previous summary is merged with the same
// section of the new prefix, deduplicated, and the OLDEST items are dropped first under a per-section budget, with a running
// count of what was left out. (The earlier design clipped the whole carried text to its first 12,000 characters, which kept the
// oldest nested content and cut the newest requests and handles.)
// ---------------------------------------------------------------------------------------------------------------

export interface ParsedSummary extends upstream.ParsedSummary {
	epochs?: StructuredNarrative;
	cmdAliases: Map<string, string>;
}

/** Heading written for the user section. Its request bodies indent every continuation line by USER_INDENT, so a numbered list or a `## ` heading inside a request cannot be taken for an item or section start. Older summaries have no such marker and are parsed heuristically. */
/** Heading once older requests in the middle are shortened (USERS budget): those lines start with SHORT_MARK. */
/** The omission marker of a long request names its handle after this text (requestText); a shortened line keeps that handle. */
const OMITTED_REQ_HANDLE = " (handle ";
const OMITTED_REQ_RE = /\[… middle of this request omitted \(handle ([0-9a-z]{10})\)/;
const shortHandle = (t: string): string => {
	const h = OMITTED_REQ_RE.exec(t)?.[1];
	return h ? ` (whole request: handle ${h})` : "";
};
/** The commands heading names each aliased `cd <dir>` once, and the dirs older summaries left out of their rows without an alias. */
const cmdsHead = (aliases: Map<string, string>, legacy: string[]) => {
	const legend = [...aliases].sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1])).map(([d, a]) => `${a}=${d}`);
	return `## Commands run (with exit status${legend.length ? `; "[a] cmd" stands for "cd <dir> && cmd": ${legend.join(", ")}` : ""}${legacy.length ? `; a leading "cd <dir> &&" is left out for: ${legacy.join(", ")}` : ""})`;
};
const CMD_ALIAS_RE = /^## Commands run \(.*?; "\[a\] cmd" stands for "cd <dir> && cmd": (.*?)(?:; a leading "cd <dir> &&" is left out for: .*)?\)$/;
/** Alias names an alias legend uses in this text (`[a] `, anywhere a command is shown). */
const usedAliases = (text: string): Set<string> => new Set([...text.matchAll(/\[([a-z]{1,3})\] /g)].map((m) => m[1]));

/** Parse any summary text: pi-zip's current and older formats (carried-forward blocks nested inside carried-forward blocks included), or free text. */
export function parseSummary(text: string | null): ParsedSummary {
	const out: ParsedSummary = { ...upstream.parseSummary(null), cmdAliases: new Map() };
	if (!text) return out;
	const v3 = parseSummaryV3(text);
	if (v3) {
		// the format-v3 view an older-format reader needs: the resident requests (numbered; ranges counted as omitted), the aliases, the
		// digest as one epoch and the open work as the state
		out.structured = true;
		const reqs = v3.rows.flatMap((r) => ("request" in r ? [r.request] : []));
		const omitted = v3.rows.reduce((n, r) => n + ("range" in r ? r.range.last - r.range.first + 1 : 0), 0);
		out.users = { items: reqs.map((r) => r.text), omitted, nums: reqs.map((r) => r.number || r.legacyNumber || 0) };
		for (const [d, a] of v3.aliases) out.cmdAliases.set(d, a);
		const d = v3.digest;
		const body = ([["Architecture", d.architecture], ["Settled decisions", d.decisions], ["Discarded approaches", d.discarded], ["Test health", d.tests]] as const)
			.filter(([, t]) => t.length).map(([h, t]) => `**${h}**\n${sectionText(t)}`).join("\n\n");
		out.epochs = { activeState: sectionText(d.open), ...(v3.digestAt ? { activeAt: v3.digestAt } : {}), ...(v3.digestStale ? { activeStale: v3.digestStale } : {}), epochs: body ? [mkEpoch(1, 1, "state digest", v3.digestAt ?? "time unknown", 1, body)] : [] };
		if (d.open.length || body) out.narrative.push(formatNarrative(out.epochs));
		return out;
	}
	const v2 = parseSummaryV2(text);
	if (v2) {
		// the format-v2 view an older-format reader needs: every request (numbered), the aliases and the epochs' prose
		out.structured = true;
		const reqs = v2.epochs.flatMap((e) => e.requests);
		out.users = { items: reqs.map((r) => r.text), omitted: 0, nums: reqs.map((r) => r.number || r.legacyNumber || 0) };
		for (const [d, a] of v2.aliases) out.cmdAliases.set(d, a);
		out.epochs = { activeState: v2.activeState, ...(v2.activeAt ? { activeAt: v2.activeAt } : {}), ...(v2.activeStale ? { activeStale: v2.activeStale } : {}), epochs: v2.epochs.map((e) => e.block) };
		if (v2.activeState || v2.epochs.length) out.narrative.push(formatNarrative(out.epochs));
		return out;
	}
	Object.assign(out, upstream.parseSummary(text, narrative => {
		const epochs = parseEpochNarrative(narrative);
		if (epochs) out.epochs = epochs;
	}));
	for (const line of text.split("\n")) {
		const aliases = CMD_ALIAS_RE.exec(line);
		for (const pair of aliases ? aliases[1].split(/, (?=[a-z]{1,3}=)/) : []) {
			const match = /^([a-z]{1,3})=(.+)$/.exec(pair);
			if (match && ![...out.cmdAliases.values()].includes(match[1])) out.cmdAliases.set(match[2], match[1]);
		}
	}
	return out;
}

/**
 * User requests, previous (older) then new, numbered over the whole session: the first requests (numbers 1..FIRST_REQUESTS, while
 * they fit usersFirst) and the newest (users) verbatim; the ones between shortened to one line (usersShort, newest first); the rest
 * counted. A request already shortened stays as it is.
 */
function mergeUsers(prev: Items, now: string[]): { lines: string[]; omitted: number } {
	return upstream.mergeUsers(prev, now, text => SHORT_MARK + clip(text, SHORT_CHARS) + shortHandle(text));
}

// ---------------------------------------------------------------------------------------------------------------
// Append-only narrative (billion-context §3.2, §3.6, §4.2; pi-vcc's volatile/durable split). The narrative call reads ONLY the
// conversation since the previous summary, never the previous narrative, and writes two parts: the decisions and durable facts of
// that part (an epoch, appended once and then carried by code byte for byte) and the current state and open todos (volatile:
// replaced by every summary). Re-summarising the whole narrative at every cut re-compressed early facts once per summary (retention
// ~rho^k after k summaries); an epoch is compressed once when written. Only when the epochs pass their budget are two neighbouring
// epochs of the same tier, the oldest such pair, merged by one small call (an LSM-style tier merge): a fact is re-compressed about
// log2(k) times over k summaries, and the newest epochs are never touched.
// ---------------------------------------------------------------------------------------------------------------

/** One epoch: the decisions and durable facts of one part of the conversation (or of neighbouring parts, once consolidated). */
export interface EpochBlock {
	id: string; // "Epoch 3", or "Epochs 1–2" once consolidated
	turns: string; // the user requests it covers: "requests 9–12", "request 5", "within request 5"
	timestamp: string; // when its part of the conversation ended (MM-DD HH:MM UTC), a range once consolidated
	durableProse: string;
	tokens: number; // chars/4 of its heading and prose
	first?: number; // number of the first epoch it covers (0 = the narrative of an older-format or foreign summary, carried verbatim)
	last?: number;
	level?: number; // tier: 1 = written once from its own part; n = the result of tier merges n-1 deep
	note?: string; // "not written: <why>", "earlier narrative, carried verbatim; ..."
}

/** The narrative of a summary in the append-only format. */
export interface StructuredNarrative {
	activeState: string; // volatile: current state and open todos, reconciled with the next slice
	activeAt?: string; // when it was written (MM-DD HH:MM UTC)
	activeStale?: string; // set when it was carried forward because a new one could not be written: why
	epochs: EpochBlock[]; // durable: append-only, oldest first
}

/** Budget of the epochs (tokens); over it, tier merges run. The narrative budget of the cut lowers it, never below EPOCH_CAP_MIN. */
export const MAX_NARRATIVE_TOKENS = envInt("SUM_NARRATIVE_TOKENS", 2500);
const EPOCH_CAP_MIN = 1000;
/** Words the narrative call is asked for: the epoch's decisions and durable facts, and the current state and open todos. */
export const EPOCH_WORDS = envInt("SUM_EPOCH_WORDS", 250);
export const ACTIVE_WORDS = envInt("SUM_ACTIVE_WORDS", 150);
/** Only the bounded active state is re-read; durable epochs never enter the narrative call. */
export const ACTIVE_INPUT_TOKENS = 500;
/** Tier merges one summary may run (each a small call over two epochs). */
export const MAX_MERGES_PER_CUT = 3;
/** A part of the reply is clipped (head and tail) at this many characters per word asked: ~1.6x a reply at its budget (~7.7 chars a word). */
const CHARS_PER_WORD = 12;
/** An older-format or foreign narrative becomes Epoch 0, carried verbatim up to this many characters (its head and its tail). */
const LEGACY_CHARS = MAX_NARRATIVE_TOKENS * 2;

/** The words of a narrative call for a narrative budget of this many tokens: decisions and durable facts, and the current state. */
export function epochWords(budgetTokens: number): { durable: number; active: number } {
	const all = EPOCH_WORDS + ACTIVE_WORDS;
	const total = Math.round(clamp(budgetTokens * 0.6, 120, all));
	const durable = Math.round((total * EPOCH_WORDS) / all);
	return { durable, active: total - durable };
}
/** The epochs' token budget for a narrative budget of this many tokens (the current state's share left out). */
export const epochCap = (budgetTokens: number) => clamp(budgetTokens - Math.ceil(epochWords(budgetTokens).active * 1.5), EPOCH_CAP_MIN, MAX_NARRATIVE_TOKENS);

/**
 * The previous summary's narrative only (not its lists): the model-written sections of pi-zip's summary (an older summary's carried
 * excerpt included), or the whole text of a free-text summary. null: none. `at` = the previous summary's timestamp (ms), used when
 * the text does not say when its narrative was written. A narrative in an older format becomes Epoch 0 of the next one (legacyNarrative).
 */
export function previousNarrative(text: string | null, at?: number, maxChars = PREV_NARRATIVE_CHARS): PrevNarrative | null {
	const parsed = parseSummary(text);
	return upstream.previousNarrative(text, at, maxChars, { ...parsed, narrativeAt: parsed.narrativeAt ?? parsed.epochs?.activeAt });
}

const DURABLE_HEAD = "### Decisions and durable facts (append-only epochs, oldest first: each written once from its own part of the conversation and not rewritten; only the oldest are consolidated, when over budget)";
const ACTIVE_PREFIX = "### Current state and open todos (";
const activeHead = (s: StructuredNarrative) =>
	ACTIVE_PREFIX +
	(s.activeStale
		? `carried forward from the summary of ${s.activeAt ?? "an earlier time"}; possibly stale: a new one could not be written: ${s.activeStale})`
		: `as of ${s.activeAt ?? "the end of the summarised part"}; replaced by each new summary)`);
const EPOCH_HEAD = /^#### Epochs? (\d+)(?:–(\d+))? · (.*)$/;
const TIER = /^consolidated, tier (\d+)$/;
/** One line of a heading: no newlines, and no " · " (the heading's field separator). */
const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/·/g, "-").trim();
export const epochHead = (e: EpochBlock) => `#### ${e.id} · ${e.turns} · ${e.timestamp}${(e.level ?? 1) > 1 ? ` · consolidated, tier ${e.level}` : ""}${e.note ? ` · ${e.note}` : ""}`;

function epochNum(e: EpochBlock, hi = false): number {
	const v = hi ? (e.last ?? e.first) : (e.first ?? e.last);
	if (v !== undefined) return v;
	const m = [...e.id.matchAll(/\d+/g)].map((x) => Number(x[0]));
	return (hi ? m.at(-1) : m[0]) ?? 1;
}

export function mkEpoch(first: number, last: number, turns: string, timestamp: string, level: number, durableProse: string, note?: string): EpochBlock {
	const e: EpochBlock = { id: first === last ? `Epoch ${first}` : `Epochs ${first}–${last}`, first, last, turns: oneLine(turns), timestamp: oneLine(timestamp) || "time unknown", level, durableProse, tokens: 0, ...(note ? { note: oneLine(note) } : {}) };
	e.tokens = tok4(epochHead(e) + "\n" + durableProse);
	return e;
}
const epochTokens = (eps: EpochBlock[]) => eps.reduce((a, e) => a + (e.tokens || tok4(epochHead(e) + "\n" + e.durableProse)) + 1, 0);

/**
 * Model-written text as it may sit inside the narrative section: a markdown heading becomes a bold line, so nothing the model writes
 * can start a summary section (`## Errors`), an epoch (`#### Epoch`) or the current state; the summary mark line goes.
 */
export function prose(t: string): string {
	return t
		.split("\n")
		.map((l) => { const m = /^\s{0,3}#{1,6}\s+(.*?)[\s#]*$/.exec(l); return m ? (m[1] ? `**${m[1]}**` : "") : l; })
		.filter((l) => l.trim() !== SUMMARY_MARK)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
/** A part of a reply clipped to its word budget (head and tail kept). */
const clipPart = (t: string, words: number) => excerpt(t, Math.max(200, words * CHARS_PER_WORD), Math.floor(Math.max(200, words * CHARS_PER_WORD) / 3));
/** Characters the current state may take in a summary for this many words (the same bound as clipPart). */
const activeChars = (words: number) => Math.max(200, words * CHARS_PER_WORD);

/** A line of the current state that holds open work: a `- [ ]` item (the format the prompt asks for), or a line naming a todo or blocker. */
const OPEN_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]|\b(?:todo|fixme|blocker|blocked|pending|next step)s?\b/i;

/**
 * The current state bounded to `maxChars` by whole lines. Open-work lines are kept before other lines; kept lines stay in their order.
 * A line is never cut in the middle, except an open line that alone exceeds the room left (its head is kept). Every dropped line is
 * counted in one closing marker, so the reader of the summary sees that open work was left out and how much.
 */
export function clipActive(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const lines = text.split("\n"), open = lines.map((l) => OPEN_LINE.test(l));
	const kept: (string | null)[] = lines.map(() => null);
	const room = maxChars - 80; // the marker: "[… 9999 open items and 9999 other lines omitted for length …]" with its newline
	let used = 0;
	for (const wantOpen of [true, false]) {
		for (let i = 0; i < lines.length; i++) {
			if (kept[i] !== null || open[i] !== wantOpen || !lines[i].trim()) continue;
			const left = room - used;
			if (lines[i].length + 1 <= left) kept[i] = lines[i];
			else if (wantOpen && left >= 120) {
				const head = lines[i].slice(0, left - 3), trimmed = head.replace(/\s+\S{1,24}$/, "");
				kept[i] = (trimmed.length >= 16 ? trimmed : head) + " …";
			} else continue;
			used += kept[i]!.length + 1;
		}
	}
	let o = 0, s = 0;
	lines.forEach((l, i) => { if (kept[i] === null && l.trim()) open[i] ? o++ : s++; });
	const n = (k: number, what: string) => `${k} ${what}${k > 1 ? "s" : ""}`;
	const marker = `[… ${[o ? n(o, "open item") : "", s ? n(s, "other line") : ""].filter(Boolean).join(" and ")} omitted for length …]`;
	return [...kept.filter((l): l is string => l !== null), ...(o || s ? [marker] : [])].join("\n");
}

const MARK_LINE = /^[\s#*_>`-]*(DECISIONS|ACTIVE|INTENT|COMMITMENTS|EVIDENCE)\b[\s#*_:`-]*$/i;
const ACTIVE_TOPIC = /current state|state of the work|open todo|todos|next step|blocker|in.flight|active|status/i;
/**
 * The two parts of a narrative reply: decisions and durable facts, and the current state and open todos. Reads the marker lines the
 * prompt asks for; a reply without them is split by its headings (the older four headings included); a reply with neither is all durable.
 */
export function parseNarrativeReply(text: string): { durable: string; active: string; intent?: string[]; commitments?: CommitmentProposal[]; evidence?: EvidenceProposal[] } {
	const lines = text.split("\n");
	const d: string[] = [], a: string[] = [], i: string[] = [], c: string[] = [], e: string[] = [];
	const marked = lines.some((l) => MARK_LINE.test(l));
	let cur = d, sawIntent = false;
	for (const l of lines) {
		const m = MARK_LINE.exec(l);
		if (marked) {
			if (m) {
				const k = m[1].toUpperCase();
				cur = k === "ACTIVE" ? a : k === "INTENT" ? i : k === "COMMITMENTS" ? c : k === "EVIDENCE" ? e : d;
				if (k === "INTENT") sawIntent = true;
			} else cur.push(l);
			continue;
		}
		const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
		if (h) cur = ACTIVE_TOPIC.test(h[1]) ? a : d;
		cur.push(l);
	}
	const none = (t: string) => (!t || /^\(?none\.?\)?\.?$/i.test(t) ? NONE_ROW : t);
	const quotes = (lines: string[]): Array<{ sourceHandle: string; quote: string }> => {
		const out: Array<{ sourceHandle: string; quote: string }> = [];
		for (const line of lines) {
			try {
				const p = JSON.parse(line);
				if (typeof p?.sourceHandle === "string" && typeof p?.quote === "string") out.push({ sourceHandle: p.sourceHandle, quote: p.quote });
			} catch { /* A malformed proposal adds no record. */ }
		}
		return out;
	};
	return { durable: none(prose(d.join("\n"))), active: prose(a.join("\n")), ...(sawIntent ? { intent: intentQuotesOf(i) } : {}), ...(c.length ? { commitments: quotes(c) } : {}), ...(e.length ? { evidence: quotes(e) } : {}) };
}

/** The narrative section's body: the current state first, then the epochs, oldest first (bounded to `maxTokens` when given). */
export function formatNarrative(data: StructuredNarrative, maxTokens = Infinity): string {
	const parts: string[] = [];
	if (data.activeState.trim()) parts.push(`${activeHead(data)}\n${data.activeState.trim()}`);
	const epochs = maxTokens < Infinity ? boundEpochs(data.epochs, maxTokens) : data.epochs;
	if (epochs.length) parts.push([DURABLE_HEAD, ...epochs.map((e) => `${epochHead(e)}\n${e.durableProse}`)].join("\n"));
	return parts.join("\n");
}

/** A narrative section's body in the append-only format, or null (an older format or free text). */
export function parseEpochNarrative(text: string): StructuredNarrative | null {
	const lines = text.split("\n");
	if (!lines.some((l) => l.startsWith(DURABLE_HEAD.slice(0, 35)) || l.startsWith(ACTIVE_PREFIX))) return null;
	const out: StructuredNarrative = { activeState: "", epochs: [] };
	const active: string[] = [];
	let mode: "none" | "active" | "durable" = "none";
	let cur: { m: RegExpExecArray; lines: string[] } | null = null;
	const close = () => {
		if (!cur) return;
		const [, a, b, rest] = cur.m;
		const [turns = "", timestamp = "", ...more] = rest.split(" · ");
		let level = 1;
		const notes: string[] = [];
		for (const x of more) { const t = TIER.exec(x); if (t) level = Number(t[1]); else notes.push(x); }
		out.epochs.push(mkEpoch(Number(a), Number(b ?? a), turns, timestamp, level, cur.lines.join("\n").trim(), notes.join(" - ") || undefined));
		cur = null;
	};
	for (const l of lines) {
		if (l.startsWith(ACTIVE_PREFIX)) {
			close();
			mode = "active";
			const at = /(?:as of|from the summary of) ([^;)]+)/.exec(l)?.[1];
			const stale = /could not be written: (.*)\)$/.exec(l)?.[1];
			if (at && at !== "an earlier time" && at !== "the end of the summarised part") out.activeAt = at;
			if (stale) out.activeStale = stale;
			continue;
		}
		if (l.startsWith(DURABLE_HEAD.slice(0, 35))) { close(); mode = "durable"; continue; }
		const m = mode === "durable" ? EPOCH_HEAD.exec(l) : null;
		if (m) { close(); cur = { m, lines: [] }; continue; }
		if (mode === "active") active.push(l);
		else if (cur) cur.lines.push(l);
	}
	close();
	out.activeState = active.join("\n").trim();
	return out;
}

/** The request numbers an epoch covers: the previous summary numbered requests up to `last`; this part adds `added`. */
export const turnsLabel = (last: number, added: number) => (added > 1 ? `requests ${last + 1}–${last + added}` : added === 1 ? `request ${last + 1}` : last > 0 ? `within request ${last}` : "no user request");
const lastRequestNo = (u: Items) => Math.max(u.omitted + u.items.length, u.nums?.at(-1) ?? 0);

/** An older-format or foreign narrative becomes Epoch 0, carried verbatim (head and tail of a long one); its state may be stale. */
export function legacyNarrative(prev: string | null, prevAt: number, lastReq: number): StructuredNarrative {
	const p = previousNarrative(prev, prevAt, LEGACY_CHARS);
	if (!p) return { activeState: "", epochs: [] };
	const what = p.foreign ? "the earlier summary (another summariser's)" : "the earlier narrative";
	return { activeState: "", epochs: [mkEpoch(0, 0, lastReq ? turnsLabel(0, lastReq) : "the earlier conversation", p.at ?? "time unknown", 1, prose(p.text), `${what}, carried verbatim; its state and todos are possibly stale`)] };
}

function joinTurns(a: EpochBlock, b: EpochBlock): string {
	const nums = (t: string) => [...t.matchAll(/\d+/g)].map((m) => Number(m[0]));
	const n = [...nums(a.turns), ...nums(b.turns)];
	if (!n.length) return a.turns === b.turns ? a.turns : `${a.turns}, ${b.turns}`;
	const lo = Math.min(...n), hi = Math.max(...n);
	const range = lo === hi ? `request ${lo}` : `requests ${lo}–${hi}`;
	return nums(a.turns).length ? range : `${a.turns}, ${range}`;
}
function joinTime(a: EpochBlock, b: EpochBlock): string {
	const start = a.timestamp.split(" – ")[0], end = b.timestamp.split(" – ").at(-1)!;
	return start === end ? start : `${start} – ${end}`;
}
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** The pair a tier merge takes: the oldest two neighbouring historical epochs of the same tier, leaving the newest epoch untouched. */
export function pickPair(eps: EpochBlock[]): number {
	const limit = eps.length > 2 ? eps.length - 1 : eps.length;
	for (let i = 0; i + 1 < limit; i++) if ((eps[i].level ?? 1) === (eps[i + 1].level ?? 1)) return i;
	return 0;
}

/** Output tokens a merge call adds for reasoning the model spends anyway. Reasoning counts toward the call's maxTokens. */
export const MERGE_REASONING_TOKENS = envInt("SUM_MERGE_REASONING_TOKENS", 4096);

/** The model reasons on a summariser call even though none is asked for: by default (reasonsByDefault), or because its provider refused a
 *  request without reasoning and is now asked for "low" (lowEffort). */
export function reasonsAnyway(model: Any): boolean {
	return reasonsByDefault(model) || (!!model?.reasoning && needsLowEffort(model));
}

/** Shared by execution and the planner's cost reserve; merge calls have a word-sized cap, not the narrative's 16K cap. */
function mergeSpec(a: EpochBlock, b: EpochBlock, model?: Any) {
	const words = clamp(Math.round(0.6 * wordCount(a.durableProse + " " + b.durableProse)), 120, EPOCH_WORDS);
	const prompt =
		[a, b].map((e) => `<epoch heading="${epochHead(e).slice(5).replace(/"/g, "'")}">\n${e.durableProse}\n</epoch>`).join("\n\n") +
		`\n\nThese are two consecutive epochs of the decisions and durable facts recorded for one coding session, oldest first. Merge them into ONE block: ` +
		`keep every decision with its rationale, every constraint or ruling of the user, and every exact path, identifier, value and result the work may still ` +
		`depend on; where the later epoch supersedes the earlier one, keep only the later; drop only what is plainly obsolete. Add nothing that is not in them, ` +
		`and do not mention the epochs or the merge. Output only the merged text, as short markdown bullets without headings. Stay under about ${words} words. Do not call tools.`;
	const maxChars = Math.min(words * CHARS_PER_WORD, Math.max(400, Math.floor((a.durableProse.length + b.durableProse.length) * 0.75)));
	return { prompt, maxChars, maxTokens: Math.max(1024, words * 12) + (reasonsAnyway(model) ? MERGE_REASONING_TOKENS : 0) };
}
const mergeBlock = (a: EpochBlock, b: EpochBlock, body: string) => mkEpoch(epochNum(a, false), epochNum(b, true), joinTurns(a, b), joinTime(a, b), Math.max(a.level ?? 1, b.level ?? 1) + 1, body);

/** One tier merge: two neighbouring epochs into one by a small call. */
async function mergeEpochs(a: EpochBlock, b: EpochBlock, ctx: Any, signal?: AbortSignal): Promise<Narrative & { block?: EpochBlock }> {
	const spec = mergeSpec(a, b, ctx.model);
	const r = await complete(ctx, spec.prompt, signal, spec.maxTokens);
	if (!r.ok || !r.text) return r;
	const body = excerpt(prose(r.text) || NONE_ROW, spec.maxChars, Math.floor(spec.maxChars / 3));
	return { ...r, block: mergeBlock(a, b, body) };
}

export interface MergeWork { inputTokens: number; outputTokens: number; merges: number }

/** Conservative reserve before writing the newest epoch: simulate tier selection with maximum-sized replies, not hoped-for shrinkage. */
export function estimateMergeWork(previous: string | null, budgetTokens: number, scale = 1, model?: Any): MergeWork {
	// A v3 digest is never merged. The narrative call re-reads it: the part beyond the active-state reserve is priced here as input.
	const v3 = parseSummaryV3(previous);
	if (v3) {
		const d = v3.digest;
		return { inputTokens: Math.ceil(scale * tok4([d.architecture, d.decisions, d.discarded, d.tests].map(sectionText).concat(v3.intents.map((i) => i.quote)).join("\n"))) + 64, outputTokens: 0, merges: 0 };
	}
	const prev = parseSummary(previous);
	const struct = prev.epochs ?? legacyNarrative(previous, 0, lastRequestNo(prev.users));
	const work: MergeWork = { inputTokens: 0, outputTokens: 0, merges: 0 };
	// The new epoch is never merged on this cut. Reserve its largest permitted body and a heading allowance.
	let eps = [...struct.epochs, mkEpoch(999999, 999999, "requests 999999–999999", "time unknown", 1, "x".repeat(EPOCH_WORDS * CHARS_PER_WORD + 128))];
	while (eps.length > 2 && epochTokens(eps) > epochCap(budgetTokens) && work.merges < MAX_MERGES_PER_CUT) {
		const i = pickPair(eps), a = eps[i], b = eps[i + 1], spec = mergeSpec(a, b, model);
		work.inputTokens += Math.ceil(scale * tok4(NARRATIVE_SYSTEM + spec.prompt)) + 256;
		work.outputTokens += Math.min(spec.maxTokens, Number(model?.maxTokens) > 0 ? Number(model.maxTokens) : spec.maxTokens);
		work.merges++;
		// Clipping can add an omission marker; maximum word density also reserves the next merge's largest output cap.
		const body = "x ".repeat(Math.ceil((spec.maxChars + 80) / 2));
		eps = [...eps.slice(0, i), mergeBlock(a, b, body), ...eps.slice(i + 2)];
	}
	return work;
}

/**
 * Tier merges of historical epochs until the epochs fit `target` tokens, at most MAX_MERGES_PER_CUT calls (the newest epoch stays untouched).
 * A merge that fails leaves its pair as it was (the next summary tries again); the epochs are never lost to a failed call.
 */
export async function consolidateEpochs(epochs: EpochBlock[], ctx: Any, target: number, signal?: AbortSignal): Promise<{ epochs: EpochBlock[]; costUsd: number; usage?: Any; merges: number; error?: string }> {
	let eps = [...epochs], costUsd = 0, merges = 0, usage: Any, error: string | undefined;
	while (eps.length > 2 && epochTokens(eps) > target && merges < MAX_MERGES_PER_CUT) {
		const i = pickPair(eps);
		const r = await mergeEpochs(eps[i], eps[i + 1], ctx, signal);
		merges++;
		costUsd += r.costUsd;
		usage = addUsage(usage, r.usage);
		if (!r.block) { error = r.error ?? "merge failed"; break; }
		eps = [...eps.slice(0, i), r.block, ...eps.slice(i + 2)];
	}
	return { epochs: eps, costUsd, merges, ...(usage ? { usage } : {}), ...(error ? { error } : {}) };
}

/**
 * The hard bound when tier merges could not run. Reserve the newest epoch verbatim when it fits; only historical epochs are joined.
 * An individually oversized epoch is clipped before reserving it. Headings, separators and omission markers count toward the bound.
 */
export function boundEpochs(epochs: EpochBlock[], hard: number): EpochBlock[] {
	if (!epochs.length || epochTokens(epochs) <= hard) return [...epochs];
	const fit = (e: EpochBlock, budget: number): EpochBlock[] => {
		if (epochTokens([e]) <= budget) return [e];
		const chars = Math.floor((budget - 1) * 4) - epochHead(e).length - 1;
		if (chars < 0) return []; // even the heading cannot fit
		const markerChars = "\n[… middle of the narrative omitted …]\n".length;
		const max = Math.max(0, chars - markerChars);
		const body = max > 0 ? excerpt(e.durableProse, max, Math.floor(max / 3)).slice(0, chars) : "";
		return [mkEpoch(epochNum(e, false), epochNum(e, true), e.turns, e.timestamp, e.level ?? 1, body, e.note)];
	};
	const last = epochs.at(-1)!;
	const newest = fit(last, epochTokens([last]) > hard && epochs.length > 1 ? Math.floor(hard / 2) : hard);
	const room = hard - epochTokens(newest);
	let history = epochs.slice(0, -1);
	while (history.length > 1 && epochTokens(history) > room) {
		const i = pickPair(history);
		const a = history[i], b = history[i + 1];
		history = [...history.slice(0, i), mkEpoch(epochNum(a, false), epochNum(b, true), joinTurns(a, b), joinTime(a, b), Math.max(a.level ?? 1, b.level ?? 1) + 1, `${a.durableProse}\n${b.durableProse}`, "joined without a model call; its middle may be omitted"), ...history.slice(i + 2)];
	}
	if (history.length === 1) history = fit(history[0], room);
	return [...history, ...newest];
}

/** A user request as the summary quotes it: verbatim, the middle of a very long one left out. The marker names the request's handle
 *  (recall returns user requests by handle, like tool outputs) so the model can read the whole request again. */
function requestText(content: Any, entryId?: string | null, file?: FileRecall): string {
	const t = textOf(content).trim();
	if (t.length <= 3000) return t;
	const h = entryId ? handleFor(entryId) : null;
	const how = !h ? "" : `${OMITTED_REQ_HANDLE}${h}): ${file ? `${file.dir}/${h}.txt holds it whole` : `${RECALL_TOOL} returns it whole`}`;
	return t.slice(0, 2000) + `\n[… middle of this request omitted${how} …]\n` + t.slice(-800);
}

/**
 * The user requests a branch holds before the entry `firstId`, oldest first, or null when the branch does not hold that entry.
 * A summary another summariser wrote (Pi's own compaction, say) keeps no list of requests; compaction never deletes entries, so the
 * branch still holds every request that summary took out of the view, and they are quoted from there, numbered from the session's first.
 */
export function earlierRequests(branch: Any[], firstId: string | null | undefined, file?: FileRecall): string[] | null {
	const end = firstId ? branch.findIndex((e) => e?.id === firstId) : -1;
	if (end < 0) return null;
	const out: string[] = [];
	for (const e of branch.slice(0, end)) {
		if (e?.type !== "message" || e.message?.role !== "user") continue;
		const t = requestText(e.message.content, e.id, file);
		if (t) out.push(t);
	}
	return out;
}

export interface SkeletonOptions {
	cwd?: string;
	filterRoutineReads?: boolean;
	referencedHandles?: ReadonlySet<string>;
	/** What the retained narrative and state say: a read it names by handle, path or file name is kept (referencesSource). */
	referenceText?: string;
}

/**
 * The deterministic part of a summary: user words verbatim, files, commands, other calls, errors and a handle index, each section
 * merged from the previous summary `previous` (any format) and this prefix. `tableText` = the folded-outputs table the caller will
 * append, so the index does not repeat its handles. `earlier` = the requests before this prefix when `previous` keeps no list of them.
 */
export function skeleton(
	prefix: Block[],
	previous: string | null,
	tableText = "",
	file?: FileRecall,
	earlier?: string[],
	opts?: SkeletonOptions,
): { text: string; users: number; routineReadFiltered: number } {
	const resultByCallId = new Map<string, Block>();
	// Map each toolCallId in source order; if an assistant message duplicates an ID, mark ambiguous.
	const users: string[] = [];
	const files = new Map<string, Map<string, string | null>>(); // path -> tool -> handle of its latest result
	const cmds: string[] = [];
	const others: string[] = []; // tools with neither a command nor a path (web fetch, pathless grep, custom tools)
	const errors: string[] = [];
	const now: IndexRow[] = []; // every recallable result of this prefix, oldest first
	const nowText: string[] = []; // ... and its output (to tell look-alike rows apart)
	const aliases = cdAliases(bashCommands(prefix), parseSummary(previous).cmdAliases);
	let routineReadFiltered = 0;

	// Pair results to the latest preceding issuer in source order.
	const callResults = new Map<string, Block[]>(); // `${blockIdx}:${callPos}` -> Block[]
	const activeCallForId = new Map<string, { key: string; ambiguous: boolean }>();
	for (const b of prefix) {
		if (b.kind === "assistant") {
			const content = b.msg.content ?? [];
			const counts = new Map<string, number>();
			for (const c of content) if (c?.type === "toolCall" && c.id) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
			for (let pos = 0; pos < content.length; pos++) {
				const c = content[pos];
				if (c?.type !== "toolCall" || !c.id) continue;
				const key = `${b.idx}:${pos}`;
				activeCallForId.set(c.id, { key, ambiguous: (counts.get(c.id) ?? 0) > 1 });
			}
		} else if (b.kind === "toolResult" && b.msg?.toolCallId) {
			const m = activeCallForId.get(b.msg.toolCallId);
			if (m && !m.ambiguous) {
				callResults.set(m.key, [...(callResults.get(m.key) ?? []), b]);
			}
			resultByCallId.set(b.msg.toolCallId, b);
		}
	}

	for (const b of prefix) {
		if (b.kind === "user") {
			const t = requestText(b.msg.content, b.entryId, file);
			if (t) users.push(t);
		}
		if (b.kind !== "assistant") continue;
		const content = b.msg.content ?? [];
		for (let pos = 0; pos < content.length; pos++) {
			const c = content[pos];
			if (c?.type !== "toolCall") continue;
			const a = c.arguments ?? {};
			const paired = callResults.get(`${b.idx}:${pos}`);
			const res = paired ? paired[paired.length - 1] : undefined;
			const resText = res ? textOf((res.raw ?? res.msg).content) : "";
			const resHandle = res?.entryId ? handleFor(res.entryId) : null;
			if (
				opts?.filterRoutineReads &&
				paired?.length === 1 &&
				res &&
				!res.msg.isError &&
				!(resHandle && opts.referencedHandles?.has(resHandle)) &&
				!referencesSource(opts.referenceText ?? "", { executionId: `${b.entryId}:${pos}`, results: resHandle ? [{ handle: resHandle } as Any] : [], path: typeof (a.path ?? a.file_path) === "string" ? String(a.path ?? a.file_path) : undefined, command: typeof a.command === "string" ? a.command : undefined }) &&
				classifySummaryRead(c.name, a, resText, opts.cwd ?? ".", !!res.msg.isError, (res.raw ?? res.msg).content).eligible
			) {
				routineReadFiltered++;
				continue;
			}
			if (c.name === "bash") {
				const m = /Command exited with code (\d+)/.exec(resText);
				const status = m ? `exit ${m[1]}` : res?.msg.isError ? "error" : res ? "exit 0" : "no result";
				const tag = res ? ` (${whenLabel(blockTime(res), res.userTurn)}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : ""; // every result is recallable, so every one gets its handle
				cmds.push(`\`${shortArgs({ command: String(a.command ?? "") }, BUDGET.cmdChars, aliases)}\` -> ${status}${tag}`);
			} else if (typeof a.path === "string" || typeof a.file_path === "string") {
				const p = String(a.path ?? a.file_path);
				if (!files.has(p)) files.set(p, new Map());
				const ops = files.get(p)!;
				ops.set(c.name, res?.entryId ? handleFor(res.entryId) : (ops.get(c.name) ?? null));
			} else if (c.name !== RECALL_TOOL) {
				const tag = res ? ` (${whenLabel(blockTime(res), res.userTurn)}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : " (no result)";
				others.push(`${c.name} ${shortArgs(a)}${tag}`);
			}
			if (res?.entryId && c.name !== RECALL_TOOL) {
				now.push({ handle: handleFor(res.entryId), tool: c.name, args: shortArgs(a, 60, aliases), turn: res.userTurn, at: blockTime(res) });
				nowText.push(resText);
			}
			if (res?.msg.isError) errors.push(`- ${c.name} ${shortArgs(a)}: ${clip(resText, 200)}`);
		}
	}
	const prev = parseSummary(previous);
	// user requests: previous (older) then new, the first and the newest verbatim, the ones between shortened, numbered over the session
	// (`earlier`: the requests before this prefix, quoted from the session when the previous summary keeps no list of them)
	const mu = mergeUsers(earlier ? { items: earlier, omitted: 0 } : prev.users, users);
	// files: a path touched again moves to the newest end with its newest handles
	const merged = new Map<string, FileRow>(prev.files.rows.map((r) => [r.path, r]));
	for (const [path, ops] of files) {
		const ex = merged.get(path);
		merged.delete(path);
		merged.set(path, { path, ops: new Map([...(ex?.ops ?? []), ...[...ops].filter(([t, h]) => h !== null || !ex?.ops.has(t))]) });
	}
	const fileText = [...merged.values()].map((r) => `- ${r.path} (${[...r.ops].map(([t, h]) => (h ? `${t}: ${h}` : t)).join(", ")})`);
	const mf = mergeItems(fileText, [], prev.files.omitted, BUDGET.lines, BUDGET.files, (l) => FILE_ROW.exec(l)?.[1]);
	const mc = mergeItems(prev.cmds.items, cmds, prev.cmds.omitted, BUDGET.lines, BUDGET.cmds);
	const mo = mergeItems(prev.others.items, others, prev.others.omitted, BUDGET.lines, BUDGET.others);
	const me = mergeItems(prev.errors.items, errors, prev.errors.omitted, BUDGET.errorLines, BUDGET.errors);
	const out: string[] = [SUMMARY_MARK];
	out.push(
		file
			? `Covers ${prefix.length} earlier messages. Their tool outputs are no longer in your context but are kept exactly: the 10-character code next to a command, file or call below is its handle, and ${file.dir}/<handle>.txt holds that output. ` +
					`To use what an output said, ${fileRecallHow(file)}${file.grep || file.bash ? ` (grep over ${file.dir} searches every earlier output)` : ""} rather than re-running or re-reading (results may differ). Folded blocks later in the conversation work the same way.`
			: `Covers ${prefix.length} earlier messages. Their tool outputs are no longer in your context but are kept exactly: the 10-character code next to a command, file or call below is its handle. ` +
					`To use what an output said, ${RECALL_TOOL} it (grep/range for a part; grep alone searches every earlier output) rather than re-running or re-reading (results may differ). Folded blocks later in the conversation work the same way.`,
	);
	out.push(mu.lines.some((l) => /^\d+\. ≈ /.test(l)) ? USERS_HEAD_SHORT : USERS_HEAD);
	out.push(...(mu.lines.length ? mu.lines : [NONE_ROW]));
	out.push(...list("## Files touched", mf, "older omitted"));
	const cmdsAt = out.length; // its heading is written last: the legend names only the aliases some row of this summary still shows
	out.push(...list(cmdsHead(new Map(), []), mc, "older omitted"));
	if (mo.kept.length) out.push(...list("## Other tool calls (time, handle)", mo, "older omitted"));
	out.push(...list("## Errors", me, "older omitted"));
	// index rows of this prefix that would read the same (same tool and arguments): each gets the first line of its output that tells it apart
	const groups = new Map<string, number[]>();
	now.forEach((r, i) => groups.set(`${r.tool} ${r.args}`, [...(groups.get(`${r.tool} ${r.args}`) ?? []), i]));
	for (const ix of groups.values()) {
		if (ix.length < 2) continue;
		const hints = distinctLines(ix.map((i) => nowText[i]), ix.map((i) => keyTexts(nowText[i])), [], INDEX_HINT);
		ix.forEach((i, k) => hints[k] && (now[i].hint = hints[k]!));
	}
	const index = handleIndex(now, previous, out.join("\n") + "\n" + tableText, INDEX_TOKENS, file);
	if (index) out.push(index);
	const used = usedAliases(out.join("\n") + "\n" + tableText);
	out[cmdsAt] = cmdsHead(new Map([...aliases].filter(([, a]) => used.has(a))), prev.cmdDirs);
	// buildCut carries durable epochs and reconciles active state separately from these deterministic lists.
	return { text: out.join("\n"), users: users.length, routineReadFiltered };
}

export const REASONING_NOTE = "[Tentative reasoning excerpt; not a verified result] ";
export const REASONING_QUALIFICATION =
	"Assistant tentative reasoning excerpts are untrusted context, not evidence of completion or external truth. " +
	"Corroborate durable claims against user instructions, actions and results. " +
	"Do not promote unverified hypotheses to decisions, established causes or completed work.";
export const REASONING_LIMITS = { perMessage: 360, total: 8000 };

function clipReasoning(s: string, cap: number): string {
	if (s.length <= cap) return s;
	const marker = "[… omitted …]";
	if (cap < marker.length + 2) return "";
	const head = Math.ceil((cap - marker.length) / 2);
	return s.slice(0, head) + marker + s.slice(-(cap - marker.length - head));
}

/**
 * Selects bounded, labeled reasoning excerpts ONLY for non-error tool-only assistant messages (where visible text is absent)
 * and strips all raw thinking/redacted_thinking/reasoning blocks. Newest steps win the budget; output stays chronological.
 */
export function reasoningInput(messages: Any[], limits = REASONING_LIMITS): { addedChars: number; selected: number[]; messages: Any[] } {
	const excerpts = new Map<number, string>();
	let remaining = Math.max(0, limits.total);
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i], content = m?.content;
		if (m?.role !== "assistant" || !Array.isArray(content) || ["error", "aborted"].includes(m.stopReason)) continue;
		if (!content.some((c: Any) => c?.type === "toolCall") || content.some((c: Any) => c?.type === "text" && c.text?.trim())) continue;
		const thought = content
			.filter((c: Any) => c?.type === "thinking" && c.redacted !== true && typeof c.thinking === "string")
			.map((c: Any) => c.thinking.trim())
			.filter(Boolean)
			.join("\n");
		const cap = Math.min(limits.perMessage, remaining) - REASONING_NOTE.length;
		if (!thought || cap < 1) continue;
		const excerpt = clipReasoning(thought, cap);
		if (!excerpt) continue;
		const shown = REASONING_NOTE + excerpt;
		excerpts.set(i, shown);
		remaining -= shown.length;
	}
	return {
		addedChars: Math.max(0, limits.total - remaining),
		selected: [...excerpts.keys()].sort((a, b) => a - b),
		messages: messages.map((m, i) =>
			m?.role !== "assistant" || !Array.isArray(m.content)
				? m
				: {
						...m,
						content: [
							...(excerpts.has(i) ? [{ type: "text", text: excerpts.get(i)! }] : []),
							...m.content.filter((c: Any) => !["thinking", "redacted_thinking", "reasoning"].includes(c?.type)),
						],
					},
		),
	};
}

/**
 * The narrative of this prefix, written by the current model in a separate, uncached call. Never throws. Durable epochs are not
 * re-read. Only the bounded previous active state is reconciled against this slice. `durable`/`active` = the reply's two parts.
 */
/** `intent`: also ask for the user's own words that state what they want now (format v2's Current intent), given the previous ones. */
export async function narrative(prefix: Block[], ctx: Any, budgetTokens: number, ownSignal?: AbortSignal, previousActive = "", intent?: { previous: string[] }): Promise<Narrative & { durable?: string; active?: string; intent?: string[]; commitments?: CommitmentProposal[]; evidence?: EvidenceProposal[] }> {
	const t0 = Date.now();
	if (!ctx.model) return { text: null, ok: false, ms: 0, costUsd: 0, error: "no current model" };
	const rawMsgs = prefix
		.filter((b) => b.kind !== "summary")
		.map((b) => {
			const msg = b.raw && !(b.edited && !b.ours) ? b.raw : b.msg; // unfolded originals
			if (intent && b.kind === "user") {
				// The summariser reads the user's message as it was: a Pi `<skill>` expansion is not resident-view compression, and the
				// constraints a skill carries are exactly what the durable prose and the state have to keep. Only the summary's own
				// request rows show `/skill:name` (lossy resident view, recallable by handle).
				return msg;
			}
			if (!intent || !b.entryId || (b.kind !== "assistant" && (b.kind !== "toolResult" || msg.toolName === RECALL_TOOL))) return msg;
			const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: textOf(msg.content) }];
			const role = b.kind === "assistant" ? "assistant" : "tool output";
			return { ...msg, content: [{ type: "text", text: `[${role} source: ${handleFor(b.entryId)}]` }, ...content] };
		});
	const { messages: msgs } = reasoningInput(rawMsgs);
	let conv: string;
	try {
		conv = await serialize(msgs);
	} catch (err) {
		return { text: null, ok: false, ms: Date.now() - t0, costUsd: 0, error: err instanceof Error ? err.message : String(err) };
	}
	const w = epochWords(budgetTokens);
	const previous = clipActive(previousActive, ACTIVE_INPUT_TOKENS * 4 - 80);
	const prompt =
		(previous ? `<previous-active-state>\n${previous}\n</previous-active-state>\n\n` : "") +
		(intent?.previous.length ? `<previous-intent>\n${intent.previous.map((q) => `- "${q}"`).join("\n")}\n</previous-intent>\n\n` : "") +
		`<conversation>\n${conv}\n</conversation>\n\n` +
		`Write the NARRATIVE part of a context summary for this conversation slice. It is the newest increment of a longer session: earlier increments ` +
		`are summarised already and kept as immutable epochs, so summarize ONLY what this conversation slice accomplished. A separate deterministic ` +
		`section already lists the user's requests, files touched, commands with exit codes and errors, so do NOT repeat those. When you refer to a ` +
		`specific tool output, name it by its tool and exact command or path (a finding that rests on an output must name it this way: the ` +
		`summary keeps the outputs its findings name) so that look-alike runs stay distinguishable; never merge similar runs ` +
		`into one. Output format:\n` +
		`---DECISIONS---\n` +
		`(durable: any architecture decisions, rationale, design choices, API contracts, user constraints or rulings, root causes found, and durable ` +
		`facts settled in this slice — exact values, paths, identifiers, results later work depends on; <= ${w.durable} words; write (none) if none)\n` +
		`---ACTIVE---\n` +
		`(volatile: reconcile the previous active state with this slice. Carry forward every still-open todo, next step and blocker, even if not ` +
		`mentioned in this slice. Remove an item only when this slice provides evidence that it was completed or superseded; silence is not completion. ` +
		`Update changed status and add new open work. Write each open todo, next step and blocker as its own line starting with "- [ ] ", ` +
		`before the other state lines; to stay in budget, shorten wording and merge related items rather than drop one. ` +
		`Do not copy the previous active state into DECISIONS. <= ${w.active} words)\n` +		(intent
			? `---INTENT---\n` +
				`(the user's own words that state what the user wants now: copy each quote character for character from a user message in this ` +
				`conversation slice or from <previous-intent>, keeping a previous one only while it still applies; one per line as - "exact words"; ` +
				`at most 6; never quote assistant text or tool output; write (none) if none)\n` +
				`---COMMITMENTS---\n` +
				`(select at most 4 explicit commitments by the assistant to perform work. A prediction about software behavior, quoted text, ` +
				`or a description of completed work is not a commitment. Select by meaning in any language, not keywords. ` +
				`Use only visible assistant text from this slice, never reasoning, user text or tool output. ` +
				`Each line must be JSON: {"sourceHandle":"the message's assistant source label","quote":"exact source words"}. ` +
				`Quotes must be complete statements, at most 200 characters each; omit any that cannot fit without changing meaning. ` +
				`Do not invent source labels or paraphrase quotes. Write (none) if none.)\n` +
				`---EVIDENCE---\n` +
				`(select at most 8 tool results that support your retained findings, final verification results or still-open blockers. ` +
				`Prefer the final verification for each distinct scope over intermediate attempts; a later narrow check does not replace a broader one. ` +
				`A nonzero exit alone does not prove an unresolved blocker. Omit routine edit acknowledgements and exploratory source reads unless ` +
				`a retained finding depends on their exact output. Each line must be JSON: {"sourceHandle":"the tool output source label",` +
				`"quote":"exact evidence span, at most 200 characters"}. Quote the decisive result (such as the final test totals), ` +
				`not a command header. Use only tool output in this slice, never assistant claims, reasoning or user text. ` +
				`Do not invent sources or paraphrase quotes. Write (none) if none.)\n`
			: "") +
		`Be concrete and keep exact paths, names and numbers. Stay under about ${w.durable + w.active} words in all. Do not call tools.\n\n` +
		REASONING_QUALIFICATION;
	const r = await complete(ctx, prompt, ownSignal);
	if (!r.ok || !r.text) return { ...r, ms: Date.now() - t0 };
	return { ...r, ms: Date.now() - t0, ...parseNarrativeReply(r.text) };
}

/** Emit v3 by default, or v2 with its bounded epoch narrative. The legacy skeleton is used only to preserve v2 call budgeting. */
export async function buildCut(p: PlanResult, ctx: Any, signal?: AbortSignal): Promise<Cut> {
	// Only v2 and v3 are emitted. Older summaries remain readable for migration.
	const format = (p as Any).summaryFormat ?? (process.env.PI_ZIP_SUMMARY_V2 === "1" ? "v2" : "v3");
	if (format !== "v2") return buildCutV3(p, ctx, signal);
	const { foldMin, keepLines } = settings();
	const t0 = performance.now();
	const prefix = p.blocks.slice(0, p.cutIdx!);
	const prev = prefix[0]?.kind === "summary" ? String(prefix[0].msg.summary ?? "") || null : null;
	const prevParsed = parseSummary(prev);
	const slice = prefix.filter((b) => b.kind !== "summary");
	const aliases = cdAliases(bashCommands(slice), prevParsed.cmdAliases);
	const texts: string[] = [];
	const keyLists: string[][] = [];
	const rows: HandleRow[] = prefix
		.filter((b) => b.kind === "toolResult" && b.entryId && (b.ours || b.tokens > foldMin))
		.map((b) => {
			const call = callOf(p.calls, b.msg);
			const out = textOf((b.raw ?? b.msg).content);
			const keys = keyTexts(out, keepLines);
			const tool = call?.name ?? b.msg.toolName ?? "tool";
			const hint = keys[0] ?? "";
			texts.push(out);
			keyLists.push(keys);
			return { handle: handleFor(b.entryId!), tool, args: call ? shortArgs(call.args, undefined, aliases) : "", turn: b.userTurn, at: blockTime(b), outcome: outcomeHint(out, tool, !!b.msg.isError), hint };
		});
	// rows of one tool that would show the same key line (the first line of every status report, say): each shows the first of its
	// lines that none of the others has, nor a row of that tool the previous summary's table already shows
	const prevHints = new Map<string, string[]>();
	for (const l of prevParsed.table.items) {
		const m = TABLE_ROW.exec(l);
		if (m) prevHints.set(m[2], [...(prevHints.get(m[2]) ?? []), (m[5] ?? "").split(" · ").pop() ?? ""]);
	}
	const same = new Map<string, number[]>();
	rows.forEach((r, i) => same.set(`${r.tool}\u0000${clip(r.hint, 90)}`, [...(same.get(`${r.tool}\u0000${clip(r.hint, 90)}`) ?? []), i]));
	for (const ix of same.values()) {
		const { tool, hint } = rows[ix[0]];
		const taken = prevHints.get(tool) ?? [];
		if (ix.length < 2 && !taken.includes(clip(hint, 90))) continue;
		const hs = distinctLines(ix.map((i) => texts[i]), ix.map((i) => keyLists[i]), taken, 90);
		ix.forEach((i, k) => hs[k] && (rows[i].hint = hs[k]!));
	}
	const file = p.fileRecall; // zip_recall hidden by an allowlist: the summary names the recall files instead
	const table = handleTable(rows, prev, file);
	// a previous summary that is not pi-zip's has no request list: its requests are quoted again from the session branch
	const earlier = prev && !prevParsed.structured
		? earlierRequests(attempt(() => ctx?.sessionManager?.getBranch?.() ?? [], []), slice.find((b) => b.entryId)?.entryId, file) ?? undefined
		: undefined;
	const sk = skeleton(slice, prev, table ?? "", file, earlier);
	const nb = clamp(p.summaryTokensPlanned - tok4(sk.text), 300, NARRATIVE_MAX);
	const prevAt = prefix[0]?.kind === "summary" ? Number(prefix[0].msg.timestamp) || 0 : 0;
	const prevReq = earlier ? earlier.length : lastRequestNo(prevParsed.users);
	const prevStruct = prevParsed.epochs ?? legacyNarrative(prev, prevAt, prevReq);
	const prevWhen = prevParsed.narrativeAt ?? prevStruct.activeAt ?? (prevAt > 0 ? fmtWhen(prevAt) : undefined);
	let lastAt = 0;
	for (const b of slice) {
		const bt = blockTime(b);
		if (bt && bt > lastAt) lastAt = bt;
	}
	const nowWhen = lastAt > 0 ? fmtWhen(lastAt) : undefined;
	const mergeWork = p.mergeWork ?? estimateMergeWork(prev, nb, p.scale?.c ?? 1, ctx.model);
	const predictedMergeCostUsd = (mergeWork.inputTokens * (Number(ctx.model?.cost?.input) || 0) + mergeWork.outputTokens * (Number(ctx.model?.cost?.output) || 0)) / 1e6;
	const prevV2 = parseSummaryV2(prev);
	const nar = await narrative(prefix, ctx, nb, signal, prevStruct.activeState, { previous: prevV2?.intents.map((x) => x.quote) ?? [] });
	let costUsd = nar.costUsd, actualMergeCostUsd = 0;
	let usage = nar.usage;
	const cwd = ctx?.cwd ?? ".";
	const w = epochWords(nb);
	const durable = nar.ok && nar.text ? clipPart(nar.durable ?? prose(nar.text), w.durable) : NONE_ROW;
	const active = nar.ok && nar.text ? clipActive(nar.active || prevStruct.activeState, activeChars(w.active)) : prevStruct.activeState;
	const intents: IntentProposal[] | undefined = nar.ok && nar.intent ? nar.intent.map((quote) => ({ quote, role: "user" })) : undefined;
	const prep = prepareEpochV2({
		prefix: slice,
		previous: prev,
		branch: attempt(() => ctx?.sessionManager?.getBranch?.() ?? [], []),
		cwd,
		activeState: active,
		...(nar.ok && nowWhen ? { activeAt: nowWhen } : prevWhen ? { activeAt: prevWhen } : {}),
		...(!nar.ok ? { activeStale: clip(nar.error ?? "n/a", 120) } : {}),
		durableProse: durable,
		...(intents ? { proposedIntents: intents } : {}),
		...(nar.ok && nar.commitments ? { proposedCommitments: nar.commitments } : {}),
		...(nar.ok && nar.evidence ? { proposedEvidence: nar.evidence } : {}),
		timestamp: nowWhen ?? "time unknown",
	});
	// only the prose of old epochs is merged by the model; their requests and evidence are joined by code (regroupEpochsV2)
	const capV2 = epochCap(nb);
	let blocks = prep.state.epochs.map((e) => e.block);
	if (nar.ok) {
		const cons = await consolidateEpochs(blocks, ctx, capV2, signal);
		actualMergeCostUsd = cons.costUsd;
		costUsd += cons.costUsd;
		usage = addUsage(usage, cons.usage);
		blocks = cons.epochs;
	}
	prep.state.epochs = regroupEpochsV2(prep.state.epochs, boundEpochs(blocks, capV2));
	// soft: the size this plan priced; hard: the most the compacted view can take and still fit the model's room
	const v2 = renderEpochSummaryV2(prep, { soft: p.summaryTokensPlanned, hard: p.summaryRoomTokens ?? Infinity, file });
	return {
		firstKeptEntryId: p.blocks[p.cutIdx!].entryId!,
		text: v2.text,
		trigger: p.sumTrigger ?? "cold",
		count: v2.diagnostics.requestCount,
		prefixTokens: p.prefixTokens,
		summaryTokens: tok4(v2.text),
		llmOk: nar.ok,
		llmError: nar.error ?? null,
		costUsd,
		...(mergeWork.merges > 0 ? { predictedMergeCostUsd, actualMergeCostUsd } : {}),
		usage,
		ms: Math.round(performance.now() - t0),
		...(v2.reason ? { reason: v2.reason, overflow: v2.overflow } : {}),
		summaryDiagnostics: v2.diagnostics as unknown as Record<string, unknown>,
	};
}
