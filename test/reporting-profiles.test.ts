import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { sourceSetHash } from "../src/provenance.js";
import type { AuditArtifact } from "../src/types.js";

test("real package/React/imported/coverage profiles preserve native evidence in all reporters and both gates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-reporter-profiles-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    const source = "declare function useState(value: number): unknown;\nexport function Panel({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }\nexport function unsafe(value: any) { return value.name; }\n";
    fs.writeFileSync(path.join(root, "src/main.ts"), source);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "reporter-profiles", version: "1.0.0", type: "module",
      files: ["src"], exports: { types: "./missing.d.ts", default: "./missing.js" } }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" }, include: ["src"] }));
    const file = path.join(root, "lens.json");
    const settings = { source_roots: ["src"], cache: { enabled: false }, package_health: { enabled: true },
      test_command: 'node -e "process.exit(0)"', policy: { required_checks: ["compiler", "typed-lint", "react-hooks", "tests", "package"] },
      sarif_inputs: [{ name: "scanner", path: "scanner.sarif", required: true }], runtime_inputs: { axe: "axe.json" }, coverage_report: "coverage.json" };
    fs.writeFileSync(file, JSON.stringify(settings));
    const config = loadConfig(file);
    const hash = sourceSetHash(createAnalysisContext(config).project());
    fs.writeFileSync(path.join(root, "scanner.sarif"), JSON.stringify({ version: "2.1.0", runs: [{
      tool: { driver: { name: "scanner", version: "1" } }, invocations: [{ executionSuccessful: true }], results: [
        { ruleId: "observed-error", level: "error", message: { text: "upstream error with detail" }, properties: { exact: "retained" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "src/main.ts" }, region: { startLine: 2 } } }] },
      ],
    }] }));
    fs.writeFileSync(path.join(root, "axe.json"), JSON.stringify({ provenance: { source_set_hash: hash }, producer: { name: "axe", version: "4" },
      environment: { scenario: "fixture" }, data: { violations: [{ id: "critical-observation", impact: "critical", nodes: [{ target: ["#button"], html: "<button/>" }] }] } }));
    fs.writeFileSync(path.join(root, "coverage.json"), JSON.stringify({ provenance: { source_set_hash: hash }, producer: { name: "fixture", version: "1" },
      format: "lcov", data: "TN:\nSF:src/main.ts\nDA:2,1\nDA:3,1\nend_of_record\n" }));
    const invoke = (format: string, gate: string) => {
      const result = childProcess.spawnSync(process.execPath, [path.resolve("dist/bin/ts-react-quality-lens.js"), "audit", "--config", file,
        "--format", format, "--gate", gate], { encoding: "utf8", timeout: 120000, maxBuffer: 30 * 1024 * 1024 });
      assert.ok(!result.error, String(result.error));
      assert.ok(result.stdout.trim(), result.stderr);
      return result;
    };
    let baseline: string[] = [];
    for (const gate of ["all", "new-only"]) {
      if (gate === "new-only") {
        fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({ findings: baseline }));
        fs.writeFileSync(file, JSON.stringify({ ...settings, audit: { baseline: "baseline.json" }, suppressions: [
          { kind: "runtime_accessibility_violation", reason: "reporter control" },
        ] }));
      }
      const json = invoke("json", gate);
      const audit = JSON.parse(json.stdout) as AuditArtifact;
      const sarifResult = invoke("sarif", gate);
      const sarif = JSON.parse(sarifResult.stdout).runs[0];
      const markdownResult = invoke("markdown", gate);
      const native = JSON.parse(markdownResult.stdout.split("## Complete native evidence")[1]!.split("```json\n")[1]!.split("\n```")[0]!);
      const summaryResult = invoke("summary", gate);
      assert.equal(sarifResult.status, json.status);
      assert.equal(markdownResult.status, json.status);
      assert.equal(summaryResult.status, json.status);
      assert.deepEqual(JSON.parse(summaryResult.stdout).audit, audit.summary);
      assert.deepEqual(sarif.properties.audit_summary, audit.summary);
      assert.deepEqual(sarif.properties.applicability, audit.applicability);
      assert.deepEqual(native.findings, audit.findings);
      assert.deepEqual(native.applicability, audit.applicability);
      const exported = sarif.results.filter((item: { partialFingerprints?: object }) => item.partialFingerprints);
      assert.deepEqual(exported.map((item: { properties: { native_finding: unknown } }) => item.properties.native_finding), audit.findings);
      for (const source of ["eslint-plugin-react-hooks", "typescript-eslint", "publint", "scanner", "axe"]) {
        assert.ok(audit.findings.some((finding) => finding.source === source), `producer missing: ${source}; ${JSON.stringify(audit.summary)}`);
      }
      assert.ok(!audit.summary.incomplete_reasons.some((reason) => /runtime|coverage/.test(reason)), JSON.stringify(audit.summary));
      if (gate === "all") {
        assert.equal(audit.summary.verdict, "fail");
        baseline = audit.findings.map((finding) => finding.id);
      } else {
        assert.ok(audit.findings.some((finding) => finding.suppressed));
        assert.ok(audit.summary.baseline_suppressed > 0);
      }
    }
    // Malformed configured evidence remains non-passing after ordinary input diagnostics are waived.
    fs.writeFileSync(path.join(root, "axe.json"), "{}");
    fs.writeFileSync(path.join(root, "coverage.json"), "{}");
    fs.writeFileSync(path.join(root, "scanner.sarif"), "{}");
    fs.writeFileSync(file, JSON.stringify({ ...settings, audit: { baseline: "baseline.json" }, suppressions: [
      { kind: "runtime_input_incomplete", reason: "must not waive execution" },
      { kind: "sarif_invocation_incomplete", reason: "must not waive execution" },
    ] }));
    for (const format of ["json", "sarif", "markdown", "summary"]) {
      const result = invoke(format, "new-only");
      assert.equal(result.status, 1, format);
      for (const reason of ["Configured runtime evidence", "Configured execution coverage", "Required SARIF input"]) {
        assert.ok(result.stdout.includes(reason), `${format}: ${reason}`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
