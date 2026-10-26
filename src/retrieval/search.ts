// Candidate search over the opened session's ledger, scoped to the active branch. What is searched is the assistant's earlier
// conclusions (its final answer of each user turn), once they are hidden from the model's context: a conclusion is written in the
// user's language and states what the turn established, so the user's next prompt matches it, where it rarely matches the raw tool
// output behind it. A tool result is a candidate only when the prompt names its handle.
import { handleFor, handleTokens } from "../handle.ts";
import type { Db } from "../ledger/db.ts";
import { CHUNK_CHARS, ftsSearchIn, type Hit, matchExpr } from "../ledger/fts.ts";
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

/** `ftsRows`: FTS rows read per prompt, after the hidden-conclusion filter. */
export interface SearchLimits { candidates: number; expand: number; excerptChars: number; ftsRows: number }
export const DEFAULT_LIMITS: SearchLimits = { candidates: 8, expand: 6, excerptChars: 1200, ftsRows: 400 };

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

/** A loaded skill arrives inside the prompt as a <skill ...>...</skill> block: its text is the skill file, not the user's request. */
export const userText = (prompt: string) => prompt.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, " ").trim();

/**
 * Query size: QUERY_HEAD distinct tokens from the start of the prompt and QUERY_TAIL from its end (the actual request of a long prompt
 * often comes after pasted logs or code). Measured on a real session: 128 tokens cost ~15 ms of FTS, all 495 of a 7 KB prompt ~40 ms,
 * and BM25 keeps ranking by the rare tokens, so the cap only decides which words are searched, not the cost.
 */
export const QUERY_HEAD = 32, QUERY_TAIL = 96;

/** The query of one prompt, from the user's own words. Nothing is filtered by language (no stopwords). */
export interface Query { tokens: string[]; handles: string[] }
export function queryOf(prompt: string): Query {
	const own = userText(prompt);
	const words = [...new Set(own.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])]; // distinct, first-occurrence order
	if (words.length <= QUERY_HEAD + QUERY_TAIL) return { tokens: words, handles: [...new Set(handleTokens(own))] };
	// head: the first distinct words; tail: the distinct words nearest the end, in prompt order, none repeated from the head
	const head = words.slice(0, QUERY_HEAD), inHead = new Set(head);
	const tail: string[] = [];
	const all = own.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	const seen = new Set<string>();
	for (let i = all.length - 1; i >= 0 && tail.length < QUERY_TAIL; i--) {
		const w = all[i];
		if (inHead.has(w) || seen.has(w)) continue;
		seen.add(w);
		tail.push(w);
	}
	return { tokens: [...head, ...tail.reverse()], handles: [...new Set(handleTokens(own))] };
}

/**
 * Hidden conclusions on the active branch that match the prompt, best first, one item per conclusion; plus, first, every hidden entry
 * whose handle the prompt names (each kept on its own, also several from one step). The model decides which items are needed.
 */
export function retrieve(db: Db, q: Query, scope: Scope, limits: SearchLimits = DEFAULT_LIMITS): { evidence: Evidence[]; hits: number; inBranch: number } {
	const tokens = q.tokens;
	const match = matchExpr(tokens);
	const usable = (id: string) => scope.branch.has(id) && scope.hidden.has(id) && !scope.visible.has(id);
	// A handle in the prompt names one entry: resolve it through the ledger, not through the text (a handle appears in no document).
	const named = handleDocs(db, q.handles).filter((h) => h.entry_id && usable(h.entry_id));
	const eligible = [...scope.conclusions.keys()].filter(usable);
	const hits = match ? ftsSearchIn(db, match, eligible, limits.ftsRows, ["assistant"]) : [];
	const picked = new Map<string, { hit: Hit; exact: boolean }>();
	for (const hit of named) if (!picked.has(hit.entry_id!)) picked.set(hit.entry_id!, { hit, exact: true });
	for (const hit of hits) if (picked.size < limits.candidates + named.length && !picked.has(hit.entry_id!)) picked.set(hit.entry_id!, { hit, exact: false });
	const ranked = [...picked.values()].slice(0, Math.max(limits.candidates, named.length));
	const evidence = ranked.map((c, i): Evidence => {
		const h = c.hit, entryId = h.entry_id!;
		const e = scope.entry(entryId);
		const role = e?.type === "message" ? e.message?.role : null;
		const isConclusion = scope.conclusions.has(entryId);
		// Preserve the winning FTS block/chunk: an earlier common word in the full answer must not displace the matched passage.
		// Explicit handles have no winning text match; for conclusions, quote prose rather than the first (possibly thinking) block.
		const text = isConclusion && c.exact
			? textBlocks(e).filter((b) => b.kind === "assistant").map((b) => b.text).join("\n")
			: sourceSlice(e, h.block_index, h.char_start) || h.body;
		return {
			ref: `E${i + 1}`,
			handle: handleFor(entryId),
			entryId,
			hidden: scope.hidden.get(entryId)!,
			kind: isConclusion ? "assistant" : h.kind,
			tool: h.tool,
			title: isConclusion ? (scope.conclusions.get(entryId) ? `answer to: "${clip(scope.conclusions.get(entryId)!, 160)}"` : "earlier conclusion") : titleOf(scope, entryId, h),
			excerpt: window(text, tokens, limits.excerptChars),
			outcome: role === "toolResult" ? outcomeHint(textBlocks(e).map((b) => b.text).join("\n"), String(h.tool ?? ""), !!h.is_error) : "",
			isError: !!h.is_error,
			folded: role === "toolResult",
			matched: matchedOf(tokens, text),
			exact: c.exact,
			context: i < limits.expand ? contextOf(db, h, scope) : [],
			seq: Number(h.seq ?? 0),
			at: Date.parse(e?.timestamp ?? "") || 0,
		};
	});
	return { evidence, hits: named.length + hits.length, inBranch: named.length + hits.length };
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
