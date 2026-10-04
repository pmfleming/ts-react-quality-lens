import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuditArtifact } from "../src/types.js";

test("real CLI formats preserve policy, finding identity, evidence and required failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-reporting-e2e-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/main.ts"), "export const wrong: number = 'text';\nexport function read(value: any) { return value.name; }\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"reporting","type":"module","private":true}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["src"] }));
    const config = path.join(root, "lens.json");
    fs.writeFileSync(config, JSON.stringify({ source_roots: ["src"], cache: { enabled: false },
      test_command: 'node -e "process.exit(1)"', policy: { required_checks: ["compiler", "typed-lint", "tests"] },
      sarif_inputs: [{ path: "missing.sarif", required: true }],
      suppressions: [{ kind: "compiler_diagnostic", reason: "compiler regression" },
        { kind: "test_execution_failed", reason: "test regression" },
        { kind: "sarif_invocation_incomplete", reason: "input regression" }] }));
    const invoke = (format: string) => {
      const result = childProcess.spawnSync(process.execPath, [path.resolve("dist/bin/ts-react-quality-lens.js"),
        "audit", "--config", config, "--gate", "all", "--format", format], { encoding: "utf8", timeout: 90000, maxBuffer: 20 * 1024 * 1024 });
      assert.equal(result.status, 1, result.stderr);
      assert.ok(!result.error, String(result.error));
      return result.stdout;
    };
    const audit = JSON.parse(invoke("json")) as AuditArtifact;
    const sarif = JSON.parse(invoke("sarif"));
    const markdown = invoke("markdown");
    const summary = JSON.parse(invoke("summary"));
    assert.equal(audit.summary.verdict, "fail");
    assert.equal(audit.summary.complete, false);
    assert.equal(summary.audit.verdict, audit.summary.verdict);
    assert.match(summary.full_evidence, /audit.json/);
    const run = sarif.runs[0];
    assert.equal(run.properties.verdict, audit.summary.verdict);
    assert.equal(run.invocations[0].executionSuccessful, audit.summary.complete);
    assert.deepEqual(run.properties.audit_summary, audit.summary);
    assert.deepEqual(run.properties.reconciliation, audit.reconciliation);
    assert.ok(run.properties.evidence_contract.some((entry: { kind: string }) => entry.kind === "run"));
    const findings = run.results.filter((entry: { partialFingerprints?: object }) => entry.partialFingerprints);
    assert.equal(findings.length, audit.findings.length);
    for (const finding of audit.findings) {
      const result = findings.find((entry: { partialFingerprints: Record<string, string> }) => entry.partialFingerprints["tsrqlens/finding-id"] === finding.id);
      assert.ok(result, finding.id);
      assert.deepEqual(result.properties.native_finding, finding, "all native evidence survives export without adapter classification");
      assert.equal(result.ruleId, finding.rule_id);
      assert.equal(result.properties.disposition, finding.disposition);
      assert.equal(result.properties.evidence_kind, finding.evidence_kind);
      assert.equal(result.properties.confidence, finding.finding_confidence);
      assert.equal(result.properties.semantic_decision, finding.semantic_decision);
      assert.equal(Boolean(result.suppressions), Boolean(finding.suppressed));
      assert.ok(markdown.includes(`id=${finding.id};`), finding.id);
    }
    assert.equal(run.results.filter((entry: { properties: { suppressible?: boolean } }) => entry.properties.suppressible === false).length, 2);
    assert.ok(markdown.includes("Required SARIF"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
