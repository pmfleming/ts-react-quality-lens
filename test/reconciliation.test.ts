import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcileCleanupRecords } from "../src/measures/cleanup.js";
import { measureLint } from "../src/measures/type-quality.js";
import type { KnipResult, ScoredRecord } from "../src/types.js";
import { collectFindings, collectReconciliation } from "../src/audit/findings.js";
import { loadConfig } from "../src/config.js";
import { writeArtifact } from "../src/writer.js";

test("cleanup matching requires exact subjects, complete scope and explicit observations", () => {
  const own: ScoredRecord = { id: "internal", kind: "unused_export", file: "src/a.ts", name: "answer" };
  const upstream: ScoredRecord = { id: "knip", kind: "unused_export", file: "src/a.ts", name: "answer", source: "knip", rule_id: "knip/exports", disposition: "review" };
  const tool: KnipResult = { available: true, ran: true, complete: true, reason: null, version: "6", issues: [], excluded_dependencies: [], exclusions_complete: true };
  const matched = reconcileCleanupRecords([own], [upstream], tool);
  assert.equal(matched.records.length, 1);
  assert.equal(matched.records[0]?.tool_validation, "confirmed");
  assert.deepEqual(matched.records[0]?.supporting_observations, [own, upstream], "neither original observation is erased");
  const missingFile = { ...upstream }; delete missingFile.file;
  const missingName = { ...upstream }; delete missingName.name;
  for (const other of [{ ...upstream, file: "src/b.ts" }, { ...upstream, name: "different" }, missingFile, missingName]) {
    const result = reconcileCleanupRecords([own], [other], tool);
    assert.equal(result.unconfirmed[0]?.tool_validation, "not_comparable");
    assert.equal(result.records[0]?.id, "knip");
    assert.equal(result.disagreements.length, 0);
  }
  for (const state of [{ ...tool, complete: false }, { ...tool, version: null }]) {
    const result = reconcileCleanupRecords([own], [upstream], state);
    assert.equal(result.records.find((record) => record.id === "internal")?.tool_validation, "unavailable");
    assert.ok(!result.records.some((record) => record.tool_validation === "confirmed"));
  }
  const silence = reconcileCleanupRecords([own], [], tool);
  assert.equal(silence.disagreements.length, 0);
  assert.equal(silence.unconfirmed[0]?.tool_validation, "not_comparable");
  const dependency = { id: "dep", kind: "unused_dependency", file: "package.json", name: "@scope/tool" };
  const excluded = reconcileCleanupRecords([dependency], [], { ...tool, excluded_dependencies: ["@scope/*"] });
  assert.equal(excluded.unconfirmed[0]?.tool_validation, "excluded_by_tool");
});

test("managed lint never exports findings or evaluated counts from excluded source scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-lint-scope-"));
  try {
    fs.mkdirSync(path.join(root, "src/excluded"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"scope"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["src"]}');
    fs.writeFileSync(path.join(root, "src/main.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "src/excluded/bad.ts"), "export function unsafe(value: any) { return value.name; }\n");
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], exclude: ["excluded"], cache: { enabled: false } }));
    const artifact = measureLint(loadConfig(path.join(root, "lens.json")), "scope-mutation");
    assert.equal(artifact.tool_status.typed_eslint.complete, true);
    assert.deepEqual(artifact.tool_status.typed_eslint.evaluated_files, ["src/main.ts"]);
    assert.ok(!artifact.records.some((record) => record.file?.includes("excluded")));
    assert.ok(artifact.rule_applicability.every((entry) => entry.evaluated === 1 && entry.abstained === 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("audit retains all reconciliation states without counting non-findings as blockers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-reconciliation-"));
  try {
    const config = loadConfig(path.join(root, "lens.json"));
    const observation = (state: string) => ({ id: state, kind: "unused_export", rule_id: "knip/exports", disposition: "review",
      file: "src/public.ts", tool_validation: state, validation_scope: "knip/unused_export",
      corroborating_producers: state === "confirmed" ? ["internal", "knip"] : [], message: state });
    writeArtifact(config, "cleanup.json", { schema_version: "0.3.0", task_id: "quality.cleanup", project: {}, provenance: {},
      confidence: {}, summary: {}, records: [observation("confirmed")], disagreements: [observation("disagreed")],
      unconfirmed: [observation("excluded_by_tool"), observation("not_comparable"), observation("unavailable")],
      engine_relationships: [{ capability: "cleanup", mode: "reconciled", scope: "public exports excluded" }] });
    const evidence = collectReconciliation(config);
    assert.equal(evidence.length, 1);
    assert.deepEqual(evidence[0]?.observations.map((record) => record.tool_validation),
      ["confirmed", "disagreed", "excluded_by_tool", "not_comparable", "unavailable"]);
    assert.ok(evidence[0]?.observations.every((record) => record.validation_scope === "knip/unused_export"));
    const findings = collectFindings(config, { changedFiles: [], changedLines: new Map(), baselineIds: new Set(), includeAll: true });
    assert.equal(findings.length, 1, "non-findings are separate evidence, not additional actionable diagnostics");
    assert.equal(findings[0]?.id, "confirmed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
