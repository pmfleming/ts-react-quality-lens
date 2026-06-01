import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/cli.js";
import { catalogForConfig } from "../src/tasks.js";

const repoRoot = path.resolve();
const fixtureConfig = path.join(repoRoot, "examples/basic/ts-react-quality-lens.config.json");

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

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8"));
  assert.ok(map.nodes.length > 0);
  assert.ok(map.edges.length > 0);

  const typeHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "type_health.json"), "utf8"));
  assert.equal(typeHealth.confidence.typescript_compiler_api_available, true);
  assert.equal(typeHealth.confidence.typescript_program_loaded, true);
  assert.ok(typeHealth.records.some((record) => record.source === "typescript-compiler-api"));

  const dependencyHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8"));
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.available, true);
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
  assert.ok(dependencyHealth.graph.edges.every((edge) => !edge.from.includes(".test")));
  assert.ok(dependencyHealth.graph.edges.some((edge) => edge.source === "dependency-cruiser" && edge.line !== null));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8"));
  assert.equal(clones.tool_status.jscpd.available, true);
  assert.equal(clones.tool_status.jscpd.ran, true);
  assert.ok(clones.summary.jscpd_clone_groups > 0);

  const reactHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8"));
  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
  assert.ok(reactHealth.summary.hook_lint_findings > 0);
  assert.ok(reactHealth.records.some((record) => record.source === "framework-adapter"));

  const correctness = JSON.parse(fs.readFileSync(path.join(config.outputDir, "correctness_review.json"), "utf8"));
  assert.equal(correctness.summary.execution_status, "passed");
});

test("react hooks lint resolves dependencies when output dir is outside the project", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-react-hooks`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const [reactHealth] = runMeasure(config, "quality.react_health", "test react hooks temp output");

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
  };
  const context = {
    project: () => project,
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
  };

  const [dependencyHealth] = runMeasure(config, "quality.dependency_health", "test depcruise cycle shape", { context });

  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
  assert.equal(dependencyHealth.summary.dependency_cruiser_cycles, 1);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});
