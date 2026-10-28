import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Zip } from "./run.ts";
import type { Any } from "./util.ts";
import { Memory } from "./memory.ts";

/** Session memory registration; lifecycle calls stay next to the runtime's corresponding event hooks. */
export function registerMemory(pi: ExtensionAPI, zip: Zip): Memory {
	const memory = new Memory((rec) => zip.ledger(rec));
	{
		zip.memory = memory;
		pi.registerCommand("zip-memory", {
			description: "pi-zip: session memory status (ledger of this session, retrieval counters)",
			handler: async (_args: string, cctx: Any) => {
				const text = memory.statusLine(cctx);
				if (cctx?.ui?.notify && (cctx.mode === "tui" || cctx.mode === "rpc")) {
					try { cctx.ui.notify(text); return; } catch {}
				}
				process.stderr.write(text + "\n");
			},
		});
		pi.on("session_tree", (_e, ctx) => memory.catchUp(ctx, "session_tree"));
	}
	return memory;
}
