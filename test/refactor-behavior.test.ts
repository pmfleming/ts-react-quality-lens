import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/measure-runner.js";
import { auditVerdict, requiredVerificationFailures } from "../src/audit/findings.js";

const pairs: { before: string; equivalent: string; incorrect_smaller: string } = JSON.parse(fs.readFileSync("contracts/refactor-candidates.json", "utf8"));
const samples = [-Infinity, -11, -1, -0, 0, 1, 9, 10, 11, Infinity, NaN];

test("candidate refactors execute behavior checks rather than infer equivalence from syntax", () => {
  for (const value of samples) {
    const before = vm.runInNewContext(`(${pairs.before})(value)`, { value }, { timeout: 1000 });
    const after = vm.runInNewContext(`(${pairs.equivalent})(value)`, { value }, { timeout: 1000 });
    assert.ok(Object.is(before, after));
  }
  assert.ok(pairs.incorrect_smaller.length < pairs.before.length);
  assert.ok(!Object.is(vm.runInNewContext(`(${pairs.incorrect_smaller})(-0)`, {}, { timeout: 1000 }), -0));
});

test("actual required test execution rejects smaller broken code and a removed test runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-refactor-behavior-"));
  try {
    fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"behavior-fixture","type":"module"}');
    const source = path.join(root, "src/clamp.js");
    const runner = path.join(root, "test/behavior.mjs");
    fs.writeFileSync(runner, 'import assert from "node:assert/strict"; import { clamp } from "../src/clamp.js"; assert.ok(Object.is(clamp(-0), -0));\n');
    const file = path.join(root, "ts-react-quality-lens.config.json");
    fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], output_dir: "out", test_command: `${JSON.stringify(process.execPath)} test/behavior.mjs`, policy: { required_checks: ["tests"] }, cache: { enabled: false } }));
    const config = loadConfig(file);
    fs.writeFileSync(source, `export ${pairs.before}\n`);
    assert.equal(runMeasure(config, "correctness.all", "test")[0]?.execution?.status, "passed");
    fs.writeFileSync(source, `export ${pairs.incorrect_smaller}\n`);
    assert.equal(runMeasure(config, "correctness.all", "test")[0]?.execution?.status, "failed");
    assert.equal(auditVerdict([], [], requiredVerificationFailures(config)), "fail");
    fs.rmSync(runner);
    assert.equal(runMeasure(config, "correctness.all", "test")[0]?.execution?.status, "failed");
    assert.equal(auditVerdict([], [], requiredVerificationFailures(config)), "fail");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
