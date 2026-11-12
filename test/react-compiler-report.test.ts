import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { measureRuntime } from "../src/measures/runtime.js";
import { sourceSetHash, taskInputHash } from "../src/provenance.js";
import { readArtifact } from "../src/writer.js";
import { isRecord } from "../src/collections.js";
import { validProducerPayload } from "../src/producer-payload.js";
import { reactFixture } from "./react-improvement-helpers.js";

function compilerReport(hash: string) {
  return { provenance: { source_set_hash: hash }, producer: { name: "compiler-log-normalizer", version: "1" },
    environment: { build_id: "build-1", react_version: "19.2.0", target: "19" },
    data: { format: "react-compiler-report-v1", compiler: { name: "babel-plugin-react-compiler", version: "1.0.0" },
      scope: { name: "selected app functions", complete: true, functions: [{ id: "app", file: "src/main.tsx", name: "App", line: 1 }] },
      events: [{ function_id: "app" as string | null, kind: "CompileSuccess", reason: "compiled" }] } };
}
function coverage(artifact: ReturnType<typeof measureRuntime>) {
  const item = artifact.import_metadata.react_compiler;
  assert.ok(isRecord(item) && isRecord(item.report) && isRecord(item.report.reported_coverage));
  return { verified: item.source_verified, status: item.report.reported_coverage.status, percent: item.report.reported_coverage.percent };
}

test("compiler logs preserve source/build identity, outcomes and bounded coverage through saved runtime artifacts", () => reactFixture((root, config) => {
  fs.writeFileSync(config.configPath, JSON.stringify({ source_roots: ["src"], runtime_inputs: { react_compiler: "compiler.json" } }));
  config = loadConfig(config.configPath);
  assert.equal(config.runtimeInputs.reactCompiler, path.join(root, "compiler.json"));
  const context = createAnalysisContext(config);
  const hash = sourceSetHash(context.project());
  const report = compilerReport(hash);
  fs.writeFileSync(config.runtimeInputs.reactCompiler!, JSON.stringify(report));
  const result = measureRuntime(config, "compiler import", context);
  assert.equal(result.summary.status, "complete");
  assert.equal(result.records[0]?.compiler_event, "CompileSuccess");
  assert.equal(result.records[0]?.disposition, "info");
  assert.deepEqual(coverage(result), { verified: true, status: "complete", percent: 100 });
  assert.ok(readArtifact(config, "runtime_health.json"));
  const originalHash = taskInputHash(config, "quality.runtime", hash);
  report.data.events[0]!.kind = "CompileSkip";
  report.data.events[0]!.reason = "unsupported syntax";
  fs.writeFileSync(config.runtimeInputs.reactCompiler!, JSON.stringify(report));
  assert.notEqual(taskInputHash(config, "quality.runtime", hash), originalHash);
  const skipped = measureRuntime(config, "compiler skip", context);
  assert.equal(skipped.summary.status, "complete", "a reported skip is an outcome, not ingestion failure");
  assert.equal(skipped.records[0]?.disposition, "review");
  assert.equal(coverage(skipped).percent, 0);
  report.provenance.source_set_hash = "stale";
  fs.writeFileSync(config.runtimeInputs.reactCompiler!, JSON.stringify(report));
  const stale = measureRuntime(config, "stale", context);
  assert.equal(stale.summary.status, "incomplete");
  assert.deepEqual(coverage(stale), { verified: false, status: "unverified", percent: null });
  assert.equal(stale.records[0]?.finding_confidence, "low");
}));

test("partial, incomplete and failed compiler scopes never publish coverage percentages", () => reactFixture((root, config) => {
  config.runtimeInputs.reactCompiler = path.join(root, "compiler.json");
  const context = createAnalysisContext(config);
  const hash = sourceSetHash(context.project());
  for (const mutate of [
    (report: ReturnType<typeof compilerReport>) => { report.data.scope.complete = false; },
    (report: ReturnType<typeof compilerReport>) => { report.data.events = []; },
    (report: ReturnType<typeof compilerReport>) => { report.data.events.push({ kind: "PipelineError", function_id: null, reason: "pipeline crashed" }); },
  ]) {
    const report = compilerReport(hash); mutate(report);
    fs.writeFileSync(config.runtimeInputs.reactCompiler!, JSON.stringify(report));
    const result = measureRuntime(config, "partial", context);
    assert.equal(result.summary.status, "incomplete");
    assert.equal(coverage(result).percent, null);
  }
  const empty = compilerReport(hash); empty.data.scope.functions = []; empty.data.events = [];
  fs.writeFileSync(config.runtimeInputs.reactCompiler, JSON.stringify(empty));
  assert.equal(coverage(measureRuntime(config, "empty", context)).percent, null);
}));

test("compiler report rejects malformed inventories, contradictory outcomes and forged saved coverage", () => reactFixture((root, config) => {
  config.runtimeInputs.reactCompiler = path.join(root, "compiler.json");
  const context = createAnalysisContext(config);
  const hash = sourceSetHash(context.project());
  for (const mutate of [
    (report: ReturnType<typeof compilerReport>) => { report.data.scope.functions[0]!.file = "../outside.tsx"; },
    (report: ReturnType<typeof compilerReport>) => { report.data.scope.functions[0]!.line = 500; },
    (report: ReturnType<typeof compilerReport>) => { report.data.events.push({ ...report.data.events[0]! }); },
    (report: ReturnType<typeof compilerReport>) => { report.data.events[0]!.function_id = "missing"; },
    (report: ReturnType<typeof compilerReport>) => { report.data.events[0]!.kind = "UnknownEvent"; },
    (report: ReturnType<typeof compilerReport>) => { report.environment.build_id = ""; },
    (report: ReturnType<typeof compilerReport>) => { report.data.compiler.version = "latest"; },
  ]) {
    const report = compilerReport(hash); mutate(report);
    fs.writeFileSync(config.runtimeInputs.reactCompiler!, JSON.stringify(report));
    const result = measureRuntime(config, "invalid", context);
    assert.equal(result.summary.status, "incomplete");
    assert.equal(result.records[0]?.kind, "runtime_input_incomplete");
  }
  fs.writeFileSync(config.runtimeInputs.reactCompiler, JSON.stringify(compilerReport(hash)));
  const result = measureRuntime(config, "valid", context);
  const item = result.import_metadata.react_compiler;
  assert.ok(isRecord(item) && isRecord(item.report) && isRecord(item.report.reported_coverage));
  item.report.reported_coverage.percent = 120;
  assert.equal(validProducerPayload(result), false);
}));
