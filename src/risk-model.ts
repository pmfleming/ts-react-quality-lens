import type { ModuleRecord, RiskLevel, ScoredRecord } from "./types.js";

export type ArtifactFreshness = "available" | "missing" | "stale";

export type RiskArtifact = {
  records?: ScoredRecord[];
  tests?: Array<{ source_mapping?: string[] }>;
  execution?: { status?: string };
} | null;

export type RiskArtifactLookup = Record<string, RiskArtifact>;
export type ArtifactFreshnessLookup = Record<string, ArtifactFreshness>;
export type RiskClassification = "ok" | "warning" | "bad" | "unknown";
export type RiskScore = number | null;

export type CategoryRiskScores = {
  maintainability: RiskScore;
  correctness: RiskScore;
  architecture: RiskScore;
  change: RiskScore;
  render_performance: RiskScore;
  performance: RiskScore;
  quality: RiskScore;
  total: RiskScore;
};

export type NamedRiskScores = {
  maintainability_risk: RiskScore;
  change_risk: RiskScore;
  performance_risk: RiskScore;
  correctness_risk: RiskScore;
  architectural_risk: RiskScore;
  quality_risk: RiskScore;
  total_score: RiskScore;
};

export type ArchitectureRiskScores = NamedRiskScores & {
  category_scores: CategoryRiskScores;
  risk_score: number;
  classification: RiskClassification;
  unknown_metrics: string[];
};

export const RISK_MODEL = Object.freeze({
  id: "tsrqlens.architecture_risk",
  version: 1,
  calibration: "v1-static-analysis",
  thresholds: Object.freeze({
    warning: 35,
    bad: 70,
  }),
  hotspot: Object.freeze({
    file_line_weight: 0.3,
    file_branch_weight: 2,
    file_import_weight: 2,
    function_complexity_weight: 8,
    function_nesting_weight: 5,
    function_line_weight: 0.4,
    function_jsx_density_weight: 2,
    function_jsx_conditional_weight: 6,
  }),
  architecture: Object.freeze({
    large_module_line_threshold: 300,
    large_module_line_weight: 0.08,
    large_module_cap: 24,
    category_weights: Object.freeze({
      maintainability: 1,
      correctness: 1,
      architecture: 1,
      change: 1,
      performance: 0.5,
      quality: 1,
    }),
  }),
  tool_scores: Object.freeze({
    missing_direct_test_evidence: 40,
    failing_test_run: 85,
    stale_or_missing_input: null,
  }),
});

export function riskForScore(score: number): RiskLevel {
  if (score >= RISK_MODEL.thresholds.bad) return "high";
  if (score >= RISK_MODEL.thresholds.warning) return "medium";
  return "low";
}

export function classifyRiskScore(score: number | null): RiskClassification {
  if (score === null) return "unknown";
  if (score >= RISK_MODEL.thresholds.bad) return "bad";
  if (score >= RISK_MODEL.thresholds.warning) return "warning";
  return "ok";
}

export function riskModelRecordMetadata() {
  return {
    risk_model_id: RISK_MODEL.id,
    risk_model_version: RISK_MODEL.version,
    risk_calibration: RISK_MODEL.calibration,
  };
}

export function architectureRiskScores(
  module: ModuleRecord,
  artifacts: RiskArtifactLookup,
  artifactStatus: ArtifactFreshnessLookup,
  correctnessFiles: Set<string>,
): ArchitectureRiskScores {
  const unknownMetrics: string[] = [];
  const maintainability = availableScore("hotspots", unknownMetrics, artifactStatus, () =>
    maxScoreFor(artifacts.hotspots?.records, module.file),
  );
  const correctness = availableScore("correctness", unknownMetrics, artifactStatus, () =>
    correctnessScore(artifacts.correctness, module.file, correctnessFiles),
  );
  const architecture = availableScore("dependency_health", unknownMetrics, artifactStatus, () => {
    const dependencyScore = maxScoreFor(artifacts.dependency_health?.records, module.file);
    const leverageScore = artifactStatus.leverage === "available" ? maxScoreFor(artifacts.leverage?.records, module.file) : null;
    return clampScore(
      Math.max(dependencyScore ?? 0, leverageScore ?? 0) + largeModulePenalty(module),
    );
  });
  const change = availableScore("locality", unknownMetrics, artifactStatus, () =>
    maxScoreFor(artifacts.locality?.records, module.file),
  );
  const performance = availableScore("react_health", unknownMetrics, artifactStatus, () =>
    Math.max(
      maxScoreFor(artifacts.react_health?.records, module.file) ?? 0,
      artifactStatus.performance === "available" ? maxScoreFor(artifacts.performance?.records, module.file) ?? 0 : 0,
    ),
  );
  const quality = compositeScore(
    ["escape_hatches", "type_health"],
    unknownMetrics,
    artifactStatus,
    (name) => maxScoreFor(artifacts[name]?.records, module.file),
  );

  const categoryScores = {
    maintainability,
    correctness,
    architecture,
    change,
    render_performance: performance,
    performance,
    quality,
    total: weightedTotal({ maintainability, correctness, architecture, change, performance, quality }),
  };
  const riskScore = Math.max(
    0,
    ...[maintainability, correctness, architecture, change, performance, quality].filter(
      (score): score is number => typeof score === "number",
    ),
  );

  return {
    category_scores: categoryScores,
    maintainability_risk: maintainability,
    change_risk: change,
    performance_risk: performance,
    correctness_risk: correctness,
    architectural_risk: architecture,
    quality_risk: quality,
    total_score: categoryScores.total,
    risk_score: riskScore,
    classification: classifyRiskScore(categoryScores.total ?? riskScore),
    unknown_metrics: unknownMetrics,
  };
}

function availableScore(
  artifactName: string,
  unknownMetrics: string[],
  artifactStatus: ArtifactFreshnessLookup,
  compute: () => number | null,
): number | null {
  const status = artifactStatus[artifactName] ?? "missing";
  if (status !== "available") {
    unknownMetrics.push(`${artifactName}:${status}`);
    return null;
  }
  return compute();
}

function compositeScore(
  artifactNames: string[],
  unknownMetrics: string[],
  artifactStatus: ArtifactFreshnessLookup,
  compute: (artifactName: string) => number | null,
): number | null {
  const scores: number[] = [];
  for (const artifactName of artifactNames) {
    const score = availableScore(artifactName, unknownMetrics, artifactStatus, () => compute(artifactName));
    if (typeof score === "number") scores.push(score);
  }
  return scores.length ? Math.max(...scores) : null;
}

function correctnessScore(artifact: RiskArtifact, file: string, correctnessFiles: Set<string>): number | null {
  if (!artifact) return null;
  if (artifact.execution?.status === "failed") return RISK_MODEL.tool_scores.failing_test_run;
  return correctnessFiles.has(file) ? 0 : RISK_MODEL.tool_scores.missing_direct_test_evidence;
}

function weightedTotal(scores: Record<string, number | null>): number | null {
  const entries = Object.entries(RISK_MODEL.architecture.category_weights);
  if (entries.some(([name]) => scores[name] === null)) return null;
  const weighted = entries.reduce((total, [name, weight]) => total + (scores[name] ?? 0) * weight, 0);
  const weights = entries.reduce((total, [, weight]) => total + weight, 0);
  return Math.round(weighted / weights);
}

function maxScoreFor(records: ScoredRecord[] = [], file: string): number | null {
  const candidates = records.filter((record) => record.file === file || record.files?.includes(file));
  if (!candidates.length) return 0;
  return Math.max(0, ...candidates.map((record) => severityScore(record.severity) ?? record.score ?? 0));
}

export function severityScore(severity: unknown): number | null {
  if (severity === "high") return 75;
  if (severity === "medium") return 45;
  if (severity === "low") return 20;
  return null;
}

function largeModulePenalty(module: ModuleRecord): number {
  const extraLines = Math.max(0, module.lines - RISK_MODEL.architecture.large_module_line_threshold);
  return Math.min(RISK_MODEL.architecture.large_module_cap, Math.round(extraLines * RISK_MODEL.architecture.large_module_line_weight));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
