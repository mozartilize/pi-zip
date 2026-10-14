// Transcript surfaces (pure, testable): the status card, state lines, the zip_recall row and the fold mark on a folded output.
// One visual grammar everywhere: the monogram ƶ (bold, accent) says whose line it is, the words zip / zipped / unzip say what
// happened, the one bright thing is the size now; everything else is dim, no boxes, no other symbols.
// Collapsed = the conclusion, click or ctrl+o = the detail. Every returned line fits the given width.
// ƶ (U+01B6) is a Latin letter: East Asian width N, so one column in every terminal and locale; fonts without it fall back.
import { PRODUCT } from "./util.ts";

export interface Th {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}
/** Display width and truncation: Pi's visibleWidth / truncateToWidth in the renderer, string length in tests. */
export interface Measure {
	vw(s: string): number;
	cut(s: string, width: number): string; // plain text, at most width columns, with "…" when cut
}
export const plainMeasure: Measure = {
	vw: (s) => s.length,
	cut: (s, w) => (s.length <= w ? s : w <= 0 ? "" : s.slice(0, w - 1) + "…"),
};
/** The measure renderers use: index.ts swaps in Pi's own (pi-tui) when it loads. */
export let measure: Measure = plainMeasure;
export function setMeasure(m: Measure) {
	measure = m;
}

/** The pi-zip monogram: z for zip, the stroke is the slider. */
export const SYM = "ƶ";
export const brand = (th: Th): string => th.fg("accent", th.bold ? th.bold(SYM) : SYM);
const LABEL_W = 9;

/** Plain text without control characters (tabs become two spaces): recalled output goes into the TUI as text, never as escape codes. */
export const clean = (s: string): string => s.replace(/\t/g, "  ").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

// ---- state lines -------------------------------------------------------------------------------------------------------

export type StateWord = "on" | "off" | "paused" | "reread-only" | "quiet" | "notices on" | "cache";
const WARN = new Set<StateWord>(["off", "paused", "reread-only"]);

/** "ƶ pi-zip  paused  billion-context also manages context · run: pi remove npm:billion-context" */
export function renderState(word: StateWord, reason: string, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const wordC = th.fg(WARN.has(word) ? "warning" : word === "on" ? "success" : "muted", word);
	const base = `${SYM} ${PRODUCT}  ${word}`;
	if (m.vw(base) > width) return m.vw(word) <= width ? [wordC] : [];
	const room = width - m.vw(base) - 2;
	const r = reason && room >= 12 ? m.cut(reason, room) : "";
	return [`${brand(th)} ${th.fg("muted", PRODUCT)}  ${wordC}${r ? "  " + th.fg("dim", r) : ""}`];
}

// ---- status card ------------------------------------------------------------------------------------------------------

/** One learned gap bin of the cache chart: how many times you came back after a gap in [lo, hi) s and the cache was still there / gone.
 *  Counts are rounded decayed weights (learn.ts keeps no raw per-bin count: old evidence halves after HALF_LIFE newer ones of the bin). */
export interface ChartBin { lo: number; hi: number; alive: number; gone: number }

export interface CardData {
	state: "on" | "off" | "paused" | "reread-only";
	stateNote?: string; // why paused / reread-only
	model?: string; // provider/id
	life?: string; // "~5 min" | "~1 h" | "2 h+": how long the cache outlives the last reply (the declared TTL until something is learned)
	bins?: ChartBin[]; // learned bins that round to at least one return; none = nothing learned yet: one line, no chart
	s1?: number; // seconds: the cache is (nearly) always still there under this (learned curve, never the prior)
	s2?: number; // seconds: it is mostly gone from here on; between s1 and s2 it is not sure yet
	usually?: boolean; // some bin under s1 has P(still there) < 0.95: "usually still there" instead of "still there"
	folds: number;
	foldedTokens: string; // "310K"
	summaries: number;
	summaryUsd: number;
	recalls: number;
	last?: string; // "10:50  folded 12 old outputs · cache cold (away 47 min)"
	quiet: boolean;
	unzip?: string; // how the model gets folded outputs back, when it is not zip_recall (file recall under a tool allowlist)
	failed?: number; // summary calls of this session whose narrative failed (each still a summary: the fallback)
	failedWhy?: string; // "07:10 narrative hit the token cap": when and why the newest one failed
}

/** "~5 min", "~1 h", "~2.5 h" */
export function fmtLife(s: number): string {
	if (s < 90) return `~${Math.round(s)} s`;
	if (Math.round(s / 60) < 60) return `~${Math.round(s / 60)} min`;
	return `~${+(s / 3600).toFixed(1)} h`;
}

// ---- the cache chart: one dot per time you came back ----------------------------------------------------------------------
// Across: how long you were away, 30 s to 2 h on a log scale. Above the axis (accent): the times the cache was still there, below
// (dim): the times it was gone. The axis itself says what to expect: solid while it is (nearly) always there, dashed while not sure,
// thin after it is gone. A column shows at most STACK_CAP marks; beyond that STACK_CAP - 1 dots and then the count.

export const CHART_W = 60; // columns 0..CHART_W
const CT0 = 30, CT1 = 7200;
export const STACK_CAP = 4;
const IND = 11; // the values column of the card: "  " + the 9-wide label
export const colW = (s: number): number => Math.round((CHART_W * Math.log(s / CT0)) / Math.log(CT1 / CT0));
const gapW = (c: number): number => CT0 * (CT1 / CT0) ** (c / CHART_W);
const AXIS_TICKS: [number, string][] = [[30, "30s"], [60, "1m"], [120, "2m"], [300, "5m"], [600, "10m"], [1800, "30m"], [3600, "1h"], [7200, "2h"]];
const fmtGap = (s: number): string => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${+(s / 60).toFixed(1)} min` : `${+(s / 3600).toFixed(1)} h`);

/** What the marks of one side of the axis look like, as rows from the axis outwards: row r (1-based) holds, per column, a dot, a digit of
 *  the count or a blank. `items` are (column, times); items on the same column merge. A count is drawn on the row of the stack's end,
 *  centred on its column; when that would touch another mark in its row (neighbouring columns, other counts) it moves, the nearest free
 *  place first, right before left, and keeps one blank on each side, so two counts never read as one number. Deterministic. */
export function stackRows(items: { col: number; n: number }[], dot: string = "\u25cf", cap: number = STACK_CAP, width: number = CHART_W + 1): { rows: string[][]; height: number } {
	const merged = new Map<number, number>();
	for (const it of items) {
		const col = Math.max(0, Math.min(width - 1, it.col));
		if (it.n > 0) merged.set(col, (merged.get(col) ?? 0) + it.n);
	}
	const cols = [...merged.entries()].sort((a, b) => a[0] - b[0]);
	const height = Math.max(1, ...cols.map(([, n]) => Math.min(n, cap)));
	const rows = Array.from({ length: height }, () => Array<string>(width).fill(" "));
	const counts: { col: number; text: string; row: number }[] = [];
	for (const [col, n] of cols) {
		const dots = n <= cap ? n : cap - 1;
		for (let r = 0; r < dots; r++) rows[r][col] = dot;
		if (n > cap) counts.push({ col, text: String(n), row: cap - 1 });
	}
	for (const { col, text, row } of counts) {
		const len = text.length, want = col - Math.floor((len - 1) / 2), line = rows[row];
		const free = (st: number, gap: boolean) => {
			if (st < 0 || st + len > width) return false;
			for (let x = st - (gap ? 1 : 0); x < st + len + (gap ? 1 : 0); x++) if (x >= 0 && x < width && line[x] !== " ") return false;
			return true;
		};
		let at = -1;
		for (const gap of [true, false]) {
			for (let d = 0; d < width && at < 0; d++) for (const st of d ? [want + d, want - d] : [want]) if (at < 0 && free(st, gap)) at = st;
			if (at >= 0) break;
		}
		if (at >= 0) for (let k = 0; k < len; k++) line[at + k] = text[k];
	}
	return { rows, height };
}

/** Colours the cells of a row (one string per column, null = blank) with as few runs as possible. */
function paint(cells: { ch: string; color: string }[], th: Th): string {
	let out = "", run = "", color = "";
	const flush = () => { if (run) out += color ? th.fg(color, run) : run; run = ""; };
	for (const c of cells) {
		if (c.color !== color) flush(), (color = c.color);
		run += c.ch;
	}
	flush();
	return out.trimEnd();
}

interface Seg { lead: string; word: string; color: string }
/** "under 5 min: usually still there · 5–10 min: not sure yet · over 10 min: gone", as segments that wrap whole. */
function captionSegs(c: CardData): Seg[] {
	const s1 = c.s1 ?? CT0, s2 = c.s2 ?? CT1;
	const range = s1 >= 60 && s2 < 3600 ? `${+(s1 / 60).toFixed(1)}–${fmtGap(s2)}` : `${fmtGap(s1)}–${fmtGap(s2)}`; // "5–10 min"
	return [
		{ lead: `under ${fmtGap(s1)}: `, word: c.usually ? "usually still there" : "still there", color: "accent" },
		...(s2 > s1 ? [{ lead: `${range}: `, word: "not sure yet", color: "warning" }] : []),
		{ lead: `over ${fmtGap(s2)}: `, word: "gone", color: "muted" },
	];
}
const SEP = "  \u00b7  ";
const segW = (g: Seg) => g.lead.length + g.word.length;
/** The caption as lines of at most `room` columns, wrapped between segments (a segment wider than the room is cut). */
function captionLines(segs: Seg[], room: number, th: Th, m: Measure): string[] {
	if (room < 2) return []; // no room for even a cut sentence
	const lines: Seg[][] = [[]];
	for (const g of segs) {
		const cur = lines[lines.length - 1], w = cur.reduce((a, x) => a + segW(x), 0) + SEP.length * cur.length + segW(g);
		if (cur.length && w > room) lines.push([g]);
		else cur.push(g);
	}
	return lines.map((l) => {
		const plain = l.map((g) => g.lead + g.word).join(SEP);
		if (plain.length > room) return th.fg("dim", m.cut(plain, room));
		return l.map((g) => th.fg("dim", g.lead) + th.fg(g.color, g.word)).join(th.fg("dim", SEP));
	});
}
const captionPlain = (c: CardData) => captionSegs(c).map((g) => g.lead + g.word).join(SEP);

const idle = (c: CardData): string => (c.life ? `expires after ${c.life} idle` : "");
const NO_DATA = "a chart appears once you come back after a break";
const hasChart = (c: CardData): boolean => !!c.model && !!c.bins?.length;

export function cardText(c: CardData): string[] {
	const rows: [string, string][] = [];
	if (c.model) rows.push(["model", c.model]);
	if (c.model) rows.push(["cache", hasChart(c) ? `each dot is one time you came back · ${captionPlain(c)}` : `${idle(c) || "expires after ~5 min idle"} · ${NO_DATA}`]);
	const n = (x: number, one: string, many = one + "s") => `${x} ${x === 1 ? one : many}`;
	rows.push(["session", `${c.folds} zipped ~${c.foldedTokens}  ·  ${n(c.summaries, "summary", "summaries")}${c.summaryUsd > 0 ? ` $${c.summaryUsd.toFixed(2)}` : ""}  ·  ${n(c.recalls, "unzip")}`]);
	if (c.last) rows.push(["last", c.last]);
	if (c.failed) rows.push(["errors", `${n(c.failed, "narrative call")} failed${c.failedWhy ? ` · last ${c.failedWhy}` : ""}`]);
	if (c.unzip) rows.push(["unzip", c.unzip]);
	if (c.quiet) rows.push(["notices", "off  (/zip quiet turns them back on)"]); // the default says nothing, so it is not shown
	return rows.map(([k, v]) => `${k.padEnd(LABEL_W)}${v}`);
}

/** The chart rows (without the model row): header, marks above, axis, marks below, axis labels, [legend], caption. */
function chartRows(c: CardData, width: number, th: Th, m: Measure): string[] {
	const indent = "  ", label = (k: string) => th.fg("dim", (indent + k).padEnd(indent.length + LABEL_W)), pad = " ".repeat(IND);
	const bins = c.bins ?? [];
	const na = bins.reduce((a, b) => a + b.alive, 0), nd = bins.reduce((a, b) => a + b.gone, 0);
	const up = stackRows(bins.map((b) => ({ col: colW(Math.sqrt(b.lo * b.hi)), n: b.alive })));
	const down = stackRows(bins.map((b) => ({ col: colW(Math.sqrt(b.lo * b.hi)), n: b.gone })), "\u25cb");
	const legUp = ["\u25cf", ` still there  ${na}`], legDown = ["\u25cb", ` gone  ${nd}`];
	const legW = (l: string[]) => l[0].length + l[1].length;
	const beside = width >= IND + CHART_W + 1 + 3 + Math.max(legW(legUp), legW(legDown));
	const s1 = c.s1 ?? CT0, s2 = c.s2 ?? CT1;
	const out: string[] = [label("cache") + th.fg("dim", "each dot is one time you came back")];
	const side = (rows: string[][], color: string, leg: string[], first: number) =>
		rows.map((cells, r) => {
			const line = paint(cells.map((ch) => ({ ch, color: ch === " " ? "" : color })), th);
			return pad + line + (beside && r === first ? "   " + th.fg(color, leg[0]) + th.fg("muted", leg[1]) : "");
		});
	out.push(...side(up.rows.slice().reverse(), "accent", legUp, up.height - 1)); // outermost row first; the legend sits on the row next to the axis
	out.push(pad + paint(Array.from({ length: CHART_W + 1 }, (_, i) => ({ ch: gapW(i) < s1 ? "\u2501" : gapW(i) < s2 ? "\u2505" : "\u2500", color: gapW(i) < s1 ? "accent" : gapW(i) < s2 ? "warning" : "dim" })), th));
	out.push(...side(down.rows, "dim", legDown, 0));
	const ax = Array<string>(CHART_W + 3).fill(" ");
	for (const [t, lab] of AXIS_TICKS) {
		const col = Math.min(colW(t), CHART_W - lab.length + 1);
		for (let k = 0; k < lab.length; k++) ax[col + k] = lab[k];
	}
	out.push(label("away") + th.fg("dim", ax.join("").trimEnd()));
	if (!beside) out.push(pad + th.fg("accent", legUp[0]) + th.fg("muted", legUp[1]) + "   " + th.fg("dim", legDown[0]) + th.fg("muted", legDown[1]));
	for (const l of captionLines(captionSegs(c), width - IND, th, m)) out.push(pad + l);
	return out;
}

export function renderCard(c: CardData, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const out = renderState(c.state, c.stateNote ?? "", width, th, m);
	const indent = "  "; // under the words after the monogram
	const head = (k: string) => th.fg("dim", (indent + k).padEnd(indent.length + LABEL_W));
	const row = (k: string, v: string) => {
		const line = m.cut(indent + k.padEnd(LABEL_W) + v, width);
		if (!line) return;
		const kk = line.slice(0, indent.length + LABEL_W);
		out.push(th.fg("dim", kk) + th.fg("dim", line.slice(kk.length)));
	};
	if (c.model) {
		row("model", c.model);
		if (!hasChart(c)) {
			// nothing learned yet: one line, the chart appears with the first return after a break
			const room = width - indent.length - LABEL_W;
			const v = [`${idle(c) || "expires after ~5 min idle"} \u00b7 ${NO_DATA}`, idle(c) || "expires after ~5 min idle"].find((x) => m.vw(x) <= room);
			if (v) out.push(head("cache") + th.fg("dim", v));
			else row("cache", idle(c) || "expires after ~5 min idle");
		} else if (width >= IND + CHART_W + 1) out.push(...chartRows(c, width, th, m));
		else {
			// too narrow for the chart: the caption sentence alone says the same thing
			const lines = captionLines(captionSegs(c), width - IND, th, m);
			lines.forEach((l, i) => out.push((i ? " ".repeat(IND) : head("cache")) + l));
		}
	}
	for (const r of cardText({ ...c, model: undefined })) {
		if (r.startsWith("unzip ")) {
			// Narrow: the bracketed reason goes first, so where the files are stays whole.
			const h = head("unzip"), room = width - m.vw(h);
			const v = [r.slice(LABEL_W), r.slice(LABEL_W).replace(/ \([^()]*\)$/, "")].find((x) => m.vw(x) <= room);
			if (v) { out.push(th.fg("dim", h + v)); continue; }
		}
		const line = m.cut(indent + r, width);
		if (!line) continue;
		const k = line.slice(0, indent.length + LABEL_W), v = line.slice(indent.length + LABEL_W);
		out.push(th.fg("dim", k) + (r.startsWith("session") ? th.fg("text", v) : r.startsWith("errors") ? th.fg("warning", v) : th.fg("dim", v)));
	}
	return out;
}

// ---- zip_recall row ------------------------------------------------------------------------------------------------------

export interface RecallSectionInfo {
	handle: string;
	label?: string; // "bash npm test"
	turn?: number;
	totalLines?: number;
	shownLines?: number;
	how?: "all" | "grep" | "range" | "page";
	missing?: boolean;
}

/** "ƶ unzip src/learn.ts:1-2000  /HALF_LIFE/": the same shape as Pi's own tool rows (bold name, accent argument) after the monogram;
 *  the argument says WHAT comes back (the folded output's label), not its handle. `labelOf` maps a handle to that label when known. */
export function recallCallLine(args: { handle?: string; handles?: string[]; grep?: string; range?: string; offset?: number }, width: number, th: Th, m: Measure = plainMeasure, labelOf: (h: string) => string | undefined = () => undefined): string[] {
	const hs = [...(typeof args?.handle === "string" ? [args.handle] : []), ...(Array.isArray(args?.handles) ? args.handles.filter((h) => typeof h === "string") : [])];
	const label = (h: string) => (labelOf(h.trim()) ?? h).replace(/^read /, ""); // "read src/a.ts" reads as "unzip src/a.ts"
	const what = hs.length > 1 ? `${hs.length} outputs` : hs[0] ? label(hs[0]) : args?.grep ? "all outputs" : ""; // grep without a handle searches every output
	const opt = [args?.grep ? `/${args.grep}/` : "", args?.range ? `lines ${args.range}` : "", args?.offset ? `from char ${args.offset}` : ""].filter(Boolean).join(" · ");
	const head = `${SYM} unzip`;
	const plain = m.cut(`${head} ${what}${opt ? "  " + opt : ""}`, width);
	const bold = (t: string) => (th.bold ? th.bold(t) : t);
	if (!plain.startsWith(head + " ")) return [th.fg("dim", plain)];
	const w = plain.slice(head.length + 1, head.length + 1 + what.length);
	return [brand(th) + " " + th.fg("toolTitle", bold("unzip")) + " " + th.fg("accent", w) + th.fg("dim", plain.slice(head.length + 1 + w.length))];
}

export function sectionLine(s: RecallSectionInfo, many = false): string {
	if (s.missing) return `${s.handle} not found`;
	const total = s.totalLines ?? 0;
	const got = s.how === "all" ? `all ${total} lines` : `${s.shownLines ?? 0} of ${total} lines`;
	return many ? `${s.label || s.handle}  ${got}` : got;
}

const RECALL_FRAME = /^\[(handle \S+( · |\]| not found)|grep( \(|: | over )|range: lines |chars \d+-\d+ of |… \d+ more chars: )/;

/** Collapsed: what came back ("2 of 142 lines"; one line per output for a batch). Expanded: the recalled text, at most maxLines. */
export function recallResultLines(sections: RecallSectionInfo[], text: string, expanded: boolean, width: number, th: Th, m: Measure = plainMeasure, maxLines = 40): string[] {
	const out: string[] = [];
	for (const s of sections) {
		const l = m.cut(sectionLine(s, sections.length > 1), width);
		if (l) out.push(s.missing ? th.fg("error", l) : th.fg("dim", l));
	}
	if (!sections.length && text) out.push(th.fg("dim", m.cut(clean(text.split("\n")[0]), width)));
	if (!expanded || !text) return out;
	// the model's framing lines ("[handle … · 117 lines]", "[grep: 0 matching line(s) of 117]", page notes) repeat the row above: the user sees only the text
	const lines = clean(text).split("\n").filter((l) => !RECALL_FRAME.test(l));
	if (!lines.some((l) => l.trim())) return out;
	for (const l of lines.slice(0, maxLines)) out.push(th.fg("toolOutput", m.cut(l, width)));
	if (lines.length > maxLines) out.push(th.fg("dim", m.cut(`… ${lines.length - maxLines} more lines (the model got them all)`, width)));
	return out;
}

// ---- the mark on a folded output ---------------------------------------------------------------------------------------

/** "$ npm test  ƶ zipped": the mark follows the call row's own text, if it fits; otherwise the row is left alone. */
export function markFirstLine(lines: string[], handle: string, width: number, th: Th, m: Measure = plainMeasure): string[] {
	if (!lines.length) return lines;
	// the handle is in the notice (click / ctrl+o) and in the model's view; here it would only be noise
	// renderers often pad a row to the full width (and may close styles after the padding): drop the padding, keep the codes
	const first = lines[0].replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
	const markW = 2 + m.vw(`${SYM} zipped`);
	if (m.vw(first) + markW > width) return lines;
	const pad = width - m.vw(first) - markW; // keep the row as wide as it was (Pi pads rows to the full width)
	return [first + "  " + brand(th) + th.fg("dim", " zipped") + " ".repeat(pad), ...lines.slice(1)];
}
