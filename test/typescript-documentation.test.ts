import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { documentationEvidence, validDocumentationReport } from "../src/typescript-documentation.js";
import { validProducerPayload } from "../src/producer-payload.js";
import { measureTypeHealth } from "../src/measures/type-quality.js";
import { readArtifact } from "../src/writer.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-docs-"));
  const write = (file: string, content: string | object) => fs.writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  fs.mkdirSync(path.join(root, "src"));
  write("package.json", { name: "docs", type: "module", exports: "./src/api.ts" });
  write("tsconfig.json", { compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, include: ["src"] });
  write("lens.json", { source_roots: ["src"], documentation: { enabled: true, exempt_exports: [
    { file: "src/api.ts", names: ["default", "framework"], reason: "Framework consumes these exports by convention." },
  ] } });
  write("src/api.ts", `export { documented as alias, undocumented, old, replaced, framework } from './impl.js';
export { generated } from './generated.js';
export type { Remote } from '../external.js';
export default function Tool() {}
`);
  write("src/impl.ts", `/** Explain the operation to consumers. */
export function documented() {}
export function undocumented() {}
/** @deprecated */
export function old() {}
/** @deprecated Use documented instead. */
export function replaced() {}
export function framework() {}
`);
  write("src/generated.ts", "/** @generated */\nexport const generated = 1;\n");
  write("external.d.ts", "export interface Remote { value: string }\n");
  try { run(root, loadConfig(path.join(root, "lens.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("optional public documentation follows re-exports and excludes generated/framework/external declarations", () => fixture((_root, config) => {
  const context = createAnalysisContext(config);
  const evidence = documentationEvidence(config, context.project());
  assert.equal(evidence.report.status, "complete");
  assert.equal(evidence.report.scope, "detected-package-entrypoints");
  assert.deepEqual(evidence.report.summary, {
    public_exports: 8, evaluated_exports: 4, excluded_exports: 4, unavailable_exports: 0,
    documented_exports: 2, undocumented_exports: 2, coverage_percent: 50,
    deprecated_exports: 2, deprecated_with_guidance_text: 1, missing_deprecation_guidance: 1,
  });
  assert.equal(evidence.records.length, 3);
  assert.ok(evidence.records.every((r) => r.disposition === "review" && r.documentation_quality_verified === false && r.file === "src/impl.ts"));
  assert.equal(evidence.report.exports.find((item) => item.name === "alias")?.documented, true);
  const artifact = measureTypeHealth(config, "documentation", context);
  assert.ok(validProducerPayload(artifact));
  const inconsistent = structuredClone(evidence.report);
  inconsistent.summary.coverage_percent = 100;
  assert.equal(validDocumentationReport(inconsistent), false);
  assert.equal(validProducerPayload({ ...artifact, documentation: inconsistent }), false);
  const validate = new Ajv2020({ strict: false }).compile(JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8")));
  assert.ok(validate(artifact), JSON.stringify(validate.errors));
  assert.deepEqual(readArtifact(config, "type_health.json")?.documentation, evidence.report);
  const cached = createAnalysisContext(config);
  assert.equal(cached.project().cache.status, "hit");
  assert.deepEqual(documentationEvidence(config, cached.project()), evidence);
  config.documentation.enabled = false;
  const disabled = createAnalysisContext(config);
  assert.notEqual(disabled.project().cache.status, "hit");
  assert.ok(disabled.project().modules.every((module) => !module.typed?.documentation));
  assert.equal(documentationEvidence(config, disabled.project()).report.status, "disabled");
}));

test("documentation scope, exclusions and unavailable inventories never invent coverage", () => fixture((root, config) => {
  config.publicApi = { entry: [], exports: [{ file: "src/api.ts", names: ["alias"] }] };
  let result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.summary.evaluated_exports, 1);
  assert.equal(result.report.summary.coverage_percent, 100);
  config.documentation.exclude = ["src/impl.*"];
  result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.status, "not_applicable");
  assert.equal(result.report.summary.coverage_percent, null);
  config.documentation.exclude = [];
  config.publicApi.exports[0]!.names = ["missing"];
  result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.status, "incomplete");
  assert.deepEqual(result.report.unmatched_selectors, ["export:src/api.ts:missing"]);
  assert.equal(result.report.summary.coverage_percent, null);
  config.publicApi = { entry: ["src/no-such-entry.ts"], exports: [] };
  result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.status, "incomplete");
  config.publicApi = { entry: ["src/api.ts"], exports: [] };
  fs.appendFileSync(path.join(root, "src/api.ts"), "export * from './absent.js';\n");
  result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.summary.coverage_percent, null);
  assert.equal(result.records.length, 0);
  fs.unlinkSync(path.join(root, "tsconfig.json"));
  result = documentationEvidence(config, createAnalysisContext(config).project());
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.summary.coverage_percent, null);
  assert.equal(result.records.length, 0);
  assert.equal(result.report.files[0]?.status, "unavailable");
}));

test("documentation config defaults off and requires an explanation for framework exemptions", () => fixture((root) => {
  const file = path.join(root, "lens.json");
  fs.writeFileSync(file, "{}");
  assert.equal(loadConfig(file).documentation.enabled, false);
  for (const documentation of [{ enabled: "yes" }, { exempt_exports: [{ file: "src/api.ts", names: ["default"], reason: " " }] }]) {
    fs.writeFileSync(file, JSON.stringify({ documentation }));
    assert.throws(() => loadConfig(file));
  }
}));
