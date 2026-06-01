import { test } from "node:test";
import assert from "node:assert/strict";

function formatTotal(value) {
  if (value > 1000) {
    return `$${Math.round(value / 100) / 10}k`;
  }
  return `$${value.toFixed(2)}`;
}

test("formats dollars at runtime", () => {
  assert.equal(formatTotal(12), "$12.00");
});
