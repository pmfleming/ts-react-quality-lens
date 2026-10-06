import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { auditVerdict, requiredEvidenceReasons, requiredVerificationFailures } from "../src/audit/findings.js";
import { writeArtifact } from "../src/writer.js";
import type { PolicyCheck } from "../src/types.js";

test("every required native verification channel survives removal of all ordinary findings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-verification-matrix-"));
  try {
    const config = loadConfig(path.join(root, "lens.json"));
    config.testCommand = "declared-test-command";
    const base = { schema_version: "0.3.0", task_id: "fixture", project: {}, provenance: {}, confidence: {}, summary: {}, records: [] };
    const cases: Record<PolicyCheck, { file: string; success: object; failure: object }> = {
      compiler: { file: "type_health.json", success: { confidence: { typescript_program_loaded: true } }, failure: { confidence: { typescript_program_loaded: false } } },
      "typed-lint": { file: "lint_health.json", success: { tool_status: { typed_eslint: { ran: true, complete: true } } }, failure: { tool_status: { typed_eslint: { ran: false, complete: false } } } },
      "react-hooks": { file: "react_health.json", success: { tool_status: { eslint_react_hooks: { ran: true, complete: true } } }, failure: { tool_status: { eslint_react_hooks: { ran: false, complete: false } } } },
      tests: { file: "correctness_review.json", success: { execution: { status: "passed", command: config.testCommand } }, failure: { execution: { status: "unknown", reason: "timeout" } } },
      package: { file: "package_health.json", success: { summary: { complete: true } }, failure: { summary: { complete: false } } },
    };
    for (const [check, item] of Object.entries(cases)) {
      config.policy.requiredChecks = [check as PolicyCheck];
      config.outputDir = path.join(root, check);
      for (const unavailable of [null, {}, item.failure]) {
        if (unavailable !== null) writeArtifact(config, item.file, { ...base, ...unavailable });
        assert.equal(auditVerdict([], requiredEvidenceReasons(config), requiredVerificationFailures(config)), "incomplete", `${check}: ${JSON.stringify(unavailable)}`);
      }
      writeArtifact(config, item.file, { ...base, ...item.success });
      assert.equal(auditVerdict([], requiredEvidenceReasons(config), requiredVerificationFailures(config)), "incomplete", `${check}: legacy success is not verified current evidence`);
    }
    config.policy.requiredChecks = ["compiler", "tests"];
    writeArtifact(config, "type_health.json", { ...base, confidence: { typescript_program_loaded: true }, records: [
      { id: "failure", kind: "compiler_diagnostic", disposition: "block", suppressed: true },
    ] });
    writeArtifact(config, "correctness_review.json", { ...base, execution: { status: "failed", command: config.testCommand, exit_code: 1, stdout: "", stderr: "" } });
    assert.equal(auditVerdict([], [], requiredVerificationFailures(config)), "fail");
    config.policy.requiredChecks = [];
    for (const kind of ["sarif", "runtime", "coverage"] as const) {
      config.outputDir = path.join(root, `imported-${kind}`);
      config.sarifInputs = kind === "sarif" ? [{ name: "scanner", path: path.join(root, "required.sarif"), required: true }] : [];
      config.runtimeInputs.axe = kind === "runtime" ? path.join(root, "axe.json") : null;
      config.coverageReport = kind === "coverage" ? path.join(root, "coverage.json") : null;
      const file = { sarif: "sarif_findings.json", runtime: "runtime_health.json", coverage: "execution_coverage.json" }[kind];
      for (const status of [null, "incomplete", "not_configured"]) {
        if (status !== null) writeArtifact(config, file, { ...base, summary: { status } });
        assert.equal(auditVerdict([], requiredEvidenceReasons(config)), "incomplete", `${kind}: ${status}`);
      }
      const success = kind === "sarif" ? { tool_status: { scanner: { path: config.sarifInputs[0]!.path, required: true, available: true, ran: true, complete: true } } } : { summary: { status: "complete" } };
      writeArtifact(config, file, { ...base, ...success });
      assert.equal(auditVerdict([], requiredEvidenceReasons(config)), "incomplete", `${kind}: legacy success is not verified current evidence`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
