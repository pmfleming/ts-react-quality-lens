import { separateTelemetry } from "./artifact-telemetry.js";
import { capabilityEvidence, validCapabilityEvidence, type CapabilityEvidence, type CapabilityStatus } from "./capability-evidence.js";
import { isRecord } from "./collections.js";
import { isWireEvidence, type WireEvidence } from "./wire-evidence.js";
import type { Artifact, Config, ScoredRecord } from "./types.js";

const findingCollections = ["records", "groups", "findings", "disagreements", "unconfirmed"] as const;
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

function producerCapability(artifact: Artifact): CapabilityEvidence {
  const { task_id: task, summary, confidence } = artifact;
  let status: CapabilityStatus = confidence.complete === true ? "completed" : "partial";
  if (task === "quality.type_health" && confidence.typescript_program_loaded !== true) status = "unavailable";
  if (task === "quality.lint" && artifact.tool_status?.typed_eslint?.ran !== true) status = "unavailable";
  if (task === "correctness.all") status = ["passed", "failed"].includes(artifact.execution?.status ?? "") ? "completed" : "unavailable";
  if (["quality.runtime", "quality.sarif", "testing.coverage", "quality.package_health"].includes(task)) {
    status = summary.status === "not_configured" || summary.status === "disabled" ? "disabled"
      : summary.status === "complete" ? "completed" : "partial";
  }
  if (task === "audit" && summary.complete !== true) status = "partial";
  const reasons = [
    ...(confidence.missing_input ?? []), ...(confidence.stale_input ?? []),
    ...(confidence.unsupported_pattern ?? []).map((item) => item.message ?? item.kind),
    ...(task === "audit" && Array.isArray(summary.incomplete_reasons) ? summary.incomplete_reasons : []),
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
  };
  result.evidence_contract = projectWireEvidence(result);
  if (!validNativeEvidence(result, config)) throw new Error(`Invalid native evidence projection for ${artifact.task_id}`);
  return result;
}

function toolCapabilities(config: Config, artifact: Artifact): CapabilityEvidence[] {
  return Object.entries(artifact.tool_status ?? {}).filter(([, value]) => isRecord(value)).map(([name, value]) =>
    toolCapability(`${artifact.task_id}/${name}`, value, (name === "jsx_a11y" && !config.accessibility.enabled) ||
      (name === "knip" && !config.cleanup.knip) || (artifact.task_id === "quality.package_health" && !config.packageHealth.enabled)));
}

function nativeFindings(artifact: Artifact): ScoredRecord[] {
  return findingCollections.flatMap((key) => {
    const values = artifact[key];
    return Array.isArray(values) ? values.filter((value): value is ScoredRecord => isRecord(value) && typeof value.id === "string") : [];
  });
}

function projectWireEvidence(artifact: Artifact): WireEvidence[] {
  const identity = artifact.analysis_identity;
  if (!identity || typeof artifact.provenance.run_id !== "string" || typeof artifact.provenance.input_set_hash !== "string") {
    throw new Error("Native run evidence needs analysis and input identity");
  }
  const runId = artifact.provenance.run_id;
  const findings: WireEvidence[] = nativeFindings(artifact).map((record) => ({
    schema_version: 1, kind: "finding", id: record.id, rule_id: record.rule_id ?? "ts-react-quality-lens/unknown",
    subject: record.id, run_id: runId,
    locations: record.file ? [{ file: record.file, line: Math.max(1, record.line ?? 1) }] : [],
    evidence_kind: record.evidence_kind ?? "heuristic", confidence: record.finding_confidence ?? "low",
    severity: ["error", "high"].includes(record.severity ?? record.risk ?? "") ? "error"
      : ["warning", "medium"].includes(record.severity ?? record.risk ?? "") ? "warning" : "note",
    disposition: record.disposition ?? "review", message: record.message ?? record.id,
    suppression: record.suppressed ? { reason: record.suppression_reason ?? "Configured suppression" } : null,
  }));
  const measurements: WireEvidence[] = Object.entries(artifact.summary).flatMap(([name, value]) =>
    typeof value === "number" ? [{ schema_version: 1, kind: "measurement", name: `${artifact.task_id}/summary/${name}`,
      value, unit: name.endsWith("percent") ? "percent" : "producer-defined", scope: String(artifact.confidence.confidence_scope ?? "project"),
      model: `${identity.rulesets.builtin ?? "native-v1"}/${artifact.task_id}/${name}`, run_id: runId, uncertainty: null,
      limitations: ["Native summary observation; consult producer formula. Not calibrated accuracy or cross-language comparability."] }] : []);
  return [{ schema_version: 1, kind: "run", id: runId,
    analyzer: { name: "ts-react-quality-lens", version: String(artifact.provenance.analyzer_version) },
    ruleset: identity.id, config_fingerprint: identity.config_closure_hash, input_fingerprint: artifact.provenance.input_set_hash,
    language_profile: `typescript/${identity.compiler_api_version ?? "unknown"};framework/${artifact.project.framework}`,
    producers: Object.entries(identity.integration_versions).flatMap(([name, version]) => version ? [{ name, version }] : []),
  }, ...findings, ...measurements];
}

/** Validate references and the native/common projection together, not just JSON shapes. */
export function validNativeEvidence(artifact: Artifact, config?: Config): boolean {
  if (artifact.provenance.run_id === undefined) return true;
  if (!Array.isArray(artifact.capabilities) || !artifact.capabilities.length || !artifact.capabilities.every(validCapabilityEvidence)) return false;
  if (artifact.capabilities[0]?.capability !== artifact.task_id ||
      artifact.confidence.complete !== (artifact.capabilities[0]?.status === "completed")) return false;
  if (!Array.isArray(artifact.evidence_contract) || !artifact.evidence_contract.every(isWireEvidence)) return false;
  if (artifact.tool_status !== undefined && (!isRecord(artifact.tool_status) || !Object.values(artifact.tool_status).every((status) =>
    isRecord(status) && ["available", "ran", "complete"].every((key) => status[key] === undefined || typeof status[key] === "boolean")))) return false;
  if (artifact.execution !== undefined && (!isRecord(artifact.execution) || !["passed", "failed", "not_run", "unknown"].includes(String(artifact.execution.status)))) return false;
  for (const key of findingCollections) {
    if (artifact[key] !== undefined && (!Array.isArray(artifact[key]) || !(artifact[key] as unknown[]).every((item) => isRecord(item) && typeof item.id === "string"))) return false;
  }
  try {
    if (config && JSON.stringify(artifact.capabilities) !== JSON.stringify([producerCapability(artifact), ...toolCapabilities(config, artifact)])) return false;
    const expected = projectWireEvidence(artifact);
    const identities = expected.map((entry) => entry.kind === "run" || entry.kind === "finding" ? `${entry.kind}:${entry.id}`
      : entry.kind === "measurement" ? `measurement:${entry.name}` : `comparison:${entry.current_run}`);
    if (new Set(identities).size !== identities.length) return false;
    return JSON.stringify(expected) === JSON.stringify(artifact.evidence_contract);
  } catch { return false; }
}
