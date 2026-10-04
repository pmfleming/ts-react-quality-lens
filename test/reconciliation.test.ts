import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectFindings, collectReconciliation } from "../src/audit/findings.js";
import { loadConfig } from "../src/config.js";
import { writeArtifact } from "../src/writer.js";

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
