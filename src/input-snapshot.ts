import { discoverSourceFiles, discoverTestFiles, readSourceFile } from "./files.js";
import { compilerInputQueryResults } from "./integrations/compiler-inputs.js";
import { analysisIdentity, sourceSetHash, taskInputHash } from "./provenance.js";
import type { Config, ProjectAnalysis } from "./types.js";

/** Re-read the input closure, not the memoized project, before accepting evidence. */
export function inputSnapshot(config: Config, project: ProjectAnalysis): () => string | null {
  const fingerprint = () => JSON.stringify({
    identity: analysisIdentity(config).id,
    sources: sourceSetHash({
      sourceFiles: discoverSourceFiles(config).map((file) => readSourceFile(file, config.projectRoot)),
      testFiles: discoverTestFiles(config).map((file) => readSourceFile(file, config.projectRoot)),
      tsProject: project.tsProject,
    }),
    queries: compilerInputQueryResults(project.tsProject.input_queries ?? []),
    imported: ["quality.runtime", "quality.sarif", "testing.coverage", "quality.type_health", "map.architecture"]
      .map((task) => taskInputHash(config, task, "imported-input-closure")),
    ...(config.modernWeb.enabled ? { modern_web: taskInputHash(config, "quality.modern_web", "web-input-closure") } : {}),
  });
  const initial = fingerprint();
  return () => {
    try { return fingerprint() === initial ? null : "Analysis inputs changed during the run; rerun analysis."; }
    catch { return "Analysis inputs became unreadable during the run; rerun analysis."; }
  };
}
