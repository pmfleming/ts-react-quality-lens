import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/measure-runner.js";
import { inputSnapshot } from "../src/input-snapshot.js";
import { withStore } from "../src/store.js";
import { readArtifact } from "../src/writer.js";
import { validNativeEvidence } from "../src/artifact-evidence.js";
import type { Artifact } from "../src/types.js";
import type { WireEvidence } from "../src/wire-evidence.js";

test("native wire references and payload projections reject tampering while preserving exact finding identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-native-wire-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/main.ts"), "export const result = input as number;\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"wire-probe"}');
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
    const config = loadConfig(path.join(root, "lens.json"));
    const artifact = runMeasure(config, "quality.escape_hatches", "wire-test")[0]!;
    assert.ok(validNativeEvidence(artifact, config));
    const wire = artifact.evidence_contract as WireEvidence[];
    const run = wire.find((item) => item.kind === "run")!;
    assert.equal(run.kind, "run");
    const finding = wire.find((item) => item.kind === "finding")!;
    assert.equal(finding.kind, "finding");
    if (finding.kind === "finding" && run.kind === "run") {
      assert.equal(finding.run_id, run.id);
      assert.equal(finding.id, artifact.records?.[0]?.id);
    }
    const mutations: Array<(value: Artifact) => void> = [
      (value) => { value.records![0]!.disposition = "block"; },
      (value) => { value.evidence_contract = wire.filter((item) => item.kind !== "run"); },
      (value) => { value.evidence_contract = [...wire, wire[0]]; },
      (value) => { value.provenance.run_id = "different-run"; },
      (value) => { value.confidence.complete = !value.confidence.complete; },
      (value) => { value.tool_status = { corrupt: { ran: "yes" } } as unknown as NonNullable<Artifact["tool_status"]>; },
      (value) => { value.records = [null] as unknown as NonNullable<Artifact["records"]>; },
      (value) => { value.summary.records = Number.NaN; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(artifact);
      mutate(changed);
      assert.equal(validNativeEvidence(changed, config), false);
      withStore(config.outputDir, (db) => db.prepare("UPDATE artifacts SET payload = ? WHERE name = ?").run(JSON.stringify(changed), "ts_escape_hatches.json"));
      assert.equal(readArtifact(config, "ts_escape_hatches.json"), null);
    }
    config.sarifInputs = [{ path: path.join(root, "input.sarif"), name: "scanner", required: true }];
    fs.writeFileSync(config.sarifInputs[0]!.path, "{}");
    const unchanged = inputSnapshot(config, createAnalysisContext(config).project());
    fs.writeFileSync(config.sarifInputs[0]!.path, '{"changed":true}');
    assert.match(unchanged() ?? "", /changed/, "imported evidence belongs to the audit input closure");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
