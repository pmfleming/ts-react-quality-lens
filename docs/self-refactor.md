# Refactoring the lens using its own findings

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
