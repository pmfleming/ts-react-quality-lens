# Imported execution evidence

Configure `coverage_report` with a JSON envelope:

```json
{
  "format": "lcov",
  "provenance": { "source_set_hash": "sha256:..." },
  "producer": { "name": "vitest", "version": "..." },
  "data": "SF:src/example.ts\nDA:1,1\nend_of_record\n"
}
```

Use the input identity from the measurement of the **same source/build that produced the report**; never stamp an old report with a new source hash. `format` also accepts `istanbul` (coverage-final object) and `v8` (result/scripts/functions/ranges object). V8 offsets must address the original discovered JavaScript, not transpiled TypeScript. Source-mapped LCOV/Istanbul is required for transpiled files. Unknown files and malformed ranges are rejected.

`measure testing.coverage` writes `execution_coverage.json`. Function/changed-line values use observed lines only; missing observations remain unknown. Function risk is advisory (`CC² × uncovered³ + CC`), not a verdict. This is neither branch coverage nor proof of behavior.

Runtime inputs may use the same `provenance` and `producer` fields, plus a nonempty `environment` object and the existing native report in `data`. Legacy reports remain visible but are incomplete, low-confidence review observations, not current-source blocking findings. A source hash links evidence to input; it is not a cryptographic attestation of truthful execution.
