import assert from "node:assert/strict";
import fs from "node:fs";
import { typescriptFixture } from "./project-fixture.js";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureTypeHealth } from "../src/measures/type-quality.js";

test("public callback contracts use observed direct calls and abstain on escapes or ambiguous arguments", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/bad.ts"), `
export function visit(callback: (value: string, index?: number) => any) { callback('first', 0); callback('second', 1); }
export const arrow = (callback: () => any) => { callback(); };
export class Public { call(callback: () => any) { callback(); } }
`);
  fs.writeFileSync(path.join(root, "src/good.ts"), `
export function used(callback: () => any) { return callback(); }
export function optional(callback: (index?: number) => void) { callback(); callback(1); }
export function undefinedArg(callback: (index?: number) => void) { callback(undefined); }
export function uncertain(callback: (index?: number) => void, value: number | undefined) { callback(value); }
export function escaping(callback: () => any) { callback(); return callback; }
export function spread(callback: (index?: number) => any, args: [number?]) { callback(...args); }
export function replaced(callback: () => any) { callback = () => 1; callback(); }
export function shadow(callback: () => any) { return (callback: () => any) => callback(); }
export declare function absent(callback: () => any): void;
function internal(callback: () => any) { callback(); }
export class Hidden { private call(callback: () => any) { callback(); } }
`);
  const context = createAnalysisContext(config);
  assert.equal(context.project().tsProject.diagnostics.length, 0);
  const health = measureTypeHealth(config, "callback contracts", context);
  const records = health.records!.filter((r) => r.kind === "callback_contract_review");
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.file === "src/bad.ts" && r.disposition === "review" && r.semantic_decision === "unresolved"));
  assert.equal(records.filter((r) => r.rule_id?.endsWith("always-supplied-optional-callback-argument")).length, 1);
  assert.ok(records.every((r) => r.related_locations?.length === r.observed_calls));
  const cached = createAnalysisContext(config);
  assert.equal(cached.project().cache.status, "hit");
  assert.deepEqual(measureTypeHealth(config, "cached contracts", cached).records, health.records);
  fs.unlinkSync(path.join(root, "tsconfig.json"));
  assert.ok(!measureTypeHealth(config, "missing contracts").records?.some((r) => r.kind === "callback_contract_review"));
}));
