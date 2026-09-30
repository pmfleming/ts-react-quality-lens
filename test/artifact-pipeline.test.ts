import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { auditVerdict, requiredVerificationFailures } from "../src/audit/findings.js";
import { runMeasure } from "../src/measure-runner.js";
import { readArtifact, writeArtifact } from "../src/writer.js";

test("measurements return the same enriched evidence they publish", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-artifact-pipeline-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = input as number;\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"pipeline"}');
    const file = path.join(root, "ts-react-quality-lens.config.json");
    fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], output_dir: "out" }));
    const config = loadConfig(file);
    const artifact = runMeasure(config, "quality.escape_hatches", "test")[0];
    assert.ok(artifact?.records?.some((record) => record.rule_id && record.actions?.length));
    assert.deepEqual(readArtifact(config, "ts_escape_hatches.json"), JSON.parse(JSON.stringify(artifact)));
    assert.throws(() => writeArtifact(config, "../outside.json", artifact), /filenames/);
    assert.ok(!fs.existsSync(path.join(root, "outside.json")));
    const circular: { self?: unknown } = {}; circular.self = circular;
    assert.throws(() => writeArtifact(config, "invalid.json", circular), /circular/i);
    assert.ok(fs.readdirSync(config.outputDir).every((name) => !name.endsWith(".tmp")));
    config.policy.requiredChecks = ["compiler", "tests"];
    writeArtifact(config, "type_health.json", { ...artifact, records: [{ id: "compiler-error", kind: "compiler_diagnostic", disposition: "block", suppressed: true }] });
    writeArtifact(config, "correctness_review.json", { ...artifact, execution: { status: "failed", command: "test", exit_code: 1, stderr: "", stdout: "" } });
    const failures = requiredVerificationFailures(config);
    assert.equal(failures.length, 2);
    assert.equal(auditVerdict([], [], failures), "fail", "an empty/suppressed finding set cannot certify failed required verification");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
