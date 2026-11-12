# Integrations, report inputs, and servers

## Execution boundaries

Every artifact records `provenance.compilers`: `analysis` identifies the loaded TypeScript compiler API and its actual runtime version; `native` identifies the installed `@typescript/native` build tool (or a null version when unavailable). Native availability is not execution evidence: `analysis_executed` is false. The lens builds with TS7, while diagnostics, type coverage, and typed lint currently use the TS6 compatibility API. `type_health.json` also exposes compiler API load status and stamps compiler diagnostics with their engine/version. Analysis identity includes both versions so toolchain changes invalidate comparisons.

The lens writes artifacts/cache files and temporary tool configurations. It does not invoke upstream `--fix` operations or directly rewrite measured source. This is **not** a read-only sandbox: project tooling may execute configuration, and configured/inferred test commands run arbitrary project code and can modify files.

ESLint/plugins, Knip, jscpd, dependency-cruiser, publint, and Are The Types Wrong are package dependencies, not just optional peer installations. Tool lookup and successful execution still depend on the environment. Inspect each artifact's `tool_status` and confidence fields for availability, completion, reason, and timing where supplied.

- **Typed lint:** a generated managed ESLint config uses `tsrqlens-typescript-recommended-v4`. `typed_lint.mode: "auto"` selects project service for conventional root configs and workspace-only projects; an explicitly selected custom config retains `project` mode. Project service uses each file's nearest `tsconfig.json` and supports project references. Explicit `project` mode uses only the selected config. The artifact reports `project_mode`, `configured_project` (null for project service), API version, timing, and completeness. Uncovered files produce parser findings and incomplete evidence; there is no silent retry with weaker settings. Missing configs/source roots are incomplete. TypeScript plugins and out-of-project default-project allowances are disabled. Managed rules cover TS/TSX/MTS/CTS and do not reproduce custom project lint policy. See [typescript-eslint's project-service guidance](https://typescript-eslint.io/packages/parser/#projectservice).
- **React:** `recommended-v2` selects the installed plugin's recommended-latest rules where available, with compatibility fallbacks; `classic-v1` selects two classic Hooks rules. Managed Hooks execution uses the lens's plugin/parser versions, matching the recorded analysis identity rather than silently resolving a different project plugin. `react_support` in `react_health.json` reports each workspace's supported range, API capabilities, and applicable guidance. Peer ranges take precedence over dependencies, optional dependencies, and dev dependencies. An explicit `react.version` overrides every workspace. A capability is recommended only when the entire declared stable range supports it; ranges spanning older versions are `mixed`. Missing versions, previews, catalogs, tags, and invalid ranges are `unknown`, with no version-specific advice. A workspace without a declaration does not inherit the root range. Guidance is advisory metadata, not evidence that a migration is necessary or that React Compiler is enabled. Existing correctness rules remain active across versions.
- **Accessibility:** managed jsx-a11y recommended rules, custom component mappings, and optional polymorphic prop configuration. Built-in missing-alt/nonsemantic-interaction heuristics are used when managed analysis does not complete, including when disabled.
- **Clones/dependencies:** pinned jscpd 5.4.0 is a Rust/native engine distributed through npm platform packages. Do not omit optional dependencies if external clone execution is required. Its isolated managed config selects discovered source files and absolute report paths; project `.jscpd.json` is not loaded, and semantic model downloads/network providers are not enabled. Malformed/missing/out-of-scope reports fail execution rather than appearing clean. Original engine observations survive presentation deduplication. Dependency-cruiser and internal import-graph analysis remain alternative cycle engines.
- **Native platforms:** clean Linux Node 20/24 installs and installed-native-engine smoke are tested. Windows execution is still pending. On NixOS, raw npm-installed GNU binaries need a compatible loader; the flake adds ELF patching and its package build is verified. Missing/unrunnable engines have explicit status and scoped built-in fallbacks, not invented external verification.
- **Cleanup:** Knip runs without fixes. Exact-subject positive confirmation, non-comparable heuristics, tool exclusions, and unavailable evidence remain distinguishable. Knip's issue-only output does not provide evaluated negatives: silence is not disagreement. Both supporting observations are retained. Public entrypoints, script binaries, declaration-surface types, and canonical re-exports contribute usage evidence; cleanup candidates are not proof that removal is safe.
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

Payloads are wrapped in `{ provenance: { source_set_hash }, producer: { name, version }, environment: { ... }, data: ... }` to establish matching source and declared producer/environment context. Valid empty payloads can be complete only with that matching provenance; unlinked observations remain advisory/incomplete. Missing files, unsupported top-level shapes, or invalid required entries produce incomplete status and input-failure warnings. No configured runtime inputs gives `summary.status: "not_configured"`, not measured zero runtime risk.

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

## Modern Web Guidance

Install the validated optional scanner in the analyzed project using `npm install --save-dev --save-exact modern-web-guidance@1.0.0`. Enable `modern_web` and invoke `ts-react-quality-lens measure quality.modern_web --config <config>`. Enabled `measure all` and audits also run this task. No package downloads or installations occur during measurement. The scanner runs under the lens process's Node executable and requires Node 22+; absent, incompatible, or unsupported versions are reported as unavailable. Source checkouts of the lens include the pinned scanner as a development dependency for integration tests. Installed consumers use the optional peer dependency.

The adapter invokes the documented `legacy-scan --json` command against a temporary snapshot of selected inputs, with telemetry disabled. It validates JSON, counts, locations and file scope, preserves verification rubrics, and applies time/output bounds. Browser target resolution uses pinned Browserslist and MDN browser compatibility data; no live browser or network lookup is used to determine support.

`modern_web.json` separates execution (`disabled`, `unavailable`, `failed`, `succeeded`) from coverage (`not_run`, `unknown`). Successful execution means a validated report was received. Overall evidence remains partial because upstream silently catches per-file parser exceptions, omits evaluated-file inventory and internal guide hashes, and covers only its qualified subset of guides. An empty report does not establish that a project is modern or defect-free. Optional scanner failure does not make the audit fail or incomplete.

All candidates have `disposition: review`, `semantic_decision: unresolved`, and pending contextual verification. `upstream_message` preserves the scanner's wording. The displayed message qualifies advice by browser support. Compatibility states are `supported`, `fallback_required`, `incompatible`, and `unknown`; the latter two withhold replacement advice. Partial, flagged, prefixed, preview-only or absent support data cannot establish full support. A Baseline label alone is not treated as a project target matrix.

The first feature mapping covers field sizing, intrinsic-size animation through `interpolate-size`, dialog light dismissal, declarative dialog/popover controls (when a script handler identifies which API is being replaced), and JavaScript scroll reveal. Other rules remain review candidates with unassessed compatibility. Guard recognition is limited to an enclosing literal `if (!CSS.supports(property, value))` for mapped script patterns. It records a syntactic observation, not proof of a working fallback, and never automatically drops the candidate. HTML/CSS guards, aliases and cross-file helpers need contextual review.

Identities combine rule, guide, file, a conservative source-line anchor and occurrence, without commit or line number. Script anchors ignore token whitespace/comments; HTML/CSS preserve internal whitespace. Unrelated line shifts retain identities, while multiline reformatting or changed anchor text may create a new identity. ID/kind suppressions for modernization are not reported as stale because coverage is unknown. Baselines, changed-line selection, MCP resources/explanations and audit reporters retain these review records. No source edit is applied automatically.

The LSP reads current saved `modern_web.json` evidence and exposes file diagnostics. It does not launch this scanner on open, save or keystrokes. Changed inputs hide stale modernization diagnostics until a CLI/MCP measurement refreshes the artifact; a subsequent save or configuration notification refreshes the editor view.

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

## React performance evidence

The existing `runtime_inputs.react_profiler` accepts commit-summary arrays as before. `actualDuration` is render time for the Profiler subtree, including descendants; it is not the duration of React's commit phase. Generic `duration_ms`/`duration` inputs remain explicitly labeled reported durations. Durations must be finite and nonnegative; a supplied render count must be a positive integer. The wrapper's `environment` is retained on observations. Use `environment.build: "development"` to identify development measurements: these stay review-only and carry an instrumentation/Strict Mode caveat. A provenance match establishes association with source, not production representativeness.

A second, explicit lens interchange format accepts normalized React Performance Tracks. This is a format for an exporter you control; it is **not** native Chrome trace JSON or an exporter supplied by the lens:

```json
{
  "provenance": { "source_set_hash": "<matching lens source hash>" },
  "producer": { "name": "your-trace-normalizer", "version": "1.0.0" },
  "environment": { "build": "development", "react_version": "19.2.0", "scenario": "open search" },
  "data": {
    "format": "react-performance-tracks-v1",
    "events": [
      { "id": "search-render-1", "track": "components", "phase": "render", "name": "Search", "start_ms": 10, "duration_ms": 12 },
      { "id": "search-effect-1", "track": "components", "phase": "effect", "name": "Search", "start_ms": 22, "duration_ms": 2 }
    ]
  }
}
```

Every event needs a unique nonempty ID/name and finite nonnegative millisecond start/duration. Supported combinations:

- `scheduler`: `update`, `render`, `commit`, `remaining-effects`, `cascading-update`.
- `components`: `render`, `effect`, `mount`, `unmount`, `reconnect`, `disconnect`.
- `server`: `request`, `component`.

The environment must declare `development` or `profiling` and React 19.2+ support. Server events require `development`, following React's documented availability. Missing or mismatched source/producer provenance leaves otherwise valid observations unverified and the input incomplete. Invalid formats, phases, duplicate IDs, impossible metrics, or unsupported environments fail the input explicitly, including empty reports.

Events retain their separate phases and environment; imported durations can overlap or include descendants. No totals, waterfall diagnoses, before/after gains, or production claims are inferred. `complete` means validated ingestion with matching provenance, not exhaustive runtime coverage. See [React's Performance Tracks documentation](https://react.dev/reference/dev-tools/react-performance-tracks) and [Profiler timing definitions](https://react.dev/reference/react/Profiler).

## React Compiler execution reports

Configure `runtime_inputs.react_compiler` with a JSON path and run `measure quality.runtime`. This imports normalized build logs; it does not install or invoke React Compiler, execute build configuration, or infer activation from a dependency declaration. `react_health.json` retains its separate unverified declaration context.

Use the usual source/producer/environment wrapper. Example:

```json
{
  "provenance": { "source_set_hash": "<matching lens source hash>" },
  "producer": { "name": "your-compiler-log-normalizer", "version": "1.0.0" },
  "environment": { "build_id": "build-123", "react_version": "19.2.0", "target": "19" },
  "data": {
    "format": "react-compiler-report-v1",
    "compiler": { "name": "babel-plugin-react-compiler", "version": "1.0.0" },
    "scope": {
      "name": "application components", "complete": true,
      "functions": [{ "id": "App", "file": "src/App.tsx", "line": 1, "name": "App" }]
    },
    "events": [{ "function_id": "App", "kind": "CompileSuccess" }]
  }
}
```

Files must belong to the lens's selected source set and locations must exist. Function IDs and file/line/name identities must be unique. Each function may have one terminal outcome: `CompileSuccess`, `CompileSkip`, or `CompileError`. Skips/errors require a reason and remain review evidence. `CompileDiagnostic` requires a reason; `Timing` requires a nonnegative finite `duration_ms`; `PipelineError` requires a reason and may use a null function ID. React and compiler versions must be concrete semver values; `target` is `17`, `18`, or `19`. Unknown events, missing functions, duplicate outcomes, or invalid locations fail ingestion.

`import_metadata.react_compiler` retains source verification, build-scope counts and reported coverage. A percentage is emitted only with matching provenance, a complete declared inventory, one terminal outcome per inventoried function, no pipeline failure, and a nonempty denominator. Missing/stale provenance, partial scope, missing outcomes, or pipeline failure produce incomplete input status and no percentage. Skips/errors are recorded outcomes, not failures of report ingestion. Compilation success does not establish runtime correctness, a speedup, or whole-project compiler coverage. The collector must supply the complete inventory; silence in logger events is not an evaluated negative.

The format deliberately normalizes [official logger events](https://react.dev/reference/react-compiler/logger), whose upstream structure can change between compiler versions. Source changes and edits to the report invalidate saved evidence. Configured incomplete reports participate in the existing runtime audit completeness policy.

## Bundle and runtime baseline comparisons

Configure both paths, relative to the lens config, then run `measure quality.runtime`:

```json
{
  "runtime_inputs": {
    "performance_current": "reports/current.json",
    "performance_baseline": "reports/baseline.json"
  }
}
```

Both files use `react-performance-snapshot-v1`. They are normalized exports from your build/benchmark tooling, not arbitrary bundler JSON, raw Chrome traces, or the legacy architecture-map `performance_inputs.bundle_stats` format. The lens reads these snapshots and never overwrites or advances the baseline. Example current snapshot (the baseline uses its own historical source hash/build ID and measurements):

```json
{
  "provenance": { "source_set_hash": "<current lens source hash>" },
  "producer": { "name": "your-performance-exporter", "version": "1.0.0" },
  "environment": {
    "build_id": "build-124", "build": "production",
    "build_config_hash": "<stable build settings hash excluding source/build ID>",
    "toolchain_hash": "<build tool and plugin versions hash>",
    "react_version": "19.2.0", "browser_targets": ["chrome 140"],
    "runtime_context": {
      "browser": "Chrome", "browser_version": "140", "os": "Linux",
      "device": "controlled-runner-a", "network": "local-fixture", "viewport": "1280x800",
      "harness_version": "1", "scenario_version": "search-v1", "cache_state": "warm"
    }
  },
  "data": {
    "format": "react-performance-snapshot-v1",
    "bundles": {
      "complete": true, "routes": ["/search"], "encodings": ["gzip"],
      "entries": [
        { "route": "/search", "chunk": "app", "loading": "initial", "encoding": "gzip", "bytes": 12000 },
        { "route": "/search", "chunk": "editor", "loading": "deferred", "encoding": "gzip", "bytes": 4000 }
      ]
    },
    "runtime": {
      "complete": true,
      "entries": [{
        "scenario": "search", "metric": "render-duration", "unit": "ms",
        "samples": [
          { "run_id": "run-1", "value": 12 }, { "run_id": "run-2", "value": 13 },
          { "run_id": "run-3", "value": 11 }, { "run_id": "run-4", "value": 14 },
          { "run_id": "run-5", "value": 12 }
        ]
      }]
    }
  }
}
```

A snapshot may contain bundles, runtime measurements, or both. Runtime context is required only for runtime data. Runtime samples represent separate scenario runs, not nested spans from one trace. Run IDs must be unique within each scenario/metric; values must be finite and nonnegative. Bundle sizes must be nonnegative safe integers. Route/encoding inventories and route/chunk/encoding keys must be unique. Use stable logical chunk names and attribute shared chunks per route. Do not report the same chunk in both loading phases for the same route/encoding. Supported encodings are `raw`, `gzip`, and `brotli`.

Comparison rules:

- The current snapshot must match the analyzed source hash. Baseline source identity is retained as a historical declaration; the lens cannot independently verify the archived build from this JSON alone. Different source hashes and build IDs are expected across revisions.
- Producer name/version, build mode, build-settings hash, toolchain hash, concrete React version, and declared browser-target set must match. The exporter must include relevant minification, splitting, runtime, and target settings in those fingerprints. Development builds are not compared.
- Bundle comparisons require complete production inventories. Each shared route/encoding gets initial and deferred totals plus chunk attribution. Missing chunks within a declared complete route/encoding scope count as zero. Missing routes or encodings are explicitly unpaired, not assumed to be zero. Shared chunks are never totaled across routes.
- Runtime comparisons require complete reports, matching browser/version, OS, device, network, viewport, harness, scenario version and cache state, plus at least five samples on each side for each matched scenario/metric. Five is a lens minimum, not a statistical sufficiency claim. Profiling builds may be compared with profiling builds. Samples retain count, range, median and nearest-rank p95; raw spans are never summed.
- Records report signed absolute and percentage differences. A zero baseline has a null percentage. No automatic regression/gain label, causal attribution, significance estimate, or blocking threshold is inferred. Comparisons are review evidence.

`import_metadata.performance_comparison` records `comparable`, `incompatible`, or `unverified`, with reasons, source/build identities and `not_compared` subjects. A comparable subset can coexist with explicitly unpaired measurements. Valid incompatible snapshots count as completed ingestion and yield a review diagnostic; they produce no numerical comparisons. Missing files, malformed data or a missing path pair make runtime evidence incomplete. Unverified current provenance also makes it incomplete. Both snapshot contents participate in freshness and in-run input-change checks.

These comparisons operationalize the [Vercel prioritization of waterfalls and bundle size](https://vercel.com/blog/introducing-react-best-practices), [Next.js production measurement guidance](https://nextjs.org/docs/app/guides/production-checklist), and [React Performance Tracks](https://react.dev/reference/dev-tools/react-performance-tracks). They do not yet infer request independence or diagnose waterfalls from timing alone.
