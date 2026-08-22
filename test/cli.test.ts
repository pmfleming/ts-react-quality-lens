import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConfig } from "../src/config.js";
import { runCli, runMeasure } from "../src/cli.js";
import { auditMarkdown, runAudit } from "../src/audit.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { projectContext } from "../src/context.js";
import { catalogForConfig } from "../src/tasks.js";
import type { AnalysisContext, Artifact, ProjectAnalysis, ScoredRecord } from "../src/types.js";

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

test("catalog exposes stable board task metadata", () => {
  const config = loadConfig(fixtureConfig);
  const catalog = catalogForConfig(config);
  assert.equal(catalog.lens, "ts-react-quality-lens");
  assert.equal(catalog.tasks.length, 16);
  assert.ok(catalog.tasks.some((task) => task.id === "quality.hotspots"));
  assert.ok(catalog.tasks.some((task) => task.id === "quality.cleanup"));
  assert.ok(catalog.tasks.some((task) => task.id === "quality.package_health"));
  assert.ok(catalog.tasks.some((task) => task.id === "quality.sarif"));
  assert.ok(catalog.tasks.some((task) => task.id === "quality.runtime"));
  assert.ok(catalog.tasks.some((task) => task.id === "map.architecture"));
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
  assert.equal(map.meta?.risk_model_version, 2);
  assert.ok(map.nodes.every((node) => node.risk_model_id === "tsrqlens.architecture_risk"));
  assert.ok(map.nodes.every((node) => node.risk_model_version === 2));
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
  assert.ok(cleanup.records?.some((record) => record.semantic_decision === "confirmed"));
  assert.ok(cleanup.records?.some((record) => record.semantic_decision === "disagreed"));
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
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tsconfig JSONC path aliases are resolved", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-alias-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "alias-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    `{
      // User tsconfigs commonly contain comments.
      "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "baseUrl": ".",
        "paths": { "@/*": ["src/*"] }
      },
      "include": ["src"]
    }`,
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "util.ts"), "export const util = 1;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), 'import { util } from "@/util";\nconsole.log(util);\n', "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({ project_name: "alias-fixture", project_root: ".", source_roots: ["src"], output_dir: "target/analysis", tsconfig: "tsconfig.json" }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const project = createAnalysisContext(config).project();
  const index = project.modules.find((module) => module.file === "src/index.ts");

  assert.ok(index?.imports.some((edge) => edge.to_kind === "relative" && edge.to === "src/util"));
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
  assert.equal(artifact.summary.complete, true);
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

test("audit writes changed-code verdict artifact with actions", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-audit`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const audit = runAudit(config, "test audit", { base: "__missing_base__", gate: "new-only" });

  assert.equal(audit.task_id, "audit");
  assert.ok(["pass", "warn", "fail", "incomplete"].includes(audit.summary.verdict));
  assert.ok(fs.existsSync(path.join(config.outputDir, "audit.json")));
  assert.ok(audit.findings.some((finding) => Array.isArray(finding.actions) && finding.actions.length > 0));
  assert.match(auditMarkdown(audit), /# ts-react-quality-lens audit:/);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
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

test("context command writes compact project context and cache can hit", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-context`);
  config.cache.dir = path.join(config.outputDir, ".cache");
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const first = projectContext(config, "test context first");
  const second = projectContext(config, "test context second");

  assert.equal(first.task_id, "context.project");
  assert.equal(first.summary.cache_reused, false);
  assert.ok(fs.existsSync(path.join(config.outputDir, "context.json")));
  assert.equal(second.summary.cache_status, "hit");
  assert.equal(second.summary.cache_reused, true);
  config.react.ruleset = "classic-v1";
  const invalidated = projectContext(config, "test context invalidated");
  assert.equal(invalidated.summary.cache_status, "miss");
  assert.equal(invalidated.summary.cache_reused, false);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("project analysis marks package tool entrypoints", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-entrypoints-`));
  fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "entrypoint-fixture",
      type: "module",
      main: "./dist/src/index.js",
      bin: { fixture: "./dist/bin/tool.js" },
      scripts: { smoke: "node ./scripts/smoke.ts" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["bin", "src", "scripts"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "bin", "tool.ts"), "export function run(): void {}\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const api = 1;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "scripts", "smoke.ts"), "export const smoke = true;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "entrypoint-fixture",
      project_root: ".",
      source_roots: ["bin", "src", "scripts"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
    }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const context = projectContext(config, "test entrypoint context") as {
    summary: { entrypoint_modules?: number };
    modules: Array<{ file: string; entrypoint_roles: string[] }>;
  };
  assert.equal(context.summary.entrypoint_modules, 3);
  assert.deepEqual(context.modules.find((module) => module.file === "bin/tool.ts")?.entrypoint_roles, ["cli_bin"]);
  assert.deepEqual(context.modules.find((module) => module.file === "src/index.ts")?.entrypoint_roles, ["package_main"]);
  assert.deepEqual(context.modules.find((module) => module.file === "scripts/smoke.ts")?.entrypoint_roles, ["npm_script"]);

  runMeasure(config, "quality.cleanup", "test entrypoint cleanup");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(!cleanup.records?.some((record) => record.kind === "unused_file" && record.id.startsWith("cleanup:")));
  assert.ok(cleanup.records?.some((record) => record.kind === "unused_file" && record.source === "knip"));
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

test("clone measure reports same-purpose exports and hooks without clone-like bodies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-same-purpose-`));
  fs.mkdirSync(path.join(tempDir, "src", "billing"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src", "profile"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "same-purpose-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "billing", "format.ts"),
    [
      "export function formatCurrency(cents: number): string {",
      "  const whole = Math.trunc(cents / 100);",
      "  const fraction = String(Math.abs(cents % 100)).padStart(2, '0');",
      "  return `USD ${whole}.${fraction}`;",
      "}",
      "",
      "export function useUserState(id: string): { id: string; loading: boolean } {",
      "  return { id, loading: false };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "profile", "money.ts"),
    [
      "export const currencyFormatter = (amount: number): string => {",
      "  const value = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });",
      "  return value.format(amount);",
      "};",
      "",
      "export function useStateUser(userId: string): { userId: string; ready: boolean } {",
      "  return { userId, ready: true };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "same-purpose-fixture",
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
    }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.clones", "test same purpose");
  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as Artifact &
    SummaryArtifact<{ same_purpose_records: number }>;
  assert.ok(clones.summary.same_purpose_records >= 2);
  assert.ok(clones.records?.some((record) => record.kind === "same_purpose_export" && record.purpose_key === "currency:format"));
  assert.ok(clones.records?.some((record) => record.kind === "same_purpose_hook" && record.purpose_key === "state:user"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("analysis handles inline type imports and default export assignments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-syntax-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({ name: "syntax-fixture", type: "module", dependencies: { react: "^19.0.0" } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "component.ts"), "const Component = () => null;\nexport default Component;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "src", "index.ts"),
    'import { type ReactNode } from "react";\nimport Component from "./component.js";\nexport const node: ReactNode = Component();\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({ project_name: "syntax-fixture", project_root: ".", source_roots: ["src"], output_dir: "target/analysis", tsconfig: "tsconfig.json" }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const project = createAnalysisContext(config).project();
  const index = project.modules.find((module) => module.file === "src/index.ts");
  const component = project.modules.find((module) => module.file === "src/component.ts");
  assert.ok(index?.imports.some((edge) => edge.specifier === "react" && edge.import_kind === "type"));
  assert.ok(component?.exports.some((exportRecord) => exportRecord.name === "default"));

  runMeasure(config, "quality.cleanup", "test syntax cleanup");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(cleanup.records?.some((record) => record.id === "cleanup:type-only-production-dependency:react"));
  assert.ok(!cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/component:default"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup honors configured public API exports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-public-api-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "public-api-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "lib.ts"), "export const publicHelper = 1;\nexport const unusedHelper = 2;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "public-api-fixture",
      project_root: ".",
      source_roots: ["src"],
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
  assert.ok(cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/lib:unusedHelper"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("react hooks lint resolves dependencies when output dir is outside the project", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-react-hooks`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const [reactHealth] = runMeasure(config, "quality.react_health", "test react hooks temp output") as [ToolArtifact];
  const reactHooks = requiredToolStatus(reactHealth, "eslint_react_hooks");

  assert.equal(reactHooks.available, true);
  assert.equal(reactHooks.ran, true);
  assert.equal(reactHooks.complete, true);
  assert.equal(typeof reactHooks.version, "string");
  assert.equal(reactHooks.ruleset, "recommended-v2");
  assert.ok(reactHealth.records?.some((record) => record.rule_id === "react-hooks/set-state-in-effect" && record.disposition === "review"));
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("jsx-a11y findings replace heuristics when managed lint completes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-a11y-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "a11y-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "src", "Card.tsx"),
    'export function Card() { return <img src="avatar.png" />; }\n',
    "utf8",
  );
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ project_root: ".", source_roots: ["src"], output_dir: "target/analysis" }),
    "utf8",
  );

  const config = loadConfig(configPath);
  const [managed] = runMeasure(config, "quality.react_health", "test managed a11y") as [ToolArtifact];
  assert.equal(requiredToolStatus(managed, "jsx_a11y").complete, true);
  assert.ok(managed.records?.some((record) => record.rule_id === "jsx-a11y/alt-text" && record.source === "eslint-plugin-jsx-a11y"));
  assert.ok(!managed.records?.some((record) => record.source === "jsx-a11y-heuristic"));

  config.accessibility.enabled = false;
  const [fallback] = runMeasure(config, "quality.react_health", "test fallback a11y") as [ToolArtifact];
  assert.equal(requiredToolStatus(fallback, "jsx_a11y").ran, false);
  assert.ok(fallback.records?.some((record) => record.kind === "img_missing_alt" && record.source === "jsx-a11y-heuristic"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("dependency health tolerates dependency-cruiser cycle shape variants", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-depcruise`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  const project = {
    sourceFiles: [],
    testFiles: [],
    modules: [
      { id: "src/a", file: "src/a.ts", imports: [], exports: [], types: [], components: [] },
      { id: "src/b", file: "src/b.ts", imports: [], exports: [], types: [], components: [] },
    ],
    imports: [{ from: "src/a", to: "src/b", to_kind: "relative", specifier: "./b", import_kind: "static", line: 1 }],
    tsProject: { available: false, loaded: false, reason: null },
    frameworkDetails: { conventions: {} },
    workspaces: [],
    unsupportedPatterns: [],
  } as unknown as ProjectAnalysis;
  const context: AnalysisContext = {
    project: () => project,
    jscpd: () => ({ available: false, ran: false, reason: "not used", duplicates: [], statistics: {} }),
    dependencyCruiser: () => ({
      available: true,
      ran: true,
      reason: null,
      modules: [
        { source: "src/a.ts", dependencies: [{ resolved: "src/b.ts", cycle: true }] },
        { source: "src/b.ts", dependencies: [{ resolved: "src/a.ts", cycle: [{ name: "src/a.ts" }] }] },
      ],
      summary: {},
    }),
    knip: () => ({
      available: false,
      ran: false,
      reason: "not used",
      issues: [],
      version: null,
      complete: false,
    }),
    packageHealth: () => ({
      enabled: false,
      declaration: { available: false, ran: false, complete: false, reason: "not used" },
      pack: { available: false, ran: false, complete: false, reason: "not used", files: 0, size: null },
      publint: { available: false, ran: false, complete: false, reason: "not used", messages: [] },
      attw: { available: false, ran: false, complete: false, reason: "not used", problems: [], profile: "strict" },
    }),
    reactHooksLint: () => ({
      available: false,
      ran: false,
      reason: "not used",
      messages: [],
      version: null,
      ruleset: "recommended-v2",
      complete: false,
    }),
    jsxA11yLint: () => ({
      available: false,
      ran: false,
      reason: "not used",
      messages: [],
      version: null,
      complete: false,
    }),
    typedLint: () => ({ available: false, ran: false, reason: "not used", messages: [], version: null, complete: false }),
  };

  const [dependencyHealth] = runMeasure(config, "quality.dependency_health", "test depcruise cycle shape", { context }) as [
    ToolArtifact & SummaryArtifact<{ dependency_cruiser_cycles: number }>,
  ];

  assert.equal(requiredToolStatus(dependencyHealth, "dependency_cruiser").ran, true);
  assert.equal(dependencyHealth.summary.dependency_cruiser_cycles, 1);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
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
