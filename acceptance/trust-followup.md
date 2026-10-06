# Trust follow-up: five implementation stages

Authority remains `criteria.json`; implementation is not automatic acceptance closure.
The previous 2093909 repeatability campaign is historical for changed semantics.

## Stage 1 — bounded rule applicability

- Added per-rule evaluated/skipped/abstained file counts for every managed typed/React blocker, including classic-profile exclusions. Successful parser/rule dispatch is required for an evaluated negative; parser failures and missing file results abstain.
- Added explicit selected/unavailable/not-applicable execution counts for all eight bounded upstream families. Compiler remains selected, not silently inapplicable. These are **family invocation** counts, not invented per-upstream-rule semantic counts.
- Managed React execution now uses the version actually recorded by the lens, rather than an arbitrary project plugin version.
- Added a mutation-tested closed blocking-inventory gate. Existing typed positive/negative/unavailable tests now assert actual dispatch counts; JavaScript-only scope is a not-applicable control.
- New cross-lens profile: `node dist/scripts/cross-lens-check.js ../qmlqualitylens`. Both native validators accept/reject both repositories' shared wire/capability fixtures (380 assertions), QML revision `fdd92bcc096c3acfc3ef5bab564776b34b84657e`.

Validation: `npm run ci` passed **80 tests**, schema/inventory/format checks, performance and installed-package smoke on Linux Node 24.16.0/npm 11.13.0. Cross-lens profile passed.

Scope limitation: file dispatch is not proof that every expression's semantics resolved. Exhaustive upstream diagnostic-family producer cases and per-expression abstention remain T3/E2 obligations. No criterion is promoted on the strength of dispatch counts alone.

## Stage 2 — payloads, legacy verification and generation references

- Critical native compiler/lint/React/test/package/SARIF/runtime/coverage/audit payloads are validated before publication and on read, independently of common-wire shape checks. Malformed package diagnostic arrays throw instead of becoming successful empty reports.
- Legacy envelopes remain readable diagnostic data but cannot satisfy required verification. Positive native compiler/lint controls and existing native imported/test regressions remain passing.
- Fixed compiler capability projection: a successfully loaded compiler is completed, not failed-execution because its native status uses `loaded` rather than `ran`.
- Saved audits bind consumed producer bytes, run IDs and semantic digests. Readers reject missing/mutated/mixed generation members; existing rollback and interrupted-publication tests still pass. This does not claim protection for arbitrary noncooperative filesystem consumers.
- Native baseline comparison now emits linked current/baseline wire runs and a comparison outcome. No baseline is explicitly unknown, not compatible. The v3 deterministic boundary resolves these references and retains semantic member digests while normalizing only declared raw run/telemetry differences.
- Validation: `npm run ci` passed **83 tests** and all native smoke checks; shared TS/QML profile passed **380 assertions**; four QML wire/capability/freshness/report tests passed at the pinned sibling revision.

E3 remains open for exhaustive producer/fault combinations and imported source/environment authenticity (especially legacy external SARIF). A self-consistent native payload is not a signature or proof of producer honesty. Existing retained MyStarQuest hashes must not be presented as validation of the changed v3 boundary.

## Stage 3 — reporter/policy alignment

- Audit now retains producer rule-applicability records. SARIF preserves applicability, comparison, source identity and generation references alongside exact native findings and summary.
- Full Markdown now includes a machine-readable native evidence section, rather than dropping package/imported details that were not represented in the human finding line.
- Added real CLI profiles executing managed React/typed lint, compiler, tests, declaration emit/npm pack/publint/ATTW, SARIF, linked axe and linked LCOV. JSON/SARIF/Markdown/summary agree on findings, applicability, policy and exits under both gates, baseline and config suppressions.
- The same CLI matrix mutates configured SARIF/runtime/coverage payloads to invalid objects and verifies that all four formats retain nonzero operational failures after ordinary input diagnostics are suppressed.
- Validation: `npm run ci` passed **84 tests** and all smoke checks. Five sibling QML reporter/policy tests passed, including actual CLI formats and changed-code baseline suppression. Shared v1 fixtures remain unchanged.

E4 remains open for exhaustive producer/profile combinations (e.g. all supported optional report formats and real Git-base compatibility cases). The executed matrix is concrete coverage, not a universal alignment claim.

## Stage 4 — explicit engine scope, no invented negatives

- Reproduced and removed the inference that a completed Knip run with no matching issue disagrees with an internal candidate. Knip has no explicit per-subject negative output: silence is now not-comparable, matching QML's native reconciliation contract.
- Matching requires exact file/symbol (or package/name) identity and completed/versioned evidence. Missing subject fields, excluded dependencies and incomplete scope cannot corroborate. Confirmed bounded matches retain both original observations and a safe-removal limitation.
- Clone region deduplication no longer erases raw engine observations; subset regions do not silently collapse larger subjects. Audit/SARIF/Markdown retain these observations without adding ordinary blockers.
- Accessibility, dependency cycles, clones and imported SARIF expose their alternative/parallel/independent scopes and non-comparability reasons. Managed lint filters observations and evaluated counts to the lens-selected source/exclusion scope.
- Added `contracts/engine-scope.md` with the supported overlap inventory and mutation tests.
- Validation: native CI **86 tests**, all smoke checks; six final reconciliation/SARIF/real-CLI tests passed after the imported-scope addition; shared TS/QML **380 assertions**; nine QML reconciliation/reporter tests passed.

E6 remains open for exhaustive per-rule exclusion mappings and independently reviewed predicate equivalence. No adapter claims that agreement alone proves behavior preservation.
