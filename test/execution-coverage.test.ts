import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { parseExecutionCoverage } from "../src/coverage.js";
import { runMeasure } from "../src/measure-runner.js";
import { sourceSetHash } from "../src/provenance.js";
import { arrayOf, finite, nullable, shape, string } from "../src/validation.js";

test("coverage formats merge maxima, preserve zero-hit inner ranges and reject malformed boundaries", () => {
  const root = path.resolve("coverage-fixture"), file = path.join(root, "a.js"), text = "a\r\nb\n";
  const sources = [{ path: file, relativePath: "a.js", text, lines: ["a", "b"], extension: ".js", isTest: false }];
  const parse = (format: string, data: unknown) => parseExecutionCoverage(format, data, root, sources);
  assert.deepEqual(parse("lcov", `SF:${pathToFileURL(file).href}\nDA:2,0\nDA:1,3,checksum\nDA:1,1\nend_of_record`),
    [{ file: "a.js", line_hits: [{ line: 1, hits: 3 }, { line: 2, hits: 0 }] }]);
  const script = (ranges: unknown[]) => ({ result: [{ url: file, functions: [{ ranges }] }] });
  const outer = { startOffset: 0, endOffset: text.length, count: 5 }, inner = { startOffset: 0, endOffset: 1, count: 0 };
  assert.deepEqual(parse("v8", script([outer, inner, { ...inner, count: 9 }])),
    [{ file: "a.js", line_hits: [{ line: 1, hits: 0 }, { line: 2, hits: 5 }] }]);
  const statement = { start: { line: 1 }, end: { line: 2 } };
  assert.deepEqual(parse("istanbul", { "a.js": { statementMap: { x: statement, y: statement }, s: { x: 0, y: 3 } } }),
    [{ file: "a.js", line_hits: [{ line: 1, hits: 3 }, { line: 2, hits: 3 }] }]);
  for (const data of [null, "", "DA:1,2", "SF:a.js\nSF:a.js", "SF:a.js\nDA:3,1\nend_of_record", "SF:a.js\nDA:1,-1\nend_of_record"]) {
    assert.throws(() => parse("lcov", data));
  }
  for (const range of [{ ...outer, count: -1 }, { ...outer, count: 0.5 }, { ...outer, endOffset: text.length + 1 },
    { ...inner, startOffset: 1 }, { ...inner, startOffset: -1 }, { ...outer, count: Number.MAX_SAFE_INTEGER + 1 }, null]) {
    assert.throws(() => parse("v8", script([range])));
  }
  for (const data of [{}, { "a.js": {} }, { "a.js": { statementMap: { x: statement }, s: {} } }]) assert.throws(() => parse("istanbul", data));
  for (const data of ["SF:../elsewhere.js\nDA:1,1\nend_of_record", "SF:a.js\nDA:1,1"]) assert.throws(() => parse("lcov", data));
  assert.deepEqual(parse("v8", script([{ startOffset: 0, endOffset: 3, count: 0 }, { startOffset: 3, endOffset: text.length, count: 1 }])),
    [{ file: "a.js", line_hits: [{ line: 1, hits: 0 }, { line: 2, hits: 1 }] }]);
  assert.throws(() => parse("toString", {}));
  assert.throws(() => parse("v8", { result: [{ url: "original.ts", functions: [] }] }));
});

test("coverage orchestration distinguishes missing evidence, partial files, and unavailable Git scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-coverage-scope-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src/a.ts"), reportPath = path.join(root, "coverage.json");
    const text = "export function covered(\n) {\n  return 1;\n}\nexport function uncovered(\n) {\n  return 0;\n}\n";
    fs.writeFileSync(file, text);
    fs.writeFileSync(path.join(root, "src/b.ts"), "export function pending() { return 2; }\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"coverage-scope"}');
    fs.writeFileSync(path.join(root, ".gitignore"), "out/\ncoverage.json\n");
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], output_dir: "out", cache: { enabled: false } }));
    const config = loadConfig(path.join(root, "lens.json"));
    const measure = () => {
      const result = runMeasure(config, "testing.coverage", "coverage-scope")[0];
      assert.ok(result);
      return result;
    };
    const save = (data: string) => fs.writeFileSync(reportPath, JSON.stringify({ format: "lcov", data,
      provenance: { source_set_hash: sourceSetHash(createAnalysisContext(config).project()) }, producer: { name: "fixture", version: "1" } }));
    const partial = "SF:src/a.ts\nDA:3,1\nDA:7,0\nend_of_record\n";
    const full = partial + "SF:src/b.ts\nDA:1,1\nend_of_record\n";
    assert.equal(measure().summary.status, "not_configured");
    config.coverageReport = reportPath;
    assert.equal(measure().summary.status, "incomplete", "missing configured file");
    fs.writeFileSync(reportPath, '{"format":"lcov","data":"","producer":{"name":" ","version":"1"}}');
    assert.match(String(measure().summary.reason), /matching source_set_hash and producer/);
    save(partial);
    const result = measure();
    assert.equal(result.summary.status, "incomplete");
    assert.equal(result.summary.line_coverage_percent, 50);
    assert.equal(result.summary.reason, "No execution observations for 1 files containing functions.");
    assert.ok(arrayOf(shape({ name: string, coverage_percent: nullable(finite), complexity_coverage_risk: nullable(finite) }))(result.functions));
    assert.deepEqual(result.functions.map((fn) => [fn.name, fn.coverage_percent, fn.complexity_coverage_risk]),
      [["covered", 100, 1], ["uncovered", 0, 2], ["pending", null, null]]);
    save(full);
    assert.equal(measure().summary.status, "complete");
    assert.equal(measure().summary.changed_scope_status, "not_configured");
    const git = (...args: string[]) => childProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
    config.audit.base = "missing-reference";
    assert.equal(measure().summary.changed_scope_status, "incomplete");
    assert.equal(measure().summary.changed_executable_lines, null);
    config.audit.changedSince = "HEAD";
    assert.equal(measure().summary.changed_scope_status, "available");
    assert.equal(measure().summary.changed_executable_lines, 0);
    assert.equal(measure().summary.changed_line_coverage_percent, null);
    fs.writeFileSync(file, text.replace("return 1", "return 3"));
    assert.equal(measure().summary.status, "incomplete", "stale coverage must not become fresh through Git scoping");
    save(full);
    const changed = measure();
    assert.equal(changed.summary.status, "complete");
    assert.equal(changed.summary.changed_executable_lines, 1);
    assert.equal(changed.summary.changed_line_coverage_percent, 100);
    assert.equal(changed.summary.line_coverage_percent, 100 * 2 / 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
