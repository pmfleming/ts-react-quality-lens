# Rule development and validation

The rule-contract and mutation corpus is a focused precision harness, not exhaustive coverage of the analyzer. [`rule-contracts.json`](../rule-contracts.json) registers eight rules: React Rules of Hooks, render-time state updates, exhaustive dependencies, immutability, synchronous Effect state updates, ref access, managed alt-text, and the missing-alt fallback. The 22 cases run both original and mutated sources (44 inputs). Other compiler, lint, import, cleanup, and heuristic behavior is covered by broader tests but not necessarily by a registered contract.

Modern React false-positive traps cover conditional/looped `use`, `useActionState`, Effect Events, guarded render updates, mutation of fresh local copies, derived values, ref props, and Fragment refs. These are static lint fixtures, not runtime or browser compatibility tests. The immutability contract confirms direct property mutation; opaque mutating method calls are outside this corpus's guarantee.

## Contributor workflow

For a new managed blocker or built-in heuristic:

1. Define its behavior, runtime rationale, authoritative references, evidence strength, precision, supported scope, and default disposition in `rule-contracts.json`.
2. Add true-positive examples, false-positive traps, and explicit out-of-scope cases before broadening detection.
3. Add at least one true-positive and one false-positive case to `test/rule-corpus/cases.json`.
4. Give each case a verdict-preserving mutation that changes identifiers and/or location.
5. Implement the rule within that boundary, preserving unavailable/abstained evidence rather than treating uncertainty as safety.
6. Update the relevant adapter/measurement tests, [rule catalog](rule-catalog.md), and schemas if output changes.
7. Run `npm run rule:check`, `npm test`, and `npm run ci` before merging.

A heuristic-only registered contract cannot have default disposition `block`. Avoid promoting heuristics merely because their scores exceed a threshold.

## What checks actually enforce

`npm run rule:check` builds and runs `scripts/rule-contract-check.ts`. It validates the contract schema, unique contract/case IDs, known contract references, both verdict categories per contract, newline-terminated source, and a mutation whose search text exists and differs from its replacement. It rejects heuristic-only blocker contracts. It does **not** discover every emitted rule or require that every analyzer rule has been registered.

`test/rule-contract.test.ts` executes original and mutated fixture sources through public measurement paths:

- `true-positive`: the contract's rule ID must occur in both versions;
- `false-positive`: it must occur in neither version.

The harness requires complete managed analysis before accepting negative cases and checks the contract disposition for positive cases. These are rule-presence and disposition verdicts, not a complete assertion of audit pass/fail behavior. Mutations are explicit search/replace cases, not a general AST fuzzer. `modern-tooling.test.ts` separately checks that optimization findings remain informational through audit policy.

## Public-project evaluation (recommended, not automated)

Before promoting a blocker, compare before/after output on pinned real projects:

- Record repository commits, compiler/tool/ruleset versions, and configuration identity.
- Manually adjudicate newly introduced findings; raw finding count is not a quality target.
- Minimize confirmed false positives into license-compatible local cases.
- Do not promote a rule while unexplained blocker regressions remain.

Default CI uses repository-owned fixtures and synthetic/performance smoke checks. There is no implemented public-project corpus lane or published empirical precision calibration. Do not copy third-party code or fixtures under incompatible licenses.
