import type { Config, IssueAction, JsonValue, ScoredRecord, SuppressionConfig } from "./types.js";

type ArtifactLike = {
  records?: unknown;
  groups?: unknown;
  summary?: Record<string, unknown>;
  [key: string]: unknown;
};

export function enrichArtifactFindings(config: Config, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const artifact = value as ArtifactLike;
  const records = Array.isArray(artifact.records) ? artifact.records.map((record) => enrichFinding(config, record)) : artifact.records;
  const groups = Array.isArray(artifact.groups) ? artifact.groups.map((record) => enrichFinding(config, record)) : artifact.groups;
  return {
    ...artifact,
    ...(Array.isArray(artifact.records) ? { records } : {}),
    ...(Array.isArray(artifact.groups) ? { groups } : {}),
  };
}

export function enrichFinding(config: Config, value: unknown): unknown {
  if (!isRecord(value) || typeof value.id !== "string") return value;
  const record = value as ScoredRecord;
  const suppression = matchingSuppression(config.suppressions, record);
  const kind = findingKind(record);
  const actions = record.actions?.length ? record.actions : actionsForRecord(record, kind);
  return {
    ...record,
    kind,
    actions,
    ...(suppression ? { suppressed: true, suppression_reason: suppression.reason ?? "Configured suppression." } : {}),
  };
}

export function isSuppressed(record: Pick<ScoredRecord, "suppressed">): boolean {
  return record.suppressed === true;
}

export function findingKind(record: ScoredRecord): string {
  if (typeof record.kind === "string") return record.kind;
  const [prefix] = record.id.split(":");
  return prefix || "finding";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
