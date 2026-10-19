// Offline mutation checks for the invariants exercised by the real Pi integration rig.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "formal", "out", "pi-integration-mutants");
mkdirSync(output, { recursive: true });
// every site must be there: a replace that finds nothing would leave a mutant that tests nothing
const rep = (source: string, from: string, to: string) => {
	if (!source.includes(from)) throw new Error(`mutation site missing: ${from}`);
	return source.replace(from, to);
};
const mutants = [
	{
		name: "boundary-double-deducts-folds",
		check: "reported after-size must be non-negative and match the resulting Pi context within 10%",
		edit: (source: string) => rep(source, "const ctxAfter = sizeOf(sc,", "const ctxAfter = ctxTokens - (before - after) - cutSaved; const ignored = sizeOf(sc,"),
	},
	{
		name: "room-summary-inherits-sent",
		check: "request carry metadata must match the actual request view",
		edit: (source: string) => rep(source, "carried: false }, usage: cut.usage", "carried: sentBefore }, usage: cut.usage"),
	},
	{
		name: "room-summary-emits-second-notice",
		check: "one turn emits at most one pi-zip notice",
		edit: (source: string) => rep(rep(source, "!plan.noticed && (plan.cut || plan.native)", "!plan.noticed"),
			"if (!plan.noticed) this.noticeFor", "if (plan.noticed && cut) this.noticeFor(ctx, plan, [], cut, ctxTokens, 0);\n\t\tif (!plan.noticed) this.noticeFor"),
	},
	{
		name: "boundary-discards-new-folds",
		pattern: "an output becoming 60 requests old",
		check: "expect(received).toEqual(expected)",
		edit: (source: string) => rep(source, "const live = plan.folds.filter((t) => byId.has(t.entryId));", "const live = plan.folds.filter((t) => byId.has(t.entryId) && (!plan.carriedIds || plan.carriedIds.has(t.entryId)));")
	},
	{
		name: "boundary-ignores-incoming-edit",
		pattern: "a preceding extension boundary edit",
		check: "expect(received).toBe(expected)",
		edit: (source: string) => rep(source, "piContextTokens(e.context.contextEntries, this.branch(ctx), e.entries)", "piContextTokens(e.context.contextEntries, this.branch(ctx))")
	},
	// 0.4.0/0.4.1 (P1): the narrative call capped at its budget, and a failed narrative dropped instead of its fallback summary
	{
		name: "narrative-call-capped-at-budget",
		file: "summary.ts",
		pattern: "a narrative longer than its budget",
		check: "expect(received).toBe(expected)",
		edit: (source: string) => rep(source, "{ maxTokens: cap, signal,", "{ maxTokens: NARRATIVE_MAX, signal,"),
	},
	{
		name: "failed-narrative-recorded-lost",
		pattern: "a narrative that fails",
		check: "expect(received).toHaveLength(expected)",
		edit: (source: string) => rep(source, "this.record({ head, key, cut: c, usd, ...(c.llmOk || c.costUsd > 0 ? {} : { estimated: true }) });", "this.record({ head, key, ...(c.llmOk ? { cut: c } : { lost: \"failed\", estimated: c.costUsd === 0 }), usd });"),
	},
	{
		name: "failed-narrative-not-handed-over",
		pattern: "a narrative that fails",
		check: "expect(received).toBe(expected)",
		edit: (source: string) => rep(source, "this.completed(c, model, head, key, estUsd, p.scale.c * c.prefixTokens);", "this.completed(c, model, head, key, estUsd, p.scale.c * c.prefixTokens);\n\t\t\t\tif (!c.llmOk) return null;"),
	},
	// 0.4.4 (P1 on long sessions): a scan of every command of the branch at every turn_end, and a settle re-reading the branch per plan
	{
		name: "recall-scan-regex-on-every-command",
		file: "recallfile.ts",
		pattern: "a long branch: turn_end",
		check: "turn_end on a branch of 80 long commands stays under 400 ms",
		edit: (source: string) => rep(source, '(typeof cmd === "string" && cmd.includes(CMD_LIT) ? [...cmd.matchAll(CMD_RE)]', '(typeof cmd === "string" ? [...cmd.matchAll(CMD_RE)]'),
	},
	{
		name: "settle-rereads-branch-per-plan",
		pattern: "a long branch: one settle",
		check: "one settle reads the branch at most 6 times",
		edit: (source: string) => rep(source, "if (this.frozen) return this.frozen.branch;", ""),
	},
	// 0.4.5 (P1): a mid-run /model booked its requests under the run's first model (every turn_end a "model switch", P = 0), and a
	// reasoning model refusing effort "none" failed every narrative
	{
		name: "request-booked-under-run-model",
		pattern: "a mid-run /model",
		check: "a mid-run /model: the request it made is booked under the new model",
		edit: (source: string) => rep(source, "if (ctx?.model) this.model = ctx.model;\n", ""),
	},
	{
		name: "model-select-ignored",
		file: "index.ts",
		pattern: "a mid-run /model",
		check: "a mid-run /model: /zip shows the selected model",
		edit: (source: string) => rep(source, 'pi.on("model_select", (e) => zip.modelSelect(e.model));', ""),
	},
	{
		name: "narrative-effort-refusal-not-retried",
		file: "summary.ts",
		pattern: "refuses effort none",
		check: "a narrative refused for its reasoning effort is retried with low effort",
		edit: (source: string) => rep(source, "if (!low && model.reasoning && EFFORT_REFUSED_RE.test(lastErr) && !signal.aborted) {", "if (false) {"),
	},
	// 0.4.6: the idle door (on by default)
	{
		name: "idle-door-decision-not-carried",
		pattern: "the idle door: a ready summary goes in",
		check: "the next run carries the idle door's decision",
		edit: (source: string) => rep(source, "else [s.nat, s.note] = [door.nat, door.note];", ""),
	},
	{
		name: "idle-door-without-tui",
		pattern: "without the TUI",
		check: "no idle door without the TUI",
		edit: (source: string) => rep(source, 'if (!idleDoorOn() || !this.ranHere || ctx?.mode !== "tui" || ', "if (!idleDoorOn() || !this.ranHere || "),
	},
	{
		name: "idle-door-ignores-input",
		pattern: "while the door reads its clock",
		check: "an input during the door's clock read keeps the door shut",
		edit: (source: string) => rep(source, "if (inputs !== this.inputs || runs !== this.runStarts || this.inRun ||", "if (this.inRun ||"),
	},
	{
		name: "foreign-gate-any-age",
		pattern: "followed by pi-zip's own, leaves the door open",
		check: "an old foreign compaction never closes the door",
		edit: (source: string) => rep(source, "if (foreignCompaction(branch.filter((en: Any) => en?.type === \"compaction\" && en.fromHook).at(-1)))", "if (branch.some(foreignCompaction))"),
	},
	{
		name: "foreign-gate-counts-pi-compactions",
		pattern: "Pi's own compaction after another extension's",
		check: "a Pi compaction does not hide another extension's",
		edit: (source: string) => rep(source, "en?.type === \"compaction\" && en.fromHook).at(-1)", "en?.type === \"compaction\").at(-1)"),
	},
	{
		name: "idle-door-run-does-not-wait",
		pattern: "holds the door's compaction past its deadline",
		check: "the idle door never aborts an announced run", // without the wait the deadline aborts it (and the run would start without the compaction)
		edit: (source: string) => rep(source, "if (door === \"idle\" && this.runStarts !== runs0) return;", ""),
	},
	{
		name: "idle-door-lost-on-re-arm",
		pattern: "a door armed again while it reads its clock",
		check: "the door asks again after a re-arm during its read",
		edit: (source: string) => rep(source, "if (again) this.armDoor(ctx, true);", ""),
	},
	{
		name: "idle-door-no-deadline",
		pattern: "a slow handler at the idle door with no run",
		check: "a slow handler at the idle door is cancelled",
		edit: (source: string) => rep(source, "const timer = setTimeout(() => {\n\t\t\t\t// the idle door's", "const timer = setTimeout(() => {\n\t\t\t\tif (door === \"idle\") return;\n\t\t\t\t// the idle door's"),
	},
	{
		name: "idle-door-after-shutdown",
		pattern: "a shutdown while the door reads its clock",
		check: "no idle door after shutdown",
		edit: (source: string) => rep(source, "this.ranHere = false; // a door reading its clock now never arms again", ""),
	},
	{
		name: "idle-door-before-any-run",
		pattern: "a session only opened",
		check: "no idle door before a run of this process",
		edit: (source: string) => rep(source, "if (!idleDoorOn() || !this.ranHere || ", "if (!idleDoorOn() || "),
	},
	{
		name: "idle-door-every-moment",
		pattern: "a door that declines asks again",
		check: "the door asks only when P(warm) changes",
		edit: (source: string) => rep(source, "now ? t : this.doorNext(ctx, branch, t)", "now ? t : t + 200"),
	},
	{
		name: "notice-rescales-summary-before",
		file: "index.ts",
		test: "test/ui.test.ts",
		pattern: "a notice shows the real size",
		check: "expect(received).toContain(expected)",
		edit: (source: string) => rep(source, ` && !/summarized /.test(d.desc ?? "")`, ""),
	},
	// 0.4.9: metadata.user_id for a relay that pools accounts (where it is sent, where not, and when an endpoint refuses it)
	{
		name: "sticky-never-sent",
		pattern: "a relay keeps the session",
		check: "an Anthropic request names its session",
		edit: (source: string) => rep(source, "return this.guarded({ ...p, metadata: { user_id: uid } }, true);", "return this.guarded(p, false);"),
	},
	{
		name: "sticky-overwrites-their-metadata",
		pattern: "a relay keeps the session",
		check: "a request that names its own keeps it",
		edit: (source: string) => rep(source, "p.metadata == null && ", ""),
	},
	{
		name: "sticky-on-any-api",
		pattern: "a relay keeps the session",
		check: "another API is left alone",
		edit: (source: string) => rep(source, " && m?.api === \"anthropic-messages\"", ""),
	},
	{
		name: "sticky-speaks-as-claude-code",
		pattern: "a relay keeps the session",
		check: "a request that speaks as Claude Code is left alone",
		edit: (source: string) => rep(source, "/^You are Claude Code/", "/^(?!)/"),
	},
	{
		name: "sticky-claude-cli-agent",
		pattern: "a relay keeps the session",
		check: "a claude-cli user agent is left alone",
		edit: (source: string) => rep(source, "/claude-cli/i.test(JSON.stringify(a?.headers ?? {}))", "false"),
	},
	{
		name: "sticky-to-api-anthropic",
		pattern: "a relay keeps the session",
		check: "api.anthropic.com is left alone",
		edit: (source: string) => rep(source, " || /^https?:\\/\\/api\\.anthropic\\.com/i.test(String(a?.baseUrl ?? m.baseUrl ?? \"\"))", ""),
	},
	{
		name: "sticky-to-copilot",
		pattern: "a relay keeps the session",
		check: "Copilot is left alone",
		edit: (source: string) => rep(source, "m.provider !== \"github-copilot\" && ", ""),
	},
	{
		name: "sticky-refused-sent-again",
		pattern: "a relay keeps the session",
		check: "a refused metadata.user_id is not sent again",
		edit: (source: string) => rep(source, "this.stickyOf(sk, \"off\");", ""),
	},
	{
		name: "sticky-unanswered-400-sent-again",
		pattern: "a relay keeps the session",
		check: "a first 400 without a body turns it off",
		edit: (source: string) => rep(source, "/^4(00|22)\\b/.test(err)", "false"),
	},
	{
		name: "sticky-too-long-turns-off",
		pattern: "a relay keeps the session",
		check: "a prompt too long keeps it",
		edit: (source: string) => rep(source, " && !/too long|exceed/i.test(err)", ""),
	},
	{
		name: "sticky-answered-400-turns-off",
		pattern: "a relay keeps the session",
		check: "a 400 after an answer keeps it",
		edit: (source: string) => rep(source, "(ok ? 2 : 1)", "1"),
	},
	{
		name: "sticky-refusal-forgotten-by-next-process",
		pattern: "a relay keeps the session",
		check: "a refused metadata.user_id is not sent in the next process",
		edit: (source: string) => rep(source, "this.sticky ??= read();", "this.sticky ??= {};"),
	},
	{
		name: "sticky-oauth-key",
		pattern: "a relay keeps the session",
		check: "an OAuth key is left alone",
		edit: (source: string) => rep(source, " || /sk-ant-oat/.test(String(a?.apiKey ?? \"\"))", ""),
	},
	{
		name: "sticky-400s-in-a-row-never-off",
		pattern: "a relay keeps the session",
		check: "the second 400 in a row after an answer turns it off",
		edit: (source: string) => rep(source, "(ok ? 2 : 1)", "(ok ? 99 : 1)"),
	},
	{
		name: "sticky-state-per-model-only",
		pattern: "a relay keeps the session",
		check: "another endpoint has its own state",
		edit: (source: string) => rep(source, "sk = `${key}@${m?.baseUrl ?? \"\"}`", "sk = key"),
	},
	// 0.4.10: timing alone never ends the native path (a slow compaction that went in; one deadline miss)
	{
		name: "native-slow-ends-path",
		pattern: "a slow compaction that goes in ends nothing",
		check: "a slow compaction that goes in keeps the native path",
		edit: (source: string) => rep(source, '? added.length > 1 ? "another compaction went in as well" : null', '? added.length > 1 ? "another compaction went in as well" : handlerMs > 250 ? "slow" : null'),
	},
	{
		name: "native-first-miss-ends-path",
		pattern: "a deadline miss cancels that compaction only",
		check: "one miss keeps the native path",
		edit: (source: string) => rep(source, "this.nativeLate >= 2", "this.nativeLate >= 1"),
	},
	{
		name: "native-misses-never-end-path",
		pattern: "a deadline miss cancels that compaction only",
		check: "a second miss in a row ends the native path",
		edit: (source: string) => rep(source, "this.nativeLate >= 2", "this.nativeLate >= 99"),
	},
	{
		name: "native-miss-count-not-reset",
		pattern: "a compaction that goes in after a miss resets the count",
		check: "a compaction that goes in resets the count",
		edit: (source: string) => rep(source, "this.nativeLate = entry ? 0 :", "this.nativeLate = entry ? this.nativeLate :"),
	},
];
const only = process.env.PZ_MUTANTS?.split(","); // run some by name
for (const mutant of mutants.filter((m) => !only || only.includes(m.name))) {
	const dir = mkdtempSync(join(output, "source-"));
	try {
		const source = join(dir, "src");
		cpSync(join(root, "src"), source, { recursive: true });
		const file = join(source, (mutant as { file?: string }).file ?? "run.ts"), original = readFileSync(file, "utf8");
		const changed = mutant.edit(original);
		if (changed === original) throw new Error(`${mutant.name}: mutation site missing`);
		writeFileSync(file, changed);
		const result = Bun.spawnSync(["bun", "test", (mutant as { test?: string }).test ?? "test/pi-integration.test.ts", "--test-name-pattern", mutant.pattern ?? "mixed room boundary"], {
			cwd: root, env: { ...process.env, PI_ZIP_TEST_SRC: source }, stdout: "pipe", stderr: "pipe",
		});
		const text = result.stdout.toString() + result.stderr.toString();
		writeFileSync(join(output, `${mutant.name}.txt`), text);
		if (result.exitCode === 0 || !text.includes(`error: ${mutant.check}`)) throw new Error(`${mutant.name}: invariant did not catch mutation\n${text}`);
		console.log(`${mutant.name}: caught by ${mutant.check}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
