// Reading the opened session's canonical source (Pi's persisted entries). Read-only: nothing here writes the session.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Any } from "../util.ts";

export const RECALL_TOOL_NAME = "zip_recall";
/** pi-zip's own custom message types never become search documents (hints, recaps and retrieval echoes are not history). */
const OWN_PREFIX = "pi-zip/";

export interface SessionSource {
	sessionId: string;
	file: string;
	header: Any;
	entries: Any[];
}

/**
 * The opened session only: its id, file, header and every persisted entry of every branch, in file order. Null when the session has
 * no file on disk yet (a new session before Pi's first flush, `--no-session`): there is nothing persisted to project.
 * Never lists the session directory.
 */
export function readSource(ctx: Any): SessionSource | null {
	const sm = ctx?.sessionManager;
	const file = sm?.getSessionFile?.();
	const sessionId = sm?.getSessionId?.();
	if (typeof file !== "string" || !file || typeof sessionId !== "string" || !sessionId) return null;
	if (!existsSync(file)) return null;
	const entries = sm.getEntries?.();
	if (!Array.isArray(entries)) return null;
	return { sessionId, file, header: sm.getHeader?.() ?? null, entries };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashEntry = (e: Any) => sha256(JSON.stringify(e));

export function tsOf(e: Any): number | null {
	const m = e?.type === "message" ? e.message : null;
	if (typeof m?.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
	const t = Date.parse(String(e?.timestamp ?? ""));
	return Number.isFinite(t) ? t : null;
}

/** "user" | "assistant" | "toolResult" | ... for message entries; the entry type otherwise ("compaction", "context_edit", "custom", ...). */
export function kindOf(e: Any): string {
	if (e?.type === "message") return String(e.message?.role ?? "message");
	return String(e?.type ?? "unknown");
}

export interface TextBlock {
	blockIndex: number;
	kind: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "custom";
	text: string;
	tool?: string;
	isError?: boolean;
	callId?: string;
	args?: Any;
}

/** A content array's text blocks with their index in the source content (images and opaque blocks keep their index, give no text). */
function blocksOf(content: Any): Array<{ i: number; b: Any }> {
	if (typeof content === "string") return [{ i: 0, b: { type: "text", text: content } }];
	return Array.isArray(content) ? content.map((b: Any, i: number) => ({ i, b })) : [];
}

/**
 * The searchable text of one source entry, block by block, exactly as persisted: user text, assistant text and thinking, tool call
 * names and arguments, tool result text, other extensions' custom messages. zip_recall results (retrieval echoes) and pi-zip's own
 * custom messages give none. Compaction summaries and context edits are structure only: the original messages stay searchable.
 */
export function textBlocks(e: Any): TextBlock[] {
	const out: TextBlock[] = [];
	if (e?.type === "custom_message") {
		if (String(e.customType ?? "").startsWith(OWN_PREFIX)) return out;
		for (const { i, b } of blocksOf(e.content)) if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ blockIndex: i, kind: "custom", text: b.text });
		return out;
	}
	const m = e?.type === "message" ? e.message : null;
	if (!m) return out;
	if (m.role === "user") {
		for (const { i, b } of blocksOf(m.content)) if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ blockIndex: i, kind: "user", text: b.text });
	} else if (m.role === "assistant") {
		for (const { i, b } of blocksOf(m.content)) {
			if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ blockIndex: i, kind: "assistant", text: b.text });
			else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking) out.push({ blockIndex: i, kind: "thinking", text: b.thinking });
			else if (b?.type === "toolCall" && typeof b.name === "string") {
				let args = "";
				try { args = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}); } catch {}
				out.push({ blockIndex: i, kind: "tool_call", text: `${b.name} ${args}`.trim(), tool: b.name, callId: typeof b.id === "string" ? b.id : undefined, args: b.arguments });
			}
		}
	} else if (m.role === "toolResult") {
		if (m.toolName === RECALL_TOOL_NAME) return out;
		for (const { i, b } of blocksOf(m.content)) if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ blockIndex: i, kind: "tool_result", text: b.text, tool: typeof m.toolName === "string" ? m.toolName : undefined, isError: !!m.isError });
	} else if (m.role === "bashExecution") {
		const text = `${m.command ?? ""}\n${m.output ?? ""}`.trim();
		if (text) out.push({ blockIndex: 0, kind: "tool_result", text, tool: "bash", isError: typeof m.exitCode === "number" && m.exitCode !== 0 });
	}
	return out;
}

/** Visible assistant prose of one message (thinking excluded). */
export function visibleText(m: Any): string {
	if (typeof m?.content === "string") return m.content;
	return Array.isArray(m?.content) ? m.content.filter((b: Any) => b?.type === "text" && typeof b.text === "string").map((b: Any) => b.text).join("\n") : "";
}
