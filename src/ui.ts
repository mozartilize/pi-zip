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

export interface CardData {
	state: "on" | "off" | "paused" | "reread-only";
	stateNote?: string; // why paused / reread-only
	model?: string; // provider/id
	life?: string; // "~5 min" | "~1 h" | "2 h+": how long the cache outlives the last reply
	measured?: boolean; // life comes from this provider's own replies, not the declared TTL
	folds: number;
	foldedTokens: string; // "310K"
	summaries: number;
	summaryUsd: number;
	recalls: number;
	last?: string; // "10:50  folded 12 old outputs · cache cold (away 47 min)"
	quiet: boolean;
}

/** "~5 min", "~1 h", "~2.5 h" */
export function fmtLife(s: number): string {
	if (s < 90) return `~${Math.round(s)} s`;
	if (Math.round(s / 60) < 60) return `~${Math.round(s / 60)} min`;
	return `~${+(s / 3600).toFixed(1)} h`;
}

export function cardText(c: CardData): string[] {
	const rows: [string, string][] = [];
	// Plain words only: one fact the user can act on ("come back within ~5 min and nothing is touched"), no classes, no curves.
	if (c.model) rows.push(["cache", `${c.model}${c.life ? ` · expires after ${c.life} idle${c.measured ? " (measured)" : ""}` : ""}`]);
	const n = (x: number, one: string, many = one + "s") => `${x} ${x === 1 ? one : many}`;
	rows.push(["session", `${c.folds} zipped ~${c.foldedTokens}  ·  ${n(c.summaries, "summary", "summaries")}${c.summaryUsd > 0 ? ` $${c.summaryUsd.toFixed(2)}` : ""}  ·  ${n(c.recalls, "unzip")}`]);
	if (c.last) rows.push(["last", c.last]);
	if (c.quiet) rows.push(["notices", "off  (/zip quiet turns them back on)"]); // the default says nothing, so it is not shown
	return rows.map(([k, v]) => `${k.padEnd(LABEL_W)}${v}`);
}

export function renderCard(c: CardData, width: number, th: Th, m: Measure = plainMeasure): string[] {
	const out = renderState(c.state, c.stateNote ?? "", width, th, m);
	const indent = "  "; // under the words after the monogram
	for (const row of cardText(c)) {
		const line = m.cut(indent + row, width);
		if (!line) continue;
		const k = line.slice(0, indent.length + LABEL_W), v = line.slice(indent.length + LABEL_W);
		out.push(th.fg("dim", k) + (row.startsWith("session") ? th.fg("text", v) : th.fg("dim", v)));
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
