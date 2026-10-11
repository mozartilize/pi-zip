// Throwaway fake provider for deterministic Pi experiments: no network, no model calls.
// Model "fake/m". Its usage is NOT chars/4: totalTokens = FAKE_OVERHEAD + FAKE_SCALE x chars/4 of what it was sent,
// so a figure that equals the usage is distinguishable from Pi's chars/4 estimate.
// Directives in the newest user message: [[bash:<cmd>]] or [[read:<path>]] or [[grep:<pattern>:<path>]] make it call that tool
// once; after the tool result it answers "ok". Every request is logged to FAKE_LOG (one JSON line).
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SCALE = Number(process.env.FAKE_SCALE ?? 1.5);
const OVERHEAD = Number(process.env.FAKE_OVERHEAD ?? 3000);
let n = 0;

const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? b?.thinking ?? (b?.type === "toolCall" ? JSON.stringify(b.arguments) : "")).join("") : "");

export default function (pi: ExtensionAPI) {
	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "fake",
		api: "fake-api" as any,
		// FAKE_TTL: declare a prompt cache lifetime (seconds; Pi's idle warmer needs one); FAKE_PRICEY: 100x prices (Pi then decides "warm")
		models: [{ id: "m", name: "fake m", reasoning: false, input: ["text"], cost: process.env.FAKE_PRICEY === "1" ? { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 } : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200_000, maxTokens: 8192, ...(process.env.FAKE_TTL ? { promptCache: { short: Number(process.env.FAKE_TTL) } } : {}) } as any],
		streamSimple: (model: any, context: any, options: any) => {
			const stream = createAssistantMessageEventStream();
			(async () => {
				const msgs: any[] = context.messages ?? [];
				const payload = { messages: msgs.map((m) => ({ role: m.role, chars: textOf(m.content).length })) };
				await options?.onPayload?.(payload, model);
				let chars = 0;
				for (const m of msgs) chars += textOf(m.content).length + (m.role === "system" ? 0 : 0);
				const total = Math.round(OVERHEAD + (SCALE * chars) / 4);
				const last = msgs[msgs.length - 1];
				const lastUser = [...msgs].reverse().find((m) => m.role === "user");
				const want = /\[\[(bash|read|grep):([^\]]*)\]\]/.exec(textOf(lastUser?.content));
				const summary = msgs.some((m) => m.role === "user" && textOf(m.content).includes("was compacted into the following summary"));
				const i = ++n;
				const sys = String(context.systemPrompt ?? "") + msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
				const summarizer = /summariz/i.test(sys); // pi-zip's narrative call or Pi's own summary: never a tool call
				if (summarizer && process.env.FAKE_SUMMARY_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SUMMARY_DELAY_MS))); // a slow summary
				const callTool = want && last?.role === "user" && !summarizer;
				const content: any[] = [];
				if (callTool) {
					let [, tool, arg] = want!;
					// "@ph" = the recall path a placeholder in the context names (read <path> / grep <path>)
					if (arg.includes("@ph")) {
						const all = msgs.map((m) => textOf(m.content)).join("\n");
						const ph = /(~?\/[^\s\]]*\/recall\/[^\s\]\/]+\/[0-9a-z]{10}\.txt)/.exec(all)?.[1] ?? "NOT-FOUND";
						arg = arg.replace("@phdir", ph.replace(/\/[^/]*$/, "")).replace("@ph", ph);
					}
					const args = tool === "bash" ? { command: arg } : tool === "read" ? { path: arg } : { pattern: arg.split(":")[0], path: arg.split(":").slice(1).join(":") };
					content.push({ type: "toolCall", id: `call_${Date.now()}_${i}`, name: tool, arguments: args });
				} else {
					const tr = last?.role === "toolResult" ? textOf(last.content) : "";
					content.push({ type: "text", text: `ok ${i}${tr ? ` | tool said: ${tr.slice(0, 120).replace(/\n/g, "\\n")}` : ""}` });
				}
				const cw = process.env.FAKE_EXPLICIT === "1" ? 100 : 0; // an explicit cache (writes billed) instead of an automatic prefix cache
				const usage = { input: 200, output: 50, cacheRead: total - 250 - cw, cacheWrite: cw, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				const msg: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason: callTool ? "toolUse" : "stop", timestamp: Date.now() };
				const hash = createHash("sha1").update(JSON.stringify(msgs, (k, v) => (k === "timestamp" ? undefined : v))).digest("hex").slice(0, 12);
				if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ i, pid: process.pid, n: msgs.length, roles: msgs.map((m) => m.role).join(","), chars, total, summary, summarizer, hash, reply: content[0].type }) + "\n");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message: msg });
				stream.end(msg);
			})().catch((err) => {
				const msg: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(err), timestamp: Date.now() };
				stream.push({ type: "error", reason: "error", error: msg });
				stream.end(msg);
			});
			return stream;
		},
	} as any);
}
