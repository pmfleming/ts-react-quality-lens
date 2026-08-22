# Rule Development and Validation

Every managed blocker and every built-in heuristic must have an explicit contract in [`rule-contracts.json`](../rule-contracts.json). The contract records behavior, runtime rationale, authoritative sources, evidence strength, precision, supported scope, default disposition, positive examples, false-positive traps, and intentionally unsupported cases.

## Required workflow

1. Research the runtime or standards behavior and add authoritative links.
2. Define the rule boundary before implementing detection.
3. Add at least one confirmed true-positive case.
4. Add at least one confirmed false-positive trap.
5. Add a verdict-preserving mutation that changes identifiers and source location.
6. Implement or enable the rule without broadening its documented scope.
7. Run `npm run rule:check` and `npm test`.
8. Before promoting a finding to `block`, compare before/after output on pinned real projects and record regressions as false-positive corpus cases.

A heuristic-only rule cannot use the default `block` disposition. Unavailable semantic or tool evidence must not be interpreted as a clean result.

## Corpus format

Local regression cases live in `test/rule-corpus/cases.json`. Each case names its contract, expected verdict, complete source file, and a verdict-preserving mutation. Tests execute original and mutated files through the public measurement path.

- `true-positive` means the contract rule must be present for both files.
- `false-positive` means the contract rule must be absent for both files.

Confirmed production false positives should be minimized into this corpus without copying third-party fixture code whose license is incompatible.

## Public-project evaluation

Default CI uses deterministic repository-owned fixtures. Rules proposed for blocking status additionally require an opt-in public-project evaluation outside normal CI:

- pin repository and commit identities;
- record tool, compiler, ruleset, and config identities;
- compare the candidate branch against the current default branch;
- manually adjudicate newly introduced findings;
- preserve only minimized, license-compatible regressions locally;
- do not promote the rule while unexplained blocker regressions remain.

Raw finding count is not a quality target. Precision, explicit abstention, and stable verdicts are.
