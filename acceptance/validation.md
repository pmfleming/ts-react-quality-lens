# TS validation map

Latest clean Linux validation: 66 tests, full CI, actual installed-consumer/test-runner smoke and zero npm advisories. See `step-5.md`, `resource-results.json` and `criteria.json` for scoped results and unresolved acceptance. Reproduce with `npm ci && npm run ci && npm audit --json`, then `python3 acceptance/profile.py`.

Baseline revision: c4241f2. Evidence is not automatically accepted from earlier test totals.

| Criteria | Implementation / regression starting points | Reproduce |
|---|---|---|
| T1–T3, P1–P4 | test/quality-parity.test.ts, test/reliability.test.ts, test/execution-coverage.test.ts, test/architecture-correctness.test.ts | npm test |
| E1–E6 | src/actions.ts, src/audit/findings.ts, rule-contracts.json; test/capability-evidence.test.ts, test/rule-contract.test.ts, test/sarif-identity.test.ts, test/artifact-pipeline.test.ts | npm run ci |
| C1–C4 | contracts/calibration-design.md; test/quality-calibration.test.ts | npm test; independent review still required |
| O1–O7 | src/analysis-context.ts, src/artifact-batch.ts, src/integrations/tool-runner.ts; test/artifact-batch.test.ts, test/editor-agent.test.ts, test/protocol.test.ts | npm run ci; npm run bench |
| T4 | package.json, scripts/package-smoke.ts | npm ci && npm run ci; npm audit --json |

Supported coverage is source-linked LCOV/Istanbul and original-JavaScript V8; source-map/branch attribution is not certified. Every blocking family still needs a complete inventory and target-specific evidence. Required compiler/test failures are separate from suppressible findings.
