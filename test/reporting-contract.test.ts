import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { auditSarif } from "../src/sarif-export.js";
import type { AuditArtifact, FindingDisposition } from "../src/types.js";

test("SARIF projects audit decisions without conflating impact, suppression or incomplete execution", () => {
  const cases: Array<{ id: string; disposition: FindingDisposition; severity: string; expected_level: string; suppressed: boolean }> = JSON.parse(fs.readFileSync("contracts/reporting-cases.json", "utf8"));
  const artifact: AuditArtifact = {
    schema_version: "1", task_id: "audit", project: { name: "fixture", root: ".", framework: "none", package_manager: "npm", test_runner: "none" },
    provenance: {}, confidence: { complete: false, partial: true },
    summary: { verdict: "fail", complete: false, incomplete_reasons: ["missing tool"], verification_failures: ["required tests failed"],
      gate: "all", base: null, changed_files: 0, changed_hunks: 0, base_snapshot_available: false, base_snapshot_compatible: null,
      findings: 5, active_findings: 4, introduced_findings: 5, inherited_findings: 0, high_risk_findings: 0, blocking_findings: 1,
      warning_findings: 1, baseline_suppressed: 0, config_suppressed: 1, stale_suppressions: 0 },
    findings: cases.map((item) => ({ ...item, task_id: "test", rule_id: `test/${item.id}`, introduced: true, message: item.id, suppression_reason: "fixture waiver" })),
  };
  const run = auditSarif(artifact).runs[0];
  assert.ok(run);
  assert.equal(run.invocations[0]?.executionSuccessful, false);
  const projections = run.results.map((entry) => ({ id: entry.ruleId, level: entry.level, suppressed: "suppressions" in entry }));
  for (const item of cases) {
    assert.deepEqual(projections.find((entry) => entry.id === `test/${item.id}`),
      { id: `test/${item.id}`, level: item.expected_level, suppressed: item.suppressed });
  }
  assert.deepEqual(projections.find((entry) => entry.id === "tsrqlens/required-verification"),
    { id: "tsrqlens/required-verification", level: "error", suppressed: false });
});
