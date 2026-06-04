import { analysisConfidence, artifactBase, createAnalysisContext, groupMapNodes, mapNode, readArtifact, sourceSetHash, writeArtifact } from "../measure-shared.js";
import { RISK_MODEL, type ArtifactFreshness, type ArtifactFreshnessLookup, type RiskArtifact } from "../risk-model.js";
import type { AnalysisContext, Config, JsonValue } from "../types.js";
import fs from "node:fs";

type MapInputArtifact = RiskArtifact & {
  provenance?: {
    source_set_hash?: JsonValue;
  };
};

export function measureArchitectureMap(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const currentSourceHash = sourceSetHash(project);
  const artifacts: Record<string, MapInputArtifact | null> = {
    hotspots: readArtifact(config, "hotspots.json"),
    clones: readArtifact(config, "clones.json"),
    escape_hatches: readArtifact(config, "ts_escape_hatches.json"),
    type_health: readArtifact(config, "type_health.json"),
    dependency_health: readArtifact(config, "dependency_health.json"),
    correctness: readArtifact(config, "correctness_review.json"),
    locality: readArtifact(config, "locality_metrics.json"),
    leverage: readArtifact(config, "leverage_metrics.json"),
    react_health: readArtifact(config, "react_health.json"),
    performance: readPerformanceInputs(config),
  };
  const correctnessFiles = new Set<string>();
  for (const test of artifacts.correctness?.tests ?? []) {
    for (const file of test.source_mapping ?? []) correctnessFiles.add(file);
  }
  const artifactStatus = artifactFreshness(artifacts, currentSourceHash);
  const nodes = project.modules.map((module) => mapNode(module, artifacts, artifactStatus, correctnessFiles));
  const edges = project.imports.map((edge) => ({
    id: `import:${edge.from}:${edge.to}:${edge.line}`,
    from: edge.from,
    to: edge.to,
    type: edge.import_kind === "dynamic" ? "dynamic_import" : edge.import_kind === "type" ? "type_only_import" : "static_import",
    source: edge.source,
    line: edge.line,
  }));
  const missingInputs = statusKeys(artifactStatus, "missing");
  const requiredMissingInputs = missingInputs.filter((name) => name !== "performance");
  const staleInputs = statusKeys(artifactStatus, "stale");
  const artifact = {
    ...artifactBase(
      config,
      "map.architecture",
      command,
      analysisConfidence(config, project, {
        confidence_scope: "architecture_map_inputs",
        required_inputs: Object.keys(artifacts).filter((name) => name !== "performance"),
        observed_inputs: statusKeys(artifactStatus, "available"),
        missing_input: requiredMissingInputs,
        stale_input: staleInputs,
      }),
      currentSourceHash,
    ),
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      entrypoint_nodes: nodes.filter((node) => node.entrypoint_roles.length > 0).length,
      high_risk_nodes: nodes.filter((node) => node.risk === "high").length,
      unknown_metric_nodes: nodes.filter((node) => node.unknown_metrics.length > 0).length,
      missing_inputs: requiredMissingInputs.length,
      stale_inputs: staleInputs.length,
      artifact_status: artifactStatus,
    },
    meta: {
      risk_model_id: RISK_MODEL.id,
      risk_model_version: RISK_MODEL.version,
      risk_calibration: RISK_MODEL.calibration,
      risk_model_weights: RISK_MODEL.architecture.category_weights,
      risk_model_tool_scores: RISK_MODEL.tool_scores,
      performance_inputs: {
        bundle_stats: config.performanceInputs.bundleStats,
        render_costs: config.performanceInputs.renderCosts,
      },
    },
    groups: groupMapNodes(nodes),
    framework: project.frameworkDetails,
    nodes,
    edges,
  };
  writeArtifact(config, "map.json", artifact);
  return artifact;
}

function artifactFreshness(
  artifacts: Record<string, MapInputArtifact | null>,
  currentSourceHash: string,
): ArtifactFreshnessLookup {
  return Object.fromEntries(
    Object.entries(artifacts).map(([name, value]) => {
      const status: ArtifactFreshness =
        !value ? "missing" : name === "performance" || value.provenance?.source_set_hash === currentSourceHash ? "available" : "stale";
      return [name, status];
    }),
  );
}

function statusKeys(status: ArtifactFreshnessLookup, expected: ArtifactFreshness): string[] {
  return Object.entries(status)
    .filter(([, value]) => value === expected)
    .map(([key]) => key);
}

function readPerformanceInputs(config: Config): MapInputArtifact | null {
  const records = [
    ...readBundleStats(config.performanceInputs.bundleStats),
    ...readRenderCosts(config.performanceInputs.renderCosts),
  ];
  if (!records.length) return null;
  return { records };
}

function readBundleStats(file: string | null) {
  const modules = readJsonArray(file, "modules");
  return modules.flatMap((item, index) => {
    const record = item as Record<string, unknown>;
    const fileName = typeof record.file === "string" ? record.file : typeof record.name === "string" ? record.name : null;
    const bytes = typeof record.bytes === "number" ? record.bytes : typeof record.size === "number" ? record.size : null;
    if (!fileName || bytes === null) return [];
    return [{
      id: `bundle:${index + 1}:${fileName}`,
      kind: "bundle_size",
      file: fileName,
      score: Math.min(100, Math.round(bytes / 10000)),
      risk: RISK_MODEL.thresholds.bad <= bytes / 10000 ? "high" : bytes / 10000 >= RISK_MODEL.thresholds.warning ? "medium" : "low",
      bytes,
      signals: [{ kind: "bundle_bytes", value: bytes }],
    }];
  });
}

function readRenderCosts(file: string | null) {
  const modules = readJsonArray(file, "modules");
  return modules.flatMap((item, index) => {
    const record = item as Record<string, unknown>;
    const fileName = typeof record.file === "string" ? record.file : null;
    const milliseconds = typeof record.ms === "number" ? record.ms : typeof record.render_ms === "number" ? record.render_ms : null;
    if (!fileName || milliseconds === null) return [];
    return [{
      id: `render-cost:${index + 1}:${fileName}`,
      kind: "render_cost",
      file: fileName,
      score: Math.min(100, Math.round(milliseconds / 2)),
      risk: milliseconds >= 140 ? "high" : milliseconds >= 70 ? "medium" : "low",
      milliseconds,
      signals: [{ kind: "render_ms", value: milliseconds }],
    }];
  });
}

function readJsonArray(file: string | null, property: string): unknown[] {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.[property]) ? value[property] : [];
  } catch {
    return [];
  }
}
