import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord } from "../src/collections.js";
import { TASKS } from "../src/tasks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactSchema = readJson(path.join(root, "ts-react-quality-lens.schema.json"));
const configSchema = readJson(path.join(root, "ts-react-quality-lens.config.schema.json"));
const packageJson = readJson(path.join(root, "package.json"));

const taskEnum = artifactSchema.properties?.task_id?.enum;
assert.ok(Array.isArray(taskEnum), "artifact schema must expose properties.task_id.enum");
for (const task of TASKS) {
  assert.ok(taskEnum.includes(task.id), `artifact schema is missing task id ${task.id}`);
}
assert.ok(taskEnum.includes("audit"), "artifact schema is missing audit task id");
assert.ok(taskEnum.includes("context.project"), "artifact schema is missing context.project task id");

const configProperties = configSchema.properties ?? {};
for (const key of [
  "$schema",
  "project_name",
  "project_root",
  "source_roots",
  "test_roots",
  "output_dir",
  "tsconfig",
  "package_manager",
  "framework",
  "test_runner",
  "test_command",
  "exclude",
  "layer_rules",
  "performance_inputs",
  "public_api",
  "cache",
  "react",
  "accessibility",
  "policy",
  "suppressions",
  "audit",
]) {
  assert.ok(configProperties[key], `config schema is missing ${key}`);
}

assert.ok(packageJson.files.includes("ts-react-quality-lens.schema.json"), "package files must include artifact schema");
assert.ok(packageJson.files.includes("ts-react-quality-lens.config.schema.json"), "package files must include config schema");
assert.ok(packageJson.files.includes("rule-contracts.json"), "package files must include rule contracts");
assert.ok(packageJson.files.includes("rule-contracts.schema.json"), "package files must include rule contract schema");
for (const runtimeDependency of [
  "ajv",
  "typescript",
  "eslint",
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react-hooks",
  "jscpd",
  "dependency-cruiser",
]) {
  assert.ok(packageJson.dependencies?.[runtimeDependency], `package dependencies must include ${runtimeDependency}`);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
assertValid(ajv, artifactSchema, representativeArtifact(), "artifact schema must accept generated artifact shape");
assertValid(ajv, configSchema, representativeConfig(), "config schema must accept documented config shape");

function representativeArtifact() {
  return {
    schema_version: "0.3.0",
    task_id: "quality.hotspots",
    project: { name: "fixture", root: "/tmp/fixture", framework: "react", package_manager: "npm", test_runner: "node" },
    provenance: {
      lens: "ts-react-quality-lens",
      schema_version: "0.3.0",
      command: "schema-check",
      host: "schema-check",
      measured_at: new Date(0).toISOString(),
      source_type: "static",
      source_set_hash: "sha256:fixture",
    },
    confidence: {
      complete: false,
      partial: true,
      confidence_scope: "project_static_analysis",
      required_inputs: ["source_roots_exist"],
      observed_inputs: ["package_json_found"],
      missing_input: ["dependencies_installed"],
      stale_input: [],
      unsupported_pattern: [{ kind: "dynamic_non_literal_import", file: "src/index.ts", line: 1, message: "fixture" }],
    },
    summary: { records: 1 },
    records: [{
      id: "fixture:finding",
      rule_id: "fixture/finding",
      kind: "fixture",
      evidence_kind: "heuristic",
      disposition: "review",
      finding_confidence: "medium",
      message: "Fixture finding.",
      file: "src/index.ts",
      line: 1,
      score: 10,
      risk: "low",
    }],
  };
}

function representativeConfig() {
  return {
    project_name: "fixture",
    project_root: ".",
    source_roots: ["src"],
    test_roots: ["test"],
    output_dir: "target/analysis",
    framework: "auto",
    test_runner: "auto",
    test_command: null,
    public_api: { entry: ["src/index.ts"], exports: [{ file: "src/lib.ts", names: ["publicHelper"] }] },
    cache: { enabled: true },
    react: { ruleset: "recommended-v2" },
    accessibility: { enabled: true, components: { Image: "img" }, polymorphic_prop_name: "as" },
    policy: { profile: "recommended", required_checks: ["compiler", "typed-lint", "tests"] },
    suppressions: [{ id: "fixture:finding", reason: "schema fixture" }],
    audit: { base: "origin/main", gate: "new-only" },
  };
}

function assertValid(ajv: Ajv2020, schema: unknown, value: unknown, message: string): void {
  if (!isRecord(schema)) throw new Error(`${message}: schema must be an object`);
  const validate = ajv.compile(schema);
  assert.ok(validate(value), `${message}: ${ajv.errorsText(validate.errors)}`);
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
