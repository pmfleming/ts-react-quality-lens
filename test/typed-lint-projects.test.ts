import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { runTypedLint } from "../src/integrations/eslint-adapter.js";
import { runMeasure } from "../src/measure-runner.js";
import { requiredEvidenceReasons } from "../src/audit/findings.js";
import { readArtifact } from "../src/writer.js";
import type { Config } from "../src/types.js";

const options = { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" };
const unsafe = "export function read(value: any) { return value.name; }\n";

function write(root: string, file: string, value: object | string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
}

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-typed-projects-"));
  write(root, "package.json", { name: "typed-projects", type: "module" });
  write(root, "tsconfig.json", { compilerOptions: options, include: ["src"] });
  write(root, "src/index.ts", unsafe);
  write(root, "ts-react-quality-lens.config.json", {
    source_roots: ["src"], cache: { enabled: false }, policy: { required_checks: ["typed-lint"] },
  });
  try { run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("project service and explicit project mode agree on conventional typed findings", () => fixture((_root, config) => {
  const service = runTypedLint(config);
  assert.equal(service.project_mode, "project-service");
  assert.equal(service.complete, true, service.reason ?? JSON.stringify(service.messages));
  assert.ok(service.messages.some((message) => message.rule_id === "@typescript-eslint/no-unsafe-return"));
  config.typedLint.mode = "project";
  const explicit = runTypedLint(config);
  assert.equal(explicit.complete, true, explicit.reason ?? JSON.stringify(explicit.messages));
  assert.equal(explicit.configured_project, "tsconfig.json");
  assert.deepEqual(service.messages, explicit.messages);
}));

test("project service covers child projects with references and without a root tsconfig", () => fixture((root, config) => {
  write(root, "package.json", { name: "typed-workspace", type: "module", workspaces: ["packages/*"] });
  write(root, "tsconfig.json", { files: [], references: [{ path: "packages/a" }, { path: "packages/b" }] });
  for (const name of ["a", "b"]) {
    write(root, `packages/${name}/package.json`, { name, type: "module" });
    write(root, `packages/${name}/tsconfig.json`, { compilerOptions: { ...options, composite: true }, include: ["src"] });
    write(root, `packages/${name}/src/index.ts`, unsafe);
  }
  config.sourceRoots = [path.join(root, "packages")];
  for (const rootConfig of [true, false]) {
    if (!rootConfig) {
      fs.unlinkSync(path.join(root, "tsconfig.json"));
      config.tsconfig = null;
    }
    const result = runTypedLint(config);
    assert.equal(result.project_mode, "project-service");
    assert.equal(result.complete, true, result.reason ?? JSON.stringify(result.messages));
    const files = new Set(result.messages.filter((message) => message.rule_id === "@typescript-eslint/no-unsafe-return").map((message) => message.file));
    assert.deepEqual([...files].sort(), ["packages/a/src/index.ts", "packages/b/src/index.ts"]);
  }
}));

test("auto preserves custom tsconfig scope and project service reports uncovered files", () => fixture((root, config) => {
  write(root, "tsconfig.json", { compilerOptions: options, include: ["src/index.ts"] });
  write(root, "src/extra.ts", unsafe);
  write(root, "tsconfig.lint.json", { compilerOptions: options, include: ["src"] });
  config.tsconfig = path.join(root, "tsconfig.lint.json");
  const custom = runTypedLint(config);
  assert.equal(custom.project_mode, "project");
  assert.equal(custom.configured_project, "tsconfig.lint.json");
  assert.equal(custom.complete, true, custom.reason ?? JSON.stringify(custom.messages));
  assert.ok(custom.messages.some((message) => message.file === "src/extra.ts" && message.rule_id === "@typescript-eslint/no-unsafe-return"));
  config.typedLint.mode = "project-service";
  runMeasure(config, "quality.lint", "test project-service coverage");
  const artifact = readArtifact(config, "lint_health.json");
  assert.equal(artifact?.tool_status?.typed_eslint?.project_mode, "project-service");
  assert.equal(artifact?.tool_status?.typed_eslint?.complete, false);
  assert.ok(artifact?.records?.some((record) => record.rule_id === "eslint/parser" && record.file === "src/extra.ts"));
  assert.ok(requiredEvidenceReasons(config).some((reason) => reason.includes("type-aware ESLint")));
}));

test("missing configuration and source roots cannot produce clean typed evidence", () => fixture((root, config) => {
  config.sourceRoots = [path.join(root, "missing")];
  let result = runTypedLint(config);
  assert.equal(result.ran, false);
  assert.equal(result.complete, false);
  assert.match(result.reason ?? "", /source roots/);
  config.sourceRoots = [path.join(root, "src")];
  fs.unlinkSync(path.join(root, "tsconfig.json"));
  result = runTypedLint(config);
  assert.equal(result.complete, false);
  assert.match(result.reason ?? "", /tsconfig/);
}));

test("typed lint mode is validated and defaults to auto", () => fixture((root, config) => {
  assert.equal(config.typedLint.mode, "auto");
  write(root, "ts-react-quality-lens.config.json", { typed_lint: { mode: "project-service" } });
  assert.equal(loadConfig(config.configPath).typedLint.mode, "project-service");
  write(root, "ts-react-quality-lens.config.json", { typed_lint: { mode: "guess" } });
  assert.throws(() => loadConfig(config.configPath), /Invalid config/);
}));
