import assert from "node:assert/strict";
import test from "node:test";
import { arrayOf, boolean, count, finite, integer, nonempty, nonnegative, nullable, oneOf, optional, positiveInteger, shape, string } from "../src/validation.js";
import { artifactFindings } from "../src/findings.js";
import { toolError, toolResult } from "../src/integrations/tool-runner.js";

test("boundary validators narrow without coercion, accepting extensions but not malformed fields", () => {
  const schema = shape({ name: nonempty, hits: arrayOf(count), note: optional(nullable(string)), kind: oneOf("a", "b"), enabled: boolean });
  const valid = { name: "probe", hits: [0, Number.MAX_SAFE_INTEGER], kind: "a", enabled: false, extension: { retained: true } };
  assert.ok(schema(valid));
  assert.ok(schema({ ...valid, note: null }));
  assert.ok(schema({ ...valid, note: "" }));
  for (const value of [null, [], {}, { ...valid, name: " " }, { ...valid, hits: [1.5] }, { ...valid, note: 1 },
    { ...valid, kind: { toString: () => "a" } }, { ...valid, enabled: "false" }, { ...valid, hits: [Number.MAX_SAFE_INTEGER + 1] }]) {
    assert.equal(schema(value), false);
  }
  for (const value of [NaN, Infinity, -Infinity, "1", null, undefined]) {
    assert.equal(finite(value), false);
    assert.equal(integer(value), false);
  }
  assert.ok(finite(-1.5));
  assert.ok(integer(-1));
  assert.equal(nonnegative(-1), false);
  assert.equal(positiveInteger(0), false);
  assert.equal(nullable(string)(undefined), false);
  assert.equal(optional(string)(null), false);
  assert.deepEqual(valid.extension, { retained: true });
});

test("shared tool status and diagnostic fallbacks preserve failure details", () => {
  const error = { stderr: "  failure  ", stdout: "ignored", toString() { throw new Error("must not stringify when diagnostics exist"); } };
  assert.equal(toolError(error), "failure");
  assert.equal(toolError({ stdout: "output" }), "output");
  assert.equal(toolError(new Error("message")), "message");
  assert.equal(toolError("x".repeat(5000)).length, 4000);
  const status = toolResult(false, false, "missing", Date.now(), { complete: false, records: [] });
  assert.equal(status.reason, "missing");
  assert.equal(status.available, false);
  assert.equal(status.ran, false);
  assert.equal(status.complete, false);
  assert.ok(status.duration_ms >= 0);
});

test("shared finding extraction keeps legacy ordering and callback compatibility", () => {
  const artifact = { records: [{ id: "record" }, null, {}], findings: [{ id: "finding" }], groups: "malformed", disagreements: [{ id: "disagreement" }] };
  assert.deepEqual(artifactFindings(artifact).map((item) => item.id), ["finding", "record", "disagreement"]);
  assert.deepEqual([artifact].flatMap(artifactFindings), artifactFindings(artifact));
  assert.deepEqual(artifactFindings(null), []);
});
