import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { runAudit } from "../src/audit.js";
import { changeSetSince } from "../src/audit/change-set.js";
import { collectFindings, requiredEvidenceReasons, runAuditMeasurements } from "../src/audit/findings.js";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/measure-runner.js";
import { MEASURE_TASKS } from "../src/measures/registry.js";
import { readArtifact, writeArtifact } from "../src/writer.js";
import { analysisIdentity, artifactBase, sourceSetHash } from "../src/provenance.js";
import { artifactFreshness } from "../src/measures/architecture.js";
import { normalizeFindingIdentities } from "../src/finding-identity.js";
import type { Artifact, Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-reliability-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "reliability", type: "module" }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), JSON.stringify({
    source_roots: ["src"], test_roots: ["src"], cache: { enabled: false }, cleanup: { knip: false },
    policy: { required_checks: [] },
  }));
  try { run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function git(root: string, ...args: string[]): string {
  return childProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function initGit(root: string): void {
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
}

function artifact(taskId: string): Artifact {
  return {
    schema_version: "test", task_id: taskId,
    project: { name: "test", root: ".", framework: "unknown", package_manager: "npm", test_runner: "unknown" },
    provenance: {}, confidence: {}, summary: {},
  };
}

function stubMeasurements(run: () => void): void {
  const tasks = new Map(MEASURE_TASKS);
  for (const [id, task] of tasks) MEASURE_TASKS.set(id, { ...task, handler: () => artifact(id) });
  try { run(); }
  finally { for (const [id, task] of tasks) MEASURE_TASKS.set(id, task); }
}

test("invalid TypeScript options are diagnostics, not clean loaded projects", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { nonexistentOption: true }, include: ["src"] }));
  const project = createAnalysisContext(config).project();
  assert.equal(project.tsProject.loaded, false);
  assert.ok(project.tsProject.diagnostics.some((diagnostic) => diagnostic.code === 5023));
}));

test("runtime inputs reject unsupported shapes and invalid entries but accept valid empty reports", () => fixture((root, config) => {
  const file = path.join(root, "runtime.json");
  for (const [key, invalid, empty] of [
    ["axe", { violations: [null] }, { violations: [] }],
    ["reactProfiler", { commits: [{}] }, { commits: [] }],
    ["reactDoctor", { projects: [{}] }, { diagnostics: [] }],
  ] as const) {
    config.runtimeInputs = { axe: null, reactProfiler: null, reactDoctor: null, [key]: file };
    for (const value of [{ unrelated: true }, invalid]) {
      fs.writeFileSync(file, JSON.stringify(value));
      const [result] = runMeasure(config, "quality.runtime", "test");
      assert.equal(result?.summary.status, "incomplete");
      assert.ok(requiredEvidenceReasons(config).some((reason) => reason.includes("runtime")));
    }
    fs.writeFileSync(file, JSON.stringify(empty));
    assert.equal(runMeasure(config, "quality.runtime", "test")[0]?.summary.status, "complete");
  }
}));

test("Git scope includes committed, staged, unstaged, and untracked changes", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 1;\n");
  initGit(root);
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 2;\n");
  git(root, "add", "src/a.ts");
  git(root, "commit", "-m", "committed");
  fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "src/staged.ts"), "export const staged = 1;\n");
  git(root, "add", "src/staged.ts");
  fs.writeFileSync(path.join(root, "src/untracked.ts"), "export const untracked = 1;\n");
  const changes = changeSetSince(config, "HEAD~1");
  assert.equal(changes.complete, true);
  assert.deepEqual(changes.files.sort(), ["src/a.ts", "src/b.ts", "src/staged.ts", "src/untracked.ts"]);
  assert.equal(changes.lines.size, 4);
  assert.equal(changeSetSince(config, "missing-ref").complete, false);
}));

test("audit fails closed for an invalid base and does not expand a valid empty diff", () => fixture((root, config) => {
  initGit(root);
  stubMeasurements(() => {
    const result = runAudit(config, "test", { base: "missing-ref" });
    assert.equal(result.summary.verdict, "incomplete");
    assert.ok(result.summary.incomplete_reasons.some((reason) => reason.includes("Git comparison")));
  });
  writeArtifact(config, "lint_health.json", { ...artifact("quality.lint"), records: [{
    id: "old", file: "src/a.ts", line: 1, disposition: "block", source: "typescript-eslint",
  }] });
  assert.deepEqual(collectFindings(config, {
    changedFiles: [], changedLines: new Map(), baselineIds: new Set(), diffAvailable: true,
  }), []);
}));

test("audits run package health and collect current package failures", () => fixture((_root, config) => {
  config.policy.requiredChecks = ["package"];
  stubMeasurements(() => {
    let ran = false;
    MEASURE_TASKS.set("quality.package_health", { handler: () => {
      ran = true;
      const result: Artifact = { ...artifact("quality.package_health"), summary: { complete: true }, records: [{
        id: "package:broken", scope: "project", source: "publint", disposition: "block", message: "Broken package",
      }] };
      writeArtifact(config, "package_health.json", result);
      return result;
    } });
    runAuditMeasurements(config, "test", createAnalysisContext(config), false);
    assert.equal(ran, true);
    assert.deepEqual(requiredEvidenceReasons(config), []);
    assert.ok(collectFindings(config, {
      changedFiles: [], changedLines: new Map(), baselineIds: new Set(), includeAll: true,
    }).some((finding) => finding.id === "package:broken" && finding.disposition === "block"));
  });
}));

test("cache invalidates inherited compiler settings and declaration dependencies", () => fixture((root, config) => {
  config.cache.enabled = true;
  const base = path.join(root, "tsconfig.base.json");
  fs.writeFileSync(base, JSON.stringify({ compilerOptions: { strict: true } }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }));
  fs.writeFileSync(path.join(root, "src/globals.d.ts"), "declare const externalValue: string;\n");
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = externalValue;\n");
  const identity = analysisIdentity(config).id;
  assert.equal(createAnalysisContext(config).project().cache.status, "miss");
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
  fs.writeFileSync(base, JSON.stringify({ compilerOptions: { strict: false } }));
  assert.notEqual(analysisIdentity(config).id, identity);
  assert.equal(createAnalysisContext(config).project().cache.status, "miss");
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
  fs.writeFileSync(path.join(root, "src/globals.d.ts"), "declare const externalValue: number;\n");
  assert.equal(createAnalysisContext(config).project().cache.status, "miss");
  const before = analysisIdentity(config).id;
  config.typeCoverage.minimumPercent = 99;
  assert.notEqual(analysisIdentity(config).id, before);
}));

test("cache invalidates compiler root-file additions and removals outside source discovery", () => fixture((root, config) => {
  config.cache.enabled = true;
  const diagnostics = () => {
    const project = createAnalysisContext(config).project();
    return { status: project.cache.status, codes: project.tsProject.diagnostics.map((item) => item.code) };
  };
  assert.deepEqual(diagnostics(), { status: "miss", codes: [] });
  assert.equal(diagnostics().status, "hit");
  const declaration = path.join(root, "src/invalid.d.ts");
  fs.writeFileSync(declaration, "declare const broken: DoesNotExist;\n");
  const added = diagnostics();
  assert.equal(added.status, "miss");
  assert.ok(added.codes.includes(2304));
  assert.equal(diagnostics().status, "hit");
  fs.rmSync(declaration);
  assert.deepEqual(diagnostics(), { status: "miss", codes: [] });
}));

test("cache invalidates previously missing module resolution candidates", () => fixture((root, config) => {
  config.cache.enabled = true;
  fs.writeFileSync(path.join(root, "src/a.ts"), 'import { value } from "../types/value.js"; export const a = value;\n');
  const before = createAnalysisContext(config).project();
  assert.ok(before.tsProject.diagnostics.some((item) => item.code === 2307));
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
  fs.mkdirSync(path.join(root, "types"));
  fs.writeFileSync(path.join(root, "types/value.d.ts"), "export declare const value: number;\n");
  const after = createAnalysisContext(config).project();
  assert.equal(after.cache.status, "miss");
  assert.deepEqual(after.tsProject.diagnostics, []);
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
}));

test("cache invalidates newly installed automatic type packages", () => fixture((root, config) => {
  config.cache.enabled = true;
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, types: ["*"] }, include: ["src"],
  }));
  fs.mkdirSync(path.join(root, "node_modules/@types"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = installedGlobal;\n");
  assert.ok(createAnalysisContext(config).project().tsProject.diagnostics.some((item) => item.code === 2304));
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
  fs.mkdirSync(path.join(root, "node_modules/@types/installed"));
  fs.writeFileSync(path.join(root, "node_modules/@types/installed/index.d.ts"), "declare const installedGlobal: number;\n");
  const after = createAnalysisContext(config).project();
  assert.equal(after.cache.status, "miss");
  assert.deepEqual(after.tsProject.diagnostics, []);
}));

test("cache fingerprints package manifests used in module resolution", () => fixture((root, config) => {
  config.cache.enabled = true;
  const dependency = path.join(root, "node_modules/dependency");
  fs.mkdirSync(dependency, { recursive: true });
  const manifest = path.join(dependency, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "dependency", types: "number.d.ts" }));
  fs.writeFileSync(path.join(dependency, "number.d.ts"), "export declare const value: number;\n");
  fs.writeFileSync(path.join(dependency, "string.d.ts"), "export declare const value: string;\n");
  fs.writeFileSync(path.join(root, "src/a.ts"), 'import { value } from "dependency"; export const a: number = value;\n');
  assert.deepEqual(createAnalysisContext(config).project().tsProject.diagnostics, []);
  assert.equal(createAnalysisContext(config).project().cache.status, "hit");
  fs.writeFileSync(manifest, JSON.stringify({ name: "dependency", types: "string.d.ts" }));
  const after = createAnalysisContext(config).project();
  assert.equal(after.cache.status, "miss");
  assert.ok(after.tsProject.diagnostics.some((item) => item.code === 2322));
}));

test("artifact freshness covers tests, analysis identity, and external runtime evidence", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "// initial test\n");
  const before = sourceSetHash(createAnalysisContext(config).project());
  fs.writeFileSync(path.join(root, "src/a.test.ts"), "// modified test\n");
  const after = sourceSetHash(createAnalysisContext(config).project());
  assert.notEqual(before, after);
  const runtime = path.join(root, "axe.json");
  config.runtimeInputs.axe = runtime;
  fs.writeFileSync(runtime, JSON.stringify({ violations: [] }));
  const input = artifactBase(config, "quality.runtime", "test", {}, after);
  assert.equal(artifactFreshness(config, { runtime: input }, after).runtime, "available");
  fs.writeFileSync(runtime, JSON.stringify({ violations: [], url: "changed" }));
  assert.equal(artifactFreshness(config, { runtime: input }, after).runtime, "stale");
  const current = artifactBase(config, "quality.runtime", "test", {}, after);
  config.react.ruleset = "classic-v1";
  assert.equal(artifactFreshness(config, { runtime: current }, after).runtime, "stale");
}));

test("semantic identities survive movement and preserve duplicate occurrences", () => fixture((root, config) => {
  const file = "src/a.ts";
  const text = "export function first() { missing(); }\nexport function second() { missing(); }\n";
  fs.writeFileSync(path.join(root, file), text);
  const finding = { id: "legacy", file, source: "typescript-compiler", rule_id: "typescript/TS2304", message: "Cannot find name missing", column: 27 };
  const records = [1, 2].map((line) => ({ ...finding, line }));
  const initial = normalizeFindingIdentities(config, records);
  fs.writeFileSync(path.join(root, file), `// inserted comment\n\n${text}`);
  const moved = normalizeFindingIdentities(config, records.map((record) => ({ ...record, line: record.line + 2 })));
  const ids = (values: unknown[]) => values.map((value) => (value as { id: string }).id);
  assert.deepEqual(ids(initial), ids(moved));
  assert.equal(new Set(ids(initial)).size, 2);
  const duplicate = normalizeFindingIdentities(config, [{ ...finding, line: 3 }, { ...finding, line: 3 }]);
  assert.equal(new Set(ids(duplicate)).size, 2);
}));

test("snapshot matching includes new errors in unchanged consumers and does not reintroduce existing issues", () => fixture((_root, config) => {
  config.policy.requiredChecks = ["typed-lint"];
  writeArtifact(config, "lint_health.json", { ...artifact("quality.lint"), records: [
    { id: "old", file: "src/a.ts", line: 1, disposition: "block" },
    { id: "new-consumer", file: "src/consumer.ts", line: 1, disposition: "block" },
  ] });
  const findings = collectFindings(config, {
    changedFiles: ["src/a.ts"], changedLines: new Map([["src/a", [{ start: 1, end: 1 }]]]),
    baselineIds: new Set(), baseFindingIds: new Set(["old"]), diffAvailable: true,
  });
  assert.equal(findings.find((finding) => finding.id === "old")?.introduced, false);
  assert.equal(findings.find((finding) => finding.id === "new-consumer")?.introduced, true);
}));

test("persisted compiler diagnostics have unique occurrence identities", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/a.ts"), "missing();\nmissing();\n");
  runMeasure(config, "quality.type_health", "test");
  const records = readArtifact(config, "type_health.json")?.records?.filter((record) => record.diagnostic_code === 2304) ?? [];
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.id)).size, 2);
}));
