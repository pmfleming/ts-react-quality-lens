import type { AuditArtifact } from "./types.js";

/** Projection only: policy/classification stays in the validated audit pipeline. */
export function auditSarif(audit: AuditArtifact) {
  const results = audit.findings.map((finding) => ({
    ruleId: finding.rule_id ?? String(finding.kind ?? "finding"),
    level: finding.disposition === "block" ? "error" : finding.disposition === "warn" ? "warning" : "note",
    message: { text: finding.message ?? String(finding.kind ?? finding.id) },
    partialFingerprints: { "tsrqlens/finding-id": finding.id },
    locations: finding.file ? [{ physicalLocation: { artifactLocation: { uri: finding.file.replaceAll("\\", "/") },
      region: { startLine: Math.max(1, finding.line ?? 1), ...(finding.column ? { startColumn: finding.column } : {}) } } }] : [],
    relatedLocations: (finding.related_locations ?? []).map((location, index) => ({ id: index + 1,
      physicalLocation: { artifactLocation: { uri: location.file.replaceAll("\\", "/") }, region: { startLine: location.start_line } },
      message: { text: location.role ?? "related" } })),
    ...(finding.suppressed ? { suppressions: [{ kind: "external", status: "accepted", justification: finding.suppression_reason ?? "Configured suppression" }] } : {}),
    properties: { disposition: finding.disposition, producer_disposition: finding.producer_disposition, evidence_kind: finding.evidence_kind,
      confidence: finding.finding_confidence, introduced: finding.introduced, task_id: finding.task_id,
      impact: finding.severity ?? finding.risk, semantic_decision: finding.semantic_decision,
      tool_validation: finding.tool_validation, validation_scope: finding.validation_scope,
      corroborating_producers: finding.corroborating_producers, upstream_finding_id: finding.upstream_finding_id,
      blocking_contract: finding.blocking_contract, native_finding: finding },
  }));
  const failures = (audit.summary.verification_failures ?? []).map((message) => ({
    ruleId: "tsrqlens/required-verification", level: "error", message: { text: message },
    properties: { disposition: "block", suppressible: false },
  }));
  return { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{
    tool: { driver: { name: "ts-react-quality-lens" } },
    invocations: [{ executionSuccessful: audit.summary.complete,
      toolExecutionNotifications: audit.summary.incomplete_reasons.map((text) => ({ level: "error", message: { text } })) }],
    properties: { verdict: audit.summary.verdict, analysis_identity: audit.analysis_identity, reconciliation: audit.reconciliation ?? [],
      capabilities: audit.capabilities, evidence_contract: audit.evidence_contract, audit_summary: audit.summary },
    results: [...results, ...failures],
  }] };
}
