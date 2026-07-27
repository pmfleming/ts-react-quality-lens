# Applying TypeScript Quality Research to `ts-react-quality-lens`

## Implementation status

- **Phase 1 completed for schema 0.2.0:** evidence dispositions, policy-based audit decisions, incomplete verdicts, compiler/test blockers, corrected `unknown` and TypeScript-directive semantics, and a documented rule catalog.
- **Phase 2 completed for schema 0.2.0:** expanded compiler-option posture, managed type-aware typescript-eslint integration, `quality.lint`, and `lint_health.json`.
- **Phases 3-6 remain planned:** correctness-strength reports, package checks, security/accessibility inputs, and empirical calibration.

## Goal

Turn the research into an evidence-based quality model that can answer three different questions without conflating them:

1. **Will this code compile and behave correctly?**
2. **Does this change meet a credible TypeScript contribution standard?**
3. **Where is maintainability or architectural risk increasing?**

The lens should not claim that one opaque score represents code quality. It should expose authoritative failures, heuristic risks, trends, and unavailable evidence separately.

## Product principles

1. **Authoritative evidence before heuristics.** Compiler diagnostics, failed tests, lint violations, invalid package exports, and confirmed security findings have priority over size or complexity proxies.
2. **Only deterministic findings fail by default.** Complexity, duplication, churn, broad types, and missing test proximity remain review signals unless a project explicitly gates them.
3. **Unknown is not pass.** Missing required tools, malformed reports, stale artifacts, and unavailable type information must be visible in the verdict.
4. **Changed-code adoption is the default.** Existing debt can be baselined; new deterministic violations are blocked.
5. **TypeScript is not runtime validation.** The lens should recognize validation at untrusted boundaries rather than assuming static types make external data safe.
6. **Profiles are contextual.** Applications, React applications, and published libraries need different checks.
7. **Do not mutate the measured project.** Integrations must run read-only and report tool version, configuration, duration, and failure reason.
8. **Every finding must be explainable.** It needs a stable rule id, evidence source, location where possible, confidence, disposition, and remediation.

## Current baseline

The project already has strong foundations:

- TypeScript compiler diagnostics and effective compiler-option summaries.
- Type and escape-hatch analysis.
- Complexity, clone, dependency, cleanup, React, test-locality, and history measurements.
- Optional ESLint React Hooks, jscpd, and dependency-cruiser integrations.
- Stable artifacts with provenance and confidence.
- Changed-hunk audit, base-snapshot comparison, baselines, suppressions, and actions.
- A versioned architecture risk model.

The main gaps are:

- The audit verdict can currently be driven by heuristic scores as if they were confirmed failures.
- All `unknown` annotations are reported as `unknown_without_narrowing`, even though `unknown` is recommended and narrowing requires use-site analysis.
- `@ts-ignore` and `@ts-expect-error` currently receive the same treatment.
- Type assertions are counted structurally rather than evaluated with type-aware rules.
- Only React Hooks rules use ESLint; there is no general type-aware lint task.
- Test execution is known, but coverage, mutation strength, and detailed test results are not.
- Published-package exports and declarations are not validated with library-specific tools.
- Security, accessibility, and external CI evidence are not represented consistently.
- Risk-model weights have static calibration rather than validation against a labelled corpus.

## Target evidence model

Extend findings so policy does not have to infer meaning from a numeric score:

```ts
type FindingDisposition = "block" | "warn" | "review" | "info";
type EvidenceKind = "diagnostic" | "tool-rule" | "test" | "metric" | "heuristic";

type QualityFinding = {
  id: string;
  rule_id: string;
  source: string;
  evidence_kind: EvidenceKind;
  disposition: FindingDisposition;
  severity: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  file?: string;
  line?: number;
  message: string;
  actions?: IssueAction[];
};
```

Existing `score` and `risk` fields can remain for compatibility, but they must no longer determine gateability by themselves.

Audit should calculate its verdict from policy and `disposition`:

- `fail`: at least one active `block` finding.
- `warn`: no blockers, but active `warn` findings exist.
- `pass`: all profile-required evidence ran and no active block/warn finding exists.
- `incomplete`: required evidence is missing, stale, timed out, or malformed.

Adding `incomplete` is a contract change and should ship with a schema-version migration note. An alternative is to retain the current verdict enum and add a required `complete: false` decision field, but consumers must never display that state as a clean pass.

## Proposed quality profiles

Add a policy section to configuration after defining it in the config schema:

- `baseline`: compiler diagnostics and configured tests.
- `recommended`: `baseline`, effective `strict`, managed type-aware lint, formatting evidence when configured, and changed-code gating.
- `strict`: `recommended` plus additional compiler safety options and stricter unsafe-operation rules.
- `library`: `recommended` plus declaration, exports, API, and package-resolution checks.
- `react`: `recommended` plus Hooks and accessibility checks.

React and library capabilities can be auto-detected, but users must be able to override them. Profiles should define required evidence and default dispositions, not just threshold numbers.

An illustrative future configuration is:

```jsonc
{
  "policy": {
    "profile": "recommended",
    "capabilities": ["react"],
    "required_checks": ["compiler", "typed-lint", "tests"]
  },
  "quality_inputs": {
    "coverage": "coverage/coverage-final.json",
    "mutation": "reports/mutation/mutation.json",
    "sarif": ["reports/codeql.sarif"]
  },
  "audit": {
    "gate": "new-only"
  }
}
```

The final names should be settled schema-first and added to `ts-react-quality-lens.config.schema.json` before implementation.

## Delivery plan

### Phase 1 — Correct the semantics and gate model

**Priority: P0**

1. Add `rule_id`, `evidence_kind`, `disposition`, and finding-level confidence to the artifact contract.
2. Make audit policy-driven instead of failing on any record with `score >= 70`.
3. Define which existing rules are authoritative, warnings, review signals, or informational.
4. Stop reporting every `unknown` keyword as unsafe. Report unsafe use through type-aware analysis in Phase 2.
5. Split TypeScript suppressions:
   - `@ts-ignore`: warning/block candidate.
   - `@ts-expect-error`: allowed when narrow and documented; report unnecessary directives from compiler/lint evidence.
   - `@ts-nocheck`: high-risk warning/block candidate.
6. Keep raw type assertions as a trend metric; reserve blocker status for type-aware unsafe assertions.
7. Ensure missing required evidence produces an incomplete decision rather than a pass.
8. Publish a rule catalog documenting default disposition, rationale, limitations, and remediation.

**Primary files**

- `src/types.ts`
- `src/audit.ts`
- `src/actions.ts`
- `src/scoring.ts`
- `src/risk-model.ts`
- `ts-react-quality-lens.schema.json`
- `docs/risk-model-v1.md`

**Acceptance criteria**

- A normal `unknown` annotation produces no unsafe-use finding.
- An existing high complexity heuristic cannot fail the recommended profile by itself.
- A compiler error on changed code fails the audit.
- A required tool timeout cannot produce `pass`.
- Old artifacts remain readable or receive a documented schema migration.

### Phase 2 — Add standards-based TypeScript and ESLint analysis

**Priority: P0**

1. Expand effective compiler-option analysis to cover:
   - `strict`
   - `noImplicitAny`
   - `strictNullChecks`
   - `noUncheckedIndexedAccess`
   - `exactOptionalPropertyTypes`
   - `noImplicitOverride`
   - `noImplicitReturns`
   - `noFallthroughCasesInSwitch`
   - `forceConsistentCasingInFileNames`
   - module-resolution and declaration settings relevant to the project type
2. Distinguish effective inherited options from explicitly configured options where possible.
3. Add a managed, read-only type-aware typescript-eslint integration using project service/type information.
4. Start with high-signal rules, especially unsafe assignment, calls, arguments, returns, member access, floating promises, misused promises, unnecessary assertions, and ban-ts-comment.
5. Keep project ESLint results separate from the lens-managed comparable profile. Do not silently treat a project’s custom style policy as a universal standard.
6. Add a new `quality.lint` task and `lint_health.json` rather than mixing all lint results into React health.
7. Record tool version, ruleset/profile version, duration, availability, and parser/type-information status.

**Primary files**

- `src/integrations.ts`
- `src/analysis-context.ts`
- `src/types.ts`
- `src/measures/quality.ts`
- `src/measures/registry.ts`
- `src/tasks.ts`
- `package.json`

**Acceptance criteria**

- Unsafe use of an `unknown` value is detected, while declaration of `unknown` is not penalized.
- Explicit `any` and unsafe propagated `any` are reported separately.
- Typed lint can run against extended tsconfigs and project references.
- Tool absence and parser failure are represented as unavailable evidence, not zero findings.
- The integration works on Linux and Windows and never uses `--fix`.

### Phase 3 — Measure correctness strength

**Priority: P1**

1. Parse common coverage formats rather than requiring the lens to own the test runner:
   - Istanbul `coverage-final.json`
   - LCOV
   - V8-compatible summaries where practical
2. Add line, function, and branch coverage by file, with branch coverage preferred for changed-code review.
3. Ingest Stryker mutation reports and expose mutation score and surviving mutants by file.
4. Improve test-to-source mapping using imports and coverage evidence rather than filename similarity alone.
5. Distinguish test execution states: passed, failed, skipped, not run, timed out, and malformed result.
6. Add `correctness.coverage` and `correctness.mutation` tasks, or one versioned `correctness.evidence` artifact if a shared contract is clearer.
7. Do not impose a universal coverage percentage. Let profiles gate changed branches or project-configured thresholds.

**Primary files**

- `src/correctness.ts`
- `src/measures/correctness.ts`
- `src/config.ts`
- `src/types.ts`
- `src/tasks.ts`
- config and artifact schemas

**Acceptance criteria**

- Coverage and mutation reports preserve source paths across Windows, POSIX, and monorepo layouts.
- A failed configured test command is a blocker.
- Missing optional coverage is unknown/optional; missing profile-required coverage is incomplete.
- Coverage percentages cannot hide an explicitly failed test.
- Changed-file records show uncovered changed branches when location data is available.

### Phase 4 — Add published-library quality checks

**Priority: P1 for libraries; P2 otherwise**

1. Detect published libraries from `package.json` exports, main/module/types fields, workspace metadata, and configured public APIs.
2. Integrate or ingest results from:
   - `publint`
   - Are The Types Wrong (`attw`)
   - API Extractor
   - `tsd`, `expect-type`, or dtslint test evidence
3. Validate declaration emit and package exports under relevant ESM/CJS and Node resolution modes.
4. Track public API changes separately from dead-export heuristics.
5. Add `quality.package_health` and `package_health.json`.
6. Make package checks required only for the library profile or explicit configuration.

**Primary files**

- `src/integrations.ts`
- `src/entrypoints.ts`
- `src/package-root.ts`
- new `src/measures/package.ts`
- `src/measures/registry.ts`
- `src/tasks.ts`

**Acceptance criteria**

- Invalid `exports` or declaration resolution produces a deterministic finding.
- Valid dual-package and ESM-only fixtures pass.
- A configured public export is not reported as dead merely because it has no internal importer.
- Package-tool absence is visible without affecting non-library profiles.

### Phase 5 — Add security, accessibility, and performance evidence

**Priority: P2**

1. Add generic SARIF ingestion for CodeQL, Semgrep, and compatible tools.
2. Keep vulnerability severity and confidence from the source tool; do not translate all security findings through maintainability scores.
3. Replace or supplement regex accessibility checks with `eslint-plugin-jsx-a11y` and optional axe results.
4. Continue supporting bundle/render inputs and add common bundle formats or size-limit reports.
5. Add `quality.security`; extend `quality.react_health` and performance artifacts without combining their raw severities.
6. Gate only confirmed high-confidence security findings by default; keep heuristic security patterns as review findings.

**Acceptance criteria**

- SARIF locations and fingerprints remain stable enough for changed-code baselines.
- Accessibility tooling results are distinguishable from built-in heuristics.
- Missing browser/runtime evidence does not become a false zero.
- External report parsers reject malformed or path-escaping input safely.

### Phase 6 — Calibrate and validate the risk model

**Priority: P2, but required before presenting scores as predictive**

1. Build a legally redistributable benchmark corpus covering:
   - strict and non-strict TypeScript
   - React applications
   - Node services and CLIs
   - published libraries
   - monorepos and project references
   - ESM, CJS, and mixed package layouts
2. Label a set of findings manually as true issue, useful review signal, or false positive.
3. Compare heuristic signals with defect fixes, review outcomes, churn, and test failures where history is available.
4. Measure precision separately for blockers and review findings.
5. Version calibrated weights as risk model v2; never silently change v1 output.
6. Add runtime and memory benchmarks for each optional integration.
7. Introduce reusable parser/checker caches only after profiling shows where they help.

**Acceptance criteria**

- Every default blocker has high measured precision on the labelled corpus.
- False-positive rates are reported by rule rather than hidden in an aggregate score.
- Risk-model changes include before/after fixture output and migration notes.
- Performance budgets are based on measured project sizes and enforced in CI.

## Proposed catalog evolution

Keep all current tasks and add new tasks additively:

| Task | Artifact | Initial phase |
| --- | --- | --- |
| `quality.lint` | `lint_health.json` | 2 |
| `correctness.coverage` | `coverage.json` | 3 |
| `correctness.mutation` | `mutation.json` | 3 |
| `quality.package_health` | `package_health.json` | 4 |
| `quality.security` | `security.json` | 5 |

New artifacts should first appear as standalone evidence. They should affect `map.architecture` only after dispositions and calibration are stable. This prevents a new tool integration from unexpectedly changing every module’s aggregate score.

## Testing strategy

Add focused fixtures for:

- `unknown` with safe and unsafe narrowing.
- `any` propagation and unsafe type assertions.
- Each TypeScript suppression directive.
- Extended tsconfigs, project references, and strict flags enabled individually.
- Existing project ESLint flat configs and projects with no ESLint installation.
- Missing, timed-out, failed, and malformed tool executions.
- LCOV, Istanbul, Stryker, SARIF, publint, and attw reports.
- ESM-only, CJS, dual-package, conditional exports, and broken declaration packages.
- Monorepo paths and Windows separators.
- Changed-hunk attribution for findings with and without source locations.

For every integration, test four states: available and successful, available with findings, available but failed, and unavailable.

## Definition of done for each new measurement

A measurement is complete only when it has:

- A stable task id and documented artifact.
- Schema validation and schema-drift coverage.
- Stable finding fingerprints.
- Provenance, tool version, duration, and confidence.
- Clear missing/stale/malformed input behaviour.
- Default disposition and profile policy.
- Machine-actionable remediation where practical.
- Golden and negative fixtures.
- Changed-code audit coverage.
- Linux and Windows CI coverage.
- README and rule-catalog documentation.

## Recommended implementation order

1. **Phase 1:** fix semantics and prevent heuristics from acting as blockers.
2. **Phase 2:** add effective tsconfig policy and type-aware ESLint.
3. **Phase 3:** ingest coverage and mutation evidence.
4. **Phase 4:** add library/package correctness.
5. **Phase 5:** add SARIF, stronger accessibility, and performance inputs.
6. **Phase 6:** calibrate the risk model and optimize performance.

The first releasable milestone should include Phases 1 and 2. It will provide the largest immediate improvement: fewer misleading findings, a defensible contribution-ready gate, and standards-based TypeScript analysis without discarding the lens’s existing architectural measurements.
