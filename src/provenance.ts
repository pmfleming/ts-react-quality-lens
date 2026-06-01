import os from "node:os";
import { LENS_NAME, SCHEMA_VERSION } from "./tasks.js";

export function provenance(command, sourceType = "static") {
  return {
    lens: LENS_NAME,
    schema_version: SCHEMA_VERSION,
    command,
    host: os.hostname(),
    measured_at: new Date().toISOString(),
    source_type: sourceType,
  };
}

export function artifactBase(config, taskId, command, confidence) {
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
    provenance: provenance(command),
    confidence,
  };
}
