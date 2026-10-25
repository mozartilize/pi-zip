// Graph identity and deterministic relations. Every node and edge follows from the source structure (structural) or from an exact
// identifier in tool arguments (referential). Nothing here infers that a later step verified or fixed an earlier one.
import { isAbsolute, normalize, resolve } from "node:path";
import type { Any } from "../util.ts";
import type { Db } from "./db.ts";

export const nodeId = {
	entry: (id: string) => `entry:${id}`,
	block: (id: string, i: number) => `block:${id}:${i}`,
	call: (id: string, i: number) => `call:${id}:${i}`,
	segment: (id: string) => `seg:${id}`,
	file: (p: string) => `file:${p}`,
	url: (u: string) => `url:${u}`,
	command: (c: string) => `command:${c}`,
};

/** Edge types. Structural: contains_block, issued, answered_by, next_in_branch, in_segment, request_has_segment, edits, compacts.
 *  Referential: touches_file, references_url, uses_command. */
export type EdgeType =
	| "contains_block" | "issued" | "answered_by" | "next_in_branch" | "in_segment" | "request_has_segment" | "edits" | "compacts"
	| "touches_file" | "references_url" | "uses_command";

export interface NodeRow { id: string; kind: string; canonical_key: string; label: string | null; entry_id: string | null; block_index: number | null; segment_id: string | null; seq: number; metadata?: Any }
export interface EdgeRow { src: string; dst: string; type: EdgeType; eventId: string; segmentId: string | null; kind: "structural" | "referential"; at: number | null }

/** The call a tool result answers: the nearest preceding assistant message on the result's own ancestry that issued its toolCallId.
 *  An id issued twice by that one message is ambiguous: no association. Timestamps are never used. */
export function callFor(result: Any, byId: Map<string, Any>): { entryId: string; blockIndex: number } | null {
	const id = result?.message?.toolCallId;
	if (typeof id !== "string" || !id) return null;
	let cur = result.parentId ? byId.get(result.parentId) : undefined;
	for (let hops = 0; cur && hops < 5000; hops++) {
		const m = cur.type === "message" ? cur.message : null;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			const at: number[] = [];
			m.content.forEach((b: Any, i: number) => { if (b?.type === "toolCall" && b.id === id) at.push(i); });
			if (at.length === 1) return { entryId: cur.id, blockIndex: at[0] };
			if (at.length > 1) return null;
		}
		if (m?.role === "user") return null; // a result never answers a call from before its own request
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return null;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const MULTI = new Set(["npm", "pnpm", "yarn", "bun", "npx", "git", "cargo", "go", "make", "docker", "kubectl", "pip", "uv", "python", "python3", "node", "deno", "pytest", "gh"]);

/** Exact identifiers of one tool call: a file it names (resolved against the session cwd), a URL, the program a shell command runs. */
export function referencesOf(args: Any, cwd: string): { files: string[]; urls: string[]; commands: string[] } {
	const out = { files: [] as string[], urls: [] as string[], commands: [] as string[] };
	if (!args || typeof args !== "object") return out;
	for (const k of PATH_KEYS) {
		const p = args[k];
		if (typeof p === "string" && p && p.length < 1024 && !/^\w+:\/\//.test(p)) out.files.push(normalize(isAbsolute(p) || !cwd ? p : resolve(cwd, p)));
	}
	if (typeof args.url === "string" && /^https?:\/\//.test(args.url)) out.urls.push(args.url.slice(0, 1024));
	if (typeof args.command === "string") {
		for (const part of args.command.split(/&&|\|\||;|\|/)) {
			const words = part.trim().split(/\s+/).filter((w: string) => w && !/^\w+=/.test(w));
			if (!words.length || words[0] === "cd") continue;
			const prog = words[0].replace(/^.*\//, "");
			const cmd = MULTI.has(prog) && words[1] && !words[1].startsWith("-") ? `${prog} ${words[1]}` : prog;
			if (/^[\w.+-]+( [\w.:+-]+)?$/.test(cmd) && !out.commands.includes(cmd)) out.commands.push(cmd);
		}
	}
	return out;
}

/** One-hop typed neighbors of a node, both directions, restricted to an edge-type allowlist. */
export function neighbors(db: Db, id: string, types: EdgeType[], limit = 20): Array<{ id: string; type: string; dir: "out" | "in" }> {
	if (!types.length) return [];
	const q = types.map(() => "?").join(",");
	const rows = db.prepare(
		`SELECT dst_id AS id, type, 'out' AS dir FROM edges WHERE src_id = ? AND type IN (${q})
		 UNION ALL SELECT src_id AS id, type, 'in' AS dir FROM edges WHERE dst_id = ? AND type IN (${q}) LIMIT ?`,
	).all(id, ...types, id, ...types, limit);
	return rows.map((r) => ({ id: String(r.id), type: String(r.type), dir: r.dir === "in" ? "in" : "out" }));
}
