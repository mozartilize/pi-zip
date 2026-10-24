// Recall through files (research pi-tricks §2). A tool allowlist (`pi --tools read,grep,bash`, sub-agent launchers) hides zip_recall,
// but read, grep or bash may still be there: a folded output then names a file those tools can read, and the file is written on
// demand, from the session, the moment a tool call names it. Placeholders say ~/.cache/pi-zip/recall/<session id>/<handle>.txt;
// a tool_call hook points any such path (any prefix: another machine, another user, a forked session) at this machine's copy.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { attempt } from "./util.ts";

/** What placeholders and summaries name: portable, `~` is expanded by read, grep, find and ls, and by the shell. */
export const RECALL_DIR = "~/.cache/pi-zip/recall";
/** Copies older than this are deleted at session start; they can be written again from the session at any time. */
export const RECALL_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Where the copies live on this machine: $XDG_CACHE_HOME/pi-zip/recall, else ~/.cache/pi-zip/recall. A relative XDG_CACHE_HOME is
 *  ignored, as the XDG spec says (it would put the copies in the project folder, where they could be committed). */
export const recallRoot = (): string => {
	const xdg = process.env.XDG_CACHE_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "pi-zip", "recall");
};
/** recallRoot() as the user is shown it (state line, /zip card): the home directory as ~. */
export const recallRootShown = (): string => {
	const r = recallRoot(), h = homedir();
	return h && h !== sep && r.startsWith(h + sep) ? `~${r.slice(h.length)}` : r;
};

/** A session id as a directory name (Pi's ids are UUIDs; anything else is reduced to safe characters). */
export const sidDir = (sid: string): string => sid.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 80);

/** The tools that can read a recall file, as they are active in this session. */
export interface FileRecall {
	dir: string; // what the model is told: RECALL_DIR/<session id>
	read: boolean;
	grep: boolean;
	bash: boolean;
}

export const fileRecallFor = (sid: string, active: { read: boolean; grep: boolean; bash: boolean }): FileRecall => ({ dir: `${RECALL_DIR}/${sidDir(sid)}`, ...active });

/** How to read a recall file, naming only the tools that are active ("read it (offset/limit for pages) or grep it"). */
export function fileRecallHow(f: FileRecall): string {
	const ways: string[] = [];
	if (f.read) ways.push("read it (offset/limit for pages)");
	else if (f.bash) ways.push("read it with bash (sed -n for pages)");
	if (f.grep) ways.push("grep it");
	else if (f.bash) ways.push("grep -n it with bash");
	return ways.join(" or ");
}

const SID = "[0-9A-Za-z][0-9A-Za-z_-]{0,79}";
const SID_RE = new RegExp(`^${SID}$`);
/** What materialize writes in a session directory: <handle>.txt or requests.txt, and .<pid>.tmp while writing. Cleanup deletes nothing else. */
const COPY_RE = /^(?:[0-9a-z]{10}|requests)\.txt(\.\d+\.tmp)?$/;
const FILE_RE = new RegExp(`(?:^|/)pi-zip/recall/${SID}/([0-9a-z]{10}|requests)\\.txt$`);
const DIR_RE = new RegExp(`(?:^|/)pi-zip/recall/${SID}/?$`);

/** A path that names a recall file ({ handle }) or a session's recall directory ({}); null for anything else. */
export function parseRecallPath(p: unknown): { handle?: string; requests?: boolean } | null {
	if (typeof p !== "string") return null;
	const f = FILE_RE.exec(p);
	if (f) return f[1] === "requests" ? { requests: true } : { handle: f[1] };
	return DIR_RE.test(p) ? {} : null;
}

/** Recall paths in a shell command: a word that runs into pi-zip/recall/<session>, with /<handle>.txt or not (the directory, a glob in it).
 *  The path starts after any quote, operator, `=` (`X=<path>`, `--file=<path>`), `,`, `{` or `}` (brace expansion); `${HOME}` and the
 *  like are part of it. */
const CMD_RE = new RegExp(`(?:\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|[^\\s'"\`<>|;&(){},=])*pi-zip/recall/${SID}(/(?:[0-9a-z]{10}|requests)\\.txt\\b)?`, "g");
/** CMD_RE needs this literal, and the unanchored regex costs ~40 us per command (it retries every start in a word). Checking the
 *  literal first gives the same answers and keeps a scan of a long branch's commands, at every turn_end, in milliseconds. */
const CMD_LIT = "pi-zip/recall/";
export const commandNamesRecall = (cmd: unknown): boolean => typeof cmd === "string" && cmd.includes(CMD_LIT) && new RegExp(CMD_RE.source).test(cmd);
/** The handles of the recall files a shell command names. */
export const commandRecallHandles = (cmd: unknown): string[] =>
	typeof cmd === "string" && cmd.includes(CMD_LIT)
		? [...cmd.matchAll(CMD_RE)].filter((m) => m[1] && m[1] !== "/requests.txt").map((m) => m[1].slice(1, 11))
		: [];

/** The command with every recall path pointed at `localDir`, the handles it names, and whether it names the directory itself.
 *  A local directory that would need shell quoting is not written in (the shell then reads ~/.cache, where the copies are when
 *  XDG_CACHE_HOME is unset). */
export function rewriteCommand(cmd: string, localDir: string): { command: string; handles: string[]; dir: boolean; requests?: boolean } {
	const handles: string[] = [];
	let dir = false;
	let requests = false;
	const safe = /^[\w@%+=:,./-]+$/.test(localDir);
	const command = cmd.replace(CMD_RE, (m: string, file?: string) => {
		if (file === "/requests.txt") requests = true;
		else if (file) handles.push(file.slice(1, 11));
		else dir = true;
		return safe ? `${localDir}${file ?? ""}` : m;
	});
	return requests ? { command, handles, dir, requests } : { command, handles, dir };
}

/** A copy on disk is the original only when it is a plain file holding exactly its bytes: a bash command may append to it or edit it
 *  in place (the rewrite points writes at it too), and write and edit are not hooked. */
function intact(file: string, bytes: Buffer): boolean {
	return attempt(() => { const st = lstatSync(file); return st.isFile() && st.size === bytes.length && readFileSync(file).equals(bytes); }, false);
}

/** Write each original that is not on disk as it is (directory 0700, file 0600, written whole then renamed over anything there, a
 *  symlink included); this machine's path per handle. */
export function materialize(root: string, sid: string, items: { handle: string; text: string }[]): Map<string, string> {
	const dir = join(root, sidDir(sid));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {}
	const out = new Map<string, string>();
	for (const it of items) {
		if (!/^(?:[0-9a-z]{10}|requests)$/.test(it.handle)) continue;
		const file = join(dir, `${it.handle}.txt`);
		const bytes = Buffer.from(it.text, "utf8");
		if (!intact(file, bytes)) {
			const tmp = `${file}.${process.pid}.tmp`;
			try {
				unlinkSync(tmp); // a leftover (or a planted symlink): never written through
			} catch {}
			writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
			renameSync(tmp, file);
		}
		out.set(it.handle, file);
	}
	return out;
}

/** Delete copies older than maxAgeMs and the session directories they leave empty. Returns how many files went. Only what materialize
 *  writes is touched: plain files named <handle>.txt (or its .tmp) in real directories named like a session id; a symlink, as a
 *  session directory or as a file, is never followed nor deleted. */
export function cleanupRecall(root: string = recallRoot(), now = Date.now(), maxAgeMs = RECALL_MAX_AGE_MS): number {
	let removed = 0;
	const sids = attempt((): string[] | null => readdirSync(root), null);
	if (!sids) return 0;
	for (const sid of sids) {
		if (!SID_RE.test(sid)) continue;
		const dir = join(root, sid);
		let names: string[];
		try {
			if (!lstatSync(dir).isDirectory()) continue; // lstat: a symlinked directory is not a directory here
			names = readdirSync(dir);
		} catch {
			continue;
		}
		let left = names.length;
		for (const n of names) {
			if (!COPY_RE.test(n)) continue;
			try {
				const f = join(dir, n);
				const st = lstatSync(f);
				if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
					unlinkSync(f);
					removed++;
					left--;
				}
			} catch {}
		}
		if (left === 0) attempt(() => rmdirSync(dir), undefined);
	}
	return removed;
}
