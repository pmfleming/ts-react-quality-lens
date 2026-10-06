# TS validation map

Latest runtime snapshot: `07b9158` plus `runtime_source_sha256:319d8fc9fa03a72aaa0be281acf6db26a70442f15a4e0ac55f22d939b17ce36d`, committed with `followup-validation.json`. Clean engine-strict Linux Node 20.19.0/npm 10.8.2 and Node 24.21.0/npm 12.1.0: **88 tests**, full native CI and installed-consumer/test/native-clone smoke passed. Fresh audit: **zero advisories**. Windows and Nix remain unverified; no Node-floor or security waiver. See `trust-followup.md`, `dependency-audit-followup.json` and `criteria.json`.

Reproduce native profiles with `npm ci --engine-strict && npm run ci && npm audit --audit-level=moderate` on supported ordinary Linux/Windows userspace (Nix native delivery remains unverified). Current QML campaign: `python3 acceptance/sibling_project.py ../qmlqualitylens OUTPUT`, with output outside both repositories and Node 24.21/npm 12.1 on PATH. Shared contracts: `node dist/scripts/cross-lens-check.js ../qmlqualitylens`. Twelve retained samples are in `qml-project-results.json`; full QML `npm test` passed 286 tests.

The earlier MyStarQuest v2-boundary campaign remains historical in `my-star-quest-results.json`; rerun `acceptance/real_project.py` before making a current MyStarQuest claim. Structural checks: `python3 -m unittest discover -s acceptance -p 'test_*.py'`. Synthetic O3 profiling remains separate (`python3 acceptance/profile.py`).

| Criteria | Implementation / regression starting points | Reproduce |
|---|---|---|
| T1–T3, P1–P4 | test/quality-parity.test.ts, test/reliability.test.ts, test/execution-coverage.test.ts, test/architecture-correctness.test.ts | npm test |
| E1–E6 | src/actions.ts, src/audit/findings.ts, rule-contracts.json; test/capability-evidence.test.ts, test/rule-contract.test.ts, test/sarif-identity.test.ts, test/artifact-pipeline.test.ts | npm run ci |
| C1–C4 | contracts/calibration-design.md; test/quality-calibration.test.ts | npm test; independent review still required |
| O1–O7 | src/analysis-context.ts, src/artifact-batch.ts, src/integrations/tool-runner.ts; test/artifact-batch.test.ts, test/editor-agent.test.ts, test/protocol.test.ts | npm run ci; npm run bench |
| T4 | package.json, scripts/test-runner.ts, scripts/package-smoke.ts, .github/workflows/ci.yml | npm ci && npm run ci; npm audit --json |
| T2 | src/deterministic-evidence.ts, contracts/determinism.md, test/determinism.test.ts, acceptance/qml-project-results.json | python3 acceptance/sibling_project.py PROJECT OUTPUT |
| E5 | test/verification-policy.test.ts, test/trust-failures.test.ts, test/reporting-e2e.test.ts, test/reporting-profiles.test.ts | npm run ci |

Supported coverage is source-linked LCOV/Istanbul and original-JavaScript V8; source-map/branch attribution is not certified. Every blocking family still needs a complete inventory and target-specific evidence. Required verification status is separate from suppressible findings across compiler, typed-lint, React, tests, package, required SARIF and configured runtime/coverage channels.
