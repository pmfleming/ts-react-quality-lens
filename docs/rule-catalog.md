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
| `@typescript-eslint/only-throw-error`, `prefer-promise-reject-errors`, `no-for-in-array`, `no-misused-spread`, `no-wrapper-object-types`, `no-empty-object-type` | `warn` |
| Typed-lint parser failure | `info` record plus incomplete typed-lint status |
| Compiler posture (`type_safety_posture`) | `info` under baseline, `warn` otherwise |
| Type-coverage floors/ratchet regressions | `warn` |

Managed lint ruleset: `tsrqlens-typescript-recommended-v2`. `ban-ts-comment` rejects `@ts-ignore`/`@ts-nocheck` and requires at least three description characters for `@ts-expect-error`; `@ts-check` is allowed. Parser failure or unavailable type information is not clean typed-lint evidence. The additional correctness rules warn rather than block; unknown thrown/rejected values and caught rethrows are allowed because upstream code may throw arbitrary values. Rule applicability covers every enabled managed rule.

All profiles inspect `strict` posture. The `strict` profile additionally expects `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`. This does not rewrite tsconfig or switch to a different typed-lint ruleset.

A safe `unknown` annotation is not an escape hatch. Type coverage separates explicit/inferred `any`, error/unresolved types, and `unknown`; coverage is not a substitute for unsafe-operation diagnostics.

## React and accessibility

`react.ruleset: "recommended-v2"` uses the installed official plugin's recommended rules with compatibility fallbacks. `classic-v1` enables only Rules of Hooks and exhaustive dependencies.

| React rule family | Produced disposition |
| --- | --- |
| `rules-of-hooks`, `set-state-in-render` | `block` |
| `exhaustive-deps`, `immutability`, `globals`, `refs`, `purity`, `static-components`, `error-boundaries`, `component-hook-factories` | `warn` (correctness) |
| `unsupported-syntax`, `incompatible-library`, `preserve-manual-memoization`, `use-memo`, `void-use-memo`, `set-state-in-effect` | `info` (optimization) |
| `config`, `gating` | `review` (configuration) |
| Other emitted official rules | `review` (unknown; requires classification) |
| Parser failures | `info` (tool-failure; incomplete evidence) |
| Managed jsx-a11y findings | `warn` |
| Built-in missing-alt/nonsemantic-interaction fallback | `review` |

React-health artifacts also expose `rule_coverage` and the actual selected preset and enabled rule IDs. An evaluated inventory entry describes the selected-file lint run, not exhaustive semantic verification. Hooks findings link to their rule documentation.

React findings carry `react_category`; the summary counts correctness, optimization, configuration, and unknown findings separately. Optimization findings describe unsupported compilation or potential wasted work, not demonstrated runtime failures. They remain informational even when React checks are required. Unknown future rules require review instead of automatically becoming blockers. When the check is optional, non-informational React findings become review items. jsx-a11y findings are separate and remain warnings. The React profile does not require successful jsx-a11y production; fallback evidence must not be mistaken for full standards-based accessibility analysis.

## Package and imported evidence

- Failed declaration emit or package packing: `block` records; unavailable tools also expose incomplete package status.
- publint: errors `block`, warnings `warn`, suggestions `info`.
- ATTW: resolution problems generally `block`, advisory findings `warn`.
- SARIF: error `block`, warning `warn`, note `info`, none `review`. Required input/invocation failure `block`; optional failure `warn`.
- React Profiler: duration over 50 ms or render count over 10 produces `warn`; otherwise `review`. Development-build observations remain `review` regardless of the threshold. These thresholds are lens policy, not official React performance budgets.
- Normalized React Performance Tracks: `review` observations only; no automatic regression verdict or duration aggregation.
- axe: critical impact `block`, serious `warn`, other impacts `review`.
- React Doctor: error severity `warn`, otherwise `review`.
- Runtime input failure: `warn` and incomplete runtime status; audit adds an incomplete reason.

## Modern web candidates

`quality.modern_web` is opt-in. Chrome's scanner findings always remain `review`, regardless of profile or browser support. The scanner's successful invocation does not prove full file/rule coverage. Missing or failed scanner execution is recorded in the artifact and does not add a required-check failure. There is no `modern-web` required-check option or automatic promotion to a warning/blocker.

Replacement advice is qualified by pinned browser support data and explicit/discovered targets. Unknown rules or targets retain the candidate and withhold replacement advice. Contextual `keepWhen`/`dropWhen` verification is still required for supported replacements. See [integration scope and limitations](integrations.md#modern-web-guidance).

## Built-in signals

Warnings include structural `ts_ignore`/`ts_nocheck`, `layer_violation`, `import_cycle`, and `stale_suppression`. `ts_expect_error` and Storybook evidence are informational.

Complexity, duplication/same-purpose candidates, size, broad types, structural assertions, dead-code candidates, barrels, deep imports, churn/co-change, test locality, React size/render heuristics, and framework boundaries are generally review evidence. High scores alone do not promote them to blockers.

## Contracts and validation

[`rule-contracts.json`](../rule-contracts.json) covers eight selected React/accessibility rules. [`contracts/typed-rule-cases.json`](../contracts/typed-rule-cases.json) adds executed positive/negative/unavailable cases for all eight managed typed-lint blockers; [`contracts/blocking-families.json`](../contracts/blocking-families.json) inventories the bounded compiler, test, package and imported families. `src/rule-policy.ts` is the managed-rule authority; unregistered blockers are downgraded to explicit review. Exhaustive upstream-family applicability/case coverage is still tracked by E2. `npm run rule:check` validates registered contracts and their corpus entries; `npm test` runs original/mutated source fixtures. See [rule development](rule-development.md) for the contributor workflow and remaining coverage limits.

Changing rules/dispositions should be reviewed separately from changing risk-model weights. Artifacts carry both analysis/ruleset identity and map risk-model metadata so consumers can reject incompatible comparisons.

## React guidance review candidates

`derived-state-effect`, `eager-state-initializer`, and `next-root-client-boundary` are advisory AST candidates with source links and keep/drop criteria. Aliased and namespace React imports are recognized; shadowed bindings are not treated as React Hooks. Next root-boundary advice requires a detected Next workspace and a compatible declared version. Compiler package declarations are recorded separately from unverified activation. See the [seven-source comparison](react-guidance-review.md) for coverage and explicit limits.

`async-effect-race` reviews Promise-style callbacks and directly invoked local async functions that write a `useState` binding. A local boolean flag initialized inside the Effect, invalidated unconditionally in its returned cleanup, and checked around every asynchronous setter is recognized; unrelated cleanup, shared flags, and rearmed flags are not accepted as protection. Abort signals, generation IDs, early-return guards, helper aliases and arbitrary async control flow are not proven. Use reordered-response tests to confirm a race before changing behavior.

`effect-state-chain` reports connected groups of direct Effects whose synchronous local state writes feed other dependency arrays, including multi-Effect cycles. Nested subscription callbacks are excluded from these static edges. Dependent network synchronization can be legitimate. Neither rule infers an actual race, render count, performance regression, or automatic fix. Both remain low-confidence, unresolved review candidates with keep/drop criteria. See [React's Effect guidance](https://react.dev/learn/you-might-not-need-an-effect).

## Imported execution and baseline evidence

Normalized React Compiler reports preserve per-function outcomes and declared-scope coverage. Successful compilation and timing events are informational; skips, compiler diagnostics, and pipeline failures require review. Percentages require complete source-linked inventories; successful compilation never proves a runtime improvement.

Performance baseline records report comparable per-route initial/deferred bundle-byte deltas and repeated-scenario median/p95 duration deltas. All remain review-only; a positive delta is an observed increase, not a statistically established regression. Unpaired scope and incompatible conditions are explicit. Configured invalid reports use the existing incomplete-runtime policy. See [integration formats](integrations.md).
