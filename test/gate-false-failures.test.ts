import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { requiredVerificationFailures } from "../src/audit/findings.js";
import { loadConfig } from "../src/config.js";
import { runTestCommand } from "../src/correctness.js";
import { runReactSyntaxLint, runTypedLint } from "../src/integrations/eslint-adapter.js";
import { toolError, toolRunOptions } from "../src/integrations/tool-runner.js";
import { measureTypeHealth } from "../src/measures/type-quality.js";
import { typescriptFixture } from "./project-fixture.js";

test("project ESLint directives and JavaScript JSX cannot make managed lint incomplete or invent findings", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/log.ts"), [
    "export function log(message: string): void {",
    "  // eslint-disable-next-line no-console",
    "  console.log(message);",
    "}",
    "// eslint-disable-next-line react-hooks/exhaustive-deps",
    "export const unrelated = 1;",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src/clean.ts"), "export const clean: number = 1;\n");
  fs.writeFileSync(path.join(root, "src/legacy.js"), "export const view = () => <div />;\n");

  const typed = runTypedLint(config);
  assert.equal(typed.ran, true, typed.reason ?? "");
  assert.equal(typed.complete, true, "an unused or unloaded-plugin directive is not an unevaluated file");
  assert.deepEqual(typed.evaluated_files, ["src/clean.ts", "src/log.ts"], "typed lint is scoped to TypeScript");
  assert.deepEqual(typed.messages, []);

  const { hooks } = runReactSyntaxLint(config);
  assert.equal(hooks.complete, true, hooks.reason ?? "");
  assert.ok(hooks.evaluated_files?.includes("src/log.ts"));
  assert.ok(!hooks.messages.some((message) => /Definition for rule/.test(message.message)));
}));

test("TypeScript 6 option deprecations are non-blocking warnings, not compile failures", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "commonjs", moduleResolution: "node", baseUrl: ".", paths: { "@/*": ["src/*"] } },
    include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a: number = 1;\n");
  const fresh = loadConfig(config.configPath);
  const artifact = measureTypeHealth(fresh, "test deprecations", createAnalysisContext(fresh));
  const deprecations = (artifact.records ?? []).filter((record) => ["typescript/TS5101", "typescript/TS5107"].includes(String(record.rule_id)));
  assert.deepEqual(deprecations.map((record) => record.rule_id).sort(), ["typescript/TS5101", "typescript/TS5107"]);
  for (const record of deprecations) {
    assert.equal(record.disposition, "warn");
    assert.match(String(record.classification_limitation), /still functions/);
  }
  assert.ok(fresh.policy.requiredChecks.includes("compiler"));
  assert.deepEqual(requiredVerificationFailures(fresh), [], "deprecations do not fail required compiler verification");
}));

test("the test command time limit is configurable and enforced", () => typescriptFixture((root, config) => {
  assert.equal(config.testTimeoutMs, 120000, "default");
  fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], test_timeout_ms: 1000,
    test_command: `"${process.execPath}" -e "setTimeout(() => {}, 15000)"` }));
  const limited = loadConfig(path.join(root, "lens.json"));
  assert.equal(limited.testTimeoutMs, 1000);
  const started = Date.now();
  const execution = runTestCommand(limited);
  assert.equal(execution.status, "failed");
  assert.ok(Date.now() - started < 10000, "the configured limit, not the default, ended the command");
  fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ test_timeout_ms: 10 }));
  assert.throws(() => loadConfig(path.join(root, "lens.json")), /test_timeout_ms/);
}));

test("tool output is not capped at Node's 1 MiB default and an overflow is reported as such", () => typescriptFixture((_root, config) => {
  assert.ok(Number(toolRunOptions(config).maxBuffer) >= 256 * 1024 * 1024);
  const overflow = Object.assign(new Error("spawnSync eslint ENOBUFS"), { code: "ENOBUFS", stdout: '[{"filePath":"partial' });
  assert.match(toolError(overflow), /exceeded .* bytes \(ENOBUFS\)/);
}));
