import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord, parseJson } from "../src/collections.js";
import { arrayOf, boolean, shape } from "../src/validation.js";
import { isWireEvidence } from "../src/wire-evidence.js";
import { validCapabilityEvidence } from "../src/capability-evidence.js";

type Check = (value: unknown) => unknown;
const callable = (value: unknown): value is Check => typeof value === "function";
async function siblingValidator(root: string, file: string, name: string): Promise<Check> {
  const module: unknown = await import(pathToFileURL(path.join(root, "dist/src", file)).href);
  assert.ok(isRecord(module));
  const validate = module[name];
  assert.ok(callable(validate), `Missing ${name} in ${file}`);
  return validate;
}

// Explicit local integration profile. Never fetch, install or change the sibling checkout.
const sibling = path.resolve(process.argv[2] ?? "../qmlqualitylens");
const profiles = [
  { file: "wire-cases.json", validators: [isWireEvidence, await siblingValidator(sibling, "wire-evidence.js", "isWireEvidence")] },
  { file: "capability-cases.json", validators: [validCapabilityEvidence, await siblingValidator(sibling, "capability-evidence.js", "validCapabilityEvidence")] },
];
const observations = [process.cwd(), sibling].reduce((total, root) => total + profiles.reduce((count, profile) => {
  const data = parseJson(fs.readFileSync(path.join(root, "contracts", profile.file), "utf8"));
  const cases = isRecord(data) ? data.cases : data;
  assert.ok(arrayOf(shape({ valid: boolean }))(cases));
  for (const item of cases) for (const validate of profile.validators) {
    assert.equal(validate(item.value), item.valid, `${profile.file}: ${String(item.id)}`);
  }
  return count + cases.length * profile.validators.length;
}, 0), 0);
const revision = childProcess.execFileSync("git", ["-C", sibling, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ profile: "TS/QML shared v1 wire and capability conformance", sibling_revision: revision, observations, status: "passed" }, null, 2));
