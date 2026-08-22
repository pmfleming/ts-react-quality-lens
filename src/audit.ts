import { isSuppressed } from "./actions.js";
import { analysisConfidence, createAnalysisContext } from "./analysis-context.js";
import { analysisIdentity, artifactBase, sourceSetHash } from "./provenance.js";
import { writeArtifact } from "./writer.js";
import { baseSnapshotFindingIds, readBaselineIds, writeBaseline } from "./audit/baseline.js";
import { changedFilesSince, changedLineRangesSince, defaultBase, type LineRange } from "./audit/change-set.js";
import auditMarkdown from "./audit/render.js";
import {
  auditVerdict,
  collectFindings,
  requiredEvidenceReasons,
  runAuditMeasurements,
  staleSuppressionFindings,
} from "./audit/findings.js";
import type { AnalysisContext, AuditArtifact, AuditFinding, Config } from "./types.js";

export { auditMarkdown };

type AuditOptions = {
  base?: string | null;
  changedSince?: string | null;
  gate?: "new-only" | "all" | null;
  baseline?: string | null;
  saveBaseline?: string | null;
};

type AuditScope = {
  base: string | null;
  gate: "new-only" | "all";
  changedFiles: string[];
  changedLines: Map<string, LineRange[]>;
};

type FindingSets = {
  findings: AuditFinding[];
  active: AuditFinding[];
  gated: AuditFinding[];
  incompleteReasons: string[];
};

export function runAudit(config: Config, command: string, options: AuditOptions = {}): AuditArtifact {
  const context = createAnalysisContext(config);
  const scope = auditScope(config, options);
  runAuditMeasurements(config, command, context, true);
  const baselineIds = readBaselineIds(options.baseline ?? config.audit.baseline);
  const baseSnapshot = scope.base ? baseSnapshotFindingIds(config, scope.base, command, baselineIds) : null;
  const baseSnapshotCompatible = baseSnapshot
    ? baseSnapshot.analysisIdentity.id === analysisIdentity(config).id
    : null;
  const baseIds = baseSnapshotCompatible ? baseSnapshot?.findingIds ?? null : null;
  const sets = findingSets(config, scope, baselineIds, baseIds);
  if (baseSnapshot && baseSnapshotCompatible === false) {
    sets.incompleteReasons.push("Base snapshot analysis identity differs from the current compiler, config, ruleset, or integration identity.");
  }
  const artifact = auditArtifact(config, command, context, scope, sets, baseSnapshot !== null, baseSnapshotCompatible);
  writeArtifact(config, "audit.json", artifact);
  if (options.saveBaseline) writeBaseline(options.saveBaseline, sets.findings);
  return artifact;
}

function auditScope(config: Config, options: AuditOptions): AuditScope {
  const base = options.changedSince ?? options.base ?? config.audit.changedSince ?? config.audit.base ?? defaultBase(config);
  return {
    base,
    gate: options.gate ?? config.audit.gate,
    changedFiles: base ? changedFilesSince(config, base) : [],
    changedLines: base ? changedLineRangesSince(config, base) : new Map(),
  };
}

function findingSets(
  config: Config,
  scope: AuditScope,
  baselineIds: Set<string>,
  baseFindingIds: Set<string> | null,
): FindingSets {
  const allFindings = collectFindings(config, {
    changedFiles: [],
    changedLines: new Map(),
    baselineIds,
    includeAll: true,
  });
  const findings = [
    ...collectFindings(config, {
      changedFiles: scope.changedFiles,
      changedLines: scope.changedLines,
      baselineIds,
      baseFindingIds,
    }),
    ...staleSuppressionFindings(config, allFindings),
  ];
  const active = findings.filter((finding) => !isSuppressed(finding) && (scope.gate === "all" || finding.introduced));
  const gated = active.filter((finding) => finding.disposition === "block" || finding.disposition === "warn");
  return { findings, active, gated, incompleteReasons: requiredEvidenceReasons(config) };
}

function auditArtifact(
  config: Config,
  command: string,
  context: AnalysisContext,
  scope: AuditScope,
  sets: FindingSets,
  baseSnapshotAvailable: boolean,
  baseSnapshotCompatible: boolean | null,
): AuditArtifact {
  const project = context.project();
  const incompleteReasons = sets.incompleteReasons;
  return {
    ...artifactBase(
      config,
      "audit",
      command,
      analysisConfidence(config, project, {
        confidence_scope: "changed_code_audit",
        changed_files_available: scope.changedFiles.length > 0,
        audit_base: scope.base,
        base_snapshot_available: baseSnapshotAvailable,
        base_snapshot_compatible: baseSnapshotCompatible,
      }),
      sourceSetHash(project),
    ),
    task_id: "audit",
    summary: {
      verdict: auditVerdict(sets.gated, incompleteReasons),
      complete: incompleteReasons.length === 0,
      incomplete_reasons: incompleteReasons,
      gate: scope.gate,
      base: scope.base,
      changed_files: scope.changedFiles.length,
      changed_hunks: [...scope.changedLines.values()].reduce((count, ranges) => count + ranges.length, 0),
      base_snapshot_available: baseSnapshotAvailable,
      base_snapshot_compatible: baseSnapshotCompatible,
      findings: sets.findings.length,
      active_findings: sets.gated.length,
      introduced_findings: countFindings(sets.findings, (finding) => finding.introduced),
      inherited_findings: countFindings(sets.findings, (finding) => !finding.introduced),
      high_risk_findings: countFindings(sets.active, (finding) => finding.risk === "high" || finding.severity === "high"),
      blocking_findings: countFindings(sets.gated, (finding) => finding.disposition === "block"),
      warning_findings: countFindings(sets.gated, (finding) => finding.disposition === "warn"),
      baseline_suppressed: countFindings(sets.findings, (finding) => finding.suppression_reason === "Suppressed by audit baseline."),
      config_suppressed: countFindings(
        sets.findings,
        (finding) => isSuppressed(finding) && finding.suppression_reason !== "Suppressed by audit baseline.",
      ),
      stale_suppressions: countFindings(sets.findings, (finding) => finding.kind === "stale_suppression"),
    },
    findings: sets.findings,
  };
}

function countFindings(findings: AuditFinding[], predicate: (finding: AuditFinding) => boolean): number {
  return findings.filter(predicate).length;
}
