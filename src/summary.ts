// Summary (F11, F12): deterministic skeleton (user words verbatim + files/commands) + model-written narrative + handle table.
// Thinking is never quoted or paraphrased: it is stripped before the model sees the prefix.
import { randomUUID } from "node:crypto";
import { blockTime, cdDirOf, clipMid, distinctLines, handleFor, keyTexts, outcomeHint, RECALL_TOOL, shortArgs, strippableCdDirs, whenLabel } from "./placeholder.ts";
import { type Block, type Cut, type PlanResult, NARRATIVE_CALL_MAX, NARRATIVE_MAX, settings, toolCallIndex } from "./plan.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { type Any, attempt, clamp, clip, envInt, fmtWhen, reasonsByDefault, textOf, tok4 } from "./util.ts";

export const SUMMARY_MARK = "[summary of earlier conversation by pi-zip]";
const POLICY_BLOCK_RE = /violate|terms of service|usage polic|content polic|acceptable use/i;
const CAP_ERR = "narrative hit the token cap";
const NARRATIVE_SYSTEM =
	"You are a context summarization assistant. Read the conversation and write ONLY the requested summary sections. " +
	"Do NOT continue the conversation, do NOT answer questions in it, do NOT call tools.";

export interface HandleRow {
	handle: string;
	tool: string;
	args: string;
	hint: string;
	turn?: number; // user turn of the output, so look-alike runs stay apart (shown only without `at`)
	at?: number; // when the output arrived (ms), shown as MM-DD HH:MM UTC
	outcome?: string; // exit status / test counts (outcomeHint)
}

const TABLE_HEAD = "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)";
/** The same heading when zip_recall is hidden and the originals are read from recall files (parseSummary keys on "## Folded outputs"). */
const tableHead = (file?: FileRecall) => (file ? `## Folded outputs (originals in ${file.dir}/<handle>.txt; handles stay valid after later summaries or compaction)` : TABLE_HEAD);
/** The folded-outputs table: newest rows (eval-chosen with the BUDGET below, research round5/sumfmt.md). */
export const TABLE_ROWS = envInt("SUM_TABLE_ROWS", 30);
const when = (r: { at?: number; turn?: number; when?: string }) => { const w = r.when ?? whenLabel(r.at, r.turn); return w ? ` · ${w}` : ""; };
const tableLine = (r: HandleRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${when(r)}${r.outcome ? ` · ${r.outcome}` : ""} · ${clip(r.hint, 90)}`;

/**
 * Compact table appended to every summary so handles survive it: this prefix's rows merged with the rows of the previous summary's
 * table(s) (hints and outcomes kept), newest TABLE_ROWS rows, each handle once, and a count of the older rows left out.
 */
export function handleTable(rows: HandleRow[], previous: string | null = null, file?: FileRecall): string | null {
	const prev = parseSummary(previous);
	const merged = mergeItems(prev.table.items, rows.map(tableLine), prev.table.omitted, TABLE_ROWS, Infinity, (l) => TABLE_ROW.exec(l)?.[1]);
	if (!merged.kept.length) return null;
	const lines = merged.omitted ? [`[… ${merged.omitted} older folded outputs omitted from this table …]`, ...merged.kept] : merged.kept;
	return tableHead(file) + "\n" + lines.join("\n");
}

/** Keep the newest `n` lines and say how many older ones were left out (never a silent drop). */
const newest = (xs: string[], n: number): string[] => (xs.length > n ? [`[… ${xs.length - n} older omitted …]`, ...xs.slice(-n)] : xs);

const H = "[0-9a-z]{10}"; // a handle, see handleFor
/** Row time: UTC for new rows, with local times and turn numbers accepted from older persisted summaries. */
const W = "turn \\d+|\\d\\d-\\d\\d \\d\\d:\\d\\d(?: UTC)?";
const CMD_ROW = new RegExp(`^\`(.*)\` -> [^(]*\\((${W}), (${H})\\)$`);
const OTHER_ROW = new RegExp(`^(\\S+) (.*) \\((${W}), (${H})\\)$`);
const FILE_ROW = /^- (.*) \(([^()]*)\)$/;
const FILE_OP = new RegExp(`^(\\S+): (${H})$`);
const TABLE_ROW = new RegExp(`^- (${H}) · (\\S+)((?: [^·]*?)?)(?: · (${W}))?(?: · (.*))?$`);
const INDEX_HEAD = "## Handle index";
/** Budget of the "Handle index" section, in tokens. */
export const INDEX_TOKENS = envInt("SUM_INDEX_TOKENS", 2500);

interface IndexRow {
	handle: string;
	tool: string;
	args: string;
	turn?: number;
	at?: number;
	when?: string; // the time label as an earlier summary wrote it (UTC, or an older local time / turn number)
	hint?: string; // only for rows that would otherwise read the same: the first line of the output that tells it apart
}
const INDEX_HINT = 50;

const indexLine = (r: IndexRow) => `- ${r.handle} · ${r.tool}${r.args ? " " + r.args : ""}${when(r)}${r.hint ? ` · ${clip(r.hint, INDEX_HINT)}` : ""}`;

/**
 * Handle rows (oldest first) recorded in an earlier summary, read from every section that carries them: the commands, files and
 * other-calls lists, the folded-outputs table and an earlier handle index. Works on the whole text, nested carried-forward blocks
 * included, so the clip applied to the carried-forward text cannot lose them.
 */
export function handleRowsOf(text: string | null): IndexRow[] {
	const rows: IndexRow[] = [];
	let sec = "";
	for (const line of (text ?? "").split("\n")) {
		if (line.startsWith("## ")) {
			sec = line;
			continue;
		}
		let m: RegExpExecArray | null;
		if (sec.startsWith("## Commands run")) {
			if ((m = CMD_ROW.exec(line))) rows.push({ handle: m[3], tool: "bash", args: m[1], when: m[2] });
		} else if (sec.startsWith("## Other tool calls")) {
			if ((m = OTHER_ROW.exec(line))) rows.push({ handle: m[4], tool: m[1], args: m[2], when: m[3] });
		} else if (sec.startsWith("## Files touched")) {
			if ((m = FILE_ROW.exec(line)))
				for (const op of m[2].split(", ")) {
					const h = FILE_OP.exec(op);
					if (h) rows.push({ handle: h[2], tool: h[1], args: m[1] });
				}
		} else if (sec.startsWith("## Folded outputs") || sec.startsWith(INDEX_HEAD)) {
			// an index row keeps the line that tells it apart; a table row's tail (outcome, key line) stays in the table
			if ((m = TABLE_ROW.exec(line))) rows.push({ handle: m[1], tool: m[2], args: m[3].trim(), ...(m[4] ? { when: m[4] } : {}), ...(m[5] && sec.startsWith(INDEX_HEAD) ? { hint: m[5] } : {}) });
		}
	}
	return rows;
}

/**
 * Handles of the tool results the summary would otherwise lose: this prefix's results and the earlier summary's rows, newest first,
 * minus handles already written elsewhere in the summary, under a token budget. Says how many rows did not fit.
 */
function handleIndex(now: IndexRow[], previous: string | null, listed: string, budgetTokens: number, file?: FileRecall): string | null {
	const seen = new Set<string>(listed.match(new RegExp(`\\b${H}\\b`, "g")) ?? []);
	const rows: IndexRow[] = [];
	for (const r of [...now].reverse().concat(handleRowsOf(previous).reverse())) {
		if (seen.has(r.handle)) continue;
		seen.add(r.handle);
		rows.push({ ...r, args: clipMid(r.args, 60) });
	}
	if (!rows.length) return null;
	const head = `${INDEX_HEAD} (older outputs, newest first; ${file ? `${file.dir}/<handle>.txt holds the original` : "zip_recall with a handle returns the original"})`;
	let used = tok4(head) + 12; // 12: the "not listed" line
	const lines: string[] = [];
	for (const r of rows) {
		const l = indexLine(r);
		if (used + tok4(l) + 1 > budgetTokens) break;
		used += tok4(l) + 1;
		lines.push(l);
	}
	if (lines.length < rows.length) lines.push(`[… ${rows.length - lines.length} older handles not listed …]`);
	return head + "\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Sectioned carry-forward. A summary is parsed into its sections; each section of the previous summary is merged with the same
// section of the new prefix, deduplicated, and the OLDEST items are dropped first under a per-section budget, with a running
// count of what was left out. (The earlier design clipped the whole carried text to its first 12,000 characters, which kept the
// oldest nested content and cut the newest requests and handles.)
// ---------------------------------------------------------------------------------------------------------------
interface Items {
	items: string[]; // oldest first
	omitted: number; // older items already left out by earlier merges
	nums?: number[]; // user requests: the number each item was written with (1 = the session's first request), when the format says
}
interface FileRow {
	path: string;
	ops: Map<string, string | null>; // tool -> handle of its latest result
}
export interface ParsedSummary {
	structured: boolean; // at least one section of our own format was found (false: a native Pi compaction summary, free text)
	users: Items;
	files: { rows: FileRow[]; omitted: number };
	cmds: Items;
	others: Items;
	errors: Items;
	table: Items;
	narrative: string[]; // model-written text and free text, oldest first
	narrativeAt?: string; // a narrative carried forward unchanged (its call failed) says when it was written
	epochs?: StructuredNarrative; // the narrative in the append-only format (current state + epochs); absent for older formats and free text
	cmdDirs: string[]; // the shared `cd <dir>` prefixes the command rows leave out (oldest first)
}

const SECTIONS: Array<[RegExp, string]> = [
	[/^## User requests/, "users"],
	[/^## Files touched/, "files"],
	[/^## Commands run/, "cmds"],
	[/^## Other tool calls/, "others"],
	[/^## Errors/, "errors"],
	[/^## Handle index/, "index"],
	[/^## Folded outputs/, "table"],
	[/^## Narrative/, "narr"],
	[/^## Earlier narrative/, "narr"],
	[/^## Earlier summary/, "free"], // the carried-forward block of the older format
];
/** Heading written for the user section. Its request bodies indent every continuation line by USER_INDENT, so a numbered list or a `## ` heading inside a request cannot be taken for an item or section start. Older summaries have no such marker and are parsed heuristically. */
const USERS_HEAD = "## User requests (verbatim, oldest first, continuation lines indented)";
/** Heading once older requests in the middle are shortened (USERS budget): those lines start with SHORT_MARK. */
const USERS_HEAD_SHORT = "## User requests (oldest first, continuation lines indented; the first and the newest verbatim, lines starting with ≈ shortened to their start)";
const SHORT_MARK = "≈ ";
/** The omission marker of a long request names its handle after this text (requestText); a shortened line keeps that handle. */
const OMITTED_REQ_HANDLE = " (handle ";
const OMITTED_REQ_RE = /\[… middle of this request omitted \(handle ([0-9a-z]{10})\)/;
const shortHandle = (t: string): string => {
	const h = OMITTED_REQ_RE.exec(t)?.[1];
	return h ? ` (whole request: handle ${h})` : "";
};
const USER_INDENT = "   ";
const OMIT_ROW = /^\[… (\d+) [^\]]*?(?:omitted|not listed)[^\]]*…\]$/;
const COVERS_ROW = /^Covers \d+ earlier messages\./;
const NONE_ROW = "(none)";
/** Heading of a previous narrative carried forward unchanged because the call for a new one failed (buildCut). */
const narrCarriedHead = (at: string | undefined, why: string) => `## Narrative (carried forward from the summary of ${at ?? "an earlier time"}; possibly stale: a new one could not be written: ${why})`;
/** The commands heading names the shared `cd <dir>` prefixes its rows leave out. */
const cmdsHead = (dirs: string[]) => `## Commands run (with exit status${dirs.length ? `; a leading "cd <dir> &&" is left out for: ${dirs.join(", ")}` : ""})`;
const CMD_DIRS_RE = /^## Commands run \(.*; a leading "cd <dir> &&" is left out for: (.*)\)$/;
const NARR_CARRIED_RE = /^## Narrative \(carried forward from the summary of ([^;]+);/;

/** Parse any summary text: pi-zip's current and older formats (carried-forward blocks nested inside carried-forward blocks included), or free text. */
export function parseSummary(text: string | null): ParsedSummary {
	const out: ParsedSummary = { cmdDirs: [], structured: false, users: { items: [], omitted: 0 }, files: { rows: [], omitted: 0 }, cmds: { items: [], omitted: 0 }, others: { items: [], omitted: 0 }, errors: { items: [], omitted: 0 }, table: { items: [], omitted: 0 }, narrative: [] };
	if (!text) return out;
	// occurrences in text order; in the older nested format the nested (older) copy of a section comes first, so order = oldest first
	const occ: Array<{ key: string; lines: string[]; indented?: boolean }> = [{ key: "free", lines: [] }];
	for (const line of text.split("\n")) {
		if ((line.trim() === SUMMARY_MARK && !/^\s/.test(line)) || COVERS_ROW.test(line)) continue;
		const hit = line.startsWith("## ") ? SECTIONS.find(([re]) => re.test(line)) : undefined;
		if (hit) {
			const at = NARR_CARRIED_RE.exec(line);
			if (at) out.narrativeAt = at[1];
			const dirs = CMD_DIRS_RE.exec(line);
			if (dirs) out.cmdDirs.push(...dirs[1].split(", ").filter((d) => d && !out.cmdDirs.includes(d)));
			occ.push({ key: hit[1], lines: [], indented: hit[1] === "users" && (line.trim() === USERS_HEAD || line.trim() === USERS_HEAD_SHORT) });
			if (hit[1] !== "free" && hit[1] !== "narr") out.structured = true;
			continue;
		}
		occ[occ.length - 1].lines.push(line);
	}
	const files = new Map<string, FileRow>();
	for (const { key, lines, indented } of occ) {
		const body = lines.filter((l) => l.trim() !== "" && l.trim() !== NONE_ROW);
		if (key === "users") {
			const r = indented ? parseIndentedUsers(lines) : parseUsers(lines);
			// numbers: as written (current format), else counted (older formats: the omitted ones come first, numbering is continuous)
			const base = out.users.omitted + out.users.items.length + r.omitted;
			const nums = r.nums ?? r.items.map((_, i) => base + i + 1);
			out.users.nums = [...(out.users.nums ?? out.users.items.map((_, i) => i + 1)), ...nums];
			out.users.items.push(...r.items);
			out.users.omitted += r.omitted;
			continue;
		}
		const take = (dst: Items, keep: (l: string) => boolean) => {
			for (const l of body) {
				const m = OMIT_ROW.exec(l);
				if (m) dst.omitted += Number(m[1]);
				else if (keep(l)) dst.items.push(l);
			}
		};
		if (key === "files") {
			for (const l of body) {
				const m = OMIT_ROW.exec(l);
				if (m) { out.files.omitted += Number(m[1]); continue; }
				const f = FILE_ROW.exec(l);
				if (!f) continue;
				const ops = new Map<string, string | null>(files.get(f[1])?.ops ?? []);
				for (const op of f[2].split(", ")) {
					const h = FILE_OP.exec(op);
					if (h) ops.set(h[1], h[2]);
					else if (op.trim() && !ops.has(op.trim())) ops.set(op.trim(), null);
				}
				files.delete(f[1]);
				files.set(f[1], { path: f[1], ops });
			}
		} else if (key === "cmds") take(out.cmds, (l) => l.startsWith("`"));
		else if (key === "others") take(out.others, () => true);
		else if (key === "errors") take(out.errors, (l) => l.startsWith("- "));
		else if (key === "table") take(out.table, (l) => TABLE_ROW.test(l));
		else if (key === "narr" || key === "free") {
			const t = lines.join("\n").trim();
			if (t && !t.startsWith("(unavailable")) {
				out.narrative.push(t);
				const s = key === "narr" ? parseEpochNarrative(t) : null;
				if (s) out.epochs = s;
			}
		}
	}
	out.files.rows = [...files.values()];
	return out;
}

/** Current format: an unindented `N. ` line starts a request, indented lines continue it (number values are ignored: they are display only). */
function parseIndentedUsers(lines: string[]): Items {
	const out: Items = { items: [], omitted: 0, nums: [] };
	let cur: string[] | null = null;
	let num = 0;
	const close = () => {
		const t = cur?.join("\n").replace(/\s+$/, "");
		if (t && t !== NONE_ROW) out.items.push(t), out.nums!.push(num);
		cur = null;
	};
	for (const line of lines) {
		const om = OMIT_ROW.exec(line);
		if (om && /requests omitted/.test(line)) {
			close();
			out.omitted += Number(om[1]);
			continue;
		}
		const m = /^(\d+)\. (.*)$/.exec(line);
		if (m) {
			close();
			num = Number(m[1]);
			cur = [m[2]];
		} else if (cur) cur.push(line.startsWith(USER_INDENT) ? line.slice(USER_INDENT.length) : line.trim() === "" ? "" : line);
	}
	close();
	return out;
}

/** Older format: numbered, possibly multi-line requests, heuristic. Numbers run 1, 2, 3...; after an omission marker (or a gap in the older format) any larger number resumes. */
function parseUsers(lines: string[]): Items {
	const out: Items = { items: [], omitted: 0 };
	let cur: string[] | null = null;
	let last = 0;
	let anyNumber = true;
	const close = () => {
		if (cur) out.items.push(cur.join("\n").replace(/\s+$/, ""));
		cur = null;
	};
	for (const line of lines) {
		const om = OMIT_ROW.exec(line);
		if (om && /requests omitted/.test(line)) {
			close();
			out.omitted += Number(om[1]);
			anyNumber = true;
			continue;
		}
		const m = /^(\d+)\. (.*)$/.exec(line);
		if (m && (anyNumber ? Number(m[1]) > last || last === 0 : Number(m[1]) === last + 1)) {
			close();
			cur = [m[2]];
			last = Number(m[1]);
			anyNumber = false;
		} else if (cur) cur.push(line);
	}
	close();
	out.items = out.items.filter((t) => t !== NONE_ROW && t !== "");
	return out;
}

/**
 * older + newer, oldest first. Deduplicated by `key` (default: the item itself; the newest copy wins and keeps the newest position;
 * `null` = no dedup, for repeated user requests), then the newest items that fit `maxItems` and `maxChars` are kept (always at least the newest one). `omitted` counts every older
 * item left out so far, this merge's drops included.
 */
function mergeItems(older: string[], newer: string[], omitted: number, maxItems: number, maxChars: number, key: ((s: string) => string | undefined) | null = (s) => s): { kept: string[]; omitted: number } {
	let all = [...older, ...newer];
	if (key) {
		const seen = new Set<string>();
		all = all.reverse().filter((x) => { const k = key(x) ?? x; return seen.has(k) ? false : (seen.add(k), true); }).reverse();
	}
	let from = all.length;
	let used = 0;
	while (from > 0 && all.length - from < maxItems && used + all[from - 1].length + 1 <= maxChars) used += all[--from].length + 1;
	if (from === all.length && all.length) from--; // the newest item always stays
	return { kept: all.slice(from), omitted: omitted + from };
}

/** Every bash command of these blocks, in order. */
const bashCommands = (blocks: Block[]): string[] =>
	blocks.flatMap((b) => (b.kind === "assistant" ? (b.msg.content ?? []).filter((c: Any) => c?.type === "toolCall" && c.name === "bash").map((c: Any) => String(c.arguments?.command ?? "")) : []));

/** Per-section budgets (characters unless noted); the total stays near the old design's 12,000-char carry plus the new prefix's own lists. */
export const BUDGET = {
	users: envInt("SUM_USERS", 4000), // the newest requests, verbatim
	usersFirst: envInt("SUM_USERS_FIRST", 3000), // the session's first requests (they define the task), verbatim, while they fit
	usersShort: envInt("SUM_USERS_SHORT", 1000), // the requests between, one shortened line each (SHORT_CHARS), newest first while they fit; the rest are counted
	files: envInt("SUM_FILES", 6000),
	cmds: envInt("SUM_CMDS", 5000),
	cmdChars: envInt("SUM_CMD_CHARS", 80), // one command row's command, clipped in the middle
	others: envInt("SUM_OTHERS", 3000),
	errors: envInt("SUM_ERRORS", 2000),
	lines: envInt("SUM_LINES", 60),
	errorLines: envInt("SUM_ERROR_LINES", 8),
};
export const FIRST_REQUESTS = 2; // at most this many of the session's first requests are kept verbatim (BUDGET.usersFirst)
export const SHORT_CHARS = 100;

/**
 * User requests, previous (older) then new, numbered over the whole session: the first requests (numbers 1..FIRST_REQUESTS, while
 * they fit usersFirst) and the newest (users) verbatim; the ones between shortened to one line (usersShort, newest first); the rest
 * counted. A request already shortened stays as it is.
 */
function mergeUsers(prev: Items, now: string[]): { lines: string[]; omitted: number } {
	const pn = prev.nums ?? prev.items.map((_, i) => prev.omitted + i + 1);
	const last = Math.max(prev.omitted + prev.items.length, pn.at(-1) ?? 0);
	const all = [...prev.items.map((t, i) => ({ t, n: pn[i] })), ...now.map((t, i) => ({ t, n: last + i + 1 }))];
	const keep = new Map<number, string>(); // index in all -> line text
	let used = 0;
	for (let i = 0; i < all.length && all[i].n <= FIRST_REQUESTS && !all[i].t.startsWith(SHORT_MARK); i++) {
		if (used + all[i].t.length + 1 > BUDGET.usersFirst) break;
		used += all[i].t.length + 1;
		keep.set(i, all[i].t);
	}
	used = 0;
	let k = all.length - 1;
	for (; k >= 0 && !keep.has(k); k--) {
		if (all[k].t.startsWith(SHORT_MARK) || (used + all[k].t.length + 1 > BUDGET.users && k < all.length - 1)) break; // the newest always stays
		used += all[k].t.length + 1;
		keep.set(k, all[k].t);
	}
	used = 0;
	for (; k >= 0 && !keep.has(k); k--) {
		const l = all[k].t.startsWith(SHORT_MARK) ? all[k].t : SHORT_MARK + clip(all[k].t, SHORT_CHARS) + shortHandle(all[k].t);
		if (used + l.length + 8 > BUDGET.usersShort) break;
		used += l.length + 8;
		keep.set(k, l);
	}
	// gaps by number: what this merge leaves out and what earlier summaries already left out alike
	const lines: string[] = [];
	let at = 0;
	for (const i of [...keep.keys()].sort((a, b) => a - b)) {
		const gap = all[i].n - at - 1;
		if (gap > 0) lines.push(`[… ${gap} older requests omitted …]`);
		lines.push(`${all[i].n}. ${keep.get(i)!.replace(/\n/g, "\n" + USER_INDENT)}`);
		at = all[i].n;
	}
	return { lines, omitted: Math.max(0, (all.at(-1)?.n ?? 0) - keep.size) };
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
	timestamp: string; // when its part of the conversation ended (local MM-DD HH:MM), a range once consolidated
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
	activeAt?: string; // when it was written (local MM-DD HH:MM)
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

/** The previous summary's narrative a migration reads is at most PREV_NARRATIVE_CHARS: a longer one (Pi's own free-text summary, an
 *  older summary's narrative and its earlier excerpt) is kept as its head and its tail, so nothing it carries can grow. */
export const PREV_NARRATIVE_CHARS = 12_000;

function excerpt(text: string, max: number, head = 0): string {
	if (text.length <= max) return text;
	const cutAtLine = (t: string) => {
		const nl = t.indexOf("\n"); // start on a line boundary, else on a word boundary: never mid-word
		if (nl >= 0 && nl < 200) return t.slice(nl + 1);
		const sp = t.indexOf(" ");
		return sp >= 0 && sp < 40 ? t.slice(sp + 1) : t;
	};
	const h = head ? text.slice(0, head).replace(/\s+\S*$/, "") : "";
	const t = cutAtLine(text.slice(-(max - h.length)));
	return (h ? h + "\n" : "") + "[… middle of the narrative omitted …]\n" + t;
}

/** The narrative part of a previous summary in an older format (or free text). */
export interface PrevNarrative {
	text: string; // bounded by PREV_NARRATIVE_CHARS
	foreign: boolean; // the previous summary is free text (Pi's own compaction or another extension's), not pi-zip's sections
	at?: string; // when it was written (MM-DD HH:MM UTC, or a persisted older label), if known
}

/**
 * The previous summary's narrative only (not its lists): the model-written sections of pi-zip's summary (an older summary's carried
 * excerpt included), or the whole text of a free-text summary. null: none. `at` = the previous summary's timestamp (ms), used when
 * the text does not say when its narrative was written. A narrative in an older format becomes Epoch 0 of the next one (legacyNarrative).
 */
export function previousNarrative(text: string | null, at?: number, maxChars = PREV_NARRATIVE_CHARS): PrevNarrative | null {
	const p = parseSummary(text);
	const t = p.narrative.join("\n\n").trim();
	if (!t) return null;
	const when = p.narrativeAt ?? p.epochs?.activeAt ?? (at && at > 0 ? fmtWhen(at) : undefined);
	const max = Math.min(maxChars, PREV_NARRATIVE_CHARS);
	return { text: excerpt(t, max, Math.floor(max / 4)), foreign: !p.structured, ...(when ? { at: when } : {}) };
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
function prose(t: string): string {
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

const MARK_LINE = /^[\s#*_>`-]*(DECISIONS|ACTIVE)\b[\s#*_:`-]*$/i;
const ACTIVE_TOPIC = /current state|state of the work|open todo|todos|next step|blocker|in.flight|active|status/i;
/**
 * The two parts of a narrative reply: decisions and durable facts, and the current state and open todos. Reads the marker lines the
 * prompt asks for; a reply without them is split by its headings (the older four headings included); a reply with neither is all durable.
 */
export function parseNarrativeReply(text: string): { durable: string; active: string } {
	const lines = text.split("\n");
	const d: string[] = [], a: string[] = [];
	const marked = lines.some((l) => MARK_LINE.test(l));
	let cur = d;
	for (const l of lines) {
		const m = MARK_LINE.exec(l);
		if (marked) {
			if (m) cur = m[1].toUpperCase() === "ACTIVE" ? a : d;
			else cur.push(l);
			continue;
		}
		const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
		if (h) cur = ACTIVE_TOPIC.test(h[1]) ? a : d;
		cur.push(l);
	}
	const none = (t: string) => (!t || /^\(?none\.?\)?\.?$/i.test(t) ? NONE_ROW : t);
	return { durable: none(prose(d.join("\n"))), active: prose(a.join("\n")) };
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
function legacyNarrative(prev: string | null, prevAt: number, lastReq: number): StructuredNarrative {
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
	return reasonsByDefault(model) || (!!model?.reasoning && lowEffort.has(`${model.provider ?? ""}/${model.id ?? ""}`));
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

/** Token usage of two calls added up (cost included). */
function addUsage(a: Any, b: Any): Any {
	if (!b) return a;
	const out: Any = a ? { ...a, cost: { ...(a.cost ?? {}) } } : { cost: {} };
	const { cost, ...tokens } = b;
	for (const [k, v] of Object.entries(tokens)) out[k] = (Number(out[k]) || 0) + (Number(v) || 0);
	for (const [k, v] of Object.entries(cost ?? {})) out.cost[k] = (Number(out.cost[k]) || 0) + (Number(v) || 0);
	return out;
}

const list = (title: string, m: { kept: string[]; omitted: number }, marker: string): string[] => [title, m.kept.length ? [...(m.omitted ? [`[… ${m.omitted} ${marker} …]`] : []), ...m.kept].join("\n") : NONE_ROW];

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

/**
 * The deterministic part of a summary: user words verbatim, files, commands, other calls, errors and a handle index, each section
 * merged from the previous summary `previous` (any format) and this prefix. `tableText` = the folded-outputs table the caller will
 * append, so the index does not repeat its handles. `earlier` = the requests before this prefix when `previous` keeps no list of them.
 */
export function skeleton(prefix: Block[], previous: string | null, tableText = "", file?: FileRecall, earlier?: string[]): { text: string; users: number } {
	const calls = toolCallIndex(prefix);
	const results = new Map<string, Block>();
	for (const b of prefix) if (b.kind === "toolResult") results.set(b.msg.toolCallId, b);
	const users: string[] = [];
	const files = new Map<string, Map<string, string | null>>(); // path -> tool -> handle of its latest result
	const cmds: string[] = [];
	const others: string[] = []; // tools with neither a command nor a path (web fetch, pathless grep, custom tools)
	const errors: string[] = [];
	const now: IndexRow[] = []; // every recallable result of this prefix, oldest first
	const nowText: string[] = []; // ... and its output (to tell look-alike rows apart)
	const usedDirs = new Set<string>(); // shared `cd <dir>` prefixes left out of this prefix's command rows
	const shared = strippableCdDirs(bashCommands(prefix), parseSummary(previous).cmdDirs);
	for (const b of prefix) {
		if (b.kind === "user") {
			const t = requestText(b.msg.content, b.entryId, file);
			if (t) users.push(t);
		}
		if (b.kind !== "assistant") continue;
		for (const c of b.msg.content ?? []) {
			if (c?.type !== "toolCall") continue;
			const a = c.arguments ?? {};
			const res = results.get(c.id);
			const resText = res ? textOf((res.raw ?? res.msg).content) : "";
			if (c.name === "bash") {
				const m = /Command exited with code (\d+)/.exec(resText);
				const status = m ? `exit ${m[1]}` : res?.msg.isError ? "error" : res ? "exit 0" : "no result";
				const tag = res ? ` (${whenLabel(blockTime(res), res.userTurn)}${res.entryId ? ", " + handleFor(res.entryId) : ""})` : ""; // every result is recallable, so every one gets its handle
				const d = cdDirOf(String(a.command ?? ""));
				if (d && shared.has(d)) usedDirs.add(d);
				cmds.push(`\`${shortArgs({ command: String(a.command ?? "") }, BUDGET.cmdChars, shared)}\` -> ${status}${tag}`);
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
				now.push({ handle: handleFor(res.entryId), tool: c.name, args: shortArgs(a, 60, shared), turn: res.userTurn, at: blockTime(res) });
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
	const dirs = [...new Set([...prev.cmdDirs, ...usedDirs])]; // every dir any row leaves out (at most one: strippableCdDirs)
	out.push(...list(cmdsHead(dirs), mc, "older omitted"));
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
	// buildCut carries durable epochs and reconciles active state separately from these deterministic lists.
	return { text: out.join("\n"), users: users.length };
}

/** Pi's own serializer (lazy import: only needed when a summary is actually written); a plain-text fallback if it is unavailable. */
async function serialize(msgs: Any[]): Promise<string> {
	try {
		const pi: Any = await import("@earendil-works/pi-coding-agent");
		return pi.serializeConversation(pi.convertToLlm(msgs));
	} catch {
		return msgs.map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content : textOf(m.content) || JSON.stringify(m.content ?? "")}`).join("\n\n");
	}
}

export interface Narrative {
	text: string | null;
	ok: boolean;
	ms: number;
	costUsd: number;
	usage?: Any;
	error?: string;
}

/** A reasoning model whose provider refuses a request without reasoning (pi-ai sends effort "none" when none is asked for; gateway
 *  gpt-6.1-sol answers "'none' is not supported ... Supported values are: 'low', ..."). Pi's own compaction passes the session's
 *  thinking level and never meets it. */
export const EFFORT_REFUSED_RE = /(?:'none'|"none"|reasoning|effort)[^\n]{0,80}not supported|unsupported[^\n]{0,60}(?:reasoning|effort)/i;
const lowEffort = new Set<string>(); // provider/model keys that need an explicit effort: the next narrative asks for "low" at once

/**
 * One summariser call (the narrative, or a tier merge of two epochs) to the current model, separate and uncached. Never throws; one
 * retry, none for a refusal by policy, a reply cut at the cap or an abort.
 */
async function complete(ctx: Any, prompt: string, ownSignal?: AbortSignal, outputCap = NARRATIVE_CALL_MAX): Promise<Narrative> {
	const t0 = Date.now();
	const model = ctx.model;
	if (!model) return { text: null, ok: false, ms: 0, costUsd: 0, error: "no current model" };
	const cap = Math.min(outputCap, Number(model.maxTokens) > 0 ? Number(model.maxTokens) : outputCap);
	let lastErr = "", costUsd = 0;
	let usage: Any;
	try {
		const signals: AbortSignal[] = [AbortSignal.timeout(240_000)];
		// a background summary has its own signal (nothing is running, so the run's signal would be stale); a summary the user waits for follows the run's (Esc)
		const outer = ownSignal ?? ctx.signal;
		if (outer) signals.push(outer);
		const signal = AbortSignal.any(signals);
		const key = `${model.provider ?? ""}/${model.id ?? ""}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const low = lowEffort.has(key);
			try {
				signal.throwIfAborted();
				const res: Any = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: NARRATIVE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
					{ maxTokens: cap, signal, cacheRetention: "none", sessionId: randomUUID(), ...(low ? { reasoningEffort: "low" } : {}) },
				);
				costUsd += Number(res.usage?.cost?.total) || 0;
				if (res.usage) usage = addUsage(usage, res.usage);
				if (res.stopReason === "aborted" || signal.aborted) return { text: null, ok: false, ms: Date.now() - t0, costUsd, usage, error: "narrative aborted" };
				if (res.stopReason === "error") throw new Error(res.errorMessage || "provider error");
				if (res.stopReason === "length") throw new Error(CAP_ERR);
				if ((res.content ?? []).some((c: Any) => c.type === "toolCall")) throw new Error("summariser attempted a tool call");
				const text = textOf(res.content).trim();
				if (!text) throw new Error("empty narrative");
				return { text, ok: true, ms: Date.now() - t0, costUsd, usage };
			} catch (err) {
				lastErr = err instanceof Error ? err.message : String(err);
				if (!low && model.reasoning && EFFORT_REFUSED_RE.test(lastErr) && !signal.aborted) {
					lowEffort.add(key); // the request itself was refused: ask again with the lowest common effort, without using up the retry
					attempt--;
					continue;
				}
				if (POLICY_BLOCK_RE.test(lastErr) || lastErr === CAP_ERR || signal.aborted) break; // an identical retry fails the same way
			}
		}
	} catch (err) {
		lastErr = err instanceof Error ? err.message : String(err);
	}
	return { text: null, ok: false, ms: Date.now() - t0, costUsd, usage, error: lastErr };
}

/**
 * The narrative of this prefix, written by the current model in a separate, uncached call. Never throws. Durable epochs are not
 * re-read. Only the bounded previous active state is reconciled against this slice. `durable`/`active` = the reply's two parts.
 */
export async function narrative(prefix: Block[], ctx: Any, budgetTokens: number, ownSignal?: AbortSignal, previousActive = ""): Promise<Narrative & { durable?: string; active?: string }> {
	const t0 = Date.now();
	if (!ctx.model) return { text: null, ok: false, ms: 0, costUsd: 0, error: "no current model" };
	const msgs = prefix
		.filter((b) => b.kind !== "summary")
		.map((b) => {
			const m = b.raw && !(b.edited && !b.ours) ? b.raw : b.msg; // the summariser reads the unfolded originals
			return m.role === "assistant" ? { ...m, content: (m.content ?? []).filter((c: Any) => c?.type !== "thinking") } : m;
		});
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
		`<conversation>\n${conv}\n</conversation>\n\n` +
		`Write the NARRATIVE part of a context summary for this conversation slice. It is the newest increment of a longer session: earlier increments ` +
		`are summarised already and kept as immutable epochs, so summarize ONLY what this conversation slice accomplished. A separate deterministic ` +
		`section already lists the user's requests, files touched, commands with exit codes and errors, so do NOT repeat those. When you refer to a ` +
		`specific tool output, name it by its tool and exact command or path so that look-alike runs stay distinguishable; never merge similar runs ` +
		`into one. Output format:\n` +
		`---DECISIONS---\n` +
		`(durable: any architecture decisions, rationale, design choices, API contracts, user constraints or rulings, root causes found, and durable ` +
		`facts settled in this slice — exact values, paths, identifiers, results later work depends on; <= ${w.durable} words; write (none) if none)\n` +
		`---ACTIVE---\n` +
		`(volatile: reconcile the previous active state with this slice. Carry forward every still-open todo, next step and blocker, even if not ` +
		`mentioned in this slice. Remove an item only when this slice provides evidence that it was completed or superseded; silence is not completion. ` +
		`Update changed status and add new open work. Write each open todo, next step and blocker as its own line starting with "- [ ] ", ` +
		`before the other state lines; to stay in budget, shorten wording and merge related items rather than drop one. ` +
		`Do not copy the previous active state into DECISIONS. <= ${w.active} words)\n` +
		`Be concrete and keep exact paths, names and numbers. Stay under about ${w.durable + w.active} words in all. Do not call tools.`;
	const r = await complete(ctx, prompt, ownSignal);
	if (!r.ok || !r.text) return { ...r, ms: Date.now() - t0 };
	return { ...r, ms: Date.now() - t0, ...parseNarrativeReply(r.text) };
}

/** The cold summary (skeleton + narrative + handle table) for a planned cut. */
export async function buildCut(p: PlanResult, ctx: Any, signal?: AbortSignal): Promise<Cut> {
	const { foldMin, keepLines } = settings();
	const t0 = performance.now();
	const prefix = p.blocks.slice(0, p.cutIdx!);
	const prev = prefix[0]?.kind === "summary" ? String(prefix[0].msg.summary ?? "") || null : null;
	const prevParsed = parseSummary(prev);
	const slice = prefix.filter((b) => b.kind !== "summary");
	const shared = strippableCdDirs(bashCommands(slice), prevParsed.cmdDirs);
	const texts: string[] = [];
	const keyLists: string[][] = [];
	const rows: HandleRow[] = prefix
		.filter((b) => b.kind === "toolResult" && b.entryId && (b.ours || b.tokens > foldMin))
		.map((b) => {
			const call = p.calls.get(b.msg.toolCallId);
			const out = textOf((b.raw ?? b.msg).content);
			const keys = keyTexts(out, keepLines);
			const tool = call?.name ?? b.msg.toolName ?? "tool";
			const hint = keys[0] ?? "";
			texts.push(out);
			keyLists.push(keys);
			return { handle: handleFor(b.entryId!), tool, args: call ? shortArgs(call.args, undefined, shared) : "", turn: b.userTurn, at: blockTime(b), outcome: outcomeHint(out, tool, !!b.msg.isError), hint };
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
	const nar = await narrative(prefix, ctx, nb, signal, prevStruct.activeState);
	let costUsd = nar.costUsd, actualMergeCostUsd = 0;
	let usage = nar.usage;
	let text = sk.text;
	const how = file ? `read an output's file by its handle (${file.dir}/<handle>.txt)` : `${RECALL_TOOL} an output by its handle`;
	const cap = epochCap(nb);
	if (nar.ok && nar.text) {
		const w = epochWords(nb);
		const durable = clipPart(nar.durable ?? prose(nar.text), w.durable);
		const active = clipActive(nar.active || prevStruct.activeState, activeChars(w.active));
		const nextNum = (prevStruct.epochs.length ? epochNum(prevStruct.epochs.at(-1)!, true) : 0) + 1;
		const ep = mkEpoch(nextNum, nextNum, turnsLabel(prevReq, sk.users), nowWhen ?? "time unknown", 1, durable || NONE_ROW);
		const cons = await consolidateEpochs([...prevStruct.epochs, ep], ctx, cap, signal);
		actualMergeCostUsd = cons.costUsd;
		costUsd += cons.costUsd;
		usage = addUsage(usage, cons.usage);
		const cur: StructuredNarrative = {
			activeState: active,
			...(nowWhen ? { activeAt: nowWhen } : {}),
			epochs: boundEpochs(cons.epochs, cap),
		};
		text += `\n## Narrative (model-written)\n${formatNarrative(cur)}`;
	} else if (prevStruct.epochs.length > 0 || prevStruct.activeState.trim()) {
		const stale = clip(nar.error ?? "n/a", 120);
		const carried: StructuredNarrative = {
			activeState: prevStruct.activeState,
			...(prevWhen ? { activeAt: prevWhen } : {}),
			activeStale: stale,
			epochs: boundEpochs(prevStruct.epochs, cap),
		};
		text += `\n${narrCarriedHead(prevWhen, stale)}\n${formatNarrative(carried)}`;
	} else {
		text += `\n## Narrative\n(unavailable: ${nar.error ?? "n/a"}; rely on the sections above and ${how} rather than re-running or re-reading)`;
	}
	if (table) text += "\n" + table;
	return {
		firstKeptEntryId: p.blocks[p.cutIdx!].entryId!,
		text,
		trigger: p.sumTrigger ?? "cold",
		count: sk.users,
		prefixTokens: p.prefixTokens,
		summaryTokens: tok4(text),
		llmOk: nar.ok,
		llmError: nar.error ?? null,
		costUsd,
		...(mergeWork.merges > 0 ? { predictedMergeCostUsd, actualMergeCostUsd } : {}),
		usage,
		ms: Math.round(performance.now() - t0),
	};
}
