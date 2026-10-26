// The search projection: bounded chunks of every text block, segment retrieval texts, and the FTS5 index over them.
import type { Db, Row } from "./db.ts";

/** Chunk size and overlap (characters). A block longer than MAX_BLOCK_CHARS is indexed up to that size and marked truncated
 *  (raw_chars / indexed_chars say how much): the raw text stays in the session file either way. */
export const CHUNK_CHARS = 3000;
export const CHUNK_OVERLAP = 300;
export const MAX_BLOCK_CHARS = 256 * 1024;

export interface Chunk { index: number; start: number; text: string }

/** Fixed windows of CHUNK_CHARS that overlap by CHUNK_OVERLAP, never splitting a surrogate pair. Deterministic in the text alone. */
export function chunk(text: string): { chunks: Chunk[]; indexed: number; truncated: boolean } {
	let limit = Math.min(text.length, MAX_BLOCK_CHARS);
	if (limit < text.length && isHigh(text.charCodeAt(limit - 1))) limit--;
	const chunks: Chunk[] = [];
	for (let start = 0, i = 0; start < limit; i++) {
		let end = Math.min(limit, start + CHUNK_CHARS);
		if (end < limit && isHigh(text.charCodeAt(end - 1))) end--;
		chunks.push({ index: i, start, text: text.slice(start, end) });
		if (end >= limit) break;
		let next = end - CHUNK_OVERLAP;
		if (isLow(text.charCodeAt(next))) next--;
		start = Math.max(next, start + 1);
	}
	return { chunks, indexed: limit, truncated: limit < text.length };
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export interface DocRow {
	objectType: "chunk" | "segment";
	objectId: string;
	entryId: string | null;
	blockIndex: number | null;
	chunkIndex: number | null;
	charStart: number | null;
	segmentId: string | null;
	kind: string;
	tool: string | null;
	isError: boolean;
	title: string;
	requestText: string;
	body: string;
	identifiers: string;
	userTurn: number | null;
	seq: number | null;
	createdAt: number | null;
	rawChars: number | null;
	indexedChars: number | null;
	truncated: boolean;
}

export function insertDoc(db: Db, d: DocRow) {
	const r = db.prepare(
		`INSERT INTO search_docs(object_type, object_id, entry_id, block_index, chunk_index, char_start, segment_id, kind, tool, is_error, title, request_text, body, identifiers, user_turn, seq, created_at, raw_chars, indexed_chars, truncated)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
	).get(d.objectType, d.objectId, d.entryId, d.blockIndex, d.chunkIndex, d.charStart, d.segmentId, d.kind, d.tool, d.isError ? 1 : 0, d.title, d.requestText, d.body, d.identifiers, d.userTurn, d.seq, d.createdAt, d.rawChars, d.indexedChars, d.truncated ? 1 : 0);
	db.prepare("INSERT INTO search_fts(rowid, title, request_text, body, identifiers) VALUES(?,?,?,?,?)").run(r!.id, d.title, d.requestText, d.body, d.identifiers);
}

/** Remove one document from the table and the external-content index (FTS5 needs the old column values to delete). */
export function deleteDoc(db: Db, objectId: string) {
	const old = db.prepare("SELECT id, title, request_text, body, identifiers FROM search_docs WHERE object_id = ?").get(objectId);
	if (!old) return;
	db.prepare("INSERT INTO search_fts(search_fts, rowid, title, request_text, body, identifiers) VALUES('delete',?,?,?,?,?)").run(old.id, old.title, old.request_text, old.body, old.identifiers);
	db.prepare("DELETE FROM search_docs WHERE id = ?").run(old.id);
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** An FTS5 MATCH expression: any of the tokens, plus each multi-token term or identifier as an exact token phrase. Null when there
 *  is nothing to search. Terms come from the retrieval assistant's route; nothing here filters words by language. */
export function matchExpr(tokens: string[], phrases: string[] = []): string | null {
	const parts = new Set(tokens.map(quote));
	for (const p of phrases) {
		const toks = p.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
		if (toks.length) parts.add(quote(toks.join(" ")));
	}
	return parts.size ? [...parts].join(" OR ") : null;
}

/** Column weights for bm25(): identifiers and titles count most, then the request, then the body. */
const WEIGHTS = "10.0, 3.0, 1.0, 12.0"; // title, request_text, body, identifiers

export interface Hit extends Row {
	id: number;
	object_type: string;
	object_id: string;
	entry_id: string | null;
	block_index: number | null;
	chunk_index: number | null;
	char_start: number | null;
	segment_id: string | null;
	kind: string;
	tool: string | null;
	is_error: number;
	title: string;
	body: string;
	identifiers: string;
	seq: number | null;
	rank: number;
}

/**
 * FTS over source chunks of `entryIds` only, ranked, then limited. The filter runs before LIMIT: with a limit applied to the whole
 * database first, visible entries and sibling branches could fill every row and leave no place for the hidden entries searched for.
 * `kinds`: the document kinds searched (retrieval searches the assistant's earlier conclusions).
 */
export function ftsSearchIn(db: Db, match: string, entryIds: Iterable<string>, limit = 200, kinds: readonly string[] = ["assistant"]): Hit[] {
	db.exec("CREATE TEMP TABLE IF NOT EXISTS search_scope (entry_id TEXT PRIMARY KEY)");
	db.exec("BEGIN");
	try {
		db.exec("DELETE FROM search_scope");
		const ins = db.prepare("INSERT OR IGNORE INTO search_scope(entry_id) VALUES(?)");
		for (const id of entryIds) ins.run(id);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return db.prepare(
		`SELECT d.id, d.object_type, d.object_id, d.entry_id, d.block_index, d.chunk_index, d.char_start, d.segment_id, d.kind, d.tool, d.is_error,
		        d.title, d.body, d.identifiers, d.seq, bm25(search_fts, ${WEIGHTS}) AS rank
		 FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid JOIN search_scope s ON s.entry_id = d.entry_id
		 WHERE search_fts MATCH ? AND d.object_type = 'chunk' AND d.kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY rank LIMIT ?`,
	).all(match, ...kinds, limit) as Hit[];
}

export function ftsSearch(db: Db, match: string, limit = 200): Hit[] {
	return db.prepare(
		`SELECT d.id, d.object_type, d.object_id, d.entry_id, d.block_index, d.chunk_index, d.char_start, d.segment_id, d.kind, d.tool, d.is_error,
		        d.title, d.body, d.identifiers, d.seq, bm25(search_fts, ${WEIGHTS}) AS rank
		 FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid
		 WHERE search_fts MATCH ? ORDER BY rank LIMIT ?`,
	).all(match, limit) as Hit[];
}
