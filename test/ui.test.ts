import { describe, expect, test } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { recallSections, resolveHandlesInBranch } from "../src/recall.ts";
import { handleFor } from "../src/placeholder.ts";
import { CHART_COLS, cardText, chartAxis, chartGap, fmtLife, markFirstLine, recallCallLine, recallResultLines, renderCard, renderState, type CardData } from "../src/ui.ts";
import { fakeCtx, fakePi } from "./helpers.ts";

type Any = any;
const th = { fg: (_c: string, t: string) => t };
const tag = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
const plainW = (s: string) => s.replace(/<\/?\w+>/g, "").length;
const fits = (lines: string[], w: number, vw = (s: string) => s.length) => lines.every((l) => vw(l) <= w);

describe("state lines", () => {
	test("one line: product, word, dim reason; warning colour for off/paused/reread-only", () => {
		expect(renderState("paused", "billion-context also manages context", 120, th)).toEqual(["ƶ pi-zip  paused  billion-context also manages context"]);
		expect(renderState("paused", "x", 120, tag)[0]).toContain("<warning>paused</warning>");
		expect(renderState("on", "x", 120, tag)[0]).toContain("<success>on</success>");
		expect(renderState("on", "x", 120, tag)[0]).toStartWith("<accent>ƶ</accent> <muted>pi-zip</muted>");
		for (const w of [3, 8, 15, 20, 40, 120]) expect(fits(renderState("reread-only", "a tool allowlist hides zip_recall, so only rereadable outputs fold", w, th), w)).toBe(true);
		expect(renderState("paused", "a long reason", 18, th)).toEqual(["ƶ pi-zip  paused"]);
	});
});

const card: CardData = {
	state: "on", model: "sota-gpt/gpt-6.1-sol", life: "~1 h", measured: true,
	folds: 56, foldedTokens: "310K", summaries: 2, summaryUsd: 0.41, recalls: 3, last: "10:50  folded 12 old outputs · cache cold (away 47 min)", quiet: false,
};
describe("status card", () => {
	test("labelled rows in plain words: no classes, no curves, no row that only states the default", () => {
		expect(cardText(card)).toEqual([
			"cache    sota-gpt/gpt-6.1-sol · expires after ~1 h idle (measured)",
			"session  56 zipped ~310K  ·  2 summaries $0.41  ·  3 unzips",
			"last     10:50  folded 12 old outputs · cache cold (away 47 min)",
		]);
		expect(cardText({ ...card, life: "~5 min", measured: false })[0]).toBe("cache    sota-gpt/gpt-6.1-sol · expires after ~5 min idle");
		const lines = renderCard(card, 120, th);
		expect(lines[0]).toBe("ƶ pi-zip  on");
		expect(lines[2]).toBe("  session  56 zipped ~310K  ·  2 summaries $0.41  ·  3 unzips");
		for (const w of [10, 30, 60, 120]) expect(fits(renderCard(card, w, tag), w, plainW)).toBe(true);
	});
	test("reread-only and quiet show up; the session row is the only one in the text colour", () => {
		const t = cardText({ ...card, state: "reread-only", quiet: true });
		expect(t.at(-1)).toBe("notices  off  (/zip quiet turns them back on)");
		const l = renderCard(card, 200, tag);
		expect(l.filter((x) => x.includes("<text>"))).toHaveLength(1);
		expect(renderCard({ ...card, state: "reread-only", stateNote: "a tool allowlist hides zip_recall" }, 200, tag)[0]).toContain("<warning>reread-only</warning>");
	});
	test("the cache chart: labels are the axes, live bars in the accent colour, ticks under their columns, the sentence never cut", () => {
		const claude = Array.from({ length: CHART_COLS }, (_, i) => (chartGap(i) <= 300 ? 1 : 0));
		const c: CardData = { ...card, model: "anthropic/claude-sonnet-5-5", alive: claude, life: "~5 min", measured: false };
		const t = cardText(c);
		expect(t.slice(0, 3).map((r) => r.slice(0, 9))).toEqual(["model    ", "cache    ", "away     "]);
		expect(t[1]).toBe(`cache    ${"\u2588".repeat(14)}${"\u2581".repeat(18)}  expires after ~5 min idle`);
		// the 5m tick starts at the column where the bars drop, the 2h tick ends at the last column
		expect(t[2].indexOf("5m")).toBe(9 + 13);
		expect(t[2].indexOf("2h")).toBe(9 + CHART_COLS - 1);
		expect(chartAxis().trim().split(/\s+/)).toEqual(["1m", "5m", "15m", "1h", "2h"]);
		const l = renderCard(c, 120, tag);
		expect(l[2]).toContain(`<accent>${"\u2588".repeat(14)}</accent><dim>${"\u2581".repeat(18)}</dim>`);
		for (const w of [10, 30, 43, 46, 60, 80, 120]) expect(fits(renderCard(c, w, tag), w, plainW)).toBe(true);
		// medium width: the sentence moves under the axis whole; narrow: no chart, the plain row
		const mid = renderCard({ ...c, measured: true }, 60, th);
		expect(mid[3]).toStartWith("  away         1m");
		expect(mid[4]).toBe("           expires after ~5 min idle (measured)");
		expect(renderCard({ ...c, alive: undefined }, 80, th)[1]).toBe("  cache    anthropic/claude-sonnet-5-5 · expires after ~5 min idle");
		expect(renderCard(c, 40, th)[1]).toBe("  cache    expires after ~5 min idle"); // the model name goes before the fact is cut
		expect(renderCard({ ...c, measured: true }, 38, th)[1]).toBe("  cache    expires after ~5 min idle");
		expect(renderCard(c, 40, th).filter((x) => /^  (model|away) /.test(x))).toEqual([]); // no model or away row without the chart
	});
	test("fmtLife", () => expect([fmtLife(45), fmtLife(300), fmtLife(3600), fmtLife(9000)]).toEqual(["~45 s", "~5 min", "~1 h", "~2.5 h"]));
	test("the unzip row: narrow, the bracketed reason goes first, so where the files are is never cut mid-word", () => {
		const c: CardData = { ...card, unzip: "from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)" };
		const row = (w: number) => renderCard(c, w, th).find((l) => l.startsWith("  unzip "));
		expect(row(120)).toBe("  unzip    from files in ~/.cache/pi-zip/recall (a tool allowlist hides zip_recall)");
		expect(row(80)).toBe("  unzip    from files in ~/.cache/pi-zip/recall");
		expect(row(47)).toBe("  unzip    from files in ~/.cache/pi-zip/recall");
		expect(row(46)).toBe("  unzip    from files in ~/.cache/pi-zip/reca\u2026"); // narrower than the place itself: cut like any row
		for (const w of [10, 30, 46, 47, 60, 80, 120]) expect(fits(renderCard(c, w, tag), w, plainW)).toBe(true);
	});
});

describe("zip_recall row", () => {
	const branch: Any[] = [
		{ id: "u1", type: "message", message: { role: "user", content: "go" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] } },
		{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: Array.from({ length: 812 }, (_, i) => (i === 246 ? "Expected: 108.5" : `line ${i + 1}`)).join("\n") }] } },
	];
	const h = handleFor("r1");
	test("sections carry label, turn and how much was shown", () => {
		const { items } = resolveHandlesInBranch(branch, [h, "nope000000"]);
		const out = recallSections(items, { grep: "Expected" });
		expect(out.sections).toEqual([
			{ handle: h, label: "bash npm test", turn: 1, totalLines: 812, shownLines: 1, how: "grep" },
			{ handle: "nope000000", missing: true },
		]);
		expect(recallSections(items.slice(0, 1), {}).sections[0]).toMatchObject({ how: "all", shownLines: 812 });
	});
	test("collapsed: one quiet line per handle; expanded: the text, capped, control characters stripped", () => {
		// like Pi's own tool rows: the name, then WHAT comes back (the folded output's label when known, else the handle)
		expect(recallCallLine({ handle: h, grep: "Expected" }, 120, th)).toEqual([`ƶ unzip ${h}  /Expected/`]);
		expect(recallCallLine({ handle: h, grep: "Expected" }, 120, th, undefined, (x) => (x === h ? "bash npm test" : undefined))).toEqual([`ƶ unzip bash npm test  /Expected/`]);
		expect(recallCallLine({ handle: h }, 120, { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` }, undefined, () => "read src/a.ts")).toEqual(["<accent>*ƶ*</accent> <toolTitle>*unzip*</toolTitle> <accent>src/a.ts</accent><dim></dim>"]);
		expect(recallCallLine({ handles: [h, "x"] }, 120, th)).toEqual(["ƶ unzip 2 outputs"]);
		expect(recallCallLine({ grep: "Expected" }, 120, th)).toEqual(["ƶ unzip all outputs  /Expected/"]); // grep without a handle searches every output
		const secs = [{ handle: h, label: "bash npm test", turn: 1, totalLines: 812, shownLines: 1, how: "grep" as const }];
		expect(recallResultLines(secs, "x", false, 120, th)).toEqual(["1 of 812 lines"]);
		expect(recallResultLines([...secs, { ...secs[0], label: "read a.ts", how: "all" as const, totalLines: 9 }], "x", false, 120, th)).toEqual(["bash npm test  1 of 812 lines", "read a.ts  all 9 lines"]);
		const long = Array.from({ length: 50 }, (_, i) => `\x1b[31mrow\t${i}\x07`).join("\n");
		const ex = recallResultLines(secs, long, true, 120, th, undefined, 40);
		expect(ex[1]).toBe("row  0");
		expect(ex.at(-1)).toBe("… 10 more lines (the model got them all)");
		for (const w of [5, 20, 60]) expect(fits(recallResultLines(secs, long, true, w, th), w)).toBe(true);
		expect(recallResultLines([{ handle: "nope", missing: true }], "", false, 80, tag)).toEqual(["<error>nope not found</error>"]);
		// expanded: only the recalled text, not the framing the model gets (it repeats the collapsed line)
		const framed = `[handle ${h} · read · 7089 chars · 117 lines]\n[grep: 2 matching line(s) of 117]\n31: const HALF_LIFE = 16;\n89: x\n[… 900 more chars: call zip_recall again with offset=10]`;
		expect(recallResultLines(secs, framed, true, 120, th)).toEqual(["1 of 812 lines", "31: const HALF_LIFE = 16;", "89: x"]);
		expect(recallResultLines(secs, `[handle ${h} · read · 7089 chars · 117 lines]\n[grep: 0 matching line(s) of 117]\n`, true, 120, th)).toEqual(["1 of 812 lines"]);
	});
});

describe("the mark on a folded output", () => {
	test("right after the row's own text when it fits (row width kept), untouched otherwise", () => {
		expect(markFirstLine(["$ npm test", "out"], "k3x9q2m7ab", 50, th)).toEqual([`$ npm test  ƶ zipped${" ".repeat(50 - 10 - 10)}`, "out"]);
		// a row padded to the full width (styles closed after the padding) still gets the mark, at the same width
		const padded = markFirstLine(["\x1b[1m$ npm test" + " ".repeat(40) + "\x1b[0m"], "k3x9q2m7ab", 50, th, { vw: (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "").length, cut: (x: string) => x });
		expect(padded[0]).toBe(`\x1b[1m$ npm test\x1b[0m  ƶ zipped${" ".repeat(50 - 10 - 10)}`);
		expect(markFirstLine(["$ npm test"], "k3x9q2m7ab", 19, th)).toEqual(["$ npm test"]);
	});
	test("wired through registerToolRenderer: wraps the built-in renderer and marks only folded calls", async () => {
		const { default: piZip } = await import("../src/index.ts");
		let resolver: Any = null;
		const f = fakePi({ registerToolRenderer: (r: Any) => (resolver = r), registerEntryRenderer: () => {} });
		piZip(f.pi);
		const base = { renderCall: (args: Any) => ({ render: () => [`$ ${args.command}`], invalidate: () => {}, extra: 7 }) };
		const r = resolver("bash", () => base);
		const branch: Any[] = [
			{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(5000) }] } },
			{ id: "e1", type: "context_edit", targetId: "r1", replacement: { content: [{ type: "text", text: "[folded by pi-zip · bash" }] } },
		];
		const { ctx } = fakeCtx([], { branch });
		await f.handlers.get("session_start")({}, ctx);
		const folded = r.renderCall({ command: "npm test" }, th, { toolCallId: "c1" });
		expect(folded.render(60)[0].trimEnd()).toBe("$ npm test  ƶ zipped");
		expect(folded.extra).toBe(7); // everything else passes through
		expect(r.renderCall({ command: "ls" }, th, { toolCallId: "c2" }).render(60)).toEqual(["$ ls"]);
		expect(resolver("zip_recall", () => base)).toBe(base);
	});
});

describe("transcript wiring", () => {
	const setup = async (branch: Any[] = [], over: Any = {}) => {
		const { default: piZip } = await import("../src/index.ts");
		const renderers = new Map<string, Any>();
		const f = fakePi({ registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn), registerToolRenderer: () => {}, ...over });
		piZip(f.pi);
		const { ctx, notes } = fakeCtx([], { branch });
		const render = (e: Any, w = 120, expanded = false) => renderers.get("pi-zip/notice")({ data: e.data }, { expanded }, th).render(w);
		return { f, ctx, notes, render };
	};
	test("/zip status is a card in the transcript; off/on/quiet are state lines", async () => {
		const { f, ctx, notes, render } = await setup();
		await f.handlers.get("session_start")({}, ctx);
		const cmd = f.handlers.get("cmd:zip");
		await cmd.handler("status", ctx);
		await cmd.handler("off", ctx);
		await cmd.handler("on", ctx);
		await cmd.handler("quiet", ctx);
		expect(notes).toHaveLength(0);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept.map((x: Any) => x.data.kind)).toEqual(["card", "state", "state", "state"]);
		const c = render(kept[0]);
		expect(c[0]).toBe("ƶ pi-zip  on");
		expect(c.join("\n")).toContain("model    p/m");
		// the declared 5-min TTL, nothing learned yet: bars up to the 5m tick, then dead
		expect(c.join("\n")).toContain(`cache    ${"\u2588".repeat(14)}${"\u2581".repeat(18)}  expires after ~5 min idle`);
		expect(c.join("\n")).toContain("away         1m       5m");
		expect(c.join("\n")).toContain("session  0 zipped ~0K");
		expect(render(kept[1])[0]).toStartWith("ƶ pi-zip  off  Nothing is folded");
		expect(render(kept[2])[0]).toBe("ƶ pi-zip  on  folding resumes");
		expect(render(kept[3])[0]).toBe("ƶ pi-zip  quiet  per-turn notices off (folding continues)");
	});
	test("a notice shows the real size of the request that carried its plan once that request is answered (estimate before; errors skipped; old notices unchanged)", async () => {
		const { default: piZip } = await import("../src/index.ts");
		const renderers = new Map<string, Any>();
		const f = fakePi({ registerEntryRenderer: (t: string, fn: Any) => renderers.set(t, fn), registerToolRenderer: () => {} });
		piZip(f.pi);
		const branch: Any[] = [];
		let walks = 0;
		const { ctx } = fakeCtx([], { sessionManager: { getBranch: () => (walks++, branch), getEntryCount: () => branch.length, buildSessionProjection: () => ({ entries: [] }) } });
		await f.handlers.get("session_start")({}, ctx);
		const t0 = Date.now();
		const data = { v: 2, text: "x", before: 74_000, after: 43_000, desc: "zipped 12 old outputs in 6 ms", reqTs: t0 };
		const render = (d: Any) => renderers.get("pi-zip/notice")({ id: "n1", data: d }, { expanded: false }, th).render(120)[0];
		walks = 0;
		expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms"); // not answered yet: the estimate
		render(data);
		expect(walks).toBe(1); // nothing new in the session: not looked at again
		branch.push({ type: "message", id: "a0", message: { role: "assistant", timestamp: t0 - 5, usage: { input: 1, cacheRead: 99_000, cacheWrite: 0 } } }); // an earlier request
		branch.push({ type: "message", id: "a1", message: { role: "assistant", timestamp: t0 + 3, stopReason: "error", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } }); // failed: its retry carries the plan
		expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms");
		branch.push({ type: "message", id: "a2", message: { role: "assistant", timestamp: t0 + 9, stopReason: "toolUse", usage: { input: 1_200, cacheRead: 38_000, cacheWrite: 1_300 } } });
		expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 40.5K   6 ms"); // input + cacheRead + cacheWrite
		const w = walks;
		branch.push({ type: "message", id: "a3", message: { role: "assistant", timestamp: t0 + 20, usage: { input: 5, cacheRead: 60_000, cacheWrite: 0 } } });
		for (let i = 0; i < 5; i++) expect(render(data)).toBe("ƶ zipped 12 old outputs   74K → 40.5K   6 ms");
		expect(walks).toBe(w); // found once, kept
		expect(render({ ...data, reqTs: undefined })).toBe("ƶ zipped 12 old outputs   74K → 43K   6 ms"); // a notice from before: as it was
	});
	test("print mode: /zip status stays plain text on stderr, nothing appended", async () => {
		const { f, ctx } = await setup();
		ctx.mode = "print";
		const w = process.stderr.write;
		let out = "";
		process.stderr.write = ((s: string) => ((out += s), true)) as Any;
		try {
			await f.handlers.get("cmd:zip").handler("status", ctx);
		} finally {
			process.stderr.write = w;
		}
		expect(out).toContain("pi-zip: on");
		expect(f.appended.filter((x: Any) => x.customType === "pi-zip/notice")).toHaveLength(0);
	});
	test("a tool allowlist that hides zip_recall, read, grep and bash: one reread-only line per session", async () => {
		const { f, ctx, render } = await setup([], { getActiveTools: () => ["edit", "write"] });
		await f.handlers.get("session_start")({}, ctx);
		await f.handlers.get("before_agent_start")({}, ctx);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		expect(render(kept[0])[0]).toStartWith("ƶ pi-zip  reread-only  a tool allowlist hides zip_recall");
	});
	test("an allowlist that hides zip_recall but keeps read or bash: file recall is a full mode, one 'on' line naming the recall directory", async () => {
		const { f, ctx, render } = await setup([], { getActiveTools: () => ["read", "bash"] });
		ctx.sessionManager.getSessionId = () => "01a120cb-3d40-75a6-aeac-320e71967606";
		ctx.sessionManager.getSessionFile = () => "/tmp/pi-zip-test-sessions/s.jsonl";
		await f.handlers.get("session_start")({}, ctx);
		await f.handlers.get("before_agent_start")({}, ctx);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept).toHaveLength(1);
		const where = join(process.env.XDG_CACHE_HOME!, "pi-zip", "recall"); // where the copies are ($XDG_CACHE_HOME here), not always ~/.cache
		expect(render(kept[0], 200)[0]).toBe(`ƶ pi-zip  on  a tool allowlist hides zip_recall · zipped outputs are read back from files in ${where}`);
		// the card: on, with the unzip row; the chart rows are untouched
		await f.handlers.get("cmd:zip").handler("status", ctx);
		const card = render(f.appended.filter((x: Any) => x.customType === "pi-zip/notice").at(-1), 200);
		expect(card[0]).toBe("ƶ pi-zip  on");
		expect(card).toContain(`  unzip    from files in ${where} (a tool allowlist hides zip_recall)`);
		expect(card.some((l: string) => l.startsWith("  away "))).toBe(true);
	});
	test("a read or grep of a recall file is drawn like zip_recall's row", async () => {
		const { default: piZip } = await import("../src/index.ts");
		let resolver: Any = null;
		const f = fakePi({ registerToolRenderer: (r: Any) => (resolver = r), registerEntryRenderer: () => {} });
		piZip(f.pi);
		const base = { renderCall: (args: Any) => ({ render: () => [`read ${args.path}`], invalidate: () => {} }) };
		const sid = "01a120cb-3d40-75a6-aeac-320e71967606";
		const read = resolver("read", () => base).renderCall({ path: `~/.cache/pi-zip/recall/${sid}/k3f9a0x1qz.txt`, offset: 120, limit: 40 }, th, { toolCallId: "c1" });
		expect(read.render(80)).toEqual(["ƶ unzip k3f9a0x1qz  lines 120-159"]);
		const grep = resolver("grep", () => base).renderCall({ pattern: "SKU-03903", path: `~/.cache/pi-zip/recall/${sid}` }, th, { toolCallId: "c2" });
		expect(grep.render(80)).toEqual(["ƶ unzip all outputs  /SKU-03903/"]);
		expect(resolver("read", () => base).renderCall({ path: "src/a.ts" }, th, { toolCallId: "c3" }).render(80)).toEqual(["read src/a.ts"]);
	});
	test("a conflicting context manager: a paused line", async () => {
		const { f, ctx, render } = await setup([], { getAllTools: () => [{ name: "compress", sourceInfo: { path: "/x/node_modules/billion-context/index.js" } }] });
		await f.handlers.get("session_start")({}, ctx);
		const kept = f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(kept.map((x: Any) => x.data.word)).toEqual(["paused"]);
		expect(render(kept[0])[0]).toContain("paused  billion-context also manages context");
	});
	test("the welcome line appears once per machine, in the TUI only", async () => {
		const flag = join(dirname(process.env.PI_ZIP_CACHE_STATS!), "welcomed");
		rmSync(flag, { force: true });
		const a = await setup();
		await a.f.handlers.get("session_start")({}, a.ctx);
		const w = a.f.appended.filter((x: Any) => x.customType === "pi-zip/notice");
		expect(w).toHaveLength(1);
		expect(a.render(w[0])[0]).toBe("ƶ pi-zip  on  old tool output gets zipped once the prompt cache expires (5 min here) · /zip");
		expect(existsSync(flag)).toBe(true);
		const b = await setup();
		await b.f.handlers.get("session_start")({}, b.ctx);
		expect(b.f.appended.filter((x: Any) => x.customType === "pi-zip/notice")).toHaveLength(0);
	});
});
