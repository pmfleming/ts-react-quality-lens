import { analysisConfidence } from "../analysis-context.js";
import { artifactBase } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Artifact, Config, ScoredRecord } from "../types.js";

export function writeQualityArtifact(
  config: Config,
  fileName: string,
  taskId: string,
  command: string,
  context: AnalysisContext,
  summary: Record<string, unknown>,
  records: ScoredRecord[],
  extra: Record<string, unknown> = {},
): Artifact {
  const project = context.project();
  const artifact = {
    ...artifactBase(config, taskId, command, analysisConfidence(config, project), context.sourceHash(), context.identity(),
      taskId === "quality.locality_dynamic" ? context.history().fingerprint : undefined),
    summary,
    ...extra,
    records,
  };
  return writeArtifact(config, fileName, artifact);
}
