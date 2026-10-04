# Trust/Evidence execution record

Plan: [trust-evidence-plan.md](trust-evidence-plan.md). Stage completion is not criterion acceptance. No push or release performed.

## W1 — reproduced failure repairs

- Missing/unknown prerequisites now fail closed. Standalone typed-lint and React artifacts require successful requested semantic producers instead of generic dependency-directory presence.
- Required SARIF completion is checked independently of findings, suppressions, baselines and audit gate. Optional missing inputs remain explicitly optional.
- Added `test/trust-failures.test.ts`: real missing-tsconfig and suppressed-required-SARIF probes, malformed/failed-invocation cases, baseline and both gate modes, successful and optional controls, SARIF projection.
- Validation: `npm run ci` on Linux Node 24.16/npm 11.13: **69 tests passed**, all native checks and installed-package smoke passed. Log: `/tmp/ts-trust-w1-ci.log` (diagnostic only; committed regressions are the durable reproduction).
- E5 is reopened rather than re-certified: the observed counterexample is repaired, but exhaustive required-producer/profile cases remain pending. T3/E3 remain open pending the broader capability/payload matrix.

## W2 — blocking inventory and executable typed-rule corpus

- Centralized enabled typed rules and blocking React rules in `src/rule-policy.ts`; producers consume that authority. Unknown blocking classifications become explicitly limited review findings rather than silently acquiring blocking semantics.
- Added prerequisite/applicability/version requirements for blocking React contracts; added all eight typed blockers with executable positive/negative/unavailable cases and an eight-family compiler/test/package/imported inventory.
- Rule checker now requires exact managed-blocker/family inventory equality, metadata and existing regression paths. Native findings carry their blocking contract identity.
- Validation: `npm run ci`: **71 tests passed**, all checks and installed-package smoke passed (`/tmp/ts-trust-w2-ci.log`).
- E2 stays open: the bounded upstream family inventory is not yet an exhaustive per-family positive/negative/unavailable/applicability matrix. Existing paths are coverage references, not a claim each case exists. Fine-grained per-rule evaluated/skipped counts remain pending.

## W3 — native projection and boundary validation

- Native publication attaches distinct producer-run identity, invocation-scoped capability states and common run/finding/numeric-summary records. Readers check local references, duplicate identities, payload/projection agreement, capability consistency and critical status shapes. Project context returns the same projected artifact it publishes.
- Typed/compiler/runtime/coverage/package/test states distinguish unavailable or disabled work from completed execution. Missing SARIF invocation evidence and malformed/empty result documents no longer count as completed scanner verification; malformed ESLint report structures fail parsing rather than silently becoming empty findings.
- Imported runtime/SARIF/coverage/type-baseline/performance report contents now participate in the audit unchanged-input closure.
- `test/native-evidence.test.ts` exercises missing/changed run references, duplicate entries, altered findings/completeness, malformed native fields and imported-report mutation. SARIF identity fixtures now explicitly declare successful invocation rather than relying on absent evidence.
- Validation: `npm run ci`: **72 tests passed**, full checks/package smoke passed (`/tmp/ts-trust-w3-ci.log`).
- T3/E3 remain open: capability counts are invocation-scoped, not exhaustive per-rule coverage; legacy envelopes and some upstream payloads still lack strong validation/provenance. Common comparison records, pinned multi-read generations and complete producer-fault coverage are not certified. E1's structural pass is retained without expanding its acceptance scope.
