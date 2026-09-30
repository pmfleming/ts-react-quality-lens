import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isWireEvidence, validWireExtension } from "../src/wire-evidence.js";

test("shared run/finding/measurement/comparison wire cases validate at the native boundary", () => {
  const cases: Array<{ id: string; value: unknown; valid: boolean }> = JSON.parse(fs.readFileSync("contracts/wire-cases.json", "utf8"));
  for (const item of cases) {
    assert.equal(isWireEvidence(item.value), item.valid, item.id);
    assert.equal(validWireExtension([item.value]), item.valid, item.id);
  }
  assert.equal(validWireExtension(undefined), true, "legacy envelopes may omit the additive extension");
  assert.equal(validWireExtension(null), false, "an explicitly invalid extension is not absent evidence");
});
