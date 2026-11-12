import assert from "node:assert/strict";
import fs from "node:fs";
import { typescriptFixture } from "./project-fixture.js";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { isRecord } from "../src/collections.js";
import { measureEscapeHatches } from "../src/measures/type-quality.js";

test("dynamic-code and mutable-binding evidence resolves symbols, exports and cached results", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/main.ts"), `
eval('1'); Function('return 1'); new Function('return 1');
globalThis.eval('1'); new globalThis.Function('return 1'); globalThis['eval']('1');
const object = { Function: (value: string) => value, eval: (value: string) => value };
object.Function('safe'); object.eval('safe');
function shadow(Function: new (value: string) => object) { return new Function('safe'); }
export var shared = 1;
let alias = 2; export { alias as publicAlias };
var local = 3; let other = 4;
export let { nested } = { nested: 5 };
export const fixed = 6;
function inside() { let nestedLocal = 0; return nestedLocal; }
`);
  fs.writeFileSync(path.join(root, "src/custom.ts"), "export function Function(value: string) { return value; }\n");
  fs.writeFileSync(path.join(root, "src/imported.ts"), "import {Function} from './custom.js'; Function('safe');\n");
  const firstContext = createAnalysisContext(config);
  const first = measureEscapeHatches(config, "safety", firstContext);
  assert.ok(first.records);
  assert.equal(first.records.filter((r) => r.kind === "eval_like_api").length, 6);
  assert.ok(first.records.filter((r) => r.kind === "eval_like_api").every((r) => r.binding_verified === true && r.disposition === "review"));
  assert.deepEqual(first.records.filter((r) => r.kind === "exported_mutable_binding").map((r) => r.name).sort(), ["alias", "nested", "shared"]);
  assert.deepEqual(first.records.filter((r) => r.kind === "module_level_mutable_state").map((r) => r.name).sort(), ["local", "other"]);
  assert.ok(first.records.filter((r) => String(r.kind).includes("mutable")).every((r) => r.mutation_observed === false));
  const cachedContext = createAnalysisContext(config);
  assert.equal(cachedContext.project().cache.status, "hit");
  assert.deepEqual(measureEscapeHatches(config, "cached safety", cachedContext).records, first.records);
  fs.unlinkSync(path.join(root, "tsconfig.json"));
  const missing = measureEscapeHatches(config, "unavailable safety");
  assert.ok(missing.records);
  assert.ok(isRecord(missing.dynamic_code_analysis) && Array.isArray(missing.dynamic_code_analysis.files));
  assert.ok(missing.dynamic_code_analysis.files.every((file) => isRecord(file) && file.status === "unavailable"));
  assert.ok(!missing.records.some((r) => r.kind === "eval_like_api" || r.kind === "exported_mutable_binding"));
  assert.ok(missing.records.filter((r) => r.kind === "module_level_mutable_state").every((r) => r.visibility === "unverified"));
}));
