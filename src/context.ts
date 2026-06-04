import { createAnalysisContext } from "./analysis-context.js";
import { catalogForConfig } from "./tasks.js";
import { sourceSetHash } from "./provenance.js";
import { writeArtifact } from "./writer.js";
import type { Config } from "./types.js";

export function projectContext(config: Config, command: string) {
  const analysis = createAnalysisContext(config).project();
  const context = {
    schema_version: "0.1.0",
    task_id: "context.project",
    project: {
      name: config.projectName,
      root: config.projectRoot,
      framework: config.framework,
      package_manager: config.packageManager,
      test_runner: config.testRunner,
    },
    provenance: {
      lens: "ts-react-quality-lens",
      command,
      source_set_hash: sourceSetHash(analysis),
      measured_at: new Date().toISOString(),
    },
    summary: {
      source_files: analysis.sourceFiles.length,
      test_files: analysis.testFiles.length,
      modules: analysis.modules.length,
      imports: analysis.imports.length,
      entrypoint_modules: analysis.modules.filter((module) => module.entrypointRoles.length > 0).length,
      framework_conventions: Object.entries(analysis.frameworkDetails.conventions)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
      cache_status: analysis.cache.status,
    },
    tasks: catalogForConfig(config).tasks.map((task) => ({
      id: task.id,
      artifact: task.artifact,
      category: task.category,
    })),
    modules: analysis.modules.map((module) => ({
      id: module.id,
      file: module.file,
      lines: module.lines,
      imports: module.imports.length,
      exports: module.exports.map((item) => item.name),
      entrypoint_roles: module.entrypointRoles,
      functions: module.functions.length,
      components: module.components.map((component) => component.name),
    })),
  };
  writeArtifact(config, "context.json", context);
  return context;
}
