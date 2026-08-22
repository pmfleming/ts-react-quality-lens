import fs from "node:fs";
import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { changedFilesSince, defaultBase } from "../audit/change-set.js";
import { stableHash } from "../clone-utils.js";
import { countBy, isRecord, parseJson } from "../collections.js";
import { eslintFindingRecord } from "../integrations/eslint-findings.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { riskForScore } from "../risk-model.js";
import { escapeRecords, typeHealthRecords } from "../scoring.js";
import { writeArtifact } from "../writer.js";
import { writeQualityArtifact } from "./quality-artifact.js";
import type { AnalysisContext, Config, DiagnosticRecord, EslintMessage, ProjectAnalysis, ScoredRecord, TypeCoverageFile } from "../types.js";

export function measureEscapeHatches(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const records = project.modules.flatMap(escapeRecords);
  return writeQualityArtifact(config, "ts_escape_hatches.json", "quality.escape_hatches", command, project, {
    records: records.length,
    files_with_escape_hatches: new Set(records.map((record) => record.file)).size,
    by_kind: Object.fromEntries(countBy(records, (record) => record.kind)),
  }, records);
}

export function measureTypeHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const diagnostics = project.tsProject.diagnostics;
  const coverage = project.tsProject.type_coverage;
  const records = [
    ...project.modules.flatMap(typeHealthRecords),
    ...typeSafetyPostureRecords(config, project),
    ...typeCoverageRecords(config, coverage),
    ...diagnostics.map(compilerDiagnosticFinding),
  ];
  return writeQualityArtifact(config, "type_health.json", "quality.type_health", command, project, {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
    wide_types: records.filter((record) => record.signals?.some((signal) => signal.kind === "wide_surface")).length,
    compiler_diagnostics: diagnostics.length,
    type_coverage_percent: coverage?.summary.type_coverage_percent ?? null,
    typed_symbols: coverage?.summary.typed_symbols ?? null,
    untyped_symbols: coverage
      ? coverage.summary.explicit_any + coverage.summary.inferred_any + coverage.summary.error_types
      : null,
  }, records, {
    compiler_options: project.tsProject.compiler_options ?? null,
    diagnostics,
    type_coverage: coverage ?? null,
  });
}

export function measureLint(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const lint = context.typedLint();
  const records = lint.messages.map(typedLintRecord);
  const artifact = {
    ...artifactBase(config, "quality.lint", command, analysisConfidence(config, project, {
      typed_eslint_available: lint.available,
      typed_eslint_ran: lint.ran,
      typed_eslint_complete: lint.complete,
      typed_eslint_reason: lint.reason,
    }), sourceSetHash(project)),
    summary: {
      records: records.length,
      blocking_findings: records.filter((record) => record.disposition === "block").length,
      warning_findings: records.filter((record) => record.disposition === "warn").length,
    },
    tool_status: {
      typed_eslint: {
        available: lint.available,
        ran: lint.ran,
        complete: lint.complete,
        reason: lint.reason,
        version: lint.version,
        duration_ms: lint.duration_ms ?? null,
        ruleset: "tsrqlens-typescript-recommended-v1",
      },
    },
    records,
  };
  writeArtifact(config, "lint_health.json", artifact);
  return artifact;
}

function compilerDiagnosticFinding(diagnostic: DiagnosticRecord): ScoredRecord {
  const error = diagnostic.category === "Error";
  const location = `${diagnostic.file ?? "project"}:${diagnostic.code}:${diagnostic.message}`;
  return {
    id: `tsc:${diagnostic.code}:${stableHash(location)}`,
    rule_id: `typescript/TS${diagnostic.code}`,
    kind: "compiler_diagnostic",
    evidence_kind: "diagnostic",
    disposition: error ? "block" : "warn",
    finding_confidence: "high",
    scope: diagnostic.file ? "file" : "project",
    ...(diagnostic.file ? { file: diagnostic.file } : {}),
    line: diagnostic.line,
    column: diagnostic.character,
    end_line: diagnostic.end_line,
    end_column: diagnostic.end_character,
    severity: error ? "high" : "medium",
    score: error ? 100 : 50,
    risk: error ? "high" : "medium",
    source: "typescript-compiler",
    message: diagnostic.message,
    diagnostic_code: diagnostic.code,
    signals: [{ kind: `TS${diagnostic.code}`, message: diagnostic.message }],
  };
}

function typedLintRecord(message: EslintMessage): ScoredRecord {
  const parserFailure = message.rule_id === "eslint/parser";
  const advisory = [
    "@typescript-eslint/no-unnecessary-type-assertion",
    "@typescript-eslint/no-unsafe-type-assertion",
  ].includes(message.rule_id);
  const disposition = parserFailure ? "info" : advisory || message.severity === "warning" ? "warn" : "block";
  return eslintFindingRecord(message, {
    id: `typed-lint:${message.rule_id}:${message.file}:${message.line ?? 0}:${message.column ?? 0}`,
    kind: message.rule_id.replace(/^@typescript-eslint\//, "typed_").replace(/-/g, "_"),
    disposition,
    source: "typescript-eslint",
    signal: message.rule_id,
    score: disposition === "block" ? 90 : disposition === "info" ? 0 : 50,
  });
}

function typeCoverageRecords(config: Config, coverage: ProjectAnalysis["tsProject"]["type_coverage"]): ScoredRecord[] {
  if (!coverage) return [];
  const records: ScoredRecord[] = [];
  const minimum = config.typeCoverage.minimumPercent;
  if (minimum !== null && coverage.summary.type_coverage_percent < minimum) {
    records.push(typeCoverageFinding("project", null, coverage.summary.type_coverage_percent, minimum, "configured_project_floor"));
  }
  const fileMinimum = config.typeCoverage.perFileMinimumPercent;
  if (fileMinimum !== null) {
    for (const file of coverage.files.filter((item) => item.type_coverage_percent < fileMinimum)) {
      records.push(typeCoverageFinding("file", file, file.type_coverage_percent, fileMinimum, "configured_file_floor"));
    }
  }
  addChangedFileCoverageRecords(config, coverage.files, records);
  addBaselineCoverageRecords(config, coverage, records);
  return records;
}

function addChangedFileCoverageRecords(config: Config, files: TypeCoverageFile[], records: ScoredRecord[]): void {
  const minimum = config.typeCoverage.changedFileMinimumPercent;
  if (minimum === null) return;
  const base = config.audit.changedSince ?? config.audit.base ?? defaultBase(config);
  if (!base) return;
  const changed = new Set(changedFilesSince(config, base));
  for (const file of files.filter((item) => changed.has(item.file) && item.type_coverage_percent < minimum)) {
    records.push(typeCoverageFinding("changed-file", file, file.type_coverage_percent, minimum, "configured_changed_file_floor"));
  }
}

function addBaselineCoverageRecords(
  config: Config,
  coverage: NonNullable<ProjectAnalysis["tsProject"]["type_coverage"]>,
  records: ScoredRecord[],
): void {
  const baseline = readTypeCoverageBaseline(config.typeCoverage.baseline);
  if (!baseline) return;
  if (coverage.summary.type_coverage_percent < baseline.projectPercent) {
    records.push(typeCoverageFinding("project", null, coverage.summary.type_coverage_percent, baseline.projectPercent, "ratchet_regression"));
  }
  const currentByFile = new Map(coverage.files.map((file) => [file.file, file]));
  for (const [fileName, previous] of baseline.files) {
    const current = currentByFile.get(fileName);
    if (current && current.type_coverage_percent < previous) {
      records.push(typeCoverageFinding("file", current, current.type_coverage_percent, previous, "ratchet_regression"));
    }
  }
}

function readTypeCoverageBaseline(file: string | null): { projectPercent: number; files: Map<string, number> } | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const value = parseJson(fs.readFileSync(file, "utf8"));
    if (!isRecord(value) || !isRecord(value.type_coverage)) return null;
    const summary = value.type_coverage.summary;
    const files = value.type_coverage.files;
    if (!isRecord(summary) || typeof summary.type_coverage_percent !== "number" || !Array.isArray(files)) return null;
    return {
      projectPercent: summary.type_coverage_percent,
      files: new Map(files.flatMap((item): Array<[string, number]> =>
        isRecord(item) && typeof item.file === "string" && typeof item.type_coverage_percent === "number"
          ? [[item.file, item.type_coverage_percent]]
          : [])),
    };
  } catch {
    return null;
  }
}

function typeCoverageFinding(
  scope: "project" | "file" | "changed-file",
  file: TypeCoverageFile | null,
  actual: number,
  required: number,
  reason: string,
): ScoredRecord {
  return {
    id: `type-coverage:${scope}:${file?.file ?? "project"}:${reason}`,
    rule_id: `ts-react-quality-lens/type-coverage-${reason.replaceAll("_", "-")}`,
    kind: "type_coverage_below_threshold",
    evidence_kind: "metric",
    disposition: "warn",
    finding_confidence: "high",
    scope: file ? "file" : "project",
    ...(file ? { file: file.file, coverage: file } : {}),
    score: Math.min(100, Math.round(required - actual) * 5),
    risk: actual < required - 10 ? "high" : "medium",
    source: "typescript-compiler-api",
    message: `Type coverage ${actual}% is below the required ${required}% ${scope} threshold.`,
    actual_percent: actual,
    required_percent: required,
    reason,
    signals: [{ kind: reason, value: actual }],
  };
}

function typeSafetyPostureRecords(config: Config, project: ProjectAnalysis): ScoredRecord[] {
  const options = project.tsProject.compiler_options ?? {};
  const strict = [
    "strict",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "forceConsistentCasingInFileNames",
    "noUncheckedSideEffectImports",
    "verbatimModuleSyntax",
    "erasableSyntaxOnly",
  ];
  const expected = config.policy.profile === "strict" ? strict : ["strict"];
  const missing = expected.filter((key) => options[key] !== true);
  if (!missing.length) return [];
  const score = Math.min(69, missing.length * 12);
  return [{
    id: "project:type-safety-posture",
    rule_id: `ts-react-quality-lens/tsconfig-${config.policy.profile}`,
    kind: "type_safety_posture",
    evidence_kind: "diagnostic",
    disposition: config.policy.profile === "baseline" ? "info" : "warn",
    finding_confidence: "high",
    scope: "project",
    message: `Compiler options do not meet the ${config.policy.profile} profile: ${missing.join(", ")}.`,
    score,
    risk: riskForScore(score),
    source: "typescript-compiler-options",
    signals: missing.map((key) => ({ kind: "compiler_option_disabled", value: key })),
  }];
}
