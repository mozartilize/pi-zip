# Judge replay

Run saved model responses through the production parser without more API calls:

```sh
bun bench/judge-replay.ts /path/to/captures.jsonl
```

Each JSONL row is a `JudgeCapture` from `bench/judge-replay.ts`. Capture the exact system prompt and user text from the provider call. Preserve the submitted handle set, evidence spans and folded/locator metadata from `judgeInput`. Convert sets and maps to arrays. Do not substitute a stub task or reconstruct a changed candidate list.

Example shape (synthetic, not a measured model response):

```json
{"model":"provider/model","protocol":"facts-v1","system":"EXACT SYSTEM PROMPT","text":"EXACT USER TEXT","known":["aaaaaaaaaa"],"evidence":[{"id":"E1","role":"user","handles":["aaaaaaaaaa"],"locators":[]}],"meta":[["aaaaaaaaaa",{"folded":false,"locator":null}]],"reply":"aaaaaaaaaa Y Y N","expected":{"aaaaaaaaaa":["hot"]},"ms":5000,"costUsd":0.002,"usage":{"input":1000,"output":30,"cacheRead":0}}
```

The current provider contract is `facts-v1`: `<handle> <active> <finished> <lookup>`, with Y/N/U answers and no citations. Code applies priority rules; finished work can still be needed. Use `evidence-v1` for historical citation-field captures and `labels-v1` for historical C/H/N/U captures. Replay keeps their original parsers and policies; production rejects historical formats. Never relabel an old capture as the new protocol.

## Measurement rules

- Annotate expected verdicts before inspecting model replies. A target can have more than one acceptable verdict.
- Include explicit completion, unresolved dependencies, conflicting evidence, same-path independent tasks and insufficient information.
- Measure the contract change, candidate filtering and incremental scheduling separately. Keep the model and task fixed.
- For fresh-call consistency, repeat the same complete input. The report groups by model, protocol, system prompt, user text and parser metadata. Changed tasks or candidate subsets are not repeat trials.
- Test candidate-order and subset changes as separate experiments against the same independently annotated targets. Do not pool them into the identical-input agreement statistic.
- Missing rows and explicit unknown answers both map to warm through production parsing.
- A wholly malformed response counts as a failure and receives the no-advice baseline for scoring. It is not a successful model judgment.
- An all-warm model can be consistent while useless. Report decisive coverage, annotated accuracy, false-cold counts and parse failures together.
- The report returns null accuracy when there are no annotations. It returns null agreement when there are no repeat trials.
- Input, output, cache-read tokens, cost and latency must come from the captured call. Missing usage is not evidence of zero cost.

Use scheduler tests and ledger records to measure incremental reuse separately. Reused labels are not fresh model agreements. Ledger `known` counts submitted handles. `reused` counts valid verdicts retained without submission. `addedTokens` measures selected output growth. These counters do not measure semantic correctness.

Capture files contain task and tool data. Keep them outside the repository unless they are sanitized fixtures. The normal ledger does not store complete prompts or successful replies. This tool does not silently enable recording or send data to a provider.

## Verification scope

`test/judge-replay.test.ts` tests metric discrimination and production-parser behavior. `test/judge.test.ts` tests the fact contract (all 27 three-fact combinations, completion with continuing demand, unknowns and exact-reference lookup guards), historical parsers, candidate selection, invalidation, incremental updates and planner guards. Their mocked replies do not establish live model quality or latency improvements.

Provider-enforced structured output remains disabled until the configured endpoint and Pi transport are verified together. A payload hook alone does not establish schema support.
