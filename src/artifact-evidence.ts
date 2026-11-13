import { validProducerPayload } from "./producer-payload.js";
import { familyApplicability, validRuleApplicability } from "./rule-applicability.js";
import { separateTelemetry } from "./artifact-telemetry.js";
import { capabilityEvidence, validCapabilityEvidence, type CapabilityEvidence, type CapabilityStatus } from "./capability-evidence.js";
import { isRecord, isUnknownArray } from "./collections.js";
import { findingRecords, FINDING_COLLECTIONS, isScoredRecord } from "./findings.js";
import { arrayOf, boolean, nullable, optional, shape } from "./validation.js";
import { isWireEvidence, type WireEvidence } from "./wire-evidence.js";
import type { Artifact, Config, ScoredRecord } from "./types.js";
const scope = "producer invocation; per-rule/file coverage is not implied";

function capability(name: string, status: CapabilityStatus, reason?: string): CapabilityEvidence {
  return capabilityEvidence(name, scope, status === "completed" ? 1 : 0, status === "completed" ? 0 : 1,
    status === "completed" ? [] : [reason || "Required evidence is missing, incomplete or outside supported scope."], status);
}

function toolCapability(name: string, value: Record<string, unknown>, disabled: boolean): CapabilityEvidence {
  const complete = value.complete === true || (value.complete === undefined && value.ran === true && !value.reason);
  const status: CapabilityStatus = disabled ? "disabled" : value.available === false ? "unavailable"
    : value.ran !== true ? "failed_execution" : complete ? "completed" : "partial";
  return capability(name, status, typeof value.reason === "string" ? value.reason : undefined);
}

function producerStatus(artifact: Artifact): CapabilityStatus {
  const { task_id: task, summary, confidence } = artifact;
  const fallback = confidence.complete === true ? "completed" : "partial";
  switch (task) {
    case "quality.modern_web": return summary.status === "disabled" ? "disabled" : summary.status === "unavailable" ? "unavailable"
      : summary.status === "failed" ? "failed_execution" : "partial";
    case "quality.type_health": return confidence.typescript_program_loaded === true ? fallback : "unavailable";
    case "quality.lint": return artifact.tool_status?.typed_eslint?.ran === true ? fallback : "unavailable";
    case "correctness.all": return ["passed", "failed"].includes(artifact.execution?.status ?? "") ? "completed" : "unavailable";
    case "quality.runtime": case "quality.sarif": case "testing.coverage": case "quality.package_health":
      return summary.status === "not_configured" || summary.status === "disabled" ? "disabled" : summary.status === "complete" ? "completed" : "partial";
    case "audit": return summary.complete === true ? fallback : "partial";
    default: return fallback;
  }
}
function producerCapability(artifact: Artifact): CapabilityEvidence {
  const { task_id: task, summary, confidence } = artifact;
  const status = producerStatus(artifact);
  const reasons = [
    ...(confidence.missing_input ?? []), ...(confidence.stale_input ?? []),
    ...(confidence.unsupported_pattern ?? []).map((item) => item.message ?? item.kind),
    ...(task === "audit" && isUnknownArray(summary.incomplete_reasons) ? summary.incomplete_reasons : []),
  ].filter((item): item is string => typeof item === "string");
  return capability(task, status, reasons.join("; ") || (status === "disabled" ? "Not configured or disabled in the selected profile." : undefined));
}

/** Additive native projection. Legacy test/import envelopes without run identity remain legacy. */
export function attachArtifactEvidence(config: Config, artifact: Artifact): Artifact {
  if (typeof artifact.provenance.run_id !== "string") return artifact;
  artifact = separateTelemetry(artifact);
  const primary = producerCapability(artifact);
  const tools = toolCapabilities(config, artifact);
  const result: Artifact = { ...artifact,
    confidence: { ...artifact.confidence, complete: primary.status === "completed",
      partial: !["completed", "disabled", "not_applicable"].includes(primary.status), capability_status: primary.status },
    capabilities: [primary, ...tools],
    rule_applicability: artifact.rule_applicability ?? familyApplicability(config, artifact),
  };
  result.evidence_contract = projectWireEvidence(result);
  const problem = nativeEvidenceProblem(result, config);
  if (problem) throw new Error(`Invalid native evidence projection for ${artifact.task_id}: ${problem}`);
  return result;
}

function toolCapabilities(config: Config, artifact: Artifact): CapabilityEvidence[] {
  if (artifact.task_id === "quality.modern_web") {
    const tool = artifact.tool_status?.modern_web;
    const status = tool?.status === "disabled" ? "disabled" : tool?.status === "unavailable" ? "unavailable"
      : tool?.status === "failed" ? "failed_execution" : tool?.complete === true ? "completed" : "partial";
    return [capability("quality.modern_web/modern_web", status, typeof tool?.reason === "string" ? tool.reason : undefined)];
  }
  return Object.entries(artifact.tool_status ?? {}).filter(([, value]) => isRecord(value)).map(([name, value]) =>
    toolCapability(`${artifact.task_id}/${name}`, name === "compiler_api" ? { ...value, ran: value.loaded, complete: value.loaded } : value, (name === "jsx_a11y" && !config.accessibility.enabled) ||
      (name === "knip" && !config.cleanup.knip) || (name === "modern_web" && !config.modernWeb.enabled) ||
      (artifact.task_id === "quality.package_health" && !config.packageHealth.enabled)));
}

type WireRun = Extract<WireEvidence, { kind: "run" }>;
const comparisonInput = shape({ baseline: nullable((value: unknown): value is WireRun => isWireEvidence(value) && value.kind === "run") });

function projectWireEvidence(artifact: Artifact): WireEvidence[] {
  const run = runEvidence(artifact);
  return [run, ...comparisonEvidence(artifact, run),
    ...FINDING_COLLECTIONS.flatMap((key) => findingRecords(artifact[key])).map((record) => findingEvidence(record, run.id)),
    ...summaryEvidence(artifact, run.id)];
}
function runEvidence(artifact: Artifact): WireRun {
  const identity = artifact.analysis_identity;
  if (!identity || typeof artifact.provenance.run_id !== "string" || typeof artifact.provenance.input_set_hash !== "string") {
    throw new Error("Native run evidence needs analysis and input identity");
  }
  return { schema_version: 1, kind: "run", id: artifact.provenance.run_id,
    analyzer: { name: "ts-react-quality-lens", version: String(artifact.provenance.analyzer_version) },
    ruleset: identity.id, config_fingerprint: identity.config_closure_hash, input_fingerprint: artifact.provenance.input_set_hash,
    language_profile: `typescript/${identity.compiler_api_version ?? "unknown"};framework/${artifact.project.framework}`,
    producers: Object.entries(identity.integration_versions).flatMap(([name, version]) => version ? [{ name, version }] : []),
  };
}
function findingEvidence(record: ScoredRecord, runId: string): WireEvidence {
  return {
    schema_version: 1, kind: "finding", id: record.id, rule_id: record.rule_id ?? "ts-react-quality-lens/unknown",
    subject: record.id, run_id: runId,
    locations: record.file ? [{ file: record.file, line: Math.max(1, record.line ?? 1) }] : [],
    evidence_kind: record.evidence_kind ?? "heuristic", confidence: record.finding_confidence ?? "low",
    severity: ["error", "high"].includes(record.severity ?? record.risk ?? "") ? "error"
      : ["warning", "medium"].includes(record.severity ?? record.risk ?? "") ? "warning" : "note",
    disposition: record.disposition ?? "review", message: record.message ?? record.id,
    suppression: record.suppressed ? { reason: record.suppression_reason?.trim() || "Configured suppression" } : null,
  };
}
function summaryEvidence(artifact: Artifact, runId: string): WireEvidence[] {
  return Object.entries(artifact.summary).flatMap(([name, value]) =>
    typeof value === "number" ? [{ schema_version: 1, kind: "measurement", name: `${artifact.task_id}/summary/${name}`,
      value, unit: name.endsWith("percent") ? "percent" : "producer-defined", scope: String(artifact.confidence.confidence_scope ?? "project"),
      model: `${artifact.analysis_identity?.rulesets.builtin ?? "native-v1"}/${artifact.task_id}/${name}`, run_id: runId, uncertainty: null,
      limitations: ["Native summary observation; consult producer formula. Not calibrated accuracy or cross-language comparability."] }] : []);
}
function comparisonEvidence(artifact: Artifact, run: WireRun): WireEvidence[] {
  const comparison = artifact.comparison;
  if (comparison === undefined) return [];
  if (!comparisonInput(comparison)) throw new Error("Invalid native comparison baseline");
  const baseline = comparison.baseline;
  const expectedStatus = artifact.summary.base_snapshot_compatible === true ? "compatible" : artifact.summary.base_snapshot_compatible === false ? "incompatible" : "unknown";
  if (comparison.status !== expectedStatus || comparison.status === "compatible" &&
      (!baseline || baseline.ruleset !== run.ruleset || baseline.config_fingerprint !== run.config_fingerprint)) {
    throw new Error("Comparison disagrees with native compatibility evidence");
  }
  const entry = { schema_version: 1, kind: "comparison", status: comparison.status, current_run: run.id,
    baseline_run: baseline === null ? null : baseline.id, reasons: comparison.reasons };
  if (!isWireEvidence(entry)) throw new Error("Invalid native comparison outcome");
  return baseline === null ? [entry] : [baseline, entry];
}

const toolStatus = shape({ available: optional(boolean), ran: optional(boolean), complete: optional(boolean) });
const toolStatuses = (value: unknown): value is Record<string, unknown> => isRecord(value) && Object.values(value).every(toolStatus);
const nativeShape = shape({ capabilities: arrayOf(validCapabilityEvidence), evidence_contract: arrayOf(isWireEvidence),
  tool_status: optional(toolStatuses), execution: optional(isRecord) });
const findingsCollection = optional(arrayOf(isScoredRecord));
function structureProblem(artifact: Artifact): string | null {
  if (!nativeShape(artifact)) {
    const invalid = isUnknownArray(artifact.evidence_contract) ? artifact.evidence_contract.find((entry) => !isWireEvidence(entry)) : undefined;
    return invalid === undefined ? "capabilities, evidence contract or tool status have an invalid shape"
      : `invalid wire evidence ${excerpt(invalid)}`;
  }
  const primary = artifact.capabilities[0];
  if (!primary || primary.capability !== artifact.task_id) return "the primary capability does not describe this task";
  if (artifact.confidence.complete !== (primary.status === "completed")) return "confidence.complete disagrees with the primary capability";
  if (artifact.execution !== undefined && !["passed", "failed", "not_run", "unknown"].includes(String(artifact.execution.status))) {
    return `unknown execution status ${JSON.stringify(artifact.execution.status)}`;
  }
  const collection = FINDING_COLLECTIONS.find((key) => !findingsCollection(artifact[key]));
  return collection ? `${collection} contains a record without a string id` : null;
}
function excerpt(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
function wireIdentity(entry: WireEvidence): string {
  switch (entry.kind) {
    case "run": case "finding": return `${entry.kind}:${entry.id}`;
    case "measurement": return `measurement:${entry.name}`;
    case "comparison": return `comparison:${entry.current_run}`;
  }
}

/** Validate references and the native/common projection together, not just JSON shapes. */
export function validNativeEvidence(artifact: Artifact, config?: Config): boolean {
  return nativeEvidenceProblem(artifact, config) === null;
}

/** The first reason native evidence is invalid, precise enough to name the offending record; null when valid. */
export function nativeEvidenceProblem(artifact: Artifact, config?: Config): string | null {
  if (artifact.provenance.run_id === undefined) return null;
  try {
    const structure = structureProblem(artifact);
    if (structure) return structure;
    if (!validProducerPayload(artifact)) return "the task payload does not match its producer contract";
    if (!validRuleApplicability(artifact.rule_applicability, artifact.task_id)) return "rule applicability is invalid";
    if (config && JSON.stringify(artifact.capabilities) !== JSON.stringify([producerCapability(artifact), ...toolCapabilities(config, artifact)])) {
      return "capabilities do not match the evidence they summarize";
    }
    const expected = projectWireEvidence(artifact);
    const seen = new Set<string>();
    const duplicates = [...new Set(expected.map(wireIdentity).filter((identity) => seen.has(identity) || !seen.add(identity)))];
    if (duplicates.length) return `duplicate evidence identities ${duplicates.slice(0, 5).join(", ")}${duplicates.length > 5 ? ` (+${duplicates.length - 5} more)` : ""}`;
    return JSON.stringify(expected) === JSON.stringify(artifact.evidence_contract) ? null : "the evidence contract does not match its native projection";
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
