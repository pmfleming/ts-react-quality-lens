import { enrichFinding, findingKind, suppressionMatches } from "../actions.js";
import { findingRecords } from "../findings.js";
import { MEASURE_TASKS } from "../measures/registry.js";
import { TASKS } from "../tasks.js";
import { readArtifact } from "../writer.js";
import { findingTouchesChangedFile, findingTouchesChangedLine, stripSourceExtension, type LineRange } from "./change-set.js";
import type {
  AnalysisContext,
  AuditFinding,
  AuditVerdict,
  Config,
  FindingDisposition,
  PolicyCheck,
  ScoredRecord,
} from "../types.js";

const AUDIT_TASK_IDS = [
  "quality.hotspots",
  "quality.clones",
  "quality.escape_hatches",
  "quality.type_health",
  "quality.lint",
  "quality.dependency_health",
  "correctness.all",
  "quality.locality_dynamic",
  "quality.locality_leverage",
  "quality.react_health",
  "quality.cleanup",
  "quality.package_health",
  "quality.sarif",
  "quality.runtime",
  "quality.modern_web",
  "testing.coverage",
];

type FindingScope = {
  changedFiles: string[];
  changedLines: Map<string, LineRange[]>;
  baselineIds: Set<string>;
  includeAll?: boolean;
  diffAvailable?: boolean;
  baseFindingIds?: Set<string> | null;
};

export function runAuditMeasurements(config: Config, command: string, context: AnalysisContext, includeTests: boolean): void {
  for (const taskId of AUDIT_TASK_IDS) {
    const measurement = !includeTests && taskId === "correctness.all" ? "correctness.catalog" : taskId;
    MEASURE_TASKS.get(measurement)?.handler(config, command, context);
  }
}

export function collectFindings(config: Config, scope: FindingScope): AuditFinding[] {
  const changed = new Set(scope.changedFiles.map(stripSourceExtension));
  const noDiffScope = scope.includeAll || (!scope.diffAvailable && changed.size === 0);
  return AUDIT_TASK_IDS.flatMap((taskId) => taskFindings(config, taskId)).flatMap((raw) => {
    const enriched = enrichFinding(config, raw.finding);
    const newInSnapshot = scope.baseFindingIds && !scope.baseFindingIds.has(enriched.id);
    if (!noDiffScope && !newInSnapshot && !findingTouchesChangedFile(enriched, changed)) return [];
    return [auditFinding(config, raw.taskId, enriched, scope, Boolean(noDiffScope))];
  });
}

export function collectApplicability(config: Config) {
  return AUDIT_TASK_IDS.flatMap((taskId) => {
    const task = TASKS.find((candidate) => candidate.id === taskId);
    const artifact = task ? readArtifact(config, task.artifact) : null;
    return artifact && Array.isArray(artifact.rule_applicability) && artifact.rule_applicability.length
      ? [{ task_id: taskId, rules: artifact.rule_applicability }] : [];
  });
}

export function collectReconciliation(config: Config) {
  return AUDIT_TASK_IDS.flatMap((taskId) => {
    const task = TASKS.find((candidate) => candidate.id === taskId);
    const artifact = task ? readArtifact(config, task.artifact) : null;
    return artifact ? [{ task_id: taskId,
      relationships: artifact.engine_relationships ?? [],
      observations: [...findingRecords(artifact.records).filter((record) => record.tool_validation !== undefined),
        ...findingRecords(artifact.disagreements), ...findingRecords(artifact.unconfirmed), ...findingRecords(artifact.engine_observations)],
    }].filter((item) => item.observations.length > 0 || Array.isArray(item.relationships) && item.relationships.length > 0) : [];
  });
}

function taskFindings(config: Config, taskId: string): Array<{ taskId: string; finding: ScoredRecord }> {
  const task = TASKS.find((candidate) => candidate.id === taskId);
  const artifact = task ? readArtifact(config, task.artifact) : null;
  return [...findingRecords(artifact?.records), ...findingRecords(artifact?.groups)]
    .map((finding) => ({ taskId, finding }));
}

function auditFinding(
  config: Config,
  taskId: string,
  finding: ScoredRecord,
  scope: FindingScope,
  noDiffScope: boolean,
): AuditFinding {
  const baselineSuppressed = scope.baselineIds.has(finding.id);
  return {
    ...finding,
    disposition: policyDisposition(config, finding),
    kind: findingKind(finding),
    task_id: taskId,
    introduced: introducedByDiffOrBase(finding, noDiffScope, scope.changedLines, scope.baseFindingIds ?? null),
    ...(baselineSuppressed ? { suppressed: true, suppression_reason: "Suppressed by audit baseline." } : {}),
  };
}

function introducedByDiffOrBase(
  finding: ScoredRecord,
  noDiffScope: boolean,
  changedLines: Map<string, LineRange[]>,
  baseFindingIds: Set<string> | null,
): boolean {
  if (baseFindingIds) return !baseFindingIds.has(finding.id);
  if (noDiffScope) return true;
  return findingTouchesChangedLine(finding, changedLines);
}

function policyDisposition(config: Config, finding: ScoredRecord): FindingDisposition {
  if (finding.source === "eslint-plugin-react-hooks" && finding.disposition === "info") return "info";
  if (finding.source === "typescript-eslint" && !config.policy.requiredChecks.includes("typed-lint")) return "review";
  if (finding.source === "eslint-plugin-react-hooks" && !config.policy.requiredChecks.includes("react-hooks")) return "review";
  if (["publint", "are-the-types-wrong", "declaration-emit", "pack", "attw"].includes(String(finding.source)) &&
      !config.policy.requiredChecks.includes("package")) return "review";
  return finding.disposition ?? "review";
}

export function staleSuppressionFindings(config: Config, findings: AuditFinding[]): AuditFinding[] {
  return config.suppressions.flatMap((suppression, index) => {
    // An optional scanner with unknown per-file coverage cannot prove that its suppression is stale.
    if (suppression.id?.startsWith("modern-web:") || suppression.kind === "web_modernization_candidate") return [];
    if (findings.some((finding) => suppressionMatches(suppression, finding))) return [];
    const id = suppression.id ?? `${suppression.kind ?? "finding"}:${suppression.file ?? index + 1}`;
    return [{
      id: `suppression:stale:${index + 1}:${id}`,
      kind: "stale_suppression",
      rule_id: "ts-react-quality-lens/stale-suppression",
      evidence_kind: "diagnostic",
      disposition: "warn",
      finding_confidence: "high",
      message: "Configured suppression no longer matches a finding.",
      scope: suppression.file ? "file" : "project",
      task_id: "audit",
      introduced: true,
      ...(suppression.file ? { file: suppression.file } : {}),
      score: 35,
      risk: "medium",
      signals: [
        { kind: "configured_suppression_no_longer_matches" },
        ...(suppression.id ? [{ kind: "suppression_id", value: suppression.id }] : []),
        ...(suppression.kind ? [{ kind: "suppression_kind", value: suppression.kind }] : []),
      ],
      actions: [{
        type: "fix",
        auto_fixable: false,
        description: "Remove this stale suppression from the config.",
        fix: "remove-stale-suppression",
      }],
    } satisfies AuditFinding];
  });
}

export function auditVerdict(findings: AuditFinding[], incompleteReasons: string[], verificationFailures: string[] = []): AuditVerdict {
  if (verificationFailures.length || findings.some((finding) => finding.disposition === "block")) return "fail";
  if (incompleteReasons.length) return "incomplete";
  return findings.some((finding) => finding.disposition === "warn") ? "warn" : "pass";
}

export function requiredVerificationFailures(config: Config): string[] {
  const failures: string[] = [];
  if (config.policy.requiredChecks.includes("compiler") && readArtifact(config, "type_health.json")?.records?.some((record) => record.kind === "compiler_diagnostic" && record.disposition === "block")) {
    failures.push("Required compiler verification failed; suppressions and baselines do not establish correctness.");
  }
  if (config.policy.requiredChecks.includes("tests") && readArtifact(config, "correctness_review.json")?.execution?.status === "failed") {
    failures.push("Required test execution failed; suppressions and baselines do not establish correctness.");
  }
  return failures;
}

function verificationArtifact(config: Config, name: string) {
  const artifact = readArtifact(config, name);
  // Legacy envelopes remain readable diagnostics, never proof of current verification.
  return typeof artifact?.provenance.run_id === "string" ? artifact : null;
}

function toolEvidence(artifact: string, tool: string, label: string) {
  return (config: Config): string | null => {
    const status = verificationArtifact(config, artifact)?.tool_status?.[tool];
    return status?.ran === true && status.complete === true ? null : `Required ${label} analysis did not complete.`;
  };
}
const EVIDENCE_CHECKS: Record<PolicyCheck, (config: Config) => string | null> = {
  compiler: (config) => verificationArtifact(config, "type_health.json")?.confidence.typescript_program_loaded === true
    ? null
    : "TypeScript compiler program did not load.",
  "typed-lint": toolEvidence("lint_health.json", "typed_eslint", "type-aware ESLint"),
  tests: testEvidenceReason,
  "react-hooks": toolEvidence("react_health.json", "eslint_react_hooks", "React Hooks"),
  package: (config) => verificationArtifact(config, "package_health.json")?.summary.complete === true
    ? null
    : "Required package health analysis did not complete.",
};

export function requiredEvidenceReasons(config: Config): string[] {
  const reasons = config.policy.requiredChecks.flatMap((check) => EVIDENCE_CHECKS[check](config) ?? []);
  if (config.sarifInputs.some((input) => input.required)) {
    const statuses = Object.values(verificationArtifact(config, "sarif_findings.json")?.tool_status ?? {});
    for (const input of config.sarifInputs.filter((input) => input.required)) {
      if (!statuses.some((status) => status.path === input.path && status.required === true &&
          status.available === true && status.ran === true && status.complete === true)) {
        reasons.push(`Required SARIF input ${input.name} did not complete.`);
      }
    }
  }
  if (Object.values(config.runtimeInputs).some((input) => input !== null) &&
      verificationArtifact(config, "runtime_health.json")?.summary.status !== "complete") {
    reasons.push("Configured runtime evidence did not complete.");
  }
  if (config.coverageReport && verificationArtifact(config, "execution_coverage.json")?.summary.status !== "complete") {
    reasons.push("Configured execution coverage is incomplete or stale.");
  }
  return reasons;
}

function testEvidenceReason(config: Config): string | null {
  if (!config.testCommand) return "Tests are required but no test command is configured.";
  const execution = verificationArtifact(config, "correctness_review.json")?.execution;
  return execution && ["passed", "failed"].includes(execution.status ?? "") ? null : "Required test execution did not complete.";
}
