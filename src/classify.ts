// Retrievability classification (F5): can the model get this output back by simply re-running the call?
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Any } from "./util.ts";

export type Recover = "rereadable" | "nonrereadable";
export type SummaryReadDecision = {
	eligible: boolean;
	reason: "verified-matching-read" | "volatile-snapshot" | "not-read-tool" | "missing-path" | "read-mismatch" | "image-or-error" | "unknown";
};

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50 * 1024;
const READ_MAX_DISK_BYTES = 32 * 1024 * 1024; // avoid unbounded memory on giant binary/log files

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function formatReadSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateReadHead(content: string) {
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	if (totalLines <= READ_MAX_LINES && totalBytes <= READ_MAX_BYTES) {
		return { content, truncated: false, truncatedBy: null as "lines" | "bytes" | null, outputLines: totalLines, firstLineExceedsLimit: false };
	}
	if (Buffer.byteLength(lines[0] ?? "", "utf-8") > READ_MAX_BYTES) {
		return { content: "", truncated: true, truncatedBy: "bytes" as const, outputLines: 0, firstLineExceedsLimit: true };
	}
	const out: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < READ_MAX_LINES; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > READ_MAX_BYTES) {
			truncatedBy = "bytes";
			break;
		}
		out.push(line);
		bytes += lineBytes;
	}
	if (out.length >= READ_MAX_LINES && bytes <= READ_MAX_BYTES) truncatedBy = "lines";
	return { content: out.join("\n"), truncated: true, truncatedBy, outputLines: out.length, firstLineExceedsLimit: false };
}

/** True iff `rawText` is an exact text-read output for the current file on disk under Pi's read slice/truncation contract. */
export function matchesPiReadOutput(args: Any, rawText: string, cwd: string, content?: Any): SummaryReadDecision {
	if (Array.isArray(content) && content.some((b: Any) => b?.type === "image")) return { eligible: false, reason: "image-or-error" };
	if (/^Read image file \[|^\[Line \d+ is [^\]]*exceeds /.test(rawText)) return { eligible: false, reason: "image-or-error" };
	const a: Any = args ?? {};
	const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
	if (!p) return { eligible: false, reason: "missing-path" };
	if (a.offset !== undefined && (typeof a.offset !== "number" || !Number.isFinite(a.offset) || !Number.isInteger(a.offset))) return { eligible: false, reason: "unknown" };
	if (a.limit !== undefined && (typeof a.limit !== "number" || !Number.isFinite(a.limit) || !Number.isInteger(a.limit) || a.limit < 0)) return { eligible: false, reason: "unknown" };
	try {
		const full = isAbsolute(p) ? p : join(cwd, p);
		const st = statSync(full);
		if (!st.isFile() || st.size > READ_MAX_DISK_BYTES) return { eligible: false, reason: "read-mismatch" };
		const textContent = readFileSync(full, "utf-8");
		const allLines = textContent.split("\n");
		const totalFileLines = allLines.length;
		const offset = typeof a.offset === "number" ? a.offset : undefined;
		const limit = typeof a.limit === "number" ? a.limit : undefined;
		const startLine = offset ? Math.max(0, offset - 1) : 0;
		const startLineDisplay = startLine + 1;
		if (startLine >= allLines.length) return { eligible: false, reason: "read-mismatch" };
		let selectedContent: string;
		let userLimitedLines: number | undefined;
		if (limit !== undefined) {
			const endLine = Math.min(startLine + limit, allLines.length);
			selectedContent = allLines.slice(startLine, endLine).join("\n");
			userLimitedLines = endLine - startLine;
		} else {
			selectedContent = allLines.slice(startLine).join("\n");
		}
		const truncation = truncateReadHead(selectedContent);
		if (truncation.firstLineExceedsLimit) return { eligible: false, reason: "image-or-error" };
		const candidates = new Set<string>([truncation.content]);
		if (truncation.truncated) {
			const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
			const nextOffset = endLineDisplay + 1;
			if (truncation.truncatedBy === "lines") {
				candidates.add(`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`);
				candidates.add(`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}]`);
			} else {
				candidates.add(`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatReadSize(READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`);
			}
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;
			candidates.add(`${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`);
			candidates.add(`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${startLine + userLimitedLines} of ${totalFileLines}]`);
		} else {
			candidates.add(`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${totalFileLines} of ${totalFileLines}]`);
			if (truncation.content.endsWith("\n") && totalFileLines > 1) {
				const noTrail = truncation.content.slice(0, -1);
				const nonEmptyLines = totalFileLines - 1;
				candidates.add(`${noTrail}\n\n[Showing lines ${startLineDisplay}-${nonEmptyLines} of ${nonEmptyLines}]`);
			}
		}
		return candidates.has(rawText) ? { eligible: true, reason: "verified-matching-read" } : { eligible: false, reason: "read-mismatch" };
	} catch {
		return { eligible: false, reason: "read-mismatch" };
	}
}

const READ_ONLY_CMDS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "file", "stat", "du", "pwd", "echo"]);
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "shortlog"]);

// Options that make an otherwise read-only command write files or run other programs.
const FIND_UNSAFE = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const GIT_UNSAFE = /^--(output(=.*)?|ext-diff|textconv|open-files-in-pager.*|exec-path.*)$/;
const RG_UNSAFE = /^--(pre|pre-glob)(=.*)?$/;

/** Read-only bash whitelist: every pipe/;/&& segment must be a whitelisted command with no write or exec option; substitutions, redirections and background jobs are never read-only. */
export function isReadOnlyBash(cmd: string): boolean {
	const c = String(cmd ?? "").replace(/2>(\/dev\/null|&1)/g, " ").trim();
	if (!c || /[<>`]|\$\(/.test(c)) return false; // any remaining redirection can write; $(...) and backticks run arbitrary commands
	if (/&/.test(c.replace(/&&/g, ";"))) return false; // a lone & backgrounds a job (and `&>` redirects)
	const segments = c.split(/[|;\n]|&&/).map((s) => s.trim()).filter(Boolean);
	if (!segments.length) return false;
	for (const seg of segments) {
		let toks = seg.split(/\s+/).filter(Boolean);
		while (toks.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
		const head = (toks[0] ?? "").toLowerCase();
		const rest = toks.slice(1);
		if (head === "find") {
			if (rest.some((t) => FIND_UNSAFE.test(t))) return false;
			continue;
		}
		if (head === "rg") {
			if (rest.some((t) => RG_UNSAFE.test(t))) return false;
			continue;
		}
		if (head === "file") {
			if (rest.some((t) => /^-[A-Za-z]*C/.test(t) || t === "--compile")) return false; // file -C writes a magic database
			continue;
		}
		if (READ_ONLY_CMDS.has(head)) continue;
		if (head === "git" && READ_ONLY_GIT.has((toks[1] ?? "").toLowerCase())) {
			if (rest.some((t) => GIT_UNSAFE.test(t))) return false;
			continue;
		}
		return false;
	}
	return true;
}

/** read: rereadable iff the file still exists and its slice/truncation equals what the tool returned (unchanged since).
 *  bash: rereadable iff read-only. grep/find/ls/glob: re-runnable queries. Everything else: not rereadable. */
export function classifyRecoverability(tool: string, args: Any, rawText: string, cwd: string, content?: Any): Recover {
	tool = String(tool ?? "").toLowerCase();
	const a: Any = args ?? {};
	if (tool === "read") return matchesPiReadOutput(a, rawText, cwd, content).eligible ? "rereadable" : "nonrereadable";
	if (tool === "bash") return typeof a.command === "string" && isReadOnlyBash(a.command) ? "rereadable" : "nonrereadable";
	if (tool === "grep" || tool === "find" || tool === "ls" || tool === "glob") return "rereadable";
	return "nonrereadable";
}

/** Summary routine-read eligibility: unlike `classifyRecoverability`, read-only bash/search snapshots (`git status`, `git diff`, `ls`, `grep`)
 *  are historical observations of a mutable workspace and are NOT eligible for routine-read omission. Only verified matching `read` outputs qualify. */
export function classifySummaryRead(tool: string, args: Any, rawText: string, cwd: string, isError?: boolean, content?: Any): SummaryReadDecision {
	if (isError) return { eligible: false, reason: "image-or-error" };
	const name = String(tool ?? "");
	if (name !== "read") {
		const low = name.toLowerCase();
		if (low === "bash" || low === "grep" || low === "find" || low === "ls" || low === "glob") return { eligible: false, reason: "volatile-snapshot" };
		return { eligible: false, reason: "not-read-tool" };
	}
	return matchesPiReadOutput(args, rawText, cwd, content);
}
