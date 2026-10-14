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
		name: "idle-door-run-does-not-wait",
		pattern: "holds the door's compaction past its deadline",
		check: "the idle door never aborts a run", // without the wait the deadline aborts it (and the run would start without the compaction)
		edit: (source: string) => rep(source, "const timer = door === \"idle\" ? undefined : setTimeout(", "const timer = setTimeout("),
	},
	{
		name: "idle-door-lost-on-re-arm",
		pattern: "a door armed again while it reads its clock",
		check: "the door asks again after a re-arm during its read",
		edit: (source: string) => rep(source, "if (again) this.armDoor(ctx, true);", ""),
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
		const result = Bun.spawnSync(["bun", "test", "test/pi-integration.test.ts", "--test-name-pattern", mutant.pattern ?? "mixed room boundary"], {
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
