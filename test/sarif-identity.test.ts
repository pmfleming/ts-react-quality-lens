import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { collectFindings } from "../src/audit/findings.js";
import { loadConfig } from "../src/config.js";
import { measureSarif } from "../src/measures/sarif.js";
import { readArtifact } from "../src/writer.js";
import type { Config } from "../src/types.js";

function fixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-sarif-identity-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  try { run(root, loadConfig(path.join(root, "lens.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function result(ruleId = "rule-a", file = "src/a.ts", line = 1, fingerprints: Record<string, string> = { primaryLocationLineHash: "same" }) {
  return {
    ruleId, level: "error", message: { text: ruleId }, partialFingerprints: fingerprints,
    locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } } }],
  };
}

function run(name: string, results: ReturnType<typeof result>[]) {
  return { tool: { driver: { name } }, results };
}

function report(file: string, runs: ReturnType<typeof run>[]): void {
  fs.writeFileSync(file, JSON.stringify({ version: "2.1.0", runs }));
}

test("SARIF fingerprints are isolated by input, scanner, rule, file, and occurrence", () => fixture((root, config) => {
  const first = path.join(root, "first.sarif");
  const second = path.join(root, "second.sarif");
  config.sarifInputs = [
    { name: "first", path: first, required: true },
    { name: "second", path: second, required: true },
  ];
  report(first, [
    run("scanner", [result(), result("rule-b"), result("rule-a", "src/b.ts"), result()]),
    run("other-scanner", [result()]),
    run("scanner", [result()]),
  ]);
  report(second, [run("scanner", [result()])]);
  const context = createAnalysisContext(config);
  const initial = measureSarif(config, "test", context).records;
  assert.equal(initial.length, 7);
  assert.equal(new Set(initial.map((item) => item.id)).size, 7);
  const selected = initial[0];
  assert.ok(selected);
  config.suppressions = [{ id: selected.id, reason: "Only this finding" }];
  measureSarif(config, "test", context);
  assert.equal(readArtifact(config, "sarif_findings.json")?.records?.filter((item) => item.suppressed).length, 1);
  const findings = collectFindings(config, {
    changedFiles: ["src/a.ts"], changedLines: new Map(), diffAvailable: true,
    baselineIds: new Set([selected.id]), baseFindingIds: new Set([selected.id]),
  });
  assert.equal(findings.filter((item) => !item.introduced).length, 1);
  assert.equal(findings.filter((item) => item.introduced && !item.suppressed).length, 6);
}));

test("SARIF fingerprint identities survive movement, result reordering, and fingerprint-key ordering", () => fixture((root, config) => {
  const file = path.join(root, "report.sarif");
  config.sarifInputs = [{ name: "scanner", path: file, required: true }];
  const context = createAnalysisContext(config);
  report(file, [run("scanner", [
    result("rule-a", "src/a.ts", 1, { first: "one", second: "two" }), result("rule-b"),
  ])]);
  const initial = measureSarif(config, "test", context).records.map((item) => item.id).sort();
  report(file, [run("scanner", [
    result("rule-b", "src/a.ts", 10), result("rule-a", "src/a.ts", 20, { second: "two", first: "one" }),
  ])]);
  assert.deepEqual(measureSarif(config, "test", context).records.map((item) => item.id).sort(), initial);
}));

test("SARIF results without fingerprints retain duplicate occurrences", () => fixture((root, config) => {
  const file = path.join(root, "report.sarif");
  config.sarifInputs = [{ name: "scanner", path: file, required: true }];
  report(file, [run("scanner", [result("rule-a", "src/a.ts", 1, {}), result("rule-a", "src/a.ts", 1, {})])]);
  const context = createAnalysisContext(config);
  const initial = measureSarif(config, "test", context).records;
  assert.equal(new Set(initial.map((item) => item.id)).size, 2);
  assert.deepEqual(initial.map((item) => item.occurrence), [1, 2]);
  assert.deepEqual(measureSarif(config, "test", context).records.map((item) => item.id), initial.map((item) => item.id));
}));
