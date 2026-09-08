import { isRecord } from "./collections.js";
import { normalizeFindingIdentities } from "./finding-identity.js";
import { discoverWorkspaces, workspaceForFile } from "./workspaces.js";
import type {
  Artifact,
  Config,
  EvidenceKind,
  FindingConfidence,
  FindingDisposition,
  IssueAction,
  JsonValue,
  RelatedLocation,
  ScoredRecord,
  SemanticDecision,
  SuppressionConfig,
} from "./types.js";

export function enrichArtifactFindings(config: Config, value: Artifact): Artifact;
export function enrichArtifactFindings(config: Config, value: unknown): unknown;
export function enrichArtifactFindings(config: Config, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const records = Array.isArray(value.records)
    ? normalizeFindingIdentities(config, value.records).map((record) => enrichFinding(config, record)) : value.records;
  const groups = Array.isArray(value.groups) ? value.groups.map((record) => enrichFinding(config, record)) : value.groups;
  const disagreements = Array.isArray(value.disagreements)
    ? value.disagreements.map((record) => enrichFinding(config, record))
    : value.disagreements;
  const unconfirmed = Array.isArray(value.unconfirmed)
    ? value.unconfirmed.map((record) => enrichFinding(config, record))
    : value.unconfirmed;
  return {
    ...value,
    ...(Array.isArray(value.records) ? { records } : {}),
    ...(Array.isArray(value.groups) ? { groups } : {}),
    ...(Array.isArray(value.disagreements) ? { disagreements } : {}),
    ...(Array.isArray(value.unconfirmed) ? { unconfirmed } : {}),
  };
}

export function enrichFinding(config: Config, value: ScoredRecord): ScoredRecord;
export function enrichFinding(config: Config, value: unknown): unknown;
export function enrichFinding(config: Config, value: unknown): unknown {
  if (!isScoredRecord(value)) return value;
  const record = value;
  const suppression = matchingSuppression(config.suppressions, record);
  const kind = findingKind(record);
  const ruleId = record.rule_id ?? defaultRuleId(record, kind);
  const evidenceKind = record.evidence_kind ?? defaultEvidenceKind(record, kind);
  const disposition = record.disposition ?? defaultDisposition(kind);
  const actions = record.actions?.length ? record.actions : actionsForRecord(record, kind);
  const relatedLocations = record.related_locations ?? relatedLocationsFor(record);
  const fixGroupId = record.fix_group_id ?? (relatedLocations.length > 1 ? record.id : null);
  const workspace = record.file ? workspaceForFile(cachedWorkspaces(config), record.file) : null;
  return {
    ...record,
    kind,
    rule_id: ruleId,
    evidence_kind: evidenceKind,
    disposition,
    finding_confidence: record.finding_confidence ?? defaultFindingConfidence(record),
    message: record.message ?? defaultMessage(record, kind),
    reason_code: record.reason_code ?? ruleId,
    ...(workspace ? { workspace_id: record.workspace_id ?? workspace.id, workspace_name: record.workspace_name ?? workspace.name } : {}),
    semantic_decision: record.semantic_decision ?? defaultSemanticDecision(record, evidenceKind, kind),
    estimated_effort: record.estimated_effort ?? defaultEstimatedEffort(disposition),
    ...(relatedLocations.length ? { related_locations: relatedLocations } : {}),
    ...(fixGroupId ? { fix_group_id: fixGroupId } : {}),
    actions,
    ...(suppression ? { suppressed: true, suppression_reason: suppression.reason ?? "Configured suppression." } : {}),
  };
}

const workspaceCache = new WeakMap<Config, ReturnType<typeof discoverWorkspaces>["records"]>();

function cachedWorkspaces(config: Config): ReturnType<typeof discoverWorkspaces>["records"] {
  const cached = workspaceCache.get(config);
  if (cached) return cached;
  const records = discoverWorkspaces(config).records;
  workspaceCache.set(config, records);
  return records;
}

function isScoredRecord(value: unknown): value is ScoredRecord {
  return isRecord(value) && typeof value.id === "string";
}

export function isSuppressed(record: Pick<ScoredRecord, "suppressed">): boolean {
  return record.suppressed === true;
}

export function findingKind(record: ScoredRecord): string {
  if (typeof record.kind === "string") return record.kind;
  const [prefix] = record.id.split(":");
  return prefix || "finding";
}

function defaultRuleId(record: ScoredRecord, kind: string): string {
  if (typeof record.source === "string") return `${record.source}/${kind}`;
  return `ts-react-quality-lens/${kind}`;
}

function defaultEvidenceKind(record: ScoredRecord, kind: string): EvidenceKind {
  if (kind === "compiler_diagnostic") return "diagnostic";
  if (kind === "test_execution_failed") return "test";
  if (typeof record.source === "string" && record.source.includes("eslint")) return "tool-rule";
  if (typeof record.source === "string" && record.source !== "structural-type-scan" && record.source !== "framework-adapter") {
    return "tool-rule";
  }
  if (kind.includes("count") || kind.includes("coverage")) return "metric";
  return "heuristic";
}

function defaultDisposition(kind: string): FindingDisposition {
  if (kind === "compiler_diagnostic" || kind === "test_execution_failed") return "block";
  if (["ts_ignore", "ts_nocheck", "stale_suppression", "layer_violation", "import_cycle"].includes(kind)) return "warn";
  if (["ts_expect_error", "storybook_evidence"].includes(kind)) return "info";
  return "review";
}

function defaultFindingConfidence(record: ScoredRecord): FindingConfidence {
  if (record.evidence_kind === "diagnostic" || record.evidence_kind === "test" || record.evidence_kind === "tool-rule") return "high";
  if (typeof record.source === "string" && !record.source.includes("heuristic")) return "high";
  return "medium";
}

function defaultSemanticDecision(record: ScoredRecord, evidence: EvidenceKind, kind: string): SemanticDecision {
  if (record.tool_validation === "confirmed") return "confirmed";
  if (record.tool_validation === "disagreed") return "disagreed";
  if (record.tool_validation === "not_comparable") return "not-comparable";
  if (record.tool_validation === "excluded_by_tool") return "excluded-by-tool";
  if (record.tool_validation === "unavailable") return "unavailable";
  if (kind === "storybook_evidence" || kind.includes("contract")) return "contract-preserved";
  if (kind === "unsupported_pattern") return "abstained";
  if (evidence === "heuristic") return "unresolved";
  return "confirmed";
}

function defaultEstimatedEffort(disposition: FindingDisposition): number {
  if (disposition === "block") return 60;
  if (disposition === "warn") return 30;
  if (disposition === "review") return 15;
  return 5;
}

function relatedLocationsFor(record: ScoredRecord): RelatedLocation[] {
  const instances = instanceLocations(record.instances);
  return [...instances, ...fileLocations(record, instances)];
}

function instanceLocations(value: unknown): RelatedLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((instance): RelatedLocation[] => {
    if (!isRecord(instance) || typeof instance.file !== "string") return [];
    return [{
      file: instance.file,
      start_line: typeof instance.start_line === "number" ? instance.start_line : 1,
      ...(typeof instance.start_column === "number" ? { start_column: instance.start_column } : {}),
      ...(typeof instance.end_line === "number" ? { end_line: instance.end_line } : {}),
      ...(typeof instance.end_column === "number" ? { end_column: instance.end_column } : {}),
      role: "duplicate",
    }];
  });
}

function fileLocations(record: ScoredRecord, instances: RelatedLocation[]): RelatedLocation[] {
  return (record.files ?? []).flatMap((file): RelatedLocation[] =>
    file === record.file || instances.some((location) => location.file === file)
      ? []
      : [{ file, start_line: 1, role: "related" }]);
}

function defaultMessage(record: ScoredRecord, kind: string): string {
  if (typeof record.evidence === "string" && record.evidence.trim()) return record.evidence;
  const signalMessage = record.signals?.find((signal) => signal.message)?.message;
  if (signalMessage) return signalMessage;
  return kind.replace(/_/g, " ");
}

function matchingSuppression(suppressions: SuppressionConfig[], record: ScoredRecord): SuppressionConfig | null {
  return suppressions.find((suppression) => suppressionMatches(suppression, record)) ?? null;
}

export function suppressionMatches(suppression: SuppressionConfig, record: ScoredRecord): boolean {
  if (suppression.id && suppression.id !== record.id) return false;
  if (suppression.file && suppression.file !== record.file) return false;
  if (suppression.kind && suppression.kind !== findingKind(record)) return false;
  return Boolean(suppression.id || suppression.file || suppression.kind);
}

function actionsForRecord(record: ScoredRecord, kind: string): IssueAction[] {
  const actions: IssueAction[] = [
    {
      type: "add-to-config",
      auto_fixable: true,
      description: `Keep this ${kind} finding intentionally by adding a narrow configured suppression.`,
      config_key: "suppressions",
      value: suppressionValue(record, kind),
    },
  ];
  const fix = fixAction(record, kind);
  if (fix) actions.unshift(fix);
  return actions;
}

function fixAction(record: ScoredRecord, kind: string): IssueAction | null {
  if (kind.includes("unused") || kind === "unused_file" || kind === "unused_export") {
    return {
      type: "fix",
      auto_fixable: false,
      description: "Remove the unused code or mark it as intentional public surface.",
      fix: "remove-unused-code",
    };
  }
  if (kind.includes("dependency") || kind.includes("import")) {
    return {
      type: "fix",
      auto_fixable: false,
      description: "Update the import or dependency declaration so the graph matches runtime intent.",
      fix: "repair-dependency-edge",
    };
  }
  if (kind.includes("clone") || kind.includes("duplication") || kind.includes("same_purpose")) {
    return {
      type: "fix",
      auto_fixable: false,
      description: "Extract the duplicated logic or document why the clone should remain.",
      fix: "deduplicate-code",
    };
  }
  if (Number(record.score ?? 0) >= 70 || record.risk === "high" || record.severity === "high") {
    return {
      type: "fix",
      auto_fixable: false,
      description: "Reduce the high-risk signal or split the risky unit into clearer parts.",
      fix: "reduce-risk",
    };
  }
  return null;
}

function suppressionValue(record: ScoredRecord, kind: string): JsonValue {
  const value: Record<string, JsonValue> = { id: record.id, kind };
  if (record.file) value.file = record.file;
  value.reason = "Intentional finding; document the project-specific reason.";
  return value;
}
