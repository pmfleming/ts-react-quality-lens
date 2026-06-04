import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrichFinding, findingKind, isSuppressed, suppressionMatches } from "./actions.js";
import { analysisConfidence, artifactBase, createAnalysisContext, readArtifact, sourceSetHash, writeArtifact } from "./measure-shared.js";
import { loadConfig } from "./config.js";
import { MEASURE_TASKS } from "./measures/registry.js";
import { TASKS } from "./tasks.js";
import type { AnalysisContext, Artifact, AuditArtifact, AuditFinding, AuditVerdict, Config, ScoredRecord } from "./types.js";

type AuditOptions = {
  base?: string | null;
  changedSince?: string | null;
  gate?: "new-only" | "all" | null;
  baseline?: string | null;
  saveBaseline?: string | null;
};

const AUDIT_TASK_IDS = [
  "quality.hotspots",
  "quality.clones",
  "quality.escape_hatches",
  "quality.type_health",
  "quality.dependency_health",
  "correctness.catalog",
  "quality.locality_dynamic",
  "quality.locality_leverage",
  "quality.react_health",
  "quality.cleanup",
] as const;

export function runAudit(config: Config, command: string, options: AuditOptions = {}): AuditArtifact {
  const context = createAnalysisContext(config);
  const base = options.changedSince ?? options.base ?? config.audit.changedSince ?? config.audit.base ?? defaultBase(config);
  const gate = options.gate ?? config.audit.gate;
  const changedFiles = base ? changedFilesSince(config, base) : [];
  const changedLines = base ? changedLineRangesSince(config, base) : new Map<string, LineRange[]>();
  runAuditMeasurements(config, command, context);
  const baselineIds = readBaselineIds(options.baseline ?? config.audit.baseline);
  const baseFindingIds = base ? baseSnapshotFindingIds(config, base, command, baselineIds) : null;
  const allFindings = collectFindings(config, [], new Map(), baselineIds, true);
  const findings = [
    ...collectFindings(config, changedFiles, changedLines, baselineIds, false, baseFindingIds),
    ...staleSuppressionFindings(config, allFindings),
  ];
  const gatedFindings = findings.filter((finding) => !isSuppressed(finding) && (gate === "all" || finding.introduced));
  const verdict = auditVerdict(gatedFindings);
  const baselineSuppressed = findings.filter((finding) => finding.suppression_reason === "Suppressed by audit baseline.").length;
  const configSuppressed = findings.filter((finding) => isSuppressed(finding) && finding.suppression_reason !== "Suppressed by audit baseline.").length;
  const artifact = {
    ...artifactBase(
      config,
      "audit",
      command,
      analysisConfidence(config, context.project(), {
        confidence_scope: "changed_code_audit",
        changed_files_available: changedFiles.length > 0,
        audit_base: base,
        base_snapshot_available: baseFindingIds !== null,
      }),
      sourceSetHash(context.project()),
    ),
    task_id: "audit" as const,
    summary: {
      verdict,
      gate,
      base,
      changed_files: changedFiles.length,
      changed_hunks: [...changedLines.values()].reduce((count, ranges) => count + ranges.length, 0),
      base_snapshot_available: baseFindingIds !== null,
      findings: findings.length,
      active_findings: gatedFindings.length,
      introduced_findings: findings.filter((finding) => finding.introduced).length,
      inherited_findings: findings.filter((finding) => !finding.introduced).length,
      high_risk_findings: gatedFindings.filter((finding) => finding.risk === "high" || finding.severity === "high").length,
      baseline_suppressed: baselineSuppressed,
      config_suppressed: configSuppressed,
      stale_suppressions: findings.filter((finding) => finding.kind === "stale_suppression").length,
    },
    findings,
  } satisfies AuditArtifact;
  writeArtifact(config, "audit.json", artifact);
  if (options.saveBaseline) writeBaseline(options.saveBaseline, findings);
  return artifact;
}

function runAuditMeasurements(config: Config, command: string, context: AnalysisContext): void {
  for (const taskId of AUDIT_TASK_IDS) {
    const task = MEASURE_TASKS.get(taskId);
    if (!task) continue;
    task.handler(config, command, context);
  }
}

type LineRange = { start: number; end: number };

function collectFindings(
  config: Config,
  changedFiles: string[],
  changedLines: Map<string, LineRange[]>,
  baselineIds: Set<string>,
  includeAll = false,
  baseFindingIds: Set<string> | null = null,
): AuditFinding[] {
  const changed = new Set(changedFiles.map(stripSourceExtension));
  const noDiffScope = includeAll || changed.size === 0;
  return AUDIT_TASK_IDS.flatMap((taskId) => {
    const task = TASKS.find((candidate) => candidate.id === taskId);
    const artifact = task ? readArtifact<Artifact>(config, task.artifact) : null;
    const rawFindings = [...findingRecords(artifact?.records), ...findingRecords(artifact?.groups)];
    return rawFindings.flatMap((raw): AuditFinding[] => {
      const enriched = enrichFinding(config, raw) as ScoredRecord;
      if (!isRecord(enriched)) return [];
      const touchesChangedFile = noDiffScope || findingTouchesChangedFile(enriched, changed);
      if (!touchesChangedFile) return [];
      const introduced = introducedByDiffOrBase(enriched, noDiffScope, changedLines, baseFindingIds);
      const baselineSuppressed = baselineIds.has(enriched.id);
      const finding = {
        ...enriched,
        kind: findingKind(enriched),
        task_id: taskId,
        introduced,
        ...(baselineSuppressed ? { suppressed: true, suppression_reason: "Suppressed by audit baseline." } : {}),
      };
      return [finding];
    });
  });
}

function introducedByDiffOrBase(
  record: ScoredRecord,
  noDiffScope: boolean,
  changedLines: Map<string, LineRange[]>,
  baseFindingIds: Set<string> | null,
): boolean {
  if (baseFindingIds && !baseFindingIds.has(record.id)) return true;
  if (noDiffScope) return baseFindingIds ? !baseFindingIds.has(record.id) : true;
  return findingTouchesChangedLine(record, changedLines);
}

function staleSuppressionFindings(config: Config, findings: AuditFinding[]): AuditFinding[] {
  return config.suppressions.flatMap((suppression, index) => {
    const matched = findings.some((finding) => suppressionMatches(suppression, finding));
    if (matched) return [];
    const id = suppression.id ?? `${suppression.kind ?? "finding"}:${suppression.file ?? index + 1}`;
    return [{
      id: `suppression:stale:${index + 1}:${id}`,
      kind: "stale_suppression",
      task_id: "audit",
      introduced: true,
      file: suppression.file,
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

export function auditMarkdown(artifact: AuditArtifact): string {
  const lines = [
    `# ts-react-quality-lens audit: ${artifact.summary.verdict}`,
    "",
    `- Gate: ${artifact.summary.gate}`,
    `- Base: ${artifact.summary.base ?? "none"}`,
    `- Changed files: ${artifact.summary.changed_files}`,
    `- Changed hunks: ${artifact.summary.changed_hunks}`,
    `- Active findings: ${artifact.summary.active_findings}`,
    `- Introduced findings: ${artifact.summary.introduced_findings}`,
    `- Inherited findings: ${artifact.summary.inherited_findings}`,
    `- Suppressed by baseline: ${artifact.summary.baseline_suppressed}`,
    `- Suppressed by config: ${artifact.summary.config_suppressed}`,
    `- Stale suppressions: ${artifact.summary.stale_suppressions}`,
    "",
  ];
  const active = artifact.findings.filter((finding) => !isSuppressed(finding) && (artifact.summary.gate === "all" || finding.introduced));
  if (!active.length) {
    lines.push("No active findings.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("## Active Findings", "");
  for (const finding of active.slice(0, 25)) {
    const location = [finding.file, finding.line].filter((value) => value !== undefined && value !== null).join(":");
    lines.push(`- ${finding.risk ?? finding.severity ?? "unknown"} ${finding.kind}: ${location || finding.id}`);
  }
  if (active.length > 25) lines.push(`- ...and ${active.length - 25} more`);
  return `${lines.join("\n")}\n`;
}

function findingRecords(value: unknown): ScoredRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ScoredRecord => isRecord(item) && typeof item.id === "string") : [];
}

function findingTouchesChangedFile(record: ScoredRecord, changedFiles: Set<string>): boolean {
  if (typeof record.file === "string" && changedFiles.has(stripSourceExtension(record.file))) return true;
  if (Array.isArray(record.files)) {
    return record.files.some((file) => typeof file === "string" && changedFiles.has(stripSourceExtension(file)));
  }
  const instances = record.instances;
  if (Array.isArray(instances)) {
    return instances.some((instance) => isRecord(instance) && typeof instance.file === "string" && changedFiles.has(stripSourceExtension(instance.file)));
  }
  return false;
}

function findingTouchesChangedLine(record: ScoredRecord, changedLines: Map<string, LineRange[]>): boolean {
  if (changedLines.size === 0) return true;
  if (typeof record.file === "string") {
    const line = typeof record.line === "number" ? record.line : null;
    if (line === null) return changedLines.has(stripSourceExtension(record.file));
    return lineInRanges(line, changedLines.get(stripSourceExtension(record.file)) ?? []);
  }
  const instances = record.instances;
  if (Array.isArray(instances)) {
    return instances.some((instance) => {
      if (!isRecord(instance) || typeof instance.file !== "string") return false;
      const ranges = changedLines.get(stripSourceExtension(instance.file)) ?? [];
      const start = typeof instance.start_line === "number" ? instance.start_line : null;
      const end = typeof instance.end_line === "number" ? instance.end_line : start;
      return start === null ? ranges.length > 0 : rangesOverlap({ start, end: end ?? start }, ranges);
    });
  }
  if (Array.isArray(record.files)) {
    return record.files.some((file) => typeof file === "string" && changedLines.has(stripSourceExtension(file)));
  }
  return false;
}

function lineInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function rangesOverlap(target: LineRange, ranges: LineRange[]): boolean {
  return ranges.some((range) => target.start <= range.end && range.start <= target.end);
}

function auditVerdict(findings: AuditFinding[]): AuditVerdict {
  if (findings.some((finding) => finding.risk === "high" || finding.severity === "high" || Number(finding.score ?? 0) >= 70)) {
    return "fail";
  }
  return findings.length > 0 ? "warn" : "pass";
}

function changedFilesSince(config: Config, base: string): string[] {
  const stdout = firstGitDiffOutput(config, [
    ["diff", "--name-only", `${base}...HEAD`],
    ["diff", "--name-only", base],
  ]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

function changedLineRangesSince(config: Config, base: string): Map<string, LineRange[]> {
  const stdout = firstGitDiffOutput(config, [
    ["diff", "--unified=0", "--no-ext-diff", `${base}...HEAD`],
    ["diff", "--unified=0", "--no-ext-diff", base],
  ]);
  return stdout ? parseChangedLineRanges(stdout) : new Map();
}

function firstGitDiffOutput(config: Config, attempts: string[][]): string {
  for (const args of attempts) {
    try {
      const stdout = childProcess.execFileSync("git", args, {
        cwd: config.projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!stdout.trim()) continue;
      return stdout;
    } catch {
      continue;
    }
  }
  return "";
}

function baseSnapshotFindingIds(config: Config, base: string, command: string, baselineIds: Set<string>): Set<string> | null {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-react-quality-lens-audit-base-"));
  try {
    childProcess.execFileSync("git", ["worktree", "add", "--detach", "--quiet", tempRoot, base], {
      cwd: config.projectRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const relativeConfig = path.relative(config.projectRoot, config.configPath);
    const baseConfigPath = path.join(tempRoot, relativeConfig);
    if (!fs.existsSync(baseConfigPath)) return null;
    const baseConfig = loadConfig(baseConfigPath);
    baseConfig.outputDir = path.join(tempRoot, "target", "audit-base-analysis");
    baseConfig.cache.enabled = false;
    const context = createAnalysisContext(baseConfig);
    runAuditMeasurements(baseConfig, command, context);
    return new Set(collectFindings(baseConfig, [], new Map(), baselineIds, true).map((finding) => finding.id));
  } catch {
    return null;
  } finally {
    try {
      childProcess.execFileSync("git", ["worktree", "remove", "--force", tempRoot], {
        cwd: config.projectRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function parseChangedLineRanges(diff: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let currentFile: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).replace(/\\/g, "/");
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentFile = null;
      continue;
    }
    if (!currentFile || !line.startsWith("@@")) continue;
    const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const length = match[2] ? Number(match[2]) : 1;
    const end = length === 0 ? start : start + length - 1;
    const key = stripSourceExtension(currentFile);
    const ranges = result.get(key) ?? [];
    ranges.push({ start, end });
    result.set(key, ranges);
  }
  return result;
}

function defaultBase(config: Config): string | null {
  try {
    const stdout = childProcess.execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() ? "origin/main" : null;
  } catch {
    return null;
  }
}

function readBaselineIds(file: string | null | undefined): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return new Set(parsed.filter((item): item is string => typeof item === "string"));
    if (Array.isArray(parsed.findings)) {
      return new Set(
        parsed.findings.flatMap((item: unknown) =>
          isRecord(item) && typeof item.id === "string" ? [item.id] : typeof item === "string" ? [item] : [],
        ),
      );
    }
  } catch {
    return new Set();
  }
  return new Set();
}

function writeBaseline(file: string, findings: AuditFinding[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ids = [...new Set(findings.map((finding) => finding.id))].sort();
  fs.writeFileSync(file, `${JSON.stringify({ findings: ids }, null, 2)}\n`, "utf8");
}

function stripSourceExtension(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
