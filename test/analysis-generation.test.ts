import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureCorrectnessCatalog } from "../src/measures/correctness.js";
import { measureRuntime } from "../src/measures/runtime.js";
import { typescriptFixture } from "./project-fixture.js";

test("analysis fingerprints are shared within a generation and refresh source and dependency inputs", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/a.ts"), 'import type { Value } from "./value.js"; export const a: Value = 1;');
  const dependency = path.join(root, "src/value.d.ts");
  fs.writeFileSync(dependency, "export type Value = number;");
  config.cache.enabled = false;
  const context = createAnalysisContext(config);
  const hash = context.sourceHash(), identity = context.identity();
  const program = context.syntaxProgram(), manifest = context.workspaceManifest(".");
  assert.equal(context.syntaxProgram(), program);
  assert.equal(context.workspaceManifest("missing"), null);
  fs.mkdirSync(path.join(root, "missing"));
  fs.writeFileSync(path.join(root, "missing/package.json"), '{"name":"added"}');
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"changed","type":"module"}');
  fs.writeFileSync(dependency, "export type Value = string;");
  fs.appendFileSync(config.configPath, "\n");
  assert.equal(context.sourceHash(), hash);
  assert.equal(context.identity(), identity);
  assert.equal(measureRuntime(config, "generation", context).provenance.source_set_hash, hash);
  assert.equal(context.workspaceManifest("."), manifest);
  assert.equal(context.workspaceManifest("missing"), null);
  context.refresh();
  assert.notEqual(context.syntaxProgram(), program);
  assert.equal(context.workspaceManifest(".")?.name, "changed");
  assert.equal(context.workspaceManifest("missing")?.name, "added");
  assert.notEqual(context.sourceHash(), hash);
  assert.notEqual(context.identity().id, identity.id);
  assert.ok(context.project().tsProject.diagnostics.length > 0);
}));

test("test commands invalidate analysis while retaining the tested input identity", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;");
  config.cache.enabled = false;
  config.testCommand = `node -e "require('node:fs').writeFileSync('src/a.ts', 'export const a = 2;')"`;
  const context = createAnalysisContext(config), before = context.sourceHash();
  const artifact = measureCorrectnessCatalog(config, "mutating test", true, context);
  assert.equal(artifact.execution?.status, "passed");
  assert.equal(artifact.provenance.source_set_hash, before);
  assert.notEqual(context.sourceHash(), before);
  assert.match(context.project().modules[0]?.text ?? "", /a = 2/);
}));
