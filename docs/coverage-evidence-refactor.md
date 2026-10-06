# Coverage orchestration and artifact-evidence refactor

Baseline: `6122259`. This batch changes only the two production modules recommended by the preceding self-lens review. It does not change scoring, discovery, thresholds, public entrypoint signatures, or wire schemas.

## Responsibilities

- `src/measures/coverage.ts`: isolate linked-report loading/completeness, Git changed-line aggregation, and function coverage/risk calculation. The entrypoint assembles the artifact. Preserve partial observations, null versus zero coverage, stale-input rejection, and `changedSince` precedence over `base`.
- `src/artifact-evidence.ts`: make producer-status precedence explicit; separate run, finding, measurement and comparison projection; separate structural validation from producer/applicability and reference consistency checks. Preserve ordering, defaults, suppression, severity precedence, duplicate-identity rejection and legacy-envelope handling.
- Native validation now catches malformed common-field processing inside its rejection boundary. In the differential campaign, 11 cases that previously threw now return `false`; none becomes accepted.

## Frozen-analyzer measurements

The analyzer built from `6122259` measured both source trees with the same locked dependencies, Node 24.16.0, source roots and disabled cache. All extracted helpers are included in the totals.

| Observation | Before | After |
| --- | ---: | ---: |
| Maximum function cognitive complexity | 29 | 21 |
| Maximum function cyclomatic complexity | 23 | 18 |
| Total cognitive complexity | 2,266 | 2,254 |
| Total cyclomatic complexity | 2,663 | 2,680 |
| Total estimated Halstead effort | 8,001,787.47 | 7,977,545.13 |
| Production lines | 12,158 | 12,200 |
| Functions | 713 | 724 |
| All TS/TSX lines, including tests/fixtures | 15,637 | 15,838 |
| Type coverage | 99.29% | 99.27% |

The largest cognitive/cyclomatic values within the coverage module become **8/8**, and within artifact evidence **17/18**, including replacement helpers. This is a reduction of concentrated complexity, **not** a total-cyclomatic or line-count improvement. Halstead is a static estimate, and extraction can change its aggregation.

Compiler diagnostics remain zero. The type-coverage change comes from three additional identifiers the collector classifies as compiler `error` types: two type-predicate parameter references and one destructuring property name. Inferred-any count remains 69; this batch does not modify the collector or waive the reported decrease.

Unchanged: 117 high-risk hotspot records, five clone groups, two escape hatches, zero blocking/one warning lint finding, zero cleanup findings, two high-risk locality records, 26 shared hubs, and zero dependency cycles/layer violations. Internal edges increase by one through reuse of boundary validators. Existing LSP and test-mapper effort hotspots are outside this batch.

## Validation

- **97 tests passed** in a clean Ubuntu userspace profile: Node **24.18.0**, npm **11.16.0**. `npm ci --engine-strict`, full `npm run ci` (including schema/rule/format checks, performance smoke and installed-consumer/native-clone smoke), and moderate-threshold audit all passed. Zero vulnerabilities; no installed binary patching.
- Added 46 task/confidence combinations, wire/default/comparison/identity mutation controls, and coverage orchestration tests spanning malformed/missing/stale reports, partially observed functions, invalid Git bases, empty diffs and changed-line percentages.
- The 46 capability cases and all coverage tests also pass against the frozen implementation.
- Differential replay of **11 existing native artifacts and 726 malformed-field mutations** preserves accepted/rejected outcomes and successful projected payloads; only the 11 rejection-channel changes described above differ.
- The frozen and refactored analyzers produce **11 identical deterministic artifacts** when measuring the final working tree.
- Shared TS/QML wire/capability validation: **380 assertions passed** at observed sibling HEAD `958d52faaef60ffe4a7924afc882f29c7a6ad035`. This work does not modify the sibling checkout.
- Windows/Nix delivery and broader Trust/Evidence acceptance gaps are not certified by this batch.

## Reproduction

Use `npm ci --engine-strict && npm run ci && npm audit --audit-level=moderate` in a compatible Linux userspace. Targeted tests are `dist/test/evidence-projection.test.js` and `dist/test/execution-coverage.test.js`; run them with `node --test` after building.

For frozen measurement, use the method in [the preceding report](self-refactor-followup.md), replacing the baseline with `6122259` (no identity patch required). Local temporary evidence: `/tmp/ts-next-{before,after,current}`, `/tmp/ts-next-differential.mjs`, `/tmp/ts-next-node24.log`, and the driver `/tmp/lens-self-refactor.mjs`. These are local replay artifacts, not distributed acceptance fixtures.
