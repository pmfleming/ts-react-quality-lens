# Configuration reference

Runtime configuration is parsed as JSONC with TypeScript's parser and validated against the bundled [JSON Schema](../ts-react-quality-lens.config.schema.json) using Ajv. Unknown top-level and nested option keys are rejected, as are invalid value types. `$schema` is an optional editor hint; runtime validation does not fetch it.

The default filename is `ts-react-quality-lens.config.json` in the current working directory. `--config` selects a different file. If the file does not exist, the loader uses defaults; `init` is not required to measure a project.

## Paths and discovery

- `project_root` and `output_dir` resolve relative to the **config directory**, not the shell working directory or each other.
- Explicit `tsconfig`, report paths, `type_coverage.baseline`, and `audit.baseline` also resolve relative to the config directory.
- Each source/test root is first resolved relative to the config directory. If that path does not exist, it is resolved relative to `project_root` instead. For predictable results, keep the config at the project root or use absolute roots.
- Finding files, `public_api` entries, suppression files, and layer patterns use project-relative paths. Suppression files are exact matches, not globs.
- CLI `--baseline` and `--save-baseline` paths are used as supplied, so relative CLI paths are relative to the shell working directory.

| Field | Default and behavior |
| --- | --- |
| `project_name` | Root package name, otherwise project directory name. |
| `project_root` | `.` relative to config directory. |
| `source_roots` | `src`, `app`, `pages`, `components`, `packages`, `libs`. Explicit arrays replace defaults. |
| `test_roots` | `src`, `test`, `tests`, `__tests__`, `e2e`, `cypress`. Explicit arrays replace defaults. |
| `output_dir` | `target/analysis` relative to config directory. |
| `tsconfig` | Auto-detect `project_root/tsconfig.json`. |
| `package_manager` | Detect pnpm, Yarn, Bun, then npm lockfiles; fall back to npm if a package manifest exists, otherwise `unknown`. Omit for detection; there is no special `auto` value here. |
| `framework` | Omitted or `auto`: detect Next, Remix, Expo, Astro, Vite, React Router, or React from dependencies/conventional files; otherwise `unknown`. |
| `test_runner` | Omitted or `auto`: detect Vitest, Jest, Playwright, Cypress, or Node from dependencies, scripts, or conventional files. This labels evidence; it does not select a test command. |
| `test_command` | When omitted, infer `<package-manager> run test` if the root manifest has a `test` script. `null` disables inference/execution. A string runs with the project shell. |
| `exclude` | Adds to built-in excludes; does not replace them. |

Source/test discovery walks directories and accepts `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, and `.cts`; `.mjs` and `.cjs` are not discovered as source files. Tests are recognized by test/spec/e2e filename suffixes or conventional test-directory path segments relative to `project_root`, and excluded from the source module set. Parent directories outside the project do not affect classification.

Framework detection is broader than convention analysis: the built-in convention adapters currently cover generic React, Next.js, Remix, and Storybook signals. Detecting Expo, Astro, or Vite does not imply a comprehensive framework-specific ruleset.

Built-in excludes are `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.turbo`, `target`, `out`, `*.snap`, `*.generated.*`, `*.gen.*`, and `*.d.ts`. These apply to source/test discovery; declaration files can still be compiler inputs. External tools have their own scopes and ignores, so do not assume identical project selection across every adapter.

## Analysis options

| Field | Supported options and defaults |
| --- | --- |
| `cache` | `enabled: true`; cache directory is fixed under `output_dir/.cache`. |
| `react` | `ruleset: "recommended-v2"`; use `"classic-v1"` for just Rules of Hooks and exhaustive dependencies. Optional `version` overrides the supported React range for all workspaces (for example `"^19.3.0"`). |
| `typed_lint` | `mode: "auto"` uses project service for a conventional root `tsconfig.json` or workspaces without a root config. A selected custom config uses `project` mode. Set `"project-service"` to explicitly discover each file's nearest tsconfig, or `"project"` to use only the selected `tsconfig`. |
| `accessibility` | `enabled: true`, `components: {}`, optional `polymorphic_prop_name`. Disabling managed analysis does not disable built-in fallback heuristics. |
| `cleanup` | `knip: true`, `production: false`. Knip production mode changes its scope and therefore cross-check comparability. |
| `documentation` | `enabled: false`; optional project-relative `exclude` patterns and `exempt_exports` entries (`file`, `names`, nonblank `reason`). Reports public export documentation presence in `type_health.json`; see below. |
| `type_coverage` | Optional `minimum_percent`, `per_file_minimum_percent`, `changed_file_minimum_percent` (0–100), and `baseline` pointing to an earlier `type_health.json`. No default floors. |
| `package_health` | `enabled` defaults to true for the `library` profile or an explicit required `package` check, false otherwise. `attw_profile` is `strict` (default), `node16`, or `esm-only`. Explicit `enabled: false` overrides activation but does not remove a required policy check. |
| `sarif_inputs` | Array of `{ "path": "…", "name": "…", "required": false }`; only `path` is required. Default names are `sarif-1`, etc. |
| `runtime_inputs` | Optional profiler, axe, React Doctor, compiler-report and paired performance-snapshot paths. Configured inputs must parse and satisfy their provenance/completeness requirements. |
| `performance_inputs` | Optional `bundle_stats` and `render_costs` JSON paths, used by `map.architecture`, not `quality.runtime`. |
| `public_api` | `entry`: project-relative entry paths; `exports`: objects with `file` and `names` arrays to preserve intentional public exports during cleanup and define the optional documentation scope. |
| `layer_rules` | Ordered `{ "layer": "…", "patterns": ["…"] }` rules. A nonempty array replaces the built-in route/feature/ui/hook/lib/core rules. |

Type-coverage floors and ratchet regressions emit **warnings**, not blockers. Changed-file floors require a usable audit base. Missing/unreadable/malformed type-coverage baselines are currently ignored, not reported as incomplete. Type coverage describes checked identifier types, not executed test coverage.

Example optional configuration fragment:

```json
{
  "accessibility": {
    "components": { "Image": "img", "Link": "a" },
    "polymorphic_prop_name": "as"
  },
  "public_api": {
    "entry": ["src/index.ts"],
    "exports": [{ "file": "src/format.ts", "names": ["formatMoney"] }]
  },
  "type_coverage": {
    "minimum_percent": 90,
    "changed_file_minimum_percent": 95,
    "baseline": "baselines/type_health.json"
  }
}
```

## Modern web evidence

`modern_web` is optional and disabled by default. `roots` resolve relative to the lens configuration file and default to the project root. The scan includes JS/TS variants, `.html`, `.htm`, `.css` (including CSS Modules), and relevant ancestor package manifests. It uses separate discovery from the TypeScript module graph. Project exclusions and `modern_web.exclude` apply together. Tests, documentation/examples/demo directories, generated/build output, symlinks, and configured output directories are excluded. Unsupported SCSS/Sass/Less and framework template formats are reported as skipped; they are not compiled. Inputs outside the project are rejected from selection.

```json
{
  "modern_web": {
    "enabled": true,
    "roots": ["src", "public", "index.html"],
    "exclude": ["vendor"],
    "timeout_ms": 120000,
    "max_output_bytes": 8388608,
    "browsers": {
      "targets": ["chrome 130", "firefox 120", "safari 17"],
      "environment": "production"
    }
  }
}
```

Omit `browsers.targets` to discover the nearest repository `.browserslistrc`, `browserslist` file, or `package.json` Browserslist field for each selected file. Child packages may have different targets. Explicit targets override discovery. Named environments fall back to a declared `defaults` section; missing/empty queries, conflicts, malformed configuration and unknown browsers produce an unknown result. Discovery stops at the project root and ignores ambient `BROWSERSLIST` settings. Shared `extends` configs and custom usage statistics are outside the supported scope; supply explicit queries for those projects.

Timeout defaults to 120 seconds (maximum 600); output defaults to 8 MiB (maximum 64 MiB). The web inventory limits individual files to 1 MiB and selects at most 10,000 files, recording skipped paths. The upstream scanner has additional filters and does not report every skipped or unparsed file.

Browser resolution and support data are pinned dependencies. Artifacts record their versions, resolved targets, configuration origins, mapping version, and input fingerprints. HTML/CSS edits, additions/removals, browser configuration changes, and scanner/data changes invalidate saved modernization evidence. CSS-only edits do not enter the compiler project cache or TypeScript metrics.

## Workspaces

`workspaces.enabled` defaults to true. Discovery uses, in order:

1. A nonempty `workspaces.patterns` override.
2. Root `package.json` workspaces (an array or `workspaces.packages`).
3. Patterns read from `pnpm-workspace.yaml`.

The root project is always represented. Workspace matching supports `*`, `**`, and negative `!` patterns; pnpm parsing is a simple list-line reader, not a full YAML implementation. Child packages need package manifests. Workspace tsconfigs and project-reference closures are loaded and their completion status is exposed.

```json
{
  "source_roots": ["packages"],
  "workspaces": {
    "patterns": ["packages/*", "!packages/fixtures"],
    "overrides": [
      { "workspace": "@example/web", "framework": "next", "policy_profile": "react" }
    ]
  }
}
```

An override matches a workspace's name or relative root. It changes the workspace record's metadata; it does **not** independently select lint rules or audit requirements for that package. Audit policy and managed typed-lint configuration remain rooted in the top-level config. Workspace discovery also does not replace `source_roots`; include the directories you want measured.

## Policy, audit, and suppressions

| Field | Default and behavior |
| --- | --- |
| `policy.profile` | `baseline`; `init` deliberately writes `recommended` instead. Other values: `strict`, `react`, `library`. |
| `policy.required_checks` | Replaces profile defaults, including when empty. Allowed: `compiler`, `typed-lint`, `tests`, `react-hooks`, `package`. |
| `audit.base` | No configured default; audit attempts `origin/main` if it exists. |
| `audit.changed_since` | Alternative base ref, takes precedence over `audit.base`. It is not a timestamp. |
| `audit.gate` | `new-only`; alternative `all`. |
| `audit.baseline` | Optional saved finding-ID set or audit artifact. |
| `suppressions` | Array of exact `id`, `file`, and/or `kind` selectors, with optional `reason`. At least one selector is required; supplied selectors are ANDed. |

See [rule profiles](rule-catalog.md) and the [audit reference](audit.md). Disabling a tool is not the same as removing its policy requirement. Replacing `required_checks` also does not disable measurement tasks or universally silence compiler, accessibility, runtime, or imported SARIF findings.

## Custom Effect hooks

Set `react.additional_effect_hooks` to a JavaScript regular expression, for example `"^(useRemoteEffect|useSubscriptionEffect)$"`. The managed Hooks plugin receives it through the official shared `additionalEffectHooks` setting in both `classic-v1` and `recommended-v2`. Empty, malformed, or over-256-character expressions are rejected. The managed plugin dependency supports this setting (React documents it for plugin 6.1.1+).

`react_health.json.custom_effect_hooks` records the pattern, run status, and matching direct named call sites. This is a syntactic inventory, not proof that every call was semantically evaluated. Member calls and alias resolution are not inventoried. Configure the names actually called in your source. Changing the setting invalidates prior analysis identity. See [the official setting](https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps#options).

`runtime_inputs.react_compiler` accepts a source-linked normalized React Compiler build report. Its path resolves relative to the lens config. See [the execution-report format](integrations.md#react-compiler-execution-reports); absent input is optional, while a configured invalid or incomplete report makes runtime evidence incomplete.

For measured baseline comparisons, set both `runtime_inputs.performance_current` and `runtime_inputs.performance_baseline` to normalized snapshot paths. Run `measure quality.runtime`; the lens does not run benchmarks or update the baseline. See [comparison requirements and format](integrations.md#bundle-and-runtime-baseline-comparisons). Legacy `performance_inputs.bundle_stats` and `render_costs` still feed the architecture map and do not establish comparable baseline evidence.

## Optional public API documentation

Enable documentation measurement within `quality.type_health`:

```json
{
  "public_api": { "entry": ["src/index.ts"] },
  "documentation": {
    "enabled": true,
    "exclude": ["src/vendor/*"],
    "exempt_exports": [
      { "file": "src/app/page.tsx", "names": ["default"], "reason": "Framework route entrypoint." }
    ]
  }
}
```

A nonempty `public_api.entry` or `public_api.exports` explicitly selects the surface; otherwise detected package export/main/module/types source entrypoints are used. Paths use project-relative matching (`*` matches any characters, including `/`, as in cleanup selectors). This is not a claim to discover every published subpath. Configure source entrypoints explicitly when package metadata points only to unresolved build outputs. Framework exports can be exempted by name and reason; the lens does not assume every default export is a framework entrypoint.

Compiler-resolved aliases and star re-exports inherit documentation from their targets. Each entrypoint/export name is counted once; the same declaration exposed through two names or entrypoints counts twice. Only top-level exports are measured, not class/interface members. Exports whose declarations are outside selected sources, generated filenames (`*.generated.*`, `*.gen.*`), leading `@generated` comments, and configured exclusions/exemptions stay outside the denominator. Normal source-discovery exclusions also apply.

`documentation.summary` reports evaluated/documented/undocumented/excluded/unavailable export counts, coverage percentage, and deprecated exports with/without guidance text. Nonempty JSDoc descriptions or descriptive param/return/remarks/example/deprecated tags count as documentation. A nonempty `@deprecated` message counts as guidance text; usefulness and migration correctness still require review.

The report distinguishes `disabled`, `not_applicable`, `complete`, and `incomplete`. Coverage is `null` without an eligible denominator or when requested scope/compiler inventory is incomplete, including unmatched selectors and source diagnostics. Missing evidence is not a clean result. Available findings remain advisory and this optional report does not add a required audit check or coverage gate. Changing its configuration invalidates cached analysis.

## Compiler runtime contexts

Optional `typescript.targets` declares an execution environment for each analyzed tsconfig:

```json
{
  "typescript": {
    "targets": [
      { "tsconfig": "tsconfig.json", "environment": "node" },
      { "tsconfig": "packages/ui/tsconfig.json", "environment": "bundler" }
    ]
  }
}
```

Environments are `node`, `bundler`, `browser` (unbundled modules), and `library`. Paths are project-relative, unique and confined to the project. Targets describe already analyzed configurations; they do not load extra configs. Select custom configs with `tsconfig`, or use discovered workspace configs. Missing target configs report unavailable. Configs with no declared environment report unknown and receive no runtime-specific recommendations.

`type_health.json.compiler_targets` contains contexts and effective module options. Reviews cover runtime resolution, independent transpilation, duplicate emit, and library declaration/output/runtime-floor concerns. External emitters may intentionally satisfy these requirements elsewhere. No runtime-specific review gates the audit. Compiler defaults are read from checked runtime exports of the installed analysis compiler; unavailable computed defaults cause abstention.
