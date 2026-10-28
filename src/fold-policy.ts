// Fork fold selection and source-order call matching. The upstream planner owns the price law.
import { type Block, type Calls, type Call, type PlanOpts, type PlanResult, type plan, settings, UNIT, countUserTurns, openStarter, buildBlocks } from "./plan.ts";
import { classifyRecoverability } from "./read-policy.ts";
import { handleFor, makePlaceholderFor, RECALL_TOOL } from "./fold-format.ts";
import { commandNamesRecall, parseRecallPath } from "./recallfile.ts";
import { MIN_EXPECT } from "./learn.ts";
import { type Any, textOf, tok4, tokensOf } from "./util.ts";
const PROTECT_USER_TURNS = 2;

export function toolCallIndex(blocks: Block[]): Calls {
	const m: Calls = new Map();
	const byResult = new WeakMap<object, Call | null>();
	const issued = new Map<string, Call | null>(); // id -> the newest call that issued it so far; null: one message issued it twice
	for (const b of blocks) {
		if (b.kind === "assistant") {
			const content: Any[] = Array.isArray(b.msg.content) ? b.msg.content : [];
			const seen = new Map<string, number>();
			for (const c of content) if (c?.type === "toolCall") seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
			for (const c of content) {
				if (c?.type !== "toolCall") continue;
				const call = { name: c.name, args: c.arguments };
				m.set(c.id, call);
				issued.set(c.id, (seen.get(c.id) ?? 0) > 1 ? null : call);
			}
		} else if (b.kind === "toolResult" && b.msg && typeof b.msg === "object") {
			byResult.set(b.msg, issued.get(b.msg.toolCallId) ?? null);
			if (b.raw && typeof b.raw === "object") byResult.set(b.raw, issued.get(b.msg.toolCallId) ?? null);
		}
	}
	m.byResult = byResult;
	return m;
}

/** The call that produced this tool result message: its own source-order call when `calls` indexed it (undefined when ambiguous or
 *  issued only after it), else the call with its id (an index built without results). */
export function callOf(calls: Calls, msg: Any): Call | undefined {
	if (msg && typeof msg === "object" && calls.byResult?.has(msg)) return calls.byResult.get(msg) ?? undefined;
	return calls.get(msg?.toolCallId);
}

/** Candidate groups in planner order. Shared with the background judge; economics still belongs to plan(). */
export function foldCandidates(blocks: Block[], calls: Calls, o: PlanOpts): [Block[], Block[], Block[]] {
	const s = settings(), scale = o.scale ?? UNIT;
	const turns = countUserTurns(blocks) + (o.promptPending && !openStarter(blocks) ? 1 : 0);
	const age = o.inturnAge ?? s.inturnAge;
	// Preserve the automatic-cache observation prefix in both selection paths.
	const head = o.law?.pr.cls === "automatic" ? (MIN_EXPECT - scale.O) / scale.c : 0;
	const groups: [Block[], Block[], Block[]] = [[], [], []];
	let start = 0;
	for (const b of blocks) {
		const pos = start; start += b.tokens;
		if (b.kind !== "toolResult" || b.edited || !b.entryId || pos < head || (o.recalled?.size ? o.recalled.has(handleFor(b.entryId)) : false)) continue;
		const text = textOf((b.raw ?? b.msg).content);
		if (tok4(text) <= (o.foldMin ?? s.foldMin)) continue;
		const call = callOf(calls, b.msg), name = call?.name ?? b.msg.toolName;
		if (name === RECALL_TOOL || (name === "bash" && commandNamesRecall(call?.args?.command))
			|| (["read", "grep", "find", "ls"].includes(name) && !!parseRecallPath(call?.args?.path))) continue;
		const rereadable = () => classifyRecoverability(name ?? "", call?.args, text, o.cwd, (b.raw ?? b.msg).content) === "rereadable";
		if (o.rereadOnly && !rereadable()) continue;
		if (b.userTurn < turns - PROTECT_USER_TURNS + 1) groups[0].push(b);
		else if (o.rescue?.force?.has(b.entryId)) groups[2].push(b);
		else {
			if (o.pause && b.userTurn < turns && rereadable()) groups[1].push(b);
			if (age > 0 && b.age >= age) groups[2].push(b);
		}
	}
	return groups;
}

/** A useful, recallable replacement; ranking cannot bypass the planner's saving check. */
export function foldPlaceholder(b: Block, calls: Calls, o: PlanOpts): { ph: string; phTok: number } | null {
	if (!b.entryId || (o.recalled?.size ? o.recalled.has(handleFor(b.entryId)) : false)) return null;
	const ph = makePlaceholderFor(b, calls, o.keepLines ?? settings().keepLines, !!o.rereadOnly, o.fileRecall, o.foldedAt);
	if (ph === null) return null;
	const phTok = tokensOf({ ...b.msg, content: [{ type: "text", text: ph }] });
	return phTok < 0.9 * b.tokens ? { ph, phTok } : null;
}


export function recordFoldDecision(o: PlanOpts, q: ReturnType<typeof plan>, p: PlanResult | null, b2b: boolean, entries: Any[]) {
	if (o.trace) {
		const blocks = q?.f.blocks ?? buildBlocks(entries), calls = q?.f.calls ?? toolCallIndex(blocks);
		const groups = new Map<string, number>();
		foldCandidates(blocks, calls, o).forEach((xs, i) => xs.forEach((b) => groups.set(b.entryId!, i)));
		// The guard may try a ready-summary plan and then the folds-only fallback. Record proposals from both paths.
		const proposed = [q?.a, q?.f, p].flatMap((x) => x ? [...x.folds, ...(x.judged?.folds ?? [])] : []);
		const planned = new Set(proposed.map((f) => f.entryId));
		const selected = new Set(p?.folds.map((f) => f.entryId) ?? []);
		o.foldDecision = {
			reason: b2b ? "back-to-back" : p ? "selected" : o.trace.some((t) => t.where === "guard" && !t.ok && t.A < t.B) ? "guard-rejected" : "no-plan",
			outputs: blocks.filter((b) => b.kind === "toolResult" && b.entryId && !b.edited && b.tokens > (o.foldMin ?? settings().foldMin)).map((b) => {
				const h = handleFor(b.entryId!);
				return { h, age: b.age, verdict: o.verdicts?.get(h) ?? "unscored", group: groups.get(b.entryId!) ?? null,
					planned: planned.has(b.entryId!), selected: selected.has(b.entryId!) };
			}),
		};
	}
}
