# Rule and Gate Catalog

This catalog documents the default policy introduced with artifact schema `0.2.0`. A numeric risk score is retained for ranking and compatibility, but it does not decide whether an audit fails.

## Dispositions

| Disposition | Audit behaviour |
| --- | --- |
| `block` | Fails the active audit gate. |
| `warn` | Produces a warning verdict when no blocker exists. |
| `review` | Appears as review evidence but does not change the verdict. |
| `info` | Context only. |

A suppressed finding does not affect the verdict. Under `new-only`, inherited findings do not affect it either.

If profile-required evidence does not run, audit returns `incomplete`. A blocker takes precedence, so an audit with both a confirmed blocker and unavailable evidence returns `fail` while preserving incomplete reasons.

## Authoritative rules

| Rule | Source | Default | Rationale |
| --- | --- | --- | --- |
| `typescript/TS…` | TypeScript compiler | `block` for errors | Compiler diagnostics are deterministic for the measured program. |
| `test-runner/execution` | Configured test command | `block` | A completed failing test run is direct correctness evidence. |
| `@typescript-eslint/no-unsafe-assignment` | typescript-eslint | `block` | Prevents unchecked `any` propagation. |
| `@typescript-eslint/no-unsafe-argument` | typescript-eslint | `block` | Prevents unsafe values crossing call boundaries. |
| `@typescript-eslint/no-unsafe-call` | typescript-eslint | `block` | Prevents calling unresolved or `any` values. |
| `@typescript-eslint/no-unsafe-member-access` | typescript-eslint | `block` | Prevents unchecked member access. |
| `@typescript-eslint/no-unsafe-return` | typescript-eslint | `block` | Prevents unsafe values escaping a function boundary. |
| `@typescript-eslint/no-floating-promises` | typescript-eslint | `block` | Detects promises whose rejection is not handled. |
| `@typescript-eslint/no-misused-promises` | typescript-eslint | `block` | Detects promises used where synchronous values are expected. |
| `@typescript-eslint/ban-ts-comment` | typescript-eslint | `block` | Managed configuration rejects `@ts-ignore`/`@ts-nocheck` and requires descriptions for `@ts-expect-error`. |

Type-aware ESLint findings are authoritative only when parsing and TypeScript project loading succeed. Otherwise the tool is unavailable evidence rather than a clean result. Profiles that do not require `typed-lint` retain these findings as review evidence rather than gating on them.

## Warnings

| Rule or finding | Default | Notes |
| --- | --- | --- |
| `@typescript-eslint/no-unnecessary-type-assertion` | `warn` | Usually safe to remove, but not a correctness failure. |
| `@typescript-eslint/no-unsafe-type-assertion` | `warn` | Requires review because boundary adaptation can be intentional. |
| `type_safety_posture` | `warn` outside baseline | Reports options required by the selected profile. |
| `ts_ignore` | `warn` | Structural signal; managed lint provides the stronger check. |
| `ts_nocheck` | `warn` | Disables checking for a whole file. |
| `layer_violation` | `warn` | Deterministic against configured layers, but architecture policy is project-specific. |
| `import_cycle` | `warn` | Useful architecture evidence, not necessarily a runtime defect. |
| `stale_suppression` | `warn` | The configured exception no longer matches current evidence. |
| React Hooks exhaustive-deps | `warn` | Preserves the plugin's warning semantics. |

React Rules-of-Hooks violations are blockers and exhaustive-deps violations are warnings when `react-hooks` is required (the default for the React profile). Other profiles retain them as review evidence.

## Review evidence

The following categories are ranked but do not fail or warn by default:

- complexity and nesting hotspots
- file and function size
- duplication and same-purpose heuristics
- broad interfaces, large unions, and generic counts
- type assertions and non-null assertions found structurally
- barrels and deep imports
- dead-code and cleanup candidates
- churn, co-change, test locality, and ownership proxies
- React component size, hook counts, render branching, and regex accessibility heuristics
- framework boundary heuristics

Projects may display or explicitly promote these findings, but the managed recommended profile does not treat a threshold score as proof of a defect.

## Informational evidence

- `ts_expect_error`: allowed as an intentional negative type assertion; the compiler reports an unused directive and managed lint requires a description.
- Storybook evidence and other positive framework signals.
- Compiler posture differences under the compatibility-oriented `baseline` profile.

## Profiles

| Profile | Required evidence by default |
| --- | --- |
| `baseline` | Compiler when a tsconfig exists; configured tests when a test command exists. |
| `recommended` | Compiler, managed type-aware lint, and configured tests. |
| `strict` | Recommended evidence plus the strict compiler-option posture. |
| `react` | Recommended evidence plus React Hooks analysis. |

`policy.required_checks` can explicitly replace profile defaults. Supported checks are `compiler`, `typed-lint`, `tests`, and `react-hooks`.

## Ruleset versioning

The first managed lint ruleset is `tsrqlens-typescript-recommended-v1`. Adding or promoting blocker rules requires a new ruleset or schema release note. Risk model changes are versioned separately from rule dispositions.
