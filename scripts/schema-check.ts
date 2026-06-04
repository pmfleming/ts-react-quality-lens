import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  "suppressions",
  "audit",
]) {
  assert.ok(configProperties[key], `config schema is missing ${key}`);
}

assert.ok(packageJson.files.includes("ts-react-quality-lens.schema.json"), "package files must include artifact schema");
assert.ok(packageJson.files.includes("ts-react-quality-lens.config.schema.json"), "package files must include config schema");

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
