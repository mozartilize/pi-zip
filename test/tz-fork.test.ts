import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/tz-render-fork.ts", import.meta.url));

// Ambient opt-in flags in a developer's shell must not change what this test renders (or what it asserts):
// the mode is chosen here, per render.
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_ZIP")));
const render = (executable: string, TZ: string, locale: string, env: Record<string, string> = {}) => {
	const child = Bun.spawnSync([executable, fixture], {
		env: { ...clean(), TZ, LANG: locale, LC_ALL: locale, ...env }, stdout: "pipe", stderr: "pipe",
	});
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	return JSON.parse(child.stdout.toString());
};
const zones: [string, string][] = [["Asia/Shanghai", "tr_TR.UTF-8"], ["America/New_York", "de_DE.UTF-8"]];
// Model-visible time labels always carry the explicit zone; a bare MM-DD HH:MM would move with the process clock.
const noLocalTime = (rendered: unknown) => expect(JSON.stringify(rendered)).not.toMatch(/\d\d-\d\d \d\d:\d\d(?! UTC)/);

// Format v2 (PI_ZIP_SUMMARY_V2=1) writes its own epoch headings and "as of" labels; they must be TZ-stable too.
test("format v2 model text is byte-identical across process time zones", () => {
	const env = { PI_ZIP_SUMMARY_V2: "1" };
	const utc = render(process.execPath, "UTC", "en_US.UTF-8", env);
	for (const [tz, locale] of zones) {
		const other = render(process.execPath, tz, locale, env);
		expect(other.zoneOffset).not.toBe(utc.zoneOffset);
		expect(JSON.stringify(other.rendered)).toBe(JSON.stringify(utc.rendered));
	}
	expect(utc.rendered.first).toContain("### Epoch 1 · source interval u1..r64 · request 1 · 12-31 23:58 UTC");
	expect(utc.rendered.first).toContain("## Current state — assistant interpretation (as of 12-31 23:58 UTC)");
	noLocalTime(utc.rendered);
});

// Format v3 (the default) writes "as of" and "carried forward from" digest labels and evidence times; they must be TZ-stable too.
test("format v3 model text is byte-identical across process time zones", () => {
	const utc = render(process.execPath, "UTC", "en_US.UTF-8");
	for (const [tz, locale] of zones) {
		const other = render(process.execPath, tz, locale);
		expect(other.zoneOffset).not.toBe(utc.zoneOffset);
		expect(JSON.stringify(other.rendered)).toBe(JSON.stringify(utc.rendered));
	}
	// the newest time in the slice dates the digest: 2026-12-31 23:58 is later than the two 2026-03-08 times and 2024-02-29;
	// the selected outputs (r0, r1) carry their own times
	expect(utc.rendered.first).toContain("Digest: as of 12-31 23:58 UTC");
	expect(utc.rendered.first).toContain("- [i1] Persisted fact: 42.");
	expect(utc.rendered.first).toContain(" · 12-31 23:58 UTC · ");
	expect(utc.rendered.first).toContain(" · 02-29 00:05 UTC · ");
	expect(utc.rendered.failed).toContain("Digest: carried forward from 12-31 23:58 UTC; possibly stale: offline");
	noLocalTime(utc.rendered);
});
