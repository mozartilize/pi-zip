# Judge replay

Run saved model responses through the production parser without making API calls:

```sh
bun bench/judge-replay.ts /path/to/captures.jsonl
```

Each JSONL row is a `JudgeCapture` from `bench/judge-replay.ts`.
Capture the exact system prompt and user text from the provider call.
Keep the submitted handle set, evidence spans, and metadata from `judgeInput`.
Convert sets and maps to arrays.
Do not substitute stub tasks.
Do not change the candidate list.

Synthetic example shape:

```json
{"model":"provider/model","protocol":"facts-v1","system":"EXACT SYSTEM PROMPT","text":"EXACT USER TEXT","known":["aaaaaaaaaa"],"evidence":[{"id":"E1","role":"user","handles":["aaaaaaaaaa"],"locators":[]}],"meta":[["aaaaaaaaaa",{"folded":false,"locator":null}]],"reply":"aaaaaaaaaa Y Y N","expected":{"aaaaaaaaaa":["hot"]},"ms":5000,"costUsd":0.002,"usage":{"input":1000,"output":30,"cacheRead":0}}
```

The current provider contract is `facts-v1`: `<handle> <active> <finished> <lookup>`.
Each answer must be `Y`, `N`, or `U`.
The response contains no citations.
Code calculates priority rules.
Finished work can still remain necessary.

Historical captures use `evidence-v1` for citation fields or `labels-v1` for C/H/N/U labels.
Replay retains historical parsers and policies for these records.
Production rejects historical formats.
Do not relabel an old capture as a new protocol.

## Measurement rules

- Annotate expected verdicts before inspecting model replies.
  A target can have more than one acceptable verdict.
- Include explicit completion, unresolved dependencies, conflicting evidence, independent tasks on the same path, and missing information.
- Measure contract changes, candidate filtering, and incremental scheduling separately.
  Keep the model and task fixed.
- For fresh-call consistency, repeat the exact input.
  The report groups results by model, protocol, system prompt, user text, and parser metadata.
  Changed tasks or candidate subsets count as separate experiments.
- Test candidate order and subset changes as independent experiments.
  Do not combine them into the identical-input agreement metric.
- Production parsing maps missing rows and explicit unknown answers (`U`) to `warm`.
- A malformed response counts as a failure.
  It receives the baseline no-advice score.
- An all-warm model can show high consistency but zero utility.
  Report decisive coverage, annotated accuracy, false-cold counts, and parse failures together.
- The report returns null accuracy when annotations are absent.
  It returns null agreement when repeat trials are absent.
- Take token counts, costs, and latencies directly from captured calls.
  Missing usage fields do not mean zero cost.

Measure incremental reuse separately with scheduler tests and ledger logs.
Reused labels do not count as fresh model agreements.
In ledger records:
- `known` counts submitted handles.
- `reused` counts valid verdicts retained without submission.
- `addedTokens` tracks output growth.

Capture files contain task and tool data.
Store them outside the repository, unless you sanitize them as test fixtures.
The normal ledger never stores complete prompts or successful replies.
This tool never records silently and never sends data to external providers.

## Verification scope

- `test/judge-replay.test.ts` tests metric calculations and parser behavior.
- `test/judge.test.ts` tests the fact contract, historical parsers, candidate selection, invalidations, incremental updates, and planner guards.
Mocked tests do not prove live model quality or latency gains.

Provider-enforced structured output stays disabled until you confirm endpoint and transport support together.
A payload hook alone does not prove schema support.
