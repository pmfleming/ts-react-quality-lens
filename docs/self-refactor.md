# Refactoring the lens using its own findings

For the subsequent review against `b71c97d`, see [the follow-up report](self-refactor-followup.md).

Measured on Windows with Node 24 on 2026-09-29. Baseline: `79d934e`.
Both runs use the root configuration and its `src`, `bin`, and `scripts` source roots.

## Results

| Measurement | Before | After |
| --- | ---: | ---: |
| Production source lines | 11,158 | 11,092 |
| All tracked TS/TSX lines, including tests and fixtures | 13,376 | 13,332 |
| Total function cyclomatic complexity | 2,315 | 2,267 |
| Maximum function cyclomatic complexity | 23 | 18 |
| Total function cognitive complexity | 1,908 | 1,852 |
| Maximum function cognitive complexity | 23 | 20 |
| Total function Halstead effort | 7,132,204.04 | 6,869,399.24 |
| Maximum function Halstead effort | 434,209.77 | 343,989.16 |
| High-risk hotspot records, including files | 101 | 97 |
| Clone groups | 13 | 6 |
| Files with duplication pressure | 16 | 8 |

Line counts use the lens's existing split-on-newline convention, including blank lines and final empty lines. Halstead effort is a token-based estimate, not elapsed time or developer hours. Nested function text contributes to enclosing-function effort, so its aggregate can overlap. Function count changed from 645 to 646; the totals include the extracted helpers.

No scoring weights, complexity formulas, clone thresholds, discovery exclusions, or test discovery settings were relaxed. Reanalyzing the baseline source with the refactored metric implementation reproduced all three metrics exactly for all 645 baseline functions.

## Changes selected from the output

- **SARIF parsing:** isolate stable identity and source-location construction; centralize level metadata; parse code flows once. `parseResult` drops from 23 to 12 cyclomatic and 23 to 11 cognitive complexity. Fingerprints, occurrence isolation, fixes, and invocation failures remain covered.
- **Finding enrichment:** share processing of record collections, separate assessment defaults, and use a common table for fix guidance. `enrichFinding` drops from 22 to 14 cyclomatic complexity; `fixAction` drops from 13 to 6.
- **LSP:** keep session lifecycle and invalidation together, dispatch analysis requests through a method map, and move response formatting into pure helpers. `handleRequest` drops from 21 to 18 cyclomatic complexity; session Halstead effort falls about 21%.
- **Repeated implementation:** reuse AST traversal, risk ordering, package-name extraction, Git execution, package-version lookup, tool-output recovery, and type-coverage aggregation. Remove an unused changed-line wrapper and an unnecessary type export. The compiler adapter now uses its module import directly instead of passing it through private helpers.

## Leverage and locality

Shared implementations now serve more callers without introducing new modules or dependency cycles. AST helpers serve four consuming modules instead of two; Git helpers serve three instead of two; package-name handling serves six instead of five. Decisions about these behaviors have one implementation to maintain.

The aggregate locality score decreases from 2,636 to 2,618 because the alias regression now directly exercises locality measurement. That is improved test association, not measured coverage or evidence that historical churn decreased. No distant-import penalty existed in this repository before or after the refactor.

## Output accuracy and usefulness

- `hotspots.json` now includes source-line and function totals plus total, maximum, and mean values for cyclomatic complexity, cognitive complexity, and Halstead effort. Findings include concrete metric values in their messages and use metric evidence classification.
- Leverage counts distinct consuming modules and excludes self imports. Multiple statements from one consumer cannot inflate reach.
- Locality uses resolved paths, so aliases cannot hide imports that traverse two or more parent directories. Its message distinguishes direct test association from measured coverage.
- Leverage messages and signals describe module escape hatches. The existing `weak_surface` numeric field counts module-wide escape hatches; it does not establish that they leak into public signatures. Its signal is now named `module_escape_hatches`.
- Default confidence follows the resolved evidence kind. Compiler diagnostics receive high confidence; structural heuristics receive medium confidence. Explicit confidence remains authoritative.

## Reproduction

Run `npm run self:measure` using the root config. This executes the configured test suite and package checks. Raw local snapshots are in `target/self-refactor/before` and `target/self-refactor/after`; `target/self-refactor/comparison.json` contains the numeric comparison. These generated artifacts are ignored by Git; this report records the comparison in the repository.

The existing 52-test suite is retained, with regression assertions added for distinct consumers, aliased dependency distance, evidence confidence, hotspot messages, and LSP dispatch. Existing compiler, cache, package, SARIF, audit, and rule-corpus regressions protect the refactored paths.

Validation passed: `npm run ci` (52 tests, no skips or failures, eight rule contracts, 22 corpus cases, performance smoke in 14.013 seconds against a 60-second limit, and package smoke), `npm run self:measure`, schema validation of all 16 self-analysis artifacts, and `git diff --check`. Self-analysis reports zero compiler diagnostics, dependency cycles, or cleanup findings, and complete package checks.

The self-analysis still reports the existing unsafe worker-data assertion in `src/lsp-worker.ts`. Six clone groups and 97 high-risk hotspot records remain.

## Follow-up: measurement integrity and remaining hotspots (2026-11-12)

Five follow-up improvements now validate directed cycle witnesses, separate exclusive function coverage from ambiguous/nested lines, preserve local binding relationships in structural clones, validate editor worker messages, and isolate compiler policies and React state binding collection. Import-only and simple projection boilerplate remains visible without contributing to implementation duplication pressure. The worker-data assertion described above has been removed. Raw V8 collection now includes subprocesses and workers; these traces do not establish source-mapped TypeScript coverage percentages.

For the final hotspot refactor, the baseline is commit `2035259`, after the first four improvements. Both snapshots use the same complete function inventory, exclusive-body metric formulas, source discovery, and scoring settings. This comparison therefore isolates the final refactor from the measurement corrections. All added policy callbacks and helpers are included.

| Affected module | Aggregate cognitive before → after | Maximum cognitive before → after | Maximum cyclomatic before → after | Aggregate Halstead effort before → after |
| --- | --- | --- | --- | --- |
| `src/compiler-targets.ts` | 52 → 27 | 51 → 19 | 32 → 15 | 79,008 → 40,667 |
| `src/react-review.ts` | 147 → 128 | 50 → 29 | 25 → 24 | 326,875 → 310,567 |

Compiler rules retain their messages, ordering, environment scope, and abstention for unavailable configurations. React review retains top-level hook scope, local binding identities, destructuring behavior, and eager initializer candidates. Existing compiler and React positive/negative controls pass without adding refactor-specific tests.

Across the project, aggregate cognitive complexity changes from 4,298 to 4,254, and the maximum from 51 to 42. Aggregate Halstead effort changes from 11,219,107 to 11,164,458. Maximum cyclomatic complexity changes from 32 to 31. The tradeoff is explicit: function count rises from 1,876 to 1,890, aggregate cyclomatic complexity rises from 5,501 to 5,503 (each function contributes a base of one), and physical source lines rise from 14,445 to 14,478. This is a reduction in concentrated decision complexity and lexical effort, not a claim of fewer total lines or paths.

The local reproduction snapshots are `target/self-review/next-five-before` and `target/self-review/next-five-after`; `target/self-review/next-five-comparison.json` contains affected-module aggregates. Raw coverage traces are collected by `npm run test:coverage` under `target/coverage/v8`. Generated evidence is ignored by Git.

Validation: all 153 tests passed with raw subprocess/worker coverage enabled; schema and rule contracts, formatting, performance smoke, and the installed-package smoke checks passed. Focused regressions cover directed-edge witnesses, shared-line and nested coverage attribution, clone precision and boilerplate classification, and malformed worker messages and lifecycle failures.

Final self-review reports zero compiler diagnostics, lint findings, dependency cycles, or cleanup findings. It retains one implementation clone candidate and one informational import-boilerplate group. These clone counts reflect the corrected normalization/classification rules and are not evidence that equivalent amounts of source code were removed.

## Performance audit follow-up (2026-11-12)

The six optimizations target repeated work without weakening evidence checks:

- Editor saves share the active analysis and schedule only the latest outstanding generation. Diagnostics publish once per generation; opening a document can republish that document's cached diagnostics. Failed current analyses remain retryable.
- Source fingerprints and analysis identities are reused within a generation. Project test execution clears generation caches afterward, while execution evidence retains its pre-command identity. New contexts and explicit refreshes recheck source and compiler dependencies.
- Hooks and accessibility rules share a syntax-only ESLint invocation, with separate finding collections and completion status. Configuration failures fall back to isolated invocations so one broken family cannot hide the other. Disabled accessibility starts no tool on its own.
- Clone and React review share a lazily constructed local syntax program. Workspace manifests, including missing manifests, are read once per generation. Refresh releases the cached references.
- Function coverage uses sorted line lookups and a sweep over overlapping declarations. No ownership comparisons are needed without observations. Sets replace repeated array membership scans; nested and shared-line ambiguity semantics remain unchanged. Deeply overlapping inventories can still require quadratic relationships.
- Locality metrics and their provenance use the same captured Git history. Architecture freshness reuses that fingerprint. Exact co-change counts and partner ordering are unchanged; no history truncation or approximate counting was introduced.

The baseline is the preceding audit at `0f99cd3`. The repeat uses the same root project, Node 24.18.0, disabled disk caching, disabled project-test execution, and cold/warm passes sharing one context. Read counts and bytes cover synchronous reads in the parent process, including OS-cached reads. They exclude subprocess I/O.

| Observation | Before | After |
| --- | ---: | ---: |
| Analyses for initialization plus ten rapid saves | 11 | 2 |
| Diagnostic publications for that burst | 11 | 1 |
| Warm-pass file reads | 7,113 | 93 |
| Warm-pass bytes read, decimal MB | 94.51 | 8.14 |
| ESLint subprocesses across both passes | 3 | 2 |
| Git history commands across both passes | 6 | 1 |
| Coverage kernel: 5,000 flat functions, no observations, median ms | 192.68 | 1.96 |
| Coverage kernel: 5,000 flat functions with observations, median ms | 297.19 | 10.00 |

A separate alternating comparison ran the previous Hooks/accessibility adapter and the combined adapter against the same current source files, three times each. Median elapsed time was 2,544 ms for separate invocations and 1,467 ms combined; all runs completed with identical finding counts. Coverage figures are medians of four isolated kernel calls, not whole-analysis timings.

The full-run timing sample did **not** establish an end-to-end speedup: cold elapsed time was 12.17 s before and 26.43 s after; warm elapsed time was 0.90 s before and 1.22 s after. Concurrent background compilation was observed during the repeat, so these samples are not controlled latency comparisons. Parent peak RSS was 649 MiB before and 628 MiB after, excluding child-process peaks; this is not a memory-leak assessment. The reduction in invocation counts and logical I/O is independently observable.

Validation passed: all 159 tests, schema/rule/format checks, performance smoke, installed-package smoke, and schema validation of 18 measured artifacts. Self-review reports zero compiler diagnostics, lint findings, and cleanup findings. Generated measurements are under `target/performance-audit`: `before-profile.json`, `profile.json`, `comparison.json`, `frequency.json`, `coverage-scaling.json`, and `lint-comparison.json`.
