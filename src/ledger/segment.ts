// Deterministic execution segments. A segment is one user message (the request) or one assistant message together with the entries
// that follow it on the same branch until the next user or assistant message: the tool results it got back, edits, custom entries.
// A tool call and its result therefore never land in different segments, and a single prompt with hundreds of tool calls is split
// into one segment per model step.
import type { Any } from "../util.ts";
import { referencesOf } from "./graph.ts";
import { kindOf, textBlocks, tsOf, visibleText } from "./source.ts";

const clipText = (s: string, n: number) => {
	s = s.replace(/\s+/g, " ").trim();
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Ancestry facts memoised per entry: the segment owner, the request (nearest user message), user turn and segment ordinal. */
export class Lineage {
	private owner = new Map<string, string | null>();
	private request = new Map<string, string | null>();
	private turn = new Map<string, number>();
	private ordinal = new Map<string, number>();
	constructor(private byId: Map<string, Any>) {}

	private parentOf(e: Any): Any | undefined {
		return e?.parentId ? this.byId.get(e.parentId) : undefined;
	}
	/** Walks the ancestry iteratively (a session can be deeper than the call stack) and fills `memo` for every entry on the way. */
	private resolve<T>(e: Any, memo: Map<string, T>, own: (e: Any) => T | undefined, fromParent: (e: Any, p: T | undefined) => T): T {
		const chain: Any[] = [];
		let cur: Any = e;
		while (cur && !memo.has(cur.id)) {
			chain.push(cur);
			cur = this.parentOf(cur);
		}
		let acc: T | undefined = cur ? memo.get(cur.id) : undefined;
		for (let i = chain.length - 1; i >= 0; i--) {
			const x = chain[i];
			const o = own(x);
			acc = o !== undefined ? o : fromParent(x, acc);
			memo.set(x.id, acc);
		}
		return acc as T;
	}
	ownerOf(e: Any): string | null {
		return this.resolve(e, this.owner, (x) => (kindOf(x) === "user" || kindOf(x) === "assistant" ? x.id : undefined), (_x, p) => p ?? null);
	}
	requestOf(e: Any): string | null {
		return this.resolve(e, this.request, (x) => (kindOf(x) === "user" ? x.id : undefined), (_x, p) => p ?? null);
	}
	turnOf(e: Any): number {
		return this.resolve(e, this.turn, () => undefined, (x, p) => (p ?? 0) + (kindOf(x) === "user" ? 1 : 0));
	}
	/** 0 for a request segment; 1, 2, ... for the model steps after it on the branch. */
	ordinalOf(e: Any): number {
		return this.resolve(e, this.ordinal, () => undefined, (x, p) => (kindOf(x) === "user" ? 0 : kindOf(x) === "assistant" ? (p ?? 0) + 1 : (p ?? 0)));
	}
}

export interface SegmentRow {
	id: string;
	requestEntryId: string | null;
	userTurn: number;
	ordinal: number;
	startSeq: number;
	endSeq: number;
	requestText: string;
	intentText: string | null;
	retrievalText: string;
	identifiers: string;
	tools: string;
	createdAt: number | null;
}

const KEY_RE = /\b(error|errors|fail(ed|ure|ing)?|exception|traceback|panic|denied|not found|timeout|timed out|passed|exit code|warning)\b|✗|✓/i;

/** Up to `n` deterministic key lines of a tool result: matching lines first (source order), then the first and last line. */
export function keyLines(text: string, n = 4): string[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return [];
	const picked: string[] = [];
	for (const l of lines) if (picked.length < n - 1 && KEY_RE.test(l) && !picked.includes(l)) picked.push(l);
	for (const l of [lines[0], lines[lines.length - 1]]) if (picked.length < n && !picked.includes(l)) picked.push(l);
	return picked.map((l) => clipText(l, 200));
}

/**
 * The segment's row from its member entries (source order; the owner first). `requestText` is the text of the request on the owner's
 * ancestry. The retrieval text is dense deterministic search text, not a summary: request, intent, tool labels, key result lines and
 * identifiers.
 */
export function buildSegment(ownerId: string, members: Array<{ e: Any; seq: number }>, lineage: Lineage, byId: Map<string, Any>, cwd: string): SegmentRow {
	const owner = byId.get(ownerId);
	const reqId = lineage.requestOf(owner);
	const req = reqId ? byId.get(reqId) : undefined;
	const requestText = clipText(req ? textBlocks(req).map((b) => b.text).join("\n") : "", 1000);
	const isAssistant = kindOf(owner) === "assistant";
	const intent = isAssistant ? clipText(visibleText(owner.message), 600) : "";
	const tools: string[] = [], results: string[] = [], files = new Set<string>(), urls = new Set<string>(), commands = new Set<string>();
	for (const { e } of members) {
		for (const b of textBlocks(e)) {
			if (b.kind === "tool_call") {
				tools.push(clipText(b.text, 160));
				const r = referencesOf(b.args, cwd);
				r.files.forEach((f) => files.add(f));
				r.urls.forEach((u) => urls.add(u));
				r.commands.forEach((c) => commands.add(c));
			} else if (b.kind === "tool_result") {
				results.push(...keyLines(b.text).map((l) => (b.isError ? `[error] ${l}` : l)));
			}
		}
	}
	const identifiers = [...files, ...urls, ...commands].join("\n");
	const parts = [
		requestText && `REQUEST: ${clipText(requestText, 400)}`,
		intent && `INTENT: ${intent}`,
		tools.length ? `TOOLS: ${tools.slice(0, 12).join(" ; ")}` : "",
		results.length ? `KEY RESULTS: ${results.slice(0, 16).join(" | ")}` : "",
		identifiers && `IDENTIFIERS: ${[...files, ...urls, ...commands].slice(0, 24).join(" ")}`,
	].filter(Boolean);
	const seqs = members.map((m) => m.seq);
	return {
		id: ownerId,
		requestEntryId: reqId,
		userTurn: lineage.turnOf(owner),
		ordinal: lineage.ordinalOf(owner),
		startSeq: Math.min(...seqs),
		endSeq: Math.max(...seqs),
		requestText,
		intentText: intent || null,
		retrievalText: parts.join("\n"),
		identifiers,
		tools: tools.slice(0, 6).map((t) => t.split(" ")[0]).join(", "),
		createdAt: tsOf(owner),
	};
}
