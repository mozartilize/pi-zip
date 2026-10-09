// Recall through files (research pi-tricks §2). A tool allowlist (`pi --tools read,grep,bash`, sub-agent launchers) hides zip_recall,
// but read, grep or bash may still be there: a folded output then names a file those tools can read, and the file is written on
// demand, from the session, the moment a tool call names it. Placeholders say ~/.cache/pi-zip/recall/<session id>/<handle>.txt;
// a tool_call hook points any such path (any prefix: another machine, another user, a forked session) at this machine's copy.
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What placeholders and summaries name: portable, `~` is expanded by read, grep, find and ls, and by the shell. */
export const RECALL_DIR = "~/.cache/pi-zip/recall";
/** Copies older than this are deleted at session start; they can be written again from the session at any time. */
export const RECALL_MAX_AGE_MS = 14 * 24 * 3600_000;

/** Where the copies live on this machine: $XDG_CACHE_HOME/pi-zip/recall, else ~/.cache/pi-zip/recall. */
export const recallRoot = (): string => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-zip", "recall");

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
const FILE_RE = new RegExp(`(?:^|/)pi-zip/recall/${SID}/([0-9a-z]{10})\\.txt$`);
const DIR_RE = new RegExp(`(?:^|/)pi-zip/recall/${SID}/?$`);

/** A path that names a recall file ({ handle }) or a session's recall directory ({}); null for anything else. */
export function parseRecallPath(p: unknown): { handle?: string } | null {
	if (typeof p !== "string") return null;
	const f = FILE_RE.exec(p);
	if (f) return { handle: f[1] };
	return DIR_RE.test(p) ? {} : null;
}

/** Recall paths in a shell command: a word that runs into pi-zip/recall/<session>, with /<handle>.txt or not (the directory, a glob in it). */
const CMD_RE = new RegExp(`[^\\s'"\`<>|;&()]*pi-zip/recall/${SID}(/[0-9a-z]{10}\\.txt\\b)?`, "g");
export const commandNamesRecall = (cmd: unknown): boolean => typeof cmd === "string" && new RegExp(CMD_RE.source).test(cmd);
/** The handles of the recall files a shell command names. */
export const commandRecallHandles = (cmd: unknown): string[] => (typeof cmd === "string" ? [...cmd.matchAll(CMD_RE)].filter((m) => m[1]).map((m) => m[1].slice(1, 11)) : []);

/** The command with every recall path pointed at `localDir`, the handles it names, and whether it names the directory itself.
 *  A local directory that would need shell quoting is not written in (the shell then reads ~/.cache, where the copies are when
 *  XDG_CACHE_HOME is unset). */
export function rewriteCommand(cmd: string, localDir: string): { command: string; handles: string[]; dir: boolean } {
	const handles: string[] = [];
	let dir = false;
	const safe = /^[\w@%+=:,./-]+$/.test(localDir);
	const command = cmd.replace(CMD_RE, (m: string, file?: string) => {
		if (file) handles.push(file.slice(1, 11));
		else dir = true;
		return safe ? `${localDir}${file ?? ""}` : m;
	});
	return { command, handles, dir };
}

/** Write each original that is not on disk yet (directory 0700, file 0600, written whole then renamed); this machine's path per handle. */
export function materialize(root: string, sid: string, items: { handle: string; text: string }[]): Map<string, string> {
	const dir = join(root, sidDir(sid));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {}
	const out = new Map<string, string>();
	for (const it of items) {
		if (!/^[0-9a-z]{10}$/.test(it.handle)) continue;
		const file = join(dir, `${it.handle}.txt`);
		if (!existsSync(file)) {
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, it.text, { mode: 0o600 });
			renameSync(tmp, file);
		}
		out.set(it.handle, file);
	}
	return out;
}

/** Delete copies older than maxAgeMs and the session directories they leave empty. Returns how many files went. */
export function cleanupRecall(root: string = recallRoot(), now = Date.now(), maxAgeMs = RECALL_MAX_AGE_MS): number {
	let removed = 0;
	let sids: string[];
	try {
		sids = readdirSync(root);
	} catch {
		return 0;
	}
	for (const sid of sids) {
		const dir = join(root, sid);
		let names: string[];
		try {
			if (!statSync(dir).isDirectory()) continue;
			names = readdirSync(dir);
		} catch {
			continue;
		}
		let left = names.length;
		for (const n of names) {
			try {
				const f = join(dir, n);
				if (now - statSync(f).mtimeMs > maxAgeMs) {
					unlinkSync(f);
					removed++;
					left--;
				}
			} catch {}
		}
		if (left === 0) {
			try {
				rmdirSync(dir);
			} catch {}
		}
	}
	return removed;
}
