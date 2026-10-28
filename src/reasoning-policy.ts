import type { Any } from "./util.ts";

/**
 * A request that names no reasoning effort still reasons at the provider's default effort. Pi otherwise sends the model's "off" effort.
 * The exceptions: a thinking-level map that says off is impossible (`off: null`), and GitHub Copilot on the Responses API, where pi-ai
 * sends no effort at all.
 */
export function reasonsByDefault(model: Any): boolean {
	return !!model?.reasoning && (model.thinkingLevelMap?.off === null || (model.provider === "github-copilot" && model.api === "openai-responses"));
}
