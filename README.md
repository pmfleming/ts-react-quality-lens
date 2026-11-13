# ts-react-quality-lens

A CLI and measurement engine for TypeScript, JavaScript, JSX, TSX, and React projects. It stores working evidence in an embedded local Turso database and exposes JSON artifacts for dashboards, CI checks, editors, and agents. The task catalog is compatible with `project-management-board`; this repository does not provide a dashboard or application UI.

Current package and artifact schema: **0.3.0**. Architecture risk model: **v3**.

## Quick start

Requires Node.js **20.19+, 22.13+, or 24+** (`^20.19.0 || ^22.13.0 || >=24`; the bundled ESLint, dependency-cruiser and Knip reject Node 21, 22.0–22.12 and 23) and npm. From this repository:

```sh
npm ci
npm run build
node ./dist/bin/ts-react-quality-lens.js catalog --config ./examples/basic/ts-react-quality-lens.config.json
node ./dist/bin/ts-react-quality-lens.js measure all --config ./examples/basic/ts-react-quality-lens.config.json
```

`catalog` prints task metadata. `measure` saves artifacts in `output_dir/lens.db` and prints task summaries. The example's database is `examples/basic/target/analysis/lens.db`. Export an artifact with `export hotspots.json --config ./examples/basic/ts-react-quality-lens.config.json`.

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
| `audit` | Run measurements and a policy gate; save `audit.json` in Turso. |
| `export <name>` | Print a saved artifact as JSON, for example `export audit.json`. |
| `context` | Save and print `context.json` with modules, entrypoints, workspaces, framework facts, and cache status. |
| `mcp` | Start the agent endpoint over newline-delimited JSON-RPC stdio. |
| `lsp` | Start the editor endpoint over Content-Length-framed JSON-RPC stdio. |

`--help` prints usage. Audit options include `--base`, `--changed-since`, `--gate`, `--baseline`, `--save-baseline`, and `--format`. See [audit behavior](docs/audit.md) for scope, precedence, and exit codes.

## Local working storage

The runtime uses the pinned `@tursodatabase/database` embedded engine and its synchronous binding. No server, account, credentials, cloud sync, or network connection is required for storage. The native package currently ships Linux x64/arm64, macOS arm64, and Windows x64 binaries.

- `output_dir/lens.db` holds current artifacts, publication generations, and finding indexes by ID and by rule/file. MCP explanations use the ID index to select candidate artifacts before validating their evidence.
- Audits measure into an in-memory Turso database and publish all members in one short transaction. Readers see committed evidence; failed commits roll back. Artifact references still bind exact payloads and run IDs, so later standalone measurements invalidate an older audit when they replace its inputs.
- `output_dir/.cache/lens.db` holds the reusable analysis snapshot and its validation metadata. Cache and evidence have independent lifetimes; disabling the cache does not disable saved evidence. Connections close after synchronous operations. Replaced generations and finding rows are removed rather than accumulating history.
- On Linux and macOS, Turso's experimental multiprocess WAL support coordinates CLI processes and editor workers, with a five-second lock timeout. Keep its WAL/shared-memory sidecars with a live database; do not open it concurrently through a different SQLite engine.
- Windows' Turso IO backend does not support multiprocess WAL, so each process holds an exclusive file lock while its short-lived connection is open. Overlapping processes wait up to five seconds for the lock and then fail closed with a locking error; they never read uncommitted evidence. This dependency is pinned because this engine feature is still experimental.

This is a breaking storage change. Old artifact/cache JSON files are ignored; re-run measurements to populate Turso. Names such as `hotspots.json` are resource IDs, not files. Use `export hotspots.json > hotspots.json`, audit output formats, or MCP resources for portable evidence. Configuration, explicit baseline exports, SARIF, coverage, and external-tool interchange formats remain JSON. Stop all lens processes before removing a database and its sidecars to reset working storage.

## Measurement catalog

| Task | Artifact | Evidence |
| --- | --- | --- |
| `quality.hotspots` | `hotspots.json` | File/function size, cyclomatic and cognitive complexity, nesting, Halstead effort. |
| `quality.clones` | `clones.json` | jscpd plus built-in normalized-line and AST clones; module duplication pressure and same-purpose export/component/hook candidates. |
| `quality.escape_hatches` | `ts_escape_hatches.json` | Structural type, runtime, React, module, and suppression escape-hatch signals. |
| `quality.type_health` | `type_health.json` | Compiler diagnostics, compiler-option posture, types/exports, advisory generic API reviews, type coverage with optional floors and ratchets, optional public API documentation metrics, declared-runtime compiler reviews, and opt-in compiler performance observations. |
| `quality.lint` | `lint_health.json` | Managed type-aware typescript-eslint rules; requires a readable tsconfig. |
| `quality.locality_dynamic` | `locality_metrics.json` | Dependency/test locality, Git churn, defect-keyword commits, and co-change. |
| `quality.locality_leverage` | `leverage_metrics.json` | Reuse leverage and public-surface risk. |
| `quality.react_health` | `react_health.json` | Component/framework heuristics, official React Hooks/Compiler rules, and jsx-a11y. |
| `quality.dependency_health` | `dependency_health.json` | Import graph, cycles, layers, barrels, deep imports, and unsupported patterns; dependency-cruiser cycles plus internal-graph cycles it cannot see (tsconfig path aliases). |
| `quality.cleanup` | `cleanup.json` | Unused files/exports, dependency hygiene, and Knip cross-checks with explicit comparison outcomes. |
| `quality.package_health` | `package_health.json` | Declaration emit, npm packing, publint, and Are The Types Wrong; disabled unless enabled by configuration/policy. |
| `quality.sarif` | `sarif_findings.json` | Imported SARIF 2.1.0 findings and invocation status; does not run security scanners. |
| `quality.runtime` | `runtime_health.json` | Imported profiler/track observations, compiler execution reports, comparable bundle/runtime baselines, axe violations, and React Doctor diagnostics. |
| `quality.modern_web` | `modern_web.json` | Optional Chrome modernization scanner candidates for JS/TS, HTML and CSS, with contextual verification criteria and browser-target-qualified advice. |
| `correctness.catalog` | `correctness_review.json`, `test_catalog.json` | Test discovery and compiler-resolved source associations; no tests executed. |
| `correctness.all` | `correctness_review.json`, `test_catalog.json` | Same catalog plus suite-level execution of the configured test command. |
| `map.architecture` | `map.json` | Module/workspace graph and risk-model-v3 category scores. |

A single task may run prerequisites and write additional artifacts: locality needs the correctness catalog, and the map refreshes eleven static/correctness input tasks. A standalone map **does not run tests**. It preserves an existing passed/failed suite result only when the review and test catalog match current source and analysis identities. Otherwise correctness risk remains unknown until tests run. See [risk model v3](docs/risk-model-v3.md).

Structural clone candidates preserve local binding relationships, property names, literal values, and operators while allowing local renaming. They describe similar syntax, not behavioral equivalence. Verified import-only spans and simple object projections remain visible as informational boilerplate, with their original producer scores retained; they do not contribute to implementation duplication pressure. Raw engine totals still include these observations.

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

Check `confidence`, `tool_status`, and task-specific completion fields before interpreting an empty record list as clean evidence. Built-in heuristics are not proof of defects, and a passing suite plus a direct test import is not measured coverage. Execution coverage accepts source-linked LCOV, Istanbul, or original-JavaScript V8 observations; mutation-report ingestion and per-test execution results are not implemented.

dependency-cruiser runs without the project's configuration, so it cannot follow tsconfig path aliases. The internal import graph resolves them and reports one verified directed cycle per cyclic strongly connected component, not an enumeration of every possible cycle. When dependency-cruiser runs, an internal witness is added only for cyclic components that share no module with a dependency-cruiser cycle. Cycle IDs derive from the rotation-independent cycle, not its position in the list. Cycle, layer and deep-import records locate modules by file path (`file`, `files`), with module IDs in `modules`, `module_id` and `target`.

Hotspot metrics inventory every implemented function, including inline callbacks, methods, constructors and accessors. Cyclomatic complexity counts a base of one plus branches, catches, cases, ternaries and logical operators. Cognitive complexity is a Lens-specific nesting-weighted variant, not a Sonar compatibility claim. Halstead effort is a lexical token proxy, not measured developer time. Each function's complexity and tokens exclude nested implementations; signature tokens belong to their own function. IDs include line and column to distinguish same-line functions. Physical source lines count blank lines but exclude the phantom line after a final newline. Function coverage reports inclusive body observations separately from exclusive lines. Nested body interiors are excluded from the parent; overlapping boundaries, signatures and same-line functions have unknown attribution. Ambiguous functions have no coverage percentage or complexity-weighted risk, while known exclusive observations remain visible. Line observations do not establish branch coverage.

Workspace discovery supports npm/Yarn package patterns, pnpm workspace patterns, and TypeScript project references. Ownership and cross-workspace edges are exposed. Workspace framework/profile overrides are metadata, not independent per-workspace audit policies; audit uses the root policy.

The bundled dependencies include ESLint/plugins, Knip, jscpd, dependency-cruiser, publint, and ATTW. Integrations can still be unavailable or fail and have built-in fallbacks where implemented. See [integrations and protocol behavior](docs/integrations.md).

Modern web evidence is disabled by default. Install the optional `modern-web-guidance@1.0.0` peer in the analyzed project, enable `modern_web`, and run `measure quality.modern_web`. Scanner execution needs Node 22.13+; other lens tasks also support Node 20.19+. Candidates remain review-only, including when browser support is established. See [configuration](docs/configuration.md#modern-web-evidence) and [scanner limitations](docs/integrations.md#modern-web-guidance).

## Development

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile source, CLI, tests, and scripts into `dist/`. |
| `npm run typecheck` / `npm run lint` | Type checking only; `lint` is an alias, not an ESLint run. |
| `npm test` | Build and run Node's test suite. |
| `npm run test:coverage` | Run the suite with raw V8 traces in `target/coverage/v8`, including inherited subprocess and worker coverage. Replaces the previous traces. |
| `npm run ci` | Typecheck, build, production-dependency engine check, schema/rule checks, formatting checks, tests, performance smoke, package smoke. |
| `npm run catalog` / `npm run measure` | Build and operate on `examples/basic`. |
| `npm run self:measure` / `npm run self:audit` | Build and analyze this repository's root config. |
| `npm run bench` | Synthetic multi-size benchmark. |
| `npm run perf:smoke` | Example performance gate; `TSRQLENS_PERF_MAX_MS` overrides the 60,000 ms budget. |
| `npm run schema:check` / `npm run rule:check` | Validate contracts and drift checks. |
| `npm run format:check` / `npm run package:smoke` | Repository formatting checks / built-package validation. |

The build uses the TypeScript 7 native compiler through `@typescript/native`. Runtime compiler-API analysis uses `typescript`, aliased to `@typescript/typescript6`. GitHub Actions runs `npm run ci` and the acceptance checks on Ubuntu and Windows with Node 20.19.0, 22.13.0 and 24.21.0. `scripts/engine-check.ts` verifies that every production dependency accepts the whole declared Node range. A separate job gates on high-severity advisories in production dependencies (`npm audit --omit=dev --audit-level=high`).

Coverage collection preserves raw per-process V8 observations; it does not claim an aggregated or source-mapped TypeScript coverage percentage. Editor integration tests exercise the real subprocess and analysis worker and verify that both appear in the traces. The worker protocol validates versioned configuration snapshots and returned findings before use, including nested locations and actions.

See the [self-refactoring report](docs/self-refactor.md) for measured before/after results, hotspot summary fields, and the interpretation of leverage and locality evidence.

Artifacts identify the analysis API and native build tool separately under `provenance.compilers`. React health reports each workspace's declared React support range and applicable API guidance, with separate correctness and optimization categories. Typed lint defaults to project-service discovery for conventional projects and preserves explicit custom tsconfigs. See [integrations](docs/integrations.md) and [configuration](docs/configuration.md) for scope and overrides.

The enabled-by-default disk cache stores a reusable project-analysis snapshot in local Turso at `output_dir/.cache/lens.db` (internal cache format 7). Cache key and compiler-query metadata are read before the snapshot payload, so misses avoid parsing the full previous analysis. It fingerprints source/test/compiler inputs, compiler file-discovery and resolution queries (including missing dependencies), and analysis identity; it does not persist external-tool results or a live TypeScript Program. Projects with no source files or unloaded configured TypeScript projects are not cached; external-tool completion is not part of that cache-admission check. Tool results, source fingerprints, and configuration identity are memoized within one analysis generation. A new context starts a generation; callers reusing a context after input changes must call `refresh()`. Configuration-setting changes require a newly loaded config/context. Running a project test command refreshes the context automatically, while its execution artifacts retain the input identity captured before the command. This is project-snapshot reuse, not changed-file-only incremental checking.

Further reading: [rule development](docs/rule-development.md), [implementation status and remaining work](docs/typescript-quality-roadmap.md). The [GitHub checker review](docs/github-quality-checker-review.md), [Fallow comparison](docs/fallow-comparison-opportunities.md), and [original HTML plan](plan.html) are historical research, not current API references.

The [React guidance comparison](docs/react-guidance-review.md) maps seven official React/Vercel sources to current checks, advisory improvements, and coverage limits.
