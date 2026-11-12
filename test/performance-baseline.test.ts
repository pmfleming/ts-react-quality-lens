import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { isRecord } from "../src/collections.js";
import { measureRuntime } from "../src/measures/runtime.js";
import { sourceSetHash, taskInputHash } from "../src/provenance.js";
import { validProducerPayload } from "../src/producer-payload.js";
import { readArtifact } from "../src/writer.js";
import { reactFixture } from "./react-improvement-helpers.js";

function snapshot(hash: string, buildId: string, bytes = 100, samples = [10, 20, 30, 40, 50]) {
  return { provenance: { source_set_hash: hash }, producer: { name: "performance-exporter", version: "1" },
    environment: { build_id: buildId, build: "production", build_config_hash: "config-a", toolchain_hash: "toolchain-a", react_version: "19.2.0", browser_targets: ["chrome 140"],
      runtime_context: { browser: "Chrome", browser_version: "140", os: "Linux", device: "runner-a", network: "offline-fixture", viewport: "1280x800",
        harness_version: "1", scenario_version: "1", cache_state: "warm" } },
    data: { format: "react-performance-snapshot-v1", bundles: { complete: true, routes: ["/", "/search"], encodings: ["gzip"], entries: [
      { route: "/", chunk: "shared", loading: "initial", encoding: "gzip", bytes },
      { route: "/search", chunk: "shared", loading: "initial", encoding: "gzip", bytes },
    ] }, runtime: { complete: true, entries: [{ scenario: "search", metric: "render-duration", unit: "ms", samples: samples.map((value, index) => ({ run_id: `run-${index}`, value })) }] } } };
}
function report(artifact: ReturnType<typeof measureRuntime>) {
  const item = artifact.import_metadata.performance_comparison;
  assert.ok(isRecord(item) && isRecord(item.report)); return item.report;
}

test("bundle/runtime comparisons use matching conditions and preserve route attribution, sample distributions and zero baselines", () => reactFixture((_root, config) => {
  fs.writeFileSync(config.configPath, JSON.stringify({ source_roots: ["src"], runtime_inputs: { performance_current: "current.json", performance_baseline: "baseline.json" } }));
  config = loadConfig(config.configPath);
  const context = createAnalysisContext(config); const hash = sourceSetHash(context.project());
  const baseline = snapshot("historical-source", "old", 100);
  const current = snapshot(hash, "new", 150, [20, 30, 40, 50, 60]);
  fs.writeFileSync(config.runtimeInputs.performanceCurrent!, JSON.stringify(current));
  fs.writeFileSync(config.runtimeInputs.performanceBaseline!, JSON.stringify(baseline));
  const artifact = measureRuntime(config, "compare", context);
  assert.equal(artifact.summary.status, "complete");
  assert.equal(report(artifact).status, "comparable");
  assert.equal(artifact.summary.performance_comparisons, 6, "two route/phase totals plus median and p95");
  const bundles = artifact.records.filter((item) => item.metric === "route-bundle-bytes" && item.loading === "initial");
  assert.equal(bundles.length, 2);
  assert.ok(bundles.every((item) => item.delta === 50 && item.delta_percent === 50), "shared bytes remain attributed per route");
  assert.ok(artifact.records.filter((item) => item.loading === "deferred").every((item) => item.delta_percent === null));
  assert.equal(artifact.records.find((item) => item.metric === "runtime-median")?.delta, 10);
  assert.equal(artifact.records.find((item) => item.metric === "runtime-p95")?.baseline_value, 50);
  assert.ok(artifact.records.every((item) => item.disposition === "review"));
  assert.ok(readArtifact(config, "runtime_health.json"));
  const schema = new Ajv2020({ strict: false }).compile(JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8")));
  assert.ok(schema(artifact), JSON.stringify(schema.errors));
  const original = taskInputHash(config, "quality.runtime", hash);
  baseline.data.bundles.entries[0]!.bytes = 90;
  fs.writeFileSync(config.runtimeInputs.performanceBaseline!, JSON.stringify(baseline));
  assert.notEqual(taskInputHash(config, "quality.runtime", hash), original, "baseline edits invalidate evidence");
  artifact.records[0]!.delta = 999;
  assert.equal(validProducerPayload(artifact), false);
}));

test("source, producer, build and toolchain mismatches withhold deltas", () => reactFixture((root, config) => {
  config.runtimeInputs.performanceCurrent = path.join(root, "current.json");
  config.runtimeInputs.performanceBaseline = path.join(root, "baseline.json");
  const context = createAnalysisContext(config); const hash = sourceSetHash(context.project());
  const baseline = snapshot("historical", "old");
  fs.writeFileSync(config.runtimeInputs.performanceBaseline, JSON.stringify(baseline));
  for (const mutate of [
    (value: ReturnType<typeof snapshot>) => { value.provenance.source_set_hash = "stale"; },
    (value: ReturnType<typeof snapshot>) => { value.producer.version = "2"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.browser_targets = ["safari 18"]; },
    (value: ReturnType<typeof snapshot>) => { value.environment.build_config_hash = "other"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.toolchain_hash = "other"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.build = "development"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.react_version = "19.3.0"; },
  ]) {
    const current = snapshot(hash, "new"); mutate(current);
    fs.writeFileSync(config.runtimeInputs.performanceCurrent, JSON.stringify(current));
    const artifact = measureRuntime(config, "mismatch", context);
    assert.ok(!artifact.records.some((item) => item.kind === "performance_delta"));
    assert.ok(["incompatible", "unverified"].includes(String(report(artifact).status)));
  }
}));

test("runtime context, incomplete scope and insufficient samples do not contaminate comparable bundle evidence", () => reactFixture((root, config) => {
  config.runtimeInputs.performanceCurrent = path.join(root, "current.json");
  config.runtimeInputs.performanceBaseline = path.join(root, "baseline.json");
  const context = createAnalysisContext(config); const hash = sourceSetHash(context.project());
  fs.writeFileSync(config.runtimeInputs.performanceBaseline, JSON.stringify(snapshot("historical", "old")));
  for (const mutate of [
    (value: ReturnType<typeof snapshot>) => { value.environment.runtime_context.device = "other-machine"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.runtime_context.scenario_version = "2"; },
    (value: ReturnType<typeof snapshot>) => { value.environment.runtime_context.cache_state = "cold"; },
    (value: ReturnType<typeof snapshot>) => { value.data.runtime.complete = false; },
    (value: ReturnType<typeof snapshot>) => { value.data.runtime.entries[0]!.samples = [{ run_id: "one", value: 10 }]; },
  ]) {
    const current = snapshot(hash, "new"); mutate(current);
    fs.writeFileSync(config.runtimeInputs.performanceCurrent, JSON.stringify(current));
    const artifact = measureRuntime(config, "partial comparison", context);
    assert.equal(artifact.records.filter((item) => String(item.metric).startsWith("runtime-")).length, 0);
    assert.equal(report(artifact).status, "comparable");
    assert.ok(Array.isArray(report(artifact).not_compared) && (report(artifact).not_compared as unknown[]).length > 0);
  }
  const current = snapshot(hash, "new"); current.data.runtime.complete = false; current.data.bundles.complete = false;
  fs.writeFileSync(config.runtimeInputs.performanceCurrent, JSON.stringify(current));
  assert.equal(report(measureRuntime(config, "no comparisons", context)).status, "incompatible");
}));

test("snapshot validation rejects duplicate samples, duplicate chunks, unknown scope, impossible values and missing pairs", () => reactFixture((root, config) => {
  config.runtimeInputs.performanceCurrent = path.join(root, "current.json");
  config.runtimeInputs.performanceBaseline = path.join(root, "baseline.json");
  const context = createAnalysisContext(config); const hash = sourceSetHash(context.project());
  fs.writeFileSync(config.runtimeInputs.performanceBaseline, JSON.stringify(snapshot("historical", "old")));
  for (const mutate of [
    (value: ReturnType<typeof snapshot>) => { value.data.runtime.entries[0]!.samples[0]!.value = -1; },
    (value: ReturnType<typeof snapshot>) => { value.data.runtime.entries[0]!.samples[0]!.run_id = "run-1"; },
    (value: ReturnType<typeof snapshot>) => { value.data.bundles.entries.push({ ...value.data.bundles.entries[0]! }); },
    (value: ReturnType<typeof snapshot>) => { value.data.bundles.entries[0]!.route = "/unknown"; },
    (value: ReturnType<typeof snapshot>) => { value.data.bundles.entries[0]!.bytes = -1; },
    (value: ReturnType<typeof snapshot>) => { value.environment.runtime_context.browser = ""; },
  ]) {
    const current = snapshot(hash, "new"); mutate(current);
    fs.writeFileSync(config.runtimeInputs.performanceCurrent, JSON.stringify(current));
    const artifact = measureRuntime(config, "invalid", context);
    assert.equal(artifact.summary.status, "incomplete");
    assert.equal(artifact.records[0]?.kind, "runtime_input_incomplete");
  }
  fs.writeFileSync(config.runtimeInputs.performanceCurrent, JSON.stringify(snapshot(hash, "new")));
  fs.writeFileSync(config.runtimeInputs.performanceBaseline, "broken JSON");
  assert.equal(measureRuntime(config, "bad baseline", context).summary.status, "incomplete");
  config.runtimeInputs.performanceBaseline = null;
  assert.equal(measureRuntime(config, "missing pair", context).summary.status, "incomplete");
}));

test("equivalent snapshot ordering produces identical records and unmatched routes remain explicit", () => reactFixture((root, config) => {
  config.runtimeInputs.performanceCurrent = path.join(root, "current.json");
  config.runtimeInputs.performanceBaseline = path.join(root, "baseline.json");
  const context = createAnalysisContext(config); const hash = sourceSetHash(context.project());
  const current = snapshot(hash, "new"); const baseline = snapshot("historical", "old");
  const measure = () => { fs.writeFileSync(config.runtimeInputs.performanceCurrent!, JSON.stringify(current));
    fs.writeFileSync(config.runtimeInputs.performanceBaseline!, JSON.stringify(baseline)); return measureRuntime(config, "compare", context); };
  const first = measure().records;
  current.data.bundles.entries.reverse(); baseline.data.bundles.routes.reverse(); current.data.runtime.entries[0]!.samples.reverse();
  assert.deepEqual(measure().records, first);
  current.data.bundles.routes.push("/new-route");
  assert.ok(JSON.stringify(report(measure()).not_compared).includes("/new-route"));
}));
