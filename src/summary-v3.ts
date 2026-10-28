// Format v3 summary: a state digest instead of a growing history. One model call per compaction updates five sections from the
// new conversation slice: architecture, settled decisions, discarded approaches, test health and open work.
// Earlier conversation is not appended as epochs. The room after the digest is filled to a token target: the newest substantive user
// requests verbatim (at least V3_RECENT_REQUESTS), then tool evidence (what the digest names or the model selected first, then errors,
// then other outputs). Older requests become numbered ranges whose exact text zip_recall returns from the raw branch.
//
// Rules that keep the digest safe:
// - A request leaves the resident view only when the raw branch can return its exact text (its number and handle match the branch).
// - A request is folded as "go-ahead only" only when the model judged it so by meaning (no keyword or regex classifier). Code checks
//   only that the label names a user request of this slice. A folded request keeps its number and recall. Requests longer than
//   ACK_MAX_CHARS are never folded: this bounds the cost of a wrong judgement; it is not a classifier.
// - The digest is a list of numbered items. The code carries every item; the model only adds, edits, moves or drops items by number,
//   and a drop needs a reason. An item that no operation names stays word for word, so a model that forgets an item cannot lose it.
//   A failed call keeps the whole previous digest, marked possibly stale.
// - Intent quotes are exact NFC spans of user requests. They are checked against the raw branch, so a digested request still
//   supplies verbatim intent. A quote from a request the model judged go-ahead only is refused (assent alone is no intent; what was
//   approved belongs in an open-work item). A quote may name the digest item it is about (`about iN`), which gives its scope.
// Section order puts the stable system picture first and the open work and current intent last, where a reader looks for what to do.
import { blockTime, cdAliases, handleFor, RECALL_TOOL } from "./placeholder.ts";
import type { Block, Cut, PlanResult } from "./plan.ts";
import { branchRequests, type BranchRequest } from "./recall.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { skillReference } from "./skill-reference.ts";
import { addUsage, bashCommands, complete, excerpt, parseSummary, PREV_NARRATIVE_CHARS, previousNarrative, REASONING_QUALIFICATION, reasoningInput, serialize } from "./summary.ts";
import {
	collectExecutions, type EvidenceProposal, evidenceQuotes, formatExecutionRecord, formatRequestExcerpt, type IntentProposal, intentQuotesOf,
	MIN_EXCERPT_CHARS, parseSummaryV2, recordHandles, resolveIntents, SUMMARY_V2_DISCLAIMER, type V2Intent, type V2Request,
} from "./summary-v2.ts";
import { type Any, attempt, clip, envInt, fmtWhen, textOf, tok4 } from "./util.ts";

export const SUMMARY_V3_MARK = "[pi-zip summary · format v3 · state digest · request numbering: raw-branch-v2]";

/** Substantive user requests always kept verbatim (room permitting), newest first. Go-ahead-only requests do not count. */
export const V3_RECENT_REQUESTS = envInt("SUM_V3_RECENT_REQUESTS", 8);
/** The size a v3 summary fills to with requests and evidence (tokens), never above the plan's target. A fixed ceiling, so the
 *  summary does not ratchet up to the previous summary's size (the plan's target is at least the previous summary). */
export const V3_TARGET_TOKENS = envInt("SUM_V3_TARGET", 8000);
/** Share of the free room that more requests take before evidence; requests take what evidence leaves. */
const REQUEST_SHARE = 0.5;
/** Tool outputs one call may select as evidence. Only selected outputs and outputs the digest names become evidence. */
export const V3_SELECT_EVIDENCE = envInt("SUM_V3_SELECT_EVIDENCE", 20);
/** A request longer than this stays resident even when the model judged it go-ahead only. */
export const ACK_MAX_CHARS = 200;

export type DigestKey = "architecture" | "decisions" | "discarded" | "tests" | "open";
export const DIGEST_KEYS: readonly DigestKey[] = ["architecture", "decisions", "discarded", "tests", "open"];
/** Size each digest section should stay within (characters of item text). Over it, the prompt asks the model to merge items; the
 *  code drops nothing for size until the hard room is reached. */
export const V3_SECTION_CHARS: Readonly<Record<DigestKey, number>> = { architecture: 2000, decisions: 6000, discarded: 2000, tests: 800, open: 2000 };
/** The longest text the model can write for one item. */
export const ITEM_MAX_CHARS = 800;
const MARKERS: Record<DigestKey, string> = { architecture: "ARCHITECTURE", decisions: "DECISIONS", discarded: "DISCARDED", tests: "TESTS", open: "OPEN" };
const HEADS: Record<DigestKey, string> = {
	architecture: "## Architecture — assistant interpretation: components, key files, data flow",
	decisions: "## Settled decisions — assistant interpretation: rationale, user rulings, invariants, established causes",
	discarded: "## Discarded approaches — assistant interpretation: tried or rejected; do not retry without new evidence",
	tests: "## Test health — assistant interpretation: baseline failures versus new regressions",
	open: "## Open work — assistant interpretation",
};
const EVIDENCE_HEAD = "## Key evidence — tool observations the digest rests on";
const REQUESTS_HEAD = "## Requests — user said (older requests are digested above; recall returns their exact text)";
const INTENT_HEAD = "## Current intent — selected user quotes, scope not inferred";
const ALIASES_PREFIX = "Command directory aliases: ";
const DIGEST_RE = /^Digest: (?:as of (.+)|carried forward(?: from ([^;]*))?; possibly stale: (.*)|time unknown)$/;
const RANGE_RE = /^- R(\d+)(?:–R(\d+))? (digested|go-ahead only) \((\d+) requests?\b[^)]*\);/;
const REQ_HEAD_RE = /^- (?:R(\d+)|legacy R(\d+)|legacy request)(?: · handle ([0-9a-z]{10}))?((?: · (?:skill references|source incomplete|emergency excerpt|original \d+ chars))*)$/;
const INTENT_ROW_RE = /^- R(\d+) · source ([0-9a-z]{10})(?: · about i(\d+))?$/;
const QUOTE = "  > ";
const SELECTED_RE = /\n {2}Selected evidence(?: \([0-9a-z]{10}\))?: /;
const NONE = "(none)";
const OMITTED = "(omitted to fit the summary room)";

const quoteLines = (t: string) => String(t ?? "").split("\n").map((l) => QUOTE + l).join("\n");
const unquote = (lines: string[]) => lines.map((l) => (l.startsWith(QUOTE) ? l.slice(QUOTE.length) : l)).join("\n");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, token: string) => !!token && new RegExp(`(^|[^\\w./-])${esc(token)}($|[^\\w-])`).test(text);

// ---------------------------------------------------------------------------------------------------------------
// digest items
// ---------------------------------------------------------------------------------------------------------------

/** One digest entry. `id` is stable across compactions; 0 marks a placeholder line (a section omitted to fit the room). */
export interface DigestItem { id: number; text: string }
export type Digest = Record<DigestKey, DigestItem[]>;

const emptyDigest = (): Digest => ({ architecture: [], decisions: [], discarded: [], tests: [], open: [] });
const copyDigest = (d: Digest): Digest => ({ architecture: [...d.architecture], decisions: [...d.decisions], discarded: [...d.discarded], tests: [...d.tests], open: [...d.open] });
// Item numbers are written iN, not #N: sessions are full of #N issue and task numbers that an item label must not be confused with.
const ITEM_RE = /^- \[i(\d+)\] ?(.*)$/;
/** Item text: trimmed lines without blank ones (every line after the first is rendered indented, so none can read as structure). */
const itemText = (t: string) => String(t ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
/** An item's text cut to `n` characters, keeping its lines. */
const clipItem = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const itemLines = (it: DigestItem): string[] => {
	const [first = "", ...rest] = it.text.split("\n");
	return it.id > 0 ? [`- [i${it.id}] ${first}`, ...rest.map((l) => `  ${l}`)] : [`  ${first}`, ...rest.map((l) => `  ${l}`)];
};
/** A section's items as plain text (for readers of older formats and for size estimates). */
export const sectionText = (items: readonly DigestItem[]) => items.map((i) => i.text).join("\n");
const digestText = (d: Digest) => DIGEST_KEYS.map((k) => sectionText(d[k])).join("\n");
const sectionChars = (items: readonly DigestItem[]) => items.reduce((n, i) => n + i.text.length, 0);
const maxItemId = (d: Digest) => DIGEST_KEYS.reduce((m, k) => d[k].reduce((n, i) => Math.max(n, i.id), m), 0);

/** Split text written without item numbers (a v2 or older summary's prose, an earlier v3 section) into items: a new item starts at a
 *  top-level list marker or after a blank line; other lines continue the item. This splits by markdown layout only. */
export function itemsOf(text: string, firstId: number): DigestItem[] {
	const out: DigestItem[] = [];
	let cur: string[] = [], gap = true;
	const flush = () => {
		const t = itemText(cur.join("\n"));
		if (t && t !== NONE && t !== OMITTED) out.push({ id: firstId + out.length, text: t });
		cur = [];
	};
	for (const l of String(text ?? "").split("\n")) {
		if (!l.trim() || l.trim() === NONE || l.trim() === OMITTED) {
			gap = true;
			continue;
		}
		const m = /^ ?(?:[-*+]|\d+[.)])\s+(?:\[ \]\s+)?(.*)$/.exec(l);
		if (m || gap) flush();
		cur.push(m ? m[1] : l);
		gap = false;
	}
	flush();
	return out;
}

export type DigestOp =
	| { op: "add"; section: DigestKey; text: string; id?: number }
	| { op: "edit"; id: number; text: string }
	| { op: "move"; id: number; section: DigestKey; text?: string }
	| { op: "drop"; id: number; reason: string };

export interface OpsResult {
	digest: Digest;
	added: number;
	edited: number;
	moved: number;
	dropped: { id: number; text: string; reason: string }[];
	/** operations that name no current item, carry no text, or drop without a reason; each leaves the digest as it was */
	rejected: number;
	/** number an ADD asked for -> number it got (they differ only when the asked number was taken) */
	assigned: Map<number, number>;
}

/** Apply the model's operations in order. Every item that no accepted operation names is kept unchanged. */
export function applyDigestOps(before: Digest, ops: readonly DigestOp[]): OpsResult {
	const d = copyDigest(before);
	let next = maxItemId(d) + 1, added = 0, edited = 0, moved = 0, rejected = 0;
	const dropped: OpsResult["dropped"] = [];
	const assigned = new Map<number, number>();
	const used = new Set(DIGEST_KEYS.flatMap((k) => d[k].map((i) => i.id)));
	const find = (id: number) => {
		for (const k of DIGEST_KEYS) {
			const i = d[k].findIndex((it) => it.id === id);
			if (i >= 0) return { k, i };
		}
		return null;
	};
	for (const o of ops) {
		if (o.op === "add") {
			const t = clipItem(itemText(o.text), ITEM_MAX_CHARS);
			if (!t) {
				rejected++;
				continue;
			}
			// the asked number when it is free (never one used before in this digest or this reply), else the next free one
			const want = o.id && o.id > 0 && !used.has(o.id) && !assigned.has(o.id) ? o.id : 0;
			const id = want || next;
			next = Math.max(next, id + 1);
			used.add(id);
			if (o.id && o.id > 0 && !assigned.has(o.id)) assigned.set(o.id, id);
			d[o.section] = [...d[o.section], { id, text: t }];
			added++;
			continue;
		}
		const at = o.id > 0 ? find(o.id) : null;
		if (!at) {
			rejected++;
			continue;
		}
		const item = d[at.k][at.i];
		if (o.op === "edit") {
			const t = clipItem(itemText(o.text), ITEM_MAX_CHARS);
			if (t) (d[at.k] = d[at.k].map((it, i) => (i === at.i ? { id: it.id, text: t } : it))), edited++;
			else rejected++;
		} else if (o.op === "move") {
			const t = o.text !== undefined ? clipItem(itemText(o.text), ITEM_MAX_CHARS) : "";
			d[at.k] = d[at.k].filter((_, i) => i !== at.i);
			d[o.section] = [...d[o.section], { id: item.id, text: t || item.text }];
			moved++;
		} else {
			const reason = o.reason.trim();
			if (!reason) {
				rejected++;
				continue;
			}
			d[at.k] = d[at.k].filter((_, i) => i !== at.i);
			dropped.push({ id: item.id, text: item.text, reason });
		}
	}
	return { digest: d, added, edited, moved, dropped, rejected, assigned };
}

// ---------------------------------------------------------------------------------------------------------------
// the v3 document
// ---------------------------------------------------------------------------------------------------------------

export interface V3Request {
	number: number; // raw-branch-v2 ordinal; 0: an older summary's request that no raw entry matched
	legacyNumber?: number;
	handle?: string;
	entryId?: string;
	text: string;
	skillReferences?: boolean;
	sourceIncomplete?: boolean;
	emergencyExcerpt?: { originalChars: number };
}
/** Inclusive request range that is not resident. "digested": older than the recent window. "ack": go-ahead only, judged by the model. */
export interface V3Range { first: number; last: number; kind: "digested" | "ack" }
export type V3Row = { request: V3Request } | { range: V3Range };

/** A verbatim user quote; `about`: the digest item it refers to (its scope, in the assistant's words). */
export interface V3Intent extends V2Intent { about?: number }

export interface V3State {
	digest: Digest;
	digestAt?: string;
	digestStale?: string;
	intents: V3Intent[];
	aliases: Map<string, string>; // dir -> alias
	rows: V3Row[]; // oldest first; legacy rows (number 0) first
	evidence: string[]; // rendered execution records, oldest first
}

const rowCount = (rows: readonly V3Row[]) => rows.reduce((n, r) => n + ("range" in r ? r.range.last - r.range.first + 1 : 1), 0);

const requestRow = (r: V3Request) => {
	const num = r.number > 0 ? `R${r.number}` : r.legacyNumber ? `legacy R${r.legacyNumber}` : "legacy request";
	const quals = [
		r.skillReferences ? "skill references" : "",
		r.sourceIncomplete ? "source incomplete" : "",
		r.emergencyExcerpt ? "emergency excerpt" : "",
		r.emergencyExcerpt?.originalChars ? `original ${r.emergencyExcerpt.originalChars} chars` : "",
	].filter(Boolean);
	return `- ${num}${r.handle ? ` · handle ${r.handle}` : ""}${quals.map((q) => ` · ${q}`).join("")}\n${quoteLines(r.text)}`;
};

const rangeRow = (g: V3Range, file?: FileRecall) => {
	const span = g.first === g.last ? `R${g.first}` : `R${g.first}–R${g.last}`;
	const count = g.last - g.first + 1;
	const what = g.kind === "ack" ? `go-ahead only (${count} request${count === 1 ? "" : "s"}, judged by the summariser)` : `digested (${count} request${count === 1 ? "" : "s"})`;
	const recall = file
		? `${file.dir}/requests.txt holds the exact text; ${fileRecallHow(file)}`
		: `${RECALL_TOOL}({ requests: "${g.first}-${g.last}" }) returns the exact text`;
	return `- ${span} ${what}; ${recall}`;
};

const digestLine = (s: V3State) =>
	s.digestStale !== undefined
		? `Digest: carried forward${s.digestAt ? ` from ${s.digestAt}` : ""}; possibly stale: ${clip(s.digestStale, 120)}`
		: s.digestAt ? `Digest: as of ${s.digestAt}` : "Digest: time unknown";

const recallLine = (file?: FileRecall) =>
	file
		? `Recall: ${file.dir}/<handle>.txt holds each original output or request; ${file.dir}/requests.txt lists every user request (${fileRecallHow(file)}).`
		: `Recall: call ${RECALL_TOOL} with handle/handles, requests="M-N", or grep with scope="outputs"|"requests"|"assistant"|"all". An output not listed here is still recallable: grep without a handle searches every earlier output.`;

/** The whole v3 text. The alias legend names only the aliases that its records use. */
export function renderV3(s: V3State, file?: FileRecall): string {
	const used = new Set([...s.evidence.join("\n").matchAll(/\[([a-z]{1,3})\] /g)].map((m) => m[1]));
	const legend = [...s.aliases].filter(([, a]) => used.has(a)).sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1])).map(([d, a]) => `${a}=${d}`);
	const excerpts = s.rows.filter((r) => "request" in r && r.request.emergencyExcerpt).length;
	const header = [
		SUMMARY_V3_MARK,
		SUMMARY_V2_DISCLAIMER,
		digestLine(s),
		...(excerpts ? [`Requests: emergency excerpts — ${excerpts} of ${rowCount(s.rows)} requests shortened to fit the window; recall by R<n>/handle returns exact text.`] : []),
		recallLine(file),
		...(legend.length ? [ALIASES_PREFIX + legend.join(", ")] : []),
	].join("\n");
	const section = (k: DigestKey) => [HEADS[k], ...(s.digest[k].length ? s.digest[k].flatMap(itemLines) : [NONE])].join("\n");
	const rows = s.rows.map((r) => ("range" in r ? rangeRow(r.range, file) : requestRow(r.request)));
	const intents = s.intents.map((i) => `- R${i.requestNumber} · source ${i.handle}${i.about ? ` · about i${i.about}` : ""}\n${quoteLines(i.quote)}`);
	return [
		header,
		section("architecture"),
		section("decisions"),
		section("discarded"),
		section("tests"),
		[EVIDENCE_HEAD, ...(s.evidence.length ? s.evidence : [NONE])].join("\n"),
		[REQUESTS_HEAD, ...(rows.length ? rows : [NONE])].join("\n"),
		section("open"),
		[INTENT_HEAD, ...(intents.length ? intents : [NONE])].join("\n"),
	].join("\n\n");
}

/** Parse a v3 text back (null for any other text or for a range row that does not add up). */
export function parseSummaryV3(text: string | null): V3State | null {
	if (!text || !text.trimStart().startsWith(SUMMARY_V3_MARK)) return null;
	const st: V3State = { digest: emptyDigest(), intents: [], aliases: new Map(), rows: [], evidence: [] };
	const headKey = new Map<string, DigestKey>(DIGEST_KEYS.map((k) => [HEADS[k], k]));
	type Sec = "" | DigestKey | "evidence" | "requests" | "intent";
	let sec: Sec = "";
	const body = new Map<DigestKey, string[]>();
	let req: V3Request | null = null, reqLines: string[] = [];
	let intent: V3Intent | null = null, intentLines: string[] = [];
	let group: string[] = [];
	const flushReq = () => {
		if (req) st.rows.push({ request: { ...req, text: unquote(reqLines) } });
		req = null;
		reqLines = [];
	};
	const flushIntent = () => {
		if (intent) st.intents.push({ ...intent, quote: unquote(intentLines) });
		intent = null;
		intentLines = [];
	};
	const flushGroup = () => {
		if (group.length) st.evidence.push(group.join("\n"));
		group = [];
	};
	const flushAll = () => {
		flushReq();
		flushIntent();
		flushGroup();
	};
	for (const l of text.split("\n")) {
		if (l.startsWith("## ")) {
			const k = headKey.get(l);
			const next: Sec | undefined = k ?? (l === EVIDENCE_HEAD ? "evidence" : l === REQUESTS_HEAD ? "requests" : l === INTENT_HEAD ? "intent" : undefined);
			if (next !== undefined) {
				flushAll();
				sec = next;
				continue;
			}
		}
		if (sec === "") {
			const d = DIGEST_RE.exec(l);
			if (d) {
				if (d[1]) st.digestAt = d[1];
				else if (d[3] !== undefined) {
					st.digestStale = d[3];
					if (d[2]) st.digestAt = d[2];
				}
			} else if (l.startsWith(ALIASES_PREFIX)) {
				for (const pair of l.slice(ALIASES_PREFIX.length).split(/, (?=[a-z]{1,3}=)/)) {
					const m = /^([a-z]{1,3})=(.+)$/.exec(pair);
					if (m) st.aliases.set(m[2], m[1]);
				}
			}
			continue;
		}
		if (sec === "requests") {
			const g = RANGE_RE.exec(l);
			if (g) {
				flushReq();
				const first = Number(g[1]), last = Number(g[2] ?? g[1]), count = Number(g[4]);
				if (![first, last, count].every(Number.isSafeInteger) || first < 1 || last < first || count !== last - first + 1) return null;
				st.rows.push({ range: { first, last, kind: g[3] === "digested" ? "digested" : "ack" } });
				continue;
			}
			const m = REQ_HEAD_RE.exec(l);
			if (m) {
				flushReq();
				const q = m[4] ?? "";
				const orig = /original (\d+) chars/.exec(q);
				req = {
					number: m[1] ? Number(m[1]) : 0,
					...(m[2] ? { legacyNumber: Number(m[2]) } : {}),
					...(m[3] ? { handle: m[3] } : {}),
					text: "",
					...(q.includes("skill references") ? { skillReferences: true } : {}),
					...(q.includes("source incomplete") ? { sourceIncomplete: true } : {}),
					...(q.includes("emergency excerpt") ? { emergencyExcerpt: { originalChars: orig ? Number(orig[1]) : 0 } } : {}),
				};
			} else if (req && l.startsWith(QUOTE)) reqLines.push(l);
			continue;
		}
		if (sec === "intent") {
			const m = INTENT_ROW_RE.exec(l);
			if (m) {
				flushIntent();
				intent = { requestNumber: Number(m[1]), handle: m[2], quote: "", ...(m[3] ? { about: Number(m[3]) } : {}) };
			} else if (intent && l.startsWith(QUOTE)) intentLines.push(l);
			continue;
		}
		if (sec === "evidence") {
			if (l.startsWith("- ")) {
				flushGroup();
				group.push(l);
			} else if (l.startsWith("  ") && group.length) group.push(l);
			continue;
		}
		body.set(sec, [...(body.get(sec) ?? []), l]);
	}
	flushAll();
	// numbered items; a section written without numbers (an earlier v3 text) is split and numbered after the highest number
	const legacy: DigestKey[] = [];
	for (const k of DIGEST_KEYS) {
		const lines = body.get(k) ?? [];
		if (!lines.some((l) => ITEM_RE.test(l))) {
			legacy.push(k);
			continue;
		}
		let cur: DigestItem | null = null;
		for (const l of lines) {
			const m = ITEM_RE.exec(l);
			if (m) st.digest[k].push((cur = { id: Number(m[1]), text: m[2] }));
			else if (cur && l.startsWith("  ") && l.trim()) cur.text += `\n${l.trim()}`;
		}
	}
	for (const k of legacy) st.digest[k] = itemsOf((body.get(k) ?? []).join("\n"), maxItemId(st.digest) + 1);
	return st;
}

// ---------------------------------------------------------------------------------------------------------------
// the previous summary, any format
// ---------------------------------------------------------------------------------------------------------------

/** The digest a new narrative call starts from. A v2 summary's epoch prose becomes the decisions to digest and its state the open work;
 *  an older or foreign summary's narrative becomes the decisions (its head and tail when long). */
export function previousDigest(previous: string | null): { digest: Digest; intents: string[]; at?: string } {
	const v3 = parseSummaryV3(previous);
	if (v3) return { digest: copyDigest(v3.digest), intents: v3.intents.map((i) => i.quote), ...(v3.digestAt ? { at: v3.digestAt } : {}) };
	const digest = emptyDigest();
	// an older summary's prose is split into numbered decisions (the call can move each item to its section) and its state into open work
	const migrate = (prose: string, open: string) => {
		digest.decisions = itemsOf(prose, 1);
		digest.open = itemsOf(open, digest.decisions.length + 1);
	};
	const v2 = parseSummaryV2(previous);
	if (v2) {
		const all = v2.epochs.map((e) => e.block.durableProse).filter((t) => t && t !== NONE && !t.startsWith("(omitted")).join("\n\n");
		migrate(excerpt(all, PREV_NARRATIVE_CHARS, Math.floor(PREV_NARRATIVE_CHARS / 4)), v2.activeState);
		return { digest, intents: v2.intents.map((i) => i.quote), ...(v2.activeAt ? { at: v2.activeAt } : {}) };
	}
	if (!previous) return { digest, intents: [] };
	const pp = parseSummary(previous);
	const narr = previousNarrative(previous, 0, PREV_NARRATIVE_CHARS);
	migrate(pp.epochs ? excerpt(pp.epochs.epochs.map((e) => e.durableProse).join("\n\n"), PREV_NARRATIVE_CHARS, Math.floor(PREV_NARRATIVE_CHARS / 4)) : narr?.text ?? "", pp.epochs?.activeState ?? "");
	const at = pp.epochs?.activeAt ?? pp.narrativeAt ?? narr?.at;
	return { digest, intents: [], ...(at ? { at } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// building the state
// ---------------------------------------------------------------------------------------------------------------

export interface PrepareV3Options {
	prefix: Block[]; // the newest slice (no summary block)
	previous?: string | null; // the previous summary's text, any format
	branch?: Any[]; // the raw ancestor branch
	cwd?: string;
	/** The narrative's operations on the previous digest. Absent or empty: the previous digest is kept as it was. */
	ops?: readonly DigestOp[];
	digestAt?: string;
	/** Set when the narrative call failed: the previous digest is carried forward, marked possibly stale. */
	digestStale?: string;
	/** Absent: the previous intents are kept as they were written (they were checked then). `about`: a digest item number. */
	proposedIntents?: (IntentProposal & { about?: number })[];
	proposedEvidence?: EvidenceProposal[];
	/** Source handles the model judged go-ahead only. */
	acknowledgements?: readonly string[];
	/** The least number of substantive requests kept verbatim; the room decides how many more. */
	recent?: number;
}

export interface PreparedV3 {
	/** rows: every request, go-ahead-only ones folded, none digested yet; evidence: every candidate record, oldest first */
	state: V3State;
	recent: number;
	/** how many records at the end of state.evidence come from this slice */
	freshEvidence: number;
	/** request number -> handle, from the raw branch: only these requests may leave the resident view */
	recallable: ReadonlyMap<number, string>;
	stats: { ackProposed: number; ackAccepted: number; quoteAccepted: number; quoteRejected: number; quoteAck: number; evidenceNew: number };
	ops: Omit<OpsResult, "digest">;
}

const fromRaw = (r: BranchRequest): V3Request => ({ number: r.number, handle: r.handle, entryId: r.entryId, text: r.text });

/** A record whose handle or execution id the digest names is always listed. */
const recordPinned = (rec: string, text: string) =>
	recordHandles(rec).some((h) => text.includes(h)) || (() => { const x = /execution (\S+)/.exec(rec.split("\n")[0])?.[1]; return !!x && mentions(text, x); })();

/** Join adjacent ranges of one kind. Gaps and resident rows never become invented requests. */
function compactRanges(rows: readonly V3Row[]): V3Row[] {
	const out: V3Row[] = [];
	for (const r of rows) {
		const prev = out.at(-1);
		if (prev && "range" in prev && "range" in r && prev.range.kind === r.range.kind && prev.range.last + 1 === r.range.first) prev.range = { ...prev.range, last: r.range.last };
		else out.push("range" in r ? { range: { ...r.range } } : { request: { ...r.request } });
	}
	return out;
}

/** The newest `recent` substantive requests stay resident. Go-ahead-only requests inside that window become "ack" ranges. Every older
 *  row becomes a digested range, except a request that the raw branch cannot return (it stays resident: never trade away its only copy). */
export function windowRows(rows: readonly V3Row[], recent: number, ack: ReadonlySet<string>, recallable: ReadonlyMap<number, string>): V3Row[] {
	const eligible = (r: V3Request) => r.number > 0 && !r.legacyNumber && !!r.handle && recallable.get(r.number) === r.handle;
	const out: V3Row[] = [];
	let kept = 0;
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		const inWindow = kept < Math.max(1, recent);
		if ("range" in row) {
			out.push({ range: { ...row.range, kind: inWindow ? row.range.kind : "digested" } });
			continue;
		}
		const r = row.request;
		if (r.handle && ack.has(r.handle) && eligible(r)) {
			out.push({ range: { first: r.number, last: r.number, kind: inWindow ? "ack" : "digested" } });
			continue;
		}
		if (inWindow || !eligible(r)) {
			out.push({ request: { ...r } });
			kept++;
			continue;
		}
		out.push({ range: { first: r.number, last: r.number, kind: "digested" } });
	}
	return compactRanges(out.reverse());
}

/** Calls made before the slice, from the raw branch: call id -> execution id ("" when one message issued the id twice). */
function priorIssuers(branch: readonly Any[], startAt: number | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (startAt === undefined) return out;
	for (const e of branch.slice(0, startAt)) {
		const msg = e?.type === "message" ? e.message : null;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content) || !e.id) continue;
		const counts = new Map<string, number>();
		for (const c of msg.content) if (c?.type === "toolCall" && c.id) counts.set(String(c.id), (counts.get(String(c.id)) ?? 0) + 1);
		msg.content.forEach((c: Any, pos: number) => {
			if (c?.type === "toolCall" && c.id) out.set(String(c.id), (counts.get(String(c.id)) ?? 0) > 1 ? "" : `${e.id}:${pos}`);
		});
	}
	return out;
}

/** The summary's content before any budget: the previous summary (any format) carried, this slice's requests added, the digest
 *  updated, the request window applied and the evidence bounded. */
export function prepareV3(o: PrepareV3Options): PreparedV3 {
	const branch = o.branch ?? [];
	const raw = branch.length ? branchRequests(branch) : [];
	const rawById = new Map(raw.map((r) => [r.entryId, r]));
	const rawByHandle = new Map(raw.map((r) => [r.handle, r]));
	const recallable = new Map(raw.map((r) => [r.number, r.handle]));
	const sliceFirst = o.prefix.find((b) => b.entryId)?.entryId;
	const prevV3 = parseSummaryV3(o.previous ?? null);
	const prevV2 = prevV3 ? null : parseSummaryV2(o.previous ?? null);
	const before = previousDigest(o.previous ?? null);
	let rows: V3Row[] = [];
	let prevIntents: V3Intent[] = [];
	let prevEvidence: string[] = [];
	let prevAt: string | undefined = before.at;
	const aliases0 = new Map<string, string>();
	const refresh = (r: V3Request): V3Request => {
		const hit = r.handle ? rawByHandle.get(r.handle) : undefined;
		return hit ? fromRaw(hit) : r;
	};
	if (prevV3) {
		rows = prevV3.rows.map((r) => ("range" in r ? { range: { ...r.range } } : { request: refresh(r.request) }));
		prevIntents = prevV3.intents;
		prevEvidence = [...prevV3.evidence];
		for (const [d, a] of prevV3.aliases) aliases0.set(d, a);
	} else if (prevV2) {
		rows = prevV2.epochs.flatMap((e) => e.requests).map((r: V2Request): V3Row =>
			r.archived
				? { range: { first: r.number, last: r.archived.last, kind: "digested" } }
				: { request: refresh({ number: r.number, ...(r.legacyNumber ? { legacyNumber: r.legacyNumber } : {}), ...(r.handle ? { handle: r.handle } : {}), text: r.text, ...(r.sourceIncomplete || r.emergencyExcerpt ? { sourceIncomplete: true } : {}) }) });
		prevIntents = prevV2.intents;
		prevEvidence = prevV2.epochs.flatMap((e) => e.evidence).filter((rec) => SELECTED_RE.test(rec));
		for (const [d, a] of prevV2.aliases) aliases0.set(d, a);
	} else if (o.previous) {
		const pp = parseSummary(o.previous);
		const at = branch.findIndex((e) => e?.id === sliceFirst);
		if (at >= 0 && raw.length) {
			const earlier = new Set(branch.slice(0, at).map((e) => e?.id));
			rows = raw.filter((r) => earlier.has(r.entryId)).map((r) => ({ request: fromRaw(r) }));
		} else {
			const nums = pp.users.nums ?? pp.users.items.map((_, i) => pp.users.omitted + i + 1);
			rows = pp.users.items.map((t, i) => ({ request: { number: 0, legacyNumber: nums[i], text: t, sourceIncomplete: true } }));
		}
		for (const [d, a] of pp.cmdAliases) aliases0.set(d, a);
	}
	// this slice's requests
	const seen = new Set(rows.flatMap((r) => ("request" in r && r.request.entryId ? [r.request.entryId] : [])));
	const seenHandles = new Set(rows.flatMap((r) => ("request" in r && r.request.handle ? [r.request.handle] : [])));
	let maxNo = rows.reduce((m, r) => Math.max(m, "range" in r ? r.range.last : r.request.number), 0);
	const posOf = new Map(branch.map((e, i) => [e?.id, i]));
	const startAt = sliceFirst !== undefined ? posOf.get(sliceFirst) : undefined;
	const startRequest = startAt !== undefined ? raw.reduce((n, r) => ((posOf.get(r.entryId) ?? Infinity) < startAt ? Math.max(n, r.number) : n), 0) : maxNo;
	const fresh: V3Request[] = [];
	for (const b of o.prefix) {
		if (b.kind !== "user") continue;
		const r = b.entryId ? rawById.get(b.entryId) : undefined;
		const id = r?.entryId ?? b.entryId ?? `user-${maxNo + 1}`;
		if (seen.has(id) || seenHandles.has(handleFor(id))) continue;
		seen.add(id);
		if (r) {
			fresh.push(fromRaw(r));
			maxNo = Math.max(maxNo, r.number);
			continue;
		}
		const content = (b.raw ?? b.msg)?.content;
		const nonText = Array.isArray(content) && content.some((x: Any) => x?.type && x.type !== "text");
		maxNo++;
		fresh.push({ number: maxNo, handle: handleFor(id), entryId: id, text: textOf(content) || (nonText ? "[non-text user content]" : "[empty user message]") });
	}
	rows.push(...fresh.map((r) => ({ request: r })));
	// requests show a Pi skill expansion as /skill:name plus the user's own text; recall returns the expansion
	rows = rows.map((r) => {
		if ("range" in r || r.request.sourceIncomplete || r.request.emergencyExcerpt) return r;
		const text = skillReference(r.request.text);
		return text === r.request.text ? r : { request: { ...r.request, text, skillReferences: true } };
	});
	// go-ahead-only requests: the model's judgement, limited to this slice's user requests of bounded length
	const freshByHandle = new Map(fresh.map((r) => [r.handle!, r]));
	const ack = new Set<string>();
	for (const h of o.acknowledgements ?? []) {
		const r = freshByHandle.get(h);
		if (r && r.text.length <= ACK_MAX_CHARS) ack.add(h);
	}
	rows = windowRows(rows, Infinity, ack, recallable);
	// the digest: the previous items with the model's operations applied; a failed call applies none
	const { digest, ...opStats } = applyDigestOps(before.digest, o.digestStale === undefined ? o.ops ?? [] : []);
	// intents: exact spans of this slice's requests or of the requests that previous intents quote (as the prompt says), taken from the
	// raw branch first (a digested request still holds the user's words). A request judged go-ahead only (now or by an earlier call) is
	// no source: assent alone states no intent. Without the source limit an older request with the same words would match instead.
	const ackNumbers = new Set(rows.flatMap((r) => ("range" in r && r.range.kind === "ack" ? Array.from({ length: r.range.last - r.range.first + 1 }, (_, i) => r.range.first + i) : [])));
	const live = (id: number | undefined) => (id && DIGEST_KEYS.some((k) => digest[k].some((i) => i.id === id)) ? id : undefined);
	let intents: V3Intent[] = prevIntents.map((i) => { const about = live(i.about); return { requestNumber: i.requestNumber, handle: i.handle, quote: i.quote, ...(about ? { about } : {}) }; });
	let quoteAccepted = 0, quoteRejected = 0, quoteAck = 0;
	if (o.proposedIntents) {
		const allowed = new Set([...fresh.map((r) => r.handle!), ...prevIntents.map((i) => i.handle)]);
		const candidates: V2Request[] = [
			...raw.map((r) => ({ number: r.number, handle: r.handle, text: r.text })),
			...rows.flatMap((r) => ("request" in r && r.request.number > 0 && r.request.handle && !rawByHandle.has(r.request.handle) && !r.request.sourceIncomplete && !r.request.emergencyExcerpt && !r.request.skillReferences ? [{ number: r.request.number, handle: r.request.handle, text: r.request.text }] : [])),
		].filter((r) => allowed.has(r.handle!));
		const ackOnly = candidates.filter((r) => ackNumbers.has(r.number));
		candidates.splice(0, candidates.length, ...candidates.filter((r) => !ackNumbers.has(r.number)));
		intents = [];
		const seenQuote = new Set<string>();
		for (const p of o.proposedIntents) {
			const [hit] = resolveIntents([p], candidates).intents;
			if (!hit) {
				quoteRejected++;
				if (resolveIntents([p], ackOnly).intents.length) quoteAck++;
				continue;
			}
			const key = `${hit.handle}\u0000${hit.quote}`;
			if (seenQuote.has(key)) continue;
			seenQuote.add(key);
			const about = live(p.about !== undefined ? opStats.assigned.get(p.about) ?? p.about : undefined);
			intents.push({ ...hit, ...(about ? { about } : {}) });
			quoteAccepted++;
		}
	}
	// evidence candidates: outputs the model selected (an exact quote) or that the digest names by handle or execution id. Other
	// outputs (status polls, todo updates, routine reads) are left to recall: no rule here guesses which output holds a conclusion.
	const text = digestText(digest);
	const selected = evidenceQuotes(o.prefix, o.proposedEvidence, V3_SELECT_EVIDENCE);
	const requestNumbers = new Map(fresh.filter((r) => r.entryId).map((r) => [r.entryId!, r.number]));
	const col = collectExecutions(o.prefix, { cwd: o.cwd, selectedEvidence: selected, priorIssuers: priorIssuers(branch, startAt), requestNumbers, startRequest });
	const aliases = cdAliases(bashCommands(o.prefix), aliases0);
	const fresher = col.records
		.filter((rec) => rec.results.some((r) => r.selectedQuote !== undefined || text.includes(r.handle)) || (!rec.orphan && mentions(text, rec.executionId)))
		.map((rec) => formatExecutionRecord(rec, aliases));
	const evidence = [...prevEvidence, ...fresher];
	const stale = o.digestStale;
	return {
		state: {
			digest,
			...(stale === undefined ? (o.digestAt ? { digestAt: o.digestAt } : {}) : { ...(prevAt ? { digestAt: prevAt } : {}), digestStale: stale }),
			intents,
			aliases,
			rows,
			evidence,
		},
		recent: Math.max(1, o.recent ?? V3_RECENT_REQUESTS),
		freshEvidence: fresher.length,
		recallable,
		stats: { ackProposed: o.acknowledgements?.length ?? 0, ackAccepted: ack.size, quoteAccepted, quoteRejected, quoteAck, evidenceNew: fresher.length },
		ops: opStats,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// fitting the room
// ---------------------------------------------------------------------------------------------------------------

export interface SummaryV3 {
	text: string;
	ok: boolean;
	reason?: "request-budget-overflow";
	overflow?: { requiredTokens: number; availableTokens: number };
	diagnostics: {
		formatVersion: "v3";
		numbering: "raw-branch-v2";
		requestCount: number;
		residentCount: number;
		digestedCount: number;
		ackCount: number;
		ackProposed: number;
		ackAccepted: number;
		quoteAccepted: number;
		quoteRejected: number;
		/** proposed quotes refused because their request was judged go-ahead only */
		quoteAck: number;
		intentsAbout: number;
		evidenceCount: number;
		evidenceNew: number;
		evidenceDropped: number;
		sectionsOmitted: number;
		intentsOmitted: number;
		digestItems: number;
		opsAdded: number;
		opsEdited: number;
		opsMoved: number;
		opsRejected: number;
		/** items the call dropped, with its reason (text clipped) */
		opsDropped: { id: number; reason: string; text: string }[];
		/** sections over V3_SECTION_CHARS after the call */
		sectionsOverBudget: DigestKey[];
		truncatedRequestCount: number;
		tokens: { digest: number; evidence: number; requests: number; intent: number; total: number };
	};
}

/**
 * Fit the prepared summary. The base is the digest, the intents, the newest `recent` substantive requests, this slice's evidence and
 * the evidence that the digest names. Up to `soft`, the free room is filled: older requests (newest first) take up to REQUEST_SHARE of
 * it, then the evidence carried from earlier summaries (newest first), then more requests.
 * Above `hard` (the most the compacted view can take), in this order: evidence (oldest first), the oldest resident requests that the
 * branch can return (they become digested ranges; the newest stays), the intent quotes, the digest sections (clipped, then omitted:
 * discarded, tests, architecture, decisions, open), then the resident requests are excerpted. If it still does not fit:
 * `request-budget-overflow`.
 */
export function renderSummaryV3(prep: PreparedV3, opts: { soft: number; hard: number; file?: FileRecall }): SummaryV3 {
	const s: V3State = { ...prep.state, digest: copyDigest(prep.state.digest), intents: [...prep.state.intents], rows: prep.state.rows.map((r) => ("range" in r ? { range: { ...r.range } } : { request: { ...r.request } })), evidence: [...prep.state.evidence] };
	const hard = Math.max(0, opts.hard), soft = Math.min(Math.max(0, opts.soft), hard);
	const size = () => tok4(renderV3(s, opts.file));
	const text = digestText(s.digest);
	const pool = prep.state.evidence;
	// the base holds what the digest names and this slice's records; older selected records fill the room after the first share of
	// requests, newest first
	const freshFrom = pool.length - prep.freshEvidence;
	const shown = new Set(pool.flatMap((rec, i) => (i >= freshFrom || recordPinned(rec, text) ? [i] : [])));
	const showEvidence = () => (s.evidence = pool.filter((_, i) => shown.has(i)));
	showEvidence();
	let recent = prep.recent;
	const window = (k: number) => (s.rows = windowRows(prep.state.rows, k, new Set(), prep.recallable));
	window(recent);
	const residents = () => s.rows.filter((r) => "request" in r).length;
	/** One more resident request while the summary stays within `limit`; false when none is left or it does not fit. */
	const growRequests = (limit: number) => {
		const before = residents();
		window(recent + 1);
		if (residents() > before && size() <= limit) return (recent++, true);
		window(recent);
		return false;
	};
	if (size() < soft) {
		const requestLimit = size() + Math.floor((soft - size()) * REQUEST_SHARE);
		while (growRequests(requestLimit));
		const order = pool.map((_, i) => i).filter((i) => !shown.has(i)).reverse();
		for (const i of order) {
			shown.add(i);
			showEvidence();
			if (size() > soft) {
				shown.delete(i);
				showEvidence();
			}
		}
		while (growRequests(soft));
	}
	while (s.evidence.length && size() > hard) s.evidence.shift();
	const evidenceDropped = pool.length - s.evidence.length;
	const eligible = (r: V3Request) => r.number > 0 && !r.legacyNumber && !!r.handle && prep.recallable.get(r.number) === r.handle;
	while (size() > hard) {
		const resident = s.rows.flatMap((r, i) => ("request" in r ? [i] : []));
		const i = resident.slice(0, -1).find((k) => eligible((s.rows[k] as { request: V3Request }).request));
		if (i === undefined) break;
		const n = (s.rows[i] as { request: V3Request }).request.number;
		s.rows[i] = { range: { first: n, last: n, kind: "digested" } };
		s.rows = compactRanges(s.rows);
	}
	let intentsOmitted = 0;
	if (size() > hard && s.intents.length) {
		intentsOmitted = s.intents.length;
		s.intents = [];
	}
	let sectionsOmitted = 0;
	for (const k of ["discarded", "tests", "architecture", "decisions", "open"] as const) {
		if (size() <= hard) break;
		if (!s.digest[k].length) continue;
		s.digest[k] = [{ id: 0, text: OMITTED }];
		sectionsOmitted++;
	}
	for (const r of s.rows) {
		if (size() <= hard) break;
		if (!("request" in r)) continue;
		const ex = formatRequestExcerpt(r.request.text, MIN_EXCERPT_CHARS, r.request.handle, opts.file);
		if (ex.truncated) r.request = { ...r.request, text: ex.text, emergencyExcerpt: r.request.emergencyExcerpt ?? { originalChars: r.request.text.length } };
	}
	const out = renderV3(s, opts.file);
	const total = tok4(out);
	const ranges = s.rows.flatMap((r) => ("range" in r ? [r.range] : []));
	const span = (g: V3Range) => g.last - g.first + 1;
	const ok = total <= hard;
	return {
		text: out,
		ok,
		...(ok ? {} : { reason: "request-budget-overflow" as const, overflow: { requiredTokens: total, availableTokens: hard } }),
		diagnostics: {
			formatVersion: "v3",
			numbering: "raw-branch-v2",
			requestCount: rowCount(s.rows),
			residentCount: s.rows.filter((r) => "request" in r).length,
			digestedCount: ranges.filter((g) => g.kind === "digested").reduce((n, g) => n + span(g), 0),
			ackCount: ranges.filter((g) => g.kind === "ack").reduce((n, g) => n + span(g), 0),
			ackProposed: prep.stats.ackProposed,
			ackAccepted: prep.stats.ackAccepted,
			quoteAccepted: prep.stats.quoteAccepted,
			quoteRejected: prep.stats.quoteRejected,
			quoteAck: prep.stats.quoteAck,
			intentsAbout: s.intents.filter((i) => i.about).length,
			evidenceCount: s.evidence.length,
			evidenceNew: prep.stats.evidenceNew,
			evidenceDropped,
			sectionsOmitted,
			intentsOmitted,
			digestItems: DIGEST_KEYS.reduce((n, k) => n + s.digest[k].filter((i) => i.id > 0).length, 0),
			opsAdded: prep.ops.added,
			opsEdited: prep.ops.edited,
			opsMoved: prep.ops.moved,
			opsRejected: prep.ops.rejected,
			opsDropped: prep.ops.dropped.map((d) => ({ id: d.id, reason: clip(d.reason, 200), text: clip(d.text, 120) })),
			sectionsOverBudget: DIGEST_KEYS.filter((k) => sectionChars(prep.state.digest[k]) > V3_SECTION_CHARS[k]),
			truncatedRequestCount: s.rows.filter((r) => "request" in r && r.request.emergencyExcerpt).length,
			tokens: {
				digest: tok4(digestText(s.digest)),
				evidence: tok4(s.evidence.join("\n")),
				requests: tok4(s.rows.map((r) => ("range" in r ? rangeRow(r.range, opts.file) : requestRow(r.request))).join("\n")),
				intent: tok4(s.intents.map((i) => i.quote).join("\n")),
				total,
			},
		},
	};
}

/** prepareV3 then renderSummaryV3, without a model call. */
export function buildSummaryV3(o: PrepareV3Options & { file?: FileRecall; maxSummaryTokens?: number; targetTokens?: number }): SummaryV3 {
	const hard = o.maxSummaryTokens ?? Infinity;
	return renderSummaryV3(prepareV3(o), { soft: o.targetTokens ?? Math.min(hard, V3_TARGET_TOKENS), hard, file: o.file });
}

// ---------------------------------------------------------------------------------------------------------------
// the narrative call
// ---------------------------------------------------------------------------------------------------------------

const REPLY_MARK = /^[\s#*_>`-]*(ARCHITECTURE|DECISIONS|DISCARDED|TESTS|OPEN|INTENT|ACKNOWLEDGEMENTS|EVIDENCE)\b[\s#*_:`-]*$/i;
/** One digest operation: ADD iN: text | EDIT iN: text | MOVE iN: [text] | DROP iN: reason (a list marker before it is allowed; the
 *  number may be written #N or N too). */
const OP_RE = /^\s{0,1}(?:[-*]\s+)?(ADD|EDIT|MOVE|DROP)(?:\s+\[?(?:i|#)?(\d+)\]?)?\s*:\s*(.*)$/;

export interface V3Reply {
	ops: DigestOp[];
	/** lines under a digest section that are neither an operation, a continuation nor (none); they change nothing */
	malformed: number;
	intent?: { quote: string; about?: number }[];
	acknowledgements: string[];
	evidence: EvidenceProposal[];
}

/** The parts of a v3 narrative reply. null: the reply has no section marker (it cannot be told which section a line belongs to).
 *  Digest operations keep the order of the reply (an ADD's number may be asked for, and intents may refer to it). */
export function parseV3Reply(text: string): V3Reply | null {
	const parts = new Map<string, string[]>();
	const ops: DigestOp[] = [];
	let malformed = 0, sec = "", cur: DigestOp | null = null;
	const keyOf = new Map(DIGEST_KEYS.map((k) => [MARKERS[k], k]));
	for (const l of text.split("\n")) {
		const mark = REPLY_MARK.exec(l);
		if (mark) {
			sec = mark[1].toUpperCase();
			if (!parts.has(sec)) parts.set(sec, []);
			cur = null;
			continue;
		}
		if (!sec) continue;
		parts.get(sec)!.push(l);
		const k = keyOf.get(sec);
		if (!k) continue;
		const m = OP_RE.exec(l);
		if (m) {
			const verb = m[1], id = m[2] ? Number(m[2]) : 0, rest = m[3].trim();
			cur = verb === "ADD" ? { op: "add", section: k, text: rest, ...(id ? { id } : {}) }
				: !id ? null
				: verb === "EDIT" ? { op: "edit", id, text: rest }
				: verb === "MOVE" ? { op: "move", id, section: k, ...(rest ? { text: rest } : {}) }
				: { op: "drop", id, reason: rest };
			if (cur) ops.push(cur);
			else malformed++;
		} else if (/^\s{2,}\S/.test(l) && cur) {
			if (cur.op === "drop") cur.reason += ` ${l.trim()}`;
			else cur.text = cur.text === undefined ? l.trim() : `${cur.text}\n${l.trim()}`;
		} else if (l.trim() && !/^\(?none\.?\)?\.?$/i.test(l.trim())) {
			malformed++;
			cur = null;
		}
	}
	if (!parts.size) return null;
	const evidence: EvidenceProposal[] = [];
	for (const l of parts.get("EVIDENCE") ?? []) {
		try {
			const p = JSON.parse(l);
			if (typeof p?.sourceHandle === "string" && typeof p?.quote === "string") evidence.push({ sourceHandle: p.sourceHandle, quote: p.quote });
		} catch { /* a malformed proposal adds no record */ }
	}
	const acknowledgements = [...new Set((parts.get("ACKNOWLEDGEMENTS") ?? []).flatMap((l) => [...l.matchAll(/(?<![0-9a-z])[0-9a-z]{10}(?![0-9a-z])/g)].map((m) => m[0])))];
	return { ops, malformed, ...(parts.has("INTENT") ? { intent: intentsOf(parts.get("INTENT")!) } : {}), acknowledgements, evidence };
}

/** INTENT lines: - "exact words" → iN (the arrow and number are optional). */
export function intentsOf(lines: readonly string[]): { quote: string; about?: number }[] {
	return lines.flatMap((l) => {
		const m = /^(.*?)\s*(?:→|->|=>)\s*\[?(?:i|#)(\d+)\]?\s*$/.exec(l);
		const [q] = intentQuotesOf([m ? m[1] : l]);
		return q ? [{ quote: q, ...(m ? { about: Number(m[2]) } : {}) }] : [];
	});
}

/** The prompt of the v3 narrative call. */
export function v3Prompt(conversation: string, previous: Digest, previousIntents: readonly string[], budgets: Readonly<Record<DigestKey, number>> = V3_SECTION_CHARS): string {
	const hasItems = DIGEST_KEYS.some((k) => previous[k].some((i) => i.id > 0));
	const next = maxItemId(previous) + 1;
	const sizeNote = (k: DigestKey) => {
		const n = sectionChars(previous[k]), b = budgets[k];
		return n > b ? ` (${n} of ${b} characters: OVER BUDGET, merge items)` : ` (${n} of ${b} characters)`;
	};
	const prevBlock = hasItems
		? `<previous-digest>\n${DIGEST_KEYS.map((k) => `---${MARKERS[k]}---${sizeNote(k)}\n${previous[k].filter((i) => i.id > 0).flatMap(itemLines).join("\n") || NONE}`).join("\n")}\n</previous-digest>\n\n`
		: "";
	return (
		prevBlock +
		(previousIntents.length ? `<previous-intent>\n${previousIntents.map((q) => `- "${q}"`).join("\n")}\n</previous-intent>\n\n` : "") +
		`<conversation>\n${conversation}\n</conversation>\n\n` +
		`Update the STATE DIGEST of a long coding session. <previous-digest> (when present) covers everything before this conversation slice; ` +
		`after this summary the next model sees earlier conversation only through this digest, the newest user requests and recall by handle. ` +
		`The code keeps every item of <previous-digest> word for word unless you name it in an operation, so do not restate unchanged items. ` +
		`Under each section marker write only operations, one per line; a longer text may continue on lines indented by two spaces:\n` +
		`ADD iN: <text> (a new item in this section; number new items i${next}, i${next + 1}, … in the order you write them)\n` +
		`EDIT iN: <full new text> (replace the text of item iN; it stays in its section)\n` +
		`MOVE iN: <optional new text> (move item iN into this section, for example a decision that this slice showed to fail moves to DISCARDED with the reason)\n` +
		`DROP iN: <reason> (remove item iN, only when this slice shows that it is completed, superseded or wrong, or when you merged it into another item: ` +
		`then write "merged into iM". The reason says what in this slice shows it. Silence is not completion.)\n` +
		`When this slice changes a value or a claim that an item states, EDIT that item (or DROP it as superseded by the new one); never ADD a ` +
		`second item that contradicts it. When two items say the same thing, merge them. Item numbers are written iN; a #N in item text is ` +
		`the session's own issue or task number. Write facts that stay true when read later: no relative words such as "this slice", "now" ` +
		`or "latest"; name the commit, the date or the request instead.\n` +
		`Write (none) under a section without an operation. In a section marked OVER BUDGET, merge related items (EDIT one so that it covers them, ` +
		`DROP the others as merged into it) until it fits; never drop a fact only to save space. ` +
		`Each item states one current fact, decision or task in at most ${ITEM_MAX_CHARS} characters; it is not a diary entry and not a record of ` +
		`acknowledgements. Never use a bare identifier (a test case or benchmark number, a request number, a model or run code) without a clause ` +
		`that says what it denotes. A separate deterministic section keeps the newest user requests verbatim and the selected tool evidence, so do ` +
		`not copy them. A finding that rests on a tool output names it by tool and exact command or path, or by its source label. Output format:\n` +
		`---ARCHITECTURE---\n(operations on: the system as it stands now: components, key files and what each does, data flow)\n` +
		`---DECISIONS---\n(operations on: settled decisions with a one-line rationale, user rulings and constraints, invariants, causes established by evidence, exact values later work depends on)\n` +
		`---DISCARDED---\n(operations on: approaches that were tried and failed, or that the user rejected, each with the reason, so that later work does not retry them)\n` +
		`---TESTS---\n(operations on: verification status: the newest full-suite totals with the command; which failures existed before the work (baseline) and which are new regressions; "unknown" for what the conversation does not show)\n` +
		`---OPEN---\n(operations on: still-open todos, next steps and blockers; drop one only when this slice shows it completed or superseded)\n` +
		`---INTENT---\n(the user's own words that state what the user wants now: copy each quote character for character from a user message in this ` +
		`conversation slice or from <previous-intent>, keeping a previous one only while it still applies. One per line as - "exact words" → iN, ` +
		`where iN is the digest item (a previous one or one you ADD in this reply) that says what the words are about, for example the open task ` +
		`they ask for; leave out "→ iN" only when no item fits. Never quote a request that you list under ACKNOWLEDGEMENTS: when the user only ` +
		`approved a proposal, ADD or EDIT an OPEN item that names what was approved and the request number. At most 6; never quote assistant ` +
		`text or tool output; write (none) if none)\n` +
		`---ACKNOWLEDGEMENTS---\n(the source labels of user requests in this slice whose whole content is assent or a go-ahead to continue: no new ` +
		`instruction, constraint, question, correction, choice or information. Judge by meaning, in any language. A message such as "ok, but do not ` +
		`commit" is not one. When unsure, leave the request out. One label per line as - <label>; (none) if none)\n` +
		`---EVIDENCE---\n(select at most ${V3_SELECT_EVIDENCE} tool results that support the digest: final verification results, outputs that a finding rests ` +
		`on, still-open blockers, commits. Only these and outputs that an item names by source label are listed; every other output stays ` +
		`recallable. Never select status polls, progress checks, task-list updates or reads that show no result. Prefer the final ` +
		`verification for each distinct scope over intermediate attempts. A nonzero exit alone does not prove an ` +
		`unresolved blocker. Each line must be JSON: {"sourceHandle":"the tool output source label","quote":"exact evidence span, at most 200 ` +
		`characters"}. Use only tool output in this slice. Do not invent sources or paraphrase quotes. Write (none) if none.)\n` +
		`Be concrete and keep exact paths, names and numbers. Do not call tools.\n\n` +
		REASONING_QUALIFICATION
	);
}

/** The conversation as the v3 call reads it: each user request, assistant message and tool output starts with its source label. */
export function labelledMessages(prefix: Block[], numbers: ReadonlyMap<string, number>): Any[] {
	return prefix
		.filter((b) => b.kind !== "summary")
		.map((b) => {
			const msg = b.raw && !(b.edited && !b.ours) ? b.raw : b.msg;
			if (!b.entryId || (b.kind !== "user" && b.kind !== "assistant" && (b.kind !== "toolResult" || msg.toolName === RECALL_TOOL))) return msg;
			const n = numbers.get(b.entryId);
			const label = b.kind === "user" ? `[user request${n ? ` R${n}` : ""} source: ${handleFor(b.entryId)}]` : `[${b.kind === "assistant" ? "assistant" : "tool output"} source: ${handleFor(b.entryId)}]`;
			const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: textOf(msg.content) }];
			return { ...msg, content: [{ type: "text", text: label }, ...content] };
		});
}

/** The cold summary in format v3 for a planned cut: one narrative call, no tier merges. */
export async function buildCutV3(p: PlanResult, ctx: Any, signal?: AbortSignal): Promise<Cut> {
	const t0 = performance.now();
	const prefix = p.blocks.slice(0, p.cutIdx!);
	const prev = prefix[0]?.kind === "summary" ? String(prefix[0].msg.summary ?? "") || null : null;
	const slice = prefix.filter((b) => b.kind !== "summary");
	const branch: Any[] = attempt(() => ctx?.sessionManager?.getBranch?.() ?? [], []);
	const numbers = new Map(branchRequests(branch).map((r) => [r.entryId, r.number]));
	const before = previousDigest(prev);
	let lastAt = 0;
	for (const b of slice) lastAt = Math.max(lastAt, blockTime(b) ?? 0);
	const nowWhen = lastAt > 0 ? fmtWhen(lastAt) : undefined;
	let reply: V3Reply | null = null, error: string | undefined, costUsd = 0, usage: Any;
	if (!ctx.model) error = "no current model";
	else {
		let conv: string | null = null;
		try {
			conv = await serialize(reasoningInput(labelledMessages(slice, numbers)).messages);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		if (conv !== null) {
			const r = await complete(ctx, v3Prompt(conv, before.digest, before.intents), signal);
			costUsd = r.costUsd;
			usage = addUsage(undefined, r.usage);
			if (!r.ok || !r.text) error = r.error ?? "empty narrative";
			else {
				reply = parseV3Reply(r.text);
				if (!reply) error = "reply without section markers";
			}
		}
	}
	const prep = prepareV3({
		prefix: slice,
		previous: prev,
		branch,
		cwd: ctx?.cwd ?? ".",
		...(reply
			? {
					ops: reply.ops,
					...(nowWhen ? { digestAt: nowWhen } : {}),
					...(reply.intent ? { proposedIntents: reply.intent.map((i) => ({ ...i, role: "user" })) } : {}),
					proposedEvidence: reply.evidence,
					acknowledgements: reply.acknowledgements,
				}
			: { digestStale: error ?? "n/a" }),
	});
	const out = renderSummaryV3(prep, { soft: Math.min(p.summaryTokensPlanned, V3_TARGET_TOKENS), hard: p.summaryRoomTokens ?? Infinity, file: p.fileRecall });
	return {
		firstKeptEntryId: p.blocks[p.cutIdx!].entryId!,
		text: out.text,
		trigger: p.sumTrigger ?? "cold",
		count: out.diagnostics.requestCount,
		prefixTokens: p.prefixTokens,
		summaryTokens: tok4(out.text),
		llmOk: !!reply,
		llmError: reply ? null : error ?? null,
		costUsd,
		usage,
		ms: Math.round(performance.now() - t0),
		// A summary over the room is still used, never failed as request-budget-overflow (format v2 fails closed to keep its verbatim
		// requests). Over the room, everything above the minimal form is already dropped and every request stays recallable, so what is
		// left is the newest request and the headers; the room is then exceeded by the kept part of the view, which no summary size can
		// fix. Replacing the prefix with this summary still shrinks the view; failing would keep the whole prefix and waste the call.
		summaryDiagnostics: { ...out.diagnostics, ...(reply ? { opsMalformed: reply.malformed } : {}), ...(out.overflow ? { overRoom: out.overflow } : {}) } as unknown as Record<string, unknown>,
	};
}
