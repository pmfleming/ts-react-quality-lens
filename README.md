# ts-react-quality-lens

A CLI and measurement engine for TypeScript, JavaScript, JSX, TSX, and React projects. It writes JSON artifacts for dashboards, CI checks, editors, and agents. The task catalog is compatible with `project-management-board`; this repository does not provide a dashboard or application UI.

Current package and artifact schema: **0.3.0**. Architecture risk model: **v3**.

## Quick start

Requires Node.js **20.19 or newer** and npm. From this repository:

```sh
npm ci
npm run build
node ./dist/bin/ts-react-quality-lens.js catalog --config ./examples/basic/ts-react-quality-lens.config.json
node ./dist/bin/ts-react-quality-lens.js measure all --config ./examples/basic/ts-react-quality-lens.config.json
```

`catalog` prints task metadata. `measure` writes artifacts to the configured `output_dir` and prints task summaries. The example's artifacts go to `examples/basic/target/analysis`.

To analyze another project, create a config in that project, then pass its path to the built CLI:

```json
{
  "project_name": "my-app",
  "project_root": ".",
  "source_roots": ["src"],
  "test_roots": ["src", "test", "tests"],
  "output_dir": "target/analysis",
  "framework": "auto",
  "test_runner": "auto",
  "test_command": null,
  "policy": { "profile": "recommended" }
}
```

```sh
node ./dist/bin/ts-react-quality-lens.js measure all --config /path/to/my-app/ts-react-quality-lens.config.json
```

This example explicitly disables test execution. **If `test_command` is omitted and the project's `package.json` has a `test` script, the lens infers `<package-manager> run test`. CLI `measure all`, `measure correctness.all`, and `audit` then execute it.** Use only trusted project configurations and tooling: analysis is not a sandbox.

Alternatively, `init --config /path/to/my-app/ts-react-quality-lens.config.json` writes a starter config. The parent directory must exist. `init` selects the `recommended` profile and `origin/main` audit base, leaves test-command inference enabled, and refuses to overwrite an existing config without `--force`. Its `$schema` path is an editor hint; `init` does not copy the schema beside the config.

When installed as a package, the executable is `ts-react-quality-lens`; the examples above use the repository's built entrypoint instead.

## Commands

All commands accept `--config PATH` (or `-c PATH`); the default is `./ts-react-quality-lens.config.json` in the current directory. A missing config uses defaults rather than raising a missing-file error.

| Command | Behavior |
| --- | --- |
| `init` | Write a starter configuration; `--force` allows overwrite. |
| `catalog` | Print task IDs, descriptions, artifact names, and commands; no catalog file is written. |
| `measure [task-id\|all]` | Run one task or all tasks (default), write artifacts, print summaries. |
| `audit` | Run measurements and a policy gate; write `audit.json`. |
| `context` | Write and print `context.json` with modules, entrypoints, workspaces, framework facts, and cache status. |
| `mcp` | Start the agent endpoint over newline-delimited JSON-RPC stdio. |
| `lsp` | Start the editor endpoint over Content-Length-framed JSON-RPC stdio. |

`--help` prints usage. Audit options include `--base`, `--changed-since`, `--gate`, `--baseline`, `--save-baseline`, and `--format`. See [audit behavior](docs/audit.md) for scope, precedence, and exit codes.

## Measurement catalog

| Task | Artifact | Evidence |
| --- | --- | --- |
| `quality.hotspots` | `hotspots.json` | File/function size, cyclomatic and cognitive complexity, nesting, Halstead effort. |
| `quality.clones` | `clones.json` | jscpd plus built-in normalized-line and AST clones; module duplication pressure and same-purpose export/component/hook candidates. |
| `quality.escape_hatches` | `ts_escape_hatches.json` | Structural type, runtime, React, module, and suppression escape-hatch signals. |
| `quality.type_health` | `type_health.json` | Compiler diagnostics, compiler-option posture, types/exports, and type coverage with optional floors and ratchets. |
| `quality.lint` | `lint_health.json` | Managed type-aware typescript-eslint rules; requires a readable tsconfig. |
| `quality.locality_dynamic` | `locality_metrics.json` | Dependency/test locality, Git churn, defect-keyword commits, and co-change. |
| `quality.locality_leverage` | `leverage_metrics.json` | Reuse leverage and public-surface risk. |
| `quality.react_health` | `react_health.json` | Component/framework heuristics, official React Hooks/Compiler rules, and jsx-a11y. |
| `quality.dependency_health` | `dependency_health.json` | Import graph, cycles, layers, barrels, deep imports, and unsupported patterns; dependency-cruiser with built-in fallback. |
| `quality.cleanup` | `cleanup.json` | Unused files/exports, dependency hygiene, and Knip cross-checks with explicit comparison outcomes. |
| `quality.package_health` | `package_health.json` | Declaration emit, npm packing, publint, and Are The Types Wrong; disabled unless enabled by configuration/policy. |
| `quality.sarif` | `sarif_findings.json` | Imported SARIF 2.1.0 findings and invocation status; does not run security scanners. |
| `quality.runtime` | `runtime_health.json` | Imported React Profiler summaries, axe violations, and React Doctor diagnostics; does not launch the application. |
| `correctness.catalog` | `correctness_review.json`, `test_catalog.json` | Test discovery and compiler-resolved source associations; no tests executed. |
| `correctness.all` | `correctness_review.json`, `test_catalog.json` | Same catalog plus suite-level execution of the configured test command. |
| `map.architecture` | `map.json` | Module/workspace graph and risk-model-v3 category scores. |

A single task may run prerequisites and write additional artifacts: locality needs the correctness catalog, and the map refreshes eleven static/correctness input tasks. A standalone map **does not run tests**. It preserves an existing passed/failed suite result only when the review and test catalog match current source and analysis identities. Otherwise correctness risk remains unknown until tests run. See [risk model v3](docs/risk-model-v3.md).

`measure` produces evidence; it is not a CI verdict command. Findings or failed tests recorded by a measurement do not themselves set its CLI exit status to 1. Use `audit` for gating.

## Audits and evidence

```sh
node ./dist/bin/ts-react-quality-lens.js audit --config /path/to/my-app/ts-react-quality-lens.config.json --base origin/main --format markdown
```

The audit compares the analyzed working tree to the merge base of the selected ref and `HEAD`, including staged, unstaged, and untracked changes. Compatible base-snapshot finding identities take precedence over hunk attribution and can detect new findings in unchanged consumers.

Verdicts are `pass`, `warn`, `fail`, or `incomplete`. `fail` and `incomplete` exit with code 1; `warn` does not. Numeric risk scores rank evidence but do not decide the verdict. Configured suppressions and audit baselines retain findings while excluding them from the active gate.

- [Audit reference](docs/audit.md): comparison fallback, baselines, suppressions, required evidence.
- [Rule and gate catalog](docs/rule-catalog.md): profiles and dispositions.
- [Configuration reference](docs/configuration.md): defaults, path resolution, and supported nested fields.

## Artifacts and limitations

Measurement, audit, and context artifacts carry `schema_version`, `task_id`, `project`, `provenance`, `analysis_identity`, `confidence`, and a task-specific `summary`. Findings can include ranges, related locations, rule IDs, dispositions, semantic decisions, remediation estimates, and suggested actions. Not every finding has a source location or a rule contract.

Analysis identity tracks compiler, configuration closure, rulesets, and integration versions. Provenance fingerprints include source/test/compiler inputs and relevant task-specific inputs. Artifacts also contain timestamps, host information, and project paths, so repeated runs are not byte-identical.

Check `confidence`, `tool_status`, and task-specific completion fields before interpreting an empty record list as clean evidence. Built-in heuristics are not proof of defects, and a passing suite plus a direct test import is not measured coverage. Coverage, mutation-report ingestion, and per-test execution results are not implemented.

Workspace discovery supports npm/Yarn package patterns, pnpm workspace patterns, and TypeScript project references. Ownership and cross-workspace edges are exposed. Workspace framework/profile overrides are metadata, not independent per-workspace audit policies; audit uses the root policy.

The bundled dependencies include ESLint/plugins, Knip, jscpd, dependency-cruiser, publint, and ATTW. Integrations can still be unavailable or fail and have built-in fallbacks where implemented. See [integrations and protocol behavior](docs/integrations.md).

## Development

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile source, CLI, tests, and scripts into `dist/`. |
| `npm run typecheck` / `npm run lint` | Type checking only; `lint` is an alias, not an ESLint run. |
| `npm test` | Build and run Node's test suite. |
| `npm run ci` | Typecheck, build, schema/rule checks, formatting checks, tests, performance smoke, package smoke. |
| `npm run catalog` / `npm run measure` | Build and operate on `examples/basic`. |
| `npm run self:measure` / `npm run self:audit` | Build and analyze this repository's root config. |
| `npm run bench` | Synthetic multi-size benchmark. |
| `npm run perf:smoke` | Example performance gate; `TSRQLENS_PERF_MAX_MS` overrides the 60,000 ms budget. |
| `npm run schema:check` / `npm run rule:check` | Validate contracts and drift checks. |
| `npm run format:check` / `npm run package:smoke` | Repository formatting checks / built-package validation. |

The build uses the TypeScript 7 native compiler through `@typescript/native`. Runtime compiler-API analysis uses `typescript`, aliased to `@typescript/typescript6`. GitHub Actions runs CI on Ubuntu and Windows with Node 24.

The enabled-by-default disk cache stores a reusable project-analysis snapshot at `output_dir/.cache/analysis-v2.json` (internal cache format 4). It fingerprints source/test/compiler inputs, compiler file-discovery and resolution queries (including missing dependencies), and analysis identity; it does not persist external-tool results or a live TypeScript Program. Projects with no source files or unloaded configured TypeScript projects are not cached; external-tool completion is not part of that cache-admission check. Tool results are memoized within one analysis context. This is project-snapshot reuse, not changed-file-only incremental checking.

Further reading: [rule development](docs/rule-development.md), [implementation status and remaining work](docs/typescript-quality-roadmap.md). The [GitHub checker review](docs/github-quality-checker-review.md), [Fallow comparison](docs/fallow-comparison-opportunities.md), and [original HTML plan](plan.html) are historical research, not current API references.
