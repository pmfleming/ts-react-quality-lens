# Fallow Comparison Opportunities

This review compares `ts-react-quality-lens` with `fallow-rs/fallow` and looks for practical improvements that fit this project rather than trying to copy Fallow wholesale.

Baseline checked: `npm test` passes with 5 tests.

## Summary

`ts-react-quality-lens` already has a useful measurement shape: a stable catalog, task-specific artifacts, provenance, confidence metadata, golden fixtures, optional integrations, and a risk model for the architecture map. Fallow's strongest transferable patterns are around change-set review, typed contracts, CI ergonomics, fixture depth, and agent/editor-friendly remediation metadata.

## Opportunities

### 1. Add PR and change-set audit mode

Fallow's highest-leverage workflow is `audit`: changed files, verdicts, and introduced versus inherited findings. This project currently exposes `catalog` and `measure` commands only.

Add an `audit --base` or `audit --changed-since` command that:

- scopes findings to changed files or changed hunks
- returns a `pass`, `warn`, or `fail` verdict
- separates newly introduced findings from inherited context
- writes a machine-readable audit artifact for dashboards and agents

Primary local surface: `src/cli.ts`.

### 2. Emit machine-actionable fixes

Local records carry useful `signals`, but they do not yet describe the next action a human, CI bot, or agent should take.

Add an `actions` array to issue records with fields such as:

- `type`
- `auto_fixable`
- `description`
- `comment` or `config_key` when suppression/config changes are appropriate

This would make artifacts more useful for automated review and future fix workflows.

Primary local surface: `src/types.ts`.

### 3. Tighten the JSON artifact contract

The current schema intentionally permits broad artifact shapes. That keeps early development flexible, but it makes downstream consumers rely on runtime probing.

Improve the contract by:

- defining discriminated shapes for each task artifact
- documenting additive versus breaking schema changes
- validating emitted artifacts in tests
- adding a schema drift gate to CI
- generating TypeScript consumer types from the schema

Primary local surfaces: `ts-react-quality-lens.schema.json`, `src/types.ts`, `test/cli.test.ts`.

### 4. Use the config schema at runtime

Configuration is currently validated by hand in code, while the shipped schema is mostly documentation. This can drift over time.

Improve config handling by:

- validating parsed config against the schema or a shared schema source of truth
- supporting JSONC so users can comment config files
- adding clearer validation errors with field paths
- adding an `init` command that creates a tailored config
- warning when multiple config files or stale configs could conflict

Primary local surface: `src/config.ts`.

### 5. Introduce baselines and suppression hygiene

Fallow supports staged adoption with baselines and narrow suppressions. This project has confidence metadata, but not yet a lifecycle for intentional exceptions.

Add support for:

- saving baselines for existing findings
- failing only on new findings during staged adoption
- inline suppressions for specific issue kinds
- config-level exceptions for intentional patterns
- stale suppression detection

This would make the lens easier to adopt in mature repositories without hiding real problems.

### 6. Deepen cleanup and dependency hygiene

The project already has signals such as `dead_export_surface`, dependency cycles, barrels, deep imports, and layer violations. Fallow goes further with unused files, unused exports, unused dependencies, unlisted dependencies, type-only dependency placement, and stale suppressions.

Add a dedicated cleanup or dependency hygiene measurement for:

- unused files
- unused exports and types
- unused dependencies
- unlisted imports
- type-only production dependencies
- test-only production dependencies
- duplicate exports

Primary local surfaces: `src/measures/quality.ts`, `src/measures/dependency.ts`.

### 7. Make framework support plugin-like

Framework detection and conventions are currently a small hardcoded set. That is fine for the current React-oriented scope, but it will become hard to maintain as support grows.

Add a framework adapter registry that can model:

- entry points
- route conventions
- generated files
- framework-specific import aliases
- template-visible usage
- server/client boundaries
- test and Storybook conventions

This would let Next, Vite, Remix, Storybook, and future adapters grow independently of the core analyzer.

Primary local surfaces: `src/config.ts`, `src/integrations.ts`, `src/analysis-context.ts`.

### 8. Build a broader conformance fixture suite

The existing tests are compact but meaningful. Fallow's fixture corpus shows the value of locking down edge cases before broadening analyzer behavior.

Add fixtures for:

- monorepos and workspaces
- TypeScript project references
- broken and extended `tsconfig` files
- path aliases
- package manager quirks
- framework convention files
- generated files
- dynamic imports
- re-export chains
- dependency cycles
- invalid configs

Primary local surface: `test/fixtures/`.

### 9. Add performance gates and incremental caching

The analyzer runs several integrations and each can be expensive on larger repositories. Fallow invests heavily in performance, benchmarks, and caching.

Add:

- benchmark fixtures
- timing budgets for common project sizes
- source-hash based caches
- changed-file scoped analysis
- optional skipping of expensive integrations
- CI checks that catch major runtime regressions

Primary local surfaces: `src/analysis-context.ts`, `src/integrations.ts`, `src/files.ts`.

### 10. Harden CI and distribution

The local CI is intentionally small. Fallow's CI is much broader, with least-privilege permissions, concurrency cancellation, schema drift checks, typo checks, Windows smoke tests, and self-analysis jobs.

Improve CI by adding:

- workflow `permissions: {}`
- `concurrency` cancellation
- path filters for targeted jobs
- schema validation and drift checks
- Windows smoke testing for path behavior
- typo or hidden-Unicode scans
- self-analysis artifacts
- package smoke tests against the built CLI

Primary local surface: `.github/workflows/ci.yml`.

## Recommended First Moves

The best first three improvements are:

1. Add `audit --changed-since` with a verdict artifact.
2. Tighten and validate the artifact schema.
3. Validate configuration through a shared schema-backed contract.

Together, those make the project more trustworthy for dashboards, CI gates, and agent workflows.

## Implementation Status

Initial implementation pass completed:

- Added `audit` CLI support with changed-file scoping, verdicts, baselines, and `audit.json`.
- Added machine-actionable finding `actions` and configured suppressions.
- Added `quality.cleanup` and `cleanup.json`.
- Added `ts-react-quality-lens.config.schema.json`, JSONC config parsing, and schema-key validation.
- Moved framework convention detection behind an adapter registry.
- Tightened the artifact schema for task ids, findings, actions, and audit output.
- Added schema drift checking to CI.
- Hardened GitHub Actions with least-privilege permissions, concurrency cancellation, and Ubuntu/Windows test coverage.
- Added tests for audit, cleanup actions, and config validation.

Second implementation pass completed:

- Audit attribution is now hunk-aware when git diff line ranges are available.
- Changed-file findings outside changed hunks remain in audit output as inherited context.
- Cleanup uses named import and re-export evidence to find unused exports inside otherwise-used modules, while keeping namespace, dynamic, side-effect, and wildcard usage conservative.
- Added `init` command support for starter schema-backed configs.
- Added a smoke performance gate with `TSRQLENS_PERF_MAX_MS`.
- Added regression coverage with a temporary git repository fixture.

Third implementation pass completed:

- Added stale suppression detection in audit output.
- Added Markdown audit rendering via `--format markdown`.
- Added package smoke validation for the built CLI and npm package contents.
- Extended CI to run package smoke after tests and performance smoke.
- Added regression coverage for stale suppressions and audit Markdown rendering.

Final consolidation pass completed:

- Added base-snapshot finding-id attribution through a temporary git worktree when a base ref is available.
- Added `public_api` config support so cleanup can preserve intentional public entry files and named exports.
- Added persistent analysis cache metadata under `output_dir/.cache/analysis.json`.
- Added `context` command and `context.json` for compact agent/dashboard consumption.
- Added a synthetic benchmark harness with `npm run bench`.
- Added regression coverage for cache hits, context export, public API cleanup preservation, and base-snapshot audit availability.

Remaining larger follow-up work:

- Turning cache metadata into a full reusable incremental parser/checker cache.
- Large real-world benchmark corpus beyond the synthetic harness and smoke gate.
- Full editor, LSP, or MCP server integrations.
