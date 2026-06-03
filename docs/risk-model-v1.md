# ts-react-quality-lens Risk Model v1

Model id: `tsrqlens.architecture_risk`
Version: `1`
Calibration: `v1-static-analysis`

This model separates raw measurement facts from derived risk scores. Producers keep emitting task-specific records such as hotspot, dependency, type-health, locality, and React findings. The architecture map combines those records into portable category scores and records the model id, version, and calibration that produced them.

## Thresholds

| Classification | Score |
| --- | --- |
| `ok` / `low` | `< 35` |
| `warning` / `medium` | `35-69` |
| `bad` / `high` | `>= 70` |

## Category Scores

Per-module architecture map nodes expose these derived scores:

| Field | Inputs | Unknown when |
| --- | --- | --- |
| `maintainability_risk` | `hotspots.json` | Hotspot artifact is missing or stale. |
| `correctness_risk` | `correctness_review.json` test mapping and execution status | Correctness artifact is missing or stale. |
| `architectural_risk` | `dependency_health.json`, `leverage_metrics.json`, large-module penalty | Dependency artifact is missing or stale. |
| `change_risk` | `locality_metrics.json` with churn, defect-keyword commits, and co-change | Locality artifact is missing or stale. |
| `performance_risk` | `react_health.json` render/component heuristics plus optional bundle/render inputs | React-health artifact is missing or stale. |
| `quality_risk` | `ts_escape_hatches.json`, `type_health.json` | Both quality input artifacts are missing or stale. |

`total_score` is a weighted average of the category scores and is `null` when any required category is unknown. The compatibility field `risk_score` remains numeric and uses the highest known category score so existing dashboards can still sort partially known nodes.

## Weights

Architecture-map total-score category weights:

| Category | Weight |
| --- | ---: |
| `maintainability` | 1 |
| `correctness` | 1 |
| `architecture` | 1 |
| `change` | 1 |
| `performance` | 0.5 |
| `quality` | 1 |

Hotspot scoring weights are centralized in `src/risk-model.ts`:

| Signal | Weight |
| --- | ---: |
| File line count | 0.3 |
| File branch count | 2 |
| File import count | 2 |
| Function complexity | 8 |
| Function nesting depth | 5 |
| Function line count | 0.4 |
| Function JSX density | 2 |
| Function JSX conditionals | 6 |

## Unknown Inputs

Every produced artifact includes `provenance.source_set_hash`, a hash of the measured source file set and contents. `map.architecture` compares that hash with the current project before consuming input artifacts:

| Status | Meaning |
| --- | --- |
| `available` | Artifact exists and its `source_set_hash` matches current source. |
| `missing` | Artifact is absent. |
| `stale` | Artifact exists but has no matching `source_set_hash`. |

Missing or stale inputs are recorded in `summary.artifact_status`, `confidence.missing_input`, `confidence.stale_input`, and each affected node's `unknown_metrics`.

## Implemented Input Signals

`dependency_health.json` now includes layer classifications, `layer_violation` records, and `unsupported_pattern` records for unresolved aliases, wildcard re-exports, and non-literal dynamic imports. TypeScript `paths` aliases are resolved through the loaded `tsconfig` when possible.

`locality_metrics.json` keeps raw change facts alongside the derived score: commit count, contributor count, defect-keyword commit count, and top co-change partners.

`clones.json` includes both token-based groups and `engine: "ast"` structural clone groups built from normalized TypeScript AST function bodies.

`map.architecture` accepts optional project-supplied performance inputs through `performance_inputs.bundle_stats` and `performance_inputs.render_costs`. Missing performance input files are optional and do not make the map incomplete.
