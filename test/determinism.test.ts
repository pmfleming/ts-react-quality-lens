import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { deterministicEvidence } from "../src/deterministic-evidence.js";
import { runMeasure } from "../src/measure-runner.js";
import { writeArtifact } from "../src/writer.js";

test("semantic evidence is stable across fresh, reused, persisted and disabled cache contexts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-determinism-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/main.ts"), "export function read(value: any) { return value.name; }\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"repeatability"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["src"]}');
    fs.writeFileSync(path.join(root, "lens.json"), '{"source_roots":["src"]}');
    const config = loadConfig(path.join(root, "lens.json"));
    const context = createAnalysisContext(config);
    const measure = (reuse = false) => runMeasure(config, "quality.escape_hatches", "determinism", reuse ? { context } : {})[0]!;
    const first = measure(true);
    for (const next of [measure(true), measure(), measure()]) {
      assert.notEqual(first.provenance.run_id, next.provenance.run_id);
      assert.deepEqual(deterministicEvidence(first), deterministicEvidence(next));
    }
    config.cache.enabled = false;
    assert.deepEqual(deterministicEvidence(first), deterministicEvidence(measure()));
    const reordered = { ...first, records: [...first.records!].reverse() };
    const published = writeArtifact(config, "reordered.json", reordered);
    assert.deepEqual(deterministicEvidence(first), deterministicEvidence(published));
    for (const field of ["id", "disposition", "duration_ms"]) {
      const changed = structuredClone(first);
      const record = changed.records![0]!;
      if (field === "id") record.id += "-changed";
      else if (field === "disposition") record.disposition = "info";
      else record.duration_ms = 123; // A measured runtime value, not tool telemetry.
      const updated = writeArtifact(config, "changed.json", changed);
      assert.notDeepEqual(deterministicEvidence(first), deterministicEvidence(updated), field);
    }
    const broken = structuredClone(first);
    broken.provenance.run_id = "dangling";
    assert.throws(() => deterministicEvidence(broken), /invalid native evidence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
