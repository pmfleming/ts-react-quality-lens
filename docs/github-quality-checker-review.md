# GitHub TypeScript and React Quality Checker Review

Reviewed: 2026-08-22

## Purpose

This review mines active open-source TypeScript, JavaScript, React, architecture, dead-code, package, and security checkers for ideas that fit `ts-react-quality-lens`.

The goal is not to reproduce every competing rule. The lens should remain an evidence aggregator with stable artifacts, explicit confidence, changed-code audit support, and conservative defaults. The best ideas are therefore those that improve evidence quality, coverage, adoption, interoperability, or false-positive control.

## Method

The review used repository documentation, rule registries, schemas, tests, and implementation structure at pinned commits. Popularity is only a discovery signal, not evidence of rule quality. Claims about precision or performance below are limited to what a project documents; they were not independently benchmarked here.

Key source snapshots:

| Project | Reviewed commit | Primary lesson |
| --- | --- | --- |
| [React Doctor](https://github.com/millionco/react-doctor) | `e183c3519010599d929ed14d99a18bf1f8f8a44c` | React-specific rules, framework gating, runtime traces, large-corpus validation, and false-positive fuzzing. |
| [Knip](https://github.com/webpro-nl/knip) | `9f18cba93c91de8554636b13692d6e7a937b7697` | Workspace-aware dead code and dependency hygiene backed by a large framework-plugin catalog. |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | active main branch reviewed through installed packages and public docs | Standards-based typed correctness rules and a clear split between typed and syntax-only analysis. |
| [eslint-plugin-react-hooks](https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks) | installed managed package plus current React repository | Official React and React Compiler diagnostics beyond the two classic Hooks rules. |
| [ESLint React](https://github.com/Rel1cx/eslint-react) | `b6f6bf6ca340b3ebd7d4bb05374ff30e766f2ed4` | Modern React, DOM, Web API lifecycle, React Server Component, and JSX rule families. |
| [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y) | `8f75961d965e47afb88854d324bd32fafde7acfe` | Established static JSX accessibility evidence. |
| [eslint-plugin-import-x](https://github.com/un-ts/eslint-plugin-import-x) | `25e9871b8f0debf9235a2e3b375e5586a8db3b4c` | Import correctness, dependency declarations, restricted paths, and module-boundary policy. |
| [SonarJS](https://github.com/SonarSource/SonarJS) | `8cd6c081dff36071499a9c35b54306bdbbeccb43` | Secondary locations, remediation effort, certainty, quick fixes, coverage-aware risk, and security-flow evidence. |
| [Fallow](https://github.com/fallow-rs/fallow) | `03b7e74802176f653ae5fcf6d92a1883335a8599` | Fail-closed semantic refinement, stable contracts, public conformance corpora, performance gates, and agent/editor surfaces. |
| [Betterer](https://github.com/phenomnomnominal/betterer) | `69a83c14975b6ef2e4e42736e686ffba0f28895f` | Ratcheting arbitrary quality measures without requiring a one-time cleanup. |
| [type-coverage](https://github.com/plantain-00/type-coverage) | `29db103579964888f24c7a495055fd8cf5b1b13d` | Type coverage, per-file details, history, stale ignores, and incremental strictness migration. |
| [publint](https://github.com/publint/publint) | `4dc880a2057a45d6b65bc12828c39d8d76fa0c7e` | Deterministic package-manifest and published-file validation. |
| [Are The Types Wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) | `ee85fcadb8c1130627f36d0f48cc5b8b6b12451c` | Testing package types under Node 10, Node 16, and bundler resolution modes. |
| [API Extractor](https://github.com/microsoft/rushstack/tree/main/apps/api-extractor) | `ae8073b330ea1004921cad9065f9dce60fc35a5b` | Public API review files, declaration rollups, forgotten exports, release tags, and API compatibility review. |

Also considered as integration targets: [Biome](https://github.com/biomejs/biome), [Oxlint/Oxc](https://github.com/oxc-project/oxc), [CodeQL](https://github.com/github/codeql), and [Semgrep](https://github.com/semgrep/semgrep).

### License boundary

Ideas and public interfaces may be studied, but source reuse must respect each license. In particular:

- the reviewed SonarJS repository uses the Sonar Source-Available License rather than a permissive open-source license;
- React Doctor uses a Modified MIT license that restricts use in AI-training/improvement pipelines and substantially-derived paid hosted services.

Treat both as product-design and interoperability references only. Do not copy their implementations or fixture corpora into this project. Any future React Doctor integration should consume its documented CLI output as an independently installed external tool.

## Executive conclusions

`ts-react-quality-lens` already compares well on artifact provenance, confidence, changed-code auditing, baselines, suppressions, architecture scoring, and combined evidence. Its largest gaps are:

1. **React evidence is too narrow.** The current managed React integration runs only Rules of Hooks and exhaustive dependencies, while the installed official plugin exposes React Compiler checks for purity, refs, immutability, render-time state changes, static components, error boundaries, globals, and unsupported syntax.
2. **Accessibility is heuristic.** Regex-based signals should be supplemented by `eslint-plugin-jsx-a11y` and optionally runtime axe results.
3. **Cleanup lacks ecosystem knowledge.** Reimplementing Knip's framework and workspace conventions locally would be expensive and less accurate. A normalized Knip adapter is a better route.
4. **Library correctness is missing.** Published packages need `publint`, Are The Types Wrong, declaration emit, and optionally API Extractor evidence.
5. **Type quality is represented as counts, not coverage.** A type-coverage dimension can show whether `any` and unresolved types are concentrated or improving.
6. **The test strategy is fixture-heavy but not corpus-driven.** Rule additions need real-project comparison, confirmed false-positive fixtures, and mutation/metamorphic robustness checks.
7. **The cache records metadata but does not yet reuse analysis.** Mature tools use content and dependency fingerprints and never cache incomplete runs.
8. **Findings need richer relationships.** Secondary locations, source ranges, fix grouping, and abstention reason codes would make artifacts more useful to agents and reviewers.

The recommended strategy is **integrate authoritative tools, implement only lens-specific cross-tool reasoning, and preserve built-in fallbacks**.

## What to mine from each checker

### 1. React Doctor

React Doctor's useful contribution is not simply its very large rule count. Its stronger patterns are:

- capability and installed-version gating for Next.js, React Router, React Native, Expo, TanStack, Preact, state libraries, and other ecosystems;
- separate local AST rules, cross-file rules, and project-level scans;
- changed-code CI with a base-tree analysis rather than line filtering alone;
- deterministic diagnostic occurrence IDs and shared `fixGroupId` values when one edit clears several findings;
- JSON/JSONL agent output, CI comment setup, an agent skill, and an experimental LSP;
- browser performance traces that connect static findings to real renders;
- a pinned 2,000-repository evaluation corpus;
- a fuzz corpus split into confirmed false positives and confirmed true positives;
- verdict-preserving AST rewrites that catch fragile detector implementations;
- a rule-development contract that requires runtime rationale, strong positives, false-positive traps, explicit scope, and test seeds before implementation.

High-value rule themes for this lens:

- effect cleanup for listeners, timers, animation frames, observers, object URLs, and async work;
- derived or mirrored state and effect chains;
- state changes during render and impure state updater functions;
- random or unstable keys, with array-index keys kept as a warning because valid static-list cases exist;
- unstable context provider values and nested component definitions;
- hydration mismatches and unguarded browser globals;
- unchecked fetch responses and unsafe parsing at runtime boundaries;
- duplicate JSX subtrees and high-complexity React functions;
- framework-version-specific rules only after the framework and version are proven.

Recommended use:

- Do not reproduce its broad visual-design or ecosystem-specific catalog.
- Add optional React Doctor JSON ingestion for users already running it.
- Independently adopt only small, well-researched rule themes where official React or Web APIs provide a clear correctness contract.
- Copy its validation process, not its heuristics.

### 2. Official React Hooks/Compiler rules and ESLint React

The installed `eslint-plugin-react-hooks` exposes a `recommended-latest` set including:

- `rules-of-hooks`
- `exhaustive-deps`
- `static-components`
- `use-memo`
- `preserve-manual-memoization`
- `immutability`
- `globals`
- `refs`
- `set-state-in-effect`
- `set-state-in-render`
- `error-boundaries`
- `purity`
- `unsupported-syntax`
- compiler configuration and gating checks

This is the most immediate React improvement because the dependency already exists and the rules are maintained with React itself.

ESLint React adds useful focused families:

- Web API leak checks for event listeners, fetches, intervals, timeouts, and observers;
- unstable context values and default props;
- duplicate/missing keys and nested component declarations;
- dangerous DOM APIs, iframe sandboxing, unsafe target blank, invalid void-element children, and unknown DOM properties;
- React Server Component boundaries.

Recommended use:

- Introduce a versioned managed React ruleset rather than silently expanding the current one.
- Start React Compiler diagnostics as `warn` or profile-required evidence until a real-project precision pass is complete.
- Keep style and naming rules out of the managed comparable profile.
- Preserve project custom ESLint output separately from the lens-managed profile.

### 3. jsx-a11y

The plugin supplies mature JSX checks for:

- alternative text and accessible names;
- ARIA properties, roles, and required attributes;
- keyboard support and focusability;
- labels and controls;
- headings, language, media captions, iframe titles, and landmark semantics;
- invalid positive `tabIndex`, autofocus, access keys, and distracting elements.

Recommended use:

- Add a managed accessibility adapter and label its findings `tool-rule`, not heuristic.
- Keep existing structural heuristics as fallback evidence when the plugin cannot run.
- Add optional axe JSON ingestion later for runtime-only concerns such as computed names, contrast, focus order, and rendered state.
- Never report missing runtime accessibility evidence as zero issues.

### 4. Knip

Knip's issue model is substantially richer than the current cleanup pass. It distinguishes unused files, dependencies, dev dependencies, optional peers, unlisted dependencies, unlisted binaries, unresolved imports, exports, namespace exports, types, enum members, namespace members, duplicate exports, catalog entries/references, and cycles.

Its main accuracy advantage is ecosystem modeling: the reviewed tree contains roughly 185 plugin directories for framework, build, test, documentation, code generation, and deployment conventions. It also understands workspaces, production mode, package manifests, entry files, source maps, and dependency placement.

Recommended use:

- Add an optional Knip JSON adapter to `quality.cleanup`.
- Normalize Knip issue types into stable lens rule IDs while retaining original tool/rule/version fields.
- Use Knip as authoritative tool evidence only when its run is complete; retain built-in cleanup as explainable fallback and cross-check evidence.
- Represent disagreements rather than deleting one result silently. Reconcile only rules with equivalent semantics and configuration scope: `confirmed` and `disagreed` are comparable outcomes, while `not_comparable`, `excluded_by_tool`, and `unavailable` describe candidates Knip did not evaluate equivalently.
- Resolve script commands through declared package `bin` metadata, follow declaration-surface type references, and collapse re-exports to canonical declarations before cross-checking. These are usage semantics, not suppression cases.
- Add workspace identity to findings before claiming monorepo support.
- Import Knip configuration hints as remediation suggestions, not automatic suppressions.

### 5. Fallow

The earlier Fallow comparison led to audit, baselines, actions, config schemas, framework adapters, and CI improvements. Current Fallow adds several further lessons:

- semantic analysis refines only existing syntactic candidates and follows exact declaration identity;
- unresolved semantics never become proof of safety;
- outcomes use explicit states such as confirmed used, contract preserved, no static references, unresolved, and abstained;
- stable reason codes explain dynamic imports, decorators, framework contracts, virtual files, and incomplete project selection;
- base and head are compared only under compatible analysis identities;
- output roots use discriminators and independently versioned envelopes;
- TypeScript consumer contracts are generated from JSON Schema;
- public smoke projects and public config corpora expose framework false positives;
- benchmarks are sharded by affected subsystem;
- cache/session reuse is tested as an observable behavior.

Recommended use:

- Add semantic decision and abstention fields to cleanup and dependency findings.
- Add an `analysis_identity` that includes ruleset, compiler/API version, config closure, framework adapter versions, and integration versions.
- Refuse a regression comparison when base and head analysis identities are incompatible; fall back to syntax-only stable keys with a warning where possible.
- Generate consumer TypeScript types from artifact schemas.
- Build a small pinned public-project conformance lane before adding more heuristics.

### 6. SonarJS

SonarJS demonstrates useful finding semantics:

- primary and secondary locations for multi-site problems;
- remediation effort/cost separate from severity;
- certainty or confidence on rules where static evidence varies;
- quick fixes with bounded edits;
- cognitive and cyclomatic complexity as different metrics;
- coverage-aware CRAP-style prioritization;
- test-quality checks such as missing assertions and un-awaited async assertions;
- security issues represented as source-to-sink flows rather than isolated regex hits.

Recommended use:

- Extend findings with source ranges and `related_locations`.
- Add `estimated_effort` only as prioritization metadata; do not convert effort into severity.
- Add `fix_group_id` so agents do not create duplicate work items.
- Ingest SARIF code flows and related locations without flattening them.
- Add CRAP only after branch coverage is available; complexity alone must remain review evidence.
- Do not copy SonarJS source because of its license.

### 7. Betterer and type-coverage

Betterer generalizes incremental adoption: arbitrary tests save a baseline and CI rejects regressions while allowing gradual improvement. Type Coverage applies a similar idea specifically to unresolved or `any`-typed code and supports details, per-file checks, history, changed files, caching, and stale ignore detection.

Recommended use:

- Add per-file `typed_symbols`, `untyped_symbols`, and `type_coverage_percent` to `type_health.json`.
- Separate explicit `any`, inferred `any`, error types, `unknown`, assertions, and unresolved symbols.
- Support configured project and changed-file floors rather than a universal percentage.
- Track a ratchet baseline that may stay equal or improve but cannot silently worsen.
- Detect stale type-coverage suppressions if inline suppression support is added.
- Keep typed lint for unsafe behavior: a coverage percentage alone cannot determine correctness.

### 8. publint, Are The Types Wrong, and API Extractor

These tools answer different library questions:

- `publint`: is the packed package internally consistent, are files published, and are `exports`/`imports` conditions valid and ordered correctly?
- Are The Types Wrong: do implementation and declaration files resolve consistently under Node and bundler module-resolution modes?
- API Extractor: did the public declaration surface change, does it leak forgotten exports, and are release/documentation policies satisfied?

Recommended use:

- Add a `library` profile and `quality.package_health` artifact.
- Run checks against the packed package, not only the source tree.
- Treat missing files, broken exports, failed declaration emit, and required-resolution failures as deterministic blockers for libraries.
- Keep API documentation and release-tag policies opt-in because they are organizational conventions.
- Record resolution mode and entrypoint on every package finding.
- Preserve API report diffs separately from dead-export findings.

### 9. import-x, dependency-cruiser, and architecture tools

The current dependency graph is a good base. Import-focused tools highlight missing dimensions:

- unresolved and self imports;
- imports not declared in the correct manifest;
- deprecated dependency APIs;
- restricted paths and internal module access;
- mutable exports and duplicate imports;
- type-only dependency placement;
- workspace/package boundary ownership.

Recommended use:

- Add manifest ownership and workspace identity to graph edges.
- Distinguish source, test, type-only, dynamic, optional, and side-effect dependency usage.
- Add deprecated-package/API evidence only when sourced from package metadata or a standards-based rule.
- Keep configured architecture rules separate from universal correctness rules.

### 10. Biome, Oxlint, CodeQL, and Semgrep

Biome and Oxlint show the value of fast local lint engines and LSP/editor integration. CodeQL and Semgrep show why security evidence should preserve tool-native confidence, severity, fingerprints, and data-flow paths.

Recommended use:

- Define a lint-engine adapter contract rather than binding all future rules to ESLint.
- Prefer stable JSON or SARIF ingestion over bundling every analyzer.
- Add generic SARIF ingestion before adding custom CodeQL or Semgrep parsers.
- Preserve source/sink flows, partial fingerprints, fixes, and automation details.
- Keep security artifacts and dispositions separate from maintainability scoring.

## Prioritized roadmap

### P0 — Improve React evidence with dependencies already present

Create `tsrqlens-react-recommended-v2` and run the official React Hooks/Compiler recommended rules in a managed, read-only configuration.

Initial disposition proposal:

| Rule family | Initial disposition |
| --- | --- |
| Rules of Hooks | `block` when React evidence is required |
| Exhaustive dependencies | `warn` |
| State update during render | `block` after corpus validation |
| Refs, immutability, globals, purity | `warn` initially; promote individually with evidence |
| Static components and error boundaries | `warn` |
| State update in effect | `review` initially because valid synchronization cases exist |
| Memoization/compiler optimization rules | `review` unless React Compiler is proven enabled |
| Unsupported compiler syntax | `info` or `review` |

Acceptance criteria:

- rules are capability/version gated;
- parser or plugin failure makes React evidence incomplete;
- findings retain upstream rule IDs and rule-set version;
- tests cover aliased imports, shadowed names, tests/stories, and React Compiler on/off;
- the existing v1 ruleset remains selectable for compatibility.

### P0 — Add standards-based accessibility evidence

Add `eslint-plugin-jsx-a11y` through the existing temporary ESLint mechanism or a generalized lint adapter.

Acceptance criteria:

- plugin findings are distinguishable from regex heuristics;
- component/attribute mappings are configurable;
- unavailable plugin evidence is explicit;
- the React profile can require static accessibility evidence;
- runtime accessibility remains a separate optional capability.

### P0 — Establish a rule-quality harness before expanding rules

Add a repository-owned rule contract and validation process inspired by React Doctor and Fallow:

1. one-sentence behavior and runtime rationale;
2. authoritative source links;
3. positive examples;
4. false-positive traps;
5. syntax/scope/path/type-aware precision declaration;
6. explicit in-scope and out-of-scope behavior;
7. valid, invalid, unavailable, and malformed fixtures;
8. confirmed false-positive regression corpus;
9. verdict-preserving source rewrites;
10. real-project before/after comparison for promoted blockers.

No new built-in heuristic should become a default blocker without this evidence.

### P1 — Add a Knip-backed cleanup adapter

Extend `quality.cleanup` rather than creating a competing dead-code task.

Proposed additions:

- tool status for Knip;
- workspace and package fields;
- issue types for unlisted dependencies/binaries, optional peers, enum/namespace members, catalogs, and unresolved imports;
- semantic decision fields (`confirmed`, `disagreed`, `not-comparable`, `excluded-by-tool`, `abstained`, `unavailable`);
- stable mapping from Knip issue types to lens rule IDs.

The adapter should never run `--fix`.

### P1 — Add type coverage and ratcheting

Extend `quality.type_health` with per-file and project type-coverage summaries. Use the existing TypeScript Program where practical; otherwise ingest `type-coverage --json-output`.

Do not conflate these measures:

- explicit `any` annotations;
- inferred `any`;
- unresolved/error types;
- safe `unknown`;
- assertions/non-null assertions;
- unsafe operations already reported by typescript-eslint.

### P1 — Deliver the existing correctness-strength roadmap

Implement coverage and mutation ingestion already proposed in `docs/typescript-quality-roadmap.md`:

- Istanbul JSON and LCOV first;
- branch coverage and changed-line mapping;
- Stryker mutation reports;
- CRAP as coverage-aware review prioritization;
- explicit passed, failed, skipped, timed-out, malformed, and unavailable states.

### P1 — Add library/package health

Add `library` profile plus `quality.package_health` using:

1. declaration emit;
2. `npm pack --json` or package-manager-equivalent packed contents;
3. publint;
4. Are The Types Wrong;
5. optional API Extractor/API report input.

The implementation should use adapters and normalized output rather than reimplement package-resolution matrices.

### P1 — Enrich the finding contract

Add schema-first optional fields:

```ts
type RelatedLocation = {
  file: string;
  start_line: number;
  start_column?: number;
  end_line?: number;
  end_column?: number;
  role: "source" | "sink" | "cause" | "related" | "duplicate" | "fix-site";
  message?: string;
};

type SemanticDecision =
  | "confirmed"
  | "contract-preserved"
  | "disagreed"
  | "unresolved"
  | "abstained"
  | "unavailable";
```

Also add:

- primary end line/column;
- `related_locations`;
- `fix_group_id`;
- `estimated_effort`;
- `semantic_decision` and stable `reason_code`;
- `analysis_identity` at artifact level.

### P1 — Add generic SARIF ingestion

Support SARIF 2.1 before tool-specific security integrations.

Preserve:

- original tool and rule metadata;
- level, rank, and security severity;
- partial fingerprints;
- related locations and code flows;
- fixes without applying them;
- invocation failures and incomplete notifications.

### P2 — Real workspace and project-reference support

Move from a single-root model to explicit workspace units:

- discover npm/pnpm/Yarn workspaces;
- load multiple tsconfigs and references;
- assign each file and manifest to a workspace;
- model public versus private workspace packages;
- preserve cross-workspace edges;
- permit per-workspace framework adapters and policy overrides;
- aggregate without hiding incomplete child analyses.

### P2 — Real incremental caching and scheduling

Adopt the safe caching patterns seen in React Doctor, Betterer, and Fallow:

- content hashes rather than timestamp-only identity;
- config, lockfile, manifest, tool version, and ruleset fingerprints;
- dependency fingerprints for cross-file checks;
- no caching of partial, timed-out, or malformed runs;
- deterministic output independent of worker completion order;
- size-balanced work scheduling;
- separate cold and warm benchmarks.

### P2 — Runtime React evidence

Add adapters for runtime evidence rather than attempting a browser profiler immediately:

- React Profiler/DevTools trace summaries;
- axe results;
- bundle analyzer and size-limit reports;
- render-count or interaction-cost input;
- optional React Doctor trace ingestion.

Static absence must never be interpreted as good runtime performance.

### P2 — Editor and agent surfaces

Once findings have ranges, related locations, stable IDs, and safe actions:

- expose a small MCP server for catalog, measure, audit, explain, and context;
- add LSP diagnostics/code actions or a VS Code adapter;
- provide an installable agent skill containing the rule catalog and fix protocol;
- support GitHub/GitLab review envelopes and annotations;
- ensure CI conclusion is based on policy, not whether inline comments were selected.

## Recommended first implementation sequence

The highest return sequence is:

1. **Managed React ruleset v2** using the already-installed official React plugin.
2. **Rule-quality harness** with confirmed false-positive and true-positive fixtures.
3. **jsx-a11y adapter** and clear separation from fallback heuristics.
4. **Knip adapter** for cleanup and dependency hygiene.
5. **Finding ranges, related locations, fix groups, and analysis identity.**
6. **Type coverage**, then **coverage/mutation ingestion**.
7. **Library package-health profile**.
8. **Generic SARIF ingestion**.
9. **Workspace/project-reference model**.
10. **Reusable cache and editor/agent surfaces**.

This order strengthens correctness and confidence before broadening the product surface.

## What not to copy

- Do not adopt hundreds of rules merely to increase catalog size.
- Do not treat visual taste, naming style, or generic complexity thresholds as universal blockers.
- Do not merge security, correctness, accessibility, and maintainability into one opaque score.
- Do not claim dead code is proven when framework registration, reflection, dynamic imports, or external consumers remain unresolved.
- Do not silently compare base and head runs produced by different rule/compiler/config identities.
- Do not cache incomplete analyses.
- Do not run upstream fixers against measured projects during `measure` or `audit`.
- Do not bundle every integration as a required dependency; prefer optional executables and report ingestion.
- Do not copy source from repositories whose licenses are incompatible with this project.

## Success measures

Track improvements by evidence quality rather than raw finding count:

- blocker precision on a manually adjudicated corpus;
- false-positive rate per rule;
- abstention and unavailable rates;
- introduced-versus-inherited attribution accuracy;
- percentage of findings with stable locations and actionable remediation;
- cold and warm runtime by project size;
- cache hit rate with byte-identical output checks;
- framework/workspace conformance pass rate;
- malformed and unavailable integration behavior;
- number of stale suppressions removed;
- changed-branch coverage and mutation survivors where configured.

A useful checker is not the one that emits the most findings. It is the one whose evidence a reviewer can trust, whose uncertainty is explicit, and whose output leads to safe action.
