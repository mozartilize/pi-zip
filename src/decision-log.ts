// Fork decision diagnostics. Failures never block context handling.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { statsPath } from "./learn.ts";
import { attempt } from "./util.ts";

const LEDGER_MAX = 8 << 20;

export class DecisionLog {
	sid = "";
	private ready = "";
	enabled() { return process.env.PI_ZIP_LEDGER !== "off" && process.env.PI_ZIP_LEDGER !== "0"; }
	private path() {
		if (process.env.PI_ZIP_LEDGER) return process.env.PI_ZIP_LEDGER;
		const sid = (this.sid || process.env.PI_SESSION_ID || `pid-${process.pid}`).replace(/[^\w.-]/g, "_");
		return join(dirname(statsPath()), "logs", `${sid}.log`);
	}
	write(rec: Record<string, unknown>) {
		if (!this.enabled()) return;
		const path = this.path();
		attempt(() => {
			if (this.ready !== path) { mkdirSync(dirname(path), { recursive: true }); this.ready = path; }
			appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec }) + "\n");
		}, undefined);
	}
	rotate() {
		// A named file belongs to the caller. Only the default session log is capped.
		if (process.env.PI_ZIP_LEDGER) return;
		const path = this.path();
		attempt(() => { if (statSync(path).size > LEDGER_MAX) renameSync(path, `${path}.1`); }, undefined);
	}
}
