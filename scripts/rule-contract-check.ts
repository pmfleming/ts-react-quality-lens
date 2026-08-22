import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord } from "../src/collections.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = readJson(path.join(root, "rule-contracts.schema.json"));
const contracts = readJson(path.join(root, "rule-contracts.json"));
const corpus = readJson(path.join(root, "test", "rule-corpus", "cases.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
assert.ok(isRecord(schema), "rule contract schema must be an object");
const validate = ajv.compile(schema);
assert.ok(validate(contracts), `rule contracts must satisfy schema: ${ajv.errorsText(validate.errors)}`);
assert.ok(isRecord(contracts) && Array.isArray(contracts.rules), "rule contracts must contain rules");
assert.ok(isRecord(corpus) && Array.isArray(corpus.cases), "rule corpus must contain cases");

const rules = contracts.rules.filter(isRecord);
const cases = corpus.cases.filter(isRecord);
assert.equal(rules.length, contracts.rules.length, "every rule contract must be an object");
assert.equal(cases.length, corpus.cases.length, "every rule corpus case must be an object");
assertUnique(rules, "id", "rule contract");
assertUnique(cases, "id", "rule corpus case");

const contractIds = new Set(rules.flatMap((rule) => typeof rule.id === "string" ? [rule.id] : []));
for (const rule of rules) {
  const id = requiredString(rule, "id");
  const verdicts = new Set(cases
    .filter((item) => item.contract_id === id)
    .flatMap((item) => typeof item.verdict === "string" ? [item.verdict] : []));
  assert.ok(verdicts.has("true-positive"), `${id} needs a confirmed true-positive corpus case`);
  assert.ok(verdicts.has("false-positive"), `${id} needs a confirmed false-positive trap`);
  if (rule.default_disposition === "block") {
    assert.notEqual(rule.evidence_kind, "heuristic", `${id} cannot block from heuristic-only evidence`);
  }
}

for (const item of cases) {
  const id = requiredString(item, "id");
  const contractId = requiredString(item, "contract_id");
  assert.ok(contractIds.has(contractId), `${id} references unknown contract ${contractId}`);
  assert.ok(["true-positive", "false-positive"].includes(requiredString(item, "verdict")), `${id} has an invalid verdict`);
  const source = requiredString(item, "source");
  assert.ok(source.endsWith("\n"), `${id} source must end with a newline`);
  assert.ok(isRecord(item.mutation), `${id} needs a verdict-preserving mutation`);
  const search = requiredString(item.mutation, "search");
  const replacement = requiredString(item.mutation, "replace");
  assert.notEqual(search, replacement, `${id} mutation must change the source`);
  assert.ok(source.includes(search), `${id} mutation search text is absent from source`);
}

console.log(JSON.stringify({ rule_contracts: rules.length, corpus_cases: cases.length, status: "passed" }, null, 2));

function assertUnique(values: Record<string, unknown>[], key: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = requiredString(value, key);
    assert.ok(!seen.has(id), `duplicate ${label} id ${id}`);
    seen.add(id);
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`${key} must be a string`);
  return item;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
