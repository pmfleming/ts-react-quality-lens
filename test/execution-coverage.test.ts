import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { parseExecutionCoverage } from "../src/coverage.js";
import { readSourceFile } from "../src/files.js";
import { runMeasure } from "../src/measure-runner.js";
import { sourceSetHash } from "../src/provenance.js";

test("LCOV, Istanbul and original-source V8 preserve executed and uncovered lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-coverage-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src/a.js");
    const text = "function a() { return 1; }\na();\n";
    fs.writeFileSync(file, text);
    const sources = [readSourceFile(file, root)];
    const lcov = "SF:src/a.js\nDA:1,0\nDA:2,1\nend_of_record\n";
    const expected = [{ file: "src/a.js", line_hits: [{ line: 1, hits: 0 }, { line: 2, hits: 1 }] }];
    assert.deepEqual(parseExecutionCoverage("lcov", lcov, root, sources), expected);
    assert.deepEqual(parseExecutionCoverage("istanbul", { "src/a.js": { statementMap: { a: { start: { line: 1 }, end: { line: 1 } }, b: { start: { line: 2 }, end: { line: 2 } } }, s: { a: 0, b: 1 } } }, root, sources), expected);
    assert.deepEqual(parseExecutionCoverage("v8", { result: [{ url: file, functions: [{ ranges: [{ startOffset: 0, endOffset: text.indexOf("\n"), count: 0 }, { startOffset: text.indexOf("\n") + 1, endOffset: text.length, count: 1 }] }] }] }, root, sources), expected);
    assert.throws(() => parseExecutionCoverage("lcov", lcov.replace("src/a.js", "../elsewhere.js"), root, sources), /unmapped/);
    assert.throws(() => parseExecutionCoverage("lcov", lcov.replace("end_of_record", ""), root, sources), /Unterminated/);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"coverage"}');
    const configPath = path.join(root, "ts-react-quality-lens.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ source_roots: ["src"], coverage_report: "coverage.json" }));
    const config = loadConfig(configPath);
    const report = { format: "lcov", data: lcov, provenance: { source_set_hash: sourceSetHash(createAnalysisContext(config).project()) }, producer: { name: "fixture", version: "1" } };
    fs.writeFileSync(path.join(root, "coverage.json"), JSON.stringify(report));
    const [artifact] = runMeasure(config, "testing.coverage", "test");
    assert.equal(artifact?.summary.status, "complete");
    assert.equal(artifact?.summary.line_coverage_percent, 50);
    fs.appendFileSync(file, "a();\n");
    const [stale] = runMeasure(config, "testing.coverage", "test");
    assert.equal(stale?.summary.status, "incomplete");
    assert.equal(stale?.summary.line_coverage_percent, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
