# Oxlint evaluation — 2026-09-29

Recommendation: add Oxlint as an optional typed-lint backend, retaining ESLint for explicit custom tsconfig selection and the official React Hooks/Compiler rules. Do not replace the current default before checking the full regression corpus and project-completeness behavior.

## Local trial

Repository: `288ad47`. Windows, Node 24.11.0. Installed Oxlint 1.86.0 and oxlint-tsgolint 7.0.2003 under the ignored `target/oxlint-evaluation` directory; the root package manifest, lockfile, and source are unchanged.

The exact ten managed TypeScript rule configurations were extracted from the existing adapter, with only the plugin prefix changed. Default correctness rules were disabled. Both tools analyzed `src`, `bin`, and `scripts`; Oxlint reported 70 files and ten rules. No fixes were applied.

| Run | Oxlint milliseconds | Existing ESLint adapter milliseconds |
| --- | ---: | ---: |
| 1 | 398 | 3783 |
| 2 | 239 | 3797 |
| 3 | 252 | 3778 |
| Median | 252 | 3783 |

Both reported the existing unsafe worker-data assertion at `src/lsp-worker.ts:13`. This is about 15× faster for this typed-lint invocation, not a measurement of total lens runtime or proof of complete rule equivalence. Timings exclude installation and include process startup; the ESLint adapter also creates and removes its temporary config. An initial run failed to resolve the isolated tsgolint installation; these timings come from successful reruns with `OXLINT_TSGOLINT_PATH` explicitly set to the installed native executable.

## Confirmed compatibility gap

A fixture's root tsconfig includes only `src/index.ts`. Its custom `tsconfig.lint.json` includes all source files and defines an `@model` alias to a typed module. `src/extra.ts` imports the alias.

- ESLint with the custom project: complete, zero findings.
- Oxlint with `--type-aware --type-check --tsconfig tsconfig.lint.json`: unresolved `@model`, plus unsafe assignment/member-access findings caused by the unresolved type.
- Oxlint without `--tsconfig` gives the same diagnostics.

This matches the documented limitation: the flag controls import-rule resolution, but the type-aware engine discovers tsconfig.json independently. See `custom-alias-result.json`. A simpler explicit-any fixture was detected by both tools; that alone did not establish custom-config compatibility.

## Integration requirements

1. Add an explicit engine option; retain the existing backend for unsupported project configurations.
2. Normalize Oxlint rule IDs and multi-label locations into lens findings while recording the actual engine/version. Compare suppression and baseline identity behavior before switching engines.
3. Verify all 22 corpus cases, workspace references, uncovered files, invalid configs, and missing dependencies. An empty diagnostic list must not imply complete analysis.
4. Keep official React Hooks/Compiler checks initially. Oxlint's native React Compiler rules are experimental; JavaScript plugin compatibility is alpha.
5. Benchmark the full lens after integration. Oxlint replaces lint work, not the compiler-API analysis used for graph/type metrics, cloning, package checks, or tests.

## Primary references

- [Type-aware linting and TypeScript compatibility](https://oxc.rs/docs/guide/usage/linter/type-aware)
- [CLI and the custom-tsconfig limitation](https://oxc.rs/docs/guide/usage/linter/cli)
- [Native plugins and experimental React Compiler rules](https://oxc.rs/docs/guide/usage/linter/plugins)
- [JavaScript plugin compatibility](https://oxc.rs/docs/guide/usage/linter/js-plugins)

Raw evidence: `benchmark.json`, `typed.json`, `oxlint-*.json`, `eslint-*.json`, and `custom-alias-result.json` in `target/oxlint-evaluation`. `benchmark.mjs` reruns the local timing comparison from the repository root. Generated evaluation tools and raw outputs remain local.
