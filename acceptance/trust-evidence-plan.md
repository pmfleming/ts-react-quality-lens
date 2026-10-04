# Trust and Evidence Contract: review and completion plan

Historical review/plan. Current staged implementation results and remaining obligations are in [trust-evidence-execution.md](trust-evidence-execution.md); this original assessment is not the current ledger status.

## Scope and decision

Reviewed lens revision `e0e4e76399c6c880261f600be3ea1e9540eb1e17`, recent implementation/closure commits, native producers/reporters/tests, and the acceptance ledger. This document is a review and proposed implementation plan, not an acceptance certificate. No implementation or ledger statuses were changed during this review.

Acceptance authority:

- [`criteria.json`](criteria.json): Trust **T1–T4**, Evidence Contract **E1–E6**.
- [`README.md`](README.md) and [`check.py`](check.py): fail-closed evidence and release rules.
- Original review: `../quality-lenses-review-and-upgrade-plan.md` relative to the repository root (a sibling file in the local Projects directory), phases 0 and 1.
- [`../contracts/evidence-wire.md`](../contracts/evidence-wire.md): existing vocabulary and explicitly outstanding producer/reference obligations.

**Ledger totals:** Trust 1/4 passed, 2 open, 1 blocked; Evidence Contract 2/6 passed, 4 open. Overall 4/25 passed. **Review qualification:** E5 has a reproduced counterexample outside its recorded compiler/test scope and should be reopened as failed. Thus only E1 is presently supported as passed across its stated, structural Evidence Contract scope. Neither category is complete.

Closing these ten criteria will not authorize release: P/C/O obligations remain independent. Do not rewrite criteria, weaken checks, suppress failures, or claim all-project correctness to get a green gate.

## Recent git history: what actually changed

| Revision | Change relevant to this review |
| --- | --- |
| `5ae178f` | Corrected const-assertion/DOM-read false positives; introduced audit input rechecking and regression tests. |
| `591a426` | Added capability vocabulary and staged audit publication. |
| `19c25d5` | Added source-linked execution/runtime evidence and separated measurement dimensions. |
| `e3796ac`, `c4241f2` | Added idiom/anti-gaming regressions; consolidated publication/enrichment. Not independent calibration or final acceptance. |
| `0c8d4a6` | Established the 25-criterion fail-closed ledger rather than equating implementation phases with acceptance. |
| `f60d41c` | Added optional run/finding/measurement/comparison validation and audit SARIF projection. |
| `3dbf2ca` | Updated dependencies to remediate then-known advisories. |
| `7eeb974` | Froze behavior candidates without claiming independent review. |
| `c49812d` | Added publication rollback/recovery guards and actual installed-consumer/test-runner validation. |
| `e0e4e76` | Repaired the Nix npm dependency hash after the lockfile change. |

Use the ledger and current source over historical totals in `contracts/upgrade-validation.md`. Likewise, `docs/rule-catalog.md` still says four contracts; the current inventory contains **eight contracts and 22 corpus cases**, only two contracts having a default blocking disposition.

## Validation performed for this review

- `npm run ci`: **passed**, 66 tests, typecheck/build/schema/rule/format checks, performance smoke, installed-consumer and project-test-runner smoke. Linux, Node **24.16.0**, npm **11.13.0**, using the existing dependency installation. This was not a fresh `npm ci`, Windows run, or minimum-Node campaign.
- `python3 -m unittest discover -s acceptance -p 'test_*.py'`: **3 passed**.
- `python3 acceptance/check.py`: structurally valid ledger; **21/25 unresolved**.
- `python3 acceptance/check.py --release`: **exit 1**, as expected.
- Two isolated temporary-project probes below reproduced trust failures. Temporary projects were removed; neither probe modified consumer source.
- No new vulnerability audit, Nix build, independent calibration, or full MyStarQuest semantic campaign was performed. Earlier zero-advisory results are historical, not freshly re-certified here.

Local diagnostic logs (not durable acceptance evidence): `/tmp/ts-trust-review-ci.log`, `/tmp/ts-trust-review-release.log`, `/tmp/ts-trust-review-missing-tsconfig.json`, `/tmp/ts-trust-review-required-sarif.json`. Convert the probes into committed regression tests before citing them for closure.

## Criterion-by-criterion assessment

| ID | Ledger | Current evidence and remaining gap |
| --- | --- | --- |
| T1 | Passed | Existing positive/negative idiom, changed-input, coverage and publication regressions passed again. Preserve them; this is scoped to the reproduced original defects. |
| T2 | Open | Identity/cache/movement tests exist, but there is no complete repeat-run semantic-artifact comparison campaign. Artifacts contain changing tool durations and cache hit/miss metadata as well as timestamps. Define the deterministic evidence boundary without silently deleting meaningful differences. |
| T3 | Open | Unsupported-pattern and missing-project signals exist, but producer prerequisites do not consistently control completeness. Probe A proves a lint artifact can claim complete without executing lint. |
| T4 | Blocked | Current Linux CI and package smoke passed. Workflow declares Ubuntu/Windows on Node 24; package advertises Node >=20.19. Minimum-version and Windows evidence is missing. |
| E1 | Passed, structural scope | Shared fixtures and native discriminated validation exist. `evidence_contract` is optional; no native producer currently constructs it. Validation does not establish unique run IDs, resolvable references, native/common consistency, or producer-wide emission. Preserve the narrow pass, finish these integration obligations below. |
| E2 | Open | Eight selected contracts, not the set of all possible blocking rules. Checker only checks registered entries. Schema lacks explicit prerequisites, version applicability and unavailable cases. Compiler, eight blocking managed TS rules, test execution, package-tool and imported blocking families need inventory/coverage. |
| E3 | Open | Strong targeted freshness/runtime/input-change regressions exist, but no exhaustive producer/failure-state matrix. `writer.ts` still validates mostly the native envelope and optional extension; absent/malformed semantic payloads and imported evidence need capability-specific validation. Probe A is an observed failure. |
| E4 | Open | Audit JSON and SARIF share an audit result; existing reporter test uses a constructed artifact, not all real producers through CLI. SARIF drops related locations/reconciliation detail; text lists only active block/warn findings, with truncation and no consistent rule/occurrence IDs. Policy downgrades differ between standalone and audit findings. |
| E5 | Passed, compiler/test scope only | Compiler/test verification survives suppression, as tested. **Probe B violates the broader criterion:** missing required SARIF evidence can be suppressed into a complete passing audit. Recommend `failed` with this counterexample until repaired and expanded across required producers. |
| E6 | Open | Cleanup already preserves confirmed/disagreed/not-comparable/excluded/unavailable results. But audit collection reads only `records`/`groups`, losing separate `disagreements`/`unconfirmed` arrays, and exporter projections omit reconciliation metadata. Other overlapping engines lack an explicit coverage inventory. |

### Probe A — incomplete typed semantics reported as complete

Setup: temporary project containing `src/main.ts` with `export const answer = 42;`, a minimal `package.json`, and an empty `node_modules` directory; no tsconfig. Config has `source_roots: ["src"]`, `cache.enabled: false`, and `test_command: null`.

Execute the current built API:

```js
const config = loadConfig(configPath);
const artifact = measureLint(config, "trust-review");
```

Observed:

```text
summary.records = 0
tool_status.typed_eslint.ran = false
tool_status.typed_eslint.complete = false
reason = "typed lint requires a readable tsconfig"
confidence.complete = true
confidence.partial = false
capabilities[0] = project-inputs / completed / evaluated:1 / skipped:0
```

Cause: `src/config.ts:createConfidence` defaults to generic source/package/dependency-directory prerequisites. `src/measures/type-quality.ts:measureLint` records lint failure booleans but does not make them prerequisites. `src/provenance.ts:artifactBase` derives only a generic project-input capability from that confidence. This does **not** establish that the required typed-lint audit check passes; it establishes contradictory standalone evidence.

### Probe B — required imported verification can be suppressed

Use the same minimal project and this additional configuration:

```json
{
  "policy": { "required_checks": [] },
  "sarif_inputs": [
    { "path": "missing.sarif", "name": "required-scanner", "required": true }
  ],
  "suppressions": [
    { "kind": "sarif_invocation_incomplete", "reason": "Review regression probe" }
  ]
}
```

Call `runAudit(loadConfig(configPath), "trust-review", { runTests: false, gate: "all" })`.

Observed: `verdict: "pass"`, `complete: true`, empty verification failures and incomplete reasons. The missing required input produces a blocking finding, but that finding is suppressed. `required_checks: []` intentionally isolates the imported requirement; it does not turn off `sarif_inputs[].required`.

Cause: `src/measures/sarif.ts` represents operational input failure as an ordinary suppressible record. `src/audit/findings.ts` separately enforces compiler/tests and checks package/runtime/coverage states, but does not independently enforce required SARIF completion. Treat required-verification status as non-waivable evidence, not a diagnostic whose absence proves success.

## MyStarQuest real-project baseline

Existing clean checkout was fast-forwarded from `4517d71` to the latest fetched default-branch revision:

```text
/home/laufan/Projects/MyStarQuest
https://github.com/pmfleming/MyStarQuest
9ceeb3f4502777823dd5fb58a851614d0875763d
Refactor shared activity data and simplify validation
```

It remained clean after the pull. Pin that SHA for repeatability; future refreshes require a new recorded campaign identity.

Tracked-source census, not analyzer coverage: **271 app TS/TSX files / 33,092 physical lines**, **62 test TS/TSX files**, **8 functions/src TS files**. The root lens config selects `src`, `tests`, `tsconfig.app.json`, the React policy, and `npm run test`; it explicitly excludes `functions`, Android and other directories. These counts must not be substituted for discovered/evaluated rule counts.

**Prerequisite:** latest MyStarQuest declares Node `^24.21.0` and npm `>=12.1.0` (`packageManager: npm@12.1.0`). The review shell is older, and the existing `node_modules` was not refreshed. Do not use it to certify the latest revision. Provision a compatible pinned runtime and install root/functions lockfiles separately. Inspect lifecycle scripts and record what was permitted/executed. Its Nix dev shell is one provisioning option, not something validated in this review.

Run campaigns in disposable, pinned checkouts/worktrees. MyStarQuest tracks existing `target/analysis` and `target/functions-analysis` reports: use **external campaign output/cache directories** and do not overwrite or trust those historical reports. Do not run deployment, migration, Android synchronization, or production-connected commands. Root tests, browser tests and Firebase-emulator tests are distinct profiles; passing `npm run test` does not establish the others ran.

## Ordered implementation plan

Each work package should be a reviewable commit or small series with native tests and acceptance evidence. W1 first; W2 informs W3; W4/W5 consume W3; W6 checks the integrated result; W7 completes native/platform validation. Start runtime/Windows provisioning early, in parallel with implementation.

### W1 — Repair reproduced false-complete and suppressible-verification defects

**Criteria:** T3, E3, E5; preserve T1.

- Commit regressions for probes A/B in the existing typed-lint and artifact-pipeline suites, including unsuppressed positive controls.
- Replace generic completeness inference with explicit capability prerequisites. Unknown/missing prerequisites must not satisfy a required check; a directory named `node_modules` is not proof of usable dependencies.
- Separate required producer execution/completeness from findings. Extend required verification handling to configured required SARIF inputs, then audit package/imported producer failure paths as well as compiler/tests.
- Cover missing input, failed invocation, malformed report, timeout, baseline suppression, config suppression, `new-only` scope and an empty finding set. Required unavailable evidence must yield incomplete/failure and nonzero CLI exit; a demonstrated required verification failure remains failure.
- Keep useful advisory/internal results when optional tools fail, explicitly scoped; do not make every optional disabled producer a whole-audit failure.
- Reopen E5 in the ledger with the counterexample before claiming closure; retain its previous evidence as historical scoped coverage.

**Exit:** neither probe can report verified-complete/pass; all operational failures remain observable even if every ordinary finding is suppressed, with matching JSON/SARIF/text outcomes.

### W2 — Enumerate the complete blocking-rule and applicability inventory

**Criteria:** E2, T3; supports E3/E6.

- Derive the reachable rule inventory from producers, enabled managed-tool rules and effective policy profiles, not from emitted findings or the existing eight contracts alone.
- Include compiler diagnostics and imported/upstream namespaces using explicit bounded family contracts where appropriate, preserving exact upstream rule identity/version. Inventory all supported blocking imported rules; unknown/unvalidated rule semantics must not automatically gain verified blocking status.
- Add prerequisites, language/framework/tool versions, applicability predicates, scope, rationale, limitations, evidence kind and default/effective disposition to `rule-contracts.schema.json` and its data.
- Link executable positive, convincing negative, unavailable/unsupported and not-applicable fixtures to every blocking rule or justified diagnostic family. Assert that negative cases actually evaluated the rule.
- Update `scripts/rule-contract-check.ts` so an enabled blocking rule without a contract/cases fails CI. Test the inventory gate with a deliberately unregistered blocker.
- Publish per-rule evaluated/skipped/abstained counts and reasons; zero findings alone never means evaluated clean.

**Exit:** no orphan blocking rules, no missing prerequisite/case entries, and all declared cases execute. Update stale rule-catalog counts without treating that documentation edit as evidence.

### W3 — Connect native producers to validated run/capability evidence

**Criteria:** complete E1 integration, T3, E3; supports E4/E6.

- Give each run an explicit identity distinct from a reusable analysis fingerprint. Capture selected/effective config, source/compiler inputs, configured imported report hashes, ruleset/profile and actual producer versions.
- Emit truthful capability states for every selected producer and applicability scope, not only `project-inputs`: completed, partial, unavailable, disabled, not-applicable and failed-execution.
- Project native findings/measurements/comparisons into the existing wire vocabulary at a cohesive producer boundary. Do not invent independent classification in each reporter.
- Validate native critical payloads as well as optional wire shapes on write/read. Validate unique identities, resolvable run/finding references, owning scope/input fingerprints and agreement between native/common projections. Never upgrade legacy/unknown provenance to verified current evidence just because structural JSON is valid.
- Add a producer-by-fault matrix: missing executable/config, invalid JSON, structurally valid but invalid payload, stale source/config/report, source/report mutation during execution, unsupported syntax, tool exclusion, disabled check, partial result, timeout and interrupted publication. Pin the read generation across audit consumption where needed; do not claim universal power-loss transactions.
- Distinguish successful execution with defects from failed execution and undecidable semantics. Preserve values/limitations without substituting zero for unknown measurements.

**Exit:** each matrix case has asserted execution, completeness, policy and export outcomes; malformed, stale or unresolved evidence cannot produce verified clean results. Shared structural conformance fixtures continue to pass. Coordinate any vocabulary change with sibling lenses rather than silently diverging their fixtures.

### W4 — Preserve agreement, disagreement and excluded scope end to end

**Criteria:** E6.

- Inventory actual overlapping capabilities: internal cleanup/Knip, internal/managed accessibility fallback, internal/external clone and dependency analysis, and imported overlap where semantics are genuinely comparable.
- Define explicit same-subject/same-scope matching. Preserve both producer identities, applicability/exclusions, corroboration, disagreement, not-comparable and unavailable states. Engine silence outside its coverage is not disagreement; duplicate results are not independent proof.
- Carry cleanup `disagreements`/`unconfirmed` through the normalized audit evidence and exporters, without accidentally turning them into blockers or inflating finding counts.
- Test matching positives, opposing results, excluded files/dependencies, partial tool scope and unavailable engines. State why any pair is intentionally not comparable.

**Exit:** all supported overlaps have executable state coverage; JSON, SARIF and CLI can explain both agreement and uncertainty with preserved subject/scope links.

### W5 — Make reporters consume one policy-resolved result

**Criteria:** E4; regression gate for E5.

- Centralize normalized findings, applicability and operational verification outcomes before projecting CLI, saved JSON, SARIF and policy verdicts.
- Explicitly distinguish a standalone producer's default disposition from policy-effective disposition. Reporter mode must never silently reclassify the same audit result.
- Preserve exact rule/occurrence IDs, evidence/confidence, semantic decision, locations/related locations, suppression reason and operational status. Text summaries may be bounded, but must disclose filtering/truncation and link to complete machine-readable evidence; full-detail output must retain identity.
- Add end-to-end CLI tests from real producers, not only manually constructed artifacts: compiler, typed lint, React, package, tests, SARIF/runtime/coverage and heuristics. Cover all dispositions, suppression/baseline, new-only/all, unsupported/disabled producers and identical semantic results across formats.
- Keep impact/severity distinct from policy disposition and successful tool execution distinct from a passing quality verdict.

**Exit:** machine-checkable semantic tuples and policy exits match across representations, including required failures with no active code findings.

### W6 — Prove repeatability on fixtures and pinned MyStarQuest

**Criteria:** T2; real-project stress coverage for T3/E3/E4/E6.

- Specify canonical ordering and the exact timestamp/run-ID normalization allowlist before collecting results. Keep performance/cache telemetry in an explicit separate channel so the criterion is not weakened by a broad recursive field-removal filter. Never strip confidence, applicability, scope, findings, evidence, disposition or comparison reasons.
- Distinguish analyzer elapsed-time telemetry from imported runtime measurement values: do not normalize away measured performance observations.
- Add deterministic producer-order/tool-result-order tests, fresh process versus reused context, no-cache versus persisted cache, and repeated exports. Test normalization itself by intentionally changing an ID, disposition or completeness reason and requiring a diff.
- On pinned MyStarQuest, run at least three independent cold/warm pairs for focused producer groups and full audit. Fix tool/config/input identities; record raw results plus canonical semantic hashes/diffs. Here cold means fresh process/empty lens cache, not flushed OS cache. Keep optional imported runtime reports fixed when comparing determinism.
- Run the app and Firebase functions as explicitly separate scopes/configs; there is no root workspace declaration that automatically certifies both. Record actual discovered files and exclusions. Preserve the app's declared test execution in the full verification profile; separately label no-test runs incomplete if tests are required.
- Use disposable copies for controlled source/config/report mutations and suppressed-required-failure campaigns. Separate real project defects from analyzer contract failures. Unlabeled MyStarQuest findings are not precision/recall labels or independent calibration.
- Record wall time and peak RSS with process/child accounting scope and tool/runtime versions as observations. Do not transplant synthetic resource ceilings or claim O3 closed from this campaign without its separate representative-budget work.

**Exit:** identical deterministic evidence for unchanged inputs across the declared run/cache matrix; injected differences are detected and never presented as compatible clean evidence. No uninvestigated diffs or missing producer scopes.

### W7 — Complete native/profile evidence and update the ledger

**Criteria:** T4; final T1–T4/E1–E6 evidence review.

- Extend `.github/workflows/ci.yml` to execute Ubuntu and Windows with pinned minimum Node **20.19.0** and the supported Node 24 profile, using lockfile-consistent installation. Check dependency engine compatibility rather than assuming the declared floor works. If incompatible, fix dependencies or obtain an explicit support-policy change; do not quietly raise the floor.
- Every cell runs clean `npm ci && npm run ci`, including installed-package/test-runner smoke. Collect dependency-audit results separately and investigate advisories. Add acceptance structural/regression checks to CI; do not require the global release gate to pass while unrelated categories remain open.
- Verify package exports contain any new runtime validators/contracts, without requiring source checkout, development scripts, or stale `dist` files. Validate declared Nix packaging as applicable to delivery, rather than relying only on npm smoke.
- Archive durable commands, lens/consumer SHAs, lockfile/config/report hashes, platform/tool versions, outputs and test paths. Prefer replayable regression fixtures over `/tmp` references or unauditable local snapshot IDs.
- Review each criterion against its entire wording. Update `criteria.json`, `validation.md` and `UPGRADE-STATUS.md` only for substantively demonstrated passes. Do not claim Windows or consumer support when a job could not execute.

**Exit:** all ten Trust/Evidence criteria have reviewable current evidence, with no known counterexamples; full native/platform/package matrix passes. Run the global release gate and record remaining unrelated failures honestly. No commit/push/release is authorized merely by this plan.

## Completion checklist

- [ ] Probe A becomes a passing negative regression with truthful capability evidence.
- [ ] Probe B and all required-producer suppression/baseline variants cannot become verified pass.
- [ ] Blocking-rule inventory and executable positive/negative/unavailable coverage are complete.
- [ ] Producers emit validated, linked evidence and fail closed under the fault matrix.
- [ ] Reconciliation state and reporter/policy semantics survive end-to-end projection.
- [ ] Fixture and pinned MyStarQuest repeatability campaign passes with exact, reviewed normalization.
- [ ] Clean Linux/Windows, minimum/current Node and installed-package profiles pass.
- [ ] Criterion evidence is durable, current, scoped and reviewed; unrelated acceptance remains visible.
