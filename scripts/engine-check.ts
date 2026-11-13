import assert from "node:assert/strict";
import fs from "node:fs";
import semver from "semver";
import { isRecord, parseJson } from "../src/collections.js";

// The declared Node range is a promise to consumers: every installed production package must accept all of it.
// This is checked statically so dev-only tools with narrower engines cannot hide a runtime floor violation.
const manifest = parseJson(fs.readFileSync("package.json", "utf8"));
const lock = parseJson(fs.readFileSync("package-lock.json", "utf8"));
assert.ok(isRecord(manifest) && isRecord(manifest.engines) && typeof manifest.engines.node === "string", "package.json must declare engines.node");
assert.ok(isRecord(lock) && isRecord(lock.packages), "package-lock.json must contain a packages map");
const declared = manifest.engines.node;
assert.ok(semver.validRange(declared), `engines.node is not a valid range: ${declared}`);

const violations: string[] = [];
let checked = 0;
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || !isRecord(entry) || entry.dev === true) continue;
  const engines = entry.engines;
  const required = isRecord(engines) && typeof engines.node === "string" ? engines.node : null;
  if (!required) continue;
  checked += 1;
  if (!semver.validRange(required) || !semver.subset(declared, required)) {
    violations.push(`${location.replace(/^.*node_modules\//, "")} requires node ${required}`);
  }
}
assert.deepEqual(violations, [], `engines.node "${declared}" admits Node versions that production dependencies reject:\n${violations.join("\n")}`);
console.log(JSON.stringify({ engine_check: "passed", declared, production_packages_with_engines: checked }, null, 2));
