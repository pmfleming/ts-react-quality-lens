import fs from "node:fs";
import { changedFilesSince, defaultBase } from "../audit/change-set.js";
import { isRecord } from "../collections.js";
import { analysisConfidence, artifactBase, countBy, createAnalysisContext, escapeRecords, frameworkRiskRecords, gitHistory, hiddenCouplingSignals, readArtifact, riskForScore, sourceSetHash, stableHash, typeHealthRecords, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Artifact, Config, DiagnosticRecord, EslintMessage, FindingDisposition, FunctionRecord, ModuleRecord, ProjectAnalysis, ScoredRecord, TestRecord, TypeCoverageFile } from "../types.js";

export function measureEscapeHatches(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const records = project.modules.flatMap((module) => escapeRecords(module));
  const byKind = countBy(records, (record) => record.kind);
  return writeQualityArtifact(config, "ts_escape_hatches.json", "quality.escape_hatches", command, project, {
    records: records.length,
    files_with_escape_hatches: new Set(records.map((record) => record.file)).size,
    by_kind: Object.fromEntries(byKind),
  },
    records,
  );
}

export function measureTypeHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const diagnostics = project.tsProject.diagnostics ?? [];
  const coverage = project.tsProject.type_coverage;
  const records = [
    ...project.modules.flatMap((module) => typeHealthRecords(module)),
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
  },
    records,
    {
      compiler_options: project.tsProject.compiler_options ?? null,
      diagnostics,
      type_coverage: coverage ?? null,
    },
  );
}

export function measureLint(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const lint = context.typedLint();
  const records = lint.messages.map(typedLintRecord);
  const artifact = {
    ...artifactBase(
      config,
      "quality.lint",
      command,
      analysisConfidence(config, project, {
        typed_eslint_available: lint.available,
        typed_eslint_ran: lint.ran,
        typed_eslint_complete: lint.complete,
        typed_eslint_reason: lint.reason,
      }),
      sourceSetHash(project),
    ),
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

export function measureLocality(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const testCatalog = readArtifact<{ tests?: Pick<TestRecord, "source_mapping">[] }>(config, "test_catalog.json");
  const testEvidence = new Set((testCatalog?.tests ?? []).flatMap((test) => test.source_mapping ?? []));
  const history = gitHistory(config);
  const records = project.modules.map((module) => {
    const internalImports = module.imports.filter((edge) => edge.to_kind === "relative");
    const farImports = internalImports.filter((edge) => edge.specifier.startsWith("../../"));
    const hiddenCoupling = hiddenCouplingSignals(module);
    const hasTestEvidence = testEvidence.has(module.file);
    const historyRecord = history.get(module.file) ?? { commits: 0, contributors: 0, defect_commits: 0, cochange_partners: [] };
    const strongestCochange = historyRecord.cochange_partners[0]?.commits ?? 0;
    const score = Math.min(
      100,
      farImports.length * 12 +
        hiddenCoupling.length * 18 +
        (hasTestEvidence ? 0 : 18) +
        Math.min(20, historyRecord.commits * 2) +
        Math.min(24, historyRecord.defect_commits * 8) +
        Math.min(18, strongestCochange * 3),
    );
    return {
      id: `locality:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk: riskForScore(score),
      dependency_distance: farImports.length,
      hidden_coupling: hiddenCoupling,
      test_locality: hasTestEvidence ? "direct_evidence" : "no_evidence",
      churn: { commits: historyRecord.commits, contributors: historyRecord.contributors },
      defect_commits: historyRecord.defect_commits,
      cochange_partners: historyRecord.cochange_partners,
      signals: [
        ...farImports.map((edge) => ({ kind: "far_import", line: edge.line, specifier: edge.specifier })),
        ...hiddenCoupling.map((signal) => ({ kind: signal.kind, line: signal.line })),
        ...(hasTestEvidence ? [] : [{ kind: "missing_direct_test_evidence" }]),
        ...(historyRecord.defect_commits ? [{ kind: "defect_keyword_commits", value: historyRecord.defect_commits }] : []),
        ...(strongestCochange ? [{ kind: "cochange_ripple", value: strongestCochange }] : []),
      ],
    };
  });
  return writeQualityArtifact(
    config,
    "locality_metrics.json",
    "quality.locality_dynamic",
    command,
    project,
    riskRecordSummary(records),
    records,
  );
}

export function measureLeverage(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const inbound = new Map();
  for (const edge of project.imports.filter((item) => item.to_kind === "relative")) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  const records = project.modules.map((module) => {
    const inboundReach = inbound.get(module.id) ?? 0;
    const publicSurface = module.exports.length + module.types.length;
    const deadExportSurface = inboundReach === 0 ? module.exports.length : 0;
    const weakSurface = escapeRecords(module).filter((record) =>
      ["explicit_any", "type_assertion", "double_assertion", "non_null_assertion", "ts_ignore", "ts_nocheck", "eslint_suppression"].includes(
        String(record.kind),
      ),
    ).length;
    const leverageScore = Math.min(100, inboundReach * 10 + publicSurface * 2);
    const hubWeaknessPenalty = inboundReach > 4 && weakSurface > 0 ? 20 : 0;
    const score = Math.min(100, weakSurface * 12 + deadExportSurface * 6 + hubWeaknessPenalty);
    return {
      id: `leverage:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk: riskForScore(score),
      leverage_score: leverageScore,
      inbound_reach: inboundReach,
      public_surface: publicSurface,
      weak_surface: weakSurface,
      dead_export_surface: deadExportSurface,
      classification: inboundReach > 3 ? "shared_hub" : inboundReach === 0 ? "leaf" : "local_dependency",
      signals: [
        ...(inboundReach > 3 ? [{ kind: "broad_inbound_reach", value: inboundReach }] : []),
        ...(weakSurface > 0 ? [{ kind: "weak_public_surface", value: weakSurface }] : []),
        ...(deadExportSurface > 0 ? [{ kind: "unused_export_surface", value: deadExportSurface }] : []),
      ],
    };
  });
  return writeQualityArtifact(
    config,
    "leverage_metrics.json",
    "quality.locality_leverage",
    command,
    project,
    {
      records: records.length,
      shared_hubs: records.filter((record) => record.classification === "shared_hub").length,
    },
    records,
  );
}

export function measureReactHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const hooksLint = context.reactHooksLint();
  const a11yLint = context.jsxA11yLint();
  const records = [
    ...project.modules.flatMap((module) => reactModuleRecords(module, !a11yLint.complete)),
    ...(hooksLint.messages ?? []).map(hookLintRecord),
    ...(a11yLint.messages ?? []).map(a11yLintRecord),
    ...frameworkRiskRecords(project),
  ];
  const artifact = {
    ...artifactBase(
      config,
      "quality.react_health",
      command,
      analysisConfidence(config, project, {
        eslint_react_hooks_available: hooksLint.available,
        eslint_react_hooks_ran: hooksLint.ran,
        eslint_react_hooks_complete: hooksLint.complete,
        jsx_a11y_available: a11yLint.available,
        jsx_a11y_ran: a11yLint.ran,
        jsx_a11y_complete: a11yLint.complete,
      }),
      sourceSetHash(project),
    ),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages?.length ?? 0,
      a11y_findings: records.filter((record) => ["eslint-plugin-jsx-a11y", "jsx-a11y-heuristic"].includes(String(record.source))).length,
      a11y_tool_findings: a11yLint.messages.length,
      a11y_heuristic_findings: records.filter((record) => record.source === "jsx-a11y-heuristic").length,
      high_risk_components: records.filter((record) => record.risk === "high").length,
    },
    framework: project.frameworkDetails,
    tool_status: {
      eslint_react_hooks: {
        available: hooksLint.available,
        ran: hooksLint.ran,
        complete: hooksLint.complete,
        reason: hooksLint.reason ?? null,
        version: hooksLint.version,
        ruleset: hooksLint.ruleset,
      },
      jsx_a11y: {
        available: a11yLint.available,
        ran: a11yLint.ran,
        complete: a11yLint.complete,
        reason: a11yLint.reason ?? null,
        version: a11yLint.version,
        ruleset: "jsx-a11y-recommended-v1",
      },
    },
    records,
  };
  writeArtifact(config, "react_health.json", artifact);
  return artifact;
}

function reactModuleRecords(module: ModuleRecord, includeA11yFallback: boolean): ScoredRecord[] {
  return [
    ...(includeA11yFallback ? jsxA11yRecords(module) : []),
    ...module.components.map((component) => componentHealthRecord(module, component)),
  ];
}

function componentHealthRecord(module: ModuleRecord, component: FunctionRecord): ScoredRecord {
  const signals = [
    ...(component.lines > 120 ? [{ kind: "oversized_component", value: component.lines }] : []),
    ...(component.hooks > 5 ? [{ kind: "many_hooks", value: component.hooks }] : []),
    ...(component.effects > 2 ? [{ kind: "many_effects", value: component.effects }] : []),
    ...(component.jsxConditionals > 4 ? [{ kind: "render_branch_complexity", value: component.jsxConditionals }] : []),
  ];
  const score = component.lines * 0.25 + component.hooks * 8 + component.effects * 12 + component.jsxConditionals * 6;
  return {
    id: `component:${module.id}:${component.name}`,
    module_id: module.id,
    file: module.file,
    name: component.name,
    line: component.line,
    score: Math.round(score),
    risk: riskForScore(score),
    signals,
  };
}

function hookLintRecord(message: EslintMessage): ScoredRecord {
  const ruleName = message.rule_id.replace(/^react-hooks\//, "");
  const disposition = reactRuleDisposition(ruleName);
  const score = disposition === "block" ? 90 : disposition === "warn" ? 60 : disposition === "review" ? 45 : 20;
  const kind = `${ruleName.replace(/-/g, "_")}_violation`;
  return {
    id: `react-hooks:${message.file}:${message.line ?? 0}:${message.column ?? 0}:${message.rule_id}`,
    rule_id: message.rule_id,
    kind,
    evidence_kind: "tool-rule",
    disposition,
    finding_confidence: "high",
    scope: "file",
    module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
    file: message.file,
    name: message.rule_id,
    line: message.line,
    column: message.column,
    score,
    severity: disposition === "block" ? "high" : disposition === "info" ? "low" : "medium",
    risk: disposition === "block" ? "high" : disposition === "info" ? "low" : "medium",
    source: "eslint-plugin-react-hooks",
    message: message.message,
    signals: [{ kind, message: message.message }],
  };
}

function reactRuleDisposition(ruleName: string): FindingDisposition {
  if (["rules-of-hooks", "set-state-in-render"].includes(ruleName)) return "block";
  if (["exhaustive-deps", "immutability", "globals", "refs", "purity", "static-components", "error-boundaries"].includes(ruleName)) {
    return "warn";
  }
  if (["unsupported-syntax"].includes(ruleName)) return "info";
  return "review";
}

function a11yLintRecord(message: EslintMessage): ScoredRecord {
  const kind = message.rule_id.replace(/^jsx-a11y\//, "a11y_").replace(/-/g, "_");
  return {
    id: `jsx-a11y:${message.rule_id}:${message.file}:${message.line ?? 0}:${message.column ?? 0}`,
    rule_id: message.rule_id,
    kind,
    evidence_kind: "tool-rule",
    disposition: "warn",
    finding_confidence: "high",
    scope: "file",
    module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
    file: message.file,
    line: message.line,
    column: message.column,
    score: 60,
    severity: "medium",
    risk: "medium",
    source: "eslint-plugin-jsx-a11y",
    message: message.message,
    signals: [{ kind, message: message.message }],
  };
}

function jsxA11yRecords(module: ModuleRecord): ScoredRecord[] {
  const records: ScoredRecord[] = [];
  for (const match of module.text.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/g)) {
    records.push(a11yRecord(module, "img_missing_alt", match.index ?? 0, 45));
  }
  for (const match of module.text.matchAll(/<(?:div|span)\b(?=[^>]*\bonClick=)(?![^>]*\brole=)[^>]*>/g)) {
    records.push(a11yRecord(module, "interactive_non_semantic_element", match.index ?? 0, 55));
  }
  return records;
}

function a11yRecord(module: ModuleRecord, kind: string, index: number, score: number): ScoredRecord {
  const line = module.text.slice(0, index).split(/\r?\n/).length;
  return {
    id: `a11y:${module.id}:${kind}:${line}`,
    module_id: module.id,
    file: module.file,
    line,
    kind,
    rule_id: `ts-react-quality-lens/${kind}`,
    evidence_kind: "heuristic",
    disposition: "review",
    finding_confidence: "medium",
    scope: "file",
    score,
    risk: riskForScore(score),
    source: "jsx-a11y-heuristic",
    signals: [{ kind }],
  };
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
    severity: error ? "high" : "medium",
    score: error ? 100 : 50,
    risk: error ? "high" : "medium",
    source: "typescript-compiler",
    message: diagnostic.message,
    diagnostic_code: diagnostic.code,
    character: diagnostic.character,
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
  return {
    id: `typed-lint:${message.rule_id}:${message.file}:${message.line ?? 0}:${message.column ?? 0}`,
    rule_id: message.rule_id,
    kind: message.rule_id.replace(/^@typescript-eslint\//, "typed_").replace(/-/g, "_"),
    evidence_kind: "tool-rule",
    disposition,
    finding_confidence: "high",
    scope: "file",
    module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
    file: message.file,
    line: message.line,
    severity: disposition === "block" ? "high" : disposition === "info" ? "low" : "medium",
    score: disposition === "block" ? 90 : disposition === "info" ? 0 : 50,
    risk: disposition === "block" ? "high" : disposition === "info" ? "low" : "medium",
    source: "typescript-eslint",
    message: message.message,
    column: message.column,
    signals: [{ kind: message.rule_id, message: message.message }],
  };
}

function typeCoverageRecords(
  config: Config,
  coverage: ProjectAnalysis["tsProject"]["type_coverage"],
): ScoredRecord[] {
  if (!coverage) return [];
  const records: ScoredRecord[] = [];
  if (config.typeCoverage.minimumPercent !== null && coverage.summary.type_coverage_percent < config.typeCoverage.minimumPercent) {
    records.push(typeCoverageFinding("project", null, coverage.summary.type_coverage_percent, config.typeCoverage.minimumPercent, "configured_project_floor"));
  }
  if (config.typeCoverage.perFileMinimumPercent !== null) {
    for (const file of coverage.files.filter((item) => item.type_coverage_percent < config.typeCoverage.perFileMinimumPercent!)) {
      records.push(typeCoverageFinding("file", file, file.type_coverage_percent, config.typeCoverage.perFileMinimumPercent, "configured_file_floor"));
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
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
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
    ...(file ? { file: file.file } : {}),
    score: Math.min(100, Math.round(required - actual) * 5),
    risk: actual < required - 10 ? "high" : "medium",
    source: "typescript-compiler-api",
    message: `Type coverage ${actual}% is below the required ${required}% ${scope} threshold.`,
    actual_percent: actual,
    required_percent: required,
    reason,
    ...(file ? { coverage: file } : {}),
    signals: [{ kind: reason, value: actual }],
  };
}

function typeSafetyPostureRecords(config: Config, project: ProjectAnalysis): ScoredRecord[] {
  const options = project.tsProject.compiler_options ?? {};
  const recommended = ["strict"];
  const strict = [
    ...recommended,
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "forceConsistentCasingInFileNames",
  ];
  const expected = config.policy.profile === "strict" ? strict : recommended;
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

function writeQualityArtifact(
  config: Config,
  fileName: string,
  taskId: string,
  command: string,
  project: ProjectAnalysis,
  summary: Record<string, unknown>,
  records: ScoredRecord[],
  extra: Record<string, unknown> = {},
): Artifact {
  const artifact = {
    ...artifactBase(config, taskId, command, analysisConfidence(config, project), sourceSetHash(project)),
    summary,
    ...extra,
    records,
  };
  writeArtifact(config, fileName, artifact);
  return artifact;
}

function riskRecordSummary(records: Array<{ risk?: string }>) {
  return {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
  };
}
