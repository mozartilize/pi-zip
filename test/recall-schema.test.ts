import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import piZip from "../src/index.ts";
import { handleFor } from "../src/handle.ts";
import { recallProviderPayload, registerRecallTool } from "../src/recall-extended.ts";
import { Zip } from "../src/run.ts";
import { fakePi, type Any } from "./helpers.ts";

let ledger: string | undefined;
beforeEach(() => { ledger = process.env.PI_ZIP_LEDGER; process.env.PI_ZIP_LEDGER = "off"; });
afterEach(() => { if (ledger === undefined) delete process.env.PI_ZIP_LEDGER; else process.env.PI_ZIP_LEDGER = ledger; });

function recallTool(): Any {
	let tool: Any;
	registerRecallTool({ registerTool(t: Any) { tool = t; } } as Any, { onRecall() {} });
	return tool;
}
const declaration = (extra: Any = {}) => ({ type: "function", name: "zip_recall", parameters: recallTool().parameters, ...extra });

test("Responses recall declarations explicitly opt out of strict normalization without changing their schema", () => {
	for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
		const recall = Object.freeze(declaration());
		const other = Object.freeze({ type: "function", name: "other_tool", parameters: { type: "object", required: [] } });
		const input = [{ role: "user", content: [{ type: "input_text", text: "keep these bytes" }] }];
		const payload = Object.freeze({ model: "test", tools: Object.freeze([other, recall]), input, max_output_tokens: 123 });
		const out = recallProviderPayload(api, payload);
		expect(out.tools[1].strict).toBe(false);
		expect(out.tools[1].parameters).toBe(recall.parameters);
		expect(out.tools[1].parameters.required).toEqual([]);
		expect(out.tools[0]).toBe(other); // not a global override of other extensions' tools
		expect(out.input).toBe(input);
		expect(out.max_output_tokens).toBe(123);
		expect("strict" in recall).toBe(false); // the input payload and transcript declarations were not mutated
		expect(recallProviderPayload(api, out)).toBeUndefined(); // no additional change on a repeated boundary
	}
});

test("incremental declarations are patched, while tool-shaped transcript data is not", () => {
	const initial = declaration(), added = declaration(), searched = declaration();
	const user = { type: "message", role: "user", tools: [declaration()], content: "schema examples are user data" };
	const result = { type: "function_call_output", output: { tools: [declaration()] } };
	const payload = { input: [user, { type: "additional_tools", role: "developer", tools: [initial] }, result,
		{ type: "additional_tools", tools: [added] }, { type: "tool_search_output", tools: [searched] }] };
	const out = recallProviderPayload("openai-responses", payload);
	expect(out).toBeDefined();
	expect(out.input[1].tools[0].strict).toBe(false);
	expect(out.input[3].tools[0].strict).toBe(false);
	expect(out.input[4].tools[0].strict).toBe(false);
	expect(out.input[0]).toBe(user);
	expect(out.input[2]).toBe(result);
	expect([initial, added, searched].map((t) => "strict" in t)).toEqual([false, false, false]);
});

test("explicit strict flags and unrelated provider protocols remain untouched", () => {
	const explicit = { tools: [declaration({ strict: true }), declaration({ strict: false })] };
	expect(recallProviderPayload("openai-responses", explicit)).toBeUndefined();
	expect(recallProviderPayload("openai-responses", { tools: [declaration({ strict: null })] }).tools[0].strict).toBe(false);
	for (const api of ["anthropic-messages", "openai-completions", "google-generative-ai", "bedrock-converse-stream", "mistral-conversations", ""]) {
		expect(recallProviderPayload(api, { tools: [declaration()] })).toBeUndefined();
	}
	for (const payload of [null, [], "text", {}, { input: "text" }, { tools: null }, { tools: [{ type: "function", name: "other_tool" }] }]) {
		expect(recallProviderPayload("openai-responses", payload)).toBeUndefined();
	}
});

test("the registered request hook patches the actual SDK payload before transport, with no network request", async () => {
	const { pi, handlers } = fakePi(); piZip(pi);
	const hook = handlers.get("before_provider_request")!;
	const tool = recallTool();
	const model: Any = { provider: "openai", id: "schema-test", name: "schema-test", api: "openai-responses", baseUrl: "https://api.openai.com/v1",
		reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let wire: Any, fetched = false;
	const res = await streamSimple(model, { messages: [
		{ role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
		{ role: "user", content: "recall", timestamp: 0 },
	] }, {
		apiKey: "sk-local-schema-test", maxTokens: 16,
		onPayload: async (payload: Any) => {
			wire = await hook({ api: model.api, payload }, { model }) ?? payload;
			throw new Error("LOCAL_SCHEMA_CAPTURE_STOP");
		},
		fetch: async () => { fetched = true; throw new Error("network must not be used by this test"); },
	}).result();
	expect(fetched).toBe(false);
	expect(res.errorMessage).toContain("LOCAL_SCHEMA_CAPTURE_STOP");
	expect(wire.tools).toHaveLength(1);
	expect(wire.tools[0]).toMatchObject({ name: "zip_recall", strict: false, parameters: { required: [] } });
	expect(wire.tools[0].parameters).toBe(tool.parameters);
});

test("the request hook composes with asynchronous payload guards and respects the actual request API", async () => {
	const guard = spyOn(Zip.prototype, "providerRequest").mockImplementation(async (e: Any) => ({ ...e.payload, max_output_tokens: 731 }));
	try {
		const { pi, handlers } = fakePi(); piZip(pi);
		const hook = handlers.get("before_provider_request")!;
		const ctx = { model: { api: "openai-responses" } };
		const payload = { tools: [declaration()] };
		const out = await hook({ payload }, ctx); // older hooks without event.api use the context's API
		expect(out).toMatchObject({ max_output_tokens: 731, tools: [{ strict: false }] });
		const foreign = await hook({ api: "anthropic-messages", payload }, ctx);
		expect(foreign.max_output_tokens).toBe(731);
		expect(foreign.tools).toBe(payload.tools);
	} finally { guard.mockRestore(); }
});

test("handle-only arguments resolve unchanged; explicit conflicting scopes still fail", async () => {
	const tool = recallTool(), handle = handleFor("raw-output");
	const branch = [{ type: "message", id: "raw-output", message: { role: "toolResult", toolName: "bash", toolCallId: "call", content: [{ type: "text", text: "original A\noriginal B" }] } }];
	const ctx = { sessionManager: { getBranch: () => branch } };
	const minimal = { handle };
	const out = await tool.execute("minimal", minimal, undefined, undefined, ctx);
	expect(out.isError).toBe(false);
	expect(out.details.resolved).toBe(1);
	expect(out.content[0].text).toContain("original A\noriginal B");
	expect(minimal).toEqual({ handle });
	const invalid = await tool.execute("conflict", { handle, scope: "outputs" }, undefined, undefined, ctx);
	expect(invalid.isError).toBe(true);
	expect(invalid.content[0].text).toContain("scope applies only");
});
