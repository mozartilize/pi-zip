// Candidate search over the opened session's ledger, scoped to the active branch, then one-hop graph context and exact source excerpts.
import { handleFor, handleTokens } from "../handle.ts";
import type { Db } from "../ledger/db.ts";
import { CHUNK_CHARS, ftsSearch, type Hit, matchExpr } from "../ledger/fts.ts";
import { textBlocks } from "../ledger/source.ts";
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

/** `assistantSlots`: at most this many candidates may be the assistant's own prose (its earlier claims, not results). */
export interface SearchLimits { candidates: number; expand: number; excerptChars: number; assistantSlots: number }
export const DEFAULT_LIMITS: SearchLimits = { candidates: 8, expand: 6, excerptChars: 700, assistantSlots: 3 };

/**
 * Pick `candidates` items from a rank-ordered list. Long assistant messages mention most project words, so they outrank the outputs
 * they describe. Assistant prose gets at most `assistantSlots` places while other items remain; when other items run out, the
 * remaining assistant items fill the free places. An exact handle hit never counts against the quota. The result keeps rank order.
 */
export function pickCandidates<T extends { kind: string; exact: boolean }>(ranked: T[], limits: Pick<SearchLimits, "candidates" | "assistantSlots">): T[] {
	const prose = (x: T) => x.kind === "assistant" && !x.exact;
	const others = ranked.filter((x) => !prose(x)).length;
	const proseAllowed = Math.max(limits.assistantSlots, limits.candidates - others);
	const keep = new Set<T>();
	let n = 0;
	for (const x of ranked) {
		if (keep.size >= limits.candidates) break;
		if (prose(x) && n >= proseAllowed) continue;
		if (prose(x)) n++;
		keep.add(x);
	}
	return ranked.filter((x) => keep.has(x));
}

/** Diacritics removed, for comparison only: "tiếp tục" -> "tiep tuc", "đ" -> "d". */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D");

/** How many of `tokens` occur in `text` (both folded). */
export function matchedOf(tokens: string[], text: string): number {
	if (!tokens.length) return 0;
	const words = new Set(fold(text.toLowerCase()).match(/[\p{L}\p{N}_]+/gu) ?? []);
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

/** About `n` characters from a little before the first query term found (whole text when it fits). */
export function window(text: string, terms: string[], n: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= n) return flat;
	const low = flat.toLowerCase();
	let at = -1;
	for (const w of terms) {
		const i = low.indexOf(w.toLowerCase());
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	const start = Math.max(0, Math.min(flat.length - n, (at < 0 ? 0 : at) - Math.min(80, Math.floor(n / 3)))); // the match near the front: shorter quotes keep it
	return `${start > 0 ? "…" : ""}${flat.slice(start, start + n)}${start + n < flat.length ? "…" : ""}`;
}

/**
 * The query of one prompt, taken from the prompt itself: every word token, at most 24, first occurrence order. Nothing is filtered by
 * language (no stopwords), because a word list was what the model was meant to replace, and no model call is spent on it.
 */
export interface Query { tokens: string[]; handles: string[] }
export function queryOf(prompt: string): Query {
	const seen = new Set<string>();
	// A loaded skill arrives inside the prompt as a <skill ...>...</skill> block: its text is the skill file, not the user's request.
	const own = prompt.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, " ");
	for (const w of own.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		if (seen.size >= 24) break;
		seen.add(w);
	}
	return { tokens: [...seen], handles: [...new Set(handleTokens(prompt))] };
}

/** Search hidden source chunks on the active branch. Return at most one seed per step, with hidden thinking from that step.
 * Mixed segment text and standalone thinking cannot become evidence. The model decides which eligible items are needed. */
/** `rest`: entries left out this time (src/retrieval/offers.ts); the eligible ones among them come back in `rested`. */
export function retrieve(db: Db, q: Query, scope: Scope, limits: SearchLimits = DEFAULT_LIMITS, rest: Set<string> = new Set()): { evidence: Evidence[]; hits: number; inBranch: number; rested: string[] } {
	const tokens = q.tokens;
	const match = matchExpr(tokens);
	if (!match) return { evidence: [], hits: 0, inBranch: 0, rested: [] };
	// A handle in the prompt names one output: resolve it through the ledger, not through the text (a handle appears in no document).
	const named = handleDocs(db, q.handles);
	const hits = [...named, ...ftsSearch(db, match, 400)];
	const wantHandles = new Set(q.handles);
	const bySegment = new Map<string, { hit: Hit; matched: number; exact: boolean; order: number }>();
	let inBranch = 0;
	const rested = new Set<string>();
	hits.forEach((hit, order) => {
		const entryId = hit.entry_id;
		if (!entryId || !scope.branch.has(entryId)) return;
		inBranch++;
		// Segment bodies mix visible and hidden members. Thinking is supporting context, never a search seed.
		if (!scope.hidden.has(entryId) || scope.visible.has(entryId) || hit.object_type !== "chunk" || hit.kind === "thinking" || hit.kind === "tool_call") return;
		const hay = `${hit.title}\n${hit.body}\n${hit.identifiers}`;
		const exact = wantHandles.has(handleFor(entryId)); // a handle names one output exactly
		if (rest.has(entryId) && !exact) return void rested.add(entryId);
		const matched = matchedOf(tokens, hay);
		const key = hit.segment_id ?? `entry:${entryId}`;
		const prev = bySegment.get(key);
		if (!prev) return void bySegment.set(key, { hit, matched, exact, order });
		if (exact && !prev.exact) bySegment.set(key, { hit, matched, exact, order: prev.order });
	});
	const sorted = [...bySegment.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || a.order - b.order);
	const ranked = pickCandidates(sorted.map((c) => ({ ...c, kind: c.hit.kind })), limits);
	const evidence = ranked.map((c, i): Evidence => {
		const h = c.hit, entryId = h.entry_id!;
		const e = scope.entry(entryId);
		const text = h.object_type === "chunk" ? sourceSlice(e, h.block_index, h.char_start) || h.body : h.body;
		const role = e?.type === "message" ? e.message?.role : null;
		return {
			ref: `E${i + 1}`,
			handle: handleFor(entryId),
			entryId,
			hidden: scope.hidden.get(entryId)!,
			kind: h.kind,
			tool: h.tool,
			title: titleOf(scope, entryId, h),
			excerpt: window(text, tokens, limits.excerptChars),
			isError: !!h.is_error,
			folded: role === "toolResult" && scope.hidden.has(entryId),
			matched: c.matched,
			exact: c.exact,
			context: i < limits.expand ? contextOf(db, h, scope) : [],
			seq: Number(h.seq ?? 0),
			at: Date.parse(e?.timestamp ?? "") || 0,
		};
	});
	return { evidence, hits: hits.length, inBranch, rested: [...rested] };
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
	const boundary = compaction ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId) : -1;
	if (projected) {
		for (const e of branch.slice(0, Math.max(0, boundary))) {
			if (!visible.has(e.id) && textBlocks(e).length) hidden.set(e.id, "compacted");
		}
		for (const id of folded) if (byId.has(id) && !visible.has(id) && textBlocks(byId.get(id)).length) hidden.set(id, "folded");
	}
	return { branch: new Set(byId.keys()), visible, folded, hidden, compacted: !!compaction, entry: (id) => byId.get(id) ?? sm?.getEntry?.(id) };
}
