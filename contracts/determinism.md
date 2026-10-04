# Deterministic evidence boundary v1

Fixed before the MyStarQuest campaign:

- Normalize only `provenance.measured_at`, `provenance.run_id` and that artifact's wire run/finding/measurement run references. Validate native references/projections **before** normalization. Comparison references are not normalized without explicit resolution.
- Object key ordering and top-level finding collections (`records`, `groups`, `findings`, `disagreements`, `unconfirmed`) and `evidence_contract` ordering are non-semantic. Canonicalize these sets, but preserve all contents and all other array ordering, including execution paths and samples.
- A separate top-level `telemetry` channel retains analyzer cache state and exact `tool_status.*.duration_ms` values. The artifact writer moves only declared cache fields (`confidence.analysis_cache_enabled/status`, context-summary `cache_status/reused`) and tool-duration fields there. `observed_inputs` excludes cache state because it is not an evidence prerequisite.
- Do not remove imported runtime `duration_ms`, test output, confidence/completeness, source/config/tool identities, finding identities, provenance compatibility, limitations, engine scope or policy decisions. An unstable field outside the declared boundary is an investigated failure, not permission to widen a recursive ignore filter.

`src/deterministic-evidence.ts` implements this boundary. `test/determinism.test.ts` covers fresh/reused/persisted/no-cache contexts, set ordering, dangling references, and detection of identity/disposition/runtime-measurement changes.

`python3 acceptance/real_project.py PROJECT OUTPUT` runs three cold/warm pairs for app/functions and focused/full-project audit profiles. Cold means empty lens cache and fresh process, not a flushed OS cache. Full-project audits deliberately disable Git-base comparison (`compareBase: false`); they run configured tests, but do not certify change-review compatibility. Functions have no declared test script and are analyzed with explicit compiler/typed-lint requirements, without claiming application tests cover that scope.

Raw snapshots, canonical snapshots, hashes, timings, exact commands and config/lock/analysis identity remain in the external campaign directory. Node peak RSS excludes subprocess peaks. Runtime compatibility, dependency installation and source cleanliness are prerequisites; this is not an independent accuracy/calibration study or O3 budget certificate.
