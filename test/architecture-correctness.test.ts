import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { runTestCommand, testRecord } from "../src/correctness.js";
import { createTestMapper, directTestSources } from "../src/test-mapping.js";
import { readSourceFile } from "../src/files.js";
import { mapNode } from "../src/graph.js";
import { runMeasure } from "../src/measure-runner.js";
import { ARCHITECTURE_INPUTS } from "../src/measures/architecture.js";
import { MEASURE_TASKS } from "../src/measures/registry.js";
import { readArtifact } from "../src/writer.js";
import type { Config, TestAssociation } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-architecture-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "architecture", type: "module" }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node10" }, include: ["src", "tests"],
  }));
  fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), JSON.stringify({
    source_roots: ["src"], test_roots: ["src", "tests"], cleanup: { knip: false }, cache: { enabled: false },
  }));
  try { run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("test mapping resolves inherited aliases and directory imports without suffix or comment false positives", () => fixture((root, config) => {
  for (const directory of ["src/one", "src/two", "src/barrel", "src/one/__tests__"]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of ["src/one/foo.ts", "src/two/foo.ts", "src/barrel/index.ts", "src/types.ts"]) {
    fs.writeFileSync(path.join(root, file), "export const value = 1; export type Value = string;\n");
  }
  fs.writeFileSync(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { paths: { "@one/*": ["./src/one/*"] } } }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    extends: "./tsconfig.base.json", compilerOptions: { moduleResolution: "Node10" }, include: ["src", "tests"],
  }));
  const file = path.join(root, "tests/foo.test.ts");
  fs.writeFileSync(file, [
    'import { value } from "@one/foo";',
    'import { value as barrel } from "../src/barrel";',
    'import type { Value } from "../src/types";',
    '// import { value } from "../src/two/foo"; expect(false); test.skip("fake");',
    'const pretend = "assert.equal(1, 2); test.todo(fake)";',
    'expect(value); test.skip("real", () => {});',
  ].join("\n"));
  const project = createAnalysisContext(config).project();
  const mapper = createTestMapper(config, project.modules);
  const record = testRecord(config, readSourceFile(file, root), project.modules, mapper);
  assert.deepEqual(record.source_mapping.sort(), ["src/barrel/index.ts", "src/one/foo.ts"]);
  assert.equal(record.locality, "external");
  assert.equal(record.assertions, 1);
  assert.equal(record.skipped, 1);
  assert.equal(record.todo, 0);
  assert.ok(record.source_associations?.some((item) => item.file === "src/types.ts" && item.kind === "type-only-import"));
  const colocated = path.join(root, "src/one/__tests__/foo.test.ts");
  fs.writeFileSync(colocated, "// Only a naming association, not coverage\n");
  const named = testRecord(config, readSourceFile(colocated, root), project.modules, mapper);
  assert.deepEqual(named.source_mapping, ["src/one/foo.ts"]);
  assert.equal(named.locality, "colocated");
  assert.deepEqual(directTestSources(named), []);
  assert.equal(named.coverage_status, "not_collected");
}));

test("standalone architecture generates every declared input exactly once", () => fixture((_root, config) => {
  const tasks = new Map(MEASURE_TASKS);
  const counts = new Map<string, number>();
  for (const [id, task] of tasks) MEASURE_TASKS.set(id, { ...task, handler: (...args) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return task.handler(...args);
  } });
  try {
    const [map] = runMeasure(config, "map.architecture", "test standalone");
    assert.equal(map?.summary.missing_inputs, 0);
    for (const input of ARCHITECTURE_INPUTS) {
      assert.equal(counts.get(input.task), 1, input.task);
      assert.ok(readArtifact(config, input.artifact), input.artifact);
    }
  } finally { for (const [id, task] of tasks) MEASURE_TASKS.set(id, task); }
}));

test("architecture prerequisites preserve current executed tests without rerunning them", () => fixture((root, config) => {
  config.testCommand = `node -e "require('node:fs').appendFileSync('test-runs', 'x')"`;
  runMeasure(config, "correctness.all", "test execution");
  runMeasure(config, "map.architecture", "test map");
  assert.equal(readArtifact(config, "correctness_review.json")?.execution?.status, "passed");
  assert.equal(fs.readFileSync(path.join(root, "test-runs"), "utf8"), "x");
  fs.writeFileSync(path.join(root, "tests/new.test.ts"), "// New test invalidates execution evidence\n");
  runMeasure(config, "map.architecture", "test stale map");
  assert.equal(readArtifact(config, "correctness_review.json")?.execution?.status, "not_run");
  assert.equal(fs.readFileSync(path.join(root, "test-runs"), "utf8"), "x");
}));

test("architecture distinguishes unexecuted tests from passing suite associations and consumes lint and cleanup", () => fixture((_root, config) => {
  const module = createAnalysisContext(config).project().modules[0];
  assert.ok(module);
  const filename: TestAssociation = { file: module.file, kind: "filename", confidence: "low" };
  const inputs = Object.fromEntries(ARCHITECTURE_INPUTS.map((input) => [input.name, { records: [] }]));
  const statuses = Object.fromEntries(ARCHITECTURE_INPUTS.map((input) => [input.name, "available" as const]));
  const notRun = mapNode(module, { ...inputs, correctness: { execution: { status: "not_run" }, tests: [{ source_associations: [filename] }] } }, statuses);
  assert.equal(notRun.correctness_risk, null);
  assert.ok(notRun.unknown_metrics.includes("correctness:no_measured_evidence"));
  const named = mapNode(module, { ...inputs, correctness: { execution: { status: "passed" }, tests: [{ source_associations: [filename] }] } }, statuses);
  assert.equal(named.correctness_risk, 40);
  const direct = mapNode(module, {
    ...inputs,
    correctness: { execution: { status: "passed" }, tests: [{ source_associations: [{ ...filename, kind: "direct-import" }] }] },
    lint: { records: [{ id: "lint", file: module.file, score: 90 }] },
    cleanup: { records: [{ id: "ignored", file: module.file, score: 100, suppressed: true }] },
  }, statuses);
  assert.equal(direct.correctness_risk, 0);
  assert.equal(direct.quality_risk, 90);
  assert.equal(direct.test_evidence.coverage_status, "not_collected");
}));

test("inferred tests use package-manager lifecycle scripts and explicit null disables execution", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test-lifecycle", scripts: {
    pretest: `node -e "require('node:fs').writeFileSync('pretest-ran', 'yes')"`,
    test: `node -e "if (!require('node:fs').existsSync('pretest-ran')) process.exit(1)"`,
  } }));
  const inferred = loadConfig(config.configPath);
  assert.equal(inferred.testCommand, "npm run test");
  assert.equal(runTestCommand(inferred).status, "passed");
  fs.writeFileSync(config.configPath, JSON.stringify({ test_command: null }));
  const disabled = loadConfig(config.configPath);
  assert.equal(disabled.testCommand, null);
  assert.equal(runTestCommand(disabled).status, "unknown");
}));
