import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { runJscpd } from "../src/integrations/external-tools.js";

function fixture(run: (root: string, config: ReturnType<typeof loadConfig>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-native-clones-"));
  try {
    fs.mkdirSync(path.join(root, "src/excluded"), { recursive: true });
    const source = "export function total(rows: number[]) {\n  const positive = rows.filter((value) => value > 0);\n  const sum = positive.reduce((value, item) => value + item, 0);\n  const count = positive.length;\n  const average = count ? sum / count : 0;\n  return { sum, count, average };\n}\n";
    for (const file of ["a.ts", "b.ts", "excluded/c.ts"]) fs.writeFileSync(path.join(root, "src", file), source);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"clones"}');
    fs.writeFileSync(path.join(root, ".jscpd.json"), "invalid project config must not be read");
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], exclude: ["excluded"] }));
    run(root, loadConfig(path.join(root, "lens.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("native clone engine uses managed config, absolute scoped paths and stable occurrence order", () => fixture((root, config) => {
  const first = runJscpd(config);
  assert.equal(first.ran, true, first.reason ?? "native engine must execute");
  assert.ok(first.duplicates.length > 0);
  assert.deepEqual(first.duplicates, runJscpd(config).duplicates);
  for (const duplicate of first.duplicates) {
    assert.ok([duplicate.firstFile?.name, duplicate.secondFile?.name].every((name) => name && path.isAbsolute(name) && !name.includes("excluded")));
  }
  fs.unlinkSync(path.join(root, "src/b.ts"));
  const negative = runJscpd(config);
  assert.equal(negative.ran, true);
  assert.deepEqual(negative.duplicates, []);
}));

test("missing or malformed native clone reports are operational failures, never clean scans", (t) => fixture((_root, config) => {
  for (const report of [null, {}, { duplicates: [null], statistics: {} }, { duplicates: [{}], statistics: {} }]) {
    const mock = t.mock.method(childProcess, "execFileSync", (_executable: unknown, args: string[]) => {
      const managed = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      assert.ok(managed.absolute);
      assert.ok(managed.path.every((file: string) => !file.includes("excluded")));
      if (report !== null) fs.writeFileSync(path.join(managed.output, "jscpd-report.json"), JSON.stringify(report));
      return "";
    });
    try {
      const result = runJscpd(config);
      assert.equal(result.ran, false);
      assert.ok(result.reason);
      assert.deepEqual(result.duplicates, []);
    } finally { mock.mock.restore(); }
  }
}));
