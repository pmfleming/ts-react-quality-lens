import { createConfidence } from "./config.js";
import { discoverSourceFiles, discoverTestFiles, readSourceFile } from "./files.js";
import { analyzeModule } from "./extract.js";
import {
  detectFrameworkDetails,
  loadTypeScriptProject,
  runDependencyCruiser,
  runJscpd,
  runReactHooksLint,
} from "./integrations.js";
import type { AnalysisContext, Config, Confidence, ProjectAnalysis } from "./types.js";

export function analyzeProject(config: Config): ProjectAnalysis {
  const sourceFiles = discoverSourceFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const testFiles = discoverTestFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const tsProject = loadTypeScriptProject(config, sourceFiles);
  const modules = sourceFiles.map((file) => analyzeModule(config, file, tsProject));
  const imports = modules.flatMap((module) => module.imports);
  const frameworkDetails = detectFrameworkDetails(config, { sourceFiles, testFiles, modules, imports });
  const unsupportedPatterns = modules.flatMap((module) => module.unsupportedPatterns);
  return { sourceFiles, testFiles, modules, imports, tsProject, frameworkDetails, unsupportedPatterns };
}

export function createAnalysisContext(config: Config): AnalysisContext {
  const cache = new Map<keyof AnalysisContext, ReturnType<AnalysisContext[keyof AnalysisContext]>>();
  const loaders: AnalysisContext = {
    project: () => analyzeProject(config),
    jscpd: () => runJscpd(config),
    dependencyCruiser: () => runDependencyCruiser(config),
    reactHooksLint: () => runReactHooksLint(config),
  };
  return {
    project: () => cached(cache, "project", loaders.project),
    jscpd: () => cached(cache, "jscpd", loaders.jscpd),
    dependencyCruiser: () => cached(cache, "dependencyCruiser", loaders.dependencyCruiser),
    reactHooksLint: () => cached(cache, "reactHooksLint", loaders.reactHooksLint),
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
    unsupported_pattern: project.unsupportedPatterns,
    ...extra,
  });
}
