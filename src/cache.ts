// Cache temperature (F7): "cold" is a fact about real time, never a guess.
import { type Any, PRODUCT, envInt } from "./util.ts";

/** The cache lifetimes a request can ask for (Pi's tiers): the short one, and the 1-hour one (`PI_CACHE_RETENTION=long`, an Anthropic
 *  `cache_control` ttl of 1h, OpenAI's prompt_cache_retention). No per-model table: pi-zip uses the lifetime the request asks for, and
 *  learns how long the provider really keeps it (learn.ts). */
export const SHORT_TTL_MS = 300_000;
export const LONG_TTL_MS = 3_600_000;

/** An assistant message that really ran (errors and aborts may never have reached a cache). */
const ran = (m: Any): boolean => m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && !!m.provider;

/**
 * TTL tier the provider really wrote, from the newest <=3 usable assistant messages of this model (real run, cacheWrite >= MIN_WRITE):
 * `usage.cacheWrite1h` (Anthropic, Bedrock) is the 1h share of `cacheWrite`. >= 50% -> "1h", ~0 -> "5m". The field absent (the API
 * does not report it) or a split in between = no evidence (undefined): the declared TTL stands. Relays may rewrite cache_control.
 */
const MIN_WRITE = 1024;
export function observedTier(branch: Any[], key: string): "1h" | "5m" | undefined {
	let w = 0, w1h = 0, seen = 0;
	for (let i = branch.length - 1; i >= 0 && seen < 3; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (!ran(m) || `${m.provider}/${m.model ?? ""}` !== key) continue;
		const u = m.usage;
		if (!(u?.cacheWrite >= MIN_WRITE)) continue;
		seen++;
		if (typeof u.cacheWrite1h === "number") (w += u.cacheWrite), (w1h += u.cacheWrite1h);
	}
	return !w ? undefined : w1h >= w / 2 ? "1h" : w1h < w * 0.05 ? "5m" : undefined;
}

export interface TtlInfo { ms: number; source: "declared" | "observed"; note?: string }

/** The cache tier a request asked for, read from the payload Pi built (null: the payload does not say). Anthropic: a 1-hour
 *  cache_control ttl is the long tier, cache_control without one the short tier; OpenAI: prompt_cache_retention "24h" is long. */
export function payloadRetention(p: Any): "short" | "long" | null {
	if (!p || typeof p !== "object") return null;
	if (typeof p.prompt_cache_retention === "string") return p.prompt_cache_retention === "24h" ? "long" : "short";
	const msgs: Any[] = Array.isArray(p.messages) ? p.messages : [];
	const marks = [p.system, p.tools, msgs, ...msgs.map((m) => m?.content)].flatMap((l) => (Array.isArray(l) ? l : [])).map((b) => b?.cache_control).filter((cc) => cc && typeof cc === "object");
	return marks.some((cc) => cc.ttl === "1h") ? "long" : marks.length ? "short" : null;
}

/** The lifetime the request asks for (its tier: the provider-scoped PI_CACHE_RETENTION or the request payload itself, run.ts; without
 *  one the process environment decides), corrected by the tier the provider was seen to write. PI_ZIP_TTL_SECS wins (tests). `note`
 *  = the one-time mismatch notice text. */
export function resolveTtl(model: Any, branch: Any[] = [], tier?: "short" | "long"): TtlInfo {
	if (process.env.PI_ZIP_TTL_SECS) return { ms: envInt("TTL_SECS", 300) * 1000, source: "declared" };
	const long = tier ? tier === "long" : process.env.PI_CACHE_RETENTION === "long";
	const seen = observedTier(branch, modelKey(model));
	const mismatch = (req: string, got: string, ms: number): TtlInfo => ({ ms, source: "observed", note: `${PRODUCT} · requested ${req} prompt cache, provider wrote ${got} · using ${got}` });
	if (long && seen === "5m") return mismatch("1h", "5m", SHORT_TTL_MS);
	if (!long && seen === "1h") return mismatch("5m", "1h", LONG_TTL_MS);
	return { ms: long ? LONG_TTL_MS : SHORT_TTL_MS, source: "declared" };
}

export const ttlFor = (model: Any, branch: Any[] = [], tier?: "short" | "long"): number => resolveTtl(model, branch, tier).ms;

/** Cold = a prior request exists and nothing touched the cache for longer than the TTL. No prior request counts as warm. */
export const isColdByTtl = (lastActivityMs: number, nowMs: number, ttlMs: number): boolean => lastActivityMs > 0 && nowMs - lastActivityMs > ttlMs;

export const modelKey = (m: Any): string => (m ? `${m.provider ?? ""}/${m.id ?? m.model ?? ""}` : "");

const tsOf = (en: Any, inner?: Any): number => {
	const t = typeof inner?.timestamp === "number" ? inner.timestamp : Date.parse(en?.timestamp ?? "");
	return Number.isFinite(t) ? t : 0;
};

/** A response that reached no cache: an error that reports no usage (the provider refused the request). One that reports usage was
 *  read: it touched the cache. An abort (Esc) comes after the provider read and wrote the prompt: it is a touch, with or without usage. */
export const refused = (m: Any): boolean => {
	if (m?.role !== "assistant" || m.stopReason !== "error") return false;
	const u = m.usage;
	return !((Number(u?.input) || 0) + (Number(u?.cacheRead) || 0) + (Number(u?.cacheWrite) || 0) > 0);
};

/** A usage entry of any kind (pi-aside's "aside", say) whose read covers the cacheable prefix (cacheRead + cacheWrite) of `m`, the newest
 *  response that ran before it, on m's provider and model (the one that answered, as Pi names it): it refreshed m's cache entry. */
const readPrefix = (en: Any, m: Any): boolean => {
	const prefix = (Number(m?.usage?.cacheRead) || 0) + (Number(m?.usage?.cacheWrite) || 0);
	return prefix > 0 && (Number(en.usage?.cacheRead) || 0) >= prefix && en.provider === m.provider && (en.model === m.model || en.model === m.responseModel);
};

/**
 * Last time anything touched the cache, according to the branch: the newest message, a cache-warm usage entry (Pi's own idle refresh
 * persists `{ type: "usage", kind: "cache_warm" }`; read or rewritten, the entry lives another TTL), or any other usage entry that
 * read the whole prefix (readPrefix). A request the provider refused (an error with no usage) touched nothing, and neither did the
 * messages that made it (the prompt or the tool results it carried, written before it failed): the clock stays at the last request
 * that was read. Fresh process: err on the warm side (0 = unknown).
 */
export function lastMessageMs(branch: Any[]): number {
	let last = 0, pending = 0, resp: Any = null; // pending: the newest non-assistant message since the last response, counted once its response is known
	for (const en of branch) {
		if (en?.type === "message" && en.message) {
			const t = tsOf(en, en.message);
			if (en.message.role === "assistant") {
				if (!refused(en.message)) last = Math.max(last, pending, t);
				if (ran(en.message)) resp = en.message;
				pending = 0;
			} else pending = Math.max(pending, t);
		} else if (en?.type === "usage" && (en.kind === "cache_warm" || readPrefix(en, resp))) last = Math.max(last, tsOf(en));
	}
	return Math.max(last, pending); // trailing messages with no response yet (the run in progress) count, as before
}

/** The newest assistant message that really ran: its provider/model and prompt size. */
export function lastPrompt(branch: Any[]): { key: string; total: number } {
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (ran(m)) {
			const u = m.usage;
			return { key: `${m.provider}/${m.model ?? ""}`, total: u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0 };
		}
	}
	return { key: "", total: 0 };
}

export type Survival = (gapS: number, priorS: number) => { p: number; src: string };
/** pause: the absence outlived the lifetime the requests ask for (gap >= TTL), or the model changed: a fact about the user, whatever
 *  the learned P(warm) says (the previous user turn's re-readable outputs may fold: plan.ts PlanOpts.pause). */
export interface ColdInfo { cold: boolean; reason: string; ttl: TtlInfo; pWarm: number; src: string; gapS: number | null; pause: boolean }

/** Cold by time, or because the model changed: a cache entry belongs to one provider and model. `learned` = P(warm) after a gap from the
 *  survival the provider was seen to have (learn.ts); without it, or under PI_ZIP_TTL_SECS (tests), the TTL decides. cold = P(warm) < 0.5.
 *  No request before (a new session): P = 0, no pause (nothing is cached, and there was no absence). */
export function detectCold(model: Any, lastReqMs: number, branch: Any[], nowMs = Date.now(), lastModel = "", learned?: Survival, tier?: "short" | "long"): ColdInfo {
	const ttl = resolveTtl(model, branch, tier);
	const last = Math.max(lastReqMs, lastMessageMs(branch));
	const prev = lastModel || lastPrompt(branch).key;
	// a request that went out, even one the provider refused, was made on another model: the new model's cache is not that one
	if (prev && modelKey(model) && prev !== modelKey(model)) return { cold: true, reason: `model switch ${prev} -> ${modelKey(model)}`, ttl, pWarm: 0, src: "model switch", gapS: null, pause: last > 0 && nowMs - last >= ttl.ms };
	if (!last) return { cold: true, reason: "no prior request", ttl, pWarm: 0, src: "no prior request", gapS: null, pause: false };
	const gapS = (nowMs - last) / 1000;
	const byTtl = isColdByTtl(last, nowMs, ttl.ms);
	const s = learned && !process.env.PI_ZIP_TTL_SECS ? learned(gapS, ttl.ms / 1000) : { p: byTtl ? 0 : 1, src: "prior" };
	const reason = `ttl gap ${Math.round(gapS)}s ${byTtl ? ">" : "<="} ${Math.round(ttl.ms / 1000)}s${s.src === "prior" ? "" : `, learned P(warm) ${s.p.toFixed(2)}`}`;
	return { cold: s.p < 0.5, reason, ttl, pWarm: s.p, src: s.src, gapS, pause: nowMs - last >= ttl.ms };
}
