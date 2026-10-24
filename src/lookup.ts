// Lookup cue for a new user request: earlier tool outputs the request names exactly. No model call and no context-pressure gate.
import { hintText, locatorOf, pathsIn, WRITERS } from "./judge.ts";
import { handleFor, handleTokens, MIN_FOLD_CHARS, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { textOf, type Any } from "./util.ts";

export interface LookupRef { handle: string; label: string; via: "handle" | "locator" }

export const LOOKUP_HEAD = "Your request names earlier tool outputs that are no longer shown in full: ";
export const LOOKUP_TAIL = ". Recall them with zip_recall instead of repeating their calls. Repeat a call only for its current result: a file may have changed since.";

const SKILL_BLOCK_RE = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;

/**
 * Earlier tool outputs that the request text names, read from the session branch. The branch keeps entries that a compaction took out
 * of the view, so those outputs count too. Injected `<skill ...>...</skill>` blocks are ignored so `/skill:...` expansions do not cue
 * earlier reads of `SKILL.md` or example paths inside the skill body.
 * - A handle counts when the text writes it exactly.
 * - A full path or URL counts only through the newest call on that locator, and only when that call was not an edit or write and
 *   returned a recallable output (no error, at least MIN_FOLD_CHARS). An edit or write after a read makes the read stale, so the
 *   locator gets no cue even when the edit or write output itself is long.
 * Outputs in `live` (shown in full in this request) and zip_recall results never count. Handles come first, then locators, each in text order.
 */
export function lookupRefs(text: string, branch: readonly Any[], cwd: string, live: ReadonlySet<string>): LookupRef[] {
	const clean = text.replace(SKILL_BLOCK_RE, "\n");
	const tokens = [...new Set(handleTokens(clean))], locs = pathsIn(clean, cwd);
	if (!tokens.length && !locs.length) return [];
	const wanted = new Set(tokens), wantedLoc = new Set(locs);
	const calls = new Map<string, Any>(), byHandle = new Map<string, LookupRef>(), newest = new Map<string, LookupRef | null>();
	for (const en of branch) {
		const msg = en?.type === "message" ? en.message : null;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			// ids may be reused: a result belongs to the newest call issued before it; one message issuing an id twice leaves it unknown
			const seen = new Map<string, number>();
			for (const c of msg.content) if (c?.type === "toolCall" && c.id) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
			for (const c of msg.content) if (c?.type === "toolCall" && c.id) calls.set(c.id, (seen.get(c.id) ?? 0) > 1 ? null : c);
		}
		if (msg?.role !== "toolResult" || !en.id) continue;
		const call = calls.get(msg.toolCallId) ?? undefined, tool = call?.name ?? msg.toolName ?? "tool";
		if (tool === RECALL_TOOL) continue;
		const handle = handleFor(en.id), label = `${tool} ${shortArgs(call?.arguments)}`.trim();
		if (wanted.has(handle)) byHandle.set(handle, { handle, label, via: "handle" });
		const loc = wantedLoc.size ? locatorOf(call?.arguments, cwd) : null;
		if (loc && wantedLoc.has(loc)) {
			newest.set(loc, !msg.isError && !WRITERS.has(tool) && textOf(msg.content).length >= MIN_FOLD_CHARS ? { handle, label, via: "locator" } : null);
		}
	}
	const out: LookupRef[] = [];
	for (const h of tokens) {
		const r = byHandle.get(h);
		if (r && !live.has(h)) out.push(r);
	}
	for (const l of locs) {
		const r = newest.get(l);
		if (r && !live.has(r.handle) && !out.some((x) => x.handle === r.handle)) out.push(r);
	}
	return out;
}

/** The cue as one short request-local note: at most three references in 600 characters. */
export const lookupText = (refs: readonly LookupRef[]) => hintText(refs.slice(0, 3), LOOKUP_HEAD, LOOKUP_TAIL);
