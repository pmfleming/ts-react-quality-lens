import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ts from "typescript";
import { complexityForNode, cognitiveComplexityForNode, halsteadMetricsForNode, maxNestingDepthForNode } from "../src/ast-metrics.js";
import { loadConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { runMeasure } from "../src/measure-runner.js";
import { runAudit } from "../src/audit.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { projectContext } from "../src/context.js";
import type { Artifact, ScoredRecord } from "../src/types.js";

const repoRoot = path.resolve();
const fixtureConfig = path.join(repoRoot, "examples/basic/ts-react-quality-lens.config.json");
const goldenConfig = path.join(repoRoot, "test/fixtures/golden/ts-react-quality-lens.config.json");
type ToolArtifact = Artifact & { tool_status: NonNullable<Artifact["tool_status"]> };
type SummaryArtifact<T extends Record<string, unknown>> = Artifact & { summary: T };

function requiredToolStatus(artifact: ToolArtifact, name: string) {
  const status = artifact.tool_status[name];
  assert.ok(status, `Expected ${name} tool status`);
  return status;
}

test("complexity metrics exclude nested functions and count control nesting once", () => {
  const source = ts.createSourceFile(
    "metrics.ts",
    "function outer(flag: boolean) { if (flag) { const inner = () => { if (flag) return 1; return 0; }; return inner; } return () => 0; }",
    ts.ScriptTarget.Latest,
    true,
  );
  const outer = source.statements.find(ts.isFunctionDeclaration);
  assert.ok(outer);
  assert.equal(complexityForNode(outer), 2);
  assert.equal(cognitiveComplexityForNode(outer), 1);
  assert.equal(maxNestingDepthForNode(outer), 1);
  assert.ok(halsteadMetricsForNode(outer).effort > 0);
});

test("measure all writes MVP artifacts", () => {
  const config = loadConfig(fixtureConfig);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  const results = runMeasure(config, "all", "test measure all");
  const taskIds = new Set(results.map((result) => result.task_id));
  assert.ok(taskIds.has("quality.hotspots"));
  assert.ok(taskIds.has("quality.escape_hatches"));
  assert.ok(taskIds.has("quality.type_health"));
  assert.ok(taskIds.has("quality.dependency_health"));
  assert.ok(taskIds.has("correctness.catalog"));
  assert.ok(taskIds.has("map.architecture"));

  const validateArtifact = artifactValidator();
  for (const artifact of [
    "hotspots.json",
    "clones.json",
    "ts_escape_hatches.json",
    "type_health.json",
    "lint_health.json",
    "dependency_health.json",
    "cleanup.json",
    "package_health.json",
    "sarif_findings.json",
    "runtime_health.json",
    "correctness_review.json",
    "test_catalog.json",
    "locality_metrics.json",
    "leverage_metrics.json",
    "react_health.json",
    "map.json",
  ]) {
    const artifactPath = path.join(config.outputDir, artifact);
    assert.ok(fs.existsSync(artifactPath), `${artifact} should exist`);
    const value = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    assert.ok(
      validateArtifact(value),
      `${artifact} should satisfy artifact schema: ${validateArtifact.errors?.map((error: { message?: string }) => error.message).join(", ")}`,
    );
  }

  const hotspots = JSON.parse(fs.readFileSync(path.join(config.outputDir, "hotspots.json"), "utf8")) as Artifact;
  assert.match(hotspots.analysis_identity?.id ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof hotspots.analysis_identity?.config_closure_hash, "string");
  assert.ok(Number(hotspots.summary.source_lines) > 0);
  assert.equal(hotspots.summary.functions, hotspots.records?.filter((record) => record.kind !== "file").length);
  assert.ok(hotspots.records?.every((record) => record.evidence_kind === "metric" && record.message?.includes("lines")));
  assert.ok(hotspots.records?.some((record) =>
    record.kind !== "file" &&
    record.signals?.some((signal) => signal.kind === "cyclomatic_complexity") &&
    record.signals?.some((signal) => signal.kind === "cognitive_complexity") &&
    record.signals?.some((signal) => signal.kind === "halstead_effort")
  ));

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8")) as Artifact & {
    meta?: { risk_model_id?: string; risk_model_version?: number };
    nodes: Array<{
      risk_model_id?: string;
      risk_model_version?: number;
      total_score?: number | null;
      unknown_metrics?: string[];
    }>;
    edges: Array<{ from: string; source?: unknown; line?: unknown }>;
    summary: { artifact_status?: Record<string, string>; unknown_metric_nodes?: number };
  };
  assert.ok(map.nodes.length > 0);
  assert.ok(map.edges.length > 0);
  assert.equal(map.meta?.risk_model_id, "tsrqlens.architecture_risk");
  assert.equal(map.meta?.risk_model_version, 3);
  assert.ok(map.nodes.every((node) => node.risk_model_id === "tsrqlens.architecture_risk"));
  assert.ok(map.nodes.every((node) => node.risk_model_version === 3));
  assert.ok(map.nodes.every((node) => Array.isArray(node.unknown_metrics)));
  assert.ok(Object.entries(map.summary.artifact_status ?? {}).every(([name, status]) => name === "performance" || status === "available"));
  assert.equal(map.summary.unknown_metric_nodes, 0);

  const typeHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "type_health.json"), "utf8")) as Artifact;
  assert.equal(typeHealth.confidence.typescript_compiler_api_available, true);
  assert.equal(typeHealth.confidence.typescript_program_loaded, true);
  assert.ok(typeHealth.records?.some((record: ScoredRecord) => record.source === "typescript-compiler-api"));
  assert.equal(typeof typeHealth.summary.type_coverage_percent, "number");
  assert.ok(Array.isArray((typeHealth.type_coverage as { files?: unknown[] } | undefined)?.files));

  const lintHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "lint_health.json"), "utf8")) as ToolArtifact;
  const typedEslint = requiredToolStatus(lintHealth, "typed_eslint");
  assert.equal(typedEslint.available, true);
  assert.equal(typedEslint.ran, true);
  assert.ok(lintHealth.records?.every((record) => record.source === "typescript-eslint"));

  const dependencyHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8")) as ToolArtifact & {
    graph: { edges: Array<{ from: string; source?: unknown; line?: unknown }> };
  };
  const dependencyCruiser = requiredToolStatus(dependencyHealth, "dependency_cruiser");
  assert.equal(dependencyCruiser.available, true);
  assert.equal(dependencyCruiser.ran, true);
  const dependencyEdges = dependencyHealth.graph.edges as Array<{ from: string; source?: unknown; line?: unknown }>;
  assert.ok(dependencyEdges.every((edge) => !edge.from.includes(".test")));
  assert.ok(dependencyEdges.some((edge) => edge.source === "dependency-cruiser" && edge.line !== null));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ jscpd_clone_groups: number; duplication_records: number }>;
  const jscpd = requiredToolStatus(clones, "jscpd");
  assert.equal(jscpd.available, true);
  assert.equal(jscpd.ran, true);
  assert.ok(clones.summary.jscpd_clone_groups > 0);
  assert.ok(clones.summary.duplication_records > 0);
  assert.ok(clones.records?.some((record) => record.kind === "duplication_pressure"));
  const cloneGroups = clones.groups as Array<{ instances: Array<{ file: string }> }>;
  assert.ok(cloneGroups.flatMap((group) => group.instances).every((instance) => !instance.file.startsWith("..")));

  const reactHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ hook_lint_findings: number }>;
  const reactHooks = requiredToolStatus(reactHealth, "eslint_react_hooks");
  const jsxA11y = requiredToolStatus(reactHealth, "jsx_a11y");
  assert.equal(reactHooks.available, true);
  assert.equal(reactHooks.ran, true);
  assert.equal(jsxA11y.available, true);
  assert.equal(jsxA11y.ran, true);
  assert.equal(jsxA11y.complete, true);
  assert.ok(!reactHealth.records?.some((record) => record.source === "jsx-a11y-heuristic"));
  assert.ok(reactHealth.summary.hook_lint_findings > 0);
  assert.ok(reactHealth.records?.some((record: ScoredRecord) => record.source === "framework-adapter"));

  const correctness = JSON.parse(fs.readFileSync(path.join(config.outputDir, "correctness_review.json"), "utf8"));
  assert.equal(correctness.summary.execution_status, "passed");
  assert.ok(correctness.tests.some((testRecord: { source_mapping?: string[] }) => testRecord.source_mapping?.includes("src/format.ts")));

  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as ToolArtifact;
  const knip = requiredToolStatus(cleanup, "knip");
  assert.equal(knip.available, true);
  assert.equal(knip.ran, true);
  assert.equal(knip.complete, true);
  assert.ok(cleanup.records?.some((record) => record.source === "knip"));
  assert.ok(cleanup.records?.every((record) => typeof record.reason_code === "string"));
  assert.ok(cleanup.records?.every((record) => typeof record.estimated_effort === "number"));
  assert.ok(cleanup.records?.some((record) =>
    record.id === "cleanup:unused-export:src/format:formatPercent" &&
    record.semantic_decision === "confirmed",
  ));
  assert.ok(cleanup.disagreements?.some((record) => record.semantic_decision === "disagreed"));
  assert.ok(cleanup.records?.some((record) => Array.isArray(record.actions) && record.actions.length > 0));

  assert.ok(fs.existsSync(path.join(config.outputDir, ".cache", "analysis-v2.json")));
});

test("config accepts JSONC comments and rejects unknown keys through schema-backed validation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-config-`));
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.jsonc");
  fs.writeFileSync(
    configPath,
    `{
      // JSONC comments are accepted for user configs.
      "project_name": "jsonc-fixture",
      "project_root": ${JSON.stringify(repoRoot)},
      "source_roots": ["src"],
      "output_dir": "target/jsonc-analysis"
    }`,
    "utf8",
  );
  assert.equal(loadConfig(configPath).projectName, "jsonc-fixture");

  const badConfigPath = path.join(tempDir, "bad.config.json");
  fs.writeFileSync(badConfigPath, `{"project_name": "bad", "surprise": true}`, "utf8");
  assert.throws(() => loadConfig(badConfigPath), /Unknown config key "surprise"/);
  fs.writeFileSync(badConfigPath, '{"typed_lint":{"mode":"guess"}}', "utf8");
  assert.throws(() => loadConfig(badConfigPath), /Invalid config/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("unknown is not treated as an escape hatch and TypeScript directives are distinguished", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-unknown-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "unknown-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "index.ts"),
    [
      "export function narrow(value: unknown): string {",
      '  return typeof value === "string" ? value : "";',
      "}",
      "// @ts-expect-error -- intentional negative type case",
      'const expectedNumber: number = "not-a-number";',
      "// @ts-ignore",
      'const ignoredNumber: number = "not-a-number";',
      "void expectedNumber;",
      "void ignoredNumber;",
    ].join("\n"),
    "utf8",
  );
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ project_root: ".", source_roots: ["src"], output_dir: "target/analysis", tsconfig: "tsconfig.json" }),
    "utf8",
  );

  const config = loadConfig(configPath);
  runMeasure(config, "quality.escape_hatches", "test unknown semantics");
  const artifact = JSON.parse(fs.readFileSync(path.join(config.outputDir, "ts_escape_hatches.json"), "utf8")) as Artifact;
  assert.ok(!artifact.records?.some((record) => record.kind === "unknown_without_narrowing"));
  assert.equal(artifact.records?.find((record) => record.kind === "ts_expect_error")?.disposition, "info");
  assert.equal(artifact.records?.find((record) => record.kind === "ts_ignore")?.disposition, "warn");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("type coverage distinguishes unsafe any, error types, and safe unknown with ratcheting", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-type-coverage-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "type-coverage-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: false, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "coverage.ts"),
    [
      "export function explicit(value: any) { return value; }",
      "export function inferred(value) { return value; }",
      "export function safe(value: unknown): string { return typeof value === 'string' ? value : ''; }",
      "export const broken = missingSymbol;",
      "",
    ].join("\n"),
    "utf8",
  );
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      type_coverage: { minimum_percent: 100, per_file_minimum_percent: 100 },
    }),
    "utf8",
  );

  const config = loadConfig(configPath);
  const [artifact] = runMeasure(config, "quality.type_health", "test type coverage") as [Artifact];
  const coverage = artifact.type_coverage as {
    summary: { type_coverage_percent: number };
    files: Array<{ file: string; explicit_any: number; inferred_any: number; error_types: number; unknown: number }>;
  };
  const file = coverage.files.find((item) => item.file === "src/coverage.ts");
  assert.ok(coverage.summary.type_coverage_percent < 100);
  assert.ok(file && file.explicit_any > 0);
  assert.ok(file && file.inferred_any > 0);
  assert.ok(file && file.error_types > 0);
  assert.ok(file && file.unknown > 0);
  assert.ok(artifact.records?.some((record) => record.reason === "configured_project_floor"));
  assert.ok(artifact.records?.some((record) => record.reason === "configured_file_floor"));

  const baselinePath = path.join(tempDir, "type-health-baseline.json");
  const baseline = structuredClone(artifact) as Artifact & {
    type_coverage: { summary: { type_coverage_percent: number }; files: Array<{ type_coverage_percent: number }> };
  };
  baseline.type_coverage.summary.type_coverage_percent = 100;
  for (const baselineFile of baseline.type_coverage.files) baselineFile.type_coverage_percent = 100;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline), "utf8");
  config.typeCoverage.minimumPercent = null;
  config.typeCoverage.perFileMinimumPercent = null;
  config.typeCoverage.baseline = baselinePath;
  const [ratcheted] = runMeasure(config, "quality.type_health", "test type coverage ratchet") as [Artifact];
  assert.ok(ratcheted.records?.some((record) => record.reason === "ratchet_regression"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("init writes a starter schema-backed config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-init-`));
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  await withSilencedConsole(() => runCli(["init", "--config", configPath]));

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(raw.$schema, "./ts-react-quality-lens.config.schema.json");
  assert.equal(raw.policy.profile, "recommended");
  assert.equal(raw.react.ruleset, "recommended-v2");
  assert.equal(raw.accessibility.enabled, true);
  assert.equal(raw.cleanup.knip, true);
  assert.equal(raw.audit.gate, "new-only");
  await assert.rejects(() => runCli(["init", "--config", configPath]), /Config already exists/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("library profile validates declaration emit, packed files, and type resolution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-package-health-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "package-health-fixture",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" } },
      engines: { node: ">=20" },
      license: "MIT",
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const answer: number = 42;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "dist", "index.js"), "export const answer = 42;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "dist", "index.d.ts"), "export declare const answer: number;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", declaration: true, rootDir: "src" },
      include: ["src"],
    }),
    "utf8",
  );
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      policy: { profile: "library" },
    }),
    "utf8",
  );

  const config = loadConfig(configPath);
  assert.equal(config.packageHealth.enabled, true);
  assert.ok(config.policy.requiredChecks.includes("package"));
  const [artifact] = runMeasure(config, "quality.package_health", "test package health") as [ToolArtifact];
  assert.equal(artifact.summary.complete, true, JSON.stringify(artifact.tool_status, null, 2));
  assert.equal(requiredToolStatus(artifact, "declaration_emit").complete, true);
  assert.equal(requiredToolStatus(artifact, "npm_pack").complete, true);
  assert.equal(requiredToolStatus(artifact, "publint").complete, true);
  assert.equal(requiredToolStatus(artifact, "are_the_types_wrong").complete, true);
  assert.ok(Number(artifact.summary.packed_files) > 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("SARIF ingestion preserves fingerprints, flows, fixes, and invocation failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-sarif-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "sarif-fixture", type: "module" }), "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "query.ts"), "export const query = input;\nrun(query);\n", "utf8");
  const validSarif = path.join(tempDir, "codeql.sarif");
  fs.writeFileSync(validSarif, JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "CodeQL",
        semanticVersion: "2.20.0",
        rules: [{ id: "js/sql-injection", helpUri: "https://example.test/rule", defaultConfiguration: { level: "error" } }],
      } },
      automationDetails: { id: "security/pr" },
      invocations: [{ executionSuccessful: true }],
      results: [{
        ruleId: "js/sql-injection",
        level: "error",
        message: { text: "Unsanitized input reaches a query sink." },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/query.ts" }, region: { startLine: 1, startColumn: 22, endLine: 1, endColumn: 27 } } }],
        partialFingerprints: { primaryLocationLineHash: "fingerprint-1" },
        properties: { "security-severity": "9.3" },
        codeFlows: [{ threadFlows: [{ locations: [
          { location: { physicalLocation: { artifactLocation: { uri: "src/query.ts" }, region: { startLine: 1, startColumn: 22 } } } },
          { location: { physicalLocation: { artifactLocation: { uri: "src/query.ts" }, region: { startLine: 2, startColumn: 1 } } } },
        ] }] }],
        fixes: [{ description: { text: "Use a parameterized query." }, artifactChanges: [{
          artifactLocation: { uri: "src/query.ts" },
          replacements: [{ deletedRegion: { startLine: 2, startColumn: 1 }, insertedContent: { text: "safeRun(query)" } }],
        }] }],
      }],
    }],
  }), "utf8");
  const failedSarif = path.join(tempDir, "semgrep.sarif");
  fs.writeFileSync(failedSarif, JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "Semgrep", version: "1.0.0" } },
      invocations: [{
        executionSuccessful: false,
        toolExecutionNotifications: [{ level: "error", message: { text: "Analysis timed out." } }],
      }],
      results: [],
    }],
  }), "utf8");
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    project_root: ".",
    source_roots: ["src"],
    output_dir: "target/analysis",
    sarif_inputs: [
      { path: "codeql.sarif", name: "codeql", required: true },
      { path: "semgrep.sarif", name: "semgrep", required: false },
    ],
  }), "utf8");

  const config = loadConfig(configPath);
  const [artifact] = runMeasure(config, "quality.sarif", "test sarif") as [ToolArtifact];
  const finding = artifact.records?.find((record) => record.original_rule_id === "js/sql-injection");
  assert.equal(requiredToolStatus(artifact, "codeql_1").complete, true);
  assert.equal(requiredToolStatus(artifact, "semgrep_2").complete, false);
  assert.equal(finding?.file, "src/query.ts");
  assert.equal(finding?.end_column, 27);
  assert.equal((finding?.partial_fingerprints as Record<string, string>).primaryLocationLineHash, "fingerprint-1");
  assert.equal((finding?.automation_details as { id?: string }).id, "security/pr");
  assert.ok(finding?.related_locations?.some((location) => location.role === "source"));
  assert.ok(finding?.related_locations?.some((location) => location.role === "sink"));
  assert.ok(Array.isArray(finding?.sarif_fixes) && finding.sarif_fixes.length > 0);
  assert.ok(artifact.records?.some((record) => record.kind === "sarif_invocation_incomplete" && record.source === "Semgrep"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("runtime inputs normalize React Profiler, axe, and React Doctor evidence", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-runtime-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "runtime-fixture", type: "module" }), "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "App.tsx"), "export function App() { return <main />; }\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "profiler.json"), JSON.stringify({ commits: [{
    component: "App",
    duration_ms: 64,
    render_count: 12,
    phase: "update",
    file: "src/App.tsx",
    line: 1,
  }] }), "utf8");
  fs.writeFileSync(path.join(tempDir, "axe.json"), JSON.stringify({ violations: [{
    id: "color-contrast",
    impact: "critical",
    help: "Elements must meet minimum color contrast.",
    helpUrl: "https://example.test/axe/color-contrast",
    nodes: [{ target: ["main"], html: "<main>", failureSummary: "Contrast is too low." }],
  }] }), "utf8");
  fs.writeFileSync(path.join(tempDir, "react-doctor.json"), JSON.stringify({
    schemaVersion: 3,
    diagnostics: [{
      id: "doctor-1",
      normalizedFilePath: "src/App.tsx",
      plugin: "react-doctor",
      rule: "no-large-component",
      severity: "warning",
      message: "Component is too large.",
      help: "Split the component.",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 10,
      fixGroupId: "split-app",
      relatedLocations: [{ filePath: "src/App.tsx", line: 1, column: 20, message: "Large subtree." }],
    }],
  }), "utf8");
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    project_root: ".",
    source_roots: ["src"],
    output_dir: "target/analysis",
    runtime_inputs: {
      react_profiler: "profiler.json",
      axe: "axe.json",
      react_doctor: "react-doctor.json",
    },
  }), "utf8");

  const config = loadConfig(configPath);
  const [artifact] = runMeasure(config, "quality.runtime", "test runtime") as [ToolArtifact];
  assert.equal(artifact.summary.status, "complete");
  assert.equal(requiredToolStatus(artifact, "react_profiler").complete, true);
  assert.equal(requiredToolStatus(artifact, "axe").complete, true);
  assert.equal(requiredToolStatus(artifact, "react_doctor").complete, true);
  assert.ok(artifact.records?.some((record) => record.source === "react-profiler" && record.duration_ms === 64));
  assert.ok(artifact.records?.some((record) => record.source === "axe" && record.disposition === "block"));
  assert.ok(artifact.records?.some((record) => record.source === "react-doctor" && record.fix_group_id === "split-app"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("audit reports stale configured suppressions", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-stale-suppression`);
  config.suppressions = [{ id: "missing:finding", reason: "used to be noisy" }];
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const audit = runAudit(config, "test audit stale suppression", { base: "__missing_base__", gate: "new-only" });

  assert.equal(audit.summary.stale_suppressions, 1);
  assert.ok(audit.findings.some((finding) => finding.kind === "stale_suppression"));
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("audit marks unchanged-line findings as inherited context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-git-audit-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "git-audit-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "git-audit-fixture",
      project_root: ".",
      source_roots: ["src"],
      test_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      test_command: null,
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "lib.ts"),
    [
      "export function used(): number {",
      "  return 1;",
      "}",
      "",
      "export function oldUnused(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), 'import { used } from "./lib.js";\nconsole.log(used());\n', "utf8");
  git(tempDir, "init");
  git(tempDir, "config", "user.email", "test@example.com");
  git(tempDir, "config", "user.name", "Test User");
  git(tempDir, "add", ".");
  git(tempDir, "commit", "-m", "initial");
  fs.writeFileSync(
    path.join(tempDir, "src", "lib.ts"),
    [
      "export function used(): number {",
      "  return 10;",
      "}",
      "",
      "export function oldUnused(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const audit = runAudit(config, "test audit changed lines", { base: "HEAD", gate: "new-only" });
  const oldUnused = audit.findings.find((finding) => finding.id === "cleanup:unused-export:src/lib:oldUnused");

  assert.ok(oldUnused, "old unused export should be included as changed-file context");
  assert.equal(oldUnused.introduced, false);
  assert.ok(audit.summary.changed_hunks > 0);
  assert.equal(audit.summary.base_snapshot_available, true);
  assert.equal(audit.summary.base_snapshot_compatible, true);

  config.react.ruleset = "classic-v1";
  const incompatible = runAudit(config, "test audit incompatible identity", { base: "HEAD", gate: "new-only" });
  assert.equal(incompatible.summary.base_snapshot_available, true);
  assert.equal(incompatible.summary.base_snapshot_compatible, false);
  assert.ok(incompatible.summary.incomplete_reasons.some((reason) => reason.includes("analysis identity differs")));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("workspace discovery loads project references and preserves cross-package ownership", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-workspaces-`));
  for (const workspace of ["a", "b"]) fs.mkdirSync(path.join(tempDir, "packages", workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({ name: "workspace-fixture", private: true, workspaces: ["packages/*"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ files: [], references: [{ path: "packages/a" }, { path: "packages/b" }] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "packages", "a", "package.json"),
    JSON.stringify({ name: "@fixture/a", type: "module", exports: "./dist/index.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "packages", "b", "package.json"),
    JSON.stringify({ name: "@fixture/b", type: "module", dependencies: { "@fixture/a": "workspace:*", react: "latest" }, exports: "./dist/index.js" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "packages", "a", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, strict: true, module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src" },
      include: ["src"],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "packages", "b", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        baseUrl: ".",
        paths: { "@fixture/a": ["../a/src/index.ts"] },
      },
      references: [{ path: "../a" }],
      include: ["src"],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "packages", "a", "src", "index.ts"), "export const value = 42;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "packages", "b", "src", "index.ts"),
    'import { value } from "@fixture/a";\nexport const doubled = value * 2;\n',
    "utf8",
  );
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    project_root: ".",
    source_roots: ["packages"],
    output_dir: "target/analysis",
    tsconfig: "tsconfig.json",
    workspaces: {
      enabled: true,
      overrides: [{ workspace: "@fixture/b", framework: "react", policy_profile: "strict" }],
    },
  }), "utf8");

  const config = loadConfig(configPath);
  const analysis = createAnalysisContext(config).project();
  const packageA = analysis.workspaces.find((workspace) => workspace.id === "@fixture/a");
  const packageB = analysis.workspaces.find((workspace) => workspace.id === "@fixture/b");
  const moduleB = analysis.modules.find((module) => module.file === "packages/b/src/index.ts");
  const crossEdge = moduleB?.imports.find((edge) => edge.specifier === "@fixture/a");
  assert.equal(analysis.workspaces.length, 3);
  assert.equal(packageA?.project_loaded, true);
  assert.equal(packageB?.project_loaded, true);
  assert.equal(packageB?.framework, "react");
  assert.equal(packageB?.policy_profile, "strict");
  assert.equal(moduleB?.workspace_id, "@fixture/b");
  assert.ok(moduleB?.entrypointRoles.includes("package_export"));
  assert.equal(crossEdge?.from_workspace, "@fixture/b");
  assert.equal(crossEdge?.to_workspace, "@fixture/a");
  assert.equal(crossEdge?.workspace_dependency, true);

  const [dependency] = runMeasure(config, "quality.dependency_health", "test workspace graph") as [Artifact];
  const graph = dependency.graph as { workspace_edges?: Array<{ from: string; to: string }> };
  assert.ok(graph.workspace_edges?.some((edge) => edge.from === "@fixture/b" && edge.to === "@fixture/a"));
  const context = projectContext(config, "test workspace context") as unknown as {
    summary: { workspaces: number; incomplete_workspace_projects: number };
    workspaces: Array<{ id: string }>;
  };
  assert.equal(context.summary.workspaces, 3);
  assert.equal(context.summary.incomplete_workspace_projects, 0);
  assert.ok(context.workspaces.some((workspace) => workspace.id === "@fixture/a"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup honors configured public API exports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-public-api-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "public-api-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "lib.ts"),
    "export const publicHelper = 1;\nexport const testHelper = 2;\nexport const unusedHelper = 3;\n",
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "tests", "lib.test.ts"), "import { testHelper } from '../src/lib.js';\nvoid testHelper;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "public-api-fixture",
      project_root: ".",
      source_roots: ["src"],
      test_roots: ["tests"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      public_api: { exports: [{ file: "src/lib.ts", names: ["publicHelper"] }] },
    }),
    "utf8",
  );
  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.cleanup", "test public api cleanup");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(!cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/lib:publicHelper"));
  assert.ok(!cleanup.disagreements?.some((record) => record.id === "cleanup:unused-export:src/lib:publicHelper"));
  assert.ok(!cleanup.disagreements?.some((record) => record.id === "cleanup:unused-export:src/lib:testHelper"));
  assert.ok(cleanup.disagreements?.some((record) =>
    record.id === "cleanup:unused-export:src/lib:unusedHelper" &&
    record.semantic_decision === "disagreed",
  ));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup aligns script binaries, declaration-surface types, and canonical re-exports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-cleanup-semantics-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "node_modules", "aliased-compiler"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "node_modules", "aliased-compiler", "package.json"),
    JSON.stringify({ name: "compiler-implementation", version: "1.0.0", bin: { "fixture-tsc": "./bin/tsc.js" } }),
  );
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "cleanup-semantics-fixture",
      type: "module",
      main: "./dist/index.js",
      bin: { fixture: "./dist/cli.js" },
      scripts: { build: "fixture-tsc -p tsconfig.json" },
      dependencies: { "platform-package": "1.0.0" },
      devDependencies: { "aliased-compiler": "npm:compiler-implementation@1.0.0", "configured-plugin": "1.0.0" },
    }),
  );
  fs.mkdirSync(path.join(tempDir, "android"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "vite.config.ts"), "import plugin from 'configured-plugin';\nvoid plugin;\n");
  fs.writeFileSync(path.join(tempDir, "android", "settings.gradle"), "includeBuild '../node_modules/platform-package/native'\n");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
  );
  fs.writeFileSync(path.join(tempDir, "src", "runner.ts"), "export type Options = { strict: boolean };\nexport function run(options: Options): boolean { return options.strict; }\nconst helper = () => null;\nexport default helper;\n");
  fs.writeFileSync(path.join(tempDir, "src", "cli.ts"), "export const cli = true;\n");
  fs.writeFileSync(path.join(tempDir, "src", "browser.ts"), "export const browser = true;\n");
  fs.writeFileSync(path.join(tempDir, "index.html"), '<script type="module" src="/src/browser.ts"></script>\n');
  fs.writeFileSync(path.join(tempDir, "src", "a.ts"), "export const shared = 'a';\n");
  fs.writeFileSync(path.join(tempDir, "src", "b.ts"), "export const shared = 'b';\n");
  fs.writeFileSync(path.join(tempDir, "src", "orphan.ts"), "export const orphan = true;\n");
  fs.writeFileSync(
    path.join(tempDir, "src", "index.ts"),
    "export { run, default as helper } from './runner.js';\nexport * from './a.js';\nexport * from './b.js';\n",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "cleanup-semantics-fixture",
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      cleanup: { knip: false },
    }),
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.cleanup", "test cleanup semantics");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(!cleanup.records?.some((record) => record.name === "aliased-compiler"));
  assert.ok(!cleanup.records?.some((record) => record.name === "configured-plugin"));
  assert.ok(!cleanup.records?.some((record) => record.name === "platform-package"));
  assert.ok(!cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/runner:Options"));
  assert.ok(!cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/runner:default"));
  assert.ok(!cleanup.records?.some((record) => record.kind === "unused_file" && ["src/cli.ts", "src/browser.ts"].includes(record.file ?? "")));
  assert.ok(!cleanup.records?.some((record) => record.kind === "duplicate_export" && record.name === "run"));
  assert.ok(cleanup.records?.some((record) => record.kind === "duplicate_export" && record.name === "shared"));
  assert.ok(cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/orphan:orphan"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup distinguishes Knip exclusions from semantic disagreements", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-cleanup-exclusion-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "cleanup-exclusion-fixture",
      type: "module",
      bin: { fixture: "src/index.ts" },
      dependencies: { "ignored-package": "1.0.0" },
      knip: { ignoreDependencies: ["ignored-package"] },
    }),
  );
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({ project_name: "cleanup-exclusion-fixture", project_root: ".", source_roots: ["src"], output_dir: "target/analysis" }),
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.cleanup", "test cleanup exclusion");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  const excluded = cleanup.unconfirmed?.find((record) => record.id === "cleanup:unused-dependency:ignored-package");
  assert.equal(excluded?.semantic_decision, "excluded-by-tool");
  assert.equal(cleanup.disagreements?.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("golden fixture exercises edge-case artifact signals", () => {
  const config = loadConfig(goldenConfig);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  runMeasure(config, "all", "test golden fixture");

  const dependency = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8")) as Artifact & {
    graph: { edges: Array<{ from: string; to: string; kind: string }> };
    summary: { layer_violations?: number; unsupported_patterns?: number };
  };
  assert.ok(dependency.summary.layer_violations && dependency.summary.layer_violations > 0);
  assert.ok(dependency.summary.unsupported_patterns && dependency.summary.unsupported_patterns > 0);
  assert.ok(dependency.records?.some((record) => record.kind === "layer_violation"));
  assert.ok(dependency.records?.some((record) => record.kind === "unsupported_pattern"));
  const cycle = dependency.records?.find((record) => record.kind === "import_cycle");
  assert.ok(cycle?.related_locations && cycle.related_locations.length > 1);
  assert.equal(cycle?.fix_group_id, cycle?.id);
  assert.ok(dependency.graph.edges.some((edge) => edge.from === "src/app/page" && edge.to === "src/lib/math" && edge.kind === "relative"));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as Artifact &
    SummaryArtifact<{ ast_clone_groups: number }>;
  assert.ok(clones.summary.ast_clone_groups > 0);
  assert.ok((clones.groups as Array<{ engine: string }>).some((group) => group.engine === "ast"));

  const react = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as Artifact &
    SummaryArtifact<{ a11y_findings: number }>;
  assert.ok(react.summary.a11y_findings > 0);
  assert.ok(react.records?.some((record) => record.rule_id === "jsx-a11y/alt-text" && record.source === "eslint-plugin-jsx-a11y"));
  assert.ok(react.records?.some((record) => record.id === "framework:transitive-client-server-boundary:src/app/page.tsx"));

  const leverage = JSON.parse(fs.readFileSync(path.join(config.outputDir, "leverage_metrics.json"), "utf8")) as Artifact;
  assert.ok(leverage.records?.some((record) => Number(record.dead_export_surface ?? 0) > 0));

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8")) as Artifact & {
    meta?: { performance_inputs?: Record<string, unknown> };
  };
  assert.ok(map.meta?.performance_inputs);
});

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function artifactValidator() {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "ts-react-quality-lens.schema.json"), "utf8"));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

async function withSilencedConsole<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}
