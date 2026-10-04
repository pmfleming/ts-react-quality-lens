# Trust/Evidence execution record

Plan: [trust-evidence-plan.md](trust-evidence-plan.md). Stage completion is not criterion acceptance. No push or release performed.

## W1 — reproduced failure repairs

- Missing/unknown prerequisites now fail closed. Standalone typed-lint and React artifacts require successful requested semantic producers instead of generic dependency-directory presence.
- Required SARIF completion is checked independently of findings, suppressions, baselines and audit gate. Optional missing inputs remain explicitly optional.
- Added `test/trust-failures.test.ts`: real missing-tsconfig and suppressed-required-SARIF probes, malformed/failed-invocation cases, baseline and both gate modes, successful and optional controls, SARIF projection.
- Validation: `npm run ci` on Linux Node 24.16/npm 11.13: **69 tests passed**, all native checks and installed-package smoke passed. Log: `/tmp/ts-trust-w1-ci.log` (diagnostic only; committed regressions are the durable reproduction).
- E5 is reopened rather than re-certified: the observed counterexample is repaired, but exhaustive required-producer/profile cases remain pending. T3/E3 remain open pending the broader capability/payload matrix.
