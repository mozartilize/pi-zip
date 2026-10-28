// Fork-only command aliases, bounded hints and fold timestamps. Upstream formatting stays in placeholder.ts.
import { blockTime, cdDirOf, clipMid, cmdLabel as upstreamCmdLabel, jsonKeyFields, outcomeHint, PH_MARK, RECALL_TOOL, whenLabel, pickKeyLines as upstreamKeyLines, sharedCdDirs, shortArgs as upstreamShortArgs, type KeyLine, type PlaceholderMeta as UpstreamMeta } from "./placeholder.ts";
import { handleFor } from "./handle.ts";
import type { Block } from "./plan.ts";
import { type Calls, callOf } from "./fold-policy.ts";
import { type FileRecall, fileRecallHow } from "./recallfile.ts";
import { type Any, clip, fmtWhen, textOf } from "./util.ts";
export { blockTime, clipMid, distinctLines, jsonKeyFields, outcomeHint, PH_MARK, RECALL_TOOL, whenLabel } from "./placeholder.ts";
export { handleFor, handleTokens } from "./handle.ts";
export const MIN_FOLD_CHARS = 1000;
export const KEY_LINE_MAX_CHARS = 500;
const CD_RE = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

export function pickKeyLines(text: string, keep = 8, maxLineChars = KEY_LINE_MAX_CHARS): KeyLine[] {
	return upstreamKeyLines(text, keep).map(k => ({ ...k, text: maxLineChars > 0 && k.text.length > maxLineChars ? clipMid(k.text, maxLineChars) : k.text }));
}

export function cmdLabel(cmd: string, n = 90, aliases?: Map<string, string>): string {
	const d = cdDirOf(cmd), a = d ? aliases?.get(d) : undefined;
	if (!a) return upstreamCmdLabel(cmd, n);
	const head = `[${a}] `;
	return head + upstreamCmdLabel(cmd.replace(CD_RE, ""), Math.max(1, n - head.length));
}

export function shortArgs(args: Any, n = 90, aliases?: Map<string, string>): string {
	return typeof args?.command === "string" ? cmdLabel(args.command, n, aliases) : upstreamShortArgs(args, n);
}

export interface PlaceholderMeta extends UpstreamMeta { foldedAt?: number }

/** Placeholder text, or null when the output is too short to be worth folding. Owned here (not a rewrite of upstream's text) so an
 *  upstream wording change cannot silently drop the fold time. Stored with the fold, so old folds keep their bytes. */
export function makePlaceholder(text: string, tool: string, args: string, handle: string, keep = 8, meta: PlaceholderMeta = {}): string | null {
	if (text.length <= MIN_FOLD_CHARS) return null;
	const lines = text.split("\n").length;
	const fields = jsonKeyFields(text, keep);
	const keys = fields?.length ? [] : pickKeyLines(text, keep);
	const body = keys.map((k) => `${k.no}: ${clip(k.text, 160)}`).join("\n");
	const outcome = outcomeHint(text, tool, meta.isError);
	const when = whenLabel(meta.at, meta.turn);
	return (
		`${PH_MARK}${meta.foldedAt ? ` at ${fmtWhen(meta.foldedAt)}` : ""} · ${tool}${args ? " " + args : ""}${when ? ` · ${when}` : ""}${outcome ? ` · ${outcome}` : ""} · ${text.length} chars, ${lines} lines · handle ${handle}]\n` +
		(fields?.length ? `key fields kept (JSON; path: value, long strings show their end; up to ${keep}):\n${fields.join("\n")}\n` : "") +
		(keys.length ? `key lines kept (original line numbers; up to ${keep}):\n${body}\n` : "") +
		(meta.file
			? `Original kept byte for byte, even after summaries or compaction, in ${meta.file.dir}/${handle}.txt: ${fileRecallHow(meta.file)}; prefer that to re-running or re-reading the source (output may differ). Do not guess its content.`
			: !meta.noRecall
			? `Original kept byte for byte, recallable even after summaries or compaction: ${RECALL_TOOL}("${handle}") (optional grep/range) is instant, free, no side effects; prefer it to re-running or re-reading (output may differ). Do not guess its content.`
			: `Original not shown (${RECALL_TOOL} is not enabled in this session): re-read the file or re-run the read-only command if you need it. Do not guess its content.`)
	);
}

export function keyTexts(text: string, keep = 8): string[] {
	const f = jsonKeyFields(text, keep, true);
	if (f?.length) return f;
	const keys = pickKeyLines(text, keep);
	const best = keys.find(k => k.why === "error" || k.why === "id") ?? keys[0];
	return best ? [best.text, ...keys.filter(k => k !== best).map(k => k.text)] : [];
}

/** Alias number i: a..z, then aa, ab, ... */
const aliasName = (i: number): string => (i < 26 ? "" : aliasName(Math.floor(i / 26) - 1)) + String.fromCharCode(97 + (i % 26));
/** Short aliases for `cd <dir>` prefixes (dir -> alias): a row writes `[a] cmd` for `cd <dir> && cmd`, and the heading names each dir
 *  once. Every dir works this way, so rows in several dirs stay told apart. An alias of `earlier` (an earlier summary's heading) keeps
 *  its letter; a dir that at least two of these commands share gets the first letter no earlier alias holds, in order of first use. */
export function cdAliases(cmds: string[], earlier: Map<string, string> = new Map()): Map<string, string> {
	const out = new Map(earlier);
	const shared = sharedCdDirs(cmds), taken = new Set(earlier.values());
	let next = 0;
	for (const c of cmds) {
		const d = cdDirOf(c);
		if (!d || out.has(d) || !shared.has(d)) continue;
		while (taken.has(aliasName(next))) next++;
		taken.add(aliasName(next));
		out.set(d, aliasName(next));
	}
	return out;
}

// A summary hint describes what a call found. The key-line heuristics above are tuned for placeholders, where a source line is a fine
// landmark; in a one-line hint they pick "isError?: boolean;" because it contains "error". Measured on a real session summary: most
// hints of code reads were such identifier hits, separators ("===") or arbitrary source lines.
const ERROR_WORD_RE = /(?<![A-Za-z0-9_$])(?:errors?|fail(?:ed|ure|s)?|exception|warnings?)(?![A-Za-z0-9_$])/i;
const SEPARATOR_RE = /^[\s=\-*_#~.|+:]*$/;
const LOCATION_RE = /^[\w./@-]+\.[A-Za-z0-9]+:\d+:/; // "src/a.ts:12:" (grep -n, compilers): where something is, a finding
const CODE_RE = /^(?:const|let|var|function|export|import|return|if|else|for|while|switch|case|class|interface|type|enum|private|public|protected|static|async|await|def|fn|pub|use|test|describe|it|expect)\b|^(?:\/\/|\/\*|\*\/?(?:\s|$))|[;{}(,[]\s*$|=>|;\s*\/\/|^[\w$]+\??\s*:\s*[^;]*;$/;
const looksLikeCode = (line: string) => !LOCATION_RE.test(line.trim()) && CODE_RE.test(line.replace(/^\s*\d+(?::|\s)\s?/, "").trim());

/** The one line a summary shows for a successful output: JSON key fields first, else an error-worded line (whole words, not
 *  identifiers), an id-like line, or the first key line, skipping separators and source-code lines. None when only those remain:
 *  the call head already says what was read, and the handle recalls it. */
export function summaryHint(text: string, keep = 4): string | undefined {
	const f = jsonKeyFields(text, keep, true);
	if (f?.length) return f[0];
	const keys = pickKeyLines(text, keep).filter((k) => !SEPARATOR_RE.test(k.text) && !looksLikeCode(k.text));
	return (keys.find((k) => ERROR_WORD_RE.test(k.text)) ?? keys.find((k) => k.why === "id") ?? keys[0])?.text;
}

/** Placeholder for a toolResult block (null for image results, entries without an id, or short outputs). */
export function makePlaceholderFor(b: Block, calls: Calls, keep = 8, noRecall = false, file?: FileRecall, foldedAt?: number): string | null {
	const content = b.msg.content;
	if (Array.isArray(content) && content.some((c: Any) => c?.type !== "text")) return null;
	if (!b.entryId) return null;
	const call = callOf(calls, b.msg);
	return makePlaceholder(textOf(content), call?.name ?? b.msg.toolName ?? "tool", call ? shortArgs(call.args) : "", handleFor(b.entryId), keep, { at: blockTime(b), turn: b.userTurn, isError: !!b.msg.isError, noRecall, file, foldedAt });
}

/** The newest message timestamp (ms) in a projection: the session's own clock, so a re-plan of the same view stamps the same time. */
export function newestMessageTime(entries: Any[]): number | undefined {
	let t = 0;
	for (const pe of entries) for (const m of pe?.messages ?? []) {
		const x = Number(m?.timestamp);
		if (Number.isFinite(x) && x > t) t = x;
	}
	return t > 0 ? t : undefined;
}
