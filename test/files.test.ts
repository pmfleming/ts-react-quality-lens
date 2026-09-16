import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { normalizeImportPath } from "../src/files.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-files-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "files-fixture" }));
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 1;\n");
  try { run(root, loadConfig(path.join(root, "lens.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("import resolution accepts exact aliases and empty wildcard matches without matching unrelated imports", () => fixture((root, config) => {
  config.pathAliases = [
    { pattern: "@app", replacements: [path.join(root, "missing.ts"), path.join(root, "src/index.ts")] },
    { pattern: "@src/*", replacements: [path.join(root, "src/*")] },
    { pattern: "@missing", replacements: [path.join(root, "missing.ts")] },
  ];
  const resolve = (specifier: string) => normalizeImportPath(path.join(root, "src/consumer.ts"), specifier, config);
  for (const specifier of ["@app", "@src/index", "@src/"]) {
    assert.deepEqual(resolve(specifier), { kind: "relative", id: "src/index", resolved: path.join(root, "src/index.ts") });
  }
  for (const specifier of ["@app/other", "@missing", "unrelated"]) {
    assert.deepEqual(resolve(specifier), { kind: "external", id: specifier, resolved: null });
  }
}));

test("exact tsconfig aliases produce internal graph edges on fresh and cached analysis", () => fixture((root) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, types: [], paths: { "@app": ["./src/index.ts"] } }, include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/consumer.ts"), 'import { value } from "@app"; export const result = value;\n');
  const config = loadConfig(path.join(root, "lens.json"));
  for (const status of ["miss", "hit"]) {
    const project = createAnalysisContext(config).project();
    assert.equal(project.cache.status, status);
    assert.deepEqual(project.tsProject.diagnostics, []);
    const edge = project.imports.find((item) => item.specifier === "@app");
    assert.ok(edge);
    assert.equal(edge.from, "src/consumer");
    assert.equal(edge.to, "src/index");
    assert.equal(edge.to_kind, "relative");
    assert.equal(edge.resolved, path.join(root, "src/index.ts"));
  }
}));
