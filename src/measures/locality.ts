import { createAnalysisContext } from "../analysis-context.js";
import { gitHistory } from "../history.js";
import { riskForScore } from "../risk-model.js";
import { escapeRecords, hiddenCouplingSignals } from "../scoring.js";
import { readArtifact } from "../writer.js";
import { directTestSources } from "../test-mapping.js";
import { writeQualityArtifact } from "./quality-artifact.js";
import type { AnalysisContext, Config, ModuleRecord, ScoredRecord } from "../types.js";

export function measureLocality(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const testCatalog = readArtifact(config, "test_catalog.json");
  const testEvidence = new Set((testCatalog?.tests ?? []).flatMap(directTestSources));
  const history = gitHistory(config);
  const records = project.modules.map((module) => {
    const farImports = module.imports.filter((edge) => edge.to_kind === "relative" && edge.specifier.startsWith("../../"));
    const hiddenCoupling = hiddenCouplingSignals(module);
    const hasTestEvidence = testEvidence.has(module.file);
    const historyRecord = history.get(module.file) ?? { commits: 0, contributors: 0, defect_commits: 0, cochange_partners: [] };
    const strongestCochange = historyRecord.cochange_partners[0]?.commits ?? 0;
    const score = Math.min(100,
      farImports.length * 12 + hiddenCoupling.length * 18 + (hasTestEvidence ? 0 : 18) +
      Math.min(20, historyRecord.commits * 2) + Math.min(24, historyRecord.defect_commits * 8) +
      Math.min(18, strongestCochange * 3));
    return {
      id: `locality:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk: riskForScore(score),
      dependency_distance: farImports.length,
      hidden_coupling: hiddenCoupling,
      test_locality: hasTestEvidence ? "direct_import_association" : "no_direct_import_association",
      coverage_status: "not_collected",
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
  return writeQualityArtifact(config, "locality_metrics.json", "quality.locality_dynamic", command, project, {
    records: records.length,
    high_risk_records: records.filter((record) => record.risk === "high").length,
  }, records);
}

export function measureLeverage(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const inbound = new Map<string, number>();
  for (const edge of project.imports.filter((item) => item.to_kind === "relative")) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  const records = project.modules.map((module) => leverageRecord(module, inbound.get(module.id) ?? 0));
  return writeQualityArtifact(config, "leverage_metrics.json", "quality.locality_leverage", command, project, {
    records: records.length,
    shared_hubs: records.filter((record) => record.classification === "shared_hub").length,
  }, records);
}

function leverageRecord(module: ModuleRecord, inboundReach: number): ScoredRecord {
  const publicNames = new Set([
    ...module.exports.map((item) => item.name),
    ...module.types.filter((item) => item.exported).map((item) => item.name),
  ]);
  const publicSurface = publicNames.size;
  const deadExportSurface = inboundReach === 0 && module.entrypointRoles.length === 0 ? module.exports.length : 0;
  const weakSurface = escapeRecords(module).filter((record) => WEAK_SURFACE_KINDS.has(String(record.kind))).length;
  const leverageScore = Math.min(100, inboundReach * 10 + publicSurface * 2);
  const score = Math.min(100, weakSurface * 12 + deadExportSurface * 6 + (inboundReach > 4 && weakSurface > 0 ? 20 : 0));
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
}

const WEAK_SURFACE_KINDS = new Set([
  "explicit_any", "type_assertion", "double_assertion", "non_null_assertion",
  "ts_ignore", "ts_nocheck", "eslint_suppression",
]);
