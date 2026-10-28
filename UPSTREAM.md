# Keeping this fork close to upstream

## History

The fork now starts at upstream 0.4.15 (`ec10b2a7413ede90d9a906c35721b383227ac3da`), followed by the fork's 42 replayed commits and subsequent refactors. The old mixed upstream/fork merge is not part of this history. Upstream's rewritten history has different commit identities, so the fork commits were replayed onto its current history.

`backup/master-before-upstream-rebase` preserves the original local master. Nothing was pushed to origin.

## Ownership

These source files match the upstream base byte-for-byte:
- `src/placeholder.ts`
- `src/classify.ts`
- `src/recall.ts`
- `src/util.ts`

The fork's implementations live in separate modules:

| Area | Fork modules |
| --- | --- |
| Upstream lifecycle extension (judge, memory, rescue and recovery) | `src/run-fork.ts` (`ZipFork extends Zip`) |
| Summary dispatch, epoch machinery and migration | `src/summary-engine.ts` (uses shared helpers from `summary.ts`) |
| Summary formats | `src/summary-v2.ts`, `src/summary-v3.ts` |
| Planner (`plan`, `selectPlan`, `planContext`) with pressure gates, judge reordering, merge reserve, rescue | `src/plan-fork.ts` |
| Summary pressure gates | `src/summary-pressure.ts` |
| Source-order call matching, fold selection and diagnostics | `src/fold-policy.ts` |
| Aliases, bounded hints and fold timestamps | `src/fold-format.ts` |
| Exact read verification and routine-read omission | `src/read-policy.ts` |
| Raw-request recall, visible assistant recall and scoped search | `src/recall-extended.ts` |
| Request-local lookup/retrieval insertion state | `src/request-notes.ts` |
| Model-switch fitting and repaired length-stop recovery | `src/model-switch.ts`, `src/length-recovery.ts` |
| Logging and memory registration | `src/decision-log.ts`, `src/memory-extension.ts` |
| Reasoning-effort policy | `src/reasoning-policy.ts` |

The fork emits **v2 and v3 only**. V3 is the default, and `PI_ZIP_SUMMARY_V2=1` selects v2. Old upstream/fork-v1 summaries remain readable for migration. `summary.ts` now supplies the shared parser, formatting/budget helpers, serializer, and provider-call/retry implementation used by upstream and v2/v3. `summary-engine.ts` adds format-specific parsing, epochs and dispatch; it has no fork-v1 emitter. Optional parser/row-format callbacks preserve fork additions without copying upstream algorithms. Provider effort-refusal learning is shared across all formats.

`plan.ts` differs from upstream in two lines only: `toolCallIndex` comes from `fold-policy.ts`, and a judge need note does not
start a run. Fork fields on its types (`Cut`, `PlanOpts`, `PlanResult`) are added by module augmentation in `plan-fork.ts`.

`run.ts` defines the base `Zip` lifecycle and producer, with default extension hooks and a limited protected member surface. It does not import fork runtime modules. `run-fork.ts` defines `ZipFork extends Zip`, owns the extra state and overrides those hooks. `index.ts` instantiates `ZipFork`; inherited lifecycle methods are not copied into the subclass. The base summary factory uses upstream `buildCut`, and the subclass selects v2/v3 instead.

On a sync, retain the protected members, shared-helper exports/optional parameters, and hook calls when resolving changes to the base files. Base defaults must preserve upstream behavior. `core.ts`, `index.ts`, `guard.ts`, `recallfile.ts` and `ui.ts` still have integration changes.

Fork-owned renderers: `fold-format.makePlaceholder` (fold timestamp) and `recall-extended.searchOutputs` (scoped headers) are full
implementations, not rewrites of upstream output, so an upstream wording change cannot silently break them.

### Tests

- Upstream test files stay upstream except for small fixture changes the fork's behavior requires: `pi-integration.test.ts`
  (v3 replies, pressure gate off, placeholder stamp, digest, installed-Pi hook signature), `core.test.ts`, `invariants.test.ts`,
  `helpers.ts`, `pi-integration-mutants.ts`.
- Upstream planner tests (`plan`, `law`, `calibration`, `coldwarm`, `planlaw`, `recallfile`) run unchanged against upstream's
  planner; `fork-<name>.test.ts` runs the same suites, plus fork cases, against `plan-fork.ts`.
- `fork-pi-integration.test.ts` holds the fork's real-Pi cases. It carries a copy of the rig from `pi-integration.test.ts`
  (importing that file would run its tests twice); when upstream changes the rig, port the change to the copy.
- Other fork suites: `summary-v2`, `summary-v3`, `summary-dispatch`, `fork-pieces`, `fork-restart`, `tz-fork`, `judge`,
  `lookup`, `retrieval`, `ledger`, and the summary regression files. Fork runtime tests import `ZipFork`; upstream runtime tests may still instantiate `Zip` directly. `upstream-sharing.test.ts` verifies actual lifecycle inheritance, shared function identities, cross-format retry learning and parser extensions.

Fork documentation lives in `docs/fork.md`, `docs/fork-design.md` and `docs/fork-changelog.md`. Upstream changelog, design and reference documents remain untouched; README has one fork notice.

## Sync procedure

Start with a clean working tree, or save your changes first. Prefer a merge for future syncs: it compares the net fork changes, instead of replaying historical commits that modified files later restored by the refactor.

```sh
git fetch upstream
git merge upstream/master
# Resolve the remaining integration hooks, then verify:
env -u PI_ZIP_SUMMARY_V2 bun test
bun run build-check
bunx --package typescript tsc --noEmit --lib es2023,dom
```

The explicit library override supports the existing `findLastIndex` calls without changing upstream's tsconfig. TypeScript runs from bunx; it is not added to this package.

After a sync, review changes to the base class and shared summary helpers: upstream fixes to inherited lifecycle methods and shared summary algorithms now reach the fork automatically. Fork prompts, epoch behavior and the separate planner remain fork-specific. Signature or hook-contract changes can require updates to the subclass and summary extensions; run the sharing tests as well as the integration suite. This layout reduces conflicts, not eliminates them.

To check the unmodified source boundary after merging:

```sh
git diff --exit-code upstream/master -- \
  src/placeholder.ts src/classify.ts src/recall.ts src/util.ts
```

Publishing the rewritten history requires a deliberate `git push --force-with-lease origin master`. It has not been run.
