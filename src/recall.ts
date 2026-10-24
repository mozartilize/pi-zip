// zip_recall (F3): exact, batched retrieval of folded originals from the session file (I2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleFor, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { commandRecallHandles, parseRecallPath } from "./recallfile.ts";
import { measure, recallCallLine, recallResultLines, type RecallSectionInfo } from "./ui.ts";
import { type Any, clamp, textOf } from "./util.ts";

const RECALL_PAGE_CHARS = 20_000; // default page
const SEARCH_PAGE_CHARS = 8_000; // default page of grep without a handle: a broad pattern over every output stays small (search results are never folded)
const RECALL_MAX_PAGE_CHARS = 50_000;
const RECALL_MAX_HITS = 400;
const GREP_MAX_PATTERN = 256;
const GREP_BUDGET_MS = 2000;

export function parseRange(spec: string): { from: number; to: number } | null {
	const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec ?? "");
	if (!m) return null;
	const from = parseInt(m[1], 10);
	const to = m[2] ? parseInt(m[2], 10) : from;
	return from >= 1 && to >= from && to - from <= 100_000 ? { from, to } : null;
}

// Regex shapes that can backtrack catastrophically on a long line: a quantified group that itself holds a quantifier or an
// alternation, and back-references. They are searched as literal text instead (a sync regex cannot be interrupted).
const RISKY_REGEX = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\}|\|)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)|\\[1-9]|\\k</;

/** Case-insensitive regex for a grep pattern, or the pattern as literal text when it does not compile or could backtrack badly. */
export function grepMatcher(p: string): { re: RegExp; literal: boolean } {
	const escaped = () => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	if (p.length > GREP_MAX_PATTERN || RISKY_REGEX.test(p)) return { re: escaped(), literal: true };
	try {
		return { re: new RegExp(p, "i"), literal: false };
	} catch {
		return { re: escaped(), literal: true };
	}
}

export interface RecallSlice {
	text: string; // what the model sees: header, the page, and a hint on how to get the rest
	body: string; // the page itself, exactly as a slice of the selected original text
	totalLines: number;
	matched: number | null;
	clipped: boolean;
	offset: number;
	nextOffset: number | null; // where the next page starts; null = this page reaches the end of the selection
	selectionChars: number;
}

const int = (v: unknown): number | null => {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null;
};
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Full text, a line range or grep matches of an original, then one page of it by CHARACTERS (offset, limit): a single
 * 45,000-character line is reachable too. Pages never split a surrogate pair, so concatenated pages are the selection byte for byte.
 */
export function sliceRecall(text: string, opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown; pageChars?: number; narrow?: string }): RecallSlice {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let sel: string;
	let matched: number | null = null;
	let header = "";
	const empty = (msg: string): RecallSlice => ({ text: msg, body: "", totalLines, matched: null, clipped: false, offset: 0, nextOffset: null, selectionChars: 0 });
	if (opts.grep !== undefined && String(opts.grep).trim() !== "") {
		const { re, literal } = grepMatcher(String(opts.grep));
		const hits: string[] = [];
		const t0 = Date.now();
		let examined = 0;
		for (; examined < lines.length && hits.length < RECALL_MAX_HITS; examined++) {
			if (re.test(lines[examined])) hits.push(`${examined + 1}: ${lines[examined]}`);
			if (Date.now() - t0 > GREP_BUDGET_MS) { examined++; break; }
		}
		matched = hits.length;
		sel = hits.join("\n");
		header = `[grep${literal ? " (searched as literal text: the pattern is not a safe regular expression)" : ""}: ${matched} matching line(s) of ${totalLines}${examined < lines.length && hits.length < RECALL_MAX_HITS ? `; stopped after ${examined} lines (time budget), use range for the rest` : ""}]\n`;
	} else if (opts.range !== undefined && String(opts.range).trim() !== "") {
		const r = parseRange(String(opts.range));
		if (!r) return empty(`(invalid range "${opts.range}"; use e.g. range="120-240")`);
		sel = lines.slice(r.from - 1, r.to).join("\n");
		header = `[range: lines ${r.from}-${Math.min(r.to, totalLines)} of ${totalLines}]\n`;
	} else {
		sel = text;
	}
	const limitIn = int(opts.limit);
	const limit = clamp(limitIn ?? opts.pageChars ?? RECALL_PAGE_CHARS, 1, RECALL_MAX_PAGE_CHARS);
	let offset = clamp(int(opts.offset) ?? 0, 0, sel.length);
	if (offset > 0 && offset < sel.length && isLow(sel.charCodeAt(offset))) offset--; // never start inside a surrogate pair
	let end = Math.min(sel.length, offset + limit);
	if (end < sel.length && isHigh(sel.charCodeAt(end - 1))) end += end - 1 > offset ? -1 : 1; // ... or end inside one (a 1-char page takes the whole pair)
	const body = sel.slice(offset, end);
	const more = end < sel.length;
	const paged = more || offset > 0;
	const pageHeader = paged ? `[chars ${offset}-${end} of ${sel.length}${header ? " of the selection" : ""}]\n` : "";
	const hint = more
		? `\n[… ${sel.length - end} more chars: call ${RECALL_TOOL} again with offset=${end} for the next page (limit up to ${RECALL_MAX_PAGE_CHARS}), or ${opts.narrow ?? "narrow it with grep or range"}]`
		: "";
	return { text: header + pageHeader + body + hint, body, totalLines, matched, clipped: more, offset, nextOffset: more ? end : null, selectionChars: sel.length };
}

export interface RecallItem {
	handle: string;
	text: string | null;
	tool: string | null;
	label?: string; // tool + short args of the call that produced it (transcript only)
	turn?: number;
}

export type RecallScope = "outputs" | "requests" | "assistant" | "all";

export interface BranchRequest {
	number: number; // 1-based raw user message ordinal on the ancestor branch (raw-branch-v2; includes steer/follow-up)
	entryId: string;
	handle: string;
	text: string;
	hasNonText: boolean;
}

/** Visible assistant prose only (never hidden thinking/reasoning blocks). */
export function assistantVisibleText(content: Any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: Any) => b?.type === "text" && typeof b.text === "string")
		.map((b: Any) => b.text)
		.join("\n");
}

/** Every raw user message entry on the ancestor branch, oldest first, numbered 1..N under raw-branch-v2. */
export function branchRequests(branch: Any[]): BranchRequest[] {
	const out: BranchRequest[] = [];
	let number = 0;
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (msg?.role !== "user") continue;
		number++;
		const entryId = String(en.id ?? `user-${number}`);
		const rawText = textOf(msg.content);
		const hasNonText = Array.isArray(msg.content) && msg.content.some((b: Any) => b?.type && b.type !== "text");
		const text = rawText || (hasNonText ? "[non-text user content]" : "[empty user message]");
		out.push({ number, entryId, handle: handleFor(entryId), text, hasNonText });
	}
	return out;
}

/** Format the branch's raw-branch-v2 request ledger for file-based recall (`requests.txt`). */
export function formatRequestsLedger(branch: Any[]): string {
	return branchRequests(branch)
		.map((r) => `[R${r.number} · handle ${r.handle} · user request]\n${r.text}`)
		.join("\n\n");
}

/** Resolve a `requests` selector ("85" or "20-41", inclusive) against the ancestor branch. */
export function recallRequestsInBranch(
	branch: Any[],
	spec: string,
	opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown } = {},
): { text: string; ok: number; missing: number; sections: RecallSectionInfo[]; handles: string[]; entryIds: string[] } {
	const r = parseRange(spec);
	if (!r) {
		return {
			text: `(invalid requests "${spec}"; use a positive request number or inclusive range, e.g. requests="85" or requests="20-41")`,
			ok: 0,
			missing: 1,
			sections: [],
			handles: [],
			entryIds: [],
		};
	}
	const all = branchRequests(branch);
	const byNum = new Map(all.map((x) => [x.number, x]));
	const items: RecallItem[] = [];
	const handles: string[] = [];
	const entryIds: string[] = [];
	for (let n = r.from; n <= r.to; n++) {
		const req = byNum.get(n);
		if (!req) {
			items.push({ handle: `R${n}`, text: null, tool: null, label: `R${n} · user request`, turn: n });
			continue;
		}
		items.push({ handle: req.handle, text: req.text, tool: null, label: `R${req.number} · user request`, turn: req.number });
		handles.push(req.handle);
		entryIds.push(req.entryId);
	}
	const res = recallSections(items, opts);
	return { ...res, handles, entryIds };
}
/** "[handle h · bash npm test · 812 chars · 40 lines]": the call that produced an output, so the model can tell look-alike outputs apart. */
const sectionHead = (it: RecallItem & { text: string }) => `[handle ${it.handle}${it.label || it.tool ? " · " + (it.label ?? it.tool) : ""} · ${it.text.length} chars · ${it.text.split("\n").length} lines]`;

export function recallSections(items: RecallItem[], opts: { grep?: string; range?: string; offset?: unknown; limit?: unknown }): { text: string; ok: number; missing: number; sections: RecallSectionInfo[] } {
	const parts: string[] = [];
	const sections: RecallSectionInfo[] = [];
	let ok = 0;
	let missing = 0;
	for (const it of items) {
		if (it.text === null) {
			missing++;
			sections.push({ handle: it.handle, missing: true });
			parts.push(`[handle ${it.handle}] not found. Copy the handle exactly from the folded block's marker line or the summary's handle table.`);
			continue;
		}
		ok++;
		const slice = sliceRecall(it.text, opts);
		const grep = opts.grep !== undefined && String(opts.grep).trim() !== "", range = opts.range !== undefined && String(opts.range).trim() !== "";
		const how = grep ? "grep" : range ? "range" : slice.clipped || slice.offset > 0 ? "page" : "all";
		const shown = grep ? (slice.matched ?? 0) : slice.body ? slice.body.split("\n").length : 0;
		sections.push({ handle: it.handle, label: it.label ?? it.tool ?? undefined, turn: it.turn, totalLines: slice.totalLines, shownLines: shown, how });
		parts.push(`${sectionHead({ ...it, text: it.text })}\n${slice.text}`);
	}
	return { text: parts.join("\n\n"), ok, missing, sections };
}

/**Every tool output of the session branch (which spans entries before any compaction), oldest first, with the call that produced it.
 * Uses source-order issuer matching so reused `toolCallId`s pair with the latest preceding assistant call that issued that ID
 * unless the same assistant message issued duplicate IDs (ambiguous -> unresolved). */
export function branchOutputs(branch: Any[]): Array<RecallItem & { text: string; entryId: string; executionId?: string; ambiguous?: boolean }> {
	const out: Array<RecallItem & { text: string; entryId: string; executionId?: string; ambiguous?: boolean }> = [];
	const issued = new Map<string, { call: Any; executionId: string; ambiguous: boolean }>();
	let turn = 0;
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (msg?.role === "user") turn++;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			const counts = new Map<string, number>();
			for (const c of msg.content) if (c?.type === "toolCall" && c.id) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
			for (let pos = 0; pos < msg.content.length; pos++) {
				const c = msg.content[pos];
				if (c?.type !== "toolCall" || !c.id) continue;
				const dup = (counts.get(c.id) ?? 0) > 1;
				issued.set(c.id, { call: c, executionId: `${en.id ?? "asst"}:${pos}`, ambiguous: dup });
			}
		}
		if (msg?.role !== "toolResult" || !en.id) continue;
		const m = msg.toolCallId ? issued.get(msg.toolCallId) : undefined;
		const call = m && !m.ambiguous ? m.call : undefined;
		const tool = msg.toolName ?? call?.name ?? null;
		const args = call ? shortArgs(call.arguments) : "";
		out.push({
			entryId: en.id,
			handle: handleFor(en.id),
			text: textOf(msg.content),
			tool,
			label: tool ? `${tool}${args ? " " + args : ""}` : undefined,
			turn: turn || undefined,
			executionId: m && !m.ambiguous ? m.executionId : undefined,
			ambiguous: m?.ambiguous ? true : undefined,
		});
	}
	return out;
}

/** Resolve handles against the session branch: exact originals of tool outputs, and of user requests (a summary quotes a very long
 *  request with its middle left out and names its handle). */
export function resolveHandlesInBranch(branch: Any[], handles: string[]): { items: RecallItem[]; entryIds: (string | null)[] } {
	const items: RecallItem[] = handles.map((h) => ({ handle: h, text: null, tool: null }));
	const entryIds: (string | null)[] = handles.map(() => null);
	for (const o of branchOutputs(branch)) {
		const k = handles.indexOf(o.handle);
		if (k < 0) continue;
		const { entryId, ...it } = o;
		items[k] = it;
		entryIds[k] = entryId;
	}
	if (entryIds.every((id) => id !== null)) return { items, entryIds };
	let turn = 0;
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (msg?.role === "user") {
			turn++;
			if (en.id) {
				const k = handles.indexOf(handleFor(en.id));
				if (k >= 0 && entryIds[k] === null) {
					const rawText = textOf(msg.content);
					const hasNonText = Array.isArray(msg.content) && msg.content.some((b: Any) => b?.type && b.type !== "text");
					items[k] = { handle: handles[k], text: rawText || (hasNonText ? "[non-text user content]" : ""), tool: null, label: "user request", turn };
					entryIds[k] = en.id;
				}
			}
			continue;
		}
		if (msg?.role === "assistant" && en?.id) {
			const k = handles.indexOf(handleFor(en.id));
			if (k >= 0 && entryIds[k] === null) {
				items[k] = { handle: handles[k], text: assistantVisibleText(msg.content), tool: null, label: "assistant response", turn: turn || undefined };
				entryIds[k] = en.id;
			}
		}
	}
	return { items, entryIds };
}

/**
 * grep without a handle: every earlier tool output of the branch (zip_recall results excepted), newest output first, each match
 * under its output's handle and call, then one page by characters (default SEARCH_PAGE_CHARS). For outputs whose handle the model
 * cannot see any more (a long summary lists only the newest) and for questions that name the content rather than the output.
 * `upTo` pins the pool to its first n outputs (branch order, oldest first; new outputs only append): a later page of the same search
 * passes the pool size of its first page, so an output that arrived in between cannot shift the character offsets.
 */
export function searchOutputs(
	outputs: Array<RecallItem & { text: string }>,
	grep: string,
	opts: { offset?: unknown; limit?: unknown; upTo?: number; noun?: string; plural?: string } = {},
): { text: string; matched: number; hits: number; chars: number; pool: number; sections: RecallSectionInfo[] } {
	const { re, literal } = grepMatcher(grep);
	const all = outputs.filter((o) => o.tool !== RECALL_TOOL);
	const pool = opts.upTo !== undefined && opts.upTo >= 0 && opts.upTo < all.length ? all.slice(0, opts.upTo) : all;
	const parts: string[] = [];
	const sections: RecallSectionInfo[] = [];
	let hits = 0;
	let stopped = false;
	const t0 = Date.now();
	for (let k = pool.length - 1; k >= 0 && !stopped; k--) {
		const it = pool[k];
		const lines = it.text.split("\n");
		const got: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (hits >= RECALL_MAX_HITS || Date.now() - t0 > GREP_BUDGET_MS) {
				stopped = true;
				break;
			}
			if (re.test(lines[i])) {
				got.push(`${i + 1}: ${lines[i]}`);
				hits++;
			}
		}
		if (!got.length) continue;
		parts.push(`${sectionHead(it)}\n${got.join("\n")}`);
		sections.push({ handle: it.handle, label: it.label ?? it.tool ?? undefined, turn: it.turn, totalLines: lines.length, shownLines: got.length, how: "grep" });
	}
	const noun = opts.noun ?? "output";
	const plural = opts.plural ?? "earlier tool outputs";
	const head = `[grep${literal ? " (searched as literal text: the pattern is not a safe regular expression)" : ""} over all ${pool.length} ${plural} (no handle given): ${hits} matching line(s) in ${sections.length} ${noun}(s), newest ${noun} first${stopped ? "; stopped early (time or hit cap), narrow the pattern or pass a handle" : ""}]\n`;
	if (!hits) return { text: head + "Nothing matched. Try a shorter or different pattern, or pass the handle shown in a folded block or a summary.", matched: 0, hits, chars: 0, pool: pool.length, sections };
	const page = sliceRecall(parts.join("\n\n"), { offset: opts.offset, limit: opts.limit, pageChars: SEARCH_PAGE_CHARS, narrow: "narrow the pattern, or pass one of the handles above with grep" });
	return { text: head + page.text, matched: sections.length, hits, chars: page.body.length, pool: pool.length, sections };
}

/** Build the ordered pool of searchable records for `scope` ("outputs" | "requests" | "assistant" | "all"), oldest first. */
export function branchSearchPool(branch: Any[], scope: RecallScope = "outputs"): Array<RecallItem & { text: string; entryId: string }> {
	if (scope === "outputs") return branchOutputs(branch).filter((o) => o.tool !== RECALL_TOOL);
	const out: Array<RecallItem & { text: string; entryId: string }> = [];
	const issued = new Map<string, { call: Any; ambiguous: boolean }>();
	let reqNum = 0;
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (!msg) continue;
		if (msg.role === "user") {
			reqNum++;
			if ((scope === "requests" || scope === "all") && en.id) {
				const rawText = textOf(msg.content);
				const hasNonText = Array.isArray(msg.content) && msg.content.some((b: Any) => b?.type && b.type !== "text");
				out.push({
					entryId: en.id,
					handle: handleFor(en.id),
					text: rawText || (hasNonText ? "[non-text user content]" : ""),
					tool: null,
					label: `R${reqNum} · user request`,
					turn: reqNum,
				});
			}
			continue;
		}
		if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				const counts = new Map<string, number>();
				for (const c of msg.content) if (c?.type === "toolCall" && c.id) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
				for (const c of msg.content) if (c?.type === "toolCall" && c.id) issued.set(c.id, { call: c, ambiguous: (counts.get(c.id) ?? 0) > 1 });
			}
			if ((scope === "assistant" || scope === "all") && en.id) {
				const vis = assistantVisibleText(msg.content);
				if (vis) out.push({ entryId: en.id, handle: handleFor(en.id), text: vis, tool: null, label: `assistant response${reqNum ? ` · R${reqNum}` : ""}`, turn: reqNum || undefined });
			}
			continue;
		}
		if (msg.role === "toolResult" && scope === "all" && en.id) {
			const m = msg.toolCallId ? issued.get(msg.toolCallId) : undefined;
			const call = m && !m.ambiguous ? m.call : undefined;
			const tool = msg.toolName ?? call?.name ?? null;
			if (tool === RECALL_TOOL) continue;
			const args = call ? shortArgs(call.arguments) : "";
			out.push({
				entryId: en.id,
				handle: handleFor(en.id),
				text: textOf(msg.content),
				tool,
				label: tool ? `${tool}${args ? " " + args : ""}` : undefined,
				turn: reqNum || undefined,
			});
		}
	}
	return out;
}

/** Search the branch under `scope` ("outputs" default, "requests", "assistant", "all"). */
export function searchBranch(branch: Any[], grep: string, opts: { scope?: RecallScope; offset?: unknown; limit?: unknown; upTo?: number } = {}) {
	const scope: RecallScope = opts.scope ?? "outputs";
	const pool = branchSearchPool(branch, scope);
	if (scope === "outputs") return searchOutputs(pool, grep, opts);
	const labels: Record<RecallScope, { noun: string; plural: string }> = {
		outputs: { noun: "output", plural: "earlier tool outputs" },
		requests: { noun: "request", plural: "user requests" },
		assistant: { noun: "assistant message", plural: "assistant messages" },
		all: { noun: "record", plural: "branch records (requests, assistant, outputs)" },
	};
	return searchOutputs(pool, grep, { ...opts, ...labels[scope] });
}

/** The pool size recorded by the newest earlier search with this same pattern (its first page), for a later page of it. */
export function searchPoolOf(branch: Any[], grep: string, scope: RecallScope = "outputs"): number | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		const mScope: RecallScope = m?.details?.scope ?? "outputs";
		if (m?.role === "toolResult" && m.toolName === RECALL_TOOL && m.details?.search === grep && mScope === scope && typeof m.details.pool === "number") return m.details.pool;
	}
	return undefined;
}

/** Handles the model already recalled in this branch (F4: never refold them). A failed or unanswered zip_recall does not count. */
export function recalledHandlesFromBranch(branch: Any[]): Set<string> {
	const out = new Set<string>();
	const recallResult = new Map<string, Any>();
	for (const en of branch) {
		const m = en?.type === "message" ? en.message : null;
		if (m?.role === "toolResult" && m.toolName === RECALL_TOOL && m.toolCallId) recallResult.set(m.toolCallId, m);
	}
	const recalled = (id: string, handle: string) => {
		const res = recallResult.get(id);
		if (!res || res.isError) return false;
		const sections = res.details?.sections;
		if (!Array.isArray(sections)) return true;
		return sections.some((s: Any) => s?.handle === handle && !s.missing);
	};
	for (const en of branch) {
		const m = en?.type === "message" ? en.message : null;
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content) {
			if (c?.type !== "toolCall") continue;
			const a: Any = c.arguments ?? {};
			if (c.name === RECALL_TOOL) {
				if (typeof a.handle === "string" && a.handle.trim() && recalled(c.id, a.handle.trim())) out.add(a.handle.trim());
				if (Array.isArray(a.handles)) for (const h of a.handles) if (typeof h === "string" && h.trim() && recalled(c.id, h.trim())) out.add(h.trim());
			} else if (c.name === "bash") {
				for (const h of commandRecallHandles(a.command)) out.add(h); // file recall: a shell reading a recall file
			} else if (c.name === "read" || c.name === "grep") {
				const h = parseRecallPath(a.path)?.handle; // file recall: read or grep of a recall file
				if (h) out.add(h);
			}
		}
	}
	return out;
}

export interface RecallHooks {
	onRecall(handles: string[], chars: number, entryIds: (string | null)[]): void;
	labelOf?(handle: string): string | undefined; // "read src/learn.ts" for a handle folded in this branch
}

export function registerRecallTool(pi: ExtensionAPI, hooks: RecallHooks) {
	pi.registerTool({
		name: RECALL_TOOL,
		label: "Recall folded output",
		description:
			"Get back the EXACT original of earlier tool outputs of this session that are no longer shown in full: a [folded by pi-zip …] block, or an output " +
			"listed with a handle in a pi-zip summary. Whenever you need what such an output said, recall it first: it is instant, free and has no side effects, " +
			"while re-running a command or re-reading a file costs a step and may give a different result. Never guess the content of a folded output. " +
			"Pass its handle (10 characters, from the block's marker line or the summary; handles stay valid after later summaries or compaction), or several with handles. " +
			"A summary that quotes a very long user request with its middle left out names that request's handle too: recall returns the whole request. " +
			'For a part, add grep (case-insensitive regular expression; matching lines with line numbers) or range (e.g. "120-240"). ' +
			"No handle at hand? grep alone searches every earlier tool output of the session and labels each match with its output's handle and command. " +
			"Large results come in pages of characters: when a page says more is left, call again with offset.",
		parameters: {
			type: "object",
			properties: {
				handle: { type: "string", description: "A handle from a folded block's marker line or a summary" },
				handles: { type: "array", items: { type: "string" }, description: "Optional batch: several handles at once; each is returned as its own labelled section" },
				requests: { type: "string", description: 'Optional: recall user request(s) by 1-based branch request number or inclusive range, e.g. "85" or "20-41" (mutually exclusive with handle/handles)' },
				scope: { type: "string", enum: ["outputs", "requests", "assistant", "all"], description: 'Optional scope for grep without a handle: "outputs" (default), "requests", "assistant", or "all"' },
				grep: { type: "string", description: "Optional: only lines matching this case-insensitive regular expression, with line numbers (applied to every handle or request). Without any handle/requests: searches earlier records of the session" },
				range: { type: "string", description: 'Optional: only this line range, e.g. "120-240" (applied to every handle or request)' },
				offset: { type: "number", description: "Optional: start this many characters into the (selected) text, for the next page of a large output or a very long single line (applied to every handle)" },
				limit: { type: "number", description: `Optional: page size in characters (default ${RECALL_PAGE_CHARS}; ${SEARCH_PAGE_CHARS} for grep without a handle; at most ${RECALL_MAX_PAGE_CHARS})` },
			},
			required: [],
		} as Any,
		renderCall(args: Any, theme: Any) {
			return lines((w) => recallCallLine(args ?? {}, w, theme, measure, (h) => hooks.labelOf?.(h)));
		},
		renderResult(result: Any, options: Any, theme: Any) {
			const text = textOf(result?.content);
			const secs: RecallSectionInfo[] = Array.isArray(result?.details?.sections) ? result.details.sections : [];
			return lines((w) => recallResultLines(secs, text, !!options?.expanded, w, theme, measure));
		},
		async execute(_id: string, params: Any, _signal: Any, _onUpdate: Any, ctx: Any): Promise<Any> {
			const grep = params?.grep !== undefined ? String(params.grep) : undefined;
			const range = params?.range !== undefined ? String(params.range) : undefined;
			const requests = params?.requests !== undefined ? String(params.requests).trim() : undefined;
			const rawScope = params?.scope !== undefined ? String(params.scope).trim() : undefined;
			const offset = params?.offset;
			const limit = params?.limit;
			const handles: string[] = [];
			if (typeof params?.handle === "string" && params.handle.trim()) handles.push(params.handle.trim());
			if (Array.isArray(params?.handles)) for (const h of params.handles) if (typeof h === "string" && h.trim() && !handles.includes(h.trim())) handles.push(h.trim());
			if (rawScope !== undefined && rawScope !== "outputs" && rawScope !== "requests" && rawScope !== "assistant" && rawScope !== "all") {
				return { content: [{ type: "text", text: `(invalid scope "${rawScope}"; use "outputs", "requests", "assistant", or "all")` }], details: {}, isError: true };
			}
			const scope: RecallScope = (rawScope as RecallScope | undefined) ?? "outputs";
			if (requests && handles.length > 0) {
				return { content: [{ type: "text", text: "Pass either requests or handle/handles, not both." }], details: {}, isError: true };
			}
			if (rawScope !== undefined && (handles.length > 0 || !!requests)) {
				return { content: [{ type: "text", text: "scope applies only to grep without handle/handles or requests." }], details: {}, isError: true };
			}
			if (requests !== undefined && requests !== "") {
				try {
					const branch = ctx.sessionManager.getBranch() as Any[];
					const out = recallRequestsInBranch(branch, requests, { grep, range, offset, limit });
					if (out.ok === 0) return { content: [{ type: "text", text: out.text }], details: { requests, resolved: 0, missing: out.missing, sections: out.sections }, isError: true };
					hooks.onRecall(out.handles, out.text.length, out.entryIds);
					return { content: [{ type: "text", text: out.text }], details: { requests, handles: out.handles, resolved: out.ok, missing: out.missing, sections: out.sections }, isError: false };
				} catch (err) {
					return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
				}
			}
			if (!handles.length && grep !== undefined && grep.trim() !== "") {
				try {
					const branch = ctx.sessionManager.getBranch() as Any[];
					const later = (int(offset) ?? 0) > 0; // a later page: search the pool its first page saw
					const out = searchBranch(branch, grep, { scope, offset, limit, upTo: later ? searchPoolOf(branch, grep, scope) : undefined });
					hooks.onRecall([], out.chars, []); // a search marks nothing as recalled: only what the model asks for by handle is kept unfolded
					return { content: [{ type: "text", text: out.text }], details: { handles: [], search: grep, scope, pool: out.pool, resolved: out.matched, missing: 0, sections: out.sections }, isError: false };
				} catch (err) {
					return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
				}
			}
			if (!handles.length) return { content: [{ type: "text", text: "Pass handle (one string), handles (array), or requests (e.g. \"1-5\"); or grep alone to search earlier session records." }], details: {}, isError: true };
			try {
				const { items, entryIds } = resolveHandlesInBranch(ctx.sessionManager.getBranch() as Any[], handles);
				const out = recallSections(items, { grep, range, offset, limit });
				const ok = items.flatMap((it, i) => it.text == null ? [] : [[handles[i], entryIds[i]] as const]);
				hooks.onRecall(ok.map(([h]) => h), items.reduce((a, it) => a + (it.text?.length ?? 0), 0), ok.map(([, id]) => id));
				return { content: [{ type: "text", text: out.text }], details: { handles, resolved: out.ok, missing: out.missing, sections: out.sections }, isError: out.ok === 0 };
			} catch (err) {
				return { content: [{ type: "text", text: `${RECALL_TOOL} failed: ${err instanceof Error ? err.message : String(err)}` }], details: {}, isError: true };
			}
		},
	});
}

/** A minimal pi-tui Component: lines computed for the width at render time. */
function lines(fn: (width: number) => string[]): Any {
	return { render: (width: number) => fn(Math.max(1, width)), invalidate: () => {} };
}
