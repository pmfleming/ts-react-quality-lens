import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isWireEvidence } from "../src/wire-evidence.js";
import { validCapabilityEvidence } from "../src/capability-evidence.js";

// Explicit local integration profile. Never fetch, install or change the sibling checkout.
const sibling = path.resolve(process.argv[2] ?? "../qmlqualitylens");
const qmlWire = await import(pathToFileURL(path.join(sibling, "dist/src/wire-evidence.js")).href);
const qmlCapability = await import(pathToFileURL(path.join(sibling, "dist/src/capability-evidence.js")).href);
let observations = 0;
for (const root of [process.cwd(), sibling]) {
  const wire = JSON.parse(fs.readFileSync(path.join(root, "contracts/wire-cases.json"), "utf8"));
  const capabilities = JSON.parse(fs.readFileSync(path.join(root, "contracts/capability-cases.json"), "utf8")).cases;
  for (const item of wire) {
    assert.equal(isWireEvidence(item.value), item.valid, item.id);
    assert.equal(qmlWire.isWireEvidence(item.value), item.valid, item.id);
    observations += 2;
  }
  for (const item of capabilities) {
    assert.equal(validCapabilityEvidence(item.value), item.valid);
    assert.equal(qmlCapability.validCapabilityEvidence(item.value), item.valid);
    observations += 2;
  }
}
const revision = childProcess.execFileSync("git", ["-C", sibling, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ profile: "TS/QML shared v1 wire and capability conformance", sibling_revision: revision, observations, status: "passed" }, null, 2));
