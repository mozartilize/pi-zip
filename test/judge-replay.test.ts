import { expect, test } from "bun:test";
import { replayJudge, type JudgeCapture } from "../bench/judge-replay.ts";

const a = "aaaaaaaaaa", b = "bbbbbbbbbb";
const capture = (reply: string): JudgeCapture => ({
	model: "test/model", protocol: "facts-v1", system: "fixed system", text: "actual task and catalogue",
	known: [a, b], evidence: [{ id: "E1", role: "user", handles: [a], locators: [] }],
	meta: [[a, { folded: false, locator: null }], [b, { folded: false, locator: null }]],
	expected: { [a]: ["hot"], [b]: ["cold"] }, reply,
});

test("production parser makes omitted and explicit unknown equivalent; all-unknown is not a quality win", () => {
	const report = replayJudge([capture(`${a} U U U`), capture(`${a} U U U\n${b} U U U`)]);
	expect(report).toMatchObject({ accuracy: 0, decisiveCoverage: 0, pairwiseAgreement: 1, comparedHandlePairs: 2, failures: 0 });
});

test("accuracy and false-cold use independent annotations, not the returned labels", () => {
	const report = replayJudge([capture(`${a} N Y N\n${b} N Y N`), capture(`${a} Y Y N\n${b} N Y N`)]);
	expect(report).toMatchObject({ accuracy: 0.75, decisiveCoverage: 1, falseCold: 1, coldPredictions: 3, falseColdRate: 1 / 3, pairwiseAgreement: 0.5 });
});

test("historical captures keep their original parser and never become facts-v1 trials", () => {
	const facts = capture(`${a} Y N N\n${b} N Y N`);
	const historical = [
		{ ...facts, protocol: "evidence-v1" as const, reply: `${a} E1 - -\n${b} - E1 -` },
		{ ...facts, protocol: "labels-v1" as const, reply: `${a} H E1\n${b} C E1` },
	];
	expect(replayJudge([facts, ...historical])).toMatchObject({ accuracy: 1, failures: 0, snapshots: 3, pairwiseAgreement: null });
	expect(replayJudge(historical.map((r) => ({ ...r, protocol: "facts-v1" })))).toMatchObject({ failures: 2, accuracy: 0 });
});

test("changed task, system, model and candidate subset are not repeat trials", () => {
	const first = capture(`${a} Y N N`);
	const subset = { ...first, known: [a], meta: [first.meta[0]], expected: { [a]: ["hot" as const] } };
	const report = replayJudge([first, { ...first, text: "different task" }, { ...first, system: "different rubric" }, { ...first, model: "other/model" }, subset]);
	expect(report.snapshots).toBe(5);
	expect(report.pairwiseAgreement).toBeNull();
});

test("malformed responses report failures; missing annotations cannot manufacture an accuracy score", () => {
	const report = replayJudge([{ ...capture("broken"), expected: undefined, ms: 90, costUsd: 0.01, usage: { input: 100, output: 10, cacheRead: 40 } }]);
	expect(report).toMatchObject({ failures: 1, accuracy: null, decisiveCoverage: null, costUsd: 0.01, p95Ms: 90, inputTokens: 100, cacheReadTokens: 40 });
	expect(() => replayJudge([capture(`${a} U U U`), { ...capture(`${a} U U U`), expected: { [a]: ["cold"] } }])).toThrow("inconsistent annotations");
});
