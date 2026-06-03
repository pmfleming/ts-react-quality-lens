import os from "node:os";
import crypto from "node:crypto";
import { LENS_NAME, SCHEMA_VERSION } from "./tasks.js";
import type { Confidence, Config, ProjectAnalysis } from "./types.js";

export function provenance(command: string, sourceType = "static") {
  return {
    lens: LENS_NAME,
    schema_version: SCHEMA_VERSION,
    command,
    host: os.hostname(),
    measured_at: new Date().toISOString(),
    source_type: sourceType,
  };
}

export function artifactBase(
  config: Config,
  taskId: string,
  command: string,
  confidence: Confidence,
  sourceSetHash: string | null = null,
) {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    project: {
      name: config.projectName,
      root: config.projectRoot,
      framework: config.framework,
      package_manager: config.packageManager,
      test_runner: config.testRunner,
    },
    provenance: {
      ...provenance(command),
      ...(sourceSetHash ? { source_set_hash: sourceSetHash } : {}),
    },
    confidence,
  };
}

export function sourceSetHash(project: Pick<ProjectAnalysis, "sourceFiles">): string {
  const hash = crypto.createHash("sha256");
  for (const file of [...project.sourceFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.text);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
