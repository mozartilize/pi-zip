// Candidate search over the opened session's ledger, scoped to the hidden entries of the active branch: user requests, assistant
// text (completed answers and mid-turn notes), reasoning, tool calls and tool outputs. One FTS search per keyword set of the planner
// (or one over the request's own words when there is no plan), merged round-robin so that each set's best entries come first, one
// candidate per source entry; plus referential graph traversal (file paths and code symbols in the prompt). Sibling branches and
// anything the model view still shows are excluded.
import { handleFor, handleTokens } from "../handle.ts";
import type { Db } from "../ledger/db.ts";
import { nodeId } from "../ledger/graph.ts";
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
	/** Searchable history: every entry before the latest compaction record (also the part it kept in view), plus folded entries.
	 *  Positive marks only: absence from the view alone is not enough. */
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
	kind: string; // user | assistant (a completed answer) | assistant_text (mid-turn) | thinking | tool_call | tool_result | custom
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
export const DEFAULT_LIMITS: SearchLimits = { candidates: 12, expand: 6, excerptChars: 1500, ftsRows: 400 };

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

/** One planner query: keywords and short phrases of one facet (what/why/how/when) in one language. */
export interface KeywordSet { facet?: string; lang?: string; keywords: string[] }

/** The query of one prompt: the user's own words (no stopwords), and the planner's keyword sets when there is a plan. */
export interface Query { tokens: string[]; handles: string[]; paths?: string[]; symbols?: string[]; sets?: KeywordSet[] }
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

/** Every kind a hidden source can be found by. Reasoning and tool calls can lead to a candidate; the answer call labels them. */
const SEARCH_KINDS = ["user", "assistant", "thinking", "tool_call", "tool_result", "custom"] as const;

/**
 * The FTS searches of one query: one per planner keyword set (its tokens, plus each multi-word keyword as a phrase), else one over
 * the request's own words. Matched in body and identifiers only: titles are labels ("assistant reasoning", "tool call bash") that
 * would otherwise rank every item of a kind by a common word.
 */
export function searchesOf(q: Query): Array<{ match: string; tokens: string[] }> {
	const runs: Array<{ match: string; tokens: string[] }> = [];
	for (const s of q.sets?.length ? q.sets : [{ keywords: q.tokens }]) {
		const tokens = new Set<string>(), phrases: string[] = [];
		for (const k of s.keywords) {
			const w = k.toLowerCase().match(WORD_RE) ?? [];
			for (const t of w) tokens.add(t);
			if (w.length > 1) phrases.push(k);
		}
		const expr = matchExpr([...tokens], phrases);
		if (expr) runs.push({ match: `{body identifiers} : (${expr})`, tokens: [...tokens] });
	}
	return runs;
}

/** The hidden result entry that answered the tool call of a matched call chunk (one hop over the ledger's answered_by edge). */
function pairedResult(db: Db, h: Hit): string | null {
	if (h.kind !== "tool_call" || !h.entry_id || h.block_index === null) return null;
	const row = db.prepare("SELECT dst_id FROM edges WHERE src_id = ? AND type = 'answered_by' LIMIT 1").get(nodeId.call(h.entry_id, Number(h.block_index)));
	const dst = row ? String(row.dst_id) : "";
	return dst.startsWith("entry:") ? dst.slice(6) : null;
}

/**
 * Hidden sources on the active branch that match the query, best first: every hidden entry whose handle the prompt names (each kept
 * on its own, also several from one step), then the searches merged round-robin: the first entry of each search, then the second of
 * each, and so on, one candidate per source entry. Merging by rank rather than by summed score keeps an entry that only one facet
 * finds (a decision found by "why", a command found by "how") above entries every facet matches a little. A matched tool call brings
 * its hidden result right after it. Up to 3 passages of one entry (its matching chunks in that search). The model decides need.
 */
export function retrieve(db: Db, q: Query, scope: Scope, limits: SearchLimits = DEFAULT_LIMITS): { evidence: Evidence[]; hits: number; inBranch: number } {
	const usable = (id: string) => scope.branch.has(id) && scope.hidden.has(id);
	// A handle in the prompt names one entry: resolve it through the ledger, not through the text (a handle appears in no document).
	const named = handleDocs(db, q.handles).filter((h) => h.entry_id && usable(h.entry_id));
	const eligible = [...scope.hidden.keys()].filter(usable);
	// One scope for every query below: SQL filters to the hidden active-branch entries before ranking and LIMIT.
	setSearchScope(db, eligible);
	const runs = searchesOf(q);
	const perRun = Math.max(40, Math.floor(limits.ftsRows / Math.max(1, runs.length)));
	// At most PER_ENTRY_ROWS chunks per entry: a few long outputs matching on every chunk cannot fill all rows.
	const lists = runs.map((r) => ({ tokens: r.tokens, hits: eligible.length ? ftsSearchScoped(db, r.match, perRun, SEARCH_KINDS, PER_ENTRY_ROWS) : [] }));
	const allTokens = [...new Set([...q.tokens, ...runs.flatMap((r) => r.tokens)])];
	// Referential graph traversal: file paths and code symbols in the prompt -> hidden tool outputs, through indexed SQL only.
	const graphList = eligible.length ? graphCandidates(db, q, lists.flatMap((l) => l.hits)) : [];
	if (graphList.length) lists.push({ tokens: allTokens, hits: graphList });
	const hitCount = lists.reduce((n, l) => n + l.hits.length, 0);

	// Identical excerpts from separate executions can hide different outcomes or dates; keep their handles independently.
	const dedupKey = (h: Hit, excerpt: string) => {
		const content = excerptKey(excerpt);
		return content ? `${h.entry_id}\u0000${content}` : "";
	};
	const sliceText = (h: Hit, exact: boolean): string => {
		const e = scope.entry(h.entry_id!);
		return scope.conclusions.has(h.entry_id!) && exact
			? textBlocks(e).filter((b) => b.kind === "assistant").map((b) => b.text).join("\n")
			: sourceSlice(e, h.block_index, h.char_start) || h.body;
	};
	type Passage = { blockIndex: number; chunkIndex: number; excerpt: string; text: string };
	const picked = new Map<string, { hit: Hit; exact: boolean; tokens: string[]; passages: Passage[] }>();
	const seenExcerpts = new Set<string>();
	const passage = (h: Hit, exact: boolean, tokens: string[], n: number): Passage | null => {
		const text = sliceText(h, exact);
		const excerpt = window(text, tokens, n);
		const key = dedupKey(h, excerpt);
		if (!exact && (!key || seenExcerpts.has(key))) return null;
		if (key) seenExcerpts.add(key);
		return { blockIndex: Number(h.block_index ?? 0), chunkIndex: Number(h.chunk_index ?? 0), excerpt, text };
	};

	for (const hit of named) {
		if (picked.has(hit.entry_id!)) continue;
		picked.set(hit.entry_id!, { hit, exact: true, tokens: allTokens, passages: [passage(hit, true, allTokens, limits.excerptChars)!] });
	}
	const cap = limits.candidates + named.length;
	const ordered = lists.map((l) => {
		const byEntry = new Map<string, Hit[]>();
		for (const h of l.hits) {
			if (!h.entry_id) continue;
			const group = byEntry.get(h.entry_id) ?? [];
			group.push(h);
			byEntry.set(h.entry_id, group);
		}
		return { tokens: l.tokens, entries: [...byEntry.entries()] };
	});
	// every list's chunks of one entry, so a graph continuation chunk can join an entry an FTS search found first
	const chunksOf = new Map<string, Hit[]>();
	for (const l of lists) for (const h of l.hits) if (h.entry_id) chunksOf.set(h.entry_id, [...(chunksOf.get(h.entry_id) ?? []), h]);
	const subWindow = Math.min(1200, limits.excerptChars);
	const take = (own: Hit[], tokens: string[]): boolean => {
		const hits = [...own, ...(chunksOf.get(own[0].entry_id!) ?? []).filter((h) => !own.some((o) => o.object_id === h.object_id))];
		const first = passage(hits[0], false, tokens, limits.excerptChars);
		if (!first) return false;
		const c = { hit: hits[0], exact: false, tokens, passages: [first] };
		picked.set(hits[0].entry_id!, c);
		// extra passages for tool outputs only: prose and reasoning are quoted from their winning passage
		if (limits.excerptChars >= 1200 && hits[0].kind === "tool_result") {
			for (const h of hits.slice(1)) {
				if (c.passages.length >= 3) break;
				if (c.passages.some((p) => p.blockIndex === Number(h.block_index ?? 0) && p.chunkIndex === Number(h.chunk_index ?? 0))) continue;
				const more = passage(h, false, tokens, subWindow);
				if (more) c.passages.push(more);
			}
		}
		return true;
	};
	for (let depth = 0, more = true; more && picked.size < cap; depth++) {
		more = false;
		for (const l of ordered) {
			if (picked.size >= cap) break;
			if (depth >= l.entries.length) continue;
			more = true;
			const [entryId, hits] = l.entries[depth];
			if (picked.has(entryId) || !take(hits, l.tokens)) continue;
			// one hop: a matched call brings the output it produced (its title then shows the call)
			const res = pairedResult(db, hits[0]);
			if (res && usable(res) && !picked.has(res) && picked.size < cap) {
				const rows = db.prepare(
					`SELECT ${HIT_COLS}, 0 AS rank FROM search_docs d WHERE d.entry_id = ? AND d.object_type = 'chunk' AND d.kind = 'tool_result' ORDER BY d.block_index, d.chunk_index LIMIT 1`,
				).all(res) as Hit[];
				if (rows.length) take(rows, l.tokens);
			}
		}
	}

	const ranked = [...picked.values()].slice(0, cap);
	const evidence = ranked.map((c, i): Evidence => {
		const h = c.hit, entryId = h.entry_id!;
		const e = scope.entry(entryId);
		const role = e?.type === "message" ? e.message?.role : null;
		const isConclusion = scope.conclusions.has(entryId) && (c.exact || h.kind === "assistant");
		const orderedPassages = [...c.passages].sort((a, b) => a.blockIndex - b.blockIndex || a.chunkIndex - b.chunkIndex);
		const combinedText = orderedPassages.map((p) => p.text).join("\n");
		const kind = isConclusion ? "assistant" : h.kind === "assistant" ? "assistant_text" : h.kind;
		return {
			ref: `E${i + 1}`,
			handle: handleFor(entryId),
			entryId,
			hidden: scope.hidden.get(entryId)!,
			kind,
			tool: h.tool,
			title: isConclusion ? (scope.conclusions.get(entryId) ? `answer to: "${clip(scope.conclusions.get(entryId)!, 160)}"` : "earlier conclusion")
				: kind === "user" ? "earlier user request" : titleOf(scope, entryId, h),
			excerpt: orderedPassages.map((p) => p.excerpt).join(" … "),
			passages: orderedPassages.map((p) => p.excerpt),
			outcome: role === "toolResult" ? outcomeHint(textBlocks(e).map((b) => b.text).join("\n"), String(h.tool ?? ""), !!h.is_error) : "",
			isError: !!h.is_error,
			folded: role === "toolResult",
			matched: matchedOf(c.tokens, combinedText),
			exact: c.exact,
			context: i < limits.expand && kind !== "thinking" ? contextOf(db, h, scope) : [],
			seq: Number(h.seq ?? 0),
			at: Date.parse(e?.timestamp ?? "") || 0,
		};
	});
	return { evidence, hits: named.length + hitCount, inBranch: named.length + hitCount };
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

/** Count searchable history entries (before the latest compaction, or folded). An entry merely absent from the view does not count. */
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
	// Everything on the active branch before the latest compaction record is searchable, including the part the compaction kept in
	// view (from firstKeptEntryId on): the note is advisory, and the main model may have lost track of retained text too. Branch
	// order, not timestamps: it is the active branch's own time order, and an entry without a timestamp still has a place in it.
	const boundary = compaction ? branch.findIndex((e) => e.id === compaction.id) : -1;
	if (projected) {
		for (const e of branch.slice(0, Math.max(0, boundary))) {
			if (textBlocks(e).length) hidden.set(e.id, "compacted");
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
