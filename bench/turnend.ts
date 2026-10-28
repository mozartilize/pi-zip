// Times pi-zip's per-turn handlers on a real session file (read only): the branch scans, then one prompt with three tool rounds
// and its settle through the real extension with a fake Pi. Usage: bun bench/turnend.ts <session.jsonl> [n]
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { buildBlocks, calibrate, countUserTurns } from "../src/plan.ts";
import { headOf, inRunClock, readyOf, rentOf, unusedOf } from "../src/core.ts";
import { recalledHandlesFromBranch } from "../src/recall.ts";
import { fakePi } from "../test/helpers.ts";

type Any = any;
const file = process.argv[2], N = Number(process.argv[3] ?? 5);
const t = (label: string, f: () => unknown, reps = 5) => {
	f();
	const ms: number[] = [];
	for (let i = 0; i < reps; i++) { const a = performance.now(); f(); ms.push(performance.now() - a); }
	ms.sort((a, b) => a - b);
	console.log(`${label.padEnd(34)} median ${ms[Math.floor(ms.length / 2)].toFixed(2).padStart(8)} ms  max ${ms[ms.length - 1].toFixed(2).padStart(8)} ms`);
};

let a = performance.now();
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const entries: Any[] = [];
for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }
console.log(`parsed ${entries.length} entries in ${(performance.now() - a).toFixed(0)} ms`);
const sm: Any = SessionManager.inMemory(process.cwd(), undefined, entries);
const branch = sm.getBranch();
const proj = sm.buildSessionProjection();
console.log(`branch ${branch.length} entries, projection ${proj.entries.length} entries`);
const lastA = [...branch].reverse().find((e: Any) => e.type === "message" && e.message.role === "assistant");
const model = { provider: lastA.message.provider, id: lastA.message.model, api: lastA.message.api, contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
const lam = { model, ent: undefined, tier: undefined } as Any;

t("getBranch", () => sm.getBranch());
t("buildSessionProjection (Pi)", () => sm.buildSessionProjection());
t("buildBlocks(projection)", () => buildBlocks(proj.entries));
t("countUserTurns", () => countUserTurns(buildBlocks(proj.entries)));
t("rentOf(branch)", () => rentOf(branch));
t("recalledHandlesFromBranch", () => recalledHandlesFromBranch(branch));
t("inRunClock(branch)", () => inRunClock(branch, lam, Date.now(), { reqMs: 0, modelKey: "" }));
t("headOf", () => headOf(branch));
t("readyOf", () => readyOf(branch));
t("unusedOf", () => unusedOf(branch));
t("calibrate(projection, branch)", () => calibrate(proj.entries, { text: "", tools: [] } as Any, branch, `${model.provider}/${model.id}`));

// the whole handler, through the real extension with a fake Pi around the real branch
const { default: piZip } = await import("../src/index.ts");
const f = fakePi({ getActiveTools: () => ["read", "bash", "edit", "write", "zip_recall"], getSettings: () => ({}) });
piZip(f.pi);
const ctx: Any = {
	mode: "tui", hasUI: true, cwd: process.cwd(), model, ui: { notify() {}, setStatus() {}, setWidget() {} },
	getSystemPrompt: () => "sys", getContextUsage: () => undefined,
	sessionManager: { getBranch: () => sm.getBranch(), buildSessionProjection: () => sm.buildSessionProjection(), getEntries: () => sm.getEntries(), getSessionId: () => "bench", getSessionFile: () => file, getHeader: () => sm.getHeader() },
};
a = performance.now();
await f.handlers.get("session_start")?.({ reason: "startup" }, ctx);
console.log(`session_start                      ${(performance.now() - a).toFixed(1)} ms`);
// one prompt and three tool rounds, every handler timed (input, before_agent_start, agent_start, context_with_system,
// before_provider_request, message_end, turn_end, agent_before_settle)
const fire = async (n: string, e: Any) => { const s = performance.now(); const r = await f.handlers.get(n)?.(e, ctx); times[n] = (times[n] ?? []).concat(performance.now() - s); return r; };
const times: Record<string, number[]> = {};
const msgs = proj.messages;
ctx.isIdle = () => true;
await fire("input", { type: "input", text: "next request", source: "interactive" });
await fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "next request" });
await fire("agent_start", { type: "agent_start" });
for (let r = 0; r < 3; r++) {
	await fire("context_with_system", { messages: msgs });
	await fire("before_provider_request", { payload: { messages: [] } });
	await fire("message_end", { message: { ...lastA.message, timestamp: Date.now() } }, );
	await fire("turn_end", { message: { ...lastA.message, timestamp: Date.now() }, messageEntryId: lastA.id, context: { contextEntries: proj.entries }, entries: [], turnIndex: r });
}
const { ZipFork: Zip } = await import("../src/run-fork.ts");
const Z: Any = Zip.prototype, origOpts = Z.opts, origBranch = Z.branch;
let nOpts = 0, msOpts = 0, nBranch = 0, msBranch = 0;
Z.opts = function (...a: Any[]) { const s = performance.now(); try { return origOpts.apply(this, a); } finally { nOpts++; msOpts += performance.now() - s; } };
Z.branch = function (...a: Any[]) { const s = performance.now(); try { return origBranch.apply(this, a); } finally { nBranch++; msBranch += performance.now() - s; } };
await fire("agent_before_settle", { context: { contextEntries: proj.entries }, entries: [] });
console.log(`settle: opts x${nOpts} ${msOpts.toFixed(1)} ms (incl. branch), branch x${nBranch} ${msBranch.toFixed(1)} ms`);
Z.opts = origOpts; Z.branch = origBranch;
for (const [n, v] of Object.entries(times)) console.log(`${n.padEnd(26)} ${v.map((x) => x.toFixed(1)).join("  ")} ms`);
const ev = () => ({ message: { ...lastA.message, timestamp: Date.now() - 1000 }, messageEntryId: lastA.id, context: { contextEntries: proj.entries }, entries: [], turnIndex: 1 });
const ms: number[] = [];
for (let i = 0; i < N; i++) {
	const s = performance.now();
	await f.handlers.get("turn_end")(ev(), ctx);
	ms.push(performance.now() - s);
}
console.log(`turn_end x${N}                        ${ms.map((x) => x.toFixed(1)).join("  ")} ms`);
process.exit(0);
