import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { fileHotspotRecord, functionHotspotRecord } from "../scoring.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Artifact, Config, ScoredRecord } from "../types.js";

export function measureHotspots(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)): Artifact {
  const project = context.project();
  const records: ScoredRecord[] = [];
  for (const module of project.modules) {
    records.push(fileHotspotRecord(module));
    for (const fn of module.functions) records.push(functionHotspotRecord(module, fn));
  }
  records.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
  const artifact = {
    ...artifactBase(config, "quality.hotspots", command, analysisConfidence(config, project), sourceSetHash(project)),
    summary: {
      source_files: project.sourceFiles.length,
      records: records.length,
      high_risk_records: records.filter((record) => record.risk === "high").length,
    },
    records,
  };
  writeArtifact(config, "hotspots.json", artifact);
  return artifact;
}
