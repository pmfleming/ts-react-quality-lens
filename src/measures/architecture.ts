import { createAnalysisContext, analysisConfidence, groupMapNodes, mapNode } from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { readArtifact, writeArtifact } from "../writer.js";

export function measureArchitectureMap(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const artifacts = {
    hotspots: readArtifact(config, "hotspots.json"),
    escape_hatches: readArtifact(config, "ts_escape_hatches.json"),
    type_health: readArtifact(config, "type_health.json"),
    dependency_health: readArtifact(config, "dependency_health.json"),
    correctness: readArtifact(config, "correctness_review.json"),
    locality: readArtifact(config, "locality_metrics.json"),
    leverage: readArtifact(config, "leverage_metrics.json"),
    react_health: readArtifact(config, "react_health.json"),
  };
  const nodes = project.modules.map((module) => mapNode(module, artifacts));
  const edges = project.imports.map((edge) => ({
    id: `import:${edge.from}:${edge.to}:${edge.line}`,
    from: edge.from,
    to: edge.to,
    type: edge.import_kind === "dynamic" ? "dynamic_import" : edge.import_kind === "type" ? "type_only_import" : "static_import",
    source: edge.source,
    line: edge.line,
  }));
  const artifact = {
    ...artifactBase(config, "map.architecture", command, analysisConfidence(config, project)),
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      high_risk_nodes: nodes.filter((node) => node.risk === "high").length,
      artifact_status: Object.fromEntries(
        Object.entries(artifacts).map(([name, value]) => [name, value ? "available" : "missing"]),
      ),
    },
    groups: groupMapNodes(nodes),
    framework: project.frameworkDetails,
    nodes,
    edges,
  };
  writeArtifact(config, "map.json", artifact);
  return artifact;
}
