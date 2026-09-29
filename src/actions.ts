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
  const enriched = { ...value };
  for (const key of ["records", "groups", "disagreements", "unconfirmed"]) {
    const items: unknown = value[key];
    if (!Array.isArray(items)) continue;
    const records = key === "records" ? normalizeFindingIdentities(config, items) : items;
    enriched[key] = records.map((record) => enrichFinding(config, record));
  }
  return enriched;
}

export function enrichFinding(config: Config, value: ScoredRecord): ScoredRecord;
export function enrichFinding(config: Config, value: unknown): unknown;
export function enrichFinding(config: Config, value: unknown): unknown {
  if (!isScoredRecord(value)) return value;
  const record = value;
  const suppression = matchingSuppression(config.suppressions, record);
  const kind = findingKind(record);
  const actions = record.actions?.length ? record.actions : actionsForRecord(record, kind);
  const relatedLocations = record.related_locations ?? relatedLocationsFor(record);
  const fixGroupId = record.fix_group_id ?? (relatedLocations.length > 1 ? record.id : null);
  const workspace = record.file ? workspaceForFile(cachedWorkspaces(config), record.file) : null;
  return {
    ...record,
    kind,
    ...findingAssessment(record, kind),
    ...(workspace ? { workspace_id: record.workspace_id ?? workspace.id, workspace_name: record.workspace_name ?? workspace.name } : {}),
    ...(relatedLocations.length ? { related_locations: relatedLocations } : {}),
    ...(fixGroupId ? { fix_group_id: fixGroupId } : {}),
    actions,
    ...(suppression ? { suppressed: true, suppression_reason: suppression.reason ?? "Configured suppression." } : {}),
  };
}

function findingAssessment(record: ScoredRecord, kind: string) {
  const ruleId = record.rule_id ?? defaultRuleId(record, kind);
  const evidence = record.evidence_kind ?? defaultEvidenceKind(record, kind);
  const disposition = record.disposition ?? defaultDisposition(kind);
  return {
    rule_id: ruleId, evidence_kind: evidence, disposition,
    finding_confidence: record.finding_confidence ?? defaultFindingConfidence(evidence),
    message: record.message ?? defaultMessage(record, kind),
    reason_code: record.reason_code ?? ruleId,
    semantic_decision: record.semantic_decision ?? defaultSemanticDecision(record, evidence, kind),
    estimated_effort: record.estimated_effort ?? { block: 60, warn: 30, review: 15, info: 5 }[disposition],
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

function defaultFindingConfidence(evidence: EvidenceKind): FindingConfidence {
  return evidence === "heuristic" ? "medium" : "high";
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

const FIX_GUIDANCE = [
  { kinds: /unused/, fix: "remove-unused-code",
    description: "Remove the unused code or mark it as intentional public surface." },
  { kinds: /dependency|import/, fix: "repair-dependency-edge",
    description: "Update the import or dependency declaration so the graph matches runtime intent." },
  { kinds: /clone|duplication|same_purpose/, fix: "deduplicate-code",
    description: "Extract the duplicated logic or document why the clone should remain." },
];

function fixAction(record: ScoredRecord, kind: string): IssueAction | null {
  const guidance = FIX_GUIDANCE.find((item) => item.kinds.test(kind));
  if (guidance) return { type: "fix", auto_fixable: false, description: guidance.description, fix: guidance.fix };
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
