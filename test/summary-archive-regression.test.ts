import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildBlocks } from "../src/plan.ts";
import { handleFor } from "../src/placeholder.ts";
import { buildEpochSummaryV2 as build, parseSummaryV2 as parse, renderV2 } from "../src/summary-v2.ts";
import { tok4 } from "../src/util.ts";

const entry = (n: number, text = `UNIQUE ${n}: ` + "x".repeat(4000)) => {
	const message = { role: "user", content: text };
	return { sourceEntry: { id: `u${n}`, type: "message", message }, messages: [message] };
};
const requests = (text: string) => parse(text)!.epochs.flatMap((e) => e.requests);
function history(n: number) {
	const old = Array.from({ length: n }, (_, i) => entry(i + 1));
	const next = entry(n + 1);
	const branch = [...old, next].map((e) => e.sourceEntry);
	const first = build({ prefix: buildBlocks(old), branch });
	const result = build({ prefix: buildBlocks([next]), branch, previous: first.text, maxSummaryTokens: 1000 });
	return { old, next, branch, first, result };
}

test.each([512, 513, 600])("archive %i requests preserves every identity without expanding the range on parse", (n) => {
	const { old, next, branch, result } = history(n);
	expect(result.ok).toBe(true);
	expect(result.diagnostics.archivedRequestCount).toBe(n);
	expect(result.diagnostics.requestCount).toBe(n + 1);
	expect(parse(result.text)!.epochs[0].requests).toEqual([{ number: 1, text: "", archived: { last: n } }]);
	const back = build({ prefix: [], previous: result.text, branch });
	expect(back.diagnostics.archivedRequestCount).toBe(0);
	expect(back.diagnostics.verbatimCount).toBe(n + 1);
	expect(requests(back.text).map((r) => [r.number, r.handle, r.text]))
		.toEqual([...old, next].map((e, i) => [i + 1, handleFor(e.sourceEntry.id), e.sourceEntry.message.content]));
});

test("missing or incomplete raw branch preserves un-restored ranges and honest diagnostics", () => {
	const { result, branch } = history(600);
	const carry = build({ prefix: [], previous: result.text });
	expect(carry.ok).toBe(true);
	expect(carry.diagnostics.requestEmergencyMode).toBe("archive");
	expect(carry.diagnostics.archivedRequestCount).toBe(600);
	expect(carry.diagnostics.requestCount).toBe(601);
	expect(carry.diagnostics.verbatimCount).toBe(0);
	expect(requests(carry.text)[0]).toEqual({ number: 1, text: "", archived: { last: 600 } });
	const t = carry.diagnostics.tokens;
	expect(t.requests + t.intent + t.state + t.prose + t.commitments + t.evidence + t.overhead).toBe(t.total);
	const partial = build({ prefix: [], previous: result.text, branch: branch.slice(0, 8) });
	expect(partial.diagnostics.archivedRequestCount).toBe(592);
	expect(partial.diagnostics.requestCount).toBe(601);
	expect(requests(partial.text).slice(0, 8).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	expect(requests(partial.text)[8]).toEqual({ number: 9, text: "", archived: { last: 600 } });
	const recovered = build({ prefix: [], previous: partial.text, branch });
	expect(requests(recovered.text).map((r) => r.number)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1));
});

test("archive codec rejects malformed ordinals and keeps huge valid ranges compact", () => {
	const { result } = history(15);
	const base = result.text;
	const marker = base.split("\n").find((line) => line.startsWith("- R1–R15 archived"))!;
	for (const invalid of ["R0 archived, not resident (1 request);", "R9–R1 archived, not resident (9 requests);",
		"R1–R15 archived, not resident (14 requests);", "R9007199254740992 archived, not resident (1 request);"]) {
		expect(parse(base.replace(marker, `- ${invalid}`))).toBeNull();
	}
	const huge = base.replace(marker, "- R1–R1000000000 archived, not resident (1000000000 requests); recall by number");
	expect(parse(huge)!.epochs[0].requests).toEqual([{ number: 1, text: "", archived: { last: 1000000000 } }]);
	// A regressed n++ loop above the safe-integer bound must time out in a child, not hang this runner.
	const unsafe = base.replace(marker, "- R9007199254740992 archived, not resident (1 request);");
	const child = spawnSync(process.execPath, ["-e", `import {parseSummaryV2} from "./src/summary-v2.ts";
		console.log(parseSummaryV2(${JSON.stringify(unsafe)}) === null);`],
		{ cwd: new URL("..", import.meta.url), timeout: 3000, encoding: "utf8" });
	expect(child.error).toBeUndefined();
	expect(child.status).toBe(0);
	expect(child.stdout.trim()).toBe("true");
});

test("archive ranges do not fill gaps or erase legacy and unverified request text", () => {
	const { first, next, branch } = history(3);
	const sparse = parse(first.text)!;
	sparse.epochs[0].requests = sparse.epochs[0].requests.filter((r) => r.number !== 2);
	const result = build({ prefix: buildBlocks([next]), previous: renderV2(sparse), branch, maxSummaryTokens: 400 });
	expect(result.diagnostics.requestEmergencyMode).toBe("archive");
	expect(parse(result.text)!.epochs[0].requests).toEqual([
		{ number: 1, text: "", archived: { last: 1 } }, { number: 3, text: "", archived: { last: 3 } },
	]);
	for (const legacy of [false, true]) {
		const old = parse(first.text)!;
		for (const r of old.epochs[0].requests) {
			if (legacy) { r.legacyNumber = r.number; r.number = 0; }
			delete r.handle;
		}
		const kept = build({ prefix: buildBlocks([next]), previous: renderV2(old), maxSummaryTokens: 400 });
		expect(kept.diagnostics.archivedRequestCount).toBe(0);
		expect(kept.text).not.toContain("R0 archived");
		expect(parse(kept.text)!.epochs[0].requests).toHaveLength(3);
		for (const r of parse(kept.text)!.epochs[0].requests) expect(r.text.length).toBeGreaterThan(0);
	}
});

test("file-only recall uses requests.txt for every archive row", () => {
	const { old, next, branch } = history(15);
	const first = build({ prefix: buildBlocks(old), branch });
	const result = build({ prefix: buildBlocks([next]), previous: first.text, branch, maxSummaryTokens: 1000,
		file: { dir: "/cache/session", read: true, grep: false, bash: false } });
	expect(result.ok).toBe(true);
	expect(result.diagnostics.archivedRequestCount).toBe(15);
	const marker = result.text.split("\n").find((line) => line.startsWith("- R1–R15 archived"))!;
	expect(marker).toContain("/cache/session/requests.txt");
	expect(marker).toContain("read it");
	expect(result.text).not.toContain("zip_recall");
	expect(parse(result.text)!.epochs[0].requests[0].archived).toEqual({ last: 15 });
});

test("E1 retains intents and newest prose when the active state is empty", () => {
	const text = "KEEP THIS CONSTRAINT " + "abc ".repeat(3000);
	const result = build({ prefix: buildBlocks([entry(1, text)]), activeState: "",
		durableProse: "KEEP THIS VERIFIED FINDING", proposedIntents: [{ quote: "KEEP THIS CONSTRAINT", role: "user" }], maxSummaryTokens: 600 });
	expect(result.ok).toBe(true);
	expect(parse(result.text)!.intents.map((i) => i.quote)).toEqual(["KEEP THIS CONSTRAINT"]);
	expect(parse(result.text)!.epochs[0].block.durableProse).toBe("KEEP THIS VERIFIED FINDING");
});

test("new verbatim rows omit the qualifier; old rows and continuation metadata still parse", () => {
	const first = build({ prefix: buildBlocks([entry(1, "review the fork"), entry(2, "focus on summary v2")]) });
	const modern = first.text;
	expect(modern).toContain(`- R1 · handle ${handleFor("u1")}\n  > review the fork`);
	expect(modern).not.toContain("· verbatim");
	const old = modern.replace(/(- R\d+ · handle [a-z0-9]{10})(?=\n)/g, "$1 · verbatim");
	expect(parse(old)).toEqual(parse(modern));
	const state = parse(old)!;
	state.epochs[0].requests[1].continuationOf = 1;
	const withContinuation = renderV2(state);
	expect(withContinuation).toContain(`- R2 · handle ${handleFor("u2")} · continuation of R1\n`);
	expect(parse(withContinuation)!.epochs[0].requests[1].continuationOf).toBe(1);
});

test.each([250, 288, 300, 310])("whole-row budgeting keeps %i-char requests raw and avoids false overflow", (n) => {
	const input = [...Array.from({ length: 100 }, (_, i) => entry(i + 1, `small ${i}:`.padEnd(n, "s"))),
		...Array.from({ length: 20 }, (_, i) => entry(i + 101, `long ${i}:`.padEnd(5000, "L")))];
	// An explicit feasible document for the same input: small rows raw, long rows at the excerpt floor.
	const minimum = build({ prefix: buildBlocks(input), maxSummaryTokens: 1 });
	const feasible = parse(minimum.text)!;
	for (const e of feasible.epochs) for (const r of e.requests) if (r.number <= 100) {
		r.text = input[r.number - 1].sourceEntry.message.content;
		delete r.emergencyExcerpt;
	}
	const hard = tok4(renderV2(feasible));
	const result = build({ prefix: buildBlocks(input), maxSummaryTokens: hard });
	expect(result.ok).toBe(true);
	expect(tok4(result.text)).toBeLessThanOrEqual(hard);
	expect(requests(result.text).slice(0, 100).map((r) => r.text)).toEqual(input.slice(0, 100).map((e) => e.sourceEntry.message.content));
	for (const r of requests(result.text).slice(0, 100)) expect(r.emergencyExcerpt).toBeUndefined();
});
