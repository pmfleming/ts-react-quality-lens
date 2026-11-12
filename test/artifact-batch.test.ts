import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stagedAudit } from "../src/artifact-batch.js";
import { loadConfig } from "../src/config.js";
import { runAudit } from "../src/audit.js";
import { readArtifact, writeArtifact } from "../src/writer.js";
import { artifactText, withStore } from "../src/store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-publication-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 1;\n");
  const file = path.join(root, "ts-react-quality-lens.config.json");
  fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], output_dir: "out", policy: { required_checks: [] } }));
  return { root, config: loadConfig(file) };
}

test("failed database publication rolls back every member and preserves the requested baseline", (t) => {
  const { root, config } = fixture();
  try {
    const previous = runAudit(config, "test", { runTests: false, compareBase: false });
    const baseline = path.join(root, "baseline.json");
    fs.writeFileSync(baseline, '{"findings":["preserved"]}');
    withStore(config.outputDir, (db) => {
      const original = artifactText(db, "hotspots.json");
      const exec = db.exec.bind(db);
      let failed = false;
      const mock = t.mock.method(db, "exec", (sql: string) => {
        if (sql === "COMMIT" && !failed) { failed = true; throw new Error("injected commit failure"); }
        exec(sql);
      });
      try {
        assert.throws(() => runAudit(config, "new", { runTests: false, compareBase: false, saveBaseline: baseline }), /injected commit failure/);
      } finally { mock.mock.restore(); }
      assert.equal(artifactText(db, "hotspots.json"), original);
      assert.equal(readArtifact(config, "audit.json")?.provenance.run_id, previous.provenance.run_id);
      assert.equal(fs.readFileSync(baseline, "utf8"), '{"findings":["preserved"]}');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("staged producers are isolated and failed measurements leave prior evidence readable", () => {
  const { root, config } = fixture();
  try {
    writeArtifact(config, "hotspots.json", { previous: true });
    assert.throws(() => stagedAudit(config, (staged) => {
      writeArtifact(staged, "hotspots.json", { partial: true });
      assert.equal(withStore(config.outputDir, (db) => artifactText(db, "hotspots.json")), '{"previous":true}');
      throw new Error("producer failed");
    }), /producer failed/);
    assert.equal(withStore(config.outputDir, (db) => artifactText(db, "hotspots.json")), '{"previous":true}');
    assert.ok(!fs.readdirSync(config.outputDir).some((name) => name.startsWith(".audit") || name.endsWith(".json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
