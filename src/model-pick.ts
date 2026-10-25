// Which model a background call runs on, shared by the judge and the retrieval assistant: the same `provider/id[:level]`
// configuration (PI_ZIP_JUDGE_MODEL), the same thinking-level clamping, no separate setting per feature.
import { reasonsByDefault, type Any } from "./util.ts";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Levels the model advertises. Null means the host gave no capability metadata: keep the provider default. */
export function supportedThinking(model: Any, registry?: Any): readonly string[] | null {
	if (typeof registry?.getSupportedThinkingLevels === "function") {
		const levels = registry.getSupportedThinkingLevels(model);
		return Array.isArray(levels) && levels.every((l: unknown) => typeof l === "string") && levels.length ? levels : null;
	}
	if (model?.reasoning === false) return ["off"];
	if (model?.reasoning !== true && !model?.thinkingLevelMap) return null;
	return LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * An explicit level is clamped through host metadata. With no explicit level, no level is sent, except to a model that reasons by default
 * (reasonsByDefault): it gets its lowest supported level above off. Its provider default effort made a 12-13K-token judge call reason
 * 2,500-3,000 tokens and take 34-43 s (GitHub Copilot gpt-6-luna); "low" took 7-9 s and labelled every handle.
 */
export function reasoningFor(model: Any, requested: string | undefined, registry?: Any): string | undefined {
	const levels = supportedThinking(model, registry);
	if (!levels) return undefined;
	if (!requested) {
		if (!reasonsByDefault(model)) return undefined;
		requested = LEVELS.find((l) => l !== "off" && (levels as readonly string[]).includes(l));
		if (!requested) return undefined;
	}
	const clamp = (level: string): string => {
		if (typeof registry?.clampThinkingLevel === "function") return registry.clampThinkingLevel(model, level);
		if ((levels as readonly string[]).includes(level)) return level;
		const at = LEVELS.indexOf(level as (typeof LEVELS)[number]);
		if (at < 0) return levels[0];
		for (let i = at; i < LEVELS.length; i++) if ((levels as readonly string[]).includes(LEVELS[i])) return LEVELS[i];
		for (let i = at - 1; i >= 0; i--) if ((levels as readonly string[]).includes(LEVELS[i])) return LEVELS[i];
		return levels[0];
	};
	return clamp(requested);
}

/** `provider/id` or `provider/id:level`, as Pi's --model. An id that itself contains ":" matches whole first. */
export function modelRef(raw: string | undefined, available: readonly Any[]): { ref: string; level?: string } | undefined {
	if (!raw) return undefined;
	const at = raw.lastIndexOf(":"), level = raw.slice(at + 1);
	if (at < 0 || !(LEVELS as readonly string[]).includes(level) || available.some((m) => `${m.provider}/${m.id}` === raw)) return { ref: raw };
	return { ref: raw.slice(0, at), level };
}
