# Rule and gate catalog

Current artifact schema: **0.3.0**. Sources: [`src/actions.ts`](../src/actions.ts), [`src/audit/findings.ts`](../src/audit/findings.ts), and the task-specific record producers in [`src/measures/`](../src/measures/).

This is a disposition reference, not an exhaustive list of every emitted heuristic or upstream rule. Numeric scores rank records; they do not determine audit verdicts.

## Dispositions and completeness

| Disposition | Active audit effect |
| --- | --- |
| `block` | `fail`, even when other required evidence is incomplete. |
| `warn` | `warn` only if no blocker or incomplete reason exists. |
| `review` | Review evidence; no verdict effect. |
| `info` | Context; no verdict effect. |

Suppressed findings never gate. `new-only` additionally excludes inherited findings. Missing required evidence yields `incomplete` when there is no blocker. `fail` and `incomplete` set CLI exit code 1; `warn` exits 0. See [audit scope and attribution](audit.md).

## Profiles

| Profile | Required evidence by default |
| --- | --- |
| `baseline` (loader default) | Compiler if a tsconfig is selected; tests if a command is configured/inferred. |
| `recommended` (`init` default) | Compiler and typed lint; tests if a command is configured/inferred. |
| `strict` | Same checks as recommended, with additional compiler-option posture warnings. |
| `react` | Recommended checks plus React Hooks analysis. |
| `library` | Recommended checks plus package validation; enables package health by default. |

`policy.required_checks` **replaces** defaults, including when `[]`. Allowed values: `compiler`, `typed-lint`, `tests`, `react-hooks`, `package`. There is no `accessibility`, `coverage`, `mutation`, `sarif`, or `runtime` required-check value. Configured runtime inputs are checked separately; SARIF inputs have their own `required` flag.

Required checks control completeness and certain audit downgrades, not task scheduling:

- typescript-eslint findings become `review` when `typed-lint` is not required;
- React Hooks/Compiler findings become `review` when `react-hooks` is not required;
- package-tool findings become `review` when `package` is not required.

These downgrades apply in the audit, not to the standalone artifacts or LSP diagnostics. Compiler errors and executed failing tests remain blockers even if their check is not required. Managed accessibility and imported runtime/SARIF findings retain their own dispositions across profiles. No general per-rule promotion/override setting is implemented.

## Compiler and managed TypeScript rules

| Rule/finding | Produced disposition |
| --- | --- |
| `typescript/TS…` compiler errors / non-errors | `block` / `warn` |
| `test-runner/execution` failure | `block` |
| `@typescript-eslint/no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return` | `block` |
| `@typescript-eslint/no-floating-promises`, `no-misused-promises` | `block` |
| `@typescript-eslint/ban-ts-comment` | `block` |
| `@typescript-eslint/no-unnecessary-type-assertion`, `no-unsafe-type-assertion` | `warn` |
| Typed-lint parser failure | `info` record plus incomplete typed-lint status |
| Compiler posture (`type_safety_posture`) | `info` under baseline, `warn` otherwise |
| Type-coverage floors/ratchet regressions | `warn` |

Managed lint ruleset: `tsrqlens-typescript-recommended-v1`. `ban-ts-comment` rejects `@ts-ignore`/`@ts-nocheck` and requires at least three description characters for `@ts-expect-error`; `@ts-check` is allowed. Parser failure or unavailable type information is not clean typed-lint evidence.

All profiles inspect `strict` posture. The `strict` profile additionally expects `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`. This does not rewrite tsconfig or switch to a different typed-lint ruleset.

A safe `unknown` annotation is not an escape hatch. Type coverage separates explicit/inferred `any`, error/unresolved types, and `unknown`; coverage is not a substitute for unsafe-operation diagnostics.

## React and accessibility

`react.ruleset: "recommended-v2"` uses the installed official plugin's recommended rules with compatibility fallbacks. `classic-v1` enables only Rules of Hooks and exhaustive dependencies.

| React rule family | Produced disposition |
| --- | --- |
| `rules-of-hooks`, `set-state-in-render` | `block` |
| `exhaustive-deps`, `immutability`, `globals`, `refs`, `purity`, `static-components`, `error-boundaries` | `warn` |
| `unsupported-syntax` | `info` |
| Other emitted official rules (including effect/memoization rules) | `review` |
| Managed jsx-a11y findings | `warn` |
| Built-in missing-alt/nonsemantic-interaction fallback | `review` |

React policy downgrades affect all records sourced from `eslint-plugin-react-hooks` when that check is not required. jsx-a11y findings are separate and remain warnings. The React profile does not require successful jsx-a11y production; fallback evidence must not be mistaken for full standards-based accessibility analysis.

## Package and imported evidence

- Failed declaration emit or package packing: `block` records; unavailable tools also expose incomplete package status.
- publint: errors `block`, warnings `warn`, suggestions `info`.
- ATTW: resolution problems generally `block`, advisory findings `warn`.
- SARIF: error `block`, warning `warn`, note `info`, none `review`. Required input/invocation failure `block`; optional failure `warn`.
- React Profiler: duration over 50 ms or render count over 10 produces `warn`; otherwise `review`.
- axe: critical impact `block`, serious `warn`, other impacts `review`.
- React Doctor: error severity `warn`, otherwise `review`.
- Runtime input failure: `warn` and incomplete runtime status; audit adds an incomplete reason.

## Built-in signals

Warnings include structural `ts_ignore`/`ts_nocheck`, `layer_violation`, `import_cycle`, and `stale_suppression`. `ts_expect_error` and Storybook evidence are informational.

Complexity, duplication/same-purpose candidates, size, broad types, structural assertions, dead-code candidates, barrels, deep imports, churn/co-change, test locality, React size/render heuristics, and framework boundaries are generally review evidence. High scores alone do not promote them to blockers.

## Contracts and validation

[`rule-contracts.json`](../rule-contracts.json) currently covers four selected rules: Rules of Hooks, set-state-in-render, jsx-a11y alt-text, and the built-in missing-alt fallback. It does **not** yet cover every emitted rule. `npm run rule:check` validates registered contracts and their corpus entries; `npm test` runs original/mutated source fixtures. See [rule development](rule-development.md) for the contributor workflow and remaining coverage limits.

Changing rules/dispositions should be reviewed separately from changing risk-model weights. Artifacts carry both analysis/ruleset identity and map risk-model metadata so consumers can reject incompatible comparisons.
