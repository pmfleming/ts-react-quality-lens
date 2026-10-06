# Cross-lens upgrade execution

## Latest: staged Trust/Evidence alignment

Five follow-up implementation stages are recorded in `acceptance/trust-followup.md`. Clean engine-strict Linux Node 20.19.0 and 24.21.0 profiles pass **88 native tests**, installed-consumer/test/native-clone smoke and a **zero-advisory** audit. QML lens validation: **286 native tests**, **380 shared conformance assertions**, and **12 repeatability observations** under the current v3 semantic boundary. Its tracked source stayed unchanged.

**Acceptance remains 5/25 passed, 20 unresolved.** File dispatch is not universal semantic resolution; exhaustive upstream contracts/payload authenticity/profile/exclusion coverage remains open. Windows has not executed; Nix prerequisite builds exceeded validation time limits. No platform, security or Node-floor waiver was made. Details and exact snapshot identities: `acceptance/followup-validation.json` and `acceptance/qml-project-results.json`. Commits were authorized; no push or release occurred.

## Previous Trust/Evidence follow-up (2093909)

Implemented staged Trust/Evidence repairs and contracts; clean Linux Node 20.19.0 and 24.21.0 native CI passes **77 tests**, including installed-package/test-runner smoke. A pinned MyStarQuest campaign passes **24 repeatability observations** across app/functions and focused/full-audit profiles. Required verification cannot be suppressed through ordinary findings, including required imported reports.

Acceptance is **not complete**: **5/25 passed, 20 unresolved**; Trust **2/4**, Evidence Contract **2/6**. See `acceptance/trust-evidence-execution.md` and `acceptance/criteria.json`. Remaining work includes exhaustive applicability/payload/reporter/engine-scope contracts. T4 is blocked by unexecuted Windows profiles, a transitive Node-engine mismatch, five fresh high dependency advisories through jscpd, and an upstream Nix source hash mismatch. No push or release is authorized.

## Historical: acceptance closure steps 1–5

Clean Linux Node 24.18 validation passed: 66 tests, full CI, an actually installed package/test runner, three resource-profile repetitions and zero dependency advisories. Publication rollback/recovery guards and clean runtime-only packaging are implemented.

Acceptance is **not complete**: 4/25 required criteria are evidenced, 21 remain unresolved. No push is permitted yet. See the repository ledger `acceptance/criteria.json`, `acceptance/step-5.md`, and packaged recovery/limitations in `contracts/operational-scope.md`. Independent calibration/intent review and broader semantic, operational and platform obligations remain open.

## Historical implementation record

The review's phases 0–4 are executed as phases 1–5. Each phase has its own commit. These are implementation iterations; full plan acceptance remains open (see `contracts/upgrade-validation.md`).

## Phase 1 — Trust repairs
- Restored the declared dependency installation; full `npm run ci` passed (54 tests, schema/rule checks, performance and package smoke).
- Const assertions and DOM reads no longer count as unchecked assertions/mutations. Regression tests retain actual unsafe assertions and writes.
- Audit checks source/config/compiler-input discovery against its initial snapshot; a changed run cannot save a baseline.
- Next: stage audit output and validate evidence contracts. Current per-file publication is not a multi-artifact transaction.

Installation audit reported three high-severity dependency advisories; no unrelated dependency upgrades were applied automatically.

## Phase 2 — Evidence boundaries
- Added the shared capability-v1 conformance corpus and native validated types. Project-input completeness no longer contradicts unsupported-pattern evidence.
- Audit producers run in an isolated staging directory with an exclusive publication lock. Producer failures preserve prior evidence; changed snapshots publish only an incomplete audit, not the staged measurements.
- Full suite: 55 passed; subsequent staging/conformance tests: 2 passed (56 total tests now).
- Capability granularity is currently project-input level; per-rule coverage for all TS rule families remains outstanding. Native finding/run envelopes remain language-specific, as documented in `contracts/README.md`.

## Phase 3 — Measurement parity
- Added source-linked LCOV/Istanbul/original-JavaScript V8 coverage, changed-line observations and advisory function complexity/coverage risk; configured missing/stale coverage reaches audit incompleteness.
- Runtime reports require source/producer/environment provenance for current-source certainty. Legacy observations remain visible as low-confidence review findings.
- Full CI: 57 tests passed, schema/contract checks and package/performance smoke passed.
- See `contracts/execution-evidence.md`. No source-map engine or branch-coverage claim is included; V8 attribution is limited to original JavaScript.

## Phase 4 — Calibration and anti-gaming
- Added language-idiom positive/negative cases, identifier/location mutations, explicit development/holdout partitions, and shared precision/recall/abstention conformance cases.
- Unused exports no longer improve leverage. Reuse, surface, implementation size and outbound dependencies are reported separately with advisory model identity.
- Full CI: 59 tests passed; package/performance smoke passed.
- These are regression corpora, not independent real-world validation. Ranking remains uncalibrated; see `contracts/calibration-design.md` for release criteria and remaining independent-corpus work.

## Phase 5 — Simplification and delivery validation
- Capability states are discriminated unions. Producers return the same enriched evidence they write; removed duplicate runner enrichment. Atomic writes validate filenames and clean up failed temporary writes.
- Required compiler/test failures cannot be hidden by finding suppressions or baselines; verification-policy identity is versioned.
- Ship contract fixtures and status notes; benchmark cold/warm contexts and cumulative memory with execution scope documented.
- Full CI: 60 passed; schema/rule/format, performance and package smoke passed. At 100 synthetic files: 4681 ms cold-context / 295 ms warm-context (single observations).
- Broad per-rule typed finding migration, independent calibration and other shared acceptance gaps remain listed in `contracts/upgrade-validation.md`.
