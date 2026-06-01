import {
  createAnalysisContext,
  analysisConfidence,
  countBy,
  escapeRecords,
  frameworkRiskRecords,
  gitChurn,
  hiddenCouplingSignals,
  riskForScore,
  typeHealthRecords,
} from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { readArtifact, writeArtifact } from "../writer.js";

export function measureEscapeHatches(config, command, context = createAnalysisContext(config)) {
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

export function measureTypeHealth(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const records = project.modules.flatMap((module) => typeHealthRecords(module));
  const diagnostics = project.tsProject.diagnostics ?? [];
  return writeQualityArtifact(config, "type_health.json", "quality.type_health", command, project, {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
    wide_types: records.filter((record) => record.signals.some((signal) => signal.kind === "wide_surface")).length,
    compiler_diagnostics: diagnostics.length,
  },
    records,
    {
      compiler_options: project.tsProject.compiler_options ?? null,
      diagnostics,
    },
  );
}

export function measureLocality(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const testCatalog = readArtifact(config, "test_catalog.json");
  const testEvidence = new Set((testCatalog?.tests ?? []).flatMap((test) => test.source_mapping ?? []));
  const churn = gitChurn(config);
  const records = project.modules.map((module) => {
    const internalImports = module.imports.filter((edge) => edge.to_kind === "relative");
    const farImports = internalImports.filter((edge) => edge.specifier.startsWith("../"));
    const hiddenCoupling = hiddenCouplingSignals(module);
    const hasTestEvidence = testEvidence.has(module.file);
    const score = Math.min(
      100,
      farImports.length * 12 +
        hiddenCoupling.length * 18 +
        (hasTestEvidence ? 0 : 18) +
        Math.min(20, (churn.get(module.file)?.commits ?? 0) * 2),
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
      churn: churn.get(module.file) ?? { commits: 0, contributors: 0 },
      signals: [
        ...farImports.map((edge) => ({ kind: "far_import", line: edge.line, specifier: edge.specifier })),
        ...hiddenCoupling.map((signal) => ({ kind: signal.kind, line: signal.line })),
        ...(hasTestEvidence ? [] : [{ kind: "missing_direct_test_evidence" }]),
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

export function measureLeverage(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const inbound = new Map();
  for (const edge of project.imports.filter((item) => item.to_kind === "relative")) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  const records = project.modules.map((module) => {
    const inboundReach = inbound.get(module.id) ?? 0;
    const publicSurface = module.exports.length + module.types.length;
    const weakSurface = module.escapeCounts.any + module.escapeCounts.assertions + module.escapeCounts.suppressions;
    const score = Math.max(0, Math.min(100, inboundReach * 10 + publicSurface * 2 - weakSurface * 8));
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
      classification: inboundReach > 3 ? "shared_hub" : inboundReach === 0 ? "leaf" : "local_dependency",
      signals: [
        ...(inboundReach > 3 ? [{ kind: "broad_inbound_reach", value: inboundReach }] : []),
        ...(weakSurface > 0 ? [{ kind: "weak_public_surface", value: weakSurface }] : []),
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

export function measureReactHealth(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const hooksLint = context.reactHooksLint();
  const records = [];
  for (const module of project.modules) {
    for (const component of module.components) {
      const signals = [];
      if (component.lines > 120) signals.push({ kind: "oversized_component", value: component.lines });
      if (component.hooks > 5) signals.push({ kind: "many_hooks", value: component.hooks });
      if (component.effects > 2) signals.push({ kind: "many_effects", value: component.effects });
      if (component.jsxConditionals > 4) {
        signals.push({ kind: "render_branch_complexity", value: component.jsxConditionals });
      }
      const score =
        component.lines * 0.25 + component.hooks * 8 + component.effects * 12 + component.jsxConditionals * 6;
      records.push({
        id: `component:${module.id}:${component.name}`,
        module_id: module.id,
        file: module.file,
        name: component.name,
        line: component.line,
        score: Math.round(score),
        risk: riskForScore(score),
        signals,
      });
    }
  }
  for (const message of hooksLint.messages ?? []) {
    records.push({
      id: `react-hooks:${message.file}:${message.line}:${message.rule_id}`,
      module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
      file: message.file,
      name: message.rule_id,
      line: message.line,
      score: message.severity === "error" ? 85 : 55,
      risk: message.severity === "error" ? "high" : "medium",
      source: "eslint-plugin-react-hooks",
      signals: [
        {
          kind: message.rule_id === "react-hooks/rules-of-hooks" ? "rules_of_hooks_violation" : "exhaustive_deps_violation",
          message: message.message,
        },
      ],
    });
  }
  records.push(...frameworkRiskRecords(project));
  const artifact = {
    ...artifactBase(
      config,
      "quality.react_health",
      command,
      analysisConfidence(config, project, {
        eslint_react_hooks_available: hooksLint.available,
        eslint_react_hooks_ran: hooksLint.ran,
      }),
    ),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages?.length ?? 0,
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

function writeQualityArtifact(config, fileName, taskId, command, project, summary, records, extra = {}) {
  const artifact = {
    ...artifactBase(config, taskId, command, analysisConfidence(config, project)),
    summary,
    ...extra,
    records,
  };
  writeArtifact(config, fileName, artifact);
  return artifact;
}

function riskRecordSummary(records) {
  return {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
  };
}
