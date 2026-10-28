// Request-local fork notes. Keep insertion positions stable across requests to preserve the cache prefix.
import { buildBlocks, compactionRoom, sizeOf, wireTokensOf, type Block, type Scale } from "./plan.ts";
import { handleFor, PH_MARK } from "./placeholder.ts";
import { resolveHandlesInBranch } from "./recall-extended.ts";
import { type Judge, citesWork, latestUserText, requestOpen } from "./judge.ts";
import { lookupRefs, lookupText, type LookupRef } from "./lookup.ts";
import { type Any, attempt, textOf } from "./util.ts";

export interface RequestMemory {
	current(ctx: Any): { prompt: string; pending?: string; text: string | null; found?: boolean; delivered?: boolean } | null;
	injected(chars: number, at: number, kind?: "pending" | "final"): void;
	reinjected(): void;
	cancelRetrieval(): void;
	awaitNote?(ctx: Any, signal?: AbortSignal): Promise<string | null>;
}

interface NoteHost {
	inRun: boolean;
	recallMode: string;
	steerIds: Set<string>;
	foldedCalls: Map<string, string>;
	recalled: Set<string>;
	judgeReq: number;
	judge: Judge;
	branch(ctx: Any): Any[];
	scaleOf(ctx: Any, entries?: Any[]): Scale;
	reserve(ctx: Any): number;
	appendHint(handles: string[]): void;
}

export class RequestNotes {
	private memoryPendingShown = false;
	private memoryFinalAt: number | null = null;
	private lookup: { scope: string; pending: LookupRef[] } = { scope: "\0", pending: [] };
	private readonly lookupOn = process.env.PI_ZIP_LOOKUP !== "0";
	constructor(private readonly ledger: (rec: Record<string, unknown>) => void) {}
	resetMemory() { this.memoryPendingShown = false; this.memoryFinalAt = null; }
	resetLookup() { this.lookup = { scope: "\0", pending: [] }; }
	withMemory(messages: Any[], ctx: Any, memory: RequestMemory | null, host: NoteHost): Any[] | null {
		if (!memory || !host.inRun) return null;
		try {
			const note = memory.current(ctx);
			if (!note) return null;
			const at = messages.findLastIndex((m: Any) => m?.role === "user" && textOf(m.content) === note.prompt);
			if (at < 0) return null;
			const ts = messages[at].timestamp;
			const msg = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
			const ready = note.text !== null && note.text !== undefined;
			let pending = this.memoryPendingShown, finalAt = this.memoryFinalAt;
			// findings go at the end of the first request after they are ready (right after the prompt when that is the first request);
			// "nothing relevant" only closes a pending note that was shown
			if (finalAt === null && ready && !note.delivered && (pending || note.found !== false)) finalAt = messages.length;
			if (!pending && finalAt === null && !ready && note.pending) pending = true;
			if (finalAt !== null && finalAt > messages.length) finalAt = null; // the run's messages were rebuilt: keep what still fits
			const inserts: Array<[number, Any]> = [];
			if (pending && note.pending) inserts.push([at + 1, msg(note.pending)]);
			if (finalAt !== null && note.text) inserts.push([finalAt, msg(note.text)]);
			if (!inserts.length) return null;
			const sc = host.scaleOf(ctx);
			const body = messages.filter((m) => m?.role !== "system").reduce((n: number, m: Any) => n + wireTokensOf(m), 0);
			const room = compactionRoom(ctx?.model, host.reserve(ctx));
			if (room !== null && sizeOf(sc, body + inserts.reduce((n, [, m]) => n + wireTokensOf(m), 0)) > room) return null;
			const repeat = (pending && this.memoryPendingShown) || (finalAt !== null && this.memoryFinalAt !== null);
			if (pending && !this.memoryPendingShown) memory.injected(note.pending!.length, at + 1, "pending");
			if (finalAt !== null && this.memoryFinalAt === null) memory.injected(note.text!.length, finalAt, "final");
			if (repeat) memory.reinjected();
			this.memoryPendingShown = pending;
			this.memoryFinalAt = finalAt;
			const out = [...messages];
			// the findings first (finalAt >= at + 1), so inserting the pending note does not shift them; at one index it comes first
			for (const [i, m] of inserts.reverse()) out.splice(i, 0, m);
			return out;
		} catch (err) {
			this.ledger({ type: "error", where: "memory_inject", error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	}

	withHint(messages: Any[], ctx: Any, host: NoteHost): Any[] | null {
		const judging = host.judge.enabled;
		if ((!judging && !this.lookupOn) || !host.inRun || host.recallMode !== "tool" || requestOpen(messages)) return null;
		try {
			const entries = ((ctx?.sessionManager?.buildSessionProjection?.() as Any)?.entries ?? []) as Any[];
			const blocks = buildBlocks(entries, host.steerIds);
			const scope = latestUserText(blocks);
			const cwd = (ctx?.cwd as string) ?? process.cwd();
			const cue = this.lookupOn ? this.lookupCue(scope, messages, blocks, ctx, cwd, host) : null;
			let hint: ReturnType<Judge["proposeHints"]> = null;
			if (judging) {
				const folded = new Set<string>([...host.foldedCalls.values(), ...blocks.filter((b) => b.ours && b.entryId).map((b) => handleFor(b.entryId!))]);
				const resolvable = new Set(resolveHandlesInBranch(host.branch(ctx), [...folded]).items.filter((it) => it.text != null).map((it) => it.handle));
				hint = host.judge.proposeHints({ folded: resolvable, recalled: host.recalled, reqCount: host.judgeReq, scope, cited: (h, loc) => citesWork(blocks, h, loc, cwd) });
			}
			if (!cue && !hint) return null;
			const msg = { role: "user", content: [cue?.text, hint?.text].filter(Boolean).join("\n") };
			const sc = host.scaleOf(ctx, entries);
			const body = messages.filter((m) => m?.role !== "system").reduce((n: number, m: Any) => n + wireTokensOf(m), 0);
			const room = compactionRoom(ctx?.model, host.reserve(ctx));
			if (room !== null && sizeOf(sc, body + wireTokensOf(msg)) > room) {
				if (cue) this.ledger({ type: "lookup_hint", shown: cue.shown, dropped: "room" });
				if (hint) host.judge.hintNote({ shown: hint.shown, dropped: "room" });
				return null;
			}
			if (cue) {
				const shown = new Set(cue.shown);
				this.lookup.pending = this.lookup.pending.filter((r) => !shown.has(r.handle));
				this.ledger({ type: "lookup_hint", shown: cue.shown, via: cue.via, left: this.lookup.pending.length });
			}
			if (hint) {
				host.judge.hintNote({ shown: hint.shown, skipped: hint.skipped });
				host.judge.commitHints(hint.shown, hint.skipped);
				attempt(() => host.appendHint(hint!.shown), undefined);
			}
			return [...messages, msg];
		} catch (err) {
			this.ledger({ type: "error", where: "judge_hint", error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	}

	private lookupCue(scope: string, messages: Any[], blocks: Block[], ctx: Any, cwd: string, host: NoteHost): { text: string; shown: string[]; via: string[] } | null {
		const fresh = scope !== this.lookup.scope;
		if (fresh) this.lookup = { scope, pending: [] };
		if (!scope || (!fresh && !this.lookup.pending.length)) return null;
		const entryOf = new Map<string, string>();
		for (const b of blocks) if (b.kind === "toolResult" && b.entryId && b.msg.toolCallId) entryOf.set(b.msg.toolCallId, b.entryId);
		const live = new Set<string>();
		for (const m of messages) {
			const id = m?.role === "toolResult" && !textOf(m.content).startsWith(PH_MARK) ? entryOf.get(m.toolCallId) : undefined;
			if (id) live.add(handleFor(id));
		}
		const current = lookupRefs(scope, host.branch(ctx), cwd, live);
		if (fresh) this.lookup.pending = current;
		else {
			const valid = new Set(current.map((r) => r.handle));
			this.lookup.pending = this.lookup.pending.filter((r) => valid.has(r.handle) && !host.recalled.has(r.handle));
		}
		const pending = this.lookup.pending;
		if (!pending.length) return null;
		const packed = lookupText(pending);
		if (!packed.shown.length) return null;
		return { ...packed, via: packed.shown.map((h) => pending.find((r) => r.handle === h)!.via) };
	}

}
