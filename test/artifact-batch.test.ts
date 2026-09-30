import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stagedAudit } from "../src/artifact-batch.js";
import { loadConfig } from "../src/config.js";

test("failed and competing audit producers cannot replace prior evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-batch-"));
  try {
    const file = path.join(root, "ts-react-quality-lens.config.json");
    fs.writeFileSync(file, JSON.stringify({ source_roots: ["."], output_dir: "out" }));
    const config = loadConfig(file);
    fs.mkdirSync(config.outputDir, { recursive: true });
    const output = path.join(config.outputDir, "hotspots.json");
    fs.writeFileSync(output, '{"previous":true}');
    assert.throws(() => stagedAudit(config, (staged) => {
      fs.writeFileSync(path.join(staged.outputDir, "hotspots.json"), '{"partial":true}');
      assert.throws(() => stagedAudit(config, () => { throw new Error("must not run"); }), /EEXIST/);
      throw new Error("producer failed");
    }), /producer failed/);
    assert.equal(fs.readFileSync(output, "utf8"), '{"previous":true}');
    assert.deepEqual(fs.readdirSync(config.outputDir), ["hotspots.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
