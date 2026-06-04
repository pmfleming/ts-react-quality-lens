# ts-react-quality-lens

`ts-react-quality-lens` is a reusable measurement engine for TypeScript, JavaScript, JSX, TSX, and React projects. It produces stable JSON artifacts that can be consumed by `project-management-board` or any other dashboard that understands the lens catalog contract.

The repository owns analysis artifacts only. It does not own a dashboard, web server, or project UI.

## Quick Start

Create `ts-react-quality-lens.config.json` in the project you want to measure:

```json
{
  "$schema": "./ts-react-quality-lens.config.schema.json",
  "project_name": "my-react-app",
  "project_root": ".",
  "source_roots": ["src"],
  "test_roots": ["src", "tests"],
  "output_dir": "target/analysis",
  "framework": "auto",
  "test_runner": "auto"
}
```

Or generate a starter config:

```sh
node ./dist/bin/ts-react-quality-lens.js init --config ./ts-react-quality-lens.config.json
```

Run the catalog:

```sh
npm run build
node ./dist/bin/ts-react-quality-lens.js catalog --config ./ts-react-quality-lens.config.json
```

Run all measurements:

```sh
node ./dist/bin/ts-react-quality-lens.js measure all --config ./ts-react-quality-lens.config.json
```

Artifacts are written under `output_dir`.

Run a changed-code audit:

```sh
node ./dist/bin/ts-react-quality-lens.js audit --config ./ts-react-quality-lens.config.json --base origin/main
```

The audit writes `audit.json` and returns a `pass`, `warn`, or `fail` verdict. Use `--gate new-only` to gate only findings attributed to changed hunks, `--gate all` to gate every finding in changed files, `--baseline ./fallow-baselines/ts-react-quality-lens-audit.json` to suppress known findings, and `--save-baseline ./fallow-baselines/ts-react-quality-lens-audit.json` to capture the current set during staged adoption. Findings in changed files but outside changed hunks are retained as inherited context with `introduced: false`. Use `--format markdown` for a compact PR-ready summary.

When possible, audit also measures a temporary git worktree at the base ref and compares finding ids. That lets findings without useful line locations, or findings that moved across lines, still be classified as introduced when they are absent from the base snapshot.

Export compact agent/dashboard context:

```sh
node ./dist/bin/ts-react-quality-lens.js context --config ./ts-react-quality-lens.config.json
```

This writes `context.json` with task metadata, framework facts, module summaries, and cache status.
Module summaries include package/tool entrypoint roles detected from `package.json` fields such as `bin`, `scripts`, `main`, `module`, `types`, and `exports`.

## Current Measurements

The implementation combines deterministic built-in analysis with richer optional tool integrations:

- `quality.hotspots` writes `hotspots.json`.
- `quality.clones` writes `clones.json` using `jscpd` when available, plus built-in normalized line-window and AST structural clone detection. It also derives module-level duplication pressure records from clone density and cross-file repetition, and same-purpose export/component/hook records from naming and type-shape evidence.
- `quality.escape_hatches` writes `ts_escape_hatches.json`.
- `quality.type_health` writes `type_health.json` with TypeScript compiler API diagnostics, inferred symbols, exports, and fallback structural records.
- `quality.locality_dynamic` writes `locality_metrics.json`.
- `quality.locality_leverage` writes `leverage_metrics.json`.
- `quality.react_health` writes `react_health.json` with component heuristics, framework conventions, and `eslint-plugin-react-hooks` findings when available.
- `quality.dependency_health` writes `dependency_health.json` with `dependency-cruiser` graph data when available, plus built-in import parsing fallback.
- `quality.cleanup` writes `cleanup.json` with unused files, unused exports, dependency hygiene issues, duplicate exports, and staged cleanup candidates.
- `correctness.catalog` writes `correctness_review.json` and `test_catalog.json`.
- `correctness.all` writes `correctness_review.json` with test execution status when `test_command` is configured.
- `map.architecture` writes `map.json`.

Cleanup, context, clone-derived duplication records, and the architecture map share the same entrypoint model so tool entry files are not mistaken for unused internals.

## Recent Capabilities

The analyzer now has broader duplication and entrypoint awareness:

- `clones.json` still reports concrete clone groups, but also emits `duplication_pressure` records for modules with repeated source regions, cross-file clone participation, structural clone evidence, and duplicated line coverage.
- `clones.json` emits `same_purpose_export`, `same_purpose_component`, and `same_purpose_hook` records for likely duplicated responsibilities discovered from normalized names and available TypeScript type-shape evidence, even when the implementation bodies are not clone-like.
- Package and tool entrypoints are detected once from `package.json` fields such as `bin`, `scripts`, `main`, `module`, `types`, `typings`, and `exports`, then stored on each module as `entrypoint_roles`.
- `context.json` exposes `summary.entrypoint_modules` and per-module `entrypoint_roles` for agent/dashboard consumers.
- `map.json` exposes `summary.entrypoint_nodes` and node-level `entrypoint_roles`.
- `map.architecture` now consumes clone-derived records as maintainability input, so duplication pressure can affect module risk instead of staying isolated in `clones.json`.

Each major artifact includes:

- `schema_version`
- `task_id`
- `project`
- `provenance`
- `confidence`
- `summary`
- optional `records`, `groups`, or `findings` entries with machine-actionable `actions`
- task-specific records, groups, graph data, or tests

## Configuration

Supported config fields:

| Field | Purpose |
| --- | --- |
| `project_name` | Human-readable project name. |
| `project_root` | Measured project root. Relative paths resolve from the config file. |
| `source_roots` | Source directories to analyze. |
| `test_roots` | Test directories and colocated test roots. |
| `output_dir` | Artifact output directory. |
| `tsconfig` | Main TypeScript config. Auto-detected when omitted. |
| `package_manager` | `npm`, `pnpm`, `yarn`, `bun`, or auto-detected. |
| `framework` | `vite`, `next`, `remix`, `expo`, `astro-react`, `react-router`, `react`, or `auto`. |
| `test_runner` | `vitest`, `jest`, `playwright`, `cypress`, `node`, or `auto`. |
| `test_command` | Optional command for `correctness.all`. |
| `exclude` | Extra excluded files or directories. |
| `layer_rules` | Optional ordered layer patterns for architecture-boundary checks. |
| `performance_inputs` | Optional bundle and render-cost JSON inputs for map performance scoring. |
| `public_api` | Entry files and named exports that cleanup should treat as intentional public surface. |
| `cache` | Enable or disable analysis cache metadata. |
| `suppressions` | Narrow intentional findings by `id`, `file`, or `kind`, with an optional reason. |
| `audit` | Default audit `base`, `changed_since`, `gate`, and `baseline` settings. |

Config files may contain JSONC-style comments. The shipped `ts-react-quality-lens.config.schema.json` is used to reject unknown top-level keys at runtime and is checked in CI for drift.

## Finding Actions

Findings now include an `actions` array when they are written to disk. Actions describe likely next steps such as removing unused code, repairing dependency edges, adding a narrow configured suppression, or placing an inline suppression comment.

Configured suppressions mark matching findings with `suppressed: true` and preserve `suppression_reason` so dashboards and audit gates can distinguish intentional exceptions from active issues.

Audit also reports stale configured suppressions as `stale_suppression` findings when they no longer match any current finding.

## CI And Performance

`npm run ci` runs type checking, build, schema drift checks, formatting checks, tests, a smoke performance gate over `examples/basic`, and package smoke validation. Override the generous default performance threshold with `TSRQLENS_PERF_MAX_MS` when a CI environment needs a different budget.

Run `npm run bench` for a synthetic multi-size benchmark harness. The analyzer also writes cache metadata under `output_dir/.cache/analysis.json` when `cache.enabled` is not set to `false`.

## Design Notes

This version intentionally keeps fallback heuristics explainable while using stronger tools when they are installed. The artifact contract preserves confidence metadata so missing `tsconfig`, unavailable type information, absent dependencies, missing git history, unknown framework/test runner states, and skipped integrations are visible to consumers.

The framework convention layer is adapter-based. The first adapters cover generic React client/server signals, Next.js app/pages route conventions, Remix route conventions, and Storybook story evidence. Future work can deepen framework-specific scoring and add bundle/runtime analysis without changing the task IDs or artifact names.
