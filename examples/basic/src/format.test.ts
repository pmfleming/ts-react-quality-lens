import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTotal } from "./format";

test("formats dollars", () => {
  assert.equal(formatTotal(12), "$12.00");
});
