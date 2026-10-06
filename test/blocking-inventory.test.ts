import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { enrichFinding } from "../src/actions.js";
import { BLOCKING_TYPED_RULES, blockingContract } from "../src/rule-policy.js";
import { measureLint } from "../src/measures/type-quality.js";

test("every enabled typed blocker has executed positive, negative and unavailable cases", () => {
  const corpus: { negative: string; cases: Array<{ id: string; positive: string }> } = JSON.parse(fs.readFileSync("contracts/typed-rule-cases.json", "utf8"));
  assert.deepEqual(corpus.cases.map((item) => item.id).sort(), [...BLOCKING_TYPED_RULES].sort());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-blocking-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"typed-corpus","type":"module"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }));
    const file = path.join(root, "lens.json");
    fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
    corpus.cases.forEach((item, index) => {
      fs.writeFileSync(path.join(root, `src/positive-${index}.ts`), item.positive);
      fs.writeFileSync(path.join(root, `src/negative-${index}.ts`), corpus.negative);
    });
    const config = loadConfig(file);
    const artifact = measureLint(config, "blocking-corpus");
    assert.equal(artifact.tool_status.typed_eslint.complete, true, artifact.tool_status.typed_eslint.reason ?? "complete parsing required");
    for (const [index, item] of corpus.cases.entries()) {
      const positive = artifact.records.find((record) => record.rule_id === item.id && record.file === `src/positive-${index}.ts`);
      assert.ok(positive, `missing positive ${item.id}`);
      assert.equal(positive.disposition, "block");
      assert.equal(positive.blocking_contract, item.id);
      assert.ok(!artifact.records.some((record) => record.rule_id === item.id && record.file === `src/negative-${index}.ts`), `negative ${item.id}`);
      const coverage = artifact.rule_applicability.find((entry) => entry.contract_id === item.id)!;
      assert.equal(coverage.evaluated, corpus.cases.length * 2, "negative requires actual rule dispatch, not silence");
      assert.equal(coverage.abstained, 0);
    }
    fs.unlinkSync(path.join(root, "tsconfig.json"));
    const unavailable = measureLint(config, "blocking-corpus");
    assert.equal(unavailable.confidence.complete, false);
    assert.equal(unavailable.tool_status.typed_eslint.complete, false);
    assert.equal(unavailable.records.length, 0, "no findings without execution is not an evaluated negative");
    assert.ok(unavailable.rule_applicability.every((entry) => entry.evaluated === 0 && entry.abstained === corpus.cases.length * 2));
    for (const name of fs.readdirSync(path.join(root, "src"))) fs.unlinkSync(path.join(root, "src", name));
    fs.writeFileSync(path.join(root, "src/plain.js"), "export const value = 1;\n");
    const inapplicable = measureLint(config, "not-applicable");
    assert.ok(inapplicable.rule_applicability.every((entry) => entry.status === "not_applicable" && entry.skipped === 1));
    const unknown = enrichFinding(config, { id: "unknown", rule_id: "future/rule", disposition: "block" });
    assert.equal(blockingContract(unknown), null);
    assert.equal(unknown.disposition, "review", "unregistered blockers cannot silently acquire blocking semantics");
    assert.match(String(unknown.classification_limitation), /Unregistered/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
