// Candidate search over the opened session's ledger, scoped to the active branch. What is searched is the assistant's earlier
// conclusions (its final answer of each user turn) and hidden tool outputs on the active branch, combined with referential graph
// traversal (file paths and code symbols in the prompt linked via tool call arguments and identifiers). Mid-turn assistant text and
// sibling branches are excluded.
import { handleFor, handleTokens } from "../handle.ts";
import type { Db } from "../ledger/db.ts";
import { CHUNK_CHARS, ftsSearchScoped, type Hit, matchExpr, setSearchScope } from "../ledger/fts.ts";
import { textBlocks } from "../ledger/source.ts";
import { outcomeHint } from "../outcome.ts";
import type { Any } from "../util.ts";


/** Folded-output marker of pi-zip placeholders (placeholder.ts PH_MARK; repeated here so retrieval stays free of the folding stack). */
const FOLD_MARK = "[folded by pi-zip";

export interface Scope {
	/** Entry ids on the active branch (the leaf's ancestry). Anything else (sibling branches) is never a candidate. */
	branch: Set<string>;
	/** Entries the request already shows in full: their facts are in context, so they are not repeated. */
	visible: Set<string>;
	/** Entries whose message the model view replaced with pi-zip's fold placeholder: earlier output the model can no longer read. */
	folded: Set<string>;
	/** The branch has a compaction: the messages it replaced are no longer in the model view either. */
	compacted: boolean;
	/** Positive evidence of hiding, with visible entries excluded. Absence alone is not enough. */
	hidden: Map<string, "folded" | "compacted">;
	/** Conclusion entry id -> the user request it answered. Only a completed text answer without tool calls qualifies; subsequent
	 *  assistant/tool work in the same turn invalidates it until a new completed answer arrives. */
	conclusions: Map<string, string>;
	/** Source entry by id (canonical session entries). */
	entry: (id: string) => Any | undefined;
}

export interface Evidence {
	ref: string; // E1, E2, ... in rank order
	handle: string; // handleFor(entryId): resolves with zip_recall for tool results, user requests and assistant text
	entryId: string;
	hidden: "folded" | "compacted";
	kind: string; // user | assistant | thinking | tool_call | tool_result | custom | segment
	tool: string | null;
	title: string;
	excerpt: string;
	/** Source-ordered passages, kept separate so packing can share text and budget each passage without splitting it. */
	passages?: string[];
	/** A tool result's whole-output outcome ("exit 1, 21 passed, 1 failed"), read from the full output, not the excerpt. */
	outcome: string;
	isError: boolean;
	/** A tool result the current request does not show in full (folded by pi-zip or compacted away): zip_recall gives it back. */
	folded: boolean;
	/** How many of the prompt's own tokens this candidate contains (informational: it does not gate anything). */
	matched: number;
	exact: boolean;
	context: string[];
	seq: number;
	/** When the entry was written (ms since epoch), 0 when the entry has no timestamp. */
	at: number;
}

/** `ftsRows`: FTS rows read per prompt, after the active-branch hidden scope filter. */
export interface SearchLimits { candidates: number; expand: number; excerptChars: number; ftsRows: number }
export const DEFAULT_LIMITS: SearchLimits = { candidates: 8, expand: 6, excerptChars: 1500, ftsRows: 400 };

/** Diacritics removed, for comparison only: "tiếp tục" -> "tiep tuc", "đ" -> "d". */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");

const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** Normalized words for suppressing repeated passages within one source entry, never across executions. */
function excerptKey(text: string): string {
	return (fold(text.toLowerCase()).match(WORD_RE) ?? []).join(" ");
}

/** How many of `tokens` occur in `text` (both folded). */
export function matchedOf(tokens: string[], text: string): number {
	if (!tokens.length) return 0;
	const words = new Set(fold(text.toLowerCase()).match(WORD_RE) ?? []);
	return tokens.filter((w) => words.has(fold(w))).length;
}

/** The first text document of each entry a handle names, in the order the handles were written. */
function handleDocs(db: Db, handles: string[]): Hit[] {
	const out: Hit[] = [];
	for (const h of handles) {
		const ev = db.prepare("SELECT entry_id FROM events_seen WHERE source_handle = ? LIMIT 1").get(h);
		const entryId = ev ? String(ev.entry_id) : "";
		if (!entryId) continue;
		const row = db.prepare("SELECT d.*, 0 AS rank FROM search_docs d WHERE d.entry_id = ? AND d.object_type = 'chunk' ORDER BY d.block_index, d.chunk_index LIMIT 1").get(entryId);
		if (row) out.push(row as Hit);
	}
	return out;
}

/** The text of one source block slice, read from the session entry by pointer (not from the index). */
function sourceSlice(e: Any, blockIndex: number | null, charStart: number | null): string {
	const b = textBlocks(e).find((x) => x.blockIndex === blockIndex);
	if (!b) return "";
	const start = charStart ?? 0;
	return b.text.slice(start, start + CHUNK_CHARS);
}

/**
 * About `n` characters anchored around the densest / most specific query-term match in `text` (whole text when it fits). Weighting
 * distinct matched terms by length and local rarity prevents a common query word near offset 0 from displacing the specific passage.
 */
export function window(text: string, terms: string[], n: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= n) return flat;
	const want = new Set(terms.map((t) => fold(t.toLowerCase())));
	const hits: Array<{ at: number; len: number; term: string }> = [];
	const tf = new Map<string, number>();
	for (const m of flat.matchAll(WORD_RE)) {
		const w = fold(m[0].toLowerCase());
		if (want.has(w)) {
			hits.push({ at: m.index ?? 0, len: m[0].length, term: w });
			tf.set(w, (tf.get(w) ?? 0) + 1);
		}
	}
	const lead = Math.min(80, Math.floor(n / 3));
	if (!hits.length) {
		const low = flat.toLowerCase();
		let at = -1;
		for (const w of terms) {
			const i = low.indexOf(w.toLowerCase());
			if (i >= 0 && (at < 0 || i < at)) at = i;
		}
		const start = Math.max(0, Math.min(flat.length - n, (at < 0 ? 0 : at) - lead));
		return `${start > 0 ? "…" : ""}${flat.slice(start, start + n)}${start + n < flat.length ? "…" : ""}`;
	}
	const weight = (t: string) => Math.max(1, Math.min(8, t.length)) / Math.sqrt(tf.get(t) ?? 1);
	const counts = new Map<string, number>();
	let lo = 0, hi = 0, score = 0;
	let best = { score: -1, start: 0 };
	for (const anchor of hits) {
		const start = Math.max(0, Math.min(flat.length - n, anchor.at - lead));
		while (hi < hits.length && hits[hi].at + hits[hi].len <= start + n) {
			const c = counts.get(hits[hi].term) ?? 0;
			if (c === 0) score += weight(hits[hi].term);
			counts.set(hits[hi].term, c + 1);
			hi++;
		}
		while (lo < hi && hits[lo].at < start) {
			const c = (counts.get(hits[lo].term) ?? 1) - 1;
			if (c === 0) score -= weight(hits[lo].term);
			counts.set(hits[lo].term, c);
			lo++;
		}
		if (score > best.score + 1e-9) best = { score, start };
	}
	return `${best.start > 0 ? "…" : ""}${flat.slice(best.start, best.start + n)}${best.start + n < flat.length ? "…" : ""}`;
}

/** Hard query budget, including callers that construct Query directly. Paths and symbols each get six lookups at most. */
export const GRAPH_REFERENCE_LIMIT = 6;
const graphPath = (p: string) => p.replace(/^@/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function boundedReferences(values: string[], path: boolean): string[] {
	const out = new Set<string>();
	for (const value of values) {
		const ref = path ? graphPath(value) : value.toLowerCase();
		if (ref.length >= (path ? 3 : 4) && ref.length <= 1024) out.add(ref);
		if (out.size >= GRAPH_REFERENCE_LIMIT) break;
	}
	return [...out];
}

/** Prefer explicit inline references and the end of the request outside fenced code over pasted code/diffs. */
export function promptReferences(text: string): { paths: string[]; symbols: string[] } {
	const prose = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, " ");
	const inline = [...prose.matchAll(/`([^`\n]+)`|@[^\s`]+/g)].map((m) => m[1] ?? m[0]).join("\n");
	const paths: string[] = [], symbols: string[] = [];
	for (const part of [inline, prose, text]) {
		const normalized = part.replace(/\\/g, "/");
		const pathPattern = /@?(?:[A-Za-z]:)?\/?[\w.-]+\/[\w./-]+|@?[\w.-]+\.(?:ts|js|py|sh|yml|yaml|json|md|sql|toml)\b/gi;
		paths.push(...(normalized.match(pathPattern) ?? []).reverse());
		const withoutPaths = normalized.replace(pathPattern, " ");
		symbols.push(...(withoutPaths.match(/\b[a-zA-Z_]\w*_[a-zA-Z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b/g) ?? []).reverse());
	}
	return { paths: boundedReferences(paths, true), symbols: boundedReferences(symbols, false) };
}

/** A loaded skill arrives inside the prompt as a <skill ...>...</skill> block: its text is the skill file, not the user's request. */
export const userText = (prompt: string) => prompt.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, " ").trim();

/**
 * Query size: QUERY_HEAD distinct tokens from the start of the prompt and QUERY_TAIL from its end (the actual request of a long prompt
 * often comes after pasted logs or code). Measured on a real session: 128 tokens cost ~15 ms of FTS, all 495 of a 7 KB prompt ~40 ms,
 * and BM25 keeps ranking by the rare tokens, so the cap only decides which words are searched, not the cost.
 */
export const QUERY_HEAD = 32, QUERY_TAIL = 96;

/** The query of one prompt, from the user's own words. Nothing is filtered by language (no stopwords). */
export interface Query { tokens: string[]; handles: string[]; paths?: string[]; symbols?: string[] }
export function queryOf(prompt: string): Query {
	const own = userText(prompt);
	const refs = promptReferences(own);
	const words = [...new Set(own.toLowerCase().match(WORD_RE) ?? [])]; // distinct, first-occurrence order
	if (words.length <= QUERY_HEAD + QUERY_TAIL) return { tokens: words, handles: [...new Set(handleTokens(own))], ...refs };
	// head: the first distinct words; tail: the distinct words nearest the end, in prompt order, none repeated from the head
	const head = words.slice(0, QUERY_HEAD), inHead = new Set(head);
	const tail: string[] = [];
	const all = own.toLowerCase().match(WORD_RE) ?? [];
	const seen = new Set<string>();
	for (let i = all.length - 1; i >= 0 && tail.length < QUERY_TAIL; i--) {
		const w = all[i];
		if (inHead.has(w) || seen.has(w)) continue;
		seen.add(w);
		tail.push(w);
	}
	return { tokens: [...head, ...tail.reverse()], handles: [...new Set(handleTokens(own))], ...refs };
}

/** FTS rows kept per entry before LIMIT, so ranking spreads over entries rather than chunks of one long output. */
const PER_ENTRY_ROWS = 3;
/** Graph traversal bounds: entries per path or symbol, chunks per entry. */
const GRAPH_ENTRIES = 3, GRAPH_CHUNKS = 2;
const HIT_COLS = "d.id, d.object_type, d.object_id, d.entry_id, d.block_index, d.chunk_index, d.char_start, d.segment_id, d.kind, d.tool, d.is_error, d.title, d.body, d.identifiers, d.seq";
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ftsPhrase = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Hidden tool-output entries reached from the prompt's file paths and code symbols, without reading output text into memory:
 * file nodes are matched by key (a path suffix scans file nodes only, one row per distinct file), the rest goes through indexes.
 * - path -> `file` node (exact key or path suffix) -> `touches_file` <- tool call -> `answered_by` -> result entry; when no recorded
 *   call touched it (a renamed copy, a file read through a shell), a phrase match on the file name in the scoped FTS stands in;
 * - symbol -> scoped FTS phrase in the output body or identifiers (the call title need not contain it).
 * Several matching entries per reference are kept (newest first, reads first), and from each entry the chunks that best match the
 * prompt, or its first chunk when none does. Requires `search_scope` to hold the eligible entries.
 */
function graphCandidates(db: Db, q: Query, lexical: Hit[]): Hit[] {
	const paths = boundedReferences(q.paths ?? [], true), symbols = boundedReferences(q.symbols ?? [], false);
	if (!paths.length && !symbols.length) return [];
	const out: Hit[] = [];
	const seen = new Set<string>();
	const add = (h: Hit) => {
		const id = String(h.object_id);
		if (!seen.has(id) && out.length < 30) { seen.add(id); out.push(h); }
	};
	const bestByEntry = new Map<string, Hit[]>();
	for (const h of lexical) {
		const list = bestByEntry.get(String(h.entry_id)) ?? [];
		if (list.length < GRAPH_CHUNKS) list.push(h);
		bestByEntry.set(String(h.entry_id), list);
	}
	const firstChunks = db.prepare(
		`SELECT ${HIT_COLS}, 0 AS rank FROM search_docs d WHERE d.entry_id = ? AND d.object_type = 'chunk' AND d.kind = 'tool_result'
		 ORDER BY d.block_index, d.chunk_index LIMIT ?`,
	);
	const addEntry = (entryId: string) => {
		const best = bestByEntry.get(entryId) ?? [];
		for (const h of best) add(h);
		if (best.length < GRAPH_CHUNKS) {
			for (const h of firstChunks.all(entryId, GRAPH_CHUNKS) as Hit[]) {
				if (out.length >= 30) break;
				add(h);
			}
		}
	};
	const byFile = db.prepare(
		`SELECT DISTINCT r.entry_id AS entry_id, MAX(r.tool = 'read') AS is_read, MAX(r.seq) AS seq
		 FROM nodes f
		 JOIN edges t ON t.dst_id = f.id AND t.type = 'touches_file'
		 JOIN edges a ON a.src_id = t.src_id AND a.type = 'answered_by'
		 JOIN search_docs r ON r.entry_id = substr(a.dst_id, 7) AND r.object_type = 'chunk' AND r.kind = 'tool_result'
		 JOIN search_scope s ON s.entry_id = r.entry_id
		 WHERE f.kind = 'file' AND (replace(f.canonical_key, char(92), '/') = ? COLLATE NOCASE
		 OR replace(f.canonical_key, char(92), '/') LIKE ? ESCAPE '\\')
		 GROUP BY r.entry_id ORDER BY is_read DESC, seq DESC LIMIT ?`,
	);
	// Normalize separators at lookup, including legacy Windows keys: no projection change or database rebuild needed.
	for (const ref of paths) {
		if (out.length >= 30) break;
		const base = ref.split("/").pop() ?? "";
		if (base.length < 3) continue;
		const entries = (byFile.all(ref, `%/${likeEscape(ref)}`, GRAPH_ENTRIES) as Array<{ entry_id: string }>).map((r) => String(r.entry_id));
		if (!entries.length) {
			// No recorded call touched this path: the file name as a phrase (identifiers, call title, then body) stands in.
			for (const h of ftsSearchScoped(db, ftsPhrase(base), GRAPH_ENTRIES, ["tool_result"], 1)) entries.push(String(h.entry_id));
		}
		for (const id of entries) addEntry(id);
	}
	for (const sym of symbols) {
		if (out.length >= 30) break;
		const hits = ftsSearchScoped(db, `{body identifiers} : ${ftsPhrase(sym)}`, GRAPH_ENTRIES * GRAPH_CHUNKS, ["tool_result"], GRAPH_CHUNKS);
		hits.sort((a, b) => Number(b.seq) - Number(a.seq) || a.rank - b.rank);
		for (const h of hits) add(h);
	}
	return out;
}

function fuseChannels(...lists: string[][]): string[] {
	const sums = new Map<string, number>();
	for (const list of lists) {
		list.forEach((id, i) => sums.set(id, (sums.get(id) ?? 0) + 1 / (60 + i + 1)));
	}
	return [...sums].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/**
 * Hidden conclusions and tool outputs on the active branch that match the prompt (via FTS5 and referential graph traversal over file
 * paths / code symbols), best first; plus, first, every hidden entry whose handle the prompt names (each kept on its own, also several
 * from one step). Multi-chunk matches on a chosen entry merge up to 3 passages. The model decides which items are needed.
 */
export function retrieve(db: Db, q: Query, scope: Scope, limits: SearchLimits = DEFAULT_LIMITS): { evidence: Evidence[]; hits: number; inBranch: number } {
	const tokens = q.tokens;
	const match = matchExpr(tokens);
	const usable = (id: string) => scope.branch.has(id) && scope.hidden.has(id) && !scope.visible.has(id);
	const isToolOutput = (id: string) => {
		const e = scope.entry(id);
		return e?.message?.role === "toolResult" || e?.type === "bashExecution";
	};
	// A handle in the prompt names one entry: resolve it through the ledger, not through the text (a handle appears in no document).
	const named = handleDocs(db, q.handles).filter((h) => h.entry_id && usable(h.entry_id));
	const eligible = [
		...new Set([
			...[...scope.conclusions.keys()].filter(usable),
			...[...scope.hidden.keys()].filter((id) => usable(id) && isToolOutput(id)),
		]),
	];
	// One scope for every query below: SQL filters to the hidden active-branch entries before ranking and LIMIT.
	setSearchScope(db, eligible);
	// At most PER_ENTRY_ROWS chunks per entry: a few long outputs matching on every chunk cannot fill all rows.
	const hits = match ? ftsSearchScoped(db, match, limits.ftsRows, ["assistant", "tool_result"], PER_ENTRY_ROWS) : [];
	const byObj = new Map<string, Hit>(hits.map((h) => [String(h.object_id), h]));

	// Referential graph traversal: file paths and code symbols in the prompt -> hidden tool outputs, through indexed SQL only.
	const graphList = eligible.length ? graphCandidates(db, q, hits) : [];
	for (const h of graphList) if (!byObj.has(String(h.object_id))) byObj.set(String(h.object_id), h);
	const graphIds = graphList.map((h) => String(h.object_id));

	const lexicalIds = hits.slice(0, 40).map((h) => String(h.object_id));
	const fusedIds = graphIds.length
		? [...fuseChannels(lexicalIds, graphIds), ...hits.slice(40).map((h) => String(h.object_id)).filter((id) => !graphIds.includes(id))]
		: hits.map((h) => String(h.object_id));
	// Identical excerpts from separate executions can hide different outcomes or dates; keep their handles independently.
	const dedupKey = (h: Hit, excerpt: string) => {
		const content = excerptKey(excerpt);
		return content ? `${h.entry_id}\u0000${content}` : "";
	};

	const sliceText = (h: Hit, exact: boolean): string => {
		const entryId = h.entry_id!;
		const e = scope.entry(entryId);
		const isConclusion = scope.conclusions.has(entryId);
		return isConclusion && exact
			? textBlocks(e).filter((b) => b.kind === "assistant").map((b) => b.text).join("\n")
			: sourceSlice(e, h.block_index, h.char_start) || h.body;
	};

	const picked = new Map<string, { hit: Hit; exact: boolean; passages: Array<{ blockIndex: number; chunkIndex: number; excerpt: string; text: string }> }>();
	const seenExcerpts = new Set<string>();

	for (const hit of named) {
		const entryId = hit.entry_id!;
		if (picked.has(entryId)) continue;
		const text = sliceText(hit, true);
		const excerpt = window(text, tokens, limits.excerptChars);
		const key = dedupKey(hit, excerpt);
		if (key) seenExcerpts.add(key);
		picked.set(entryId, { hit, exact: true, passages: [{ blockIndex: Number(hit.block_index ?? 0), chunkIndex: Number(hit.chunk_index ?? 0), excerpt, text }] });
	}

	// Pass 1: pick up to limits.candidates distinct source entries from the fused ranking.
	for (const objId of fusedIds) {
		if (picked.size >= limits.candidates + named.length) break;
		const hit = byObj.get(objId);
		if (!hit?.entry_id || picked.has(hit.entry_id)) continue;
		const text = sliceText(hit, false);
		const excerpt = window(text, tokens, limits.excerptChars);
		const key = dedupKey(hit, excerpt);
		if (!key || seenExcerpts.has(key)) continue;
		seenExcerpts.add(key);
		picked.set(hit.entry_id, { hit, exact: false, passages: [{ blockIndex: Number(hit.block_index ?? 0), chunkIndex: Number(hit.chunk_index ?? 0), excerpt, text }] });
	}

	// Pass 2: attach up to 2 additional matching chunks for chosen tool_result entries from the top fused candidates.
	if (limits.excerptChars >= 1200) {
		const subWindow = Math.min(1200, limits.excerptChars);
		for (const objId of fusedIds.slice(0, 16)) {
			const hit = byObj.get(objId);
			if (!hit?.entry_id || scope.conclusions.has(hit.entry_id)) continue;
			const cur = picked.get(hit.entry_id);
			if (!cur || cur.exact || cur.passages.length >= 3) continue;
			const bi = Number(hit.block_index ?? 0), ci = Number(hit.chunk_index ?? 0);
			if (cur.passages.some((p) => p.blockIndex === bi && p.chunkIndex === ci)) continue;
			const text = sliceText(hit, false);
			const excerpt = window(text, tokens, subWindow);
			const key = dedupKey(hit, excerpt);
			if (!key || seenExcerpts.has(key)) continue;
			seenExcerpts.add(key);
			cur.passages.push({ blockIndex: bi, chunkIndex: ci, excerpt, text });
		}
	}

	const ranked = [...picked.values()].slice(0, Math.max(limits.candidates, named.length));
	const evidence = ranked.map((c, i): Evidence => {
		const h = c.hit, entryId = h.entry_id!;
		const e = scope.entry(entryId);
		const role = e?.type === "message" ? e.message?.role : null;
		const isConclusion = scope.conclusions.has(entryId);
		const orderedPassages = [...c.passages].sort((a, b) => a.blockIndex - b.blockIndex || a.chunkIndex - b.chunkIndex);
		const combinedText = orderedPassages.map((p) => p.text).join("\n");
		return {
			ref: `E${i + 1}`,
			handle: handleFor(entryId),
			entryId,
			hidden: scope.hidden.get(entryId)!,
			kind: isConclusion ? "assistant" : h.kind,
			tool: h.tool,
			title: isConclusion ? (scope.conclusions.get(entryId) ? `answer to: "${clip(scope.conclusions.get(entryId)!, 160)}"` : "earlier conclusion") : titleOf(scope, entryId, h),
			excerpt: orderedPassages.map((p) => p.excerpt).join(" … "),
			passages: orderedPassages.map((p) => p.excerpt),
			outcome: role === "toolResult" ? outcomeHint(textBlocks(e).map((b) => b.text).join("\n"), String(h.tool ?? ""), !!h.is_error) : "",
			isError: !!h.is_error,
			folded: role === "toolResult",
			matched: matchedOf(tokens, combinedText),
			exact: c.exact,
			context: i < limits.expand ? contextOf(db, h, scope) : [],
			seq: Number(h.seq ?? 0),
			at: Date.parse(e?.timestamp ?? "") || 0,
		};
	});
	return { evidence, hits: named.length + hits.length + graphIds.length, inBranch: named.length + hits.length + graphIds.length };
}

const clip = (s: string, n: number) => {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/**
 * What produced a tool result: "bash: npm test -- retry". The call is the nearest ancestor assistant message that issued the
 * result's toolCallId (call ids can be reused, so the nearest one is the right one). The arguments are shown only when that assistant
 * message is hidden too: a visible call must not be copied into the note. Otherwise the plain kind ("tool result bash").
 */
function titleOf(scope: Scope, entryId: string, h: Hit): string {
	const plain = `${h.kind.replace(/_/g, " ")}${h.tool ? ` ${h.tool}` : ""}`;
	const e = scope.entry(entryId);
	const callId = e?.message?.role === "toolResult" ? e.message.toolCallId : undefined;
	if (!callId) return plain;
	let cur = e?.parentId ? scope.entry(e.parentId) : undefined;
	for (let n = 0; cur && n < 200; n++, cur = cur.parentId ? scope.entry(cur.parentId) : undefined) {
		if (cur.message?.role !== "assistant") continue;
		const b = (Array.isArray(cur.message.content) ? cur.message.content : []).find((x: Any) => x?.type === "toolCall" && x.id === callId);
		if (!b) continue;
		if (!scope.hidden.has(cur.id) || scope.visible.has(cur.id)) return plain;
		const a = b.arguments ?? {};
		const arg = typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : JSON.stringify(a);
		return `${b.name}: ${clip(arg.replace(/\s+/g, " ").trim(), 160)}`;
	}
	return plain;
}

/** Expand only from a hidden seed to hidden thinking in its execution step. Never copy the mixed segment text. */
function contextOf(db: Db, h: Hit, scope: Scope): string[] {
	if (!h.segment_id) return [];
	const rows = db.prepare("SELECT entry_id FROM events_seen WHERE segment_id = ? ORDER BY seq").all(h.segment_id);
	const out: string[] = [];
	for (const row of rows) {
		const id = String(row.entry_id);
		if (!scope.branch.has(id) || !scope.hidden.has(id) || scope.visible.has(id)) continue;
		for (const b of textBlocks(scope.entry(id))) {
			if (b.kind !== "thinking") continue;
			out.push(`thinking [${handleFor(id)}] (unverified, supporting this item only): ${clip(b.text, 400)}`);
			if (out.length >= 2) return out;
		}
	}
	return out;
}

/** Count positively hidden entries. An absent entry or a compaction record alone cannot open the gate. */
export function hiddenOutputs(scope: Scope): number {
	return scope.hidden.size;
}

/** Branch scope from Pi's session manager: the active ancestry and what the current model view shows in full. */
export function scopeOf(ctx: Any): Scope {
	const sm = ctx?.sessionManager;
	const branch: Any[] = sm?.getBranch?.() ?? [];
	const visible = new Set<string>(), folded = new Set<string>();
	let projected = false;
	try {
		const projection = sm?.buildSessionProjection?.();
		projected = Array.isArray(projection?.entries);
		for (const pe of projection?.entries ?? []) {
			const id = pe?.sourceEntry?.id;
			const msgs = pe?.messages ?? [];
			if (typeof id !== "string" || !msgs.length) continue;
			const isFolded = msgs.some((m: Any) => {
				const c = m?.content;
				const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: Any) => b?.type === "text").map((b: Any) => b.text).join("\n") : "";
				return t.startsWith(FOLD_MARK);
			});
			if (isFolded) folded.add(id);
			else visible.add(id);
		}
	} catch { projected = false; }
	const byId = new Map<string, Any>(branch.map((e: Any) => [e?.id, e]));
	const hidden = new Map<string, "folded" | "compacted">();
	const compaction = [...branch].reverse().find((e) => e?.type === "compaction");
	// Pi stores a compaction that keeps nothing before it with firstKeptEntryId = its own id; an id that is null or not on the branch
	// keeps nothing either (Pi's buildContextEntries never finds it). In both cases every entry before the compaction is summarized.
	const kept = compaction ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId) : -1;
	const boundary = !compaction ? -1 : kept >= 0 ? kept : branch.findIndex((e) => e.id === compaction.id);
	if (projected) {
		for (const e of branch.slice(0, Math.max(0, boundary))) {
			if (!visible.has(e.id) && textBlocks(e).length) hidden.set(e.id, "compacted");
		}
		for (const id of folded) if (byId.has(id) && !visible.has(id) && textBlocks(byId.get(id)).length) hidden.set(id, "folded");
	}
	return { branch: new Set(byId.keys()), visible, folded, hidden, conclusions: conclusionsOf(branch), compacted: !!compaction, entry: (id) => byId.get(id) ?? sm?.getEntry?.(id) };
}

/** Each user turn's completed final answer, mapped to its request (branch order, root first). */
export function conclusionsOf(branch: Any[]): Map<string, string> {
	const out = new Map<string, string>();
	let request = "", last: string | null = null;
	for (const e of branch) {
		const m = e?.type === "message" ? e.message : null;
		if (m?.role === "user") {
			if (last) out.set(last, request);
			request = textBlocks(e).map((b) => b.text).join("\n");
			last = null;
		} else if (m?.role === "assistant") {
			const blocks = textBlocks(e);
			last = m.stopReason === "stop" && !blocks.some((b) => b.kind === "tool_call") && blocks.some((b) => b.kind === "assistant" && b.text.trim()) ? e.id : null;
		} else if (m?.role === "toolResult") last = null;
	}
	if (last) out.set(last, request);
	return out;
}
