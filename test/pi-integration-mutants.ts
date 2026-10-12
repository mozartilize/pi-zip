// Offline mutation checks for the invariants exercised by the real Pi integration rig.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, "formal", "out", "pi-integration-mutants");
mkdirSync(output, { recursive: true });
const mutants = [
	{
		name: "room-summary-inherits-sent",
		check: "request carry metadata must match the actual request view",
		edit: (source: string) => source.replace("cut: got.cut, cutSent: false, untouched: sc.O,", "cut: got.cut,"),
	},
	{
		name: "room-summary-emits-second-notice",
		check: "one turn emits at most one pi-zip notice",
		edit: (source: string) => source
			.replace("!this.runPlan.noticed && (this.runPlan.cut || this.runPlan.native)", "!this.runPlan.noticed")
			.replace("\n\t\treturn room;", "\n\t\tif (room.noticed) this.noticeFor(ctx, room, [], got.cut, after, 0);\n\t\treturn room;"),
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
		const result = Bun.spawnSync(["bun", "test", "test/pi-integration.test.ts", "--test-name-pattern", "mixed room boundary"], {
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
