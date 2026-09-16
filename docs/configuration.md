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
| `react` | `ruleset: "recommended-v2"`; use `"classic-v1"` for just Rules of Hooks and exhaustive dependencies. |
| `accessibility` | `enabled: true`, `components: {}`, optional `polymorphic_prop_name`. Disabling managed analysis does not disable built-in fallback heuristics. |
| `cleanup` | `knip: true`, `production: false`. Knip production mode changes its scope and therefore cross-check comparability. |
| `type_coverage` | Optional `minimum_percent`, `per_file_minimum_percent`, `changed_file_minimum_percent` (0–100), and `baseline` pointing to an earlier `type_health.json`. No default floors. |
| `package_health` | `enabled` defaults to true for the `library` profile or an explicit required `package` check, false otherwise. `attw_profile` is `strict` (default), `node16`, or `esm-only`. Explicit `enabled: false` overrides activation but does not remove a required policy check. |
| `sarif_inputs` | Array of `{ "path": "…", "name": "…", "required": false }`; only `path` is required. Default names are `sarif-1`, etc. |
| `runtime_inputs` | Optional `react_profiler`, `axe`, and `react_doctor` JSON paths. All configured inputs are expected to parse successfully. |
| `performance_inputs` | Optional `bundle_stats` and `render_costs` JSON paths, used by `map.architecture`, not `quality.runtime`. |
| `public_api` | `entry`: project-relative entry paths; `exports`: objects with `file` and `names` arrays to preserve intentional public exports during cleanup. |
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
