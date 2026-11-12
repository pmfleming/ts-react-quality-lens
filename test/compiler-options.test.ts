import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compilerOptionSummary, STRICT_OPTIONS } from "../src/compiler-options.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { measureTypeHealth } from "../src/measures/type-quality.js";

test("compiler posture respects explicit false and analysis-compiler defaults", () => {
  const defaults = compilerOptionSummary({});
  assert.ok(STRICT_OPTIONS.every((key) => defaults[key] === true));
  assert.equal(defaults.noUncheckedSideEffectImports, true);
  const overrides = compilerOptionSummary({ strict: true, strictNullChecks: false, noImplicitAny: false, useUnknownInCatchVariables: false });
  assert.equal(overrides.strictNullChecks, false);
  assert.equal(overrides.noImplicitAny, false);
  assert.equal(overrides.useUnknownInCatchVariables, false);
  assert.equal(overrides.strictFunctionTypes, true);
  assert.equal(compilerOptionSummary({ composite: true }).declaration, true);
});

test("posture evaluates each inherited workspace config and abstains for missing configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-posture-"));
  const write = (file: string, content: object | string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  };
  try {
    write("package.json", { name: "posture", workspaces: ["packages/*"] });
    write("base.json", { compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } });
    write("tsconfig.json", { files: [], references: [{ path: "packages/a" }, { path: "packages/b" }] });
    for (const name of ["a", "b"]) {
      write(`packages/${name}/package.json`, { name, type: "module" });
      write(`packages/${name}/src/main.ts`, "export const value = 1;\n");
    }
    write("packages/a/tsconfig.json", { extends: "../../base.json", compilerOptions: { noImplicitAny: false }, include: ["src"] });
    write("packages/b/tsconfig.json", { extends: "../../base.json", compilerOptions: { strict: false,
      ...Object.fromEntries(STRICT_OPTIONS.map((key) => [key, true])) }, include: ["src"] });
    write("lens.json", { source_roots: ["packages"], policy: { profile: "recommended" }, cache: { enabled: false } });
    const config = loadConfig(path.join(root, "lens.json"));
    const context = createAnalysisContext(config);
    const projects = context.project().tsProject.project_configs!;
    assert.equal(projects.find((p) => p.tsconfig === "packages/a/tsconfig.json")?.compiler_options?.noImplicitAny, false);
    const records = measureTypeHealth(config, "per-project posture", context).records!.filter((r) => r.kind === "type_safety_posture");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.tsconfig, "packages/a/tsconfig.json");
    assert.match(String(records[0]?.message), /noImplicitAny/);
    write("packages/a/tsconfig.json", "{ invalid");
    const unavailable = measureTypeHealth(config, "missing posture");
    assert.ok(!unavailable.records?.some((r) => r.kind === "type_safety_posture"));
    assert.equal(unavailable.confidence.typescript_program_loaded, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
