# Rule development and validation

The rule-contract and mutation corpus is an initial precision harness, not exhaustive coverage of the analyzer. [`rule-contracts.json`](../rule-contracts.json) currently registers four rules: React Rules of Hooks, render-time state updates, managed alt-text, and the missing-alt fallback. Other compiler, lint, import, cleanup, and heuristic behavior is covered by broader tests but not necessarily by a registered contract.

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

These are rule-presence verdicts, not a complete assertion of audit pass/fail behavior. Mutations are explicit search/replace cases, not a general AST fuzzer. Add dedicated audit tests when changing disposition, attribution, or completeness behavior.

## Public-project evaluation (recommended, not automated)

Before promoting a blocker, compare before/after output on pinned real projects:

- Record repository commits, compiler/tool/ruleset versions, and configuration identity.
- Manually adjudicate newly introduced findings; raw finding count is not a quality target.
- Minimize confirmed false positives into license-compatible local cases.
- Do not promote a rule while unexplained blocker regressions remain.

Default CI uses repository-owned fixtures and synthetic/performance smoke checks. There is no implemented public-project corpus lane or published empirical precision calibration. Do not copy third-party code or fixtures under incompatible licenses.
