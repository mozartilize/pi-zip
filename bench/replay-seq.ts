// Replays a stretch of a real session in ONE process, as Pi drove it: for every response after entry `from` (up to `to`), the
// request (before_provider_request at the response's timestamp), message_end and the turn_end after its tool results, each on the
// branch as it was then (the session's own later entries, including the live pi-zip drafts, are what the next turn sees). Prints
// where this code would fold or summarize, next to what the live process did.
// Usage: PI_ZIP_LEDGER=out.jsonl bun bench/replay-seq.ts <session.jsonl> <from> <to> <model.json>
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fakePi } from "../test/helpers.ts";

type Any = any;
const [file, fromS, toS, modelFile] = process.argv.slice(2);
const from = Number(fromS), to = Number(toS);
const all: Any[] = [];
for (const l of readFileSync(file, "utf8").split("\n")) { if (!l) continue; try { all.push(JSON.parse(l)); } catch {} }
const { model, settings } = JSON.parse(readFileSync(modelFile, "utf8"));
// optional 5th argument: the model the stretch starts on (a model_change entry on the way switches ctx.model to model.json's, as /model
// does mid-run: no run start)
const startModel = process.argv[6] ? JSON.parse(readFileSync(process.argv[6], "utf8")).model : model;
let now = 0;
Date.now = () => now;
const at = (i: number) => Date.parse(all[i].timestamp);
let sm: Any = SessionManager.inMemory(process.cwd(), undefined, all.slice(0, from + 1));
const ctx: Any = {
	mode: "tui", hasUI: true, cwd: process.cwd(), ui: { notify() {}, setStatus() {}, setWidget() {} }, isIdle: () => false,
	getSystemPrompt: () => "sys", getContextUsage: () => undefined, model: startModel,
	sessionManager: { getBranch: () => sm.getBranch(), buildSessionProjection: () => sm.buildSessionProjection(), getEntries: () => sm.getEntries(), getSessionId: () => "replay", getSessionFile: () => file, getHeader: () => sm.getHeader() },
};
const cut = (i: number) => { sm = SessionManager.inMemory(process.cwd(), undefined, all.slice(0, i + 1)); };
const { default: piZip } = await import("../src/index.ts");
const f = fakePi({ getActiveTools: () => ["read", "bash", "edit", "write", "zip_recall"], getSettings: () => settings });
piZip(f.pi);
const fire = (n: string, e: Any) => f.handlers.get(n)?.(e, ctx);
now = at(from);
await fire("session_start", { reason: "resume" });
await fire("agent_start", { type: "agent_start" });
const isA = (e: Any) => e?.type === "message" && e.message?.role === "assistant";
for (let i = from + 1; i <= to; i++) {
	if (all[i]?.type === "model_change" && all[i].modelId === model.id && ctx.model !== model) { ctx.model = model; await fire("model_select", { type: "model_select", model, previousModel: startModel, source: "set" }); console.log(`${all[i].timestamp.slice(11, 19)} #${i} /model -> ${model.id} (mid-run)`); }
	if (!isA(all[i])) continue;
	const m = all[i].message;
	cut(i - 1);
	now = Number(m.timestamp) || at(i);
	await fire("before_provider_request", { payload: { messages: [] } });
	cut(i);
	now = at(i);
	await fire("message_end", { message: m });
	let j = i;
	while (j + 1 < all.length && all[j + 1]?.type === "message" && all[j + 1].message?.role === "toolResult") j++;
	cut(j);
	now = at(j);
	const proj = sm.buildSessionProjection();
	const out = await fire("turn_end", { message: m, messageEntryId: all[i].id, context: { contextEntries: proj.entries }, entries: [], turnIndex: 1 });
	const mine = ((out?.entries ?? []) as Any[]).filter((d) => d.type === "context_edit" || d.type === "compaction");
	const live: Any[] = [];
	for (let k = j + 1; k < all.length && !isA(all[k]); k++) if (all[k].type === "context_edit" || all[k].type === "compaction") live.push(all[k]);
	const u = m.usage ?? {};
	if (mine.length || live.length) console.log(`${all[i].timestamp.slice(11, 19)} #${i} cr ${u.cacheRead} cw ${u.cacheWrite}  replay: ${mine.length ? mine.map((d) => d.type === "compaction" ? "summary" : "fold").join(",") : "-"}  live: ${live.length ? live.map((d) => d.type === "compaction" ? "summary" : "fold").join(",") : "-"}`);
}
process.exit(0);
