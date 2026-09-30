import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validCapabilityEvidence } from "../src/capability-evidence.js";

test("cross-lens capability conformance cases", () => {
  const corpus: { cases: Array<{ valid: boolean; value: unknown }> } = JSON.parse(fs.readFileSync("contracts/capability-cases.json", "utf8"));
  for (const item of corpus.cases) assert.equal(validCapabilityEvidence(item.value), item.valid, JSON.stringify(item.value));
});
