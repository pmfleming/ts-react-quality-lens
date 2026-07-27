import { isRecord } from "./collections.js";
import type {
  Config,
  EvidenceKind,
  FindingConfidence,
  FindingDisposition,
  IssueAction,
  JsonValue,
  ScoredRecord,
  SuppressionConfig,
} from "./types.js";

export function enrichArtifactFindings(config: Config, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const records = Array.isArray(value.records) ? value.records.map((record) => enrichFinding(config, record)) : value.records;
  const groups = Array.isArray(value.groups) ? value.groups.map((record) => enrichFinding(config, record)) : value.groups;
  return {
    ...value,
    ...(Array.isArray(value.records) ? { records } : {}),
    ...(Array.isArray(value.groups) ? { groups } : {}),
  };
}

export function enrichFinding(config: Config, value: ScoredRecord): ScoredRecord;
export function enrichFinding(config: Config, value: unknown): unknown;
export function enrichFinding(config: Config, value: unknown): unknown {
  if (!isScoredRecord(value)) return value;
  const record = value;
  const suppression = matchingSuppression(config.suppressions, record);
  const kind = findingKind(record);
  const actions = record.actions?.length ? record.actions : actionsForRecord(record, kind);
  return {
    ...record,
    kind,
    rule_id: record.rule_id ?? defaultRuleId(record, kind),
    evidence_kind: record.evidence_kind ?? defaultEvidenceKind(record, kind),
    disposition: record.disposition ?? defaultDisposition(kind),
    finding_confidence: record.finding_confidence ?? defaultFindingConfidence(record),
    message: record.message ?? defaultMessage(record, kind),
    actions,
    ...(suppression ? { suppressed: true, suppression_reason: suppression.reason ?? "Configured suppression." } : {}),
  };
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
  const lineComment = `// ts-react-quality-lens-ignore-next-line ${kind}`;
  const fileComment = `// ts-react-quality-lens-ignore-file ${kind}`;
  const actions: IssueAction[] = [
    {
      type: "suppress-line",
      auto_fixable: false,
      description: `Suppress this ${kind} finding on the affected line.`,
      comment: lineComment,
    },
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
  if (!record.line) {
    actions.push({
      type: "suppress-file",
      auto_fixable: false,
      description: `Suppress this ${kind} finding for the whole file.`,
      comment: fileComment,
    });
  }
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
