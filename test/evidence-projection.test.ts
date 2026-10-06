import assert from "node:assert/strict";
import test from "node:test";
import { attachArtifactEvidence, validNativeEvidence } from "../src/artifact-evidence.js";
import { validCapabilityEvidence, type CapabilityStatus } from "../src/capability-evidence.js";
import { loadConfig } from "../src/config.js";
import { artifactBase } from "../src/provenance.js";
import { fileRuleApplicability } from "../src/rule-applicability.js";
import { BLOCKING_TYPED_RULES } from "../src/rule-policy.js";
import type { Artifact } from "../src/types.js";
import { arrayOf } from "../src/validation.js";
import { isWireEvidence } from "../src/wire-evidence.js";

function fixture() {
  const config = loadConfig("examples/basic/ts-react-quality-lens.config.json");
  config.packageHealth.enabled = true;
  const seed: Artifact = { ...artifactBase(config, "quality.hotspots", "projection-fixture", { complete: true }, "synthetic-source"), summary: {} };
  return { config, seed };
}
const completeTool = { available: true, ran: true, complete: true, reason: null };
const missingTool = { available: false, ran: false, complete: false, reason: "missing" };

test("producer capability states retain task-specific precedence over input confidence", () => {
  const { config, seed } = fixture();
  const cases: Array<[string, Partial<Artifact>, CapabilityStatus, CapabilityStatus]> = [
    ["quality.hotspots", {}, "completed", "partial"],
    ["quality.type_health", { confidence: { typescript_program_loaded: true }, tool_status: { compiler_api: { loaded: true } }, diagnostics: [] }, "completed", "partial"],
    ["quality.type_health", { confidence: { typescript_program_loaded: false }, tool_status: { compiler_api: { loaded: false } }, diagnostics: [] }, "unavailable", "unavailable"],
    ["quality.lint", { tool_status: { typed_eslint: { ...completeTool, evaluated_files: [] } } }, "completed", "partial"],
    ["quality.lint", { tool_status: { typed_eslint: { ...missingTool, evaluated_files: [] } } }, "unavailable", "unavailable"],
    ["correctness.all", { execution: { status: "passed", command: "test" } }, "completed", "completed"],
    ["correctness.all", { execution: { status: "failed", command: "test", exit_code: 1, stdout: "", stderr: "failed" } }, "completed", "completed"],
    ["correctness.all", { execution: { status: "not_run", command: null } }, "unavailable", "unavailable"],
    ["correctness.all", { execution: { status: "unknown", reason: "unavailable" } }, "unavailable", "unavailable"],
    ["audit", { summary: { complete: true, verdict: "pass", incomplete_reasons: [], verification_failures: [] }, findings: [] }, "completed", "partial"],
    ["audit", { summary: { complete: false, verdict: "incomplete", incomplete_reasons: ["missing"], verification_failures: [] }, findings: [] }, "partial", "partial"],
  ];
  for (const task of ["quality.runtime", "quality.sarif", "testing.coverage", "quality.package_health"]) {
    for (const [status, expected] of [["not_configured", "disabled"], ["complete", "completed"], ["incomplete", "partial"]] as const) {
      const packageTask = task === "quality.package_health";
      const tool = status === "complete" ? completeTool : missingTool;
      cases.push([task, { summary: { status: packageTask && status === "not_configured" ? "disabled" : status, complete: status === "complete" },
        tool_status: packageTask ? Object.fromEntries(["declaration_emit", "npm_pack", "publint", "are_the_types_wrong"].map((name) => [name, tool])) : { input: { ...tool, path: "input.json" } },
        files: [], functions: [], package_evidence: { publint_messages: [], attw_problems: [] } }, expected, expected]);
    }
  }
  for (const [task, payload, whenComplete, whenPartial] of cases) for (const complete of [true, false]) {
    const candidate: Artifact = { ...seed, ...payload, task_id: task, confidence: { ...payload.confidence, complete } };
    if (task === "quality.lint") candidate.rule_applicability = fileRuleApplicability(BLOCKING_TYPED_RULES, ["synthetic.ts"],
      candidate.tool_status?.typed_eslint?.ran === true ? ["synthetic.ts"] : [], () => true);
    const result = attachArtifactEvidence(config, candidate);
    assert.ok(arrayOf(validCapabilityEvidence)(result.capabilities));
    assert.equal(result.capabilities[0]?.status, complete ? whenComplete : whenPartial, `${task}/${String(payload.summary?.status)}/${complete}`);
    assert.equal(result.confidence.complete, result.capabilities[0]?.status === "completed");
    assert.ok(validNativeEvidence(result, config));
  }
});

test("native projections retain ordering, defaults, severity precedence and comparison linkage", () => {
  const { config, seed } = fixture();
  const initial = attachArtifactEvidence(config, seed);
  assert.ok(arrayOf(isWireEvidence)(initial.evidence_contract));
  assert.ok(arrayOf(validCapabilityEvidence)(initial.capabilities));
  const run = initial.evidence_contract.find((entry) => entry.kind === "run");
  assert.ok(run);
  const candidate: Artifact = { ...seed,
    summary: { count: 0, rate_percent: 50, ignored: "label", base_snapshot_compatible: true },
    comparison: { status: "compatible", baseline: { ...run, id: "baseline" }, reasons: [] },
    records: [{ id: "record", file: "src/a.ts", line: 0, severity: "warning", risk: "high" }],
    groups: [{ id: "group", risk: "high" }], findings: [{ id: "finding", suppressed: true }],
    disagreements: [{ id: "disagreement", severity: "note", risk: "high" }], unconfirmed: [{ id: "unconfirmed" }],
  };
  const result = attachArtifactEvidence(config, candidate);
  assert.ok(arrayOf(isWireEvidence)(result.evidence_contract));
  const wire = result.evidence_contract;
  assert.deepEqual(wire.map((entry) => entry.kind), ["run", "run", "comparison", ...Array<string>(5).fill("finding"), "measurement", "measurement"]);
  assert.deepEqual(wire.filter((entry) => entry.kind === "finding").map((entry) => [entry.id, entry.severity]),
    [["record", "warning"], ["group", "error"], ["finding", "note"], ["disagreement", "note"], ["unconfirmed", "note"]]);
  assert.deepEqual(wire[3], { schema_version: 1, kind: "finding", id: "record", rule_id: "ts-react-quality-lens/unknown", subject: "record", run_id: run.id,
    locations: [{ file: "src/a.ts", line: 1 }], evidence_kind: "heuristic", confidence: "low", severity: "warning", disposition: "review", message: "record", suppression: null });
  assert.deepEqual(wire.filter((entry) => entry.kind === "finding").find((entry) => entry.id === "finding")?.suppression, { reason: "Configured suppression" });
  assert.deepEqual(wire.filter((entry) => entry.kind === "measurement").map((entry) => [entry.name, entry.unit, entry.value]),
    [["quality.hotspots/summary/count", "producer-defined", 0], ["quality.hotspots/summary/rate_percent", "percent", 50]]);
  for (const baseline of [null, { ...run, ruleset: "different" }, { ...run, config_fingerprint: "different" }, run]) {
    assert.throws(() => attachArtifactEvidence(config, { ...candidate, comparison: { status: "compatible", baseline, reasons: [] } }));
  }
  assert.throws(() => attachArtifactEvidence(config, { ...candidate, groups: [{ id: "record" }] }), /native evidence/);
  for (const status of ["unknown", "incompatible"] as const) {
    const summary = { base_snapshot_compatible: status === "unknown" ? null : false };
    assert.ok(validNativeEvidence(attachArtifactEvidence(config, { ...seed, summary, comparison: { status, baseline: null, reasons: ["not comparable"] } }), config));
    assert.throws(() => attachArtifactEvidence(config, { ...seed, summary, comparison: { status, baseline: null, reasons: [] } }));
  }
  for (const mutation of [{ capabilities: [] }, { capabilities: [{ ...initial.capabilities[0], capability: "wrong" }] },
    { evidence_contract: [] }, { tool_status: { corrupt: { ran: "yes" } } }, { execution: null }, { records: [null] }, { confidence: null }, { summary: null }]) {
    assert.equal(validNativeEvidence(Object.assign(structuredClone(result), mutation), config), false);
  }
  const legacy = structuredClone(seed);
  delete legacy.provenance.run_id;
  assert.equal(attachArtifactEvidence(config, legacy), legacy);
});
