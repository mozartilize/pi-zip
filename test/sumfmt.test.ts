// Summary and placeholder format (research round5/sumfmt.md): distinguishable row labels, times instead of turn numbers, smaller
// mechanical lists, short fold text, JSON key fields. Synthetic sessions only.
import { describe, expect, test } from "bun:test";
import { buildBlocks, toolCallIndex } from "../src/plan.ts";
import { cmdLabel, distinctLines, handleFor, sharedCdDirs, shortArgs } from "../src/placeholder.ts";
import { buildCut, handleRowsOf, skeleton } from "../src/summary.ts";
import { A, type Any, U } from "./helpers.ts";

const tcall = (id: string, name: string, args: Any) => {
	const m = { role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: `c-${id}`, name, arguments: args }] };
	return { sourceEntry: { id, type: "message", message: m }, messages: [m] };
};
const tres = (id: string, name: string, text: string, ts?: number) => {
	const m = { role: "toolResult", toolCallId: `c-${id}`, toolName: name, isError: false, content: [{ type: "text", text }], ...(ts ? { timestamp: ts } : {}) };
	return { sourceEntry: { id: `r-${id}`, type: "message", message: m }, messages: [m] };
};
const stub = (text = "## Decisions and rationale\nnone") => ({ model: { id: "m" }, modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text }], usage: { cost: { total: 0 } } }) } }) as Any;
async function cutOf(entries: Any[]): Promise<string> {
	const all = [...entries, U("keep", "kept"), A("keepA")];
	const blocks = buildBlocks(all);
	const p: Any = { blocks, calls: toolCallIndex(blocks), cutIdx: blocks.findIndex((b) => b.entryId === "keep"), prefixTokens: 50_000, summaryTokensPlanned: 7000, sumTrigger: "cold" };
	return (await buildCut(p, stub())).text;
}
const sec = (t: string, head: string) => { const i = t.indexOf(head); const j = t.indexOf("\n## ", i + 1); return t.slice(i, j < 0 ? undefined : j); };
/** A status report of a long-running job: the same first lines every time, the line that tells it apart further down. */
const status = (n: number) => `done: alpha, beta, gamma, delta, epsilon, zeta\nopen: none\nqueue: 3 items\n` + "pad line\n".repeat(400) + `Saved #${n} state.v${60 + n}\nCopy: state.v${60 + n}\nend`;

describe("row labels tell look-alike rows apart (2026-10-11 item 3)", () => {
	test("folded-outputs table: rows of one tool that would show the same key line each show the first line that differs", async () => {
		const entries: Any[] = [U("u1", "go")];
		for (let i = 1; i <= 3; i++) entries.push(tcall(`p${i}`, "job_status", {}), tres(`p${i}`, "job_status", status(i)));
		entries.push(A("e"));
		const table = sec(await cutOf(entries), "## Folded outputs");
		const rows = table.split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toHaveLength(3);
		for (let i = 1; i <= 3; i++) expect(rows[i - 1]).toContain(`Saved #${i} state.v${60 + i}`);
		expect(new Set(rows.map((r) => r.split(" · ").pop())).size).toBe(3);
		// a row whose key line differs anyway keeps it
		const one = sec(await cutOf([U("u1", "go"), tcall("q", "job_status", {}), tres("q", "job_status", status(7)), A("e")]), "## Folded outputs");
		expect(one).toContain("queue: 3 items");
	});

	test("folded-outputs table: a row is told apart from the previous summary's rows of that tool too", async () => {
		const first = await cutOf([U("u1", "go"), tcall("p1", "job_status", {}), tres("p1", "job_status", status(1)), A("e")]);
		expect(sec(first, "## Folded outputs")).toContain("queue: 3 items");
		const entries = [{ sourceEntry: { id: "comp", type: "compaction" }, messages: [{ role: "compactionSummary", summary: first, tokensBefore: 0, timestamp: 0 }] }, U("u2", "more"), tcall("p2", "job_status", {}), tres("p2", "job_status", status(2)), A("e2")];
		const rows = sec(await cutOf(entries), "## Folded outputs").split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEndWith(" · queue: 3 items"); // the earlier row, as it was
		expect(rows[1]).not.toEndWith(" · queue: 3 items"); // the new one shows another of its lines
	});

	test("commands: a shared `cd <dir> &&` / `cd <dir>;` is left out (the heading names it), heredocs show their gist, the clip keeps head and tail", async () => {
		const dir = "/home/user/projects/example-app";
		const py = (seq: number) => `cd ${dir}; python3 - <<'EOF'\nimport json\nL=[json.loads(l) for l in open('data/ledger.jsonl')]\nfor e in L:\n    if e['seq']>${seq}: print(e['seq'], e['kind'])\nEOF`;
		const entries: Any[] = [U("u1", "go")];
		[120, 130, 140].forEach((s, i) => entries.push(tcall(`b${i}`, "bash", { command: py(s) }), tres(`b${i}`, "bash", `out ${i}`)));
		entries.push(tcall("b9", "bash", { command: `cd ${dir} && make all` }), tres("b9", "bash", "ok"), A("e"));
		const t = skeleton(buildBlocks(entries), null).text;
		const cmds = sec(t, "## Commands run");
		expect(cmds.split("\n")[0]).toBe(`## Commands run (with exit status; a leading "cd <dir> &&" is left out for: ${dir})`);
		const rows = cmds.split("\n").filter((l) => l.startsWith("`"));
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => !r.includes(`cd ${dir}`))).toBe(true);
		expect(new Set(rows.map((r) => r.replace(/\(.*\)$/, ""))).size).toBe(4);
		for (const s of [120, 130, 140]) expect(cmds).toContain(`e['seq']>${s}`);
		expect(rows[3]).toMatch(/^`make all` -> exit 0/);
		// carried into the next summary, the heading keeps the dir
		const again = skeleton(buildBlocks([U("u2", "x"), tcall("c1", "bash", { command: "ls" }), tres("c1", "bash", "a"), A("e2")]), t).text;
		expect(sec(again, "## Commands run").split("\n")[0]).toContain(`left out for: ${dir}`);
		// a cd used once says where the command ran: kept
		expect(skeleton(buildBlocks([U("u1", "go"), tcall("x", "bash", { command: "cd /a/b && ls" }), tres("x", "bash", "a"), A("e")]), null).text).toContain("`cd /a/b && ls`");
	});

	test("cmdLabel: heredoc gist (comment, else echo/print, else tail), cd only when shared, middle clip", () => {
		const hd = (body: string) => `python3 - <<'EOF'\nimport json, sys\nrows = json.load(open('x.json'))\n${body}\nEOF`;
		expect(cmdLabel(hd("# count the failed rows\nprint(len(rows))"))).toBe("python3 - <<'EOF' … # count the failed rows");
		expect(cmdLabel(hd("x = 1\nprint(len(rows))\ny = 2"))).toBe("python3 - <<'EOF' … print(len(rows))");
		expect(cmdLabel(hd("x = [r for r in rows if r['a'] > 5]\ny = sum(x)"))).toBe("python3 - <<'EOF' … x = [r for r in rows if r['a'] > 5] y = sum(x)");
		expect(cmdLabel("cat <<EOF > f.txt\nhello\nEOF\nwc -l f.txt")).toBe("cat <<EOF > f.txt … hello EOF wc -l f.txt");
		expect(cmdLabel("cd /x && ls", 90, new Set(["/x"]))).toBe("ls");
		expect(cmdLabel("cd /x && ls", 90, new Set(["/y"]))).toBe("cd /x && ls");
		const long = "npm run test -- " + "--flag ".repeat(40) + "--testPathPattern=alpha.spec.ts";
		expect(cmdLabel(long, 60).endsWith("alpha.spec.ts")).toBe(true);
		expect(shortArgs({ command: long }, 60)).toBe(cmdLabel(long, 60));
		expect(sharedCdDirs(["cd /a && x", "cd /a; y", "cd /b && z", "ls"])).toEqual(new Set(["/a"]));
	});

	test("handle index: rows of one tool and the same arguments get the first line that tells them apart", async () => {
		const entries: Any[] = [U("u1", "go")];
		for (let i = 1; i <= 70; i++) entries.push(tcall(`s${i}`, "bash", { command: "job status" }), tres(`s${i}`, "bash", status(i)));
		entries.push(A("e"));
		const t = skeleton(buildBlocks(entries), null).text;
		const index = sec(t, "## Handle index").split("\n").filter((l) => l.startsWith("- "));
		expect(index.length).toBeGreaterThan(0); // the commands list dropped the oldest: their handles are in the index
		for (const l of index) expect(l).toMatch(/ · Saved #\d+ state\.v\d+$/);
		expect(new Set(index.map((l) => l.split(" · ").pop())).size).toBe(index.length);
		// carried into the next summary's index, a row keeps its line
		const rows = handleRowsOf(t).filter((r) => r.hint);
		expect(rows.length).toBe(index.length);
	});

	test("distinctLines is pure, prefers the given key lines, skips lines a sibling or a taken label has", () => {
		const a = "same\nkey A\nonly-a", b = "same\nkey B\nonly-b";
		expect(distinctLines([a, b])).toEqual(["key A", "key B"]);
		expect(distinctLines([a, b], [["only-a"], ["only-b"]])).toEqual(["only-a", "only-b"]);
		expect(distinctLines([a, b], [], ["key A"])).toEqual(["only-a", "key B"]);
		expect(distinctLines(["x\ny", "x\ny"])).toEqual([null, null]);
		expect(distinctLines([a, b])).toEqual(distinctLines([a, b]));
	});

	test("deterministic: the same session gives byte-identical summaries", async () => {
		const mk = () => [U("u1", "go"), ...[1, 2, 3].flatMap((i) => [tcall(`p${i}`, "job_status", {}), tres(`p${i}`, "job_status", status(i))]), A("e")];
		expect(await cutOf(mk())).toBe(await cutOf(mk()));
	});
});

export { handleFor };
