import { enrichFinding, findingKind, suppressionMatches } from "../actions.js";
import { isRecord } from "../collections.js";
import { MEASURE_TASKS } from "../measures/registry.js";
import { TASKS } from "../tasks.js";
import { readArtifact } from "../writer.js";
import { findingTouchesChangedFile, findingTouchesChangedLine, stripSourceExtension, type LineRange } from "./change-set.js";
import type {
  AnalysisContext,
  Artifact,
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
  "quality.sarif",
];

type FindingScope = {
  changedFiles: string[];
  changedLines: Map<string, LineRange[]>;
  baselineIds: Set<string>;
  includeAll?: boolean;
  baseFindingIds?: Set<string> | null;
};

export function runAuditMeasurements(config: Config, command: string, context: AnalysisContext, includeTests: boolean): void {
  for (const taskId of AUDIT_TASK_IDS) {
    if (!includeTests && taskId === "correctness.all") continue;
    MEASURE_TASKS.get(taskId)?.handler(config, command, context);
  }
}

export function collectFindings(config: Config, scope: FindingScope): AuditFinding[] {
  const changed = new Set(scope.changedFiles.map(stripSourceExtension));
  const noDiffScope = scope.includeAll || changed.size === 0;
  return AUDIT_TASK_IDS.flatMap((taskId) => taskFindings(config, taskId)).flatMap((raw) => {
    const enriched = enrichFinding(config, raw.finding);
    if (!noDiffScope && !findingTouchesChangedFile(enriched, changed)) return [];
    return [auditFinding(config, raw.taskId, enriched, scope, Boolean(noDiffScope))];
  });
}

function taskFindings(config: Config, taskId: string): Array<{ taskId: string; finding: ScoredRecord }> {
  const task = TASKS.find((candidate) => candidate.id === taskId);
  const artifact = task ? readArtifact<Artifact>(config, task.artifact) : null;
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
  if (baseFindingIds && !baseFindingIds.has(finding.id)) return true;
  if (noDiffScope) return baseFindingIds ? !baseFindingIds.has(finding.id) : true;
  return findingTouchesChangedLine(finding, changedLines);
}

function policyDisposition(config: Config, finding: ScoredRecord): FindingDisposition {
  if (finding.source === "typescript-eslint" && !config.policy.requiredChecks.includes("typed-lint")) return "review";
  if (finding.source === "eslint-plugin-react-hooks" && !config.policy.requiredChecks.includes("react-hooks")) return "review";
  if (["publint", "are-the-types-wrong", "declaration-emit", "pack", "attw"].includes(String(finding.source)) &&
      !config.policy.requiredChecks.includes("package")) return "review";
  return finding.disposition ?? "review";
}

export function staleSuppressionFindings(config: Config, findings: AuditFinding[]): AuditFinding[] {
  return config.suppressions.flatMap((suppression, index) => {
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

export function auditVerdict(findings: AuditFinding[], incompleteReasons: string[]): AuditVerdict {
  if (findings.some((finding) => finding.disposition === "block")) return "fail";
  if (incompleteReasons.length) return "incomplete";
  return findings.some((finding) => finding.disposition === "warn") ? "warn" : "pass";
}

const EVIDENCE_CHECKS: Record<PolicyCheck, (config: Config) => string | null> = {
  compiler: (config) => readArtifact<Artifact>(config, "type_health.json")?.confidence.typescript_program_loaded === true
    ? null
    : "TypeScript compiler program did not load.",
  "typed-lint": (config) => {
    const status = readArtifact<Artifact>(config, "lint_health.json")?.tool_status?.typed_eslint;
    return status?.ran === true && status.complete === true ? null : "Required type-aware ESLint analysis did not complete.";
  },
  tests: testEvidenceReason,
  "react-hooks": (config) => readArtifact<Artifact>(config, "react_health.json")?.tool_status?.eslint_react_hooks?.ran === true
    ? null
    : "Required React Hooks analysis did not run.",
  package: (config) => readArtifact<Artifact>(config, "package_health.json")?.summary.complete === true
    ? null
    : "Required package health analysis did not complete.",
};

export function requiredEvidenceReasons(config: Config): string[] {
  return config.policy.requiredChecks.flatMap((check) => EVIDENCE_CHECKS[check](config) ?? []);
}

function testEvidenceReason(config: Config): string | null {
  if (!config.testCommand) return "Tests are required but no test command is configured.";
  const execution = readArtifact<Artifact & { execution?: { status?: string } }>(config, "correctness_review.json")?.execution;
  return execution && ["passed", "failed"].includes(execution.status ?? "") ? null : "Required test execution did not complete.";
}

function findingRecords(value: unknown): ScoredRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ScoredRecord => isRecord(item) && typeof item.id === "string")
    : [];
}
