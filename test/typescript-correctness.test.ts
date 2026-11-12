import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { measureLint } from "../src/measures/type-quality.js";
import { TYPED_RULESET } from "../src/rule-policy.js";

const cases = [
  ["no-unsafe-function-type", "export function accept(callback: Function) { return callback; }", "export function accept(callback: () => void) { return callback; }"],
  ["only-throw-error", "export function fail() { throw 'failure'; }", "export function fail(e: unknown) { try { throw new Error('failure'); } catch (caught) { throw caught; } }"],
  ["prefer-promise-reject-errors", "export const failed = Promise.reject('failure');", "export const failed = Promise.reject(new Error('failure'));"],
  ["no-for-in-array", "export function keys(values: string[]) { for (const key in values) console.log(key); }", "export function keys(values: string[]) { for (const value of values) console.log(value); }"],
  ["no-misused-spread", "export const copied = {...new Map<string, number>()};", "export const copied = {...{value: 1}};"],
  ["no-wrapper-object-types", "export function value(input: String) { return input; }", "export function value(input: string) { return input; }"],
  ["no-empty-object-type", "export type Anything = {};", "export type Anything = unknown; export type Present<T> = T & {};"],
] as const;

test("correctness rules execute positive and negative cases and preserve unavailable evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-ts-correctness-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"correctness","type":"module"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, include: ["src"] }));
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
    for (const [name, positive, negative] of cases) {
      fs.writeFileSync(path.join(root, `src/${name}-bad.ts`), positive + "\n");
      fs.writeFileSync(path.join(root, `src/${name}-good.ts`), negative + "\n");
    }
    const config = loadConfig(path.join(root, "lens.json"));
    const result = measureLint(config, "correctness rules");
    assert.equal(result.tool_status.typed_eslint.complete, true, result.tool_status.typed_eslint.reason ?? "complete required");
    assert.equal(result.tool_status.typed_eslint.ruleset, TYPED_RULESET);
    for (const [name] of cases) {
      const id = `@typescript-eslint/${name}`;
      assert.ok(result.records.some((r) => r.rule_id === id && r.file === `src/${name}-bad.ts` && r.disposition === "warn"), id);
      assert.ok(!result.records.some((r) => r.rule_id === id && r.file === `src/${name}-good.ts`), id);
      assert.equal(result.rule_applicability.find((r) => r.contract_id === id)?.evaluated, cases.length * 2);
    }
    fs.unlinkSync(path.join(root, "tsconfig.json"));
    const missing = measureLint(config, "unavailable correctness");
    assert.equal(missing.tool_status.typed_eslint.complete, false);
    assert.ok(missing.rule_applicability.every((r) => r.evaluated === 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
