import { analysisConfidence } from "../analysis-context.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import type { Artifact, Config, ProjectAnalysis, ScoredRecord } from "../types.js";

export function writeQualityArtifact(
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
