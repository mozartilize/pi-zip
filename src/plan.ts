// Pure planning: session projection -> which outputs to fold, whether to summarise, where to cut (F5-F10).
import { classifyRecoverability, type Recover } from "./classify.ts";
import { handleFor, makePlaceholderFor, pickKeyLines, RECALL_TOOL, shortArgs } from "./placeholder.ts";
import { createHash } from "node:crypto";
import { type Any, COMMIT_CUSTOM, PRODUCT, clamp, envInt, piTokensOf, textOf, tok4, tokensOf } from "./util.ts";
import { PH_MARK } from "./placeholder.ts";
import { MIN_EXPECT, type Prices } from "./learn.ts";
import { commandNamesRecall, parseRecallPath, type FileRecall } from "./recallfile.ts";

/** Default: when a COLD plan (P(warm) < 0.5) is still above the cap, also fold REREADABLE outputs of the previous user turn, biggest
 *  first. A warm plan does so only at a user return after the declared TTL (PlanOpts.pastTtl): the very returns where the TTL rule
 *  always folded that turn, so the quality stays the TTL rule's while the law, with the learned P(warm), still decides whether the
 *  rewrite pays (a provider whose cache outlives its declared TTL otherwise keeps the whole previous turn at every return: live GLM
 *  1.15x the TTL rule's bill). Any other warm plan never does: the user comes back to a warm cache and refers to the turn just
 *  finished (final model: +4.0 / +5.8 lost items with it). false = no relax fold of the previous user turn, but the
 *  in-turn rule (INTURN_AGE) still folds old outputs there; set PI_ZIP_INTURN_AGE=0 as well for a fully protected previous turn. */
export const RELAX_PREV_TURN = true;

/** Default age, in assistant requests, from which ANY foldable output (every recoverability class) inside the protected user turns may
 *  still be folded. A sub-agent session is one user turn with hundreds of tool rounds, so without this its candidate set is empty for
 *  its whole life (offline sim on 295 recorded sessions: 1.37x the billion-context bill). 0 disables the rule (PI_ZIP_INTURN_AGE).
 *  Plans run at turn_end, before the next request, so `age >= 60` here equals the sim's `b <= v - 61`. 60 is the final model's quality
 *  constant (largest saving with lost <= prod in every stratum); the old rereadable-only filter cost 1.026 / 1.018x at -0.6 lost items. */
export const INTURN_AGE = 60;

const PROTECT_USER_TURNS = 2; // the latest user turn and the one before it are never summarised (but see LOOKAHEAD); folded only by relax (cold plan, previous turn, rereadable) or in-turn (old enough)

/** F1: a warm (valve) summary passes the same summary gate as a cold one, the call priced in (before: a warm plan skipped it, so a
 *  summary the cold gate had just refused was written one request later anyway). PlanOpts.warmSummaryGate. */
export const WARM_SUMMARY_GATE = true;
/** F2: a cold plan that does not summarise looks one user turn ahead: if the warm valve would summarise at the next user turn, once the
 *  protected window has slid past the previous turn, the cold plan summarises now (the rewrite is free now, not then), its cut allowed
 *  inside the previous user turn up to that turn's final assistant answer, which stays verbatim with everything after it. PlanOpts.lookahead. */
export const LOOKAHEAD = false;
/** F3: the summary gates price the call the code makes (summary.ts narrative): uncached input of the prefix the narrative reads (the
 *  previous summary is not sent: its sections are carried forward by code) plus output of at most the narrative budget, instead of
 *  w x the prefix + out x the whole planned summary (which counts the carried-forward previous summary as model output). PlanOpts.narrativePrice. */
export const NARRATIVE_PRICE = true;
/** The narrative's token budget (chars/4), summary.ts buildCut: clamp(planned - skeleton, 300, NARRATIVE_MAX). */
export const NARRATIVE_MAX = 4000;
/** B2 for folds (formal TRIAGE (a) 6): the outputs a cold plan must protect (the previous user turn's, the mutating ones) are no longer
 *  protected one prompt later, when the window slides, and the warm plan then folded them at a warm cache: a rewrite the free cold one
 *  dominated. Now a warm plan holds back the blocks that were protected at the last cold return (PlanOpts.hold: that return's prompt)
 *  until the next cold return, or until the session has grown by more than HOLD_RELEASE real tokens since it (new information), or the
 *  context is at Pi's compaction room; and when even folding them all would not avoid a summary, it is the plan it was before. Chosen
 *  over folding them early at the cold return (the user would lose the previous turn's outputs at the prompt that asks about them):
 *  formal/TRIAGE.md, B2 for folds. */
export const FOLD_HOLD = true;
/** The spec's "no new information" is growth <= 10K real tokens (formal DELTA); the estimate is chars/4 x c, 15% off at worst (TOL_TARGET). */
export const HOLD_RELEASE = 11_500;
const SUMMARY_FLOOR = 1000;
const SUMMARY_CAP = 8000;
const SUMMARY_RATIO = 0.1;

export const DEFAULT_RESERVE_TOKENS = 16_384; // Pi's compaction reserve default
export const COMPACT_MARGIN = 8_192; // estimates are chars/4: stay clear of the trigger
const MIN_TARGET = 4_096;

/** Pi's compaction reserve for this model: compaction.modelOverrides["provider/id"], else compaction.reserveTokens, else 16384. */
export function reserveTokensFor(settings: Any, model: Any): number {
	const c = settings?.compaction;
	const key = model ? `${model.provider}/${model.id}` : "";
	for (const v of [c?.modelOverrides?.[key]?.reserveTokens, c?.reserveTokens]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	return DEFAULT_RESERVE_TOKENS;
}

/** Highest context size that stays clear of Pi's compaction trigger; null when the window is unknown. */
export function compactionRoom(model: Any, reserve = DEFAULT_RESERVE_TOKENS): number | null {
	const w = Number(model?.contextWindow);
	return w > 0 ? Math.max(MIN_TARGET, w - reserve - COMPACT_MARGIN) : null;
}

// Legacy rule, only when nothing at all is known about prices (cache class unknown: no response from this model yet): a warm edit must cut at least half
// of the context, or, inside Pi's compaction danger zone (before >= room), merely reduce it.
export const VALVE_MIN_REDUCTION = 0.5;
export function legacyValve(before: number, after: number, room: number | null): boolean {
	if (!(after < before)) return false;
	if (room !== null && before >= room) return true;
	return after <= (1 - VALVE_MIN_REDUCTION) * before;
}

export const PI_KEEP_RECENT = 20_000; // Pi's compaction keepRecentTokens default

/** Pi's compaction keepRecentTokens for this model: compaction.modelOverrides["provider/id"], else compaction.keepRecentTokens, else 20000. */
export function keepRecentTokensFor(settings: Any, model: Any): number {
	const c = settings?.compaction;
	const key = model ? `${model.provider}/${model.id}` : "";
	for (const v of [c?.modelOverrides?.[key]?.keepRecentTokens, c?.keepRecentTokens]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
	return PI_KEEP_RECENT;
}

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/**
 * Would Pi's compact() find something to compact in this projection (the branch as it is now), or throw "Nothing to compact (session
 * too small)"? A replica of the emptiness test of Pi's prepareCompaction (core/compaction/compaction.js, not exported): Pi cuts where
 * keepRecent of its chars/4 tokens, counted from the end, begin, at the next cut point; the conversation before that cut (or before the
 * turn it splits) must not be empty. Pi's own extra moves of the cut (over entries without messages, past recovery omissions) never
 * empty it. The caller checks "Already compacted" (the newest branch entry is a compaction) itself.
 */
export function piCanCompact(entries: Any[], keepRecent: number): boolean {
	const msgs = (e: Any): Any[] => (Array.isArray(e?.messages) ? e.messages : []);
	const isComp = (e: Any) => e?.sourceEntry?.type === "compaction";
	const prev = entries.findIndex((e) => isComp(e) && msgs(e).length > 0);
	const start = prev >= 0 ? prev + 1 : 0, end = entries.length;
	const cuts: number[] = [];
	for (let i = start; i < end; i++) if (!isComp(entries[i]) && msgs(entries[i]).some((m) => CUT_POINT_ROLES.has(m?.role))) cuts.push(i);
	if (!cuts.length) return false;
	let cut = cuts[0], acc = 0;
	for (let i = end - 1; i >= start; i--) {
		const t = msgs(entries[i]).reduce((a, m) => a + piTokensOf(m), 0);
		if (!t) continue;
		acc += t;
		if (acc >= keepRecent) { cut = cuts.find((c) => c >= i) ?? cuts[cuts.length - 1]; break; }
	}
	while (cut > start && !isComp(entries[cut - 1]) && !msgs(entries[cut - 1]).length) cut--;
	if (!entries[cut]?.sourceEntry?.id) return false;
	const startsTurn = (e: Any) => !isComp(e) && msgs(e).some((m) => TURN_START_ROLES.has(m?.role));
	let turn = -1;
	if (!startsTurn(entries[cut])) for (let i = cut; i >= start; i--) if (startsTurn(entries[i])) { turn = i; break; }
	const conversation = (from: number, to: number) => entries.slice(from, to).some((e) => !isComp(e) && msgs(e).some((m) => m?.role !== "system"));
	return turn >= 0 ? conversation(start, turn) || conversation(turn, cut) : conversation(start, cut);
}

/** The projection a run plan would have seen without pi-zip's native compaction: `pre` (taken right before it) plus what was appended
 *  after the compaction entry (the prompt and anything sent with it). null when that compaction is no longer the head of `now`. */
export function spliceNative(pre: Any[], now: Any[], compactionId: string): Any[] | null {
	if (!compactionId || now[0]?.sourceEntry?.id !== compactionId) return null;
	const known = new Set(pre.map((e) => e?.sourceEntry?.id).filter((x) => typeof x === "string"));
	return [...pre, ...now.slice(1).filter((e) => !known.has(e?.sourceEntry?.id))];
}
export const G0 = 2_500; // growth per request before the session's own EWMA has data

/** What the law knows at a decision: prices (null = legacy rule), growth per request g (real tokens), P(the cache is warm). */
export interface Law { pr: Prices | null; g: number; pWarm: number }
export interface LawTerms { ok: boolean; B: number; A: number; T: number; P: number; K: number; eta: number; phi: number; Tsuf?: number }

/**
 * The round-5 law (verdict section 8): rewrite the cache only when what the edit saves pays for the rewrite it causes.
 *   Phi = [ r D^2/(2g) + eta D ] / K >= 1,   D = B - A,   K = (w - r) (P T - (1 - P) D) + call
 * B, A = real context before / after the edit. T = the rewrite base; the planner passes T = A (final model: pricing only the suffix after
 * the earliest edit, ~0.42 A, fires warm edits earlier and costs +0.9 / +4.6 lost items for -0.6 / -0.3% $; the suffix is logged as Tsuf,
 * a measurement only). T is clamped to A. P = P(warm) at this gap: 1 = the verdict's warm valve, 0 = known dead (K < 0: always fire). The expected form is
 * linear in P because a warm next request costs (w - r) T - r D more with the edit and a cold one w D less, plus the r D read credit.
 * eta = 0 below Pi's compaction room, else Pi's own price per token of room (window term). Prices per token; no prices = legacy rule.
 */
export function lawTerms(B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A, keep = PI_KEEP_RECENT): LawTerms {
	const t: LawTerms = { ok: false, B, A, T, P, K: NaN, eta: 0, phi: NaN };
	if (!(A < B)) return t;
	if (!pr || !(pr.r > 0)) return { ...t, ok: legacyValve(B, A, room) };
	const { r, w, out } = pr;
	const D = B - A, K = (w - r) * (P * Math.min(T, A) - (1 - P) * D) + call;
	let eta = 0;
	if (room !== null && B >= room) {
		const S = Math.min(8_000, Math.max(1_000, 0.1 * (B - keep))), Api = keep + S;
		eta = (w * (B - keep) + out * S + (w - r) * Api) / Math.max(B - Api, 1);
	}
	const gain = (r * D * D) / (2 * Math.max(g, 1)) + eta * D;
	return { ...t, ok: K <= 0 || gain >= K, K, eta, phi: K > 0 ? gain / K : Infinity };
}

export const editAllowed = (B: number, A: number, P: number, room: number | null, pr: Prices | null, g: number, call = 0, T = A): boolean =>
	lawTerms(B, A, P, room, pr, g, call, T).ok;

// Token scale. Every size in this file is a chars/4 estimate of the CONTENT (Pi's own rule); the provider counts real tokens, and the
// two are not proportional:   real = O + c x content.
//   O  what every request carries and no edit can shrink: system prompt, tool schemas, the provider's own framing (2-4K on a bare Pi,
//      29-55K with a large tool set);
//   c  real tokens per estimated content token (0.7-1.1 GLM / GPT, 1.5-2.2 Claude; more on CJK-heavy content).
// pi-zip <= 0.2.9 used ONE ratio, k = real / (system prompt + content) clamped to [1, 2.5]: with O a third of the context k sat on its
// clamp, and every size after an edit came out 10-15K too small (research round5/affine.md). Both are read from the branch on every
// decision, so a restart or `pi -p` calibrates exactly like a long-lived process, and nothing is stored:
//   O  1. the cacheRead of the request that first carried the newest summary: everything after the system prompt and tools changed
//         there, so what the provider still read from its cache is exactly O (when the cache was warm at all);
//      2. else the session's first request minus C0 x its content (an opening prompt is small next to O);
//      3. else R0 x the chars/4 of the system prompt and the JSON of the declared tools.
//      An O measured under another system prompt or tool set moves by R0 x the change of that chars/4 size (MCP tools come and go).
//   c  (real - O) / content of the newest response, clamped to [C_MIN, C_MAX] (a guard for a tiny content estimate; recorded sessions
//      span 0.7-3.9); C0 before the first response. A response followed by edits it did not carry (a warm-valve edit is persisted at
//      turn_end and first sent with the next request: that response's prompt did not shrink) is counted with the originals.
//   Both are per model: only responses of the model the next request goes to count. After a switch, before its first response,
//   O = R0 x the system state and c = C0; after it, with no O evidence of its own, O = c x X, X = O / c of the previous model.
export const C0 = 1.5;
export const C_MIN = 0.5;
export const C_MAX = 4;
export const R0 = 2;

/** The system prompt and the declared tools (Pi API fallback for a transcript that records no system message). */
export interface SysInfo { text: string; tools: Any[] }
/** chars/4 of the system prompt plus the JSON of the declared tool definitions (name, description, parameters). */
export const sysEst = (s: SysInfo): number =>
	tok4(s.text) + (s.tools.length ? tok4(JSON.stringify(s.tools.map((t: Any) => ({ name: t?.name, description: t?.description, parameters: t?.parameters })))) : 0);

export interface Scale {
	O: number; // real tokens every request carries before the content (system prompt, tools, framing)
	c: number; // real tokens per estimated (chars/4) content token
	real: number; // input + cacheRead + cacheWrite of the newest usable response (0 = none)
	est: number; // estimated content that request carried
	source: "usage" | "default"; // where c comes from
	oSource: "summary" | "first" | "model" | "default"; // where O comes from ("model": another model's O in content units, X = O' / c')
}
/** Sizes taken as real (tests, and the ledger of a plan made without calibration). */
export const UNIT: Scale = { O: 0, c: 1, real: 0, est: 0, source: "default", oSource: "default" };
/** Real tokens of a context whose content is estimated at `content`. */
export const sizeOf = (s: Pick<Scale, "O" | "c">, content: number): number => s.O + s.c * content;

/** A response pi-ai drops before sending (an error or an abort): it carries no usable usage and adds nothing to later requests. */
const dropped = (m: Any): boolean => m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted");
/** chars/4 a message adds to every later request: tokensOf, except 0 for an assistant message pi-ai drops before sending. */
export const wireTokensOf = (m: Any): number => (dropped(m) ? 0 : tokensOf(m));
/** Prompt size the provider reported for a response that really ran (0 = none, an error or an abort). */
const promptOf = (m: Any): number => {
	const u = m?.role === "assistant" && !dropped(m) ? m.usage : null;
	return u ? (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) : 0;
};
/** "provider/model" of a response ("" = not recorded: such a response counts for any model). */
const respKey = (m: Any): string => (m?.provider || m?.model ? `${m.provider ?? ""}/${m.model ?? ""}` : "");
/** chars/4 of the system state the transcript records in `msgs` (-1: none recorded). */
function sysOf(msgs: Any[]): number {
	const s = collapseSystem(msgs);
	return s ? sysEst({ text: [textOf(s.content), ...Object.values<string>(s.sections ?? {})].filter((x) => x).join("\n\n"), tools: s.toolsAdded ?? [] }) : -1;
}
/** The session's first response from model `key` on the branch: its prompt, the content before it and the system state it was sent with. */
function firstRequest(branch: Any[], key: string): { real: number; est: number; S: number } | null {
	const sys: Any[] = [];
	let est = 0;
	for (const e of branch) {
		const m = e?.type === "message" ? e.message : e?.type === "custom_message" ? { role: "custom", content: e.content } : null;
		if (!m) continue;
		if (m.role === "system") { sys.push(m); continue; }
		const real = promptOf(m), k = respKey(m);
		if (real > 0 && (!key || !k || k === key)) return { real, est, S: sysOf(sys) };
		est += wireTokensOf(m);
	}
	return null;
}

/** chars/4 of the context the request behind the response `id` carried, rebuilt from the branch the way Pi projects it: the newest
 *  compaction before the response, the entries it keeps, everything after it, and the edits persisted before the response, plus the
 *  edits of a run plan persisted right after it (their commit entry says the response itself carried them). null: `id` is not on the
 *  branch. Used when a compaction written after the response (Pi's own, another extension's) removed that request's content from the
 *  projection, so the projection cannot say what the response measured. */
function requestEst(branch: Any[], id: string): number | null {
	const at = branch.findIndex((e) => e?.id === id);
	if (at < 0) return null;
	const pre = branch.slice(0, at);
	const edit = new Map<string, Any>();
	for (const e of pre) if (e?.type === "context_edit") edit.set(e.targetId, e.replacement);
	for (let i = at + 1; i < branch.length && !(branch[i]?.type === "message" || branch[i]?.type === "compaction"); i++) {
		const e = branch[i];
		if (e?.type === "custom" && e.customType === COMMIT_CUSTOM) {
			if (e.data?.carried) for (let j = at + 1; j < i; j++) if (branch[j]?.type === "context_edit") edit.set(branch[j].targetId, branch[j].replacement);
			break;
		}
	}
	let ci = -1;
	pre.forEach((e, i) => { if (e?.type === "compaction") ci = i; });
	const kept = ci < 0 ? pre : [pre[ci], ...pre.slice(0, ci).slice(Math.max(0, pre.findIndex((e) => e?.id === pre[ci].firstKeptEntryId))).filter((e) => !(e?.type === "message" && e.message?.role === "system")), ...pre.slice(ci + 1)];
	let est = 0;
	for (const e of kept) {
		if (e?.type === "compaction" || e?.type === "branch_summary") est += tokensOf({ role: "compactionSummary", summary: e.summary });
		else if (e?.type === "custom_message") est += tokensOf({ role: "custom", content: edit.has(e.id) ? edit.get(e.id)?.content : e.content });
		else if (e?.type === "message" && e.message) {
			const rep = edit.get(e.id);
			if (rep === null) continue;
			const m = rep && e.message.role !== "system" ? { ...e.message, content: typeof rep.content === "string" && e.message.role !== "user" ? [{ type: "text", text: rep.content }] : rep.content } : e.message;
			est += wireTokensOf(m);
		}
	}
	return est;
}

/** O and c from the projection (`entries`) and, for the session's first request, the branch; `sys` stands in for a transcript without
 *  system messages. `model` = "provider/id" of the model the next request goes to (default: the newest response's): O and c are
 *  properties of the provider's tokenizer, so only that model's responses are evidence. With none, O = R0 x the system state and
 *  c = C0; with responses but no O evidence of its own (a model switch mid-session), O keeps the size another model measured in
 *  content units, X = O' / c' (the system prompt and tools tokenize like the content around them): real = c (X + E). */
export function calibrate(entries: Any[], sys?: SysInfo, branch: Any[] = [], model?: string): Scale {
	type Resp = { at: number; est: number; real: number; read: number; nSys: number; ts: number; key: string; id: string };
	const resp: Resp[] = [];
	const sysMsgs: Any[] = [];
	const edits: { at: number; target: string; foreign: boolean }[] = [];
	const marks: { at: number; carried: boolean }[] = []; // pi-zip's commit entries: who first carried the edits right before them (run.ts commit)
	const orig = new Map<string, { at: number; d: number }>(); // edited entries: tokens their originals add back
	const withMsgs: number[] = [0]; // withMsgs[k]: entries before k that carry messages (a commit group has none inside it)
	let est = 0, sysAt = 0; // sysAt: responses before the newest system message
	entries.forEach((pe, at) => {
		const src = pe.sourceEntry, msgs: Any[] = pe.messages ?? [];
		withMsgs.push(withMsgs[at] + (msgs.length ? 1 : 0));
		// an edit with a replacement that is not our placeholder is another extension's (never carried by a request of ours); one without
		// (a bare entry) is judged by the size heuristics below
		if (src?.type === "context_edit") edits.push({ at, target: src.targetId, foreign: "replacement" in src && !textOf(src.replacement?.content).startsWith(PH_MARK) });
		if (src?.type === "custom" && src.customType === COMMIT_CUSTOM) marks.push({ at, carried: !!src.data?.carried });
		if (src?.type === "message" && msgs.length === 1 && msgs[0] !== src.message) orig.set(src.id, { at, d: wireTokensOf(src.message) - wireTokensOf(msgs[0]) });
		for (const m of msgs) {
			if (m?.role === "system") { sysMsgs.push(m); sysAt = resp.length; continue; }
			const real = promptOf(m);
			if (real > 0) resp.push({ at, est, real, read: Number(m.usage.cacheRead) || 0, nSys: sysMsgs.length, ts: Number(m.timestamp) || 0, key: respKey(m), id: src?.id ?? "" });
			est += wireTokensOf(m);
		}
	});
	const sAt = (n: number) => sysOf(sysMsgs.slice(0, n)); // the system state after the first n system messages (computed only where needed)
	const S = sAt(sysMsgs.length);
	const Snow = S >= 0 ? S : sys ? sysEst(sys) : 0;
	const head = entries[0]?.sourceEntry?.type === "compaction" ? entries[0].sourceEntry : null;
	const headMs = head ? Date.parse(head.timestamp) || 0 : 0;
	// a pi-zip summary persisted as a turn_end draft was request-local first (a run plan carries it before its entry exists); one that
	// went in through Pi's compaction before the run (details.via "native") is carried after its entry, exactly like Pi's own
	const local = !!head && head.details?.by === PRODUCT && head.details?.via !== "native";
	// Was the request behind this response sent after the head compaction entry was written? The branch's order says (timestamps tie when
	// a compaction follows a response in the same millisecond); without the branch the timestamps do.
	const pos = new Map<string, number>();
	if (head) branch.forEach((e, i) => { if (typeof e?.id === "string") pos.set(e.id, i); });
	const afterHead = (r: Resp): boolean => {
		const h = pos.get(head?.id), i = pos.get(r.id);
		return h !== undefined && i !== undefined ? i > h : r.ts > headMs;
	};
	const opening = (r: { real: number; est: number } | null | undefined) => !!r && C0 * r.est <= 0.1 * r.real; // content small next to O

	/** The first commit entry of the group of pi-zip edits that starts at entry `at` (none when a message comes first). */
	const markOf = (at: number) => marks.find((m) => m.at > at && withMsgs[m.at] - withMsgs[at + 1] === 0);
	/** Index of the newest response in `resp` before entry `at`. */
	const respBefore = (at: number) => resp.reduce((k, r, i) => (r.at < at ? i : k), -1);
	/** Tokens the originals add back for response i: edits persisted after it that its own request did not carry (the projection counts
	 *  their placeholders). A commit entry says who carried them (a run plan: the response before the entry; a valve plan: the next one);
	 *  with none (a session of an older version) the sizes decide, for the newest response only (`legacy`). */
	const addBack = (i: number, legacy: boolean): number => {
		let d = 0;
		for (const x of edits) {
			const t = orig.get(x.target);
			if (x.at <= resp[i].at || !t || t.at >= resp[i].at) continue;
			const m = x.foreign ? undefined : markOf(x.at);
			if (m ? m.carried && respBefore(m.at) === i : !x.foreign && legacy) continue;
			d += t.d;
		}
		return d;
	};

	const fit = (want: string, transfer: boolean): Scale => {
		const mine = (r: Resp | undefined): r is Resp => !!r && (!want || !r.key || r.key === want);
		// evidence for O, the newest wins (it needs the smallest correction for system changes since)
		const ev: { at: number; O: number; S: number; src: Scale["oSource"] }[] = [];
		const f = branch.length ? firstRequest(branch, want) : head ? null : resp.find(mine); // the session's first request
		if (f && opening(f)) ev.push({ at: -1, O: f.real - C0 * f.est, S: "S" in f ? f.S : sAt(f.nSys), src: "first" });
		const ci = resp.findIndex((r, i) => i >= sysAt && mine(r)), cur = resp[ci]; // the first response sent with the current system prompt and tools
		// its content as its request carried it: edits persisted after it (a model switch, say, then a run plan's folds) are in `est`
		const curEst = cur ? cur.est + addBack(ci, false) : 0;
		if (cur && (!head || afterHead(cur)) && opening({ real: cur.real, est: curEst })) ev.push({ at: ci, O: cur.real - C0 * curEst, S, src: "first" });
		if (head) {
			// the summary at the head was first carried by the first response after its entry, or, for pi-zip's own request-local summary
			// (a run plan), by the last one before it; Pi's, another extension's or a native pi-zip compaction is never sent before its entry
			const after = resp.findIndex((r) => afterHead(r)), ours = local;
			for (const i of after < 0 ? (ours ? [resp.length - 1] : []) : ours ? [after - 1, after] : [after]) {
				const r = resp[i], prev = resp[i - 1];
				if (mine(r) && r.read > 0 && r.read < 0.8 * r.real && (!prev || r.read < 0.8 * prev.real)) { ev.push({ at: i, O: r.read, S: sAt(r.nSys), src: "summary" }); break; }
			}
		}
		const best = ev.sort((a, b) => b.at - a.at)[0];
		let O = best ? Math.max(0, best.O + (best.S >= 0 && S >= 0 ? R0 * (Snow - best.S) : 0)) : R0 * Snow, oSource: Scale["oSource"] = best?.src ?? "default";
		// c from the newest response of this model
		let n = resp.length - 1;
		while (n >= 0 && !mine(resp[n])) n--;
		if (n < 0) return { O, c: C0, real: 0, est: 0, source: "default", oSource };
		const N = resp[n];
		let estN = N.est;
		const cutLater = !!head && !afterHead(N);
		const later = edits.filter((x) => x.at > N.at);
		const rebuilt = cutLater && !local && !!N.id ? requestEst(branch, N.id) : null; // what its request carried: the compaction after it removed that from the projection
		if (rebuilt !== null && rebuilt > 0) estN = rebuilt;
		else if (later.length || cutLater) {
			// carried (a run plan): the prompt shrank, or a read stopped early; a cache miss alone (no read at all) proves nothing. The
			// commit entries of pi-zip's edits say it outright; the sizes decide only for edits without one (older sessions).
			// Pi's own compaction is never request-local.
			let p = n - 1;
			while (p >= 0 && !mine(resp[p])) p--;
			const P = resp[p];
			const heur = !P || N.real < P.real || (N.read > 0 && N.read < 0.8 * P.real);
			const carried = !(cutLater && !local) && (cutLater && typeof head.details?.carried === "boolean" ? head.details.carried : heur);
			if (!carried && cutLater) return { O, c: C0, real: N.real, est: 0, source: "default", oSource }; // what it carried is summarised away
			estN += addBack(n, heur && carried);
		}
		if (!best && transfer && estN > 0) {
			// no O of its own: the newest other model's O in content units
			// (a compaction may have taken the other model's responses out of the projection: the branch still has them)
			const other = [...resp].reverse().find((r) => r.key && r.key !== want)?.key
				?? [...branch].reverse().map((e) => (e?.type === "message" && promptOf(e.message) > 0 ? respKey(e.message) : "")).find((k) => k && k !== want);
			const o = other ? fit(other, false) : null;
			if (o && o.oSource !== "default" && o.c > 0) {
				const X = o.O / o.c, c = clamp(N.real / (X + estN), C_MIN, C_MAX);
				return { O: c * X, c, real: N.real, est: estN, source: "usage", oSource: "model" };
			}
		}
		return { O, c: estN > 0 ? clamp((N.real - O) / estN, C_MIN, C_MAX) : C0, real: N.real, est: estN, source: estN > 0 ? "usage" : "default", oSource };
	};
	return fit(model || [...resp].reverse().find((r) => r.key)?.key || "", true);
}

/** The cold cap's target in real tokens of the WHOLE context (system prompt and tools included, as the cap was tuned): max(cap, O + cap/2),
 *  never above Pi's compaction room. While O is under half the cap this is the plain whole-context cap. Above that the target is O plus
 *  half the cap of conversation: never at or below O, where no edit reaches it (0.2.9's 40K with O = 29-55K summarised at every cold
 *  return), and not 40K of conversation on top of O either (the cap on content alone cost +13% live on a 36K prefix, with no quality
 *  difference measured). Offline it never loses more items than the whole-context cap (research round5/affine.md section 11). */
export const CAP_CONTENT_MIN = 0.5;
export const coldTarget = (cap: number, O: number, room: number | null): number => Math.min(Math.max(cap, O + CAP_CONTENT_MIN * cap), room ?? Infinity);

export const settings = () => ({
	coldCap: envInt("COLD_CAP", 40_000), // cold: fold, then summarise, down to this many real tokens of the whole context, but never below O + half of it (coldTarget)
	foldMin: envInt("FOLD_MIN", 500), // outputs below this many tokens are never folded
	keepLines: envInt("KEEP_LINES", 8),
	minGain: envInt("MIN_GAIN", 10_000), // legacy rule only (no prices): a summary must remove at least max(minGain, 15% of the context)
	inturnAge: envInt("INTURN_AGE", INTURN_AGE), // outputs (any class) of the protected turns at least this many assistant requests old may fold; 0 = never
});

/** Legacy summary gate (no prices): a summary only pays when it removes a real share of the context. */
export function summaryGainOk(prefixTokens: number, summaryTokens: number, totalTokens: number, minGain = settings().minGain): boolean {
	return prefixTokens - summaryTokens >= Math.max(minGain, 0.15 * totalTokens);
}

// ---------------------------------------------------------------------------------------------------------------
// blocks: the model-visible context, one block per projected session entry
// ---------------------------------------------------------------------------------------------------------------
export interface Block {
	idx: number;
	entryId: string | null;
	kind: "summary" | "user" | "assistant" | "toolResult" | "other";
	msg: Any; // projected message (after edits)
	raw: Any; // original message (before edits), message entries only
	tokens: number;
	userTurn: number; // user messages so far (inclusive)
	edited: boolean; // some context_edit changed this entry
	ours: boolean; // ... and it is one of our placeholders
	age: number; // toolResult: assistant requests that came after the one that issued the call (0 = answered by the newest request); other kinds 0
}
export type Calls = Map<string, { name: string; args: Any }>;

/** User turns so far: the real prompts. Steering and follow-up messages typed during a run belong to that run's turn. */
export const countUserTurns = (blocks: Block[]): number => blocks.reduce((a, b) => Math.max(a, b.userTurn), 0);

export function buildBlocks(contextEntries: Any[], steerIds?: Set<string>): Block[] {
	const blocks: Block[] = [];
	let userTurn = 0;
	let asst = 0; // assistant messages so far
	const issued = new Map<string, number>(); // tool call id -> ordinal of the latest assistant message that issued it (ids may be reused)
	const asstOf: number[] = []; // block idx -> ordinal of the issuing assistant message (toolResult blocks only)
	for (const pe of contextEntries) {
		const src = pe.sourceEntry;
		const msgs: Any[] = pe.messages ?? [];
		if (!msgs.length) continue;
		let kind: Block["kind"] = "other";
		let msg = msgs[msgs.length - 1];
		let raw: Any;
		let edited = false;
		if (src.type === "compaction") {
			kind = "summary";
			msg = msgs.find((m) => m.role === "compactionSummary") ?? msg;
		} else if (src.type === "message" && msgs.length === 1) {
			raw = src.message;
			msg = msgs[0];
			const r = msg.role;
			kind = r === "user" ? "user" : r === "assistant" ? "assistant" : r === "toolResult" ? "toolResult" : "other";
			edited = msg !== raw && msg.content !== raw.content;
		}
		if (kind === "user" && !(src.id && steerIds?.has(src.id))) userTurn++;
		const ours = edited && kind === "toolResult" && textOf(msg.content).startsWith(PH_MARK);
		if (kind === "assistant") {
			// aborted / final-error messages stay in the projection but pi-ai drops them before sending: they add no age (their calls still count as issued)
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") asst++;
			for (const c of msg.content ?? []) if (c?.type === "toolCall") issued.set(c.id, asst);
		}
		asstOf[blocks.length] = kind === "toolResult" ? (issued.get(msg.toolCallId) ?? asst) : asst;
		blocks.push({ idx: blocks.length, entryId: src.id ?? null, kind, msg, raw, tokens: msgs.reduce((a, m) => a + wireTokensOf(m), 0), userTurn, edited, ours, age: 0 });
	}
	for (const b of blocks) if (b.kind === "toolResult") b.age = asst - asstOf[b.idx];
	return blocks;
}

export function toolCallIndex(blocks: Block[]): Calls {
	const m: Calls = new Map();
	for (const b of blocks) if (b.kind === "assistant") for (const c of b.msg.content ?? []) if (c?.type === "toolCall") m.set(c.id, { name: c.name, args: c.arguments });
	return m;
}

// ---------------------------------------------------------------------------------------------------------------
// plan types
// ---------------------------------------------------------------------------------------------------------------
export interface FoldTarget {
	entryId: string;
	toolCallId: string;
	visIdx: number; // index among the non-system projected messages when planned (-1 = unknown)
	contentKey: string; // hash + length of the original text: some servers reuse tool call ids, so the id alone does not identify a result
	tool: string;
	args: string;
	entryTokens: number;
	phTokens: number;
	ph: string; // placeholder text: byte-identical in the request-local view and the persisted context_edit
	trig: string;
	recover?: Recover;
}

export interface Cut {
	firstKeptEntryId: string;
	text: string; // summary text: byte-identical in the request-local view and the persisted compaction
	trigger: "cold" | "valve";
	count: number; // user requests carried verbatim in the summary
	prefixTokens: number;
	summaryTokens: number;
	llmOk: boolean;
	llmError: string | null;
	costUsd: number; // what the narrative model call cost (0 when unknown)
	usage?: Any;
	ms: number; // total production time (the narrative model call included)
	ahead?: boolean; // F2: a lookahead cut (inside the previous user turn, before its final answer; guard.ts)
}

/** What a run sends from its first request on and persists verbatim at turn_end (F8). */
export interface RunPlan {
	source: "settle" | "runstart" | "valve";
	folds: FoldTarget[];
	cut: Cut | null;
	ctxBefore: number;
	ctxAfter: number;
	ms: number;
	scale: Scale; // the token scale the plan was made with (stats and notices of this run use the same one)
	persisted: boolean;
	cutVisibleIdx?: number; // where the kept part starts among the projected non-system messages
	cutKeptFirstMsg?: Any; // ... and that message itself (a disagreeing request view drops the cut)
	sent?: boolean; // a request view carrying this plan has gone out
	applied?: Set<string>; // entry ids whose fold the latest request view actually carried (what turn_end must persist, no more)
	cutTs?: number; // timestamp of the request-local summary message: one value per run, so every request of the run is identical
	untouched?: number; // real tokens before the earliest edited block: what the first request carrying the plan can still read from the cache
	waitMs?: number; // how long the user waited for this plan's summary (0: none, or it was ready)
	noticed?: boolean; // its notice is already in the transcript (shown when the first request carrying it went out)
	native?: Cut; // this run's summary went in through Pi's own compaction before the run: no request-local cut, no compaction draft
}

export interface PlanOpts {
	mode?: "cold" | "warm"; // cold: cache believed gone (default). warm: only when the context is above the cold cap and the law fires; then the cold plan without the previous-turn relax (kept only when pastTtl).
	law?: Law; // prices, g and P(warm); default: no prices (legacy rule), P = 0 cold / 1 warm
	trace?: (LawTerms & { where: "summary" | "plan" })[]; // every law evaluation is pushed here (ledger)
	reserve?: number; // Pi's compaction reserveTokens (default 16384)
	steerIds?: Set<string>; // user entries that are mid-run steering or follow-up messages, not new user turns
	scale?: Scale; // real = O + c x content estimate (calibrate); default UNIT = the estimates are taken as real
	cwd: string;
	coldCap?: number;
	foldMin?: number;
	keepLines?: number;
	recalled?: Set<string>;
	model?: Any;
	promptPending?: boolean; // true at settle: the upcoming prompt is NOT in `entries` yet but counts as a new user turn
	relax?: boolean; // default RELAX_PREV_TURN
	minGain?: number;
	inturnAge?: number; // default settings().inturnAge (PI_ZIP_INTURN_AGE, 60); 0 = outputs of the protected turns never fold on age
	noSummary?: boolean; // a summary was already made while this cache stayed warm: no second one unless the context is at/above the compaction room
	rereadOnly?: boolean; // zip_recall is not available to the model: fold only outputs that can be re-read (classify "rereadable")
	fileRecall?: FileRecall; // zip_recall is hidden but read, grep or bash is active: fold as in full mode, placeholders name the recall file
	pastTtl?: boolean; // a user return after the declared TTL: a warm plan may relax into the previous user turn too (RELAX_PREV_TURN)
	warmSummaryGate?: boolean; // F1, default WARM_SUMMARY_GATE
	lookahead?: boolean; // F2, default LOOKAHEAD (cold plans only)
	narrativePrice?: boolean; // F3, default NARRATIVE_PRICE
	slide?: number; // internal (F2): plan as if this many more user turns had started (the protected window slid)
	valveB?: number; // internal (F2): the real context the slid warm plan's law sees (the cold plan's folds already applied)
	hold?: { anchor: string }; // B2 for folds: the entry id of the prompt of the last cold return (run.ts holdOf); undefined = nothing held
	holdPass?: boolean; // internal: the held pass of a warm plan with a hold
	warmStyle?: boolean; // internal: a cold plan at 0 < P(warm) < 0.5 that the law refused is planned once more the way a warm plan is (no relax folds unless pastTtl, the summary gated)
}

export interface PlanResult {
	blocks: Block[];
	calls: Calls;
	folds: FoldTarget[];
	cutIdx: number | null;
	firstKeptEntryId: string | null;
	prefixTokens: number; // content estimate units (x c = real), like summaryTokensPlanned
	summaryTokensPlanned: number;
	sumTrigger: "cold" | "valve" | null;
	scale: Scale;
	ctxTokens: number; // real: O + c x content
	ctxAfterFolds: number; // real
	userTurns: number;
	cutVisibleIdx: number;
	cutKeptFirstMsg: Any;
	fileRecall?: FileRecall; // the summary of this plan names recall files instead of zip_recall (PlanOpts.fileRecall)
	ahead?: boolean; // F2: the cut was decided by the lookahead (it may lie inside the previous user turn, before its final answer)
}

/** Index of the final assistant message of user turn `turn` (the answer the user saw), -1 if none. */
export function finalAnswerIdx(blocks: Block[], turn: number): number {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i];
		if (b.userTurn < turn) break;
		if (b.userTurn === turn && b.kind === "assistant" && b.entryId && b.msg?.stopReason !== "error" && b.msg?.stopReason !== "aborted") return i;
	}
	return -1;
}

/** Estimated content before the earliest edited block: what stays cached through the edit with O (real: O + c x it). A cut edits from the start. */
export function untouchedEst(blocks: Block[], folds: FoldTarget[], cut: boolean): number {
	const ids = new Set(folds.map((t) => t.entryId));
	let est = 0;
	if (!cut) for (const b of blocks) { if (b.entryId && ids.has(b.entryId)) break; est += b.tokens; }
	return est;
}

/** Identity of a tool result's text, independent of its tool call id. */
export const contentKeyOf = (content: Any): string => {
	const t = textOf(content);
	return `${createHash("sha1").update(t).digest("hex")}:${t.length}`;
};

/** The planner. Cold: fold everything outside the protected window, relax into the previous turn if still above the cap,
 *  summarise only if folds cannot reach the cap and the law prices the summary call in. Warm: null unless the context is above the
 *  cold cap and the law fires for the plan; its summary passes the same summary gate (WARM_SUMMARY_GATE); then the cold plan minus the previous-turn relax (a warm plan
 *  folds the previous user turn by relax only at a return after the declared TTL, o.pastTtl). A cold plan with P(warm) > 0
 *  passes the same law (expected cost). The cap never exceeds Pi's compaction room. Returns null when there is nothing to plan on
 *  or the law says no. */
export function planContext(entries: Any[], o: PlanOpts): PlanResult | null {
	if (o.hold && !o.holdPass && (o.mode ?? "cold") === "warm") {
		// the hold gives way to a summary: when the plan without it summarises, that is the plan (a summary voids the folds before its
		// cut anyway); otherwise the held plan, with no summary of its own (the next cold return writes it)
		const full = planContext(entries, { ...o, hold: undefined, trace: undefined });
		if (!full) return null;
		if (full.cutIdx !== null) return planContext(entries, { ...o, hold: undefined });
		return planContext(entries, { ...o, noSummary: true, holdPass: true });
	}
	const s = settings();
	const mode = o.mode ?? "cold";
	const warmLike = mode === "warm" || o.warmStyle === true; // plans the way a warm plan does (the label of the trigger stays the mode's)
	// limits are in real tokens; the plan works in content estimate units (real = O + c x estimate), so they are converted once, here.
	// The cold cap is on the whole context, but leaves at least half of itself for the conversation above O (coldTarget): a cap the
	// fixed prefix alone fills is out of reach, and every cold return then folds all it may and summarises. The compaction room is
	// Pi's trigger on the whole context.
	const { O, c } = o.scale ?? UNIT;
	const real = (est: number) => O + c * est;
	const room = compactionRoom(o.model, o.reserve);
	const coldCap = (coldTarget(o.coldCap ?? s.coldCap, O, room) - O) / c;
	const law: Law = o.law ?? { pr: null, g: G0, pWarm: mode === "cold" ? 0 : 1 };
	// `cut`: a whole-plan step records whether the plan it judges has a cut (and so carries its summary call); the formal checker pins the
	// call to 0 for a folds-only plan and to the summary step's call for a cut
	const gate = (where: "summary" | "plan", B: number, A: number, r: number | null, call: number, T: number, Tsuf?: number, cut?: boolean): boolean => {
		const t = lawTerms(B, A, law.pWarm, r, law.pr, law.g, call, T);
		o.trace?.push({ where, ...t, ...(Tsuf !== undefined ? { Tsuf } : {}), ...(cut !== undefined ? { cut } : {}) });
		return t.ok;
	};
	const minGain = o.minGain ?? s.minGain;
	const foldMin = o.foldMin ?? s.foldMin;
	const keepLines = o.keepLines ?? s.keepLines;
	const relax = o.relax ?? RELAX_PREV_TURN;
	const inturnAge = o.inturnAge ?? s.inturnAge;
	const blocks = buildBlocks(entries, o.steerIds);
	if (!blocks.length) return null;
	const userTurns = countUserTurns(blocks) + (o.promptPending ? 1 : 0) + (o.slide ?? 0); // the upcoming prompt is a new user turn
	const f1 = o.warmSummaryGate ?? WARM_SUMMARY_GATE, f2 = mode === "cold" && !o.warmStyle && (o.lookahead ?? LOOKAHEAD), f3 = o.narrativePrice ?? NARRATIVE_PRICE;
	const calls = toolCallIndex(blocks);
	const recalled = o.recalled ?? new Set<string>();
	const ctxEst = blocks.reduce((a, b) => a + b.tokens, 0); // content
	if (warmLike && !(ctxEst > coldCap)) return null; // I6: warm cache below the cold cap -> never edit
	const trig = mode === "warm" ? "valve" : "cold";
	const tokOverride = new Map<number, number>();
	const folds: FoldTarget[] = [];
	const visOfBlock: number[] = []; // block idx -> index among the non-system projected messages (the numbering a request view uses)
	{
		let vis = 0;
		for (const pe of entries) {
			const msgs: Any[] = pe.messages ?? [];
			if (!msgs.length) continue;
			visOfBlock.push(vis);
			for (const m of msgs) if (String(m?.role ?? "") !== "system") vis++;
		}
	}
	const classify = (b: Block): Recover => {
		const call = calls.get(b.msg.toolCallId);
		return classifyRecoverability(call?.name ?? b.msg.toolName ?? "", call?.args, textOf((b.raw ?? b.msg).content), o.cwd);
	};
	const addFold = (b: Block, trig: string): boolean => {
		if (tokOverride.has(b.idx) || recalled.has(handleFor(b.entryId!))) return false; // F4: never refold what the model recalled
		const ph = makePlaceholderFor(b, calls, keepLines, !!o.rereadOnly, o.fileRecall);
		if (ph === null) return false;
		const phTok = tokensOf({ ...b.msg, content: [{ type: "text", text: ph }] }); // the folded message: its id and framing stay
		if (!(phTok < 0.9 * b.tokens)) return false;
		tokOverride.set(b.idx, phTok);
		const call = calls.get(b.msg.toolCallId);
		folds.push({ entryId: b.entryId!, toolCallId: b.msg.toolCallId, visIdx: visOfBlock[b.idx] ?? -1, contentKey: contentKeyOf(b.msg.content), tool: call?.name ?? b.msg.toolName ?? "tool", args: call ? shortArgs(call.args) : "", entryTokens: b.tokens, phTokens: phTok, ph, trig, recover: classify(b) });
		return true;
	};
	// a zip_recall result IS content the model just asked for: folding it would undo the recall (and loop); never
	// ... and so is a built-in read, grep, find, ls or bash call on a recall file (file recall, when an allowlist hides zip_recall)
	const isRecall = (b: Block) => {
		const call = calls.get(b.msg.toolCallId), name = call?.name ?? b.msg.toolName;
		if (name === RECALL_TOOL) return true;
		if (name === "bash") return commandNamesRecall(call?.args?.command);
		return (name === "read" || name === "grep" || name === "find" || name === "ls") && !!parseRecallPath(call?.args?.path);
	};
	// Observability: on an automatic (prefix) cache no fold starts inside the first MIN_EXPECT real tokens, so the next response's cacheRead
	// is an uncensored survival sample (learn.ts sample). Without it every idle return folded into the first 1-7K tokens and its sample was
	// censored, so the learned curve never saw a return (live GLM bench). Explicit caches are exempt: the provider looks back only ~20
	// blocks from the last breakpoint, a far head is not read either way. A cut replaces the prefix from the first message: exempt too.
	const head = law.pr?.cls === "automatic" ? (MIN_EXPECT - O) / c : 0; // MIN_EXPECT counts from the first token, O included
	const start: number[] = [];
	blocks.reduce((acc, b) => ((start[b.idx] = acc), acc + b.tokens), 0);
	const foldable = (b: Block) => b.kind === "toolResult" && !b.edited && !!b.entryId && b.tokens > foldMin && !isRecall(b) && start[b.idx] >= head && (!o.rereadOnly || classify(b) === "rereadable");
	const protectedTurn = (b: Block) => b.userTurn >= userTurns - PROTECT_USER_TURNS + 1;
	const savings = () => folds.reduce((a, t) => a + t.entryTokens - t.phTokens, 0);
	// the blocks protected at the last cold return stay out of a warm plan's folds (see FOLD_HOLD)
	const held: (b: Block) => boolean = (() => {
		const NOT_HELD = () => false;
		if (mode !== "warm" || !o.hold) return NOT_HELD;
		const from = blocks.findIndex((b) => b.entryId === o.hold!.anchor); // gone (a later summary replaced it): nothing is held
		if (from < 0) return NOT_HELD;
		// what the session grew by before this decision: the blocks between the cold return's prompt and the newest response (that
		// response, the tool results after it and a new prompt are what the decision is about, not yet something the cache has seen)
		let lastAsst = blocks.length - 1;
		while (lastAsst > 0 && blocks[lastAsst].kind !== "assistant") lastAsst--;
		const grown = c * blocks.slice(from + 1, Math.max(from + 1, lastAsst)).reduce((a, b) => a + b.tokens, 0);
		if (grown > HOLD_RELEASE || (room !== null && real(ctxEst) >= room)) return NOT_HELD;
		const turn = blocks[from].userTurn;
		return (b: Block) => b.userTurn >= turn - PROTECT_USER_TURNS + 1;
	})();
	const cands = blocks.filter((b) => foldable(b) && !protectedTurn(b) && !held(b));
	for (const b of cands) addFold(b, trig);
	if (relax && ((mode === "cold" && !o.warmStyle) || o.pastTtl === true)) {
		// the protected window = the new prompt + the previous user turn; that turn's big reads are what makes a cold return
		// expensive. Rereadable ones can be recalled exactly: fold them biggest-first until the cap; never the latest turn's own.
		// Cold plans, and warm plans at a return after the declared TTL; any other warm plan keeps the previous user turn visible.
		let est = ctxEst - savings();
		if (est > coldCap) {
			const prev = blocks.filter((b) => foldable(b) && protectedTurn(b) && b.userTurn < userTurns && classify(b) === "rereadable");
			for (const b of prev.sort((x, y) => y.tokens - x.tokens)) {
				if (est <= coldCap) break;
				if (addFold(b, `${trig}(relax)`)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
			}
		}
	}
	if (inturnAge > 0) {
		// in-turn: a protected turn (the new prompt's, the previous one, or the one a mid-run cold return / valve is inside) still holds
		// outputs that are many requests old; they fold biggest-first until the cap, whatever their recoverability class (every fold
		// stays recallable). Age = assistant requests since the call was issued (the newest outputs, age < inturnAge, always stay).
		let est = ctxEst - savings();
		if (est > coldCap) {
			const aged = blocks.filter((b) => foldable(b) && protectedTurn(b) && b.age >= inturnAge);
			for (const b of aged.sort((x, y) => y.tokens - x.tokens)) {
				if (est <= coldCap) break;
				if (addFold(b, `${trig}(inturn)`)) est -= b.tokens - (tokOverride.get(b.idx) ?? 0);
			}
		}
	}
	let ctxAfterFolds = ctxEst - savings();
	// what no summary can remove (besides O): the protected turns (after their folds) and the previous summary, which the next one
	// carries forward; the cap is never chased below it (a context that is mostly this floor would be re-summarised for nothing)
	const prevSum = blocks[0]?.kind === "summary" ? blocks[0].tokens : 0;
	const floor = prevSum + blocks.reduce((a, b) => a + (protectedTurn(b) ? (tokOverride.get(b.idx) ?? b.tokens) : 0), 0);
	const target = Math.max(coldCap, floor + SUMMARY_FLOOR);
	const atRoom = room !== null && real(ctxAfterFolds) >= room;
	const sumTrigger: "cold" | "valve" | null = ctxAfterFolds > target && (!o.noSummary || atRoom) ? trig : null;
	let cutIdx: number | null = null;
	let prefixTokens = 0;
	let summaryTokensPlanned = 0;
	let ahead = false;
	const minCut = blocks[0].kind === "summary" ? 2 : 1; // never re-summarise a prefix that is only the previous summary
	const pre: number[] = [];
	const S = (x: number) => Math.max(clamp(SUMMARY_RATIO * x, SUMMARY_FLOOR, SUMMARY_CAP), prevSum); // the next summary carries the previous one forward
	// Block index of every fold: the folds a cut voids are those before it
	const foldAt = folds.map((t) => blocks.findIndex((b) => b.entryId === t.entryId));
	/** The whole plan's law (F10): B is the context as it is (or as the slid valve saw it), A what the plan leaves, `call` the summary call
	 *  a cut makes; `untouched` is the content before the earliest edit (ledger only). A cold plan with some chance of a warm cache is
	 *  priced by expectation (no prices: a cold plan always fires). T = A (the whole post-edit context, O included, as tuned: the cheaper
	 *  A - O fires warm edits earlier and loses items offline). */
	const planGate = (after: number, untouched: number, call: number, planned: boolean, cut: boolean): boolean =>
		!(warmLike || (planned && law.pr)) || gate("plan", Math.max(o.valveB ?? real(ctxEst), real(after)), real(after), room, call, real(after), c * (after - untouched), cut);
	/** The cut for cut points minCut..maxCut: the first that brings the context to the cap, else the deepest; gated = the summary law
	 *  (no prices: the legacy gain rule) must pass. When the minimal cut's summary or the whole plan with it is refused, the deeper cuts
	 *  are tried in turn (the gain grows as D^2, the call only with the prefix read). The whole plan's law prices the summary call too.
	 *  Applies the first cut both laws accept (folds in the prefix are void) and returns true, or changes nothing. */
	const summarise = (maxCut: number, gated: boolean): boolean => {
		const cuts: number[] = [];
		for (let i = minCut; i < blocks.length && i <= maxCut; i++) if (blocks[i].entryId && (blocks[i].kind === "user" || blocks[i].kind === "assistant")) cuts.push(i);
		if (!cuts.length) return false;
		let acc = 0;
		for (let i = 0; i < blocks.length; i++) {
			pre[i] = acc;
			acc += tokOverride.get(i) ?? blocks[i].tokens;
		}
		const total = acc;
		let first = cuts.length - 1;
		for (let k = 0; k < cuts.length; k++) if (total - pre[cuts[k]] + S(pre[cuts[k]]) <= coldCap) { first = k; break; }
		for (const pick of cuts.slice(first)) {
			const X = c * pre[pick], Sr = c * S(pre[pick]);
			// the call is the narrative call summary.ts makes (F3, NARRATIVE_PRICE): uncached input of the prefix without the previous
			// summary, which it never reads, + output of at most the narrative budget; without F3 the verdict's w X + out S (the carried
			// summary as output)
			const call = !law.pr ? 0 : f3 ? law.pr.input * c * Math.max(pre[pick] - prevSum, 0) + law.pr.out * c * Math.min(S(pre[pick]), NARRATIVE_MAX) : law.pr.w * X + law.pr.out * Sr;
			if (gated) {
				// the summary call must pay for itself, cold or warm (F1, WARM_SUMMARY_GATE; before, a warm plan skipped the gate)
				const ok = !law.pr ? summaryGainOk(X, Sr, real(total), minGain) : (warmLike && !f1) || gate("summary", X, Sr, null, call, Sr);
				if (!ok) continue;
			}
			if (!(pre[pick] >= 2 * S(pre[pick]))) continue;
			// what the plan leaves: the context with its folds (those inside the prefix too: the prefix is measured as folded, `pre`) minus
			// what the summary replaces plus the summary. (Counting the voided folds' savings back, as before, overstated it by them.)
			if (!planGate(ctxAfterFolds - (pre[pick] - S(pre[pick])), 0, call, true, true)) continue;
			cutIdx = pick;
			prefixTokens = pre[pick];
			summaryTokensPlanned = S(pre[pick]);
			for (let i = folds.length - 1; i >= 0; i--) if (foldAt[i] < pick) { tokOverride.delete(foldAt[i]); folds.splice(i, 1); foldAt.splice(i, 1); } // the prefix is replaced: its folds are void
			return true;
		}
		return false;
	};
	if (sumTrigger) {
		const limit = blocks.findIndex((b) => protectedTurn(b));
		summarise(limit >= 0 ? limit : blocks.length - 1, true);
	}
	if (f2 && cutIdx === null && law.pr && ctxAfterFolds > coldCap && (!o.noSummary || atRoom)) {
		// F2 lookahead: the warm valve's plan at the next user turn (this context, its folds applied, the window slid by one turn). If it
		// would summarise, the summary is written now, at the cold return, where the rewrite costs nothing extra (and at settle it is
		// prepared while the user is away), instead of one turn later as a warm rewrite the user waits for.
		const next = planContext(entries, { ...o, mode: "warm", slide: (o.slide ?? 0) + 1, lookahead: false, pastTtl: false, noSummary: false, trace: undefined, law: { ...law, pWarm: 1 }, valveB: real(ctxAfterFolds) });
		const fa = finalAnswerIdx(blocks, userTurns - 1);
		if (next && next.cutIdx !== null && fa >= minCut && summarise(fa, false)) ahead = true;
	}
	// where the kept part starts among the projected non-system messages (the request-local view drops everything before it)
	let cutVisibleIdx = -1;
	let cutKeptFirstMsg: Any;
	if (cutIdx !== null) {
		let vis = 0;
		let bi = 0;
		for (const pe of entries) {
			const msgs: Any[] = pe.messages ?? [];
			if (!msgs.length) continue;
			for (const m of msgs) {
				if (String(m?.role ?? "") === "system") continue;
				if (bi === cutIdx && cutVisibleIdx < 0) { cutVisibleIdx = vis; cutKeptFirstMsg = m; }
				vis++;
			}
			bi++;
		}
	}
	// the untouched prefix: everything before the earliest edited block (a cut edits from the first block on)
	const untouched = untouchedEst(blocks, folds, cutIdx !== null);
	const after = ctxAfterFolds - (cutIdx !== null ? prefixTokens - summaryTokensPlanned : 0);
	const planned = folds.length > 0 || cutIdx !== null;
	// a plan with a cut passed the whole plan's law with its call inside summarise; folds only (no summary wanted, or none the laws
	// accepted: the deeper cuts and the cut-free plan both stand) is judged here
	if (cutIdx === null && !planGate(after, untouched, 0, planned, false)) {
		// a cold plan with some chance of a warm cache: the plan a warm cache would make may pay where this one does not
		if (mode === "cold" && !o.warmStyle && law.pr && law.pWarm > 0 && law.pWarm < 0.5) return planContext(entries, { ...o, warmStyle: true });
		return null;
	}
	return { blocks, calls, folds, cutIdx, firstKeptEntryId: cutIdx !== null ? blocks[cutIdx].entryId : null, prefixTokens, summaryTokensPlanned, sumTrigger: cutIdx !== null ? (sumTrigger ?? trig) : sumTrigger, scale: o.scale ?? UNIT, ctxTokens: real(ctxEst), ctxAfterFolds: real(ctxAfterFolds), userTurns, cutVisibleIdx, cutKeptFirstMsg, ...(o.fileRecall ? { fileRecall: o.fileRecall } : {}), ...(ahead ? { ahead } : {}) };
}

const sameMsg = (a: Any, b: Any): boolean =>
	!!a && !!b && String(a?.role ?? "") === String(b?.role ?? "") && JSON.stringify(a?.content ?? "") === JSON.stringify(b?.content ?? "");

const isSystem = (m: Any) => String(m?.role ?? "") === "system";

/**
 * Replay every system message into the one leading message Pi puts at the head of a compacted projection
 * (same rules as pi-ai getCurrentSystemMessage; the integration test checks the two agree).
 */
export function collapseSystem(messages: Any[]): Any | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, Any>();
	let timestamp: number | undefined;
	for (const m of messages) {
		if (!isSystem(m)) continue;
		timestamp ??= m.timestamp;
		const text = textOf(m.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(m.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value as string);
		}
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
	}
	if (timestamp === undefined && tools.size === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
		timestamp: timestamp ?? 0,
	};
}

/**
 * Request-local view of a plan over the COMPLETE transcript (the `context_with_system` form): fold targets are replaced
 * in place, system messages stay exactly where they are (so the request is byte-identical before and after turn_end
 * persists the same edits, I1). With a cut, the view is what Pi projects after the compaction: the replayed system
 * message, the summary, then the kept non-system messages. null = nothing to apply. A cut whose kept boundary cannot be
 * located is dropped (folds still apply); an inconsistent split is never sent.
 */
/** Fold targets of a plan made on the view before a native compaction, renumbered for the request Pi builds after it: Pi's summary
 *  message first, then the kept part (positions among the non-system messages, as in applyPlanToMessages). */
export const rebaseFolds = (folds: FoldTarget[], cutVisibleIdx: number): FoldTarget[] =>
	folds.map((t) => ({ ...t, visIdx: t.visIdx >= 0 && cutVisibleIdx >= 0 && t.visIdx >= cutVisibleIdx ? t.visIdx - cutVisibleIdx + 1 : -1 }));

export function applyPlanToMessages(messages: Any[], plan: RunPlan | null): { messages: Any[]; droppedCut: boolean; applied: Set<string> } | null {
	if (!plan || plan.persisted || (!plan.folds.length && !plan.cut)) return null;
	const vis: number[] = []; // indices of the non-system messages
	messages.forEach((m, i) => { if (!isSystem(m)) vis.push(i); });
	let cutAt = -1; // index into `messages`
	let droppedCut = false;
	if (plan.cut) {
		const v = plan.cutVisibleIdx ?? -1;
		cutAt = v >= 0 && v < vis.length ? vis[v] : -1;
		if (cutAt < 0 || !sameMsg(messages[cutAt], plan.cutKeptFirstMsg)) {
			plan.cut = null;
			cutAt = -1;
			droppedCut = true;
		}
	}
	// match each result to its target: by position when the position still holds the same result, else by (call id, content) when that is unique
	const used = new Set<FoldTarget>();
	const applied = new Set<string>();
	const byKey = new Map<string, FoldTarget[]>();
	const key = (id: string, ck: string) => `${id}|${ck}`;
	for (const t of plan.folds) {
		const k = key(t.toolCallId, t.contentKey);
		byKey.set(k, [...(byKey.get(k) ?? []), t]);
	}
	const seenKey = new Map<string, number>(); // how many results in THIS request carry each (id, content): more than one = ambiguous
	for (const m of messages) {
		if (m?.role !== "toolResult" || !byKey.has(key(m.toolCallId, contentKeyOf(m.content)))) continue;
		const k = key(m.toolCallId, contentKeyOf(m.content));
		seenKey.set(k, (seenKey.get(k) ?? 0) + 1);
	}
	const byPos = new Map<number, FoldTarget>();
	for (const t of plan.folds) if (t.visIdx >= 0) byPos.set(t.visIdx, t);
	let changed = false;
	let v = -1;
	const folded = messages.map((m: Any, i: number) => {
		if (isSystem(m)) return m;
		v++;
		if (cutAt >= 0 && i < cutAt) return m; // replaced by the compaction message below
		if (m?.role !== "toolResult" || textOf(m.content).startsWith(PH_MARK)) return m; // not ours, or the persisted edit already folded it
		const ck = contentKeyOf(m.content);
		let t = byPos.get(v);
		if (!t || used.has(t) || t.toolCallId !== m.toolCallId || t.contentKey !== ck) {
			const k = key(m.toolCallId, ck);
			const c = byKey.get(k);
			t = c && c.length === 1 && seenKey.get(k) === 1 && !used.has(c[0]) ? c[0] : undefined;
		}
		if (!t) return m;
		used.add(t);
		applied.add(t.entryId);
		changed = true;
		return { ...m, content: [{ type: "text", text: t.ph }] };
	});
	if (cutAt >= 0) {
		const c = plan.cut!;
		const head = collapseSystem(messages);
		const kept = folded.slice(cutAt).filter((m: Any) => !isSystem(m));
		return { messages: [...(head ? [head] : []), { role: "compactionSummary", summary: c.text, tokensBefore: c.prefixTokens, timestamp: plan.cutTs ??= Date.now() }, ...kept], droppedCut, applied };
	}
	return changed || droppedCut ? { messages: folded, droppedCut, applied } : null;
}

export { pickKeyLines };
