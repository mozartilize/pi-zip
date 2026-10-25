// Recall handles: deterministic in the session entry id. No other pi-zip import, so the ledger can use them without the folding stack.
import { createHash } from "node:crypto";

/** Deterministic recall handle for a session entry id: 10-char base36 of sha256("pi-zip:"+id)[0..12). */
export function handleFor(entryId: string): string {
	const hex = createHash("sha256").update(`pi-zip:${entryId}`).digest("hex").slice(0, 12);
	return BigInt("0x" + hex).toString(36).padStart(Math.ceil(48 / Math.log2(36)), "0").slice(-10);
}

/** Every handle-shaped token of a text (10 lowercase base36 characters, not inside a longer run of them), in one scan. */
export function handleTokens(text: string): string[] {
	return text.match(/(?<![0-9a-z])[0-9a-z]{10}(?![0-9a-z])/g) ?? [];
}
