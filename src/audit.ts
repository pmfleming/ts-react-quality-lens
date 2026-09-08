import { isSuppressed } from "./actions.js";
import { analysisConfidence, createAnalysisContext } from "./analysis-context.js";
import { analysisIdentity, artifactBase, sourceSetHash } from "./provenance.js";
import { writeArtifact } from "./writer.js";
import { baseSnapshotFindingIds, readBaselineIds, writeBaseline } from "./audit/baseline.js";
import { changeSetSince, defaultBase, type LineRange } from "./audit/change-set.js";
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
  diffAvailable: boolean;
  comparisonBase: string | null;
  incompleteReasons: string[];
};

type FindingSets = {
  findings: AuditFinding[];
  active: AuditFinding[];
  gated: AuditFinding[];
  incompleteReasons: string[];
};

export function runAudit(config: Config, command: string, options: AuditOptions = {}): AuditArtifact {
  const scope = auditScope(config, options);
  config = { ...config, audit: { ...config.audit, base: scope.base, changedSince: scope.base } };
  const context = createAnalysisContext(config);
  runAuditMeasurements(config, command, context, true);
  const baselineIds = readBaselineIds(options.baseline ?? config.audit.baseline);
  const baseSnapshot = scope.comparisonBase ? baseSnapshotFindingIds(config, scope.comparisonBase, command, baselineIds) : null;
  const baseSnapshotCompatible = baseSnapshot
    ? baseSnapshot.analysisIdentity.id === analysisIdentity(config).id
    : null;
  const baseIds = baseSnapshotCompatible ? baseSnapshot?.findingIds ?? null : null;
  const sets = findingSets(config, scope, baselineIds, baseIds);
  sets.incompleteReasons.push(...scope.incompleteReasons);
  if (scope.diffAvailable && !baseSnapshot) sets.incompleteReasons.push("Base snapshot analysis is unavailable.");
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
  const changes = base ? changeSetSince(config, base) : null;
  return {
    base,
    gate: options.gate ?? config.audit.gate,
    changedFiles: changes?.files ?? [],
    changedLines: changes?.lines ?? new Map<string, LineRange[]>(),
    diffAvailable: changes?.complete === true,
    comparisonBase: changes?.comparisonBase ?? null,
    incompleteReasons: changes?.reason ? [changes.reason] : [],
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
      diffAvailable: scope.diffAvailable,
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
