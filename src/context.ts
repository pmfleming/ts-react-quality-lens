import { analysisConfidence, createAnalysisContext } from "./analysis-context.js";
import { artifactBase, sourceSetHash } from "./provenance.js";
import { catalogForConfig } from "./tasks.js";
import { writeArtifact } from "./writer.js";
import type { Config } from "./types.js";

export function projectContext(config: Config, command: string) {
  const analysis = createAnalysisContext(config).project();
  const context = {
    ...artifactBase(
      config,
      "context.project",
      command,
      analysisConfidence(config, analysis),
      sourceSetHash(analysis),
    ),
    summary: {
      source_files: analysis.sourceFiles.length,
      test_files: analysis.testFiles.length,
      modules: analysis.modules.length,
      imports: analysis.imports.length,
      entrypoint_modules: analysis.modules.filter((module) => module.entrypointRoles.length > 0).length,
      workspaces: analysis.workspaces.length,
      incomplete_workspace_projects: analysis.workspaces.filter((workspace) => workspace.tsconfigs.length > 0 && !workspace.project_loaded).length,
      framework_conventions: Object.entries(analysis.frameworkDetails.conventions)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name),
      cache_status: analysis.cache.status,
      cache_reused: analysis.cache.reused,
      policy_profile: config.policy.profile,
      required_checks: config.policy.requiredChecks,
    },
    workspaces: analysis.workspaces,
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
      workspace_id: module.workspace_id,
      workspace_name: module.workspace_name,
      functions: module.functions.length,
      components: module.components.map((component) => component.name),
    })),
  };
  writeArtifact(config, "context.json", context);
  return context;
}
