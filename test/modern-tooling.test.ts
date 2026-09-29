import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ts from "typescript";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/measure-runner.js";
import { analysisIdentity, compilerProvenance } from "../src/provenance.js";
import { readArtifact } from "../src/writer.js";
import type { Config } from "../src/types.js";

export function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-modern-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "modern", type: "module" }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"],
  }));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a: string = 123;\n");
  fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), JSON.stringify({
    source_roots: ["src"], cache: { enabled: false }, cleanup: { knip: false }, policy: { required_checks: [] },
  }));
  try { run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("compiler evidence identifies the API that ran without claiming native analysis", () => fixture((_root, config) => {
  runMeasure(config, "quality.type_health", "test");
  const artifact = readArtifact(config, "type_health.json");
  assert.ok(artifact);
  const compilers = compilerProvenance();
  assert.equal(compilers.analysis.version, ts.version);
  assert.equal(compilers.native.analysis_executed, false);
  assert.deepEqual(artifact.provenance.compilers, compilers);
  assert.equal(artifact.tool_status?.compiler_api?.loaded, true);
  const diagnostic = artifact.records?.find((record) => record.rule_id === "typescript/TS2322");
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic.compiler, compilers.analysis);
  assert.equal(analysisIdentity(config).compiler_api_version, ts.version);
  assert.equal(analysisIdentity(config).integration_versions.typescript_native, compilers.native.version);
  const schema: unknown = JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema as object);
  assert.ok(validate(artifact), JSON.stringify(validate.errors));
}));

test("invalid compiler configuration retains engine provenance and failed load status", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"invalidOption":true}}');
  runMeasure(config, "quality.type_health", "test");
  const artifact = readArtifact(config, "type_health.json");
  assert.equal(artifact?.tool_status?.compiler_api?.loaded, false);
  assert.equal(artifact?.tool_status?.compiler_api?.version, ts.version);
  assert.ok(artifact?.records?.some((record) => record.rule_id === "typescript/TS5023"));
}));
