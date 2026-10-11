// Placeholders (F2): tool + args + size + key lines + handle. Handles are deterministic in the session entry id.
import { createHash } from "node:crypto";
import type { Block, Calls } from "./plan.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { type Any, clip, textOf } from "./util.ts";

export const PH_MARK = "[folded by pi-zip";
export const RECALL_TOOL = "zip_recall";
const MIN_FOLD_CHARS = 1000; // shorter outputs are never worth a placeholder

/** Deterministic recall handle for a session entry id: 10-char base36 of sha256("pi-zip:"+id)[0..12). */
export function handleFor(entryId: string): string {
	const hex = createHash("sha256").update(`pi-zip:${entryId}`).digest("hex").slice(0, 12);
	return BigInt("0x" + hex).toString(36).padStart(Math.ceil(48 / Math.log2(36)), "0").slice(-10);
}

export interface KeyLine {
	no: number;
	text: string;
	why: "error" | "id" | "first" | "last";
}

const ERROR_LINE_RE = /error|fail|exception|warning/i;
const ID_LINE_RE = /\b[A-Z]{2,}-[A-Z0-9-]{3,}\b/;
const KEYVAL_LINE_RE = /\b[A-Za-z_][A-Za-z0-9_.-]*=(?:"[^"]*"|\S+)/;
const LABEL_NUM_RE = /\b[A-Za-z][A-Za-z0-9_. \/-]{0,30}:\s*-?\d|\b-?\d[\d.,]*\s+(?:ms|s|kb|mb|gb|tokens?|bytes|lines)\b/i;
const HEXISH_RE = /\b[0-9a-f]{8,}\b/gi;

const hexLike = (line: string): boolean => {
	for (const m of line.matchAll(HEXISH_RE)) if (/[a-f]/i.test(m[0]) && /\d/.test(m[0])) return true; // letters+digits reads as an id/hash
	return false;
};

/** Deterministic key lines: first line, error/warning lines, id-like lines (tickets, hashes, key=value, labelled numbers), last line; sorted by line number. */
export function pickKeyLines(text: string, keep = 8): KeyLine[] {
	const lines = text.split("\n");
	if (keep <= 0 || !lines.length) return [];
	const picked = new Map<number, KeyLine>();
	const add = (no: number, why: KeyLine["why"]) => {
		if (picked.size >= keep || picked.has(no)) return;
		const t = lines[no - 1] ?? "";
		if (t.trim()) picked.set(no, { no, text: t, why });
	};
	const room = () => picked.size < keep - (picked.has(lines.length) ? 0 : 1); // always leave room for the last line
	add(1, "first");
	for (let i = 0; i < lines.length && room(); i++) if (i > 0 && i < lines.length - 1 && ERROR_LINE_RE.test(lines[i])) add(i + 1, "error");
	for (let i = 0; i < lines.length && room(); i++) {
		const no = i + 1;
		if (no === 1 || no === lines.length || picked.has(no)) continue;
		if (ID_LINE_RE.test(lines[i]) || hexLike(lines[i]) || KEYVAL_LINE_RE.test(lines[i]) || LABEL_NUM_RE.test(lines[i])) add(no, "id");
	}
	add(lines.length, "last");
	return [...picked.values()].sort((a, b) => a.no - b.no);
}

/** Collapse whitespace and cut to `n` chars keeping head AND tail (the distinguishing part of a path or command is often its end). */
export function clipMid(s: string, n: number): string {
	s = s.replace(/\s+/g, " ").trim();
	if (s.length <= n) return s;
	const head = Math.ceil((n - 1) * 0.6);
	return s.slice(0, head) + "…" + s.slice(s.length - (n - 1 - head));
}

const ARG_CHARS = 90;

/** A leading `cd <dir> &&` or `cd <dir>;` (the dir quoted or not), the prefix a whole session of commands often shares. */
const CD_RE = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
export const cdDirOf = (cmd: string): string | null => CD_RE.exec(cmd)?.[1] ?? null;
/** The `cd <dir>` prefixes at least two of these commands share (they say nothing that tells the rows apart), sorted. */
export function sharedCdDirs(cmds: string[]): Set<string> {
	const n = new Map<string, number>();
	for (const c of cmds) {
		const d = cdDirOf(c);
		if (d) n.set(d, (n.get(d) ?? 0) + 1);
	}
	return new Set([...n].filter(([, k]) => k >= 2).map(([d]) => d).sort());
}

const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
const ECHO_RE = /^\s*(?:echo|printf|print\(|console\.log\()/;
/** A heredoc command shown by its command line and the part of its body that tells it apart: a comment, else an echo/print line, else
 *  the tail of the body (the head is boilerplate: imports, file opens), then whatever follows the terminator. null: no heredoc. */
function heredocLabel(cmd: string): string | null {
	const lines = cmd.split("\n");
	const m = HEREDOC_RE.exec(lines[0]);
	if (!m || lines.length < 2) return null;
	let end = lines.findIndex((l, i) => i > 0 && l.trim() === m[2]);
	if (end < 0) end = lines.length;
	const body = lines.slice(1, end).filter((l) => l.trim());
	const after = lines.slice(end + 1).join(" ").trim();
	const comment = body.find((l) => /^\s*(#(?!!)|\/\/)\s*\S/.test(l));
	const echo = body.find((l) => ECHO_RE.test(l));
	const gist = comment ?? echo ?? body.slice(-2).join(" ");
	return `${lines[0].trim()} … ${gist.trim()}${after ? ` ${m[2]} ${after}` : ""}`;
}

/** A command as a label: a `cd` prefix shared with other rows (`shared`) dropped, a heredoc shown by its gist, clipped in the middle. */
export function cmdLabel(cmd: string, n = ARG_CHARS, shared?: Set<string>): string {
	const d = cdDirOf(cmd);
	const c = d && shared?.has(d) ? cmd.replace(CD_RE, "") : cmd;
	return clipMid(heredocLabel(c) ?? c, n);
}

export function shortArgs(args: Any, n = ARG_CHARS, shared?: Set<string>): string {
	if (!args || typeof args !== "object") return "";
	if (typeof args.command === "string") return cmdLabel(args.command, n, shared);
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (path !== null && typeof args.pattern !== "string") {
		// which slice of the file, written the way Pi's own read row writes it: "src/a.ts:1-2000", "src/a.ts:50-"
		const num = (k: string) => (typeof args[k] === "number" && Number.isFinite(args[k]) ? (args[k] as number) : undefined);
		const off = num("offset"), lim = num("limit");
		const start = off ?? 1;
		const win = off !== undefined || lim !== undefined ? `:${start}${lim !== undefined ? `-${start + lim - 1}` : ""}` : "";
		return clipMid(path, n) + win;
	}
	if (typeof args.pattern === "string") return clipMid(args.pattern + (args.path ? " " + args.path : ""), n);
	try {
		return clipMid(JSON.stringify(args), n);
	} catch {
		return "";
	}
}

/**
 * Rows that would show the same label: for each output, the first line (its `preferred` key lines first, then every line in order) that
 * no other of these outputs contains and that is not one of the `taken` labels already shown; null when there is none. Lines compare
 * as shown (whitespace collapsed, clipped to `n`). Pure: the same outputs always give the same lines.
 */
export function distinctLines(texts: string[], preferred: string[][] = [], taken: string[] = [], n = 90, maxLines = 2000): Array<string | null> {
	const norm = (l: string) => clip(l, n);
	const linesOf = texts.map((t, i) => [...(preferred[i] ?? []), ...t.split("\n", maxLines)].map(norm).filter((l) => l));
	const count = new Map<string, number>();
	for (const ls of linesOf) for (const l of new Set(ls)) count.set(l, (count.get(l) ?? 0) + 1);
	const used = new Set(taken.map(norm));
	return linesOf.map((ls) => ls.find((l) => count.get(l) === 1 && !used.has(l)) ?? null);
}

const COUNT_RE = /\b(\d+)\s+(passed|passing|pass|failed|failing|fail|skipped|errors?)\b/gi;
const COUNT_ORDER = ["passed", "failed", "skipped", "errors"];

/**
 * Deterministic one-line outcome of a command, from the output alone: exit status (bash) and test counts when the tail of the
 * output has "N passed / N failed" style summaries. `isError` (the tool result flag) lets a bash result without an exit-code
 * line read as "exit 0" or "error"; leave it undefined when unknown. Empty string = nothing distinctive to say.
 */
export function outcomeHint(text: string, tool: string, isError?: boolean): string {
	if (tool !== "bash") return "";
	const tail = text.slice(-2000);
	const parts: string[] = [];
	const ex = [...tail.matchAll(/Command exited with code (\d+)/g)].pop();
	if (ex) parts.push(`exit ${ex[1]}`);
	else if (/Command timed out/.test(tail)) parts.push("timed out");
	else if (/Command aborted/.test(tail)) parts.push("aborted");
	else if (isError === true) parts.push("error");
	else if (isError === false) parts.push("exit 0");
	const last = new Map<string, string>();
	for (const m of tail.matchAll(COUNT_RE)) {
		const w = m[2].toLowerCase();
		last.set(w.startsWith("pass") ? "passed" : w.startsWith("fail") ? "failed" : w === "skipped" ? "skipped" : "errors", m[1]);
	}
	if (last.has("passed") || last.has("failed")) parts.push(COUNT_ORDER.filter((k) => last.has(k)).map((k) => `${last.get(k)} ${k}`).join(", "));
	return parts.join(", ");
}

export interface PlaceholderMeta {
	turn?: number; // user turn the output belongs to (1-based, as seen in the projection when it was folded)
	isError?: boolean;
	noRecall?: boolean; // zip_recall is not declared to the model (`--tools` allowlist): point at re-reading instead
	file?: FileRecall; // ... but read, grep or bash is: point at the recall file (written on demand from the session)
}

/** Placeholder text, or null when the output is too short to be worth folding. The text is stored with the fold (context_edit),
 *  so it is rendered once and old folds keep their bytes whatever this format becomes. */
export function makePlaceholder(text: string, tool: string, args: string, handle: string, keep = 8, meta: PlaceholderMeta = {}): string | null {
	if (text.length <= MIN_FOLD_CHARS) return null;
	const lines = text.split("\n").length;
	const keys = pickKeyLines(text, keep);
	const body = keys.map((k) => `${k.no}: ${clip(k.text, 160)}`).join("\n");
	const outcome = outcomeHint(text, tool, meta.isError);
	return (
		`${PH_MARK} · ${tool}${args ? " " + args : ""}${meta.turn ? ` · turn ${meta.turn}` : ""}${outcome ? ` · ${outcome}` : ""} · ${text.length} chars, ${lines} lines · handle ${handle}]\n` +
		(keys.length ? `key lines kept (original line numbers; up to ${keep}):\n${body}\n` : "") +
		(meta.file
			? `Original kept byte for byte, even after summaries or compaction, in ${meta.file.dir}/${handle}.txt: ${fileRecallHow(meta.file)}; prefer that to re-running or re-reading the source (output may differ). Do not guess its content.`
			: !meta.noRecall
			? `Original kept byte for byte, recallable even after summaries or compaction: ${RECALL_TOOL}("${handle}") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.`
			: `Original not shown (${RECALL_TOOL} is not enabled in this session): re-read the file or re-run the read-only command if you need it. Do not guess its content.`)
	);
}

/** Placeholder for a toolResult block (null for image results, entries without an id, or short outputs). */
export function makePlaceholderFor(b: Block, calls: Calls, keep = 8, noRecall = false, file?: FileRecall): string | null {
	const content = b.msg.content;
	if (Array.isArray(content) && content.some((c: Any) => c?.type !== "text")) return null;
	if (!b.entryId) return null;
	const call = calls.get(b.msg.toolCallId);
	return makePlaceholder(textOf(content), call?.name ?? b.msg.toolName ?? "tool", call ? shortArgs(call.args) : "", handleFor(b.entryId), keep, { turn: b.userTurn, isError: !!b.msg.isError, noRecall, file });
}
