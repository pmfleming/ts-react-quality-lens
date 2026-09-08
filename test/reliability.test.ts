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
import { writeArtifact } from "../src/writer.js";
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
