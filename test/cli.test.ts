import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/cli.js";
import { catalogForConfig } from "../src/tasks.js";
import type { AnalysisContext, Artifact, ProjectAnalysis, ScoredRecord } from "../src/types.js";

const repoRoot = path.resolve();
const fixtureConfig = path.join(repoRoot, "examples/basic/ts-react-quality-lens.config.json");
const goldenConfig = path.join(repoRoot, "test/fixtures/golden/ts-react-quality-lens.config.json");
type ToolArtifact = Artifact & { tool_status: NonNullable<Artifact["tool_status"]> };
type SummaryArtifact<T extends Record<string, unknown>> = Artifact & { summary: T };

test("catalog exposes stable board task metadata", () => {
  const config = loadConfig(fixtureConfig);
  const catalog = catalogForConfig(config);
  assert.equal(catalog.lens, "ts-react-quality-lens");
  assert.equal(catalog.tasks.length, 11);
  assert.ok(catalog.tasks.some((task) => task.id === "quality.hotspots"));
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

  for (const artifact of [
    "hotspots.json",
    "clones.json",
    "ts_escape_hatches.json",
    "type_health.json",
    "dependency_health.json",
    "correctness_review.json",
    "test_catalog.json",
    "locality_metrics.json",
    "leverage_metrics.json",
    "react_health.json",
    "map.json",
  ]) {
    assert.ok(fs.existsSync(path.join(config.outputDir, artifact)), `${artifact} should exist`);
  }

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
  assert.equal(map.meta?.risk_model_version, 1);
  assert.ok(map.nodes.every((node) => node.risk_model_id === "tsrqlens.architecture_risk"));
  assert.ok(map.nodes.every((node) => node.risk_model_version === 1));
  assert.ok(map.nodes.every((node) => Array.isArray(node.unknown_metrics)));
  assert.ok(Object.entries(map.summary.artifact_status ?? {}).every(([name, status]) => name === "performance" || status === "available"));
  assert.equal(map.summary.unknown_metric_nodes, 0);

  const typeHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "type_health.json"), "utf8")) as Artifact;
  assert.equal(typeHealth.confidence.typescript_compiler_api_available, true);
  assert.equal(typeHealth.confidence.typescript_program_loaded, true);
  assert.ok(typeHealth.records?.some((record: ScoredRecord) => record.source === "typescript-compiler-api"));

  const dependencyHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8")) as ToolArtifact & {
    graph: { edges: Array<{ from: string; source?: unknown; line?: unknown }> };
  };
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.available, true);
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
  const dependencyEdges = dependencyHealth.graph.edges as Array<{ from: string; source?: unknown; line?: unknown }>;
  assert.ok(dependencyEdges.every((edge) => !edge.from.includes(".test")));
  assert.ok(dependencyEdges.some((edge) => edge.source === "dependency-cruiser" && edge.line !== null));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ jscpd_clone_groups: number }>;
  assert.equal(clones.tool_status.jscpd.available, true);
  assert.equal(clones.tool_status.jscpd.ran, true);
  assert.ok(clones.summary.jscpd_clone_groups > 0);

  const reactHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ hook_lint_findings: number }>;
  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
  assert.ok(reactHealth.summary.hook_lint_findings > 0);
  assert.ok(reactHealth.records?.some((record: ScoredRecord) => record.source === "framework-adapter"));

  const correctness = JSON.parse(fs.readFileSync(path.join(config.outputDir, "correctness_review.json"), "utf8"));
  assert.equal(correctness.summary.execution_status, "passed");
});

test("react hooks lint resolves dependencies when output dir is outside the project", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-react-hooks`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const [reactHealth] = runMeasure(config, "quality.react_health", "test react hooks temp output") as [ToolArtifact];

  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
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
    reactHooksLint: () => ({ available: false, ran: false, reason: "not used", messages: [] }),
  };

  const [dependencyHealth] = runMeasure(config, "quality.dependency_health", "test depcruise cycle shape", { context }) as [
    ToolArtifact & SummaryArtifact<{ dependency_cruiser_cycles: number }>,
  ];

  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
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
  assert.ok(dependency.graph.edges.some((edge) => edge.from === "src/app/page" && edge.to === "src/lib/math" && edge.kind === "relative"));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as Artifact &
    SummaryArtifact<{ ast_clone_groups: number }>;
  assert.ok(clones.summary.ast_clone_groups > 0);
  assert.ok((clones.groups as Array<{ engine: string }>).some((group) => group.engine === "ast"));

  const react = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as Artifact &
    SummaryArtifact<{ a11y_findings: number }>;
  assert.ok(react.summary.a11y_findings > 0);
  assert.ok(react.records?.some((record) => record.kind === "img_missing_alt"));
  assert.ok(react.records?.some((record) => record.id === "framework:transitive-client-server-boundary:src/app/page.tsx"));

  const leverage = JSON.parse(fs.readFileSync(path.join(config.outputDir, "leverage_metrics.json"), "utf8")) as Artifact;
  assert.ok(leverage.records?.some((record) => Number(record.dead_export_surface ?? 0) > 0));

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8")) as Artifact & {
    meta?: { performance_inputs?: Record<string, unknown> };
  };
  assert.ok(map.meta?.performance_inputs);
});
