import { createConfidence } from "./config.js";
import { discoverSourceFiles, discoverTestFiles, readSourceFile } from "./files.js";
import { analyzeModule } from "./extract.js";
import { entrypointRolesForFile, projectEntrypoints, workspacePackageEntrypoints } from "./entrypoints.js";
import { updateAnalysisCache } from "./cache.js";
import { runJsxA11yLint, runReactHooksLint, runTypedLint } from "./integrations/eslint-adapter.js";
import { runDependencyCruiser, runJscpd, runKnip } from "./integrations/external-tools.js";
import { loadTypeScriptProjects } from "./integrations/typescript-project.js";
import { runPackageHealth } from "./integrations/package-tools.js";
import { detectFrameworkDetails } from "./framework-adapters.js";
import { discoverWorkspaces, workspaceForFile, workspacePackageName } from "./workspaces.js";
import type { AnalysisContext, Config, Confidence, ProjectAnalysis } from "./types.js";

function analyzeProject(config: Config): ProjectAnalysis {
  const sourceFiles = discoverSourceFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const testFiles = discoverTestFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const workspaceDiscovery = discoverWorkspaces(config, sourceFiles);
  const tsProject = loadTypeScriptProjects(config, sourceFiles, workspaceDiscovery.tsconfigPaths);
  const entrypoints = [
    ...projectEntrypoints(config),
    ...workspaceDiscovery.records
      .filter((workspace) => workspace.root !== ".")
      .flatMap((workspace) => workspacePackageEntrypoints(config, workspace.root)),
  ];
  const modules = sourceFiles.map((file) => analyzeModule(config, file, tsProject));
  for (const module of modules) {
    module.entrypointRoles = entrypointRolesForFile(entrypoints, module.file);
    const workspace = workspaceForFile(workspaceDiscovery.records, module.file);
    module.workspace_id = workspace.id;
    module.workspace_name = workspace.name;
  }
  const imports = modules.flatMap((module) => module.imports);
  annotateWorkspaceEdges(modules, imports, workspaceDiscovery.records);
  const workspaces = workspaceAnalysisRecords(workspaceDiscovery.records, modules, tsProject.project_configs ?? []);
  const frameworkDetails = detectFrameworkDetails(config, { sourceFiles, testFiles, modules, imports });
  const unsupportedPatterns = modules.flatMap((module) => module.unsupportedPatterns);
  const projectWithoutCache = { sourceFiles, testFiles, modules, imports, tsProject, frameworkDetails, workspaces, unsupportedPatterns };
  const cache = updateAnalysisCache(config, projectWithoutCache);
  return { ...projectWithoutCache, cache };
}

function annotateWorkspaceEdges(
  modules: ProjectAnalysis["modules"],
  imports: ProjectAnalysis["imports"],
  workspaces: ProjectAnalysis["workspaces"],
): void {
  const moduleWorkspace = new Map(modules.map((module) => [module.id, module.workspace_id]));
  const packageWorkspace = new Map(workspaces.map((workspace) => [workspace.name, workspace.id]));
  for (const edge of imports) {
    const fromWorkspace = moduleWorkspace.get(edge.from);
    const toWorkspace = edge.to_kind === "relative"
      ? moduleWorkspace.get(edge.to)
      : packageWorkspace.get(workspacePackageName(edge.specifier));
    if (fromWorkspace) edge.from_workspace = fromWorkspace;
    if (toWorkspace) edge.to_workspace = toWorkspace;
    if (fromWorkspace && toWorkspace && fromWorkspace !== toWorkspace) edge.workspace_dependency = true;
  }
}

function workspaceAnalysisRecords(
  workspaces: ProjectAnalysis["workspaces"],
  modules: ProjectAnalysis["modules"],
  projects: NonNullable<ProjectAnalysis["tsProject"]["project_configs"]>,
): ProjectAnalysis["workspaces"] {
  return workspaces.map((workspace) => {
    const statuses = projects.filter((project) => workspace.tsconfigs.includes(project.tsconfig));
    const loaded = statuses.length > 0 && statuses.every((status) => status.loaded);
    return {
      ...workspace,
      source_files: modules.filter((module) => module.workspace_id === workspace.id).length,
      project_loaded: loaded,
      project_reason: loaded
        ? null
        : statuses.map((status) => status.reason).filter((reason): reason is string => Boolean(reason)).join("; ") || workspace.project_reason,
    };
  });
}

export function createAnalysisContext(config: Config): AnalysisContext {
  const cache = new Map<keyof AnalysisContext, ReturnType<AnalysisContext[keyof AnalysisContext]>>();
  const loaders: AnalysisContext = {
    project: () => analyzeProject(config),
    jscpd: () => runJscpd(config),
    dependencyCruiser: () => runDependencyCruiser(config),
    knip: () => runKnip(config),
    packageHealth: () => runPackageHealth(config),
    reactHooksLint: () => runReactHooksLint(config),
    jsxA11yLint: () => runJsxA11yLint(config),
    typedLint: () => runTypedLint(config),
  };
  return {
    project: () => cached(cache, "project", loaders.project),
    jscpd: () => cached(cache, "jscpd", loaders.jscpd),
    dependencyCruiser: () => cached(cache, "dependencyCruiser", loaders.dependencyCruiser),
    knip: () => cached(cache, "knip", loaders.knip),
    packageHealth: () => cached(cache, "packageHealth", loaders.packageHealth),
    reactHooksLint: () => cached(cache, "reactHooksLint", loaders.reactHooksLint),
    jsxA11yLint: () => cached(cache, "jsxA11yLint", loaders.jsxA11yLint),
    typedLint: () => cached(cache, "typedLint", loaders.typedLint),
  };
}

function cached<K extends keyof AnalysisContext>(
  cache: Map<keyof AnalysisContext, ReturnType<AnalysisContext[keyof AnalysisContext]>>,
  key: K,
  load: AnalysisContext[K],
): ReturnType<AnalysisContext[K]> {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key) as ReturnType<AnalysisContext[K]>;
}

export function analysisConfidence(config: Config, project: ProjectAnalysis, extra: Confidence = {}): Confidence {
  return createConfidence(config, {
    typescript_compiler_api_available: project.tsProject.available,
    typescript_program_loaded: project.tsProject.loaded,
    typescript_program_reason: project.tsProject.reason,
    type_information_available: project.tsProject.loaded,
    framework_conventions_detected: Object.values(project.frameworkDetails.conventions).some(Boolean),
    workspaces_detected: project.workspaces.length,
    workspace_projects_complete: project.workspaces
      .filter((workspace) => workspace.tsconfigs.length > 0)
      .every((workspace) => workspace.project_loaded),
    analysis_cache_enabled: project.cache?.enabled ?? false,
    analysis_cache_status: project.cache?.status ?? "disabled",
    unsupported_pattern: project.unsupportedPatterns,
    ...extra,
  });
}
