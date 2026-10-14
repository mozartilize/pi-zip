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
