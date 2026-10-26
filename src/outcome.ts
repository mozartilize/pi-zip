// One-line outcome of a command output. A leaf module: used by fold placeholders and by retrieval, which must not import plan.ts.

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
