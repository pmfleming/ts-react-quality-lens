# Cross-lens upgrade execution

The review's phases 0–4 are executed as phases 1–5. Each phase has its own commit.

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
