import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAudit } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureTypeHealth, measureLint } from "../src/measures/type-quality.js";
import { measurePackageHealth } from "../src/measures/package-health.js";
import { readArtifact, writeArtifact } from "../src/writer.js";
import { validNativeEvidence } from "../src/artifact-evidence.js";
import { validAttwProblems, validPublintMessages } from "../src/producer-payload.js";
import { requiredEvidenceReasons } from "../src/audit/findings.js";
import type { Artifact } from "../src/types.js";

function fixture(run: (root: string, config: ReturnType<typeof loadConfig>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-payload-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/main.ts"), "export const value: number = 1;\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"payload","type":"module"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["src"]}');
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], policy: { required_checks: [] }, cache: { enabled: false } }));
    run(root, loadConfig(path.join(root, "lens.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("native critical payload corruption cannot be repaired by regenerating its wire projection", () => fixture((_root, config) => {
  const context = createAnalysisContext(config);
  const compiler = measureTypeHealth(config, "test", context);
  const lint = measureLint(config, "test", context);
  const pkg = measurePackageHealth(config, "test", context);
  for (const [artifact, mutate] of [
    [compiler, (value: Artifact) => { delete value.diagnostics; }],
    [compiler, (value: Artifact) => { value.tool_status!.compiler_api!.loaded = false; }],
    [lint, (value: Artifact) => { delete value.tool_status!.typed_eslint!.evaluated_files; }],
    [lint, (value: Artifact) => { value.tool_status!.typed_eslint!.ran = false; }],
    [pkg, (value: Artifact) => { value.package_evidence = { publint_messages: [null], attw_problems: [] }; }],
  ] as Array<[Artifact, (value: Artifact) => void]>) {
    const changed = structuredClone(artifact);
    mutate(changed);
    assert.equal(validNativeEvidence(changed, config), false);
    assert.throws(() => writeArtifact(config, "corrupt.json", changed), /native evidence/);
  }
  config.policy.requiredChecks = ["compiler", "typed-lint"];
  assert.deepEqual(requiredEvidenceReasons(config), [], "real completed native producers are positive controls");
  assert.ok((compiler.capabilities as Array<{ capability: string; status: string }>).some((item) => item.capability.endsWith("compiler_api") && item.status === "completed"));
}));

test("malformed package diagnostic lists are not empty successful reports", () => {
  assert.ok(validPublintMessages([]));
  assert.ok(validAttwProblems([]));
  for (const value of [null, {}, [null], [{ code: "X", type: "error", path: 1, args: {} }], [{ code: "X", type: ["error"], path: [], args: {} }]]) assert.equal(validPublintMessages(value), false);
  for (const value of [null, {}, [null], [{ kind: "" }], [{ kind: "X", resolutionKind: 2 }]]) assert.equal(validAttwProblems(value), false);
});

test("audit generation references reject missing, replaced and mutated producer bytes", () => fixture((_root, config) => {
  const audit = runAudit(config, "generation-test", { runTests: false, compareBase: false });
  assert.ok(readArtifact(config, "audit.json"));
  const comparison = (audit.evidence_contract as Array<{ kind: string; status?: string; baseline_run?: string | null }>).find((entry) => entry.kind === "comparison");
  assert.equal(comparison?.status, "unknown");
  assert.equal(comparison?.baseline_run, null);
  const file = path.join(config.outputDir, "lint_health.json");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original + "\n");
  assert.throws(() => readArtifact(config, "audit.json"), /Mixed audit generation/);
  fs.unlinkSync(file);
  assert.throws(() => readArtifact(config, "audit.json"), /Missing audit generation/);
  fs.writeFileSync(file, original);
  assert.ok(readArtifact(config, "audit.json"));
  const changed = structuredClone(audit);
  changed.comparison = { status: "compatible", baseline: null, reasons: [] };
  assert.equal(validNativeEvidence(changed, config), false, "no baseline cannot claim compatibility");
}));
