import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { measureLint, measureTypeHealth } from "../src/measures/type-quality.js";
import { isRecord } from "../src/collections.js";

test("API design reviews distinguish generic relationships and readonly candidates without gating", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-api-design-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"api-design","type":"module"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, include: ["src"] }));
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"] }));
    fs.writeFileSync(path.join(root, "src/bad.ts"), `
export function decode<Result>(value: string): Result { return JSON.parse(value) as Result; }
export function repeated<Result>(): [Result, Result] { throw new Error('factory'); }
export function logValue<Value extends string>(value: Value): void { console.log(value); }
export class Candidate { private value = 1; read() { return this.value; } }
export function length(value: string): number;
export function length(value: string[]): number;
export function length(value: string | string[]): number { return value.length; }
`);
    fs.writeFileSync(path.join(root, "src/good.ts"), `
export function identity<Value>(value: Value): Value { return value; }
export function validate<Value>(input: unknown, guard: (value: unknown) => value is Value): Value { if (guard(input)) return input; throw new Error('invalid'); }
export function connected<T, U extends T>(value: U): T { return value; }
export type Nested<T> = <T>(value: T) => T;
export function inferred<T>(value: string) { return value as T; }
export class Mutable { private value = 1; change() { this.value++; } read() { return this.value; } }
export class Public { value = 1; read() { return this.value; } }
export class Readonly { private readonly value = 1; read() { return this.value; } }
export function related(value: string): string;
export function related(value: number): number;
export function related(value: string | number): string | number { return value; }
`);
    const config = loadConfig(path.join(root, "lens.json"));
    const context = createAnalysisContext(config);
    const health = measureTypeHealth(config, "API design", context);
    assert.ok(health.records);
    const candidates = health.records.filter((r) => r.kind === "return_only_generic");
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((r) => r.file === "src/bad.ts" && r.disposition === "review" && r.semantic_decision === "unresolved"));
    const lint = measureLint(config, "API design lint", context);
    assert.equal(lint.tool_status.typed_eslint.complete, true, lint.tool_status.typed_eslint.reason ?? "complete required");
    for (const id of ["@typescript-eslint/no-unnecessary-type-parameters", "@typescript-eslint/prefer-readonly", "@typescript-eslint/unified-signatures"]) {
      assert.ok(lint.records.some((r) => r.rule_id === id && r.file === "src/bad.ts" && r.disposition === "review" && r.semantic_decision === "unresolved"), id);
    }
    assert.ok(!lint.records.some((r) => r.rule_id === "@typescript-eslint/prefer-readonly" && r.file === "src/good.ts"));
    assert.ok(!lint.records.some((r) => r.rule_id === "@typescript-eslint/unified-signatures" && r.file === "src/good.ts"));
    const cached = createAnalysisContext(config);
    assert.equal(cached.project().cache.status, "hit");
    assert.deepEqual(measureTypeHealth(config, "cached API", cached).records, health.records);
    fs.unlinkSync(path.join(root, "tsconfig.json"));
    const unavailable = measureTypeHealth(config, "missing API evidence");
    assert.ok(!unavailable.records?.some((r) => r.kind === "return_only_generic"));
    assert.ok(isRecord(unavailable.api_design_analysis) && Array.isArray(unavailable.api_design_analysis.files));
    assert.ok(unavailable.api_design_analysis.files.every((file) => isRecord(file) && file.status === "unavailable"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
