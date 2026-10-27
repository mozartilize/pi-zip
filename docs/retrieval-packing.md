# Retrieval evidence packing

The helper input now quotes complete search passages rather than treating each merged evidence item as indivisible:

1. Admit one complete passage per source where possible.
2. Add extra passages in rounds, in candidate order.
3. Add optional, unverified thinking only after quoted results.
4. Skip a passage that does not fit; do not stop considering later, shorter passages.

Exactly identical passage text is serialized once with the source IDs it applies to. Each execution retains its own E id, recall handle, title, timestamp, error flag and whole-output outcome. The model must select need and cite each E id independently. Sharing text does not merge executions or grant a citation to another source.

`Evidence.passages` preserves actual passage boundaries; the combined `excerpt` remains available to existing callers. The helper's `sent` records contain only passages/context actually admitted. Logs expose `input.sentRefs`, physical `input.passages` and `input.sharedPassages`. `input.evidenceChars` counts serialized quoted evidence including source headers; `input.inputChars` counts the whole user message.

## Budget and measured trade-off

**The new default budgets 16,000 characters for quoted evidence, separately from the bounded header. Total input may exceed 16,000 characters.** The header includes fixed instructions, the request's existing 1,000-head/3,000-tail view, and at most 1,800 characters of recent context. No model/provider setting or candidate-ranking limit changed.

Measured on the same frozen 30 cases and 12 hidden-span labels:

| Metric | Previous: total 16k | New algorithm: total 16k control | New default: evidence 16k + header |
|---|---:|---:|---:|
| Retrieved span support | 10/12 | 10/12 | 10/12 |
| Span support admitted to helper input | 8/12 | 7/12 | 10/12 |
| Admitted source items | 140/240 | 219/240 | 240/240 |
| Cases with all eight sources admitted | 1/30 | 13/30 | 30/30 |
| Physically repeated search passages | 5 | 0 | 0 |
| Mean user-message characters | 14,410 | 15,681 | 19,288 |
| p95 user-message characters | 15,885 | 15,981 | 20,297 |
| Maximum user-message characters | 15,924 | 15,992 | 23,434 |

The new default recovers the two previously retrieved-but-unsent spans, `litellm-config` and `cache-affinity`. Its mean user-message size rises **33.9%**. This is not a same-budget recall improvement: the matched-total control is worse on literal span coverage despite exposing more source items. Breadth can displace useful depth under a tight budget. Admission of all eight sources does not mean every passage of those sources was sent.

The original retrieval misses, `policy-json` and `context-usage-api`, remain. These changes do not add embeddings, query rewriting, candidate reranking or a larger source pool.

## Measurement scope

The rerun uses identical historical prefixes, source metadata and original request timestamps. Candidate/source records are checked against the previous rerun; only the new passage-boundary annotation differs. The baseline loads `31d5f54`'s input builder. The equal-total control uses the new algorithm but subtracts its header from the evidence allowance. Full inputs, source hashes, runner scripts and per-case results are under `.local-probe/packing-share/run-001/` locally.

This is an offline input-builder diagnostic, not LLM need precision, injection success or downstream answer quality. No provider calls were made. The reused labels are assistant-authored, not new human-reviewed held-out gold. Character counts are not token counts; provider cost/latency from the larger input remains unmeasured.
