import { isSuppressed } from "../actions.js";
import type { AuditArtifact, AuditFinding } from "../types.js";

export default function auditMarkdown(artifact: AuditArtifact): string {
  const lines = [...summaryLines(artifact), ""];
  const active = activeFindings(artifact);
  if (!active.length) lines.push("No active findings.", "");
  lines.push("## Findings (all dispositions, inherited and suppressed)", "", ...artifact.findings.map(findingLine));
  if (artifact.reconciliation) lines.push("", "## Engine reconciliation", "", "```json", JSON.stringify(artifact.reconciliation, null, 2), "```");
  return `${lines.join("\n")}\n`;
}

function summaryLines(artifact: AuditArtifact): string[] {
  const summary = artifact.summary;
  return [
    `# ts-react-quality-lens audit: ${summary.verdict}`,
    "",
    `- Gate: ${summary.gate}`,
    `- Base: ${summary.base ?? "none"}`,
    `- Changed files: ${summary.changed_files}`,
    `- Changed hunks: ${summary.changed_hunks}`,
    `- Complete: ${summary.complete}`,
    `- Active findings: ${summary.active_findings}`,
    `- Blocking findings: ${summary.blocking_findings}`,
    `- Warning findings: ${summary.warning_findings}`,
    `- Introduced findings: ${summary.introduced_findings}`,
    `- Inherited findings: ${summary.inherited_findings}`,
    `- Suppressed by baseline: ${summary.baseline_suppressed}`,
    `- Suppressed by config: ${summary.config_suppressed}`,
    `- Stale suppressions: ${summary.stale_suppressions}`,
    ...(summary.verification_failures ?? []).map((reason) => `- Verification failed: ${reason}`),
    ...(summary.incomplete_reasons.length ? [`- Incomplete reasons: ${summary.incomplete_reasons.join("; ")}`] : []),
  ];
}

function activeFindings(artifact: AuditArtifact): AuditFinding[] {
  return artifact.findings.filter((finding) =>
    !isSuppressed(finding) &&
    (artifact.summary.gate === "all" || finding.introduced) &&
    (finding.disposition === "block" || finding.disposition === "warn")
  );
}

function findingLine(finding: AuditFinding): string {
  const location = [finding.file, finding.line].filter((value) => value !== undefined && value !== null).join(":");
  const related = (finding.related_locations ?? []).map((item) => `${item.file}:${item.start_line}`).join(", ");
  return `- ${finding.disposition ?? "review"} ${finding.rule_id ?? finding.kind}: ${location || "project"} ` +
    `[id=${finding.id}; evidence=${finding.evidence_kind}; confidence=${finding.finding_confidence}; decision=${finding.semantic_decision}; ` +
    `introduced=${finding.introduced}; suppressed=${isSuppressed(finding)}] ${finding.message ?? ""}` +
    (finding.suppression_reason ? ` Suppression: ${finding.suppression_reason}` : "") + (related ? ` Related: ${related}` : "");
}
