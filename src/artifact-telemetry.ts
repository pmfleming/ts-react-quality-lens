import { isRecord } from "./collections.js";
import type { Artifact } from "./types.js";

/** Execution/cache telemetry is retained, but is not semantic analysis evidence. */
export function separateTelemetry(artifact: Artifact): Artifact {
  const confidence = { ...artifact.confidence };
  const telemetry: Record<string, unknown> = isRecord(artifact.telemetry) ? { ...artifact.telemetry } : {};
  for (const key of ["analysis_cache_enabled", "analysis_cache_status"]) {
    if (key in confidence) { telemetry[key] = confidence[key]; delete confidence[key]; }
  }
  const summary = { ...artifact.summary };
  if (artifact.task_id === "context.project") {
    for (const key of ["cache_status", "cache_reused"]) {
      if (key in summary) { telemetry[key] = summary[key]; delete summary[key]; }
    }
  }
  const tool_status = artifact.tool_status ? Object.fromEntries(Object.entries(artifact.tool_status).map(([name, value]) => {
    const status = { ...value };
    if ("duration_ms" in status) { telemetry[`tool/${name}/duration_ms`] = status.duration_ms; delete status.duration_ms; }
    return [name, status];
  })) : undefined;
  return { ...artifact, confidence, summary, ...(tool_status ? { tool_status } : {}), telemetry };
}
