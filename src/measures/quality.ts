import { analysisConfidence, artifactBase, countBy, createAnalysisContext, escapeRecords, frameworkRiskRecords, gitHistory, hiddenCouplingSignals, readArtifact, riskForScore, sourceSetHash, typeHealthRecords, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Artifact, Config, EslintMessage, FunctionRecord, ModuleRecord, ProjectAnalysis, ScoredRecord, TestRecord } from "../types.js";

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
  const records = [...project.modules.flatMap((module) => typeHealthRecords(module)), ...typeSafetyPostureRecords(project)];
  const diagnostics = project.tsProject.diagnostics ?? [];
  return writeQualityArtifact(config, "type_health.json", "quality.type_health", command, project, {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
    wide_types: records.filter((record) => record.signals?.some((signal) => signal.kind === "wide_surface")).length,
    compiler_diagnostics: diagnostics.length,
  },
    records,
    {
      compiler_options: project.tsProject.compiler_options ?? null,
      diagnostics,
    },
  );
}

export function measureLocality(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const testCatalog = readArtifact<{ tests?: Pick<TestRecord, "source_mapping">[] }>(config, "test_catalog.json");
  const testEvidence = new Set((testCatalog?.tests ?? []).flatMap((test) => test.source_mapping ?? []));
  const history = gitHistory(config);
  const records = project.modules.map((module) => {
    const internalImports = module.imports.filter((edge) => edge.to_kind === "relative");
    const farImports = internalImports.filter((edge) => edge.specifier.startsWith("../"));
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
      ["explicit_any", "type_assertion", "double_assertion", "non_null_assertion", "ts_suppression", "eslint_suppression"].includes(
        String(record.kind),
      ),
    ).length;
    const score = Math.max(0, Math.min(100, inboundReach * 10 + publicSurface * 2 + deadExportSurface * 6 - weakSurface * 8));
    const risk = inboundReach > 4 && weakSurface > 0 ? "high" : inboundReach > 2 && weakSurface > 0 ? "medium" : "low";
    return {
      id: `leverage:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk,
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
  const records = [
    ...project.modules.flatMap(reactModuleRecords),
    ...(hooksLint.messages ?? []).map(hookLintRecord),
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
      }),
      sourceSetHash(project),
    ),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages?.length ?? 0,
      a11y_findings: records.filter((record) => record.source === "jsx-a11y-heuristic").length,
      high_risk_components: records.filter((record) => record.risk === "high").length,
    },
    framework: project.frameworkDetails,
    tool_status: {
      eslint_react_hooks: {
        available: hooksLint.available,
        ran: hooksLint.ran,
        reason: hooksLint.reason ?? null,
      },
    },
    records,
  };
  writeArtifact(config, "react_health.json", artifact);
  return artifact;
}

function reactModuleRecords(module: ModuleRecord): ScoredRecord[] {
  return [...jsxA11yRecords(module), ...module.components.map((component) => componentHealthRecord(module, component))];
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
  const score = message.severity === "error" ? 85 : 55;
  return {
    id: `react-hooks:${message.file}:${message.line}:${message.rule_id}`,
    module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
    file: message.file,
    name: message.rule_id,
    line: message.line,
    score,
    risk: message.severity === "error" ? "high" : "medium",
    source: "eslint-plugin-react-hooks",
    signals: [{
      kind: message.rule_id === "react-hooks/rules-of-hooks" ? "rules_of_hooks_violation" : "exhaustive_deps_violation",
      message: message.message,
    }],
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
    score,
    risk: riskForScore(score),
    source: "jsx-a11y-heuristic",
    signals: [{ kind }],
  };
}

function typeSafetyPostureRecords(project: ProjectAnalysis): ScoredRecord[] {
  const options = project.tsProject.compiler_options ?? {};
  const missing = ["strict", "noImplicitAny", "strictNullChecks", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"].filter(
    (key) => options[key] !== true,
  );
  if (!missing.length) return [];
  const score = Math.min(100, missing.length * 18);
  return [{
    id: "project:type-safety-posture",
    kind: "type_safety_posture",
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
