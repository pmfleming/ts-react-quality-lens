# Implementation status and remaining work

This document separates the current **0.3.0** implementation from research proposals. Use the [README](../README.md), [configuration reference](configuration.md), and [rule catalog](rule-catalog.md) for supported behavior. The [GitHub checker survey](github-quality-checker-review.md) and [Fallow comparison](fallow-comparison-opportunities.md) are historical inputs, not release checklists.

## Implemented

| Area | Current implementation | Important boundary |
| --- | --- | --- |
| Policy and evidence | Dispositions, required checks, incomplete verdicts, compiler/test blockers, baseline/recommended/strict/react/library profiles. | Numeric scores do not gate. Required checks are not task-selection switches. |
| TypeScript | Compiler diagnostics, inherited compiler inputs, safety posture, managed typed lint, per-file/project type coverage and ratchets. | Typed lint uses the root configured tsconfig; no arbitrary custom-project lint ingestion. |
| React/accessibility | Official recommended-v2 and classic-v1 rulesets; managed jsx-a11y with fallback heuristics. | Not a general version/capability-gated framework rule engine; static a11y is not a required-check option. |
| Cleanup | Built-in candidates plus Knip normalization, comparison outcomes, public API/entrypoint handling. | Dynamic/runtime contracts can remain unresolved; removal is not automatically safe. |
| Packages | Temporary declaration emit, npm pack, publint, ATTW, library policy. | No API Extractor integration, API compatibility diff, or independent per-workspace package validation. |
| External reports | SARIF 2.1.0, React Profiler commit summaries, axe, React Doctor JSON. | No scanner/browser launch, runtime collection, or universal raw trace/bundler format support. |
| Workspaces | npm/Yarn/pnpm patterns, project references, ownership, cross-package edges, child load status. | Workspace framework/profile overrides are metadata; audit uses root policy. |
| Audits | Merge-base-to-working-tree comparison, hunks, compatible base snapshots, semantic occurrence IDs, baselines, suppression hygiene, Markdown output. | Missing/incompatible comparisons can be incomplete; no configured/default base falls back to whole-project scope. |
| Findings | Ranges where available, related locations, semantic decisions, reason codes, fix groups, effort estimates, actions. | Not every rule has a contract or every finding a source location; no automatic source remediation. |
| Test evidence | Compiler-resolved direct/type-only imports and filename associations; suite-level command execution. | No test coverage or per-test result collection. A direct import does not prove code execution. |
| Architecture | Risk model v3, eleven input prerequisites, task-input freshness, lint/cleanup quality input, explicit execution-aware correctness. | Scores are static prioritization, not predictive probabilities. Runtime/SARIF/package artifacts do not directly feed the map. |
| Caching/performance | Reusable project snapshot, compiler/config/content fingerprints, per-context tool memoization, synthetic benchmark, smoke budget. | No persisted live Program/checker, per-file incremental scheduler, or external-tool result cache. |
| Agent/editor | MCP tools/resources with explicit test execution; worker-based LSP diagnostics and config suppression edits. | Saved-file LSP analysis only; not every task/project finding is exposed as a diagnostic. |
| Validation/distribution | Schema checks, selected rule contracts with mutations, regression tests, package/performance smoke, Ubuntu/Windows CI. | Contract corpus is four selected rules, not universal rule coverage or real-project calibration. |

## Remaining work

### Correctness strength

Not implemented:

- Istanbul, LCOV, or V8 coverage ingestion and changed-branch evidence.
- Stryker/mutation reports and surviving-mutant locations.
- Per-test passed/failed/skipped outcomes; timeout/process-error states distinct from generic failure.
- Coverage-aware risk models such as CRAP.

Any future integration should preserve unknown/optional evidence, source-path identity, and suite failures rather than turning absent reports into zero issues. `correctness.coverage` and `correctness.mutation` are not current task IDs; `quality_inputs` is not a current config key.

### Package and workspace depth

Potential work includes API Extractor/API report ingestion, public API compatibility review, independent workspace policy execution, and a stronger typed-lint project selection model. Avoid presenting workspace metadata overrides as implemented enforcement.

### Rule precision and calibration

Expand contracts beyond the initial four rules, add pinned public-project comparisons and real false-positive adjudication, and publish per-rule precision/abstention measurements before claiming predictive scoring. The current mutation harness tests specified text substitutions, not arbitrary semantic rewrites.

### Caching and editor scope

Potential work includes dependency-aware per-file invalidation, measured cold/warm real-project benchmarks, safe external-tool result reuse, unsaved-document analysis, richer group/project diagnostics, and source-fix integration with explicit user approval.

### Contract and input hardening

Potential work includes generated consumer types from schemas, more exhaustive report validation, and consistent missing/malformed baseline handling. Current audit/type-coverage baseline readers can silently ignore unusable files; this should not be described as fail-closed behavior for all inputs.

## Acceptance standard for future work

Each feature should document its task/config surface, input and identity semantics, unavailable/malformed behavior, disposition, side effects, and scope limits. Add positive/negative fixtures, changed-code tests where relevant, and schema/README updates. Keep heuristic prioritization separate from confirmed failures, and never describe executing project tools or tests as a sandboxed read-only operation.
