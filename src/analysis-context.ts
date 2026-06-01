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

export function analyzeProject(config) {
  const sourceFiles = discoverSourceFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const testFiles = discoverTestFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const tsProject = loadTypeScriptProject(config, sourceFiles);
  const modules = sourceFiles.map((file) => analyzeModule(config, file, tsProject));
  const imports = modules.flatMap((module) => module.imports);
  const frameworkDetails = detectFrameworkDetails(config, { sourceFiles, testFiles, modules, imports });
  return { sourceFiles, testFiles, modules, imports, tsProject, frameworkDetails };
}

export function createAnalysisContext(config) {
  const cache = new Map();
  const loaders = {
    project: () => analyzeProject(config),
    jscpd: () => runJscpd(config),
    dependencyCruiser: () => runDependencyCruiser(config),
    reactHooksLint: () => runReactHooksLint(config),
  };
  return Object.fromEntries(
    Object.entries(loaders).map(([key, load]) => [key, () => cached(cache, key, load)]),
  );
}

function cached(cache, key, load) {
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key);
}

export function analysisConfidence(config, project, extra = {}) {
  return createConfidence(config, {
    typescript_compiler_api_available: project.tsProject.available,
    typescript_program_loaded: project.tsProject.loaded,
    typescript_program_reason: project.tsProject.reason,
    type_information_available: project.tsProject.loaded,
    framework_conventions_detected: Object.values(project.frameworkDetails.conventions).some(Boolean),
    ...extra,
  });
}
