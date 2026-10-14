// Offline fixture and observer for the two compaction doors in the real Pi TUI.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendFileSync, writeFileSync } from "node:fs";
import { planContext } from "../../src/plan.ts";
import { planOpts } from "../../src/core.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

if (process.argv[2] === "fixture") {
	const file = process.argv[3], ready = process.argv[4] === "ready";
	const sm = SessionManager.inMemory(process.cwd()), timestamp = Date.now() - 3_600_000;
	const model = { provider: "fake", id: "m", contextWindow: 200_000, cost: { input: 3, output: 15 } };
	for (let i = 0; i < 12; i++) {
		sm.appendMessage({ role: "user", content: `Task ${i + 1}`, timestamp } as any);
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "context ".repeat(4000) }], api: "fake-api", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "fake", model: "m", stopReason: "stop", timestamp } as any);
	}
	if (ready) {
		const entries = sm.buildSessionProjection().entries;
		const env = { model, cwd: process.cwd(), sys: { text: "", tools: [] }, reserve: 16_384, recalled: new Set<string>(), steerIds: new Set<string>(), rereadOnly: false };
		const p = planContext(entries, planOpts(entries, sm.getBranch(), env, { model, g: 2500, justEdited: false, summarizedWarm: false }, true, 0, true).o)!;
		if (p.cutIdx === null) throw new Error("fixture has no cut");
		const text = "[summary of earlier conversation by pi-zip]\n## Decisions\n" + "context ".repeat(400);
		sm.appendCustomEntry("pi-zip/summary", { head: "", key: p.firstKeptEntryId, usd: 0, cut: { firstKeptEntryId: p.firstKeptEntryId, text, trigger: "cold", count: 10, prefixTokens: p.prefixTokens, summaryTokens: Math.ceil(text.length / 4), llmOk: true, llmError: null, costUsd: 0, ms: 0, prepared: true } });
	}
	writeFileSync(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("drive", { description: "Exercise the driven door offline", handler: async () => {
		pi.sendMessage({ customType: "door-drive", content: "Continue with a short answer.", display: true }, { triggerTurn: true });
	} });
	// DOOR_RACE_MS: another handler after pi-zip's holds the first compaction that long, and an extension's message starts a run meanwhile
	let raced = false;
	pi.on("session_before_compact", async () => {
		const hold = Number(process.env.DOOR_RACE_MS || 0);
		if (!hold || raced) return undefined;
		raced = true;
		setTimeout(() => pi.sendMessage({ customType: "door-drive", content: "Continue with a short answer.", display: true }, { triggerTurn: true }), 200);
		await new Promise((r) => setTimeout(r, hold));
		return undefined;
	});
	pi.on("turn_end", async (e: any) => {
		if (process.env.DOOR_LOG) appendFileSync(process.env.DOOR_LOG, JSON.stringify({ drafts: e.entries.map((d: any) => d.type) }) + "\n");
	});
}
