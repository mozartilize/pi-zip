// Index Pi session files into their session-memory databases, outside Pi.
//
//   npm run index <session.jsonl>... [-- --out <dir>]
//
// Writes the same database the extension keeps: `<session>.memory.sqlite` next to the session file, or in
// --out <dir> (or PI_ZIP_MEMORY_DIR). An existing database is reused, appended to or rebuilt, as when Pi opens the session.
// The session file is only read. Each file gets one JSON line of counts on stdout; a failure goes to stderr and sets exit code 1.
import { mkdirSync, readFileSync } from "node:fs";
import { Ledger } from "../src/ledger/projector.ts";

const args = process.argv.slice(2);
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--out") process.env.PI_ZIP_MEMORY_DIR = args[++i];
	else if (args[i] === "-h" || args[i] === "--help") files.length = 0, i = args.length;
	else files.push(args[i]);
}
if (process.env.PI_ZIP_MEMORY_DIR) mkdirSync(process.env.PI_ZIP_MEMORY_DIR, { recursive: true });
if (!files.length) {
	console.error("usage: npm run index <session.jsonl>... [-- --out <dir>]");
	process.exit(2);
}

let failed = false;
for (const file of files) {
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
		const parsed: any[] = [];
		let badLines = 0;
		for (const l of lines) {
			try { parsed.push(JSON.parse(l)); } catch { badLines++; } // a partial line (a session being written) is skipped, never repaired
		}
		const header = parsed[0];
		if (header?.type !== "session" || typeof header.id !== "string") throw new Error("no session header");
		const entries = parsed.slice(1);
		if (entries.some((e) => typeof e?.id !== "string")) throw new Error("entries without ids (an older session format: open it in Pi once to migrate it)");
		const src = { sessionId: header.id, file, header, entries };
		const ledger = Ledger.open(src);
		try {
			const r = ledger.reconcile(src);
			console.log(JSON.stringify({ file, db: ledger.path, mode: r.mode, projected: r.projected, ms: Math.round(r.ms), badLines, ...ledger.counts(entries.length) }));
		} finally {
			ledger.close();
		}
	} catch (err) {
		failed = true;
		console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
process.exit(failed ? 1 : 0);
