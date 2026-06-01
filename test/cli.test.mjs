import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runMeasure } from "../src/cli.mjs";
import { catalogForConfig } from "../src/tasks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8"));
  assert.equal(clones.tool_status.jscpd.available, true);
  assert.equal(clones.tool_status.jscpd.ran, true);

  const reactHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8"));
  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
});
