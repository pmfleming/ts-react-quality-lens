import assert from "node:assert/strict";
import fs from "node:fs";
import { typescriptFixture } from "./project-fixture.js";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { compilerTargetEvidence } from "../src/compiler-targets.js";
import type { CompilerTarget } from "../src/types.js";

test("compiler guidance uses declared runtime environments and compiler-implied defaults", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/main.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
  const configure = (options: object, environment?: CompilerTarget["environment"]) => {
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: options, include: ["src"] }));
    const config = loadConfig(path.join(root, "lens.json"));
    if (environment) config.typescript.targets = [{ tsconfig: "tsconfig.json", environment }];
    return compilerTargetEvidence(config, createAnalysisContext(config).project());
  };
  const unknown = configure({ module: "ESNext", moduleResolution: "Bundler" });
  assert.equal(unknown.report.contexts[0]?.status, "unknown");
  assert.equal(unknown.records.length, 0);
  const node = configure({ module: "NodeNext" }, "node");
  assert.equal(node.report.contexts[0]?.status, "evaluated");
  assert.equal(node.records.length, 0, "NodeNext implies its resolution mode");
  assert.ok(configure({ module: "ESNext", moduleResolution: "Bundler" }, "node").records.some((r) => r.rule_id?.endsWith("node-module-model")));
  const bundler = configure({ module: "ESNext", moduleResolution: "Bundler" }, "bundler");
  assert.deepEqual(bundler.records.map((r) => r.rule_id?.split("/")[1]).sort(), ["duplicate-emit", "isolated-transpilation"]);
  assert.equal(configure({ module: "ESNext", moduleResolution: "Bundler", noEmit: true, verbatimModuleSyntax: true }, "bundler").records.length, 0);
  const library = configure({ module: "ESNext", moduleResolution: "Bundler" }, "library");
  assert.equal(library.records.length, 4);
  assert.ok(library.records.every((r) => r.disposition === "review" && r.semantic_decision === "unresolved"));
  assert.equal(configure({ module: "Node18", target: "ES2020", declaration: true, outDir: "dist" }, "library").records.length, 0);
  assert.equal(configure({ module: "ESNext", moduleResolution: "Bundler" }, "browser").records.length, 1);
  config.typescript.targets = [{ tsconfig: "missing.json", environment: "node" }];
  const missing = compilerTargetEvidence(config, createAnalysisContext(config).project());
  assert.equal(missing.report.contexts.find((c) => c.tsconfig === "missing.json")?.status, "unavailable");
  assert.equal(missing.records.length, 0);
  for (const targets of [[{ tsconfig: "../escape.json", environment: "node" }],
    [{ tsconfig: "tsconfig.json", environment: "node" }, { tsconfig: "./tsconfig.json", environment: "bundler" }]]) {
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ typescript: { targets } }));
    assert.throws(() => loadConfig(path.join(root, "lens.json")));
  }
}));
