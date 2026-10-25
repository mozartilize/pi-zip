// The per-session derived database: schema, pragmas and transactions. Pi's session JSONL stays the source of truth; this file is a
// rebuildable read model of it (delete it and the next open of the session rebuilds it).
import { createRequire } from "node:module";

/** Bump when a table or column changes: an older database is rebuilt for the opened session. */
export const SCHEMA_VERSION = "4";

export type Row = Record<string, unknown>;
export interface Stmt {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): Row | undefined;
	all(...params: unknown[]): Row[];
}
export interface Db {
	exec(sql: string): void;
	prepare(sql: string): Stmt;
	close(): void;
}

let sqlite: { DatabaseSync: new (path: string, opts?: Row) => Db } | null | undefined;
/** node:sqlite (Node 22.13+, Bun), loaded on first use: an older runtime simply has no ledger. */
export function sqliteAvailable(): boolean {
	if (sqlite === undefined) {
		try {
			sqlite = createRequire(import.meta.url)("node:sqlite");
		} catch {
			sqlite = null;
		}
	}
	return !!sqlite;
}

// One row per eligible source entry (events_seen), deterministic execution segments, graph nodes/edges and the search projection.
// Column semantics:
// - events_seen.seq: 0-based position of the entry in the session file (append order); entry ids are Pi's own.
// - events_seen.content_hash: sha256 of the entry's JSON; a changed or missing entry makes the opened session's projection rebuild.
// - segments: one per user or assistant message (the request, or one model step with the tool results it got back). A tool call and
//   its result always share a segment. user_turn counts user messages on the ancestry, so sibling branches number independently.
// - edges.source_kind: "structural" (trace structure) or "referential" (an exact path, URL or command in tool arguments).
// - search_docs.object_type: "chunk" (one bounded slice of one text block) or "segment" (deterministic segment retrieval text).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events_seen (
	event_id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL UNIQUE,
	entry_id TEXT NOT NULL,
	parent_id TEXT,
	user_turn INTEGER,
	kind TEXT NOT NULL,
	timestamp INTEGER,
	source_handle TEXT,
	segment_id TEXT,
	content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_seen_segment ON events_seen(segment_id);
CREATE TABLE IF NOT EXISTS segments (
	id TEXT PRIMARY KEY,
	request_entry_id TEXT,
	user_turn INTEGER NOT NULL,
	segment_ordinal INTEGER NOT NULL,
	source_start_seq INTEGER NOT NULL,
	source_end_seq INTEGER NOT NULL,
	request_text TEXT NOT NULL,
	intent_text TEXT,
	closing_text TEXT,
	retrieval_text TEXT NOT NULL,
	created_at INTEGER
);
CREATE TABLE IF NOT EXISTS nodes (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	label TEXT,
	entry_id TEXT,
	block_index INTEGER,
	segment_id TEXT,
	first_seen_seq INTEGER,
	last_seen_seq INTEGER,
	metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS nodes_kind_key ON nodes(kind, canonical_key);
CREATE INDEX IF NOT EXISTS nodes_entry ON nodes(entry_id);
CREATE TABLE IF NOT EXISTS edges (
	id INTEGER PRIMARY KEY,
	src_id TEXT NOT NULL,
	dst_id TEXT NOT NULL,
	type TEXT NOT NULL,
	source_event_id TEXT,
	source_segment_id TEXT,
	confidence REAL NOT NULL DEFAULT 1.0,
	source_kind TEXT NOT NULL,
	recorded_at INTEGER,
	metadata_json TEXT,
	UNIQUE(src_id, dst_id, type)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_id, type);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_id, type);
CREATE TABLE IF NOT EXISTS search_docs (
	id INTEGER PRIMARY KEY,
	object_type TEXT NOT NULL,
	object_id TEXT NOT NULL UNIQUE,
	entry_id TEXT,
	block_index INTEGER,
	chunk_index INTEGER,
	char_start INTEGER,
	segment_id TEXT,
	kind TEXT NOT NULL,
	tool TEXT,
	is_error INTEGER NOT NULL DEFAULT 0,
	title TEXT,
	request_text TEXT,
	body TEXT,
	identifiers TEXT,
	user_turn INTEGER,
	seq INTEGER,
	created_at INTEGER,
	raw_chars INTEGER,
	indexed_chars INTEGER,
	truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_docs_entry ON search_docs(entry_id);
CREATE INDEX IF NOT EXISTS search_docs_segment ON search_docs(segment_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
	title, request_text, body, identifiers,
	content='search_docs', content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);
`;

const TABLES = ["projection_meta", "events_seen", "segments", "nodes", "edges", "search_docs", "search_fts"];

/** Open (creating) the database at `path`: WAL, a busy timeout (a second Pi on the same session waits, then fails open), the schema. */
export function openDb(path: string, busyMs = 2000): Db {
	if (!sqliteAvailable()) throw new Error("node:sqlite is not available in this runtime");
	const db = new sqlite!.DatabaseSync(path);
	try {
		db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyMs))}`);
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA synchronous=NORMAL");
		db.exec(SCHEMA);
		return db;
	} catch (err) {
		try { db.close(); } catch {}
		throw err;
	}
}

/** Drop every derived table and create the schema again (the session's projection is rebuilt from its source). */
export function resetDb(db: Db) {
	for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
	db.exec(SCHEMA);
}

/** f() inside one write transaction: committed whole or rolled back whole (an interrupted backfill leaves nothing behind). */
export function tx<T>(db: Db, f: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const r = f();
		db.exec("COMMIT");
		return r;
	} catch (err) {
		try { db.exec("ROLLBACK"); } catch {}
		throw err;
	}
}

export function getMeta(db: Db, key: string): string | undefined {
	const r = db.prepare("SELECT value FROM projection_meta WHERE key = ?").get(key);
	return typeof r?.value === "string" ? r.value : undefined;
}
export function setMeta(db: Db, key: string, value: string | number) {
	db.prepare("INSERT INTO projection_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
