import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stagedAudit } from "../src/artifact-batch.js";
import { loadConfig } from "../src/config.js";
import { runAudit } from "../src/audit.js";
import { readArtifact, writeArtifact } from "../src/writer.js";
import { isRecord, parseJson } from "../src/collections.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-publication-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 1;\n");
  const file = path.join(root, "ts-react-quality-lens.config.json");
  fs.writeFileSync(file, JSON.stringify({ source_roots: ["src"], output_dir: "out", policy: { required_checks: [] } }));
  return { root, config: loadConfig(file) };
}

test("publication faults restore prior files or block consumers while retaining recovery data", (t) => {
  const { root, config } = fixture();
  try {
    const previous = runAudit(config, "test", { runTests: false });
    const hotspot = path.join(config.outputDir, "hotspots.json");
    const original = fs.readFileSync(hotspot, "utf8");
    const fault = path.join(config.outputDir, "zz-fault.json");
    fs.writeFileSync(fault, '{"previous":true}');
    for (const recoveryFails of [false, true]) {
      let directory = "";
      let failed = false;
      const rename = fs.renameSync;
      const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (!failed && to === fault) {
          failed = true;
          assert.throws(() => readArtifact(config, "hotspots.json"), /publication/);
          assert.throws(() => writeArtifact(config, "other.json", {}), /EEXIST/);
          throw new Error("injected publication failure");
        }
        if (recoveryFails && String(from).includes(`${path.sep}.previous${path.sep}`)) throw new Error("injected recovery failure");
        return rename(from, to);
      });
      try {
        assert.throws(() => stagedAudit(config, (staged) => {
          directory = staged.outputDir;
          fs.writeFileSync(path.join(directory, "hotspots.json"), '{"new":true}');
          fs.writeFileSync(path.join(directory, "zz-fault.json"), '{"new":true}');
          return previous;
        }), recoveryFails ? /recovery failed/ : /injected publication failure/);
      } finally { mock.mock.restore(); }
      if (recoveryFails) {
        const recovery = parseJson(fs.readFileSync(path.join(config.outputDir, ".publication-incomplete"), "utf8"));
        assert.ok(isRecord(recovery));
        assert.deepEqual(recovery.previous, ["audit.json", "hotspots.json", "zz-fault.json"]);
        assert.throws(() => readArtifact(config, "hotspots.json"), /publication/);
        assert.throws(() => writeArtifact(config, "other.json", {}), /recovery/);
        assert.equal(fs.readFileSync(path.join(directory, ".previous/hotspots.json"), "utf8"), original);
      } else {
        assert.equal(fs.readFileSync(hotspot, "utf8"), original);
        assert.equal(fs.readFileSync(fault, "utf8"), '{"previous":true}');
        assert.ok(readArtifact(config, "hotspots.json"));
        assert.equal(fs.existsSync(directory), false);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a publication failure cannot advance the requested baseline", (t) => {
  const { root, config } = fixture();
  const baseline = path.join(root, "baseline.json");
  fs.writeFileSync(baseline, '{"findings":["preserved"]}');
  const rename = fs.renameSync;
  let failed = false;
  const mock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!failed && to === path.join(config.outputDir, "audit.json")) {
      failed = true;
      throw new Error("injected publication failure");
    }
    return rename(from, to);
  });
  try {
    assert.throws(() => runAudit(config, "test", { runTests: false, saveBaseline: baseline }), /injected publication failure/);
    assert.equal(fs.readFileSync(baseline, "utf8"), '{"findings":["preserved"]}');
  } finally { mock.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed and competing audit producers cannot replace prior evidence", () => {
  const { root, config } = fixture();
  try {
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
