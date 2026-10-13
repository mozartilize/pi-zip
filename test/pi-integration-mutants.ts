// Offline mutation checks for the invariants exercised by the real Pi integration rig.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "formal", "out", "pi-integration-mutants");
mkdirSync(output, { recursive: true });
const mutants = [
	{
		name: "boundary-double-deducts-folds",
		check: "reported after-size must be non-negative and match the resulting Pi context within 10%",
		edit: (source: string) => source.replace("const ctxAfter = sizeOf(sc,", "const ctxAfter = ctxTokens - (before - after) - cutSaved; const ignored = sizeOf(sc,"),
	},
	{
		name: "room-summary-inherits-sent",
		check: "request carry metadata must match the actual request view",
		edit: (source: string) => source.replace("carried: false, regrow", "carried: sentBefore, regrow"),
	},
	{
		name: "room-summary-emits-second-notice",
		check: "one turn emits at most one pi-zip notice",
		edit: (source: string) => source
			.replace("!this.runPlan.noticed && (this.runPlan.cut || this.runPlan.native)", "!this.runPlan.noticed")
			.replace("if (!plan.noticed) this.noticeFor", "if (plan.noticed && cut) this.noticeFor(ctx, plan, [], cut, ctxTokens, 0);\n\t\tif (!plan.noticed) this.noticeFor"),
	},
	{
		name: "boundary-discards-new-folds",
		pattern: "an output becoming 60 requests old",
		check: "expect(received).toEqual(expected)",
		edit: (source: string) => source.replace("const live = plan.folds.filter((t) => byId.has(t.entryId));", "const live = plan.folds.filter((t) => byId.has(t.entryId) && (!plan.carriedIds || plan.carriedIds.has(t.entryId)));")
	},
	{
		name: "boundary-ignores-incoming-edit",
		pattern: "a preceding extension boundary edit",
		check: "expect(received).toBe(expected)",
		edit: (source: string) => source.replace("piContextTokens(e.context.contextEntries, this.branch(ctx), e.entries)", "piContextTokens(e.context.contextEntries, this.branch(ctx))")
	},
];
for (const mutant of mutants) {
	const dir = mkdtempSync(join(output, "source-"));
	try {
		const source = join(dir, "src");
		cpSync(join(root, "src"), source, { recursive: true });
		const file = join(source, "run.ts"), original = readFileSync(file, "utf8");
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
