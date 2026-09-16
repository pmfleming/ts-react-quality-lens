# Integrations, report inputs, and servers

## Execution boundaries

The lens writes artifacts/cache files and temporary tool configurations. It does not invoke upstream `--fix` operations or directly rewrite measured source. This is **not** a read-only sandbox: project tooling may execute configuration, and configured/inferred test commands run arbitrary project code and can modify files.

ESLint/plugins, Knip, jscpd, dependency-cruiser, publint, and Are The Types Wrong are package dependencies, not just optional peer installations. Tool lookup and successful execution still depend on the environment. Inspect each artifact's `tool_status` and confidence fields for availability, completion, reason, and timing where supplied.

- **Typed lint:** a generated managed ESLint config uses the root `tsconfig` and `tsrqlens-typescript-recommended-v1`. It does not reproduce the project's custom lint policy. The managed file pattern covers TS/TSX/MTS/CTS, not JavaScript. Multi-project compiler loading does not imply every file is covered by this root typed-lint configuration.
- **React:** `recommended-v2` selects the installed plugin's recommended-latest rules where available, with compatibility fallbacks; `classic-v1` selects two classic Hooks rules. React tooling can resolve from the measured project before the lens installation. This is not per-framework/compiler-enabled capability gating.
- **Accessibility:** managed jsx-a11y recommended rules, custom component mappings, and optional polymorphic prop configuration. Built-in missing-alt/nonsemantic-interaction heuristics are used when managed analysis does not complete, including when disabled.
- **Clones/dependencies:** jscpd and dependency-cruiser results supplement built-in line/AST clone and import-graph analysis.
- **Cleanup:** Knip runs without fixes. Comparable confirmation/disagreement, non-comparable heuristics, tool exclusions, and unavailable evidence remain distinguishable. Public entrypoints, script binaries, declaration-surface types, and canonical re-exports contribute usage evidence; cleanup candidates are not proof that removal is safe.
- **Packages:** declaration-only emit targets a temporary directory; `npm pack --ignore-scripts --json` creates a temporary tarball for ATTW; publint runs with `pack: "npm"`. The lens does not build publishable output into the project. Prepare the files you intend to publish before measuring package health. Checks concern the configured root package, not an automatic independent validation of every workspace.

## External report formats

Paths in these configuration sections resolve relative to the config directory. The lens ingests existing JSON; it does not collect browser traces or run React Doctor, axe, CodeQL, or Semgrep.

### Runtime evidence

```json
{
  "runtime_inputs": {
    "react_profiler": "reports/profiler.json",
    "axe": "reports/axe.json",
    "react_doctor": "reports/react-doctor.json"
  }
}
```

Supported shapes in `src/measures/runtime.ts`:

| Input | Shape |
| --- | --- |
| React Profiler | An array, or `{ "commits": [...] }`. Each entry needs a finite numeric `duration_ms`, `actualDuration`, or `duration`. Optional names: `component`, `componentName`, or `name`; counts: `render_count` or `renderCount`; also `file`, `line`, and `phase`. This is a commit-summary format, not arbitrary raw DevTools traces. |
| axe | `{ "violations": [...] }`. Each violation needs a string `id` and a `nodes` array of objects. Impact, targets, HTML, help text, and help URL are preserved where present. Findings are project-scoped. |
| React Doctor | `{ "diagnostics": [...] }` or `{ "projects": [{ "diagnostics": [...] }] }`. Each diagnostic needs a string `rule`; optional plugin, severity, paths, ranges, related locations, and fix-group IDs are normalized. |

Valid empty arrays are accepted as complete reports. Missing files, unsupported top-level shapes, or invalid required entries produce incomplete status and input-failure warnings. No configured runtime inputs gives `summary.status: "not_configured"`, not measured zero runtime risk.

### SARIF

```json
{
  "sarif_inputs": [
    { "name": "codeql", "path": "reports/codeql.sarif", "required": true }
  ]
}
```

Inputs must have `version: "2.1.0"` and a `runs` array. Normalization retains tool/rule metadata, partial fingerprints, primary/related ranges, code flows, proposed fixes, automation details, and invocation failures where available. Proposed fixes are data only. This is a targeted normalizer, not full validation of every SARIF field.

SARIF result IDs namespace partial fingerprints by input name, scanner, rule, and normalized file. Occurrence suffixes preserve duplicate results; fingerprints remain stable across line movement. Without fingerprints, identity also uses the source position and message. The `sarif:v2:` identity format replaces the earlier fingerprint-only IDs: regenerate SARIF baselines and update ID-based suppressions after upgrading. Analysis identity records this change so old artifacts cannot be treated as compatible snapshots.

SARIF result levels map to `error → block`, `warning → warn`, `note → info`, and `none → review`. Input/invocation failures map to `block` for required inputs and `warn` otherwise. `required: false` makes report production optional; it does **not** downgrade actual error-level findings.

### Architecture performance inputs

```json
{
  "performance_inputs": {
    "bundle_stats": "reports/bundle.json",
    "render_costs": "reports/render.json"
  }
}
```

Each file may be an array or `{ "modules": [...] }`:

- Bundle records: `{ "file": "src/App.tsx", "bytes": 25000 }`; `name` and `size` are aliases.
- Render records: `{ "file": "src/App.tsx", "ms": 40 }`; `render_ms` is an alias for `ms`.

Use project-relative source paths matching module files. These are simplified input formats, not direct support for every bundler's native stats. Missing, invalid, or empty inputs are ignored and remain optional to map completeness. `runtime_health.json` is not an architecture-map input.

## MCP

```sh
node ./dist/bin/ts-react-quality-lens.js mcp --config ./ts-react-quality-lens.config.json
```

Transport: one JSON-RPC message per line on stdio; advertised protocol version `2025-03-26`.

| Tool | Arguments / behavior |
| --- | --- |
| `catalog` | Return task metadata. |
| `context` | Analyze, write, and return project context. |
| `measure` | Requires `task_id`. `all` skips `correctness.all`; explicitly requesting `correctness.all` is rejected. Other analysis/tool execution still occurs. |
| `audit` | Optional `base`, `gate`, `run_tests` (default false). Tests execute only when `run_tests` is explicitly true. |
| `run_tests` | Execute `correctness.all` using the configured/inferred command. This runs project code. |
| `explain` | Requires `finding_id`; return a finding from emitted artifacts and its rule contract if one exists. Does not trigger fresh measurement. |

`resources/list` advertises task primary artifacts plus `audit.json` and `context.json`. `resources/read` accepts only those `tsrqlens://artifact/<filename>` URIs and requires the artifact to exist; it is not arbitrary file access. The extra `test_catalog.json` is not currently advertised. Tool responses provide JSON text content and `structuredContent`.

## LSP

```sh
node ./dist/bin/ts-react-quality-lens.js lsp --config ./ts-react-quality-lens.config.json
```

Transport: standard Content-Length framing on stdio. The server analyzes **saved files on disk**, not unsaved document contents (`textDocumentSync.change` is 0).

- Initialization/open publishes diagnostics; save/configuration notifications invalidate analysis and republish, clearing resolved diagnostics.
- Config saves and `workspace/didChangeConfiguration` reload the file from disk.
- Document and workspace pull diagnostics are supported.
- A worker thread runs type health, typed lint, dependencies, React health, cleanup, SARIF, and runtime measurements. It does not execute tests or run every catalog task.
- Suppressed findings are hidden. Only findings with a primary `file` become diagnostics; project-scoped and group-only evidence is not fully represented in the editor view.
- Diagnostics include ranges, related information, rule IDs, finding IDs, and actions.
- Code actions offer `tsrqlens.explainFinding` and, where a config edit can be generated, a JSONC-preserving suppression quick fix. The **client** applies the returned workspace edit. The server does not automatically apply it or translate upstream fixes into source edits.

Both endpoints use the configured project root; neither is a general multi-root IDE implementation. LSP dispositions come from measurement artifacts, while audit applies additional policy downgrades, so diagnostic severity and audit gating are not necessarily identical.
