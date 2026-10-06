# Self-lens refactor review

Subsequent batch: [coverage orchestration and artifact evidence](coverage-evidence-refactor.md), measured against `6122259`.

## Method

Compared the working tree with `b71c97d` using the **same frozen analyzer and dependencies**, cache disabled, and the unchanged self-analysis source roots (`src`, `bin`, `scripts`). No scoring weights, thresholds, rules, or exclusions were relaxed. Measurements used Node 24.16.0.

The original analyzer could not publish its own escape-hatch artifact: nested assertions with the same starting position had duplicate finding IDs. Both measurement profiles therefore use the same narrow repair: append `node.end` to AST escape IDs and declare `escape_identity: node-span-v2` in the analysis identity. That repair is also in the refactor. Saved comparisons intentionally see the identity change.

| Observation | Before | After |
| --- | ---: | ---: |
| Production source lines | 12,249 | 12,158 |
| All TS/TSX lines, including tests and fixtures | 15,621 | 15,637 |
| Functions | 705 | 713 |
| Cyclomatic complexity, total / maximum | 2,814 / 45 | 2,663 / 23 |
| Cognitive complexity, total / maximum | 2,482 / 118 | 2,266 / 29 |
| Halstead effort, total | 8,501,512.96 | 8,001,787.47 |
| High-risk hotspot records | 124 | 117 |
| Clone groups (native / AST) | 8 (2 / 6) | 5 (1 / 4) |
| Escape hatches | 19 | 2 |
| Blocking / warning lint findings | 33 / 9 | 0 / 1 |
| Type coverage | 98.88% | 99.29% |
| High-risk locality records | 3 | 2 |
| Shared hubs | 23 | 26 |
| Internal dependency edges | 351 | 371 |
| Dependency cycles / layer violations | 0 / 0 | 0 / 0 |

Production code is 91 lines smaller, but regression tests add 107 lines: **overall TS/TSX grows by 16 lines**, so the total-code-line reduction goal is not met. Documentation also adds lines outside these measurements. Line counts follow the existing split-on-newline convention, including blank and final empty lines. Effort is a static estimate, not measured engineering time. More shared hubs is descriptive, not inherently better: sharing increased dependencies while eliminating repeated boundary validation, finding extraction, file-input hashing, and tool-status construction. The largest individual Halstead effort remains 343,989.16 (`createLspSession`).

## Changes and limits

- `src/coverage.ts`: separate LCOV, Istanbul and V8 readers, shared source attribution/hit aggregation, and one stable V8 range sort instead of sorting for every character. Tests preserve maximum-hit merging, inner zero-count precedence, equal-width ordering, CRLF handling, and malformed-input rejection.
- `src/validation.ts`: reusable typed boundary checks replace duplicated predicates and casts. Required producer/wire relationships still have explicit invariants. Malformed enum values that previously passed through string coercion are now rejected; valid producer formats remain supported.
- `src/measures/cleanup.ts`: encapsulate export-origin traversal state rather than repeatedly passing modules, memoization and traversal sets through cloned signatures.
- Shared helpers replace duplicate artifact readers, file snapshots and package-tool metadata. Existing finding ordering and callback compatibility are regression-tested.
- Removed the unused internal `digest` export. Knip now reports zero findings, but **this is not deletion of all previously reported code**: `test/*.test.ts` was missing from its entrypoints despite being executed by the custom test runner. Tests and their imported exports are now correctly reachable. No tests were deleted or ignored.
- A direct compiler-input regression test improves the locality association. Import association is not execution coverage. Historical churn and co-change remain unchanged.
- Remaining clone candidates include import boilerplate and structurally similar code with different meanings; these were not forced into artificial abstractions. Remaining assertions are in `src/finding-identity.ts` and `src/lsp-worker.ts`; the worker boundary accounts for the remaining lint warning.

## Validation

- Host: typecheck, build, schema/rule/format checks, **93 tests**, focused follow-up regression tests, and performance smoke passed. The installed-package smoke failed on NixOS's generic-Linux ELF loader restriction; this was not waived or reported as a pass.
- Independent Ubuntu userspace, Node **24.18.0**, npm **11.16.0**: clean `npm ci --engine-strict`, full `npm run ci` (**94 tests**) including installed-consumer/native-jscpd smoke, and moderate-threshold audit passed; **zero vulnerabilities**. No installed native binary was patched in this profile.
- TS/QML shared wire/capability validation: **380 assertions passed**, observed sibling revision `0e07c3e4a53175ee5cf17beb4c84a18602d801b8`; sibling files were not modified by this work.
- The refactored analyzer and frozen analyzer produced **11 identical deterministic artifacts** when both analyzed the final tree. This guards the measurement comparison against changing its own scoring implementation.
- This is refactor evidence, not a new release/platform certification or closure of the broader Trust/Evidence acceptance gaps. Windows and Nix delivery were not certified here.

## Reproduction

```sh
npm ci --engine-strict
npm run ci
npm audit --audit-level=moderate
node dist/scripts/cross-lens-check.js ../qmlqualitylens
```

For a like-for-like comparison, build an independent `b71c97d` checkout with the two escape-identity repairs above and the same locked dependencies. Load its `dist/src/config.js`, `analysis-context.js` and `measure-runner.js`; use `loadConfig(<target>/ts-react-quality-lens.config.json)`, an external output directory, `config.cache.enabled = false`, and a shared `createAnalysisContext(config)`. Run these tasks against both target trees without changing the analyzer:

```text
quality.hotspots quality.clones quality.escape_hatches quality.type_health
quality.lint quality.dependency_health correctness.catalog
quality.locality_dynamic quality.locality_leverage quality.cleanup
```

Local raw evidence: `/tmp/ts-lens-refactor-{before,after,current}`, driver `/tmp/lens-self-refactor.mjs`, host log `/tmp/ts-lens-refactor-ci.log`, clean-profile log `/tmp/ts-self-refactor-node24.log`. These temporary files are not distributed evidence fixtures. The catalog task does not execute tests; the test result above comes from the separate CI runs.
