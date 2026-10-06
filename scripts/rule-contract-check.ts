import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { BLOCKING_TYPED_RULES, BLOCKING_REACT_RULES, BLOCKING_FAMILIES, validateBlockingInventory } from "../src/rule-policy.js";
import { arrayOf, string } from "../src/validation.js";
import { isRecord, parseJson } from "../src/collections.js";

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

const typed = readJson(path.join(root, "contracts", "typed-rule-cases.json"));
const families = readJson(path.join(root, "contracts", "blocking-families.json"));
assert.ok(isRecord(typed) && Array.isArray(typed.cases));
assert.ok(isRecord(families) && Array.isArray(families.families));
const typedCases = typed.cases.filter(isRecord);
assert.deepEqual(typedCases.map((item) => item.id).sort(), [...BLOCKING_TYPED_RULES].sort(), "every enabled typed blocker needs executable cases");
assert.deepEqual(rules.filter((rule) => rule.default_disposition === "block").map((rule) => rule.id).sort(), [...BLOCKING_REACT_RULES].sort());
assert.deepEqual(families.families.filter(isRecord).map((item) => item.id).sort(), [...BLOCKING_FAMILIES].sort());
validateBlockingInventory([...typedCases, ...rules.filter((rule) => rule.default_disposition === "block"), ...families.families.filter(isRecord)]
  .map((item) => requiredString(item, "id")));
for (const item of typedCases) {
  assert.ok(requiredString(item, "positive").endsWith("\n"));
  assert.ok(requiredString(item, "rationale").length > 10);
}
for (const item of [typed, ...families.families.filter(isRecord)]) {
  for (const key of ["prerequisites", "limitations", "tests"]) assert.ok(Array.isArray(item[key]) && item[key].length > 0);
  assert.ok(arrayOf(string)(item.tests));
  for (const name of item.tests) assert.ok(fs.existsSync(path.join(root, name)), `missing regression ${name}`);
  for (const key of ["scope", "versions"]) assert.ok(requiredString(item, key).length > 0);
}
console.log(JSON.stringify({ rule_contracts: rules.length, corpus_cases: cases.length,
  typed_blockers: typedCases.length, blocking_families: BLOCKING_FAMILIES.length, status: "passed" }, null, 2));

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
  return parseJson(fs.readFileSync(file, "utf8"));
}
