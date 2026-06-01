import { createAnalysisContext, analysisConfidence, fileHotspotRecord, functionHotspotRecord } from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { writeArtifact } from "../writer.js";

export function measureHotspots(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const records = [];
  for (const module of project.modules) {
    records.push(fileHotspotRecord(module));
    for (const fn of module.functions) records.push(functionHotspotRecord(module, fn));
  }
  records.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const artifact = {
    ...artifactBase(config, "quality.hotspots", command, analysisConfidence(config, project)),
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
