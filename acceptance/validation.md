# TS validation map

Latest implementation revision: `2093909f5b039ef5efa711983cb8b1e205c93bf7`. Clean Linux Node 20.19.0/npm 10.8.2 and Node 24.21.0/npm 12.1.0: **77 tests**, full native CI and installed-consumer/test-runner smoke passed. Fresh dependency audit reports **five high advisories**; the Node 20 transitive engine warning, Windows and Nix profiles remain blockers. See `trust-evidence-execution.md`, `dependency-audit.json` and `criteria.json`.

Reproduce native checks with `npm ci && npm run ci`, then `npm audit --json` (currently nonzero). The pinned real-project campaign is `python3 acceptance/real_project.py PROJECT OUTPUT` under Node 24.21/npm 12.1 after installing both consumer lockfiles; 24 retained observations are in `my-star-quest-results.json`. Structural data checks: `python3 -m unittest discover -s acceptance -p 'test_*.py'`. Synthetic O3 profiling remains separate (`python3 acceptance/profile.py`). Earlier step-5 zero-advisory results are historical, not current acceptance.

| Criteria | Implementation / regression starting points | Reproduce |
|---|---|---|
| T1–T3, P1–P4 | test/quality-parity.test.ts, test/reliability.test.ts, test/execution-coverage.test.ts, test/architecture-correctness.test.ts | npm test |
| E1–E6 | src/actions.ts, src/audit/findings.ts, rule-contracts.json; test/capability-evidence.test.ts, test/rule-contract.test.ts, test/sarif-identity.test.ts, test/artifact-pipeline.test.ts | npm run ci |
| C1–C4 | contracts/calibration-design.md; test/quality-calibration.test.ts | npm test; independent review still required |
| O1–O7 | src/analysis-context.ts, src/artifact-batch.ts, src/integrations/tool-runner.ts; test/artifact-batch.test.ts, test/editor-agent.test.ts, test/protocol.test.ts | npm run ci; npm run bench |
| T4 | package.json, scripts/test-runner.ts, scripts/package-smoke.ts, .github/workflows/ci.yml | npm ci && npm run ci; npm audit --json |
| T2 | src/deterministic-evidence.ts, contracts/determinism.md, test/determinism.test.ts, acceptance/my-star-quest-results.json | python3 acceptance/real_project.py PROJECT OUTPUT |
| E5 | test/verification-policy.test.ts, test/trust-failures.test.ts, test/reporting-e2e.test.ts | npm run ci |

Supported coverage is source-linked LCOV/Istanbul and original-JavaScript V8; source-map/branch attribution is not certified. Every blocking family still needs a complete inventory and target-specific evidence. Required verification status is separate from suppressible findings across compiler, typed-lint, React, tests, package, required SARIF and configured runtime/coverage channels.
