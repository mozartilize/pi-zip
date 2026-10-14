// Live release check: replay this tree's narrative call on a real session with a real model (formal/live/narrative.sh runs it).
// 0.4.0 and 0.4.1 capped the call at the narrative budget; fake models never wrote that much, a real CJK merge did (every call failed).
// For each prefix fraction of the stretch after the session's last compaction, the call merges that compaction's narrative, as
// buildCut does, and must come back ok. Writes one line per call to PZL_OUT.
import { readFileSync, writeFileSync } from "node:fs";

export default function (pi: any) {
	pi.registerCommand("pzlive", {
		description: "pi-zip live narrative check",
		handler: async (_args: string, ctx: any) => {
			const out: string[] = [];
			const log = (s: string) => { out.push(s); writeFileSync(process.env.PZL_OUT!, out.join("\n") + "\n"); };
			try {
				const { narrative, previousNarrative } = await import(`${process.env.PZL_SRC}/summary.ts`);
				const { NARRATIVE_MAX } = await import(`${process.env.PZL_SRC}/plan.ts`);
				const rows: any[] = [];
				for (const l of readFileSync(process.env.PZL_SESSION!, "utf8").split("\n")) {
					if (!l) continue;
					try { rows.push(JSON.parse(l)); } catch {}
				}
				let lastC = -1;
				rows.forEach((r, i) => { if (r.type === "compaction") lastC = i; });
				const comp = lastC >= 0 ? rows[lastC] : null;
				const from = comp ? rows.findIndex((r) => r.id === comp.firstKeptEntryId) : 0;
				const msgs = rows.slice(Math.max(0, from)).filter((r) => r.type === "message").map((r) => r.message);
				const prev = comp ? previousNarrative(comp.summary, Date.parse(comp.timestamp)) : null;
				let failed = 0;
				for (const frac of (process.env.PZL_FRACS || "0.3").split(",").map(Number)) {
					const prefix = msgs.slice(0, Math.floor(msgs.length * frac)).map((m) => ({ kind: m.role === "toolResult" ? "toolResult" : m.role, msg: m }));
					const t0 = Date.now();
					const nar = await narrative(prefix as any, ctx, NARRATIVE_MAX, AbortSignal.timeout(300_000), prev);
					if (!nar.ok) failed++;
					log(`${nar.ok ? "OK  " : "FAIL"} frac=${frac} prefix=${prefix.length} prevChars=${prev?.text.length ?? 0} ms=${Date.now() - t0} out=${nar.usage?.output ?? "?"} reasoning=${nar.usage?.reasoning ?? "?"} chars=${nar.text?.length ?? 0}${nar.ok ? "" : ` error=${nar.error}`}`);
				}
				log(failed ? `LIVE FAIL ${failed}` : "LIVE PASS");
			} catch (e: any) {
				log("LIVE FAIL " + (e?.stack || e));
			}
		},
	});
}
