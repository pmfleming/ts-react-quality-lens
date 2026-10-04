import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfidence, loadConfig } from "../src/config.js";
import { runAudit } from "../src/audit.js";
import { auditVerdict, collectFindings, requiredEvidenceReasons } from "../src/audit/findings.js";
import { measureLint } from "../src/measures/type-quality.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { measureSarif } from "../src/measures/sarif.js";
import { auditSarif } from "../src/sarif-export.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-trust-failure-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "src/main.ts"), "export const answer = 42;\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"trust-probe","private":true}');
    const file = path.join(root, "lens.json");
    fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], cache: { enabled: false }, test_command: null,
      policy: { required_checks: [] }, sarif_inputs: [{ path: "required.sarif", name: "scanner", required: true }],
      suppressions: [{ kind: "sarif_invocation_incomplete", reason: "regression probe" }] }));
    run(root, loadConfig(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("unknown prerequisites and missing compiler configuration cannot certify lint", () => fixture((_root, config) => {
  assert.equal(createConfidence(config, { required_inputs: ["unknown_prerequisite"] }).complete, false);
  const artifact = measureLint(config, "trust-test");
  assert.equal(artifact.tool_status.typed_eslint.ran, false);
  assert.equal(artifact.confidence.complete, false);
  assert.equal(artifact.confidence.partial, true);
  assert.ok(artifact.confidence.missing_input?.includes("typed_eslint_complete"));
  assert.equal(artifact.capabilities[0]?.status, "partial");
}));

test("unavailable Hooks and disabled accessibility do not claim completed semantic checks", () => fixture((_root, config) => {
  const context = createAnalysisContext(config);
  context.reactHooksLint = () => ({ available: false, ran: false, complete: false, reason: "missing executable",
    version: null, ruleset: config.react.ruleset, messages: [] });
  config.accessibility.enabled = false;
  const artifact = measureReactHealth(config, "trust-test", context);
  assert.equal(artifact.confidence.complete, false);
  assert.ok(artifact.confidence.missing_input?.includes("eslint_react_hooks_complete"));
  assert.equal(artifact.tool_status.jsx_a11y.complete, false);
}));

test("required SARIF completeness is independent of suppression, baseline and gate", () => fixture((root, config) => {
  const report = path.join(root, "required.sarif");
  const cases = [null, "not json", JSON.stringify({ version: "2.1.0", runs: [{ invocations: [{ executionSuccessful: false }] }] })];
  for (const content of cases) {
    if (content !== null) fs.writeFileSync(report, content);
    const artifact = measureSarif(config, "trust-test");
    assert.equal(artifact.summary.status, "incomplete");
    for (const baseline of [false, true]) {
      const findings = collectFindings(config, { changedFiles: [], changedLines: new Map(), includeAll: true,
        baselineIds: new Set(baseline ? artifact.records.map((record) => record.id) : []) });
      const active = findings.filter((finding) => !finding.suppressed);
      assert.equal(active.length, 0);
      const reasons = requiredEvidenceReasons(config);
      assert.ok(reasons.some((reason) => reason.includes("Required SARIF")));
      assert.equal(auditVerdict(active, reasons), "incomplete");
    }
  }
  fs.writeFileSync(report, JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "scanner", version: "1" } },
    invocations: [{ executionSuccessful: true }], results: [] }] }));
  measureSarif(config, "trust-test");
  assert.deepEqual(requiredEvidenceReasons(config), [], "a successful required scanner is a positive control");
  fs.unlinkSync(report);
  config.sarifInputs[0]!.required = false;
  measureSarif(config, "trust-test");
  assert.deepEqual(requiredEvidenceReasons(config), [], "optional unavailable evidence does not become globally required");
}));

test("real audit and SARIF cannot hide a suppressed required input failure", () => fixture((_root, config) => {
  for (const gate of ["all", "new-only"] as const) {
    const audit = runAudit(config, "trust-test", { runTests: false, gate });
    assert.equal(audit.summary.verdict, "incomplete");
    assert.equal(audit.summary.complete, false);
    assert.ok(audit.findings.some((finding) => finding.kind === "sarif_invocation_incomplete" && finding.suppressed));
    const run = auditSarif(audit).runs[0]!;
    assert.equal(run.invocations[0]?.executionSuccessful, false);
    assert.equal(run.properties.verdict, "incomplete");
  }
}));
