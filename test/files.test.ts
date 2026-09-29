import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { measureCorrectnessCatalog } from "../src/measures/correctness.js";
import { measureLeverage, measureLocality } from "../src/measures/locality.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-files-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "files-fixture" }));
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 1;\n");
  try { run(root, loadConfig(path.join(root, "lens.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("test classification ignores checkout ancestors while preserving project-local test paths", () => fixture((root) => {
  for (const parent of ["ordinary", "test", "tests", "spec", "e2e", "cypress", "__tests__"]) {
    const projectRoot = path.join(root, parent, "app");
    fs.mkdirSync(path.join(projectRoot, "src/__tests__"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "tests"));
    fs.writeFileSync(path.join(projectRoot, "src/index.ts"), "export const production = true;\n");
    fs.writeFileSync(path.join(projectRoot, "src/index.test.ts"), 'import "./index.js";\n');
    fs.writeFileSync(path.join(projectRoot, "src/__tests__/nested.ts"), 'import "../index.js";\n');
    fs.writeFileSync(path.join(projectRoot, "tests/integration.ts"), 'import "../src/index.js";\n');
    const config = loadConfig(path.join(projectRoot, "lens.json"));
    for (const status of ["miss", "hit"]) {
      const context = createAnalysisContext(config);
      const project = context.project();
      assert.equal(project.cache.status, status, parent);
      assert.deepEqual(project.sourceFiles.map((file) => file.relativePath), ["src/index.ts"], parent);
      assert.deepEqual(project.testFiles.map((file) => file.relativePath), [
        "src/__tests__/nested.ts", "src/index.test.ts", "tests/integration.ts",
      ], parent);
      assert.ok(project.sourceFiles.every((file) => !file.isTest), parent);
      assert.ok(project.modules.every((module) => !module.sourceFile.isTest), parent);
      assert.ok(project.testFiles.every((file) => file.isTest), parent);
      const catalog = measureCorrectnessCatalog(config, "test", false, context);
      assert.equal(catalog.summary.tests, 3, parent);
      assert.ok(catalog.tests.every((test) => test.path !== "src/index.ts"), parent);
    }
  }
}));

test("exact tsconfig aliases produce internal graph edges on fresh and cached analysis", () => fixture((root) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), "// User tsconfigs accept JSONC comments.\n" + JSON.stringify({
    compilerOptions: { strict: true, types: [], paths: { "@app": ["./src/index.ts"] } }, include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/consumer.ts"), 'import { value } from "@app"; import { value as again } from "./index"; export const result = value + again;\n');
  fs.writeFileSync(path.join(root, "src/index.ts"), 'import "./index"; export const value = 1;\n');
  fs.mkdirSync(path.join(root, "src/deep/nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/deep/nested/consumer.ts"), 'import { value } from "@app"; export const nested = value;\n');
  const config = loadConfig(path.join(root, "lens.json"));
  for (const status of ["miss", "hit"]) {
    const context = createAnalysisContext(config);
    const project = context.project();
    assert.equal(project.cache.status, status);
    assert.deepEqual(project.tsProject.diagnostics, []);
    const edge = project.imports.find((item) => item.specifier === "@app");
    assert.ok(edge);
    assert.equal(edge.from, "src/consumer");
    assert.equal(edge.to, "src/index");
    assert.equal(edge.to_kind, "relative");
    assert.equal(edge.resolved, path.join(root, "src/index.ts"));
    const leverage = measureLeverage(config, "test", context).records?.find((record) => record.file === "src/index.ts");
    assert.equal(leverage?.inbound_reach, 2, "Count consumers, excluding duplicate statements and self imports");
    const locality = measureLocality(config, "test", context).records;
    assert.equal(locality?.find((record) => record.file === "src/deep/nested/consumer.ts")?.dependency_distance, 1);
    assert.equal(locality?.find((record) => record.file === "src/consumer.ts")?.dependency_distance, 0);
  }
}));
