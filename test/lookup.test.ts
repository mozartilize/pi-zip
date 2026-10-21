import { afterEach, describe, expect, test } from "bun:test";
import { lookupRefs, lookupText } from "../src/lookup.ts";
import { handleFor, handleTokens, PH_MARK } from "../src/placeholder.ts";
import { Zip } from "../src/run.ts";
import { A, U, fakeCtx, fakePi, flat, project, startZip, type Any } from "./helpers.ts";

const saved = { ...process.env };
afterEach(() => {
	for (const key of ["PI_ZIP_JUDGE", "PI_ZIP_LOOKUP"]) {
		if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
	}
});

const big = (tag: string) => Array.from({ length: 60 }, (_, k) => `${tag} line ${k}: value=${k * 7919}`).join("\n");
/** One tool round as branch entries: the assistant call and its result. */
function round(n: string, name: string, args: Any, text: string, isError = false) {
	const am = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${n}`, name, arguments: args }] };
	const rm = { role: "toolResult", toolCallId: `c${n}`, toolName: name, isError, content: [{ type: "text", text }] };
	return [{ sourceEntry: { id: `a${n}`, type: "message", message: am }, messages: [am] }, { sourceEntry: { id: `r${n}`, type: "message", message: rm }, messages: [rm] }];
}
const branchOf = (entries: Any[]) => entries.map((e) => e.sourceEntry);

describe("handle tokens", () => {
	test("a token counts only as a whole run of 10 lowercase base36 characters", () => {
		const h = handleFor("r1");
		expect(handleTokens(`see ${h}.`)).toEqual([h]);
		expect(handleTokens(`(${h})X`)).toEqual([h]); // uppercase and punctuation are boundaries, as in the placeholder marker
		expect(handleTokens(`${h}a ${"a" + h}`)).toEqual([]); // inside a longer run it is another token
		expect(handleTokens(`${h.slice(0, 9)}`)).toEqual([]);
	});
});

describe("lookupRefs", () => {
	const cwd = "/app";
	test("a handle the request writes resolves from the branch; live outputs, recall results and longer runs do not count", () => {
		const entries = [U("u1", "go"), ...round("1", "bash", { command: "npm test" }, "short failure"), ...round("2", "zip_recall", { handle: "x" }, big("recall")), ...round("3", "bash", { command: "ls" }, big("ls"))];
		const [h1, h2, h3] = ["r1", "r2", "r3"].map(handleFor);
		const text = `what did ${h3} and ${h1} and ${h2} say? not ${h1}z`;
		// a short output still counts when its handle is written: the user asked for that output
		expect(lookupRefs(text, branchOf(entries), cwd, new Set())).toEqual([
			{ handle: h3, label: "bash ls", via: "handle" },
			{ handle: h1, label: "bash npm test", via: "handle" },
		]);
		expect(lookupRefs(text, branchOf(entries), cwd, new Set([h3])).map((r) => r.handle)).toEqual([h1]);
	});

	test("a full path counts through the newest call on it; an edit after the read and a basename give no cue", () => {
		const read1 = round("1", "read", { path: "/app/src/a.ts" }, big("old"));
		const read2 = round("2", "read", { path: "src/a.ts" }, big("new")); // relative to cwd: the same locator
		const edit = round("3", "edit", { path: "/app/src/b.ts" }, "Successfully replaced 1 block(s).");
		const readB = round("4", "read", { path: "/app/src/b.ts" }, big("b"));
		const small = round("5", "read", { path: "/app/src/c.ts" }, "tiny");
		const branch = branchOf([U("u1", "go"), ...read1, ...read2, ...readB, ...edit, ...small]);
		const refs = lookupRefs("check /app/src/a.ts, /app/src/b.ts, /app/src/c.ts and a.ts", branch, cwd, new Set());
		expect(refs).toEqual([{ handle: handleFor("r2"), label: "read src/a.ts", via: "locator" }]);
		// the newest read is shown in full: nothing to cue, and never the older read instead
		expect(lookupRefs("check /app/src/a.ts", branch, cwd, new Set([handleFor("r2")]))).toEqual([]);
		expect(lookupRefs("check /app/src/a.tsx and /app/src", branch, cwd, new Set())).toEqual([]); // a longer path or a parent is another locator
	});

	test("handles come first, a locator already named by its handle is not repeated, and the note holds at most three", () => {
		const rounds = [1, 2, 3, 4].flatMap((i) => round(`${i}`, "read", { path: `/app/f${i}.ts` }, big(`f${i}`)));
		const branch = branchOf([U("u1", "go"), ...rounds]);
		const refs = lookupRefs(`/app/f1.ts /app/f2.ts /app/f3.ts ${handleFor("r4")} ${handleFor("r2")}`, branch, cwd, new Set());
		expect(refs.map((r) => r.handle)).toEqual(["r4", "r2", "r1", "r3"].map(handleFor));
		expect(lookupText(refs).shown).toEqual(["r4", "r2", "r1"].map(handleFor));
	});
});

describe("lookup cue on the first request", () => {
	/** Two earlier runs; the first one's outputs are only in the branch (a compaction took them out of the view); a new prompt names one. */
	function session(prompt: string) {
		const old = [U("u1", "inspect the build"), ...round("1", "bash", { command: "npm run build" }, big("build error")), ...round("2", "read", { path: "/app/src/x.ts" }, big("x")), A("a1end")];
		const later = [U("u2", "something else"), A("a2"), U("u3", prompt)];
		const all = [...old, ...later];
		const projected = project(all, [{ type: "compaction", firstKeptEntryId: "u2", summary: "earlier work" }]);
		return { all, projected };
	}
	async function firstRequest(prompt: string, env: Record<string, string> = {}) {
		Object.assign(process.env, env);
		const { all, projected } = session(prompt);
		const { pi } = fakePi();
		const { ctx } = fakeCtx(projected, { branch: branchOf(all), cwd: "/app" });
		const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx, { prompt });
		const messages = flat(projected);
		const first = await zip.context({ messages }, ctx);
		const second = await zip.context({ messages }, ctx);
		zip.shutdown();
		return { first, second, messages };
	}

	test("a handle that survives only in the branch is cued before any tool call, well under the fold cap, with the judge off", async () => {
		const h = handleFor("r1");
		const { first, second, messages } = await firstRequest(`why did ${h} fail?`);
		expect(first.messages.slice(0, -1)).toEqual(messages); // appended, nothing before it changes
		const cue = first.messages.at(-1);
		expect(cue.role).toBe("user");
		expect(cue.content).toContain(`bash npm run build ${h}`);
		expect(cue.content).toContain("zip_recall");
		expect(cue.content).not.toContain(handleFor("r2"));
		expect(second).toBeUndefined(); // once per user request
	});

	test("a full path cues the newest output on it; the judge being on does not gate the cue", async () => {
		const { first } = await firstRequest("what is in /app/src/x.ts again?", { PI_ZIP_JUDGE: "1" });
		expect(first.messages.at(-1).content).toContain(`read /app/src/x.ts ${handleFor("r2")}`);
	});

	test("no cue without an exact reference, and PI_ZIP_LOOKUP=0 turns it off", async () => {
		expect((await firstRequest("why did the build fail?")).first).toBeUndefined();
		expect((await firstRequest(`why did ${handleFor("r1")} fail?`, { PI_ZIP_LOOKUP: "0" })).first).toBeUndefined();
	});

	test("a folded output shown as a placeholder in this request is cued; the same output shown in full is not", async () => {
		const h = handleFor("r5");
		const base = [U("u1", "go"), ...round("5", "bash", { command: "make" }, big("make")), A("a5"), U("u2", `look at ${h}`)];
		for (const folded of [true, false]) {
			const projected = folded ? project(base, [{ type: "context_edit", targetId: "r5", replacement: { content: [{ type: "text", text: `${PH_MARK}] ${h}` }] } }]) : base;
			const { pi } = fakePi();
			const { ctx } = fakeCtx(projected, { branch: branchOf(base), cwd: "/app" });
			const zip = new Zip(pi); zip.sessionStart(ctx); await startZip(zip, ctx, { prompt: `look at ${h}` });
			const out = await zip.context({ messages: flat(projected) }, ctx);
			if (folded) expect(out.messages.at(-1).content).toContain(`bash make ${h}`);
			else expect(out).toBeUndefined();
			zip.shutdown();
		}
	});
});
