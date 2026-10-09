// Recall through files (research pi-tricks §2): a tool allowlist hides zip_recall, but read, grep or bash can read the original from a
// file that the tool_call hook writes from the session when a tool names it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { handleFor, makePlaceholder } from "../src/placeholder.ts";
import { planContext } from "../src/plan.ts";
import { recalledHandlesFromBranch } from "../src/recall.ts";
import { cleanupRecall, commandRecallHandles, fileRecallFor, fileRecallHow, materialize, parseRecallPath, recallRoot, RECALL_DIR, RECALL_MAX_AGE_MS, rewriteCommand } from "../src/recallfile.ts";
import { handleTable, skeleton } from "../src/summary.ts";
import { buildBlocks } from "../src/plan.ts";
import { A, fakeCtx, fakePi, flat, longTurn, R, U, type Any } from "./helpers.ts";

const SID = "01a120cb-3d40-75a6-aeac-320e71967606";
const OTHER = "0199aaaa-0000-7000-8000-000000000000";
const ALL = { read: true, grep: true, bash: true };
const ENV = ["PI_ZIP_TTL_SECS", "PI_ZIP_COLD_CAP", "PI_ZIP_INTURN_AGE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); process.env.PI_ZIP_TTL_SECS = "1"; });
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

describe("recall files: paths, placeholder text, disk", () => {
	test("any prefix names a recall file or a session's recall directory; nothing else does", () => {
		expect(parseRecallPath(`~/.cache/pi-zip/recall/${SID}/k3f9a0x1qz.txt`)).toEqual({ handle: "k3f9a0x1qz" });
		expect(parseRecallPath(`/home/someone-else/.cache/pi-zip/recall/${OTHER}/k3f9a0x1qz.txt`)).toEqual({ handle: "k3f9a0x1qz" });
		expect(parseRecallPath(`$HOME/.cache/pi-zip/recall/${SID}`)).toEqual({});
		expect(parseRecallPath(`/x/pi-zip/recall/${SID}/`)).toEqual({});
		for (const p of ["src/pi-zip/recall.ts", `~/.cache/pi-zip/recall/${SID}/K3F9A0X1QZ.txt`, `~/.cache/pi-zip/recall/${SID}/k3f9a0x1qz.txt.bak`, "~/.cache/pi-zip/recall/", 42, undefined])
			expect(parseRecallPath(p)).toBeNull();
	});

	test("the placeholder names the file and only the tools that are active", () => {
		const text = Array.from({ length: 300 }, (_, i) => `line ${i} value=${i * 7}`).join("\n");
		const h = "k3f9a0x1qz";
		const ph = makePlaceholder(text, "bash", "npm test", h, 8, { file: fileRecallFor(SID, ALL) })!;
		expect(ph).toContain(`in ${RECALL_DIR}/${SID}/${h}.txt: read it (offset/limit for pages) or grep it;`);
		expect(ph).not.toContain("zip_recall");
		expect(ph.split("\n")[0]).toBe(makePlaceholder(text, "bash", "npm test", h, 8)!.split("\n")[0]); // the marker line is the full mode's
		const how = (read: boolean, grep: boolean, bash: boolean) => fileRecallHow(fileRecallFor(SID, { read, grep, bash }));
		expect(how(true, false, false)).toBe("read it (offset/limit for pages)");
		expect(how(false, true, false)).toBe("grep it");
		expect(how(false, false, true)).toBe("read it with bash (sed -n for pages) or grep -n it with bash");
		expect(how(true, false, true)).toBe("read it (offset/limit for pages) or grep -n it with bash");
		expect(how(false, true, true)).toBe("read it with bash (sed -n for pages) or grep it");
	});

	test("written once from the text it is given: directory 0700, file 0600, under $XDG_CACHE_HOME", () => {
		expect(recallRoot()).toBe(join(process.env.XDG_CACHE_HOME!, "pi-zip", "recall"));
		const root = recallRoot();
		const out = materialize(root, SID, [{ handle: "aaaaaaaaaa", text: "original\nbytes ü\n" }, { handle: "../../evil", text: "x" }]);
		const f = join(root, SID, "aaaaaaaaaa.txt");
		expect([...out.entries()]).toEqual([["aaaaaaaaaa", f]]); // a handle that is not one is never a file name
		expect(readFileSync(f, "utf8")).toBe("original\nbytes ü\n");
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, SID)).mode & 0o777).toBe(0o700);
		materialize(root, SID, [{ handle: "aaaaaaaaaa", text: "something else" }]);
		expect(readFileSync(f, "utf8")).toBe("original\nbytes ü\n"); // the original never changes: an existing copy stays
		rmSync(join(root, SID), { recursive: true, force: true });
	});

	test("cleanup: copies older than 14 days go, newer ones stay, an emptied session directory goes", () => {
		const root = join(process.env.XDG_CACHE_HOME!, "cleanup-test");
		materialize(root, SID, [{ handle: "oldoldoldo", text: "a" }, { handle: "newnewnewn", text: "b" }]);
		materialize(root, OTHER, [{ handle: "oldoldoldo", text: "c" }]);
		const old = (Date.now() - RECALL_MAX_AGE_MS - 3_600_000) / 1000;
		utimesSync(join(root, SID, "oldoldoldo.txt"), old, old);
		utimesSync(join(root, OTHER, "oldoldoldo.txt"), old, old);
		expect(cleanupRecall(root)).toBe(2);
		expect(readdirSync(join(root, SID))).toEqual(["newnewnewn.txt"]);
		expect(existsSync(join(root, OTHER))).toBe(false);
		expect(cleanupRecall(join(root, "missing"))).toBe(0);
		rmSync(root, { recursive: true, force: true });
	});

	test("a shell command: every recall path points at this machine's copy; the handles, or the directory, are reported", () => {
		const r1 = rewriteCommand(`grep -n SKU-03903 ~/.cache/pi-zip/recall/${SID}/k3f9a0x1qz.txt | head -5`, "/l/recall/s");
		expect(r1).toEqual({ command: "grep -n SKU-03903 /l/recall/s/k3f9a0x1qz.txt | head -5", handles: ["k3f9a0x1qz"], dir: false });
		expect(rewriteCommand(`grep -rn foo /home/o/.cache/pi-zip/recall/${OTHER}/`, "/l/s")).toEqual({ command: "grep -rn foo /l/s/", handles: [], dir: true });
		expect(rewriteCommand(`cat "$HOME/.cache/pi-zip/recall/${SID}"/*.txt`, "/l/s").command).toBe(`cat "/l/s"/*.txt`);
		expect(rewriteCommand(`sed -n 1,9p ~/.cache/pi-zip/recall/${SID}/k3f9a0x1qz.txt`, "/with space/s")).toEqual({ command: `sed -n 1,9p ~/.cache/pi-zip/recall/${SID}/k3f9a0x1qz.txt`, handles: ["k3f9a0x1qz"], dir: false }); // would need quoting: left alone
		expect(rewriteCommand("ls -la src", "/l/s")).toEqual({ command: "ls -la src", handles: [], dir: false });
		expect(commandRecallHandles(`wc -l ~/.cache/pi-zip/recall/${SID}/aaaaaaaaaa.txt ~/.cache/pi-zip/recall/${SID}/bbbbbbbbbb.txt`)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
	});

	test("a summary in file mode names the recall files, never zip_recall; the sections still parse", () => {
		const file = fileRecallFor(SID, ALL);
		const blocks = buildBlocks([U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 4000), A("a2")]);
		const table = handleTable([{ handle: "k3f9a0x1qz", tool: "bash", args: "ls", hint: "x", turn: 1 }], null, file)!;
		expect(table.split("\n")[0]).toBe(`## Folded outputs (originals in ${RECALL_DIR}/${SID}/<handle>.txt; handles stay valid after later summaries or compaction)`);
		const older = "## Folded outputs (originals recallable with zip_recall; handles stay valid after later summaries or compaction)\n- abcdefghij · bash make · turn 1 · ok";
		const sk = skeleton(blocks, older, table, file).text;
		expect(sk).toContain(`${RECALL_DIR}/${SID}/<handle>.txt holds that output. To use what an output said, read it (offset/limit for pages) or grep it (grep over ${RECALL_DIR}/${SID} searches every earlier output)`);
		expect(sk).not.toContain("zip_recall");
		expect(sk).toContain(`## Handle index (older outputs, newest first; ${RECALL_DIR}/${SID}/<handle>.txt holds the original)\n- abcdefghij · bash make · turn 1`);
		// a later summary carries this one's rows forward (the headings are recognised)
		const again = handleTable([{ handle: "m2b7c4d8ww", tool: "bash", args: "ls", hint: "y", turn: 2 }], `${sk}\n${table}`, file)!;
		expect(again).toContain("k3f9a0x1qz");
	});
});

// ---- through the extension ----------------------------------------------------------------------------------------------------
const branchOf = (entries: Any[], lastTs: number) => [
	...entries.map((e) => ({ type: "message", id: e.sourceEntry.id, message: e.sourceEntry.message })),
	{ type: "message", id: "ts", message: { role: "assistant", timestamp: lastTs, content: [] } },
];
async function rig(entries: Any[], tools: string[], over: Any = {}, piExtra: Any = {}) {
	const { default: piZip } = await import("../src/index.ts");
	const f = fakePi({ getActiveTools: () => tools, ...piExtra });
	piZip(f.pi);
	const branch = over.branch ?? branchOf(entries, Date.now() - 60_000);
	const { ctx, notes } = fakeCtx(entries, { branch, ...over, sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({ entries: over.projection ?? entries }), getSessionId: () => SID, ...over.sessionManager } });
	return { ...f, ctx, notes, fire: async (name: string, e: Any) => f.handlers.get(name)(e, ctx) };
}
const folded = (msgs: Any[]) => msgs.filter((m) => m.role === "toolResult" && String(m.content[0].text).startsWith("[folded by pi-zip"));

describe("file recall through the extension", () => {
	const session = () => longTurn(60, { mutating: [3, 10, 50], recalls: [7] });

	test("read, grep or bash without zip_recall: folds exactly as in full mode (npm test outputs included), placeholders name the file", async () => {
		process.env.PI_ZIP_INTURN_AGE = "20";
		process.env.PI_ZIP_COLD_CAP = "8000";
		const full = await rig(session(), ["read", "bash", "zip_recall"]);
		await full.fire("session_start", {});
		await full.fire("before_agent_start", {});
		const want = folded((await full.fire("context_with_system", { messages: flat(session()) })).messages);
		const file = await rig(session(), ["read", "grep", "find", "ls", "bash"]);
		await file.fire("session_start", {});
		await file.fire("before_agent_start", {});
		const got = folded((await file.fire("context_with_system", { messages: flat(session()) })).messages);
		expect(got.map((m: Any) => m.toolCallId)).toEqual(want.map((m: Any) => m.toolCallId));
		expect(got.map((m: Any) => m.toolCallId)).toContain("c3"); // an npm test output: not re-readable, folded all the same
		for (const [i, m] of got.entries()) {
			const t = String(m.content[0].text), w = String(want[i].content[0].text);
			expect(t.split("\n").slice(0, -1)).toEqual(w.split("\n").slice(0, -1)); // the same placeholder up to its last line
			expect(t.split("\n").at(-1)).toMatch(new RegExp(`in ~/\\.cache/pi-zip/recall/${SID}/[0-9a-z]{10}\\.txt: read it \\(offset/limit for pages\\) or grep it;`));
		}
		// only when none of read, grep and bash is there: re-readable outputs only, pointing at re-reading
		const none = await rig(session(), ["edit", "write"]);
		await none.fire("session_start", {});
		await none.fire("before_agent_start", {});
		const rr = folded((await none.fire("context_with_system", { messages: flat(session()) })).messages);
		expect(rr.map((m: Any) => m.toolCallId)).not.toContain("c3");
		for (const m of rr) expect(String(m.content[0].text)).toContain("re-read the file");
	});

	test("the tool_call hook writes the original from the branch and points read, grep, find, ls and bash at it, whatever the prefix", async () => {
		const out = Array.from({ length: 50 }, (_, i) => `SKU-${String(i).padStart(5, "0")} price=${i}.42`).join("\n");
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 0, out), A("a2", ["c2"]), R("r2", "c2", 0, "second output\n".repeat(200)), A("a3"), U("u2", "two")];
		const ph = { type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip · bash cat inv" }] } };
		const branch = [...branchOf(entries, Date.now()), ph];
		const projection = entries.map((pe) => (pe.sourceEntry.id === "r1" ? { ...pe, messages: [{ ...pe.messages[0], content: ph.replacement.content }] } : pe));
		const r = await rig(entries, ["read", "grep", "bash"], { branch, projection });
		const dir = join(recallRoot(), SID);
		const h1 = handleFor("r1"), h2 = handleFor("r2");
		const read = { toolName: "read", input: { path: `/home/someone-else/.cache/pi-zip/recall/${OTHER}/${h1}.txt`, offset: 1, limit: 20 } };
		await r.fire("tool_call", read);
		expect(read.input.path).toBe(join(dir, `${h1}.txt`));
		expect(readFileSync(read.input.path, "utf8")).toBe(out); // byte for byte, from the session
		expect(statSync(read.input.path).mode & 0o777).toBe(0o600);
		// a grep over the directory: every output the model no longer sees in full is there (r1 is folded; r2 is visible, so it is not)
		const grep = { toolName: "grep", input: { pattern: "SKU-00042", path: `~/.cache/pi-zip/recall/${SID}` } };
		await r.fire("tool_call", grep);
		expect(grep.input.path).toBe(dir);
		expect(readdirSync(dir).sort()).toEqual([`${h1}.txt`]);
		const bash = { toolName: "bash", input: { command: `grep -n SKU-00042 ~/.cache/pi-zip/recall/${SID}/${h2}.txt` } };
		await r.fire("tool_call", bash);
		expect(bash.input.command).toBe(`grep -n SKU-00042 ${join(dir, `${h2}.txt`)}`);
		expect(readFileSync(join(dir, `${h2}.txt`), "utf8")).toBe("second output\n".repeat(200)); // named by handle: written even though visible
		// an unknown handle and any other path are left alone
		const unknown = { toolName: "read", input: { path: `~/.cache/pi-zip/recall/${SID}/zzzzzzzzzz.txt` } };
		await r.fire("tool_call", unknown);
		expect(unknown.input.path).toBe(`~/.cache/pi-zip/recall/${SID}/zzzzzzzzzz.txt`);
		expect(existsSync(join(dir, "zzzzzzzzzz.txt"))).toBe(false);
		const plain = { toolName: "read", input: { path: "src/index.ts" } };
		expect(await r.fire("tool_call", plain)).toBeUndefined();
		expect(plain.input.path).toBe("src/index.ts");
		rmSync(dir, { recursive: true, force: true });
	});

	test("a read of a recall file is a recall: never folded, its handle never refolded, counted as an unzip", async () => {
		const h = handleFor("r1");
		const call = A("a5", ["c5"]);
		Object.assign((call.messages[0] as Any).content[1], { name: "read", arguments: { path: `~/.cache/pi-zip/recall/${SID}/${h}.txt` } });
		const big = R("r5", "c5", 30_000);
		(big.messages[0] as Any).toolName = "read";
		const entries = [U("u1", "one"), A("a1", ["c1"]), R("r1", "c1", 30_000), A("a2"), U("u2", "two"), call, big, A("a6"), U("u3", "three"), A("a7"), U("u4", "four")];
		const p = planContext(entries, { cwd: process.cwd(), coldCap: 1000, promptPending: false })!;
		expect(p.folds.map((t) => t.entryId)).not.toContain("r5");
		const branch = branchOf(entries, Date.now());
		expect([...recalledHandlesFromBranch(branch)]).toEqual([h]);
		const r = await rig(entries, ["read", "grep"], { branch });
		await r.fire("session_start", {});
		await r.handlers.get("cmd:zip").handler("stats", r.ctx);
		expect(r.notes.at(-1)).toContain("1 unzip");
	});

	test("the card says on in file mode and how unzips work; reread-only only without read, grep and bash", async () => {
		const { Zip } = await import("../src/run.ts");
		const entries = [U("u1", "one")];
		const z = new Zip(fakePi().pi);
		const { ctx } = fakeCtx(entries, { sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries }), getSessionId: () => SID } });
		z.setRecallMode("file", { read: true, grep: false, bash: true });
		expect(z.card(ctx)).toMatchObject({ state: "on", unzip: `from files in ${RECALL_DIR} (a tool allowlist hides zip_recall)` });
		expect(z.card(ctx).stateNote).toBeUndefined();
		z.setRecallMode("reread", { read: false, grep: false, bash: false });
		expect(z.card(ctx)).toMatchObject({ state: "reread-only" });
		expect(z.card(ctx).unzip).toBeUndefined();
		z.setRecallMode("tool", { read: true, grep: true, bash: true });
		expect(z.card(ctx)).toMatchObject({ state: "on" });
		expect(z.card(ctx).unzip).toBeUndefined();
	});
});
