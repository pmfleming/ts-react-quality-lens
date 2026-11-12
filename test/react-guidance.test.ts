import assert from "node:assert/strict";
import fs from "node:fs";
import { reactFixture as fixture } from "./react-improvement-helpers.js";
import path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { enabledReactRules, OFFICIAL_REACT_RULES, reactRuleCoverage, reactRuleDocumentation, selectReactRules } from "../src/react-guidance.js";
import { reactReviewRecords } from "../src/react-review.js";
import { reactSupport } from "../src/react-support.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { measureRuntime } from "../src/measures/runtime.js";
import { sourceSetHash } from "../src/provenance.js";
import { collectFindings } from "../src/audit/findings.js";
import { validProducerPayload } from "../src/producer-payload.js";
import { readArtifact } from "../src/writer.js";
import { frameworkRiskRecords } from "../src/scoring.js";
import type { EslintReactHooksResult } from "../src/types.js";

const schema = new Ajv2020({ strict: false }).compile(JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8")));
const positive = `import { useState as state, useEffect as effect } from 'react';
export function Profile({ first, last }) {
  const [name, setName] = state('');
  const [settings] = state(JSON.parse('{}'));
  effect(() => { setName(first + last); }, [first, last]);
  return <div>{name}{settings}</div>;
}
`;

test("official React inventory describes the actual preset and never treats disabled or failed checks as evaluated", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/main.tsx"), positive);
  const result = measureReactHealth(config, "guidance test");
  assert.equal(result.tool_status.eslint_react_hooks.complete, true);
  assert.equal(result.tool_status.eslint_react_hooks.selected_preset, selectReactRules(config.react.ruleset).preset);
  for (const name of OFFICIAL_REACT_RULES) assert.ok(result.rule_coverage.some((rule) => rule.rule_id === `react-hooks/${name}`));
  assert.ok(result.rule_coverage.some((rule) => rule.rule_id === "react-hooks/purity" && rule.status === "evaluated"));
  assert.ok(result.records.some((record) => record.kind === "derived-state-effect"));
  assert.ok(schema(result), JSON.stringify(schema.errors));
  assert.ok(readArtifact(config, "react_health.json"));
  const invalidCoverage = structuredClone(result);
  invalidCoverage.rule_coverage[0]!.status = "disabled";
  invalidCoverage.tool_status.eslint_react_hooks.enabled_rules.push(invalidCoverage.rule_coverage[0]!.rule_id);
  assert.equal(validProducerPayload(invalidCoverage), false);
  const findings = collectFindings(config, { changedFiles: [], changedLines: new Map(), baselineIds: new Set(), includeAll: true });
  assert.ok(findings.some((record) => record.kind === "derived-state-effect" && record.disposition === "review"));
  const lint: EslintReactHooksResult = { available: true, ran: true, complete: true, reason: null, version: "test", ruleset: "classic-v1",
    messages: [], enabled_rules: enabledReactRules(selectReactRules("classic-v1").rules) };
  assert.equal(reactRuleCoverage(lint).find((rule) => rule.rule_id === "react-hooks/purity")?.status, "disabled");
  lint.complete = false;
  assert.equal(reactRuleCoverage(lint).find((rule) => rule.rule_id === "react-hooks/rules-of-hooks")?.status, "incomplete");
  delete lint.enabled_rules;
  assert.ok(reactRuleCoverage(lint).every((rule) => rule.status === "unknown"));
  assert.deepEqual(enabledReactRules({ off: 0, disabled: ["off"], warn: [1, {}], error: "error" }), ["error", "warn"]);
  assert.equal(reactRuleDocumentation("react-hooks/future-rule"), "https://react.dev/reference/eslint-plugin-react-hooks");
}));

test("Effect and initializer reviews follow React bindings, preserve movement identity, and abstain on external synchronization", () => fixture((root, config) => {
  const file = path.join(root, "src/main.tsx");
  fs.writeFileSync(file, positive);
  const original = reactReviewRecords(config, createAnalysisContext(config).project());
  assert.deepEqual(original.map((record) => record.kind).sort(), ["derived-state-effect", "eager-state-initializer"]);
  assert.ok(original.every((record) => record.disposition === "review" && record.performance_verified === false && record.semantic_decision === "unresolved"));
  fs.writeFileSync(file, `// moved\n\n${positive}`);
  assert.deepEqual(reactReviewRecords(config, createAnalysisContext(config).project()).map((record) => record.id), original.map((record) => record.id));
  fs.writeFileSync(file, `import React, {useState, useEffect} from 'react';
export function Good({value}) {
  const [name, setName] = React.useState(() => JSON.parse('{}'));
  React.useEffect(() => { setName(value); console.log(value); }, [value]);
  useEffect(() => { setName(previous => previous + value); }, [value]);
  useEffect(() => { const listener = () => setName(value); subscribe(listener); }, [value]);
  return <div>{name}</div>;
}
export function Shadow({value}, useEffect, useState) {
  const [name, setName] = useState(JSON.parse('{}'));
  useEffect(() => { setName(value); }, [value]);
  return <div>{name}</div>;
}
`);
  assert.deepEqual(reactReviewRecords(config, createAnalysisContext(config).project()), []);
  fs.writeFileSync(file, positive.replace("import { useState as state, useEffect as effect } from 'react';", "import * as R from 'react';").replaceAll("state(", "R.useState(").replaceAll("effect(", "R.useEffect("));
  assert.equal(reactReviewRecords(config, createAnalysisContext(config).project()).length, 2);
  fs.writeFileSync(file, positive + "function broken( {");
  assert.deepEqual(reactReviewRecords(config, createAnalysisContext(config).project()), []);
}));

test("compiler declarations never imply activation or justify removing manual memoization", () => fixture((root, config) => {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "guidance", peerDependencies: { react: "^18 || ^19" }, devDependencies: { "babel-plugin-react-compiler": "1.0.0" } }));
  const support = reactSupport(config, createAnalysisContext(config).project().workspaces)[0]!;
  assert.equal(support.compiler.activation, "unverified");
  assert.equal(support.compiler.package_declarations[0]?.name, "babel-plugin-react-compiler");
  assert.match(support.compiler.runtime_requirement, /React 17\/18/);
  assert.match(support.compiler.guidance, /Verify build configuration/);
}));

test("Next recommendations respect framework/version scope and allow server data/render colocation", () => fixture((root, config) => {
  fs.mkdirSync(path.join(root, "src/app"));
  fs.writeFileSync(path.join(root, "src/app/layout.tsx"), "'use client';\nexport default function Layout({children}) { return <html>{children}</html>; }\n");
  fs.writeFileSync(path.join(root, "src/app/page.tsx"), "export default async function Page() { const data = await fetch('/api/data'); return <div>{data.status}</div>; }\n");
  for (const version of ["^16.0.0", "^12.0.0", "catalog:", null]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "guidance", dependencies: { react: "^19", ...(version ? { next: version } : {}) } }));
    const project = createAnalysisContext(config).project();
    const reviews = reactReviewRecords(config, project).filter((record) => record.kind === "next-root-client-boundary");
    assert.equal(reviews.length, version === "^16.0.0" ? 1 : 0, String(version));
    if (version === "^16.0.0") assert.ok(!frameworkRiskRecords(project).some((record) => record.id === "framework:route-responsibility:src/app/page.tsx"));
  }
}));

test("profiler evidence distinguishes render duration, preserves build context, and rejects impossible metrics", () => fixture((root, config) => {
  config.runtimeInputs.reactProfiler = path.join(root, "profile.json");
  const context = createAnalysisContext(config);
  const wrap = (data: unknown, build = "development") => ({ provenance: { source_set_hash: sourceSetHash(context.project()) },
    producer: { name: "fixture-exporter", version: "1" }, environment: { build, react_version: "19.2.0" }, data });
  fs.writeFileSync(config.runtimeInputs.reactProfiler, JSON.stringify(wrap({ commits: [{ component: "App", actualDuration: 70, renderCount: 2 }] })));
  const artifact = measureRuntime(config, "test", context);
  const record = artifact.records[0]!;
  assert.equal(record.measurement_kind, "render_duration");
  assert.equal(record.disposition, "review");
  assert.match(String(record.message), /render time/);
  assert.deepEqual(record.observation_environment, { build: "development", react_version: "19.2.0" });
  assert.ok(schema(artifact), JSON.stringify(schema.errors));
  for (const commit of [{ actualDuration: -1 }, { actualDuration: 10, renderCount: -1 }, { actualDuration: 10, renderCount: 1.5 }, { duration_ms: "invalid", actualDuration: 10 }]) {
    fs.writeFileSync(config.runtimeInputs.reactProfiler, JSON.stringify(wrap({ commits: [commit] })));
    assert.equal(measureRuntime(config, "test", context).summary.status, "incomplete");
  }
}));

test("normalized Performance Tracks retain distinct phases and require supported build/version/provenance", () => fixture((root, config) => {
  config.runtimeInputs.reactProfiler = path.join(root, "tracks.json");
  const context = createAnalysisContext(config);
  const events = [
    { id: "render-1", track: "components", phase: "render", name: "App", start_ms: 0, duration_ms: 90 },
    { id: "cascade-1", track: "scheduler", phase: "cascading-update", name: "setState", start_ms: 10, duration_ms: 0 },
    { id: "request-1", track: "server", phase: "request", name: "fetch", start_ms: 1, duration_ms: 10 },
  ];
  const input = { provenance: { source_set_hash: sourceSetHash(context.project()) }, producer: { name: "normalized-trace-exporter", version: "1" },
    environment: { build: "development", react_version: "19.2.0" }, data: { format: "react-performance-tracks-v1", events } };
  const measure = () => { fs.writeFileSync(config.runtimeInputs.reactProfiler!, JSON.stringify(input)); return measureRuntime(config, "test", context); };
  let result = measure();
  assert.equal(result.summary.status, "complete");
  assert.equal(result.summary.performance_track_observations, 3);
  assert.ok(result.records.every((record) => record.disposition === "review" && record.source === "react-performance-tracks"));
  assert.ok(readArtifact(config, "runtime_health.json"));
  const invalidTrack = structuredClone(result);
  invalidTrack.records[0]!.duration_ms = -10;
  assert.equal(validProducerPayload(invalidTrack), false);
  invalidTrack.records[0]!.duration_ms = 10;
  invalidTrack.records[0]!.track = "__proto__";
  assert.equal(validProducerPayload(invalidTrack), false);
  assert.ok(schema(result), JSON.stringify(schema.errors));
  input.provenance.source_set_hash = "stale";
  result = measure();
  assert.equal(result.summary.status, "incomplete");
  assert.ok(result.records.every((record) => record.finding_confidence === "low"));
  input.provenance.source_set_hash = sourceSetHash(context.project());
  input.environment.build = "profiling";
  assert.equal(measure().summary.status, "incomplete", "server spans cannot come from profiling builds");
  input.data.events = events.slice(0, 2);
  assert.equal(measure().summary.status, "complete");
  input.environment.react_version = "18.3.0";
  assert.equal(measure().summary.status, "incomplete");
  input.environment.react_version = "19.2.0";
  input.data.events = [events[0]!, events[0]!];
  assert.equal(measure().summary.status, "incomplete", "duplicate event IDs must be rejected");
  input.data.events = [{ ...events[0]!, phase: "unknown" }];
  assert.equal(measure().summary.status, "incomplete");
}));
