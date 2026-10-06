# Trust/Evidence execution record

Historical execution through 2093909. Latest staged alignment, runtime/security results and remaining gaps: [trust-followup.md](trust-followup.md).

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

## W4 — reconciliation survives audit/export

- Cleanup corroboration retains both producer names. Audit now collects confirmed/disagreed/excluded/not-comparable/unavailable observations separately from actionable findings; non-findings cannot inflate blocker counts. SARIF preserves the reconciliation channel.
- Clone, dependency-cycle and accessibility artifacts declare actual engine relationships: fallback alternatives or parallel syntax candidates, not falsely independent corroboration. Cleanup retains its per-candidate comparison/exclusion scope.
- Validation: build plus CLI/reconciliation/reporting suites: **18 tests passed**, including existing native Knip exclusion/disagreement regressions (`/tmp/ts-trust-w4-tests.log`).
- E6 remains open for broader scope/mutation validation; the new projection regression alone is not semantic certification of every engine overlap.

## W5 — reporter identity and evidence preservation

- Native findings distinguish producer disposition from effective audit disposition. SARIF retains related locations, semantic decision, impact, contract/reconciliation identifiers and run/capability evidence; policy classification stays upstream.
- Markdown includes every finding (including review/info, inherited and suppressed) with exact identity/evidence and reconciliation, rather than silently truncating to 25 active findings. Compact CLI summary explicitly identifies the full evidence output.
- Added real CLI JSON/SARIF/Markdown/summary equivalence with compiler and typed findings, failed test execution and suppressed required SARIF failure; all formats retain failing/incomplete policy and exact finding identities.
- Validation: `npm run ci`: **74 tests passed**, full checks/package smoke passed (`/tmp/ts-trust-w5-ci.log`).
- At this stage E4/E5 remained open pending broader coverage. The final E5 policy matrix below closes the non-waivable-verification obligation; E4's complete producer/reporting campaign remains open.

## W6 — executed MyStarQuest repeatability campaign

Provisioned Node **24.21.0** and npm **12.1.0**. Created a disposable clone at `/tmp/ts-trust-MyStarQuest`, pinned to `9ceeb3f4502777823dd5fb58a851614d0875763d`. Installed root and functions lockfiles using `npm ci --ignore-scripts --no-audit --no-fund`; lifecycle scripts were deliberately not run. Full app audits subsequently executed the declared `npm run test` successfully. Functions have no test command: their evidence explicitly says unknown/not executed, with only compiler/typed-lint required. No deployment, migrations, emulator/browser or Android commands were executed.

The first 24-observation campaign failed audit determinism solely on jscpd's `statistics.detectionDate`. This was investigated rather than filtered away wholesale: the exact analyzer timestamp is now retained in telemetry under the declared v2 boundary. A complete second campaign passed. After explicitly versioning changed policy/evidence semantics (`builtin v4`, verification v3), a third full campaign revalidated the final implementation.

Final lens revision: **`2093909f5b039ef5efa711983cb8b1e205c93bf7`**, clean working tree. Reproduction:

```sh
# With Node 24.21.0 and npm 12.1.0 on PATH and consumer lockfiles installed:
npm ci && npm run build
python3 acceptance/real_project.py /tmp/ts-trust-MyStarQuest /tmp/ts-trust-campaign-final
```

**24/24 observations passed** semantic repeatability: three cold/warm pairs for each app/functions × focused/full-project-audit profile. Each profile has exactly one semantic hash. The fixture suite also covers reused contexts, persisted/disabled caches, producer-result ordering, invalid run references and meaningful identity/disposition/runtime-value changes. T2 is now passed within the declared semantic boundary.

Durable observations, exact commands, source/config/lock fingerprints, producer versions and raw/semantic hashes: [`my-star-quest-results.json`](my-star-quest-results.json). `test_real_project.py` checks matrix integrity, not the truth of measured results. Raw snapshots remain at `/tmp/ts-trust-campaign-final/`; initial failures at `/tmp/ts-trust-campaign-v1/`.

| Profile | Cold ms (three runs) | Warm ms (three runs) | Max Node RSS KiB |
| --- | --- | --- | ---: |
| App focused | 11471 / 11693 / 11075 | 8111 / 8312 / 7977 | 710784 |
| App audit | 48952 / 55375 / 43777 | 45363 / 41227 / 41542 | 744480 |
| Functions focused | 3085 / 3012 / 3215 | 1958 / 2247 / 2000 | 518196 |
| Functions audit | 5611 / 5569 / 5640 | 4562 / 4573 / 4583 | 547208 |

Environment: Linux 6.18.53 x86_64. Cold means empty lens cache, not cold OS caches. RSS is the analyzer process only, excluding child peaks. No O3 performance budget, cross-language ranking or independent accuracy claim is made.

Analyzer-observed scope: **270 app source files**, **62 catalogued test files**, **8 functions source files**. This differs intentionally from the tracked-file census (declarations are excluded; analyzer line counting also differs). App full-audit verdict: **warn**, 57 active warnings and no blockers, 2,723 total review/diagnostic findings; functions: **warn**, 4 active warnings, no blockers, 132 total findings. Both compiler profiles report zero diagnostics. These unlabeled findings are not precision/recall evidence, and type coverage is not execution coverage. Git-base comparisons were explicitly not requested in these full-project campaigns.

## Required verification matrix and final reporter hardening

`test/verification-policy.test.ts` covers **every PolicyCheck** (compiler, typed lint, React Hooks, tests, package) with missing/empty/failed evidence and successful controls, always using an empty ordinary finding set. It also covers required SARIF and configured runtime/coverage outputs. This exposed and repaired missing configured runtime output being ignored by audit. Actual compiler/test failures remain failures; unavailable required evidence remains incomplete even after every ordinary finding is suppressed. Existing real CLI tests cover both gate modes, baseline/config suppression and failed/removed test execution. E5 is re-certified for non-waivable verification, not for upstream payload authenticity (E3).

SARIF now retains the entire normalized native finding in properties as well as standard locations/dispositions, preventing loss of producer-specific evidence such as imported details. Its full audit summary is preserved and checked against real JSON output. E4 remains open for the complete producer/profile campaign, rather than inferring full acceptance from this core scenario.

## W7 — clean native validation and investigated platform blockers

At final implementation revision `2093909`, clean local clones ran **`npm ci && npm run ci` successfully**:

| Platform | Node / npm | Native result |
| --- | --- | --- |
| Linux x86_64 | 20.19.0 / 10.8.2 | 77 tests, all native checks, performance smoke and installed-consumer/test-runner smoke passed |
| Linux x86_64 | 24.21.0 / 12.1.0 | 77 tests, all native checks, performance smoke and installed-consumer/test-runner smoke passed |
| Windows | 20.19.0 and 24.21.0 | Matrix configured; not executed here |

Validation found and repaired two actual portability defects: Node 20 does not expand the quoted test glob, so the runner now explicitly enumerates tests on all platforms; npm 12 returns a package-name keyed pack report rather than an array, so both production packing and package smoke now validate either shape. Malformed/multi-package/escaping reports are rejected by a new regression.

**T4 is still blocked:**

1. The Node 20 install warns that `jscpd@4.3.0` depends on `commander@15.0.0`, whose declared engine is Node >=22.12. Passing tests does not override the dependency's declared support floor.
2. Fresh `npm audit --json` on both profiles reports **five high advisories** through jscpd → finder → fast-glob → micromatch → braces (GHSA-vfj7-8cjw-p6xm). See [`dependency-audit.json`](dependency-audit.json). The registry proposes jscpd **5.4.0**, a Rust/native-binary engine migration, not a safe automatic patch. No forced upgrade, override or audit waiver was applied. That migration needs explicit adapter, native-platform and packaging validation.
3. `nix build --no-link --offline` failed in the upstream TinyCC source dependency, before lens build: expected `sha256-MRuqq3TKcfIahtUWdhAcYhqDiGPkAjS8UTMsDE+/jGU=`, received `sha256-sRlCKIisiQSm7DR8hNO6rDrcNPpvcyiNNMhcpnSyGQI=`. No integrity check was disabled or hash blindly replaced.
4. Windows was not available. The expanded workflow includes both Node versions on Ubuntu/Windows, acceptance checks and dependency audit, but has not been pushed or remotely executed.

Diagnostic logs: `/tmp/ts-trust-clean-node{20,24}-final.log`, `/tmp/ts-trust-nix-build.log`. Lens lockfile SHA-256: `a107af9d4c1ef161f4fb456f4256ff97b966b040148fb88f858eb02c0a9c5ec3`. Clean Node 20 log SHA-256: `843d19c86028f0f047efc4fd4814282ebf067b745d14ee23f307a8be86ff5c4d`; Node 24: `621dc852e97090318f2029b17bfd5ae7f8aa4cf507af2dafc0c4ea6ecf66e5ea`. Later acceptance/status/data commits do not change the validated runtime implementation.

## Final acceptance decision and remaining work

- **Trust: 2/4 passed** (T1, T2); T3 open, T4 blocked.
- **Evidence Contract: 2/6 passed** (E1 structural vocabulary, E5 non-waivable verification).
- Overall **5/25 passed, 20 unresolved**. The release gate must remain nonzero. Categories and the whole plan are **not complete**.
- Remaining engineering, not external blockers: finish E2/T3 per-rule applicability and upstream-family positive/negative/unavailable cases; E3 legacy/native payload validation, imported source provenance and cross-artifact generation integrity; E4 full producer/profile reporter matrix; E6 engine exclusion/scope mutations. Comparison projection also remains an E1 integration obligation beyond the existing structural pass.
- Remaining environment/delivery work: supported dependency/security remediation, trustworthy Nix dependency resolution and actual Windows executions. Existing independent-calibration/intent-review and other P/C/O requirements remain untouched.

Implementation stages were committed separately. No push/release occurred, and both the user's MyStarQuest checkout and the disposable consumer checkout remained clean.
