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
import { validProducerPayload } from "../src/producer-payload.js";
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

test("exclusive coverage excludes nested implementations and withholds ambiguous shared-line risk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-coverage-ownership-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.ts"), [
      "export function outer() {", "  const value = 1;", "  function inner(", "    arg = 0", "  ) {", "    return arg;", "  }", "  return value;", "}",
      "export const first = () => 1, second = () => 2;",
      "export const curry = () => () => 1;", "",
    ].join("\n"));
    const config = loadConfig(path.join(root, "lens.json"));
    const reportPath = path.join(root, "coverage.json");
    config.coverageReport = reportPath;
    const context = createAnalysisContext(config), project = context.project();
    const save = (extra: string) => fs.writeFileSync(reportPath, JSON.stringify({ format: "lcov",
      data: `SF:src/a.ts\nDA:2,1\nDA:6,0\nDA:8,1\nDA:10,1\nDA:11,1\n${extra}end_of_record\n`,
      provenance: { source_set_hash: sourceSetHash(project) }, producer: { name: "fixture", version: "1" } }));
    const measure = () => {
      const result = runMeasure(config, "testing.coverage", "ownership", { context })[0];
      assert.ok(result && arrayOf(shape({ name: string, coverage_percent: nullable(finite), complexity_coverage_risk: nullable(finite) }))(result.functions));
      assert.ok(validProducerPayload(result));
      const forged = structuredClone(result);
      assert.ok(Array.isArray(forged.functions));
      const ambiguous = result.functions.findIndex((fn) => fn.attribution_status === "ambiguous");
      forged.functions[ambiguous] = { ...result.functions[ambiguous], coverage_percent: 100, complexity_coverage_risk: 1 };
      assert.equal(validProducerPayload(forged), false);
      return result.functions;
    };
    save("");
    const functions = measure(), outer = functions.find((fn) => fn.name === "outer");
    assert.equal(outer?.coverage_percent, 100);
    assert.equal(outer?.inclusive_body_coverage_percent, 100 * 2 / 3);
    assert.deepEqual(outer?.excluded_nested_lines, [6]);
    assert.equal(functions.find((fn) => fn.name === "inner")?.coverage_percent, 0);
    for (const name of ["first", "second", "curry", "anonymous"]) {
      const fn = functions.find((item) => item.name === name);
      assert.equal(fn?.attribution_status, "ambiguous", name);
      assert.equal(fn?.coverage_percent, null, name);
      assert.equal(fn?.complexity_coverage_risk, null, name);
    }
    save("DA:4,1\nDA:5,1\nDA:7,0\n");
    assert.ok(measure().filter((fn) => ["outer", "inner"].includes(fn.name)).every((fn) => fn.coverage_percent === null && fn.complexity_coverage_risk === null));
    config.cache.enabled = true;
    createAnalysisContext(config).project();
    assert.deepEqual(createAnalysisContext(config).project().modules[0]?.functions, project.modules[0]?.functions);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("large flat function inventories avoid pairwise attribution scans, including absent observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-coverage-scale-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    const count = 1000;
    fs.writeFileSync(path.join(root, "src/a.ts"), Array.from({ length: count }, (_, index) => `export function f${index}() {\n  return ${index};\n}\n`).join(""));
    const config = loadConfig(path.join(root, "lens.json"));
    config.coverageReport = path.join(root, "coverage.json");
    const context = createAnalysisContext(config), project = context.project();
    let spanReads = 0;
    for (const fn of project.modules.flatMap((module) => module.functions)) {
      const start = fn.start;
      Object.defineProperty(fn, "start", { get() { spanReads++; return start; }, enumerable: true });
    }
    const measure = () => {
      const artifact = runMeasure(config, "testing.coverage", "scale", { context })[0];
      assert.ok(artifact && arrayOf(shape({ coverage_percent: nullable(finite) }))(artifact.functions));
      return artifact.functions;
    };
    assert.ok(measure().every((fn) => fn.coverage_percent === null));
    assert.equal(spanReads, 0, "absent observations need no ownership comparisons");
    fs.writeFileSync(config.coverageReport, JSON.stringify({ format: "lcov",
      data: `SF:src/a.ts\n${Array.from({ length: count }, (_, index) => `DA:${index * 3 + 2},1`).join("\n")}\nend_of_record\n`,
      provenance: { source_set_hash: context.sourceHash() }, producer: { name: "fixture", version: "1" } }));
    const functions = measure();
    assert.equal(functions.length, count);
    assert.ok(functions.every((fn) => fn.coverage_percent === 100));
    assert.ok(spanReads < count * 10, `flat functions must not compare all pairs: ${spanReads} span reads`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
