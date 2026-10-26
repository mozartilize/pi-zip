// A small Pi session with branches, parallel and reused tool call ids, thinking, a context edit, a compaction, a recall echo and
// custom messages; and a fake session manager over it (the ReadonlySessionManager subset the ledger and retrieval read).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export type Any = any;

let clock = Date.UTC(2026, 0, 1);
export const E = (id: string, parentId: string | null, rest: Any) => ({ id, parentId, timestamp: new Date((clock += 1000)).toISOString(), ...rest });
const M = (id: string, parentId: string | null, message: Any) => E(id, parentId, { type: "message", message: { timestamp: clock + 1000, ...message } });
export const user = (id: string, parentId: string | null, text: string) => M(id, parentId, { role: "user", content: text });
export const asst = (id: string, parentId: string | null, content: Any[]) => M(id, parentId, { role: "assistant", content, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop" });
export const result = (id: string, parentId: string | null, callId: string, toolName: string, text: string, isError = false) =>
	M(id, parentId, { role: "toolResult", toolCallId: callId, toolName, isError, content: [{ type: "text", text }] });
export const call = (id: string, name: string, args: Any) => ({ type: "toolCall", id, name, arguments: args });

/** 7,000 characters: three chunks (0-3000, 2700-5700, 5400-7000). The marker sits only in the third chunk. */
export const LONG = "x".repeat(6000) + " mutex deadlock in queue.ts after 317 ms " + "y".repeat(1000 - " mutex deadlock in queue.ts after 317 ms ".length);

export function fixtureEntries(): Any[] {
	clock = Date.UTC(2026, 0, 1); // the same timestamps on every call
	return [
		user("u1", null, "fix the retry timeout in src/retry.ts"),
		asst("a1", "u1", [
			{ type: "thinking", thinking: "suspect connection cleanup leaks sockets" },
			{ type: "text", text: "Running the tests first" },
			call("c1", "bash", { command: "cd /w && npm test" }),
			call("c2", "read", { path: "src/retry.ts" }),
		]),
		result("r1", "a1", "c2", "read", "export function retry(fn) { return fn(); }"), // the second call's result arrives first
		result("r2", "r1", "c1", "bash", "FAIL test/retry.test.ts\nError: timeout after 30000ms", true),
		asst("a2", "r2", [call("c1", "bash", { command: "npm test -- retry" })]), // the call id c1 again
		result("r3", "a2", "c1", "bash", "PASS 12 tests"),
		asst("a3", "r3", [{ type: "text", text: "Fixed by closing sockets in the pool." }]),
		user("u2", "a3", "now add an export to CSV"), // one branch
		user("u3", "a3", "try the mutex approach instead"), // its sibling (the active branch below)
		asst("a4", "u3", [call("c3", "bash", { command: "npm run bench" })]),
		result("r4", "a4", "c3", "bash", LONG),
		E("ce", "r4", { type: "context_edit", targetId: "r2", replacement: { content: [{ type: "text", text: "[folded by pi-zip · bash npm test]" }] } }),
		E("cm", "ce", { type: "compaction", summary: "summary text walrus-token", firstKeptEntryId: "u3", tokensBefore: 1000 }),
		asst("a5", "cm", [call("c4", "zip_recall", { handle: "x" })]),
		result("r5", "a5", "c4", "zip_recall", "recall echo zebra-token"),
		E("pm", "r5", { type: "custom_message", customType: "pi-zip/notice", content: "pi-zip own giraffe-token", display: false }),
		E("om", "pm", { type: "custom_message", customType: "other-ext", content: "other extension okapi-token", display: true }),
	];
}

/** The ancestry of `leaf`, root first (Pi's getBranch). */
export function branchOf(entries: Any[], leaf: string): Any[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const out: Any[] = [];
	for (let cur = byId.get(leaf); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift(cur);
	return out;
}

/** A session file on disk plus a fake session manager over `entries`. The model view shows every message of the branch in full
 *  unless its entry id is in `folded` (replaced by pi-zip's placeholder). `hidden` drops an entry from the view entirely (the effect
 *  of a compaction), which also makes it hidden. */
export function fakeSession(entries: Any[], o: { dir?: string; id?: string; leaf?: string; folded?: string[]; hidden?: string[] } = {}) {
	const dir = o.dir ?? mkdtempSync(join(tmpdir(), "pi-zip-mem-"));
	const id = o.id ?? "sA";
	const file = join(dir, `2026-01-01_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: "/w" };
	writeFileSync(file, [header, ...entries].map((x) => JSON.stringify(x)).join("\n") + "\n");
	const state = { entries, leaf: o.leaf ?? entries[entries.length - 1]?.id ?? null };
	const sm: Any = {
		getSessionFile: () => file,
		getSessionId: () => id,
		getHeader: () => header,
		getEntries: () => [...state.entries],
		getBranch: () => branchOf(state.entries, state.leaf),
		getEntry: (x: string) => state.entries.find((e) => e.id === x),
		getLeafId: () => state.leaf,
		buildSessionProjection: () => ({
			entries: branchOf(state.entries, state.leaf).map((e) => {
				const fold = o.folded?.includes(e.id) ?? false;
				const shown = e.type === "message" ? e.message : e.type === "custom_message" ? { role: "user", content: [{ type: "text", text: e.content }] } : null;
				const msg = shown && !o.hidden?.includes(e.id) ? (fold ? { ...shown, content: [{ type: "text", text: "[folded by pi-zip · x]" }] } : shown) : null;
				return { sourceEntry: e, messages: msg ? [msg] : [] };
			}),
		}),
	};
	return { dir, file, header, sm, state, ctx: { sessionManager: sm, cwd: "/w", model: { provider: "p", id: "main", contextWindow: 200_000 } } as Any };
}
