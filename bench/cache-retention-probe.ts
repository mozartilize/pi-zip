// Live check of what cacheRetention "short" vs "none" does to reported usage, per provider route.
// Usage: bun bench/cache-retention-probe.ts out.json [provider/model ...]   (default: the cheapest model of each provider+api)
// Makes billed calls: per model, 2 arms x 2 identical requests of ~7K input tokens and a few output tokens.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { textOf } from "../src/util.ts";

const [out, ...refs] = process.argv.slice(2);
if (!out) throw new Error("Usage: bun bench/cache-retention-probe.ts out.json [provider/model ...]");
const rt = await ModelRuntime.create();
const all = await rt.getAvailable();
let models = refs.length ? refs.map((r) => all.find((m) => `${m.provider}/${m.id}` === r) ?? (() => { throw new Error(`unavailable ${r}`); })()) : [];
if (!models.length) {
	const best = new Map<string, (typeof all)[number]>();
	for (const m of all) {
		const k = `${m.provider} ${m.api}`, c = m.cost?.input ?? Infinity;
		if (!best.has(k) || c < (best.get(k)!.cost?.input ?? Infinity)) best.set(k, m);
	}
	models = [...best.values()];
}

// Judge-shaped request: a short fixed system prompt, then a long user message that starts with a per-arm nonce, so one arm can
// never read the other's cache. Identical bytes within an arm: the second request can only be cheaper through a cache read.
const system = "You label tool outputs. Reply with exactly the word OK.\n" + "Rules: be brief. ".repeat(60);
const body = Array.from({ length: 700 }, (_, i) => `row ${i}: output ${(i * 7919) % 10007} of tool ${["bash", "read", "grep"][i % 3]} at step ${i * 3}`).join("\n");
const rows: unknown[] = [];
for (const model of models) {
	const ref = `${model.provider}/${model.id}`;
	for (const retention of ["short", "none"] as const) {
		const nonce = randomUUID(), sessionId = randomUUID();
		const text = `probe ${nonce}\n${body}\nReply OK.`;
		for (const call of [1, 2]) {
			const t0 = Date.now();
			try {
				const res = await rt.streamSimple(model, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
					{ maxTokens: 512, cacheRetention: retention, sessionId, signal: AbortSignal.timeout(60_000) }).result();
				const u = res.usage ?? {};
				const row = { model: ref, api: model.api, retention, call, ms: Date.now() - t0, stopReason: res.stopReason, error: res.errorMessage,
					input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, costUsd: u.cost?.total, reply: textOf(res.content).slice(0, 40) };
				rows.push(row);
				console.log(JSON.stringify(row));
			} catch (e) {
				const row = { model: ref, api: model.api, retention, call, ms: Date.now() - t0, error: String(e) };
				rows.push(row); console.log(JSON.stringify(row));
			}
			await new Promise((r) => setTimeout(r, 3000)); // let a write land before the identical second request
		}
	}
}
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + "\n");
