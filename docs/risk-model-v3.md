# Architecture risk model v3

Source: [`src/risk-model.ts`](../src/risk-model.ts), [`src/measures/architecture.ts`](../src/measures/architecture.ts).

- Model ID: `tsrqlens.architecture_risk`
- Version: `3`
- Calibration label: `v3-explicit-test-evidence-and-quality-inputs`

These are static prioritization scores, not empirically calibrated defect probabilities. Findings' `block`, `warn`, `review`, and `info` dispositions govern audits independently of map scores.

## Changes from v2

V3 includes lint and cleanup in quality risk, requires explicit suite execution for correctness risk, and distinguishes direct compiler-resolved test imports from filename/type-only associations. A test catalog alone no longer implies tested correctness. The map's prerequisites include all eleven declared input tasks, and current passed/failed execution is preserved rather than overwritten by an unnecessary catalog refresh.

## Map inputs and freshness

`measure map.architecture` refreshes these prerequisites once per run:

`quality.hotspots`, `quality.clones`, `quality.escape_hatches`, `quality.type_health`, `quality.lint`, `quality.dependency_health`, `correctness.catalog`, `quality.locality_dynamic`, `quality.locality_leverage`, `quality.react_health`, and `quality.cleanup`.

It does not run tests. Existing `correctness.all` evidence can substitute for a catalog refresh only if both review and catalog match the current identity and task-input hashes. Running `measure correctness.catalog` explicitly still replaces executed evidence with `not_run`. CLI `measure all` runs tests before the map.

| Status | Meaning |
| --- | --- |
| `available` | Artifact exists, its analysis identity matches, and its `provenance.input_set_hash` matches the current hash for its task. |
| `missing` | No readable artifact. |
| `stale` | Artifact exists but fails identity/task-input matching. |

`source_set_hash` covers source, tests, and additional compiler inputs. Task-input hashing adds analysis identity and task-specific inputs; locality also includes Git history. Matching only source contents is not sufficient. Optional performance records bypass artifact identity matching because they are parsed directly from current input files.

Statuses appear in `summary.artifact_status`; missing required/stale inputs also appear in confidence. **Freshness is not tool completeness:** an available artifact can still report unavailable/partial upstream tooling. Inspect its own confidence/tool status.

## Per-module category scores

A record contributes when it is unsuppressed and project-scoped, matches `file`, or includes the module in `files`. Its contribution is the larger of its numeric score and severity conversion (`low: 20`, `medium: 45`, `high: 75`). No matching records in an available artifact contributes zero. Clone groups themselves are not scored here; clone-derived records are.

| Field | Computation / unknown behavior |
| --- | --- |
| `maintainability_risk` | Maximum of hotspot and clone record scores. Uses whichever inputs are available; null only when neither contributes a known score. |
| `correctness_risk` | Failed suite: 85 for every module. Passed suite with a direct test import: 0; passed suite without one: 40. Missing, stale, not-run, or unknown execution: null. |
| `architectural_risk` | Maximum of dependency and available leverage scores, plus large-module penalty, clamped to 0–100. Null if dependency input is missing/stale; unavailable leverage is ignored by this category. |
| `change_risk` | Maximum locality record score; null if locality input is missing/stale. |
| `performance_risk` | Maximum React-health and optional bundle/render record scores; null if React-health input is missing/stale. This includes static React signals, not just measured performance. |
| `quality_risk` | Maximum of escape-hatch, type-health, lint, and cleanup record scores. Null only when none of those inputs contributes a known score. |

Composite categories can remain numeric while `unknown_metrics` lists missing/stale contributing inputs. Correctness also reports `correctness:no_measured_evidence` when execution is not known. A non-null category does not imply all evidence is complete.

`category_scores` exposes these values under `maintainability`, `correctness`, `architecture`, `change`, `performance`, and `quality`; `render_performance` aliases `performance`.

### Test evidence is not coverage

Test mapping records high-confidence `direct-import` and `type-only-import` associations and low-confidence `filename` associations. Only direct value imports (including supported literal `require`/dynamic imports) count toward map test evidence and locality's direct test mapping. Filename similarity and type-only imports do not. The suite status does not establish that each test file ran or that every imported branch was executed. Artifacts report `coverage_status: "not_collected"`; catalog entries retain `status: "not_run"` with a separate `suite_status`.

## Total and compatibility scores

`total_score` is the rounded weighted average:

| Category | Weight |
| --- | ---: |
| Maintainability | 1 |
| Correctness | 1 |
| Architecture | 1 |
| Change | 1 |
| Performance | 0.5 |
| Quality | 1 |

It is null if any category is null. `classification` is then `unknown`. Otherwise classification is `ok` below 35, `warning` from 35 to below 70, and `bad` from 70 upward.

The compatibility `risk_score` is always numeric: the maximum known category score, or zero when none is known. `risk` uses low/medium/high at the same 35/70 thresholds. Do not interpret a numeric compatibility score as complete evidence.

Large-module penalty: `min(24, round(max(0, lines - 300) × 0.08))`.

Optional bundle score: `min(100, round(bytes / 10000))`. Optional render score: `min(100, round(ms / 2))`. Missing or unusable optional performance files do not make the map incomplete. SARIF, package health, and runtime artifacts are not map prerequisites or direct scoring inputs.

## Hotspot weights

| Signal | Weight |
| --- | ---: |
| File lines / branches / imports | 0.3 / 2 / 2 |
| Function cyclomatic / cognitive complexity | 4 / 2 |
| Function log10 Halstead effort | 1 |
| Function nesting / lines | 5 / 0.4 |
| Function JSX density / conditionals | 2 / 6 |

Function metrics stop at nested function boundaries. Nesting counts control structures, not both the structure and its block. Raw measurements remain available alongside scores for consumers that need their own prioritization.
