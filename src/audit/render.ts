import { isSuppressed } from "../actions.js";
import type { AuditArtifact, AuditFinding } from "../types.js";

export default function auditMarkdown(artifact: AuditArtifact): string {
  const lines = [...summaryLines(artifact), ""];
  const active = activeFindings(artifact);
  if (!active.length) return `${[...lines, "No active findings."].join("\n")}\n`;
  lines.push("## Active Findings", "", ...active.slice(0, 25).map(findingLine));
  if (active.length > 25) lines.push(`- ...and ${active.length - 25} more`);
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
  return `- ${finding.disposition ?? "review"} ${finding.kind}: ${location || finding.id}`;
}
