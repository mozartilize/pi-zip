// Did a run use the findings of its retrieval note? A recall of a cited handle is one signal. The other: the model repeats a
// distinctive term of a finding (a path, an identifier, a number, a quoted value) that it could not have read anywhere else before
// saying it: not in the prompt, not in the model view before the run, and not in a tool result of the run that came before.
import { visibleText } from "../ledger/source.ts";
import type { Any } from "../util.ts";

/** Terms kept per note, and terms listed in a usage record. */
const MAX_TERMS = 40, MAX_LISTED = 12;

/**
 * The distinctive terms of a rendered note's findings: backticked spans, and tokens with a digit, "_", "/", "." or an inner capital
 * (paths, identifiers, versions, ids). Plain words are left out: they match by chance. The header, the Evidence lines (handles) and the
 * closing disclaimer are not findings. `exclude`: terms never counted (the cited handles).
 */
export function noteTerms(text: string, exclude: Iterable<string> = []): string[] {
	const skip = new Set(exclude);
	const body = text.split("\n").filter((l) => {
		const t = l.trim();
		return t && !t.startsWith("[pi-zip") && !t.startsWith("Evidence:") && !t.startsWith("These are historical observations");
	}).join("\n");
	const out = new Set<string>();
	const add = (t: string) => { t = t.trim(); if (t.length >= 3 && !skip.has(t)) out.add(t); };
	for (const m of body.matchAll(/`([^`\n]{3,120})`/g)) add(m[1]);
	for (const m of body.replace(/`[^`\n]*`/g, " ").matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_./:-]*[\p{L}\p{N}_]/gu)) {
		const t = m[0];
		if (t.length >= 4 && (/[\p{N}_/]/u.test(t) || /\.[\p{L}\p{N}]/u.test(t) || /\p{Ll}\p{Lu}/u.test(t))) add(t);
	}
	return [...out].slice(0, MAX_TERMS);
}

/** Text the model wrote in one assistant message: its text, its reasoning when readable, and its tool-call arguments. */
export function written(m: Any): string {
	const parts: string[] = [];
	for (const b of Array.isArray(m?.content) ? m.content : []) {
		if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b?.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
		else if (b?.type === "toolCall") parts.push(JSON.stringify(b.arguments ?? {}));
	}
	return parts.join("\n");
}

/**
 * The terms the run's assistant messages repeat before any other source of the run showed them. `baseline`: text the model could read
 * before the run (the prompt and the earlier model view); a term in it never counts. `run`: the run's messages in order.
 */
export function reusedTerms(terms: string[], baseline: string, run: Any[]): string[] {
	let open = terms.filter((t) => !baseline.includes(t));
	const reused: string[] = [];
	for (const m of run) {
		if (!open.length) break;
		if (m?.role === "assistant") {
			const text = written(m);
			for (const t of open) if (text.includes(t)) reused.push(t);
			open = open.filter((t) => !reused.includes(t));
		} else {
			// a tool result (or anything else the run added) that shows a term: a later repeat may come from it
			const text = m?.role === "toolResult" || m?.role === "user" ? visibleText(m) : "";
			if (text) open = open.filter((t) => !text.includes(t));
		}
	}
	return reused.slice(0, MAX_LISTED);
}
