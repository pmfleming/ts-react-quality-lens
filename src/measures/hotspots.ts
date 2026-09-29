import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { compareRisk } from "../collections.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { fileHotspotRecord, functionHotspotRecord } from "../scoring.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Artifact, Config, ScoredRecord } from "../types.js";

export function measureHotspots(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)): Artifact {
  const project = context.project();
  const functions = project.modules.flatMap((module) => module.functions);
  const records: ScoredRecord[] = [];
  for (const module of project.modules) {
    records.push(fileHotspotRecord(module));
    for (const fn of module.functions) records.push(functionHotspotRecord(module, fn));
  }
  records.sort(compareRisk);
  const artifact = {
    ...artifactBase(config, "quality.hotspots", command, analysisConfidence(config, project), sourceSetHash(project)),
    summary: {
      source_files: project.sourceFiles.length,
      records: records.length,
      high_risk_records: records.filter((record) => record.risk === "high").length,
      source_lines: project.modules.reduce((total, module) => total + module.lines, 0),
      functions: functions.length,
      function_metrics: {
        cyclomatic_complexity: distribution(functions.map((fn) => fn.cyclomatic_complexity)),
        cognitive_complexity: distribution(functions.map((fn) => fn.cognitive_complexity)),
        halstead_effort: distribution(functions.map((fn) => fn.halstead_effort)),
      },
    },
    records,
  };
  writeArtifact(config, "hotspots.json", artifact);
  return artifact;
}

function distribution(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    total: Math.round(total * 100) / 100,
    max: values.reduce((max, value) => Math.max(max, value), 0),
    mean: values.length ? Math.round(total / values.length * 100) / 100 : 0,
  };
}
