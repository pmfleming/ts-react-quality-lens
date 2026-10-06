# Engine scope and reconciliation

No silence is an evaluated negative. QML's native reconciliation contract is the
cross-lens reference for this distinction; identical wire vocabulary does not
imply identical rule semantics across languages.

| Capability | Relationship | Required interpretation |
| --- | --- | --- |
| Internal cleanup / Knip | Bounded exact file/name claim matching | Complete, versioned Knip positive and same subject may corroborate the bounded unused-subject observation. Preserve both originals. Exclusions/incomplete scope prevent corroboration. No per-subject negative is present in Knip's issue-only output, so silence is not comparable, never disagreement. |
| Internal text / jscpd / AST clones | Text fallback plus parallel syntax candidates | Region deduplication is presentation only. Preserve raw engine groups in reconciliation. Overlap is not equivalent predicates or independent behavioral proof. |
| Internal / dependency-cruiser cycles | Alternative | Non-selected engine was not evaluated. Preserve selected source/exclusion scope; do not infer disagreement. |
| Internal / managed accessibility | Alternative | Regex fallback is not an independent accessibility standards check. Disabled/unavailable managed evidence remains explicit. |
| Imported SARIF and native/imported findings | Independent | Scanner/input/rule/occurrence identity remains separate. Matching locations and messages do not establish comparable semantics or input provenance. |

`test/reconciliation.test.ts` mutates symbol/file identity, missing identity,
producer version/completion, exclusions and silence. It also runs managed lint
against excluded source files. `test/sarif-identity.test.ts` protects independent
imported identities. Existing real CLI profiles check lossless reconciliation
projection. A constructed explicit disagreement remains representable, but native
adapters must not manufacture one from missing findings.

Remaining E6 work: exhaustive rule/subject exclusion mappings and independently
reviewed predicate equivalence. Nothing here certifies that a corroborated unused
symbol is safe to remove in every runtime/module-loading environment.
