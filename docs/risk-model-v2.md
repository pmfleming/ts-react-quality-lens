# Risk model v2 (superseded)

The current implementation uses **risk model v3**, not v2. See the [current risk-model reference](risk-model-v3.md) for formulas, input freshness, and test-evidence semantics.

This path is retained for existing links. V2 used model ID `tsrqlens.architecture_risk`, version `2`, and calibration label `v2-multi-complexity-static-analysis`.

Key changes in v3:

- Lint and cleanup records now contribute to quality risk.
- Correctness risk requires an explicit passed/failed suite result; discovery alone is unknown.
- Only compiler-resolved direct test imports count as direct test evidence, not filename or type-only associations.
- Map prerequisites refresh every declared input while preserving compatible current test execution.

Risk model versions are separate from artifact schema versions. Read `map.json`'s `meta.risk_model_version` and analysis identity rather than inferring scoring behavior from the filename or schema version alone.
