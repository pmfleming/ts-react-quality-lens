# ts-react-quality-lens

`ts-react-quality-lens` is a reusable measurement engine for TypeScript, JavaScript, JSX, TSX, and React projects. It produces stable JSON artifacts that can be consumed by `project-management-board` or any other dashboard that understands the lens catalog contract.

The repository owns analysis artifacts only. It does not own a dashboard, web server, or project UI.

## Quick Start

Create `ts-react-quality-lens.config.json` in the project you want to measure:

```json
{
  "project_name": "my-react-app",
  "project_root": ".",
  "source_roots": ["src"],
  "test_roots": ["src", "tests"],
  "output_dir": "target/analysis",
  "framework": "auto",
  "test_runner": "auto"
}
```

Run the catalog:

```sh
node ./bin/ts-react-quality-lens.mjs catalog --config ./ts-react-quality-lens.config.json
```

Run all measurements:

```sh
node ./bin/ts-react-quality-lens.mjs measure all --config ./ts-react-quality-lens.config.json
```

Artifacts are written under `output_dir`.

## Current Measurements

The implementation combines deterministic built-in analysis with richer optional tool integrations:

- `quality.hotspots` writes `hotspots.json`.
- `quality.clones` writes `clones.json` using `jscpd` when available, plus a built-in normalized line-window fallback.
- `quality.escape_hatches` writes `ts_escape_hatches.json`.
- `quality.type_health` writes `type_health.json` with TypeScript compiler API diagnostics, inferred symbols, exports, and fallback structural records.
- `quality.locality_dynamic` writes `locality_metrics.json`.
- `quality.locality_leverage` writes `leverage_metrics.json`.
- `quality.react_health` writes `react_health.json` with component heuristics, framework conventions, and `eslint-plugin-react-hooks` findings when available.
- `quality.dependency_health` writes `dependency_health.json` with `dependency-cruiser` graph data when available, plus built-in import parsing fallback.
- `correctness.catalog` writes `correctness_review.json` and `test_catalog.json`.
- `correctness.all` writes `correctness_review.json` with test execution status when `test_command` is configured.
- `map.architecture` writes `map.json`.

Each major artifact includes:

- `schema_version`
- `task_id`
- `project`
- `provenance`
- `confidence`
- `summary`
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

## Design Notes

This version intentionally keeps fallback heuristics explainable while using stronger tools when they are installed. The artifact contract preserves confidence metadata so missing `tsconfig`, unavailable type information, absent dependencies, missing git history, unknown framework/test runner states, and skipped integrations are visible to consumers.

The first richer adapters cover generic React, Vite, Next.js app/pages route conventions, Remix route conventions, Storybook story evidence, client component directives, and server-only signal detection. Future work can deepen framework-specific scoring and add bundle/runtime analysis without changing the task IDs or artifact names.
