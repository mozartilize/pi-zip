// Coverage of the formal model against recorded sessions: which run starts and entry kinds real Pi sessions contain, which event of
// `model.rs` each one maps to, and every kind the model cannot express.
//
//   bun formal/coverage/coverage.ts DIR [DIR ...]
//
// Reads every Pi session file (*.jsonl whose first line is a session header) under the directories, read-only, and walks the branch
// that ends at the newest entry (the conversation the session continues from). Output is counts only: no path, name, id, text or
// customType of any session is printed. Kinds are classified by position, the way Pi produces them (Pi 1.1.0 agent-session.js):
//   a run starts at a user prompt (after a final answer, or the session's first message) or at a custom message after a final answer
//   that an assistant message answers before any prompt (sendCustomMessage triggerTurn); a custom message right after a prompt rides
//   with it (nextTurn, before_agent_start messages); one after a tool call or a tool result arrived mid-run (steer / followUp
//   delivery); one after a final answer that a prompt follows was appended while idle (no triggerTurn).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PI: any = await import(join(import.meta.dir, "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js"));

type Row = { kind: string; model: string; n: number; sessions: Set<number> };
const rows = new Map<string, Row>();
const add = (kind: string, model: string, s: number, k = 1) => {
	const r = rows.get(kind) ?? { kind, model, n: 0, sessions: new Set<number>() };
	r.n += k;
	r.sessions.add(s);
	rows.set(kind, r);
};
const NO = "not expressible";

function files(dir: string, out: string[] = []): string[] {
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const n of names) {
		const p = join(dir, n);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) files(p, out);
		else if (n.endsWith(".jsonl")) {
			try {
				const head = readFileSync(p, "utf8").slice(0, 400);
				if (head.startsWith('{"type":"session"')) out.push(p);
			} catch {}
		}
	}
	return out;
}

const final = (m: any) => m?.role === "assistant" && m.stopReason !== "toolUse" && m.stopReason !== "error" && m.stopReason !== "aborted";

let sessions = 0, offBranch = 0, entriesOnBranch = 0;
for (const path of process.argv.slice(2).flatMap((d) => files(d))) {
	let file: any[];
	try {
		file = PI.parseSessionEntries(readFileSync(path, "utf8"));
		PI.migrateSessionEntries(file);
	} catch {
		continue;
	}
	const s = sessions++;
	const all = file.filter((e) => e.type !== "session");
	const byId = new Map(all.map((e) => [e.id, e]));
	const branch: any[] = [];
	for (let e: any = all[all.length - 1]; e; e = e.parentId ? byId.get(e.parentId) : null) branch.unshift(e);
	offBranch += all.length - branch.length;
	entriesOnBranch += branch.length;
	if (all.length > branch.length) add("entries on other branches (/tree, fork, rewind)", NO + " (one linear branch)", s, all.length - branch.length);
	const models = new Set<string>();
	let state: "start" | "answer" | "prompt" | "midrun" | "starter" = "start"; // what the newest message was
	const msgs = branch.filter((e) => e.type === "message" || e.type === "custom_message");
	const nextMsg = (i: number) => msgs.find((x, j) => j > i);
	const idx = new Map(msgs.map((e, i) => [e, i]));
	let lastModel = "", sysSeen = false;
	for (const e of branch) {
		switch (e.type) {
			case "message": {
				const m = e.message;
				if (m.role === "user") {
					if (state === "start" || state === "answer") add("run start: user prompt", "Prompt", s);
					else if (state === "starter") add("user prompt right after the custom message that started the run", NO + " (Drive has no prompt)", s);
					else if (state === "prompt") add("user message right after a prompt", NO, s);
					else add("user message mid-run (steering / follow-up)", "Steer", s);
					if (Array.isArray(m.content) && m.content.some((c: any) => c?.type === "image")) add("image in a user message", NO + " (text only)", s);
					state = "prompt";
				} else if (m.role === "assistant") {
					const key = `${m.provider}/${m.model}`;
					if (m.provider) {
						if (lastModel && key !== lastModel) add("model switch between requests", "Switch", s);
						lastModel = key;
						models.add(key);
					}
					const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall").length;
					if (m.stopReason === "error") add("request failed (error)", "Fail error", s);
					else if (m.stopReason === "aborted") add("request aborted (Esc)", "Fail abort", s);
					else if (calls === 1) add("request with one tool call", "Call", s);
					else if (calls > 1) add("request with several tool calls", NO + " (one tool call per request)", s);
					else add("request that answers (final)", "Say", s);
					if ((m.content ?? []).some((c: any) => c?.type === "thinking")) add("thinking blocks in a response", NO + " (no thinking)", s);
					state = final(m) ? "answer" : "midrun";
				} else if (m.role === "toolResult") {
					add(m.toolName === "zip_recall" ? "tool result of zip_recall" : "tool result", m.toolName === "zip_recall" ? "Call recall" : "Call (npm / cat)", s);
					state = "midrun";
				} else if (m.role === "system") {
					if (sysSeen) add("system prompt or tool set changed mid-session", NO + " (one system prompt)", s);
					else add("system prompt (the first)", "World sys", s);
					sysSeen = true;
				} else add(`message of role ${m.role === "bashExecution" ? "bashExecution (!cmd)" : "other"}`, NO, s);
				break;
			}
			case "custom_message": {
				const i = idx.get(e)!;
				const nx = nextMsg(i);
				const answered = nx?.type === "message" && nx.message?.role === "assistant";
				if (state === "answer" || state === "start") {
					if (answered && state === "start") { add("the session's first run started by a custom message (a subagent's task, say)", NO + " (the first run is a prompt)", s); state = "starter"; }
					else if (answered) { add("run start: custom message answered before any prompt (triggerTurn)", "Drive", s); state = "starter"; }
					else if (nx?.type === "message" && nx.message?.role === "user") add("custom message stored before the prompt that follows it (idle append, or an older Pi's nextTurn order)", NO + " (NextTurn follows its prompt)", s);
					else add("custom message followed directly by another custom message (several stored between runs or before one)", NO + " (one starter or NextTurn per message)", s);
				} else if (state === "prompt" || state === "starter") add("custom message stored with the prompt (nextTurn / before_agent_start)", "NextTurn", s);
				else add("custom message delivered mid-run (steer / followUp of an extension)", NO + " (Steer is a user message)", s);
				break;
			}
			case "compaction":
				if (e.details?.by === "pi-zip") add("pi-zip summary (compaction)", "pi-zip's own decision", s);
				else if (e.fromHook) add("compaction another extension supplied", "Foreign", s);
				else add("Pi's own compaction", "Compact", s);
				break;
			case "branch_summary":
				add("branch summary (/tree navigation)", NO, s);
				break;
			case "context_edit": {
				const text = JSON.stringify(e.replacement?.content ?? "");
				if (text.includes("[folded by pi-zip") || text.includes("[zipped")) add("pi-zip fold (context_edit)", "pi-zip's own decision", s);
				else add("context_edit of another extension (or Pi)", "Edit (the model's always prunes the oldest output)", s);
				break;
			}
			case "model_change":
				add("model_change entry", "Switch", s);
				break;
			case "thinking_level_change":
				add("thinking level change", NO + " (no thinking)", s);
				break;
			case "usage":
				add(`usage entry (${e.kind === "cache_warm" ? "Pi's idle cache warming" : "other"})`, e.kind === "cache_warm" ? "World warming" : NO, s);
				break;
			case "custom":
				add("custom entry (extension state, never sent)", "nothing to express (not in the context)", s);
				break;
			default:
				add(`entry of type ${e.type === "label" || e.type === "session_info" ? e.type : "other"}`, "nothing to express (not in the context)", s);
		}
	}
	if (models.size > 2) add("sessions with more than two models", NO + " (two models)", s);
}

const out = [...rows.values()].sort((a, b) => (a.model.startsWith(NO) === b.model.startsWith(NO) ? b.n - a.n : a.model.startsWith(NO) ? 1 : -1));
console.log(`sessions ${sessions}, entries on the newest branch ${entriesOnBranch}, entries on other branches ${offBranch}`);
console.log("| kind | model event | entries | sessions |");
console.log("|---|---|---|---|");
for (const r of out) console.log(`| ${r.kind} | ${r.model} | ${r.n} | ${r.sessions.size} |`);
