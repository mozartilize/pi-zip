// The deterministic projector: the opened session's persisted entries -> its derived SQLite database. No model call, no judge, no
// write-time selection: every eligible text block goes through the same chunking. Replaying the same source gives the same rows.
//
// Reconciliation keeps no backfill cursor. events_seen holds one row per source entry in file order with a content hash; when those
// rows are an exact prefix of the opened session's entries, only the rest is projected (append). Anything else (a changed or removed
// entry, another session id or header, a schema or projector change) rebuilds this one database from the beginning. Every projection
// batch is one transaction, so an interrupted first backfill leaves no partial rows and simply runs again at the next open.
import { join } from "node:path";
import { handleFor } from "../handle.ts";
import type { Any } from "../util.ts";
import { type Db, getMeta, openDb, resetDb, SCHEMA_VERSION, setMeta, tx } from "./db.ts";
import { chunk, deleteDoc, insertDoc } from "./fts.ts";
import { callFor, type EdgeRow, nodeId, type NodeRow, referencesOf } from "./graph.ts";
import { buildSegment, Lineage } from "./segment.ts";
import { hashEntry, kindOf, type SessionSource, sha256, textBlocks, tsOf } from "./source.ts";

/** Bump whenever projection output changes for the same source: older databases are rebuilt when their session is opened. */
export const PROJECTOR_VERSION = "1";

/** `<session file without .jsonl>.memory.sqlite`, next to the session; PI_ZIP_MEMORY_DIR puts it in that directory instead. */
export function dbPathFor(file: string, sessionId: string): string {
	const dir = process.env.PI_ZIP_MEMORY_DIR;
	if (dir) return join(dir, `${sessionId.replace(/[^\w.-]/g, "_")}.memory.sqlite`);
	return `${file.replace(/\.jsonl$/, "")}.memory.sqlite`;
}

const clip = (s: string, n: number) => {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const MESSAGE_KINDS = new Set(["user", "assistant", "toolResult", "bashExecution"]);

export interface ReconcileResult { mode: "reuse" | "append" | "rebuild"; projected: number; ms: number }

export interface LedgerCounts {
	sourceEntries: number;
	indexedEntries: number;
	ftsDocs: number;
	segments: number;
	nodes: number;
	edges: number;
	rawChars: number;
	indexedChars: number;
	truncatedBlocks: number;
}

export class Ledger {
	/** Rows in events_seen: the length of the source prefix already projected. */
	private seen = 0;
	private lastId: string | null = null;
	/** Test hook: called before each entry is projected (throwing simulates an interrupted backfill). */
	onProject: ((seq: number) => void) | null = null;

	private constructor(readonly db: Db, readonly path: string, readonly sessionId: string) {}

	static open(src: Pick<SessionSource, "file" | "sessionId">, path = dbPathFor(src.file, src.sessionId)): Ledger {
		return new Ledger(openDb(path), path, src.sessionId);
	}

	close() {
		try { this.db.close(); } catch {}
	}

	/** Source entries projected so far (the length of the projected prefix). */
	get projectedCount(): number {
		return this.seen;
	}

	private identity(src: SessionSource) {
		return { session_id: src.sessionId, header_hash: sha256(JSON.stringify(src.header ?? null)), schema_version: SCHEMA_VERSION, projector_version: PROJECTOR_VERSION };
	}

	/**
	 * Bring the database in line with the opened session's complete persisted entry list (reuse, append or rebuild). The validity
	 * check always reads the whole list; `limit` only bounds how many entries this call projects (a large first open projects in
	 * batches). Passing a shortened list instead would make a complete database look longer than its source and force a rebuild.
	 */
	reconcile(src: SessionSource, limit = Infinity): ReconcileResult {
		const t0 = performance.now();
		const id = this.identity(src);
		const entries = src.entries;
		let same = Object.entries(id).every(([k, v]) => getMeta(this.db, k) === v);
		let count = 0;
		if (same) {
			const rows = this.db.prepare("SELECT seq, entry_id, content_hash FROM events_seen ORDER BY seq").all();
			count = rows.length;
			if (count > entries.length) same = false;
			for (let i = 0; same && i < count; i++) {
				const r = rows[i], e = entries[i];
				if (r.seq !== i || r.entry_id !== e?.id || r.content_hash !== hashEntry(e)) same = false;
			}
		}
		if (same && count === entries.length) {
			this.seen = count;
			this.lastId = count ? entries[count - 1].id : null;
			return { mode: "reuse", projected: 0, ms: performance.now() - t0 };
		}
		const from = same ? count : 0;
		const end = Math.min(entries.length, from + Math.max(0, limit));
		tx(this.db, () => {
			if (!same) {
				resetDb(this.db);
				for (const [k, v] of Object.entries(id)) setMeta(this.db, k, v);
			}
			setMeta(this.db, "source_file", src.file);
			this.project(src, from, end);
		});
		this.seen = end;
		this.lastId = end ? entries[end - 1].id : null;
		return { mode: same ? "append" : "rebuild", projected: end - from, ms: performance.now() - t0 };
	}

	/** Live ingestion: project entries appended since the last reconcile or catch-up. Falls back to a reconcile when the source no
	 *  longer extends what was projected (a reload that rewrote the file). Returns the number of entries projected. */
	catchUp(src: SessionSource): number {
		const entries = src.entries;
		if (entries.length === this.seen && (this.seen === 0 || entries[this.seen - 1]?.id === this.lastId)) return 0;
		if (entries.length < this.seen || (this.seen > 0 && entries[this.seen - 1]?.id !== this.lastId)) return this.reconcile(src).projected;
		const from = this.seen;
		tx(this.db, () => this.project(src, from, entries.length));
		this.seen = entries.length;
		this.lastId = entries[entries.length - 1].id;
		return entries.length - from;
	}

	/** True when every source entry is projected (retrieval never runs on a database behind its session). */
	current(src: SessionSource): boolean {
		return src.entries.length === this.seen && (this.seen === 0 || src.entries[this.seen - 1]?.id === this.lastId);
	}

	counts(sourceEntries: number): LedgerCounts {
		const n = (sql: string) => Number(this.db.prepare(sql).get()?.n ?? 0);
		return {
			sourceEntries,
			indexedEntries: n("SELECT count(*) AS n FROM events_seen"),
			ftsDocs: n("SELECT count(*) AS n FROM search_docs"),
			segments: n("SELECT count(*) AS n FROM segments"),
			nodes: n("SELECT count(*) AS n FROM nodes"),
			edges: n("SELECT count(*) AS n FROM edges"),
			rawChars: n("SELECT coalesce(sum(raw_chars),0) AS n FROM search_docs WHERE object_type='chunk' AND chunk_index=0"),
			indexedChars: n("SELECT coalesce(sum(indexed_chars),0) AS n FROM search_docs WHERE object_type='chunk' AND chunk_index=0"),
			truncatedBlocks: n("SELECT count(*) AS n FROM search_docs WHERE object_type='chunk' AND chunk_index=0 AND truncated=1"),
		};
	}

	// ---- projection ------------------------------------------------------------------------------------------------------------
	private project(src: SessionSource, from: number, to: number) {
		if (from >= to) return;
		const entries = src.entries;
		const byId = new Map<string, Any>();
		for (const e of entries) if (typeof e?.id === "string" && !byId.has(e.id)) byId.set(e.id, e);
		const lineage = new Lineage(byId);
		const cwd = typeof src.header?.cwd === "string" ? src.header.cwd : "";
		const touched = new Set<string>();
		for (let seq = from; seq < to; seq++) {
			this.onProject?.(seq);
			const e = entries[seq];
			const seg = this.projectEntry(e, seq, byId, lineage, cwd);
			if (seg) touched.add(seg);
		}
		for (const seg of touched) this.writeSegment(seg, byId, lineage, cwd);
		setMeta(this.db, "last_projected_seq", to - 1);
	}

	private putNode(n: NodeRow, shared = false) {
		this.db.prepare(
			`INSERT INTO nodes(id, kind, canonical_key, label, entry_id, block_index, segment_id, first_seen_seq, last_seen_seq, metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(id) DO UPDATE SET ${shared ? "first_seen_seq = min(first_seen_seq, excluded.first_seen_seq), last_seen_seq = max(last_seen_seq, excluded.last_seen_seq)" : "kind = excluded.kind, canonical_key = excluded.canonical_key, label = excluded.label, entry_id = excluded.entry_id, block_index = excluded.block_index, segment_id = excluded.segment_id, first_seen_seq = excluded.first_seen_seq, last_seen_seq = excluded.last_seen_seq, metadata_json = excluded.metadata_json"}`,
		).run(n.id, n.kind, n.canonical_key, n.label, n.entry_id, n.block_index, n.segment_id, n.seq, n.seq, n.metadata === undefined ? null : JSON.stringify(n.metadata));
	}
	private putEdge(e: EdgeRow) {
		this.db.prepare("INSERT OR IGNORE INTO edges(src_id, dst_id, type, source_event_id, source_segment_id, confidence, source_kind, recorded_at) VALUES(?,?,?,?,?,1.0,?,?)")
			.run(e.src, e.dst, e.type, e.eventId, e.segmentId, e.kind, e.at);
	}

	/** One source entry: its events_seen row, nodes, edges and chunk documents. Returns its segment id (null outside any segment). */
	private projectEntry(e: Any, seq: number, byId: Map<string, Any>, lineage: Lineage, cwd: string): string | null {
		const id = typeof e?.id === "string" && e.id ? e.id : `#${seq}`;
		const kind = kindOf(e);
		const isOwn = typeof e?.id === "string" && byId.get(e.id) === e; // a duplicate id keeps only its first entry in the graph
		const seg = isOwn ? lineage.ownerOf(e) : null;
		const turn = isOwn ? lineage.turnOf(e) : null;
		const at = tsOf(e);
		const eventId = isOwn ? id : `${id}#${seq}`;
		this.db.prepare("INSERT INTO events_seen(event_id, seq, entry_id, parent_id, user_turn, kind, timestamp, source_handle, segment_id, content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)")
			.run(eventId, seq, id, e?.parentId ?? null, turn, kind, at, isOwn && MESSAGE_KINDS.has(kind) ? handleFor(id) : null, seg, hashEntry(e));
		if (!isOwn) return null;
		const segNode = seg ? nodeId.segment(seg) : null;
		const me = nodeId.entry(id);
		const label = kind === "toolResult" ? (e.message?.toolName ?? null) : e?.type === "custom" || e?.type === "custom_message" ? (e.customType ?? null) : null;
		this.putNode({ id: me, kind, canonical_key: id, label, entry_id: id, block_index: null, segment_id: seg, seq });
		const edge = (src: string, dst: string, type: EdgeRow["type"], k: EdgeRow["kind"] = "structural") => this.putEdge({ src, dst, type, eventId, segmentId: seg, kind: k, at });
		if (e.parentId && byId.has(e.parentId)) edge(nodeId.entry(e.parentId), me, "next_in_branch");
		if (seg === id) {
			this.putNode({ id: segNode!, kind: "segment", canonical_key: id, label: null, entry_id: id, block_index: null, segment_id: seg, seq });
			const req = lineage.requestOf(e);
			if (kind === "assistant" && req) edge(nodeId.entry(req), segNode!, "request_has_segment");
		}
		if (segNode) edge(me, segNode, "in_segment");
		if (e.type === "context_edit" && typeof e.targetId === "string") edge(me, nodeId.entry(e.targetId), "edits");
		if (e.type === "compaction" && typeof e.firstKeptEntryId === "string") edge(me, nodeId.entry(e.firstKeptEntryId), "compacts");

		// the call a tool result answers, for its edge and for the result's title and identifiers
		let callLabel = "", callRefs = "";
		if (kind === "toolResult") {
			const c = callFor(e, byId);
			if (c) {
				edge(nodeId.call(c.entryId, c.blockIndex), me, "answered_by");
				const b = byId.get(c.entryId)?.message?.content?.[c.blockIndex];
				let args = "";
				try { args = JSON.stringify(b?.arguments ?? {}); } catch {}
				callLabel = clip(`${b?.name ?? ""} ${args}`, 300);
				const r = referencesOf(b?.arguments, cwd);
				callRefs = [...r.files, ...r.urls, ...r.commands].join("\n");
			}
		}
		const userTurn = turn;
		for (const b of textBlocks(e)) {
			let identifiers = "";
			if (b.kind === "tool_call") {
				const cid = nodeId.call(id, b.blockIndex);
				this.putNode({ id: cid, kind: "tool_call", canonical_key: b.callId ?? cid, label: b.tool ?? null, entry_id: id, block_index: b.blockIndex, segment_id: seg, seq });
				edge(me, cid, "issued");
				const r = referencesOf(b.args, cwd);
				for (const f of r.files) { this.putNode({ id: nodeId.file(f), kind: "file", canonical_key: f, label: f, entry_id: null, block_index: null, segment_id: null, seq }, true); edge(cid, nodeId.file(f), "touches_file", "referential"); }
				for (const u of r.urls) { this.putNode({ id: nodeId.url(u), kind: "url", canonical_key: u, label: u, entry_id: null, block_index: null, segment_id: null, seq }, true); edge(cid, nodeId.url(u), "references_url", "referential"); }
				for (const c of r.commands) { this.putNode({ id: nodeId.command(c), kind: "command", canonical_key: c, label: c, entry_id: null, block_index: null, segment_id: null, seq }, true); edge(cid, nodeId.command(c), "uses_command", "referential"); }
				identifiers = [...r.files, ...r.urls, ...r.commands].join("\n");
			} else if (b.kind === "assistant" || b.kind === "thinking") {
				const bid = nodeId.block(id, b.blockIndex);
				this.putNode({ id: bid, kind: b.kind === "thinking" ? "thinking" : "assistant_text", canonical_key: bid, label: null, entry_id: id, block_index: b.blockIndex, segment_id: seg, seq });
				edge(me, bid, "contains_block");
			} else if (b.kind === "tool_result") identifiers = callRefs;
			const title = b.kind === "tool_result" ? `tool result ${callLabel || b.tool || ""}${b.isError ? " error" : ""}`.trim()
				: b.kind === "tool_call" ? `tool call ${b.tool ?? ""}`.trim()
				: b.kind === "thinking" ? "assistant reasoning (unverified)"
				: b.kind;
			const { chunks, indexed, truncated } = chunk(b.text);
			for (const c of chunks) {
				insertDoc(this.db, {
					objectType: "chunk", objectId: `chunk:${id}:${b.blockIndex}:${c.index}`, entryId: id, blockIndex: b.blockIndex, chunkIndex: c.index, charStart: c.start,
					segmentId: seg, kind: b.kind, tool: b.tool ?? null, isError: !!b.isError, title, requestText: "", body: c.text, identifiers,
					userTurn, seq, createdAt: at, rawChars: b.text.length, indexedChars: indexed, truncated,
				});
			}
		}
		return seg;
	}

	/** (Re)write one segment's row and its segment document from all its member entries. */
	private writeSegment(seg: string, byId: Map<string, Any>, lineage: Lineage, cwd: string) {
		const rows = this.db.prepare("SELECT entry_id, seq FROM events_seen WHERE segment_id = ? ORDER BY seq").all(seg);
		const members = rows.map((r) => ({ e: byId.get(String(r.entry_id)), seq: Number(r.seq) })).filter((m) => m.e);
		if (!members.length || !byId.has(seg)) return;
		const s = buildSegment(seg, members, lineage, byId, cwd);
		this.db.prepare(
			`INSERT OR REPLACE INTO segments(id, request_entry_id, user_turn, segment_ordinal, source_start_seq, source_end_seq, request_text, intent_text, closing_text, retrieval_text, created_at)
			 VALUES(?,?,?,?,?,?,?,?,NULL,?,?)`,
		).run(s.id, s.requestEntryId, s.userTurn, s.ordinal, s.startSeq, s.endSeq, s.requestText, s.intentText, s.retrievalText, s.createdAt);
		const objectId = `segment:${seg}`;
		deleteDoc(this.db, objectId);
		insertDoc(this.db, {
			objectType: "segment", objectId, entryId: seg, blockIndex: null, chunkIndex: null, charStart: null, segmentId: seg, kind: "segment", tool: null, isError: /\[error\]/.test(s.retrievalText),
			title: s.tools ? `step ${s.ordinal} of request ${s.userTurn}: ${s.tools}` : `request ${s.userTurn}`, requestText: s.requestText, body: s.retrievalText.replace(/^REQUEST: .*(\n|$)/, ""), identifiers: s.identifiers,
			userTurn: s.userTurn, seq: s.startSeq, createdAt: s.createdAt, rawChars: null, indexedChars: null, truncated: false,
		});
	}
}

/** Every logical row of a projection, without autoincrement ids or bookkeeping that names the source path: two projections of the
 *  same source compare equal through this whatever batches built them. */
export function logicalDump(db: Db): Record<string, unknown[]> {
	const q = (sql: string) => db.prepare(sql).all();
	return {
		meta: q("SELECT key, value FROM projection_meta WHERE key NOT IN ('source_file') ORDER BY key"),
		events: q("SELECT * FROM events_seen ORDER BY seq"),
		segments: q("SELECT * FROM segments ORDER BY id"),
		nodes: q("SELECT * FROM nodes ORDER BY id"),
		edges: q("SELECT src_id, dst_id, type, source_event_id, source_segment_id, confidence, source_kind, recorded_at, metadata_json FROM edges ORDER BY src_id, dst_id, type"),
		docs: q("SELECT object_type, object_id, entry_id, block_index, chunk_index, char_start, segment_id, kind, tool, is_error, title, request_text, body, identifiers, user_turn, seq, created_at, raw_chars, indexed_chars, truncated FROM search_docs ORDER BY object_id"),
		fts: q("SELECT d.object_id, f.title, f.request_text, f.body, f.identifiers FROM search_fts f JOIN search_docs d ON d.id = f.rowid ORDER BY d.object_id"),
	};
}
