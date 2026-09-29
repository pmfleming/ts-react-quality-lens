# Test suite reduction review

Review date: 2026-09-29. Baseline commit: `b27fa95`.

The baseline contains 78 registered Node tests (77 passing and one Windows skip in the preceding full CI run). The requested final count is 78 × 0.67 = 52.26; rounding to the nearest whole test gives **52**. Removing **26** tests leaves **66.67%**, a **33.33% reduction**. Counts include registered platform-specific skips; rule-corpus rows are data within one test.

This is a review snapshot, not a permanent test-count limit. Test discovery, CI commands, and production code are unchanged. Entire test bodies and repeated fixture setup were deleted. A few critical assertions were moved into existing behavior scenarios; removed bodies were not wrapped in a new table or hidden behind skips.

## Removed tests and retained protection

| File | Removed test | Reason and remaining coverage |
| --- | --- | --- |
| cli.test.ts | catalog exposes stable board task metadata | Hard-coded task count and presence smoke; schema-check validates task identifiers and protocol tests cover advertised services. |
| cli.test.ts | tsconfig JSONC path aliases are resolved | Legacy baseUrl fixture; exact alias graph regression and inherited alias test mapping remain. |
| cli.test.ts | audit writes changed-code verdict artifact with actions | Accepts every possible verdict; stronger invalid-base, changed-line, package-gate and editor-action tests remain. |
| cli.test.ts | context command writes compact project context and cache can hit | Cache hit/invalidation smoke overlaps dedicated cache regressions; workspace integration still exercises projectContext. |
| cli.test.ts | project analysis marks package tool entrypoints | Exact role-list assertions overlap cleanup entrypoint protection; preserve bin and HTML entrypoint behavior in that existing fixture. |
| cli.test.ts | clone measure reports same-purpose exports and hooks without clone-like bodies | Locks in speculative naming heuristics and exact purpose keys; real clone detection remains in basic and golden integrations. |
| cli.test.ts | analysis handles inline type imports and default export assignments | Repeated project setup; inline type association and used default exports are exercised by existing mapping and cleanup fixtures. |
| cli.test.ts | react hooks lint resolves dependencies when output dir is outside the project | Repeated Hooks execution and disposition checks; retained version-guidance integration uses an external output directory. |
| cli.test.ts | jsx-a11y findings replace heuristics when managed lint completes | Basic integration already checks suppression of heuristics; the retained rule corpus checks managed and fallback findings. |
| cli.test.ts | dependency health tolerates dependency-cruiser cycle shape variants | Hand-built compatibility variants coupled to adapter internals; installed-tool and real-cycle integration coverage remains. |
| architecture-correctness.test.ts | standalone architecture generates every declared input exactly once | Exact handler invocation counts constrain scheduling; basic integration and execution-evidence regression check resulting artifacts. |
| architecture-correctness.test.ts | architecture distinguishes unexecuted tests from passing suite associations and consumes lint and cleanup | Synthetic fixed-score expectations constrain the risk model; preserve unknown-versus-executed evidence in the real architecture regression. |
| editor-agent.test.ts | editor analysis runs in a worker while protocol requests remain responsive | Ten-millisecond unfinished-state assertion depends on scheduling and worker implementation; pending-analysis shutdown and protocol tests remain. |
| editor-agent.test.ts | API measurements return the same enriched finding identities as persisted artifacts | Whole-output equality duplicates enrichment checks; compiler provenance test now validates public occurrence identities and movement through persisted output. |
| npm-cli.test.ts | npm CLI uses npm_execpath when launched by npm | Direct path echo overlaps real npm execution in package health and package smoke. |
| npm-cli.test.ts | npm CLI ignores other package managers and resolves beside Node on Windows | Additional installation-layout branch; retain shim non-execution and missing-installation failure tests. |
| npm-cli.test.ts | npm CLI resolves a Unix installation relative to Node | Another installation-layout variant; package smoke exercises the actual installation on each CI operating system. |
| npm-cli.test.ts | npm CLI follows npm symlinks on PATH | Platform-specific path-layout microtest; remove the skipped case rather than changing skip policy. |
| modern-tooling.test.ts | React capability metadata is written and validated with the artifact | Expected output repeats the production helper; retain schema validation and concrete capability checks in the workspace guidance integration. |
| typed-lint-projects.test.ts | project service and explicit project mode agree on conventional typed findings | Exact cross-mode message equality constrains tool evolution; retained workspace/custom-project cases assert unsafe findings and completeness. |
| typed-lint-projects.test.ts | typed lint mode is validated and defaults to auto | Schema/default microtest; schema-check covers valid configuration and retained config rejection test covers invalid mode. |
| files.test.ts | import resolution accepts exact aliases and empty wildcard matches without matching unrelated imports | Low-level resolver object equality and fallback variants; keep real alias graph and inherited mapping regressions. |
| reliability.test.ts | invalid TypeScript options are diagnostics, not clean loaded projects | Duplicate of the stronger invalid-configuration artifact/provenance regression. |
| reliability.test.ts | semantic identities survive movement and preserve duplicate occurrences | Internal normalization assertions replaced by essential identity checks on actual compiler artifacts. |
| reliability.test.ts | persisted compiler diagnostics have unique occurrence identities | Duplicate compiler fixture; uniqueness is retained in the existing compiler provenance scenario. |
| sarif-identity.test.ts | SARIF results without fingerprints retain duplicate occurrences | Repeated SARIF setup; add two fingerprint-free occurrences to the retained isolation/suppression scenario. |

## Retained priorities

- Complete artifact/schema integration and real installed-tool execution.
- Audit invalid bases, empty diffs, inherited findings, incompatible identities, stale suppressions, and package failures.
- Compiler/API provenance, invalid configuration, type coverage, unsafe values, and TypeScript directives.
- All cache invalidation regressions for configuration, declarations, discovered files, missing modules, installed types, and package manifests.
- React support ranges, workspace peers/overrides, optimization policy, and all eight rule contracts with 22 original/mutated corpus cases.
- Workspace project service, custom config scope, uncovered files, and missing inputs.
- LSP lifecycle, suppression edits, MCP resource containment and explicit execution permission, and both wire protocols.
- SARIF identity isolation/stability, external-report validation, package validation, and public API cleanup protection.

## Deliberately reduced coverage

The suite no longer promises exact internal invocation counts, fixed risk weights, naming-heuristic purpose keys, equality of all messages across lint modes, every npm installation layout, or historical dependency-cruiser cycle shapes. It also removes isolated alias fallback variants while retaining real project alias regressions. Shutdown during pending analysis remains covered; the scheduler-specific responsiveness assertion is removed.

## Validation

`npm run ci` passed after the reduction: typecheck, build, schema validation, all eight rule contracts and 22 corpus cases, formatting, **52 tests passed with no failures or skips**, performance smoke (14.396 seconds against a 60-second limit), and package smoke. `git diff --check` also passed.
