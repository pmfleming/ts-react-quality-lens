import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord, parseJson } from "../src/collections.js";
import { resolveNpmCli } from "../src/integrations/npm-cli.js";

function node(args: string[], cwd = process.cwd()): string {
  return childProcess.execFileSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-lens-package-"));
try {
  const npm = resolveNpmCli();
  const parsed = parseJson(node([npm, "pack", "--json", "--pack-destination", root]));
  const pack = Array.isArray(parsed) && isRecord(parsed[0]) ? parsed[0] : {};
  const files = new Set((Array.isArray(pack.files) ? pack.files : []).flatMap((file) => isRecord(file) && typeof file.path === "string" ? [file.path] : []));
  for (const required of ["dist/bin/ts-react-quality-lens.js", "ts-react-quality-lens.schema.json", "ts-react-quality-lens.config.schema.json", "rule-contracts.json", "rule-contracts.schema.json", "README.md"]) {
    assert.ok(files.has(required), `package missing ${required}`);
  }
  for (const file of files) {
    assert.ok(!file.startsWith("dist/test/") && !file.startsWith("dist/scripts/"), `development output shipped: ${file}`);
    const emitted = file.match(/^dist\/(src\/.*)\.(?:d\.ts|js(?:\.map)?)$/)?.[1];
    if (emitted) assert.ok(fs.existsSync(`${emitted}.ts`), `obsolete emitted module: ${file}`);
  }
  assert.ok(typeof pack.filename === "string" && path.basename(pack.filename) === pack.filename);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"installed-lens-smoke","private":true,"type":"module"}');
  node([npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", path.join(root, pack.filename)], root);
  const bin = path.join(root, "node_modules/ts-react-quality-lens/dist/bin/ts-react-quality-lens.js");
  const help = node([bin, "--help"], root);
  for (const command of ["catalog", "init", "measure", "audit", "context", "mcp", "lsp"]) assert.ok(help.includes(command));
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "src/index.ts"), "export function value(): number { return 1; }\n");
  fs.writeFileSync(path.join(root, "test/behavior.test.mjs"), 'import test from "node:test"; import fs from "node:fs"; test("installed runner", () => fs.writeFileSync("executed.txt", "yes"));\n');
  const config = path.join(root, "ts-react-quality-lens.config.json");
  fs.writeFileSync(config, JSON.stringify({ source_roots: ["src"], output_dir: "out", test_command: "node --test test/behavior.test.mjs" }));
  node([bin, "catalog", "--config", config], root);
  node([bin, "measure", "quality.hotspots", "--config", config], root);
  node([bin, "measure", "correctness.all", "--config", config], root);
  const artifact = parseJson(fs.readFileSync(path.join(root, "out/correctness_review.json"), "utf8"));
  assert.ok(isRecord(artifact) && isRecord(artifact.execution) && artifact.execution.status === "passed");
  assert.equal(fs.readFileSync(path.join(root, "executed.txt"), "utf8"), "yes");
  console.log(JSON.stringify({ package_smoke: "passed", files: files.size, installed_consumer: true, project_test_runner: "passed" }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
