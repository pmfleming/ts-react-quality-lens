import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord, parseJson } from "../src/collections.js";
import { TASKS } from "../src/tasks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactSchema = requiredRecord(readJson(path.join(root, "ts-react-quality-lens.schema.json")), "artifact schema");
const configSchema = requiredRecord(readJson(path.join(root, "ts-react-quality-lens.config.schema.json")), "config schema");
const packageJson = requiredRecord(readJson(path.join(root, "package.json")), "package manifest");
const artifactProperties = requiredRecord(artifactSchema.properties, "artifact schema properties");
const taskIdSchema = requiredRecord(artifactProperties.task_id, "artifact task id schema");
const taskEnum = stringArray(taskIdSchema.enum);
assert.ok(taskEnum, "artifact schema must expose properties.task_id.enum");
for (const task of TASKS) {
  assert.ok(taskEnum.includes(task.id), `artifact schema is missing task id ${task.id}`);
}
assert.ok(taskEnum.includes("audit"), "artifact schema is missing audit task id");
assert.ok(taskEnum.includes("context.project"), "artifact schema is missing context.project task id");

const configProperties = requiredRecord(configSchema.properties, "config schema properties");
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
  "cleanup",
  "type_coverage",
  "package_health",
  "sarif_inputs",
  "workspaces",
  "runtime_inputs",
  "policy",
  "suppressions",
  "audit",
]) {
  assert.ok(configProperties[key], `config schema is missing ${key}`);
}

const packageFiles = stringArray(packageJson.files) ?? [];
const dependencies = requiredRecord(packageJson.dependencies, "package dependencies");
assert.ok(packageFiles.includes("ts-react-quality-lens.schema.json"), "package files must include artifact schema");
assert.ok(packageFiles.includes("ts-react-quality-lens.config.schema.json"), "package files must include config schema");
assert.ok(packageFiles.includes("rule-contracts.json"), "package files must include rule contracts");
assert.ok(packageFiles.includes("rule-contracts.schema.json"), "package files must include rule contract schema");
for (const runtimeDependency of [
  "ajv",
  "@arethetypeswrong/cli",
  "publint",
  "typescript",
  "eslint",
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react-hooks",
  "jscpd",
  "knip",
  "dependency-cruiser",
]) {
  assert.ok(dependencies[runtimeDependency], `package dependencies must include ${runtimeDependency}`);
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
    analysis_identity: {
      id: "sha256:fixture",
      schema_version: "0.3.0",
      compiler_api_version: "6.0.3",
      config_closure_hash: "sha256:config",
      rulesets: { react: "recommended-v2" },
      integration_versions: { typescript_eslint: "8.67.0" },
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
      column: 1,
      end_line: 1,
      end_column: 8,
      related_locations: [{ file: "src/related.ts", start_line: 2, role: "related" }],
      fix_group_id: "fixture:group",
      estimated_effort: 15,
      semantic_decision: "unresolved",
      reason_code: "fixture/finding",
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
    cleanup: { knip: true, production: false },
    type_coverage: {
      minimum_percent: 90,
      per_file_minimum_percent: 80,
      changed_file_minimum_percent: 95,
      baseline: "target/baselines/type_health.json",
    },
    package_health: { enabled: true, attw_profile: "strict" },
    sarif_inputs: [{ path: "target/codeql.sarif", name: "codeql", required: false }],
    workspaces: {
      enabled: true,
      patterns: ["packages/*"],
      overrides: [{ workspace: "@scope/app", framework: "react", policy_profile: "strict" }],
    },
    runtime_inputs: {
      react_profiler: "target/profiler.json",
      axe: "target/axe.json",
      react_doctor: "target/react-doctor.json",
    },
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

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function readJson(file: string): unknown {
  return parseJson(fs.readFileSync(file, "utf8"));
}
