import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { familyApplicability, fileRuleApplicability, validRuleApplicability } from "../src/rule-applicability.js";
import { BLOCKING_FAMILIES, BLOCKING_REACT_RULES, BLOCKING_TYPED_RULES, validateBlockingInventory } from "../src/rule-policy.js";
import type { Artifact } from "../src/types.js";

test("bounded family applicability has evaluated, unavailable and not-applicable controls for every family", () => {
  const config = loadConfig("examples/basic/ts-react-quality-lens.config.json");
  config.packageHealth.enabled = true;
  config.testCommand = "node --test";
  config.runtimeInputs.axe = "axe.json";
  config.sarifInputs = [{ name: "scanner", path: "scan.sarif", required: true }];
  const seen = new Set<string>();
  for (const task of ["quality.type_health", "correctness.all", "quality.package_health", "quality.sarif", "quality.runtime"]) {
    for (const complete of [false, true]) {
      const artifact = { task_id: task, confidence: { typescript_program_loaded: complete },
        execution: { status: complete ? "passed" : "unknown" }, summary: { complete, status: complete ? "complete" : "incomplete" },
        tool_status: Object.fromEntries(["publint", "are_the_types_wrong", "axe", "scanner"].map((name) => [name, { complete, required: true }])) } as unknown as Artifact;
      const entries = familyApplicability(config, artifact);
      assert.ok(entries.length);
      assert.ok(validRuleApplicability(entries, task));
      for (const entry of entries) {
        seen.add(entry.contract_id);
        assert.equal(entry.evaluated, complete ? 1 : 0);
        assert.equal(entry.abstained, complete ? 0 : 1);
        assert.equal(entry.status, complete ? "evaluated" : "unavailable");
      }
      if (task === "quality.type_health") continue; // selected compiler is never silently not-applicable
      const disabled = structuredClone(config);
      disabled.testCommand = null; disabled.packageHealth.enabled = false;
      disabled.runtimeInputs.axe = null; disabled.sarifInputs = [];
      assert.ok(familyApplicability(disabled, artifact).every((entry) => entry.status === "not_applicable" && entry.evaluated === 0));
    }
  }
  assert.deepEqual([...seen].sort(), [...BLOCKING_FAMILIES].sort());
});

test("new enabled blockers without contracts fail the inventory gate", () => {
  const ids = [...BLOCKING_TYPED_RULES, ...BLOCKING_REACT_RULES, ...BLOCKING_FAMILIES];
  validateBlockingInventory(ids);
  assert.throws(() => validateBlockingInventory(ids, [...ids, "future/blocker"]), /missing=future\/blocker/);
  assert.throws(() => validateBlockingInventory([...ids, ids[0]!]), /Duplicate/);
});

test("file applicability cannot substitute zero findings for evaluated scope", () => {
  const entries = fileRuleApplicability(["rule"], ["a.ts", "b.ts", "c.js"], ["a.ts", "outside.ts"], (file) => file.endsWith(".ts"));
  assert.equal(entries[0]?.status, "partial");
  assert.deepEqual([entries[0]?.evaluated, entries[0]?.abstained, entries[0]?.skipped], [1, 1, 1]);
  assert.ok(validRuleApplicability(entries, "fixture"));
  assert.equal(validRuleApplicability([...entries, ...entries], "fixture"), false);
  assert.equal(validRuleApplicability([{ ...entries[0], status: "evaluated" }], "fixture"), false);
  assert.equal(validRuleApplicability([], "quality.lint"), false);
});
