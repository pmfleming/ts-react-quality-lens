import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { npmPackResult, resolveNpmCli } from "../src/integrations/npm-cli.js";

test("npm pack accepts array and npm 12 keyed reports but rejects malformed or escaping paths", () => {
  const entry = { filename: "fixture-1.0.0.tgz", files: [{ path: "package.json" }], size: 123 };
  assert.deepEqual(npmPackResult([entry]), entry);
  assert.deepEqual(npmPackResult({ fixture: entry }), entry);
  for (const value of [null, {}, [], [entry, entry], { fixture: { ...entry, filename: "../escape.tgz" } },
    [{ ...entry, filename: "C:\\escape.tgz" }], [{ ...entry, files: [null] }]]) {
    assert.throws(() => npmPackResult(value), /valid tarball/);
  }
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quality lens npm cli "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const execPath = path.join(root, "node", "node.exe");
  const file = (relative: string) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "");
    return filename;
  };
  return { root, execPath, file };
}

test("npm CLI resolves npm.cmd on PATH without executing the shim", (t) => {
  const { root, execPath, file } = fixture(t);
  file("npm installation/npm.cmd");
  const cli = file("npm installation/node_modules/npm/bin/npm-cli.js");
  assert.equal(resolveNpmCli(execPath, { Path: path.join(root, "npm installation") }), cli);
});

test("npm CLI reports missing installations rather than executing a shim as JavaScript", (t) => {
  const { root, execPath, file } = fixture(t);
  file("bin/npm");
  assert.throws(
    () => resolveNpmCli(execPath, { npm_execpath: path.join(root, "missing/npm-cli.js"), PATH: path.join(root, "bin") }),
    /npm JavaScript CLI .* was not found/,
  );
});
