import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ts from "typescript";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/measure-runner.js";
import { analysisIdentity, compilerProvenance } from "../src/provenance.js";
import { readArtifact } from "../src/writer.js";
import { featureSupport, reactSupport } from "../src/react-support.js";
import { discoverWorkspaces } from "../src/workspaces.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { collectFindings } from "../src/audit/findings.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-modern-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "modern", type: "module" }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a: string = 123;\n");
  fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), JSON.stringify({
    source_roots: ["src"], cache: { enabled: false }, cleanup: { knip: false }, policy: { required_checks: [] },
  }));
  try { run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("compiler artifacts identify their engine and preserve distinct diagnostic identities across movement", () => fixture((root, config) => {
  const source = "export const first: string = 123;\nexport const second: string = 123;\n";
  fs.writeFileSync(path.join(root, "src/a.ts"), source);
  runMeasure(config, "quality.type_health", "test");
  const artifact = readArtifact(config, "type_health.json");
  assert.ok(artifact);
  const compilers = compilerProvenance();
  assert.equal(compilers.analysis.version, ts.version);
  assert.equal(compilers.native.analysis_executed, false);
  assert.deepEqual(artifact.provenance.compilers, compilers);
  assert.equal(artifact.tool_status?.compiler_api?.loaded, true);
  const diagnostic = artifact.records?.find((record) => record.rule_id === "typescript/TS2322");
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.compiler, compilers.analysis);
  assert.equal(analysisIdentity(config).compiler_api_version, ts.version);
  assert.equal(analysisIdentity(config).integration_versions.typescript_native, compilers.native.version);
  const schema: unknown = JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema as object);
  assert.ok(validate(artifact), JSON.stringify(validate.errors));
  const diagnosticIds = (value: typeof artifact) => value.records?.filter((record) => record.diagnostic_code === 2322).map((record) => record.id);
  const originalIds = diagnosticIds(artifact);
  assert.equal(originalIds?.length, 2);
  assert.equal(new Set(originalIds).size, 2);
  fs.writeFileSync(path.join(root, "src/a.ts"), `// moved diagnostics\n\n${source}`);
  runMeasure(config, "quality.type_health", "test moved diagnostics");
  const moved = readArtifact(config, "type_health.json");
  assert.ok(moved);
  assert.deepEqual(diagnosticIds(moved), originalIds);
}));

test("React capabilities require support throughout the declared range", () => {
  for (const [range, expected] of [
    ["^18.3.0", "unsupported"], ["^19.2.0", "mixed"], ["^19.3.0", "supported"],
    ["^18 || ^19", "mixed"], [">=19.3 <20", "supported"], ["19.3.0", "supported"],
    ["19.3.0-canary-abc", "unknown"], ["catalog:", "unknown"], ["latest", "unknown"],
    ["garbage", "unknown"], ["", "unknown"], [">=20 <19", "unknown"], [null, "unknown"],
  ] as const) assert.equal(featureSupport(range, "19.3.0"), expected, String(range));
});

test("workspace React guidance respects peer ranges, unknowns, and explicit overrides", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "modern", workspaces: ["packages/*"], dependencies: { react: "^19.3.0" },
  }));
  for (const [name, manifest] of [
    ["library", { peerDependencies: { react: "^18 || ^19" }, devDependencies: { react: "19.3.0" } }],
    ["unknown", {}], ["old", { dependencies: { react: "18.3.0" } }],
  ] as const) {
    fs.mkdirSync(path.join(root, "packages", name), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", name, "package.json"), JSON.stringify({ name, ...manifest }));
  }
  const workspaces = discoverWorkspaces(config).records;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "lens-guidance-output-"));
  let artifact;
  try {
    config.outputDir = output;
    runMeasure(config, "quality.react_health", "test external output");
    artifact = readArtifact(config, "react_health.json");
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
  assert.ok(artifact);
  assert.equal(artifact.tool_status?.eslint_react_hooks?.complete, true);
  const schema: unknown = JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema as object);
  assert.ok(validate(artifact), JSON.stringify(validate.errors));
  const support = artifact.react_support as ReturnType<typeof reactSupport>;
  assert.ok(support.find((item) => item.workspace_id === "modern")?.guidance.some((item) => item.capability === "view-transitions"));
  for (const name of ["library", "unknown", "old"]) {
    assert.deepEqual(support.find((item) => item.workspace_id === name)?.guidance, []);
  }
  assert.equal(support.find((item) => item.workspace_id === "library")?.range_source, "peerDependencies.react");
  config.react.version = "^19.3.0";
  assert.ok(reactSupport(config, workspaces).every((item) => item.guidance.some((advice) => advice.capability === "view-transitions")));
  config.react.version = "catalog:";
  assert.ok(reactSupport(config, workspaces).every((item) => item.guidance.length === 0));
  fs.writeFileSync(config.configPath, JSON.stringify({ react: { version: "^19.3.0" } }));
  assert.equal(loadConfig(config.configPath).react.version, "^19.3.0");
}));

test("invalid compiler configuration retains engine provenance and failed load status", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"invalidOption":true}}');
  runMeasure(config, "quality.type_health", "test");
  const artifact = readArtifact(config, "type_health.json");
  assert.equal(artifact?.tool_status?.compiler_api?.loaded, false);
  assert.equal(artifact?.tool_status?.compiler_api?.version, ts.version);
  assert.ok(artifact?.records?.some((record) => record.rule_id === "typescript/TS5023"));
}));

test("React optimization evidence stays informational through artifact enrichment and audit policy", () => fixture((_root, config) => {
  const rules = ["unsupported-syntax", "incompatible-library", "preserve-manual-memoization", "use-memo", "void-use-memo", "set-state-in-effect"];
  const context = createAnalysisContext(config);
  context.reactHooksLint = () => ({
    available: true, ran: true, complete: true, reason: null, version: "test", ruleset: "recommended-v2",
    messages: [...rules, "rules-of-hooks", "immutability", "config", "future-rule"].map((rule, index) => ({
      file: "src/a.ts", line: index + 1, column: 1, end_line: null, end_column: null,
      rule_id: `react-hooks/${rule}`, severity: "error", message: `Fixture ${rule}`,
    })),
  });
  context.jsxA11yLint = () => ({ available: true, ran: true, complete: true, reason: null, version: "test", messages: [] });
  const result = measureReactHealth(config, "test", context);
  assert.equal(result.summary.optimization_findings, rules.length);
  assert.equal(result.summary.correctness_findings, 2);
  assert.equal(result.summary.configuration_findings, 1);
  assert.equal(result.summary.unclassified_hook_findings, 1);
  for (const required of [true, false]) {
    config.policy.requiredChecks = required ? ["react-hooks"] : [];
    const findings = collectFindings(config, { changedFiles: [], changedLines: new Map(), baselineIds: new Set(), includeAll: true });
    for (const rule of rules) {
      const finding = findings.find((item) => item.rule_id === `react-hooks/${rule}`);
      assert.equal(finding?.react_category, "optimization");
      assert.equal(finding?.disposition, "info");
      assert.equal(finding?.risk, "low");
    }
    assert.equal(findings.find((item) => item.rule_id === "react-hooks/rules-of-hooks")?.disposition, required ? "block" : "review");
    assert.equal(findings.find((item) => item.rule_id === "react-hooks/immutability")?.disposition, required ? "warn" : "review");
    assert.equal(findings.find((item) => item.rule_id === "react-hooks/future-rule")?.disposition, "review");
  }
}));
