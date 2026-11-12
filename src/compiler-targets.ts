import * as ts from "typescript";
import type { Config, ProjectAnalysis, ScoredRecord } from "./types.js";

export function compilerTargetEvidence(config: Config, project: ProjectAnalysis) {
  const records: ScoredRecord[] = [];
  const projects = new Map((project.tsProject.project_configs ?? []).map((item) => [item.tsconfig, item]));
  const configured = new Map(config.typescript.targets.map((target) => [target.tsconfig, target.environment]));
  const contexts = [...new Set([...projects.keys(), ...configured.keys()])].sort().map((file) => {
    const item = projects.get(file);
    const environment = configured.get(file) ?? null;
    const options = item?.compiler_options;
    const status = !environment ? "unknown" : !item?.loaded || !options || typeof options.module !== "number" ||
      typeof options.moduleResolution !== "number" ? "unavailable" : "evaluated";
    if (status === "evaluated" && options) {
      const nodeResolution = options.moduleResolution === ts.ModuleResolutionKind.Node16 || options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
      const nodeModule = typeof options.module === "number" && options.module >= ts.ModuleKind.Node16 && options.module <= ts.ModuleKind.NodeNext;
      if (environment === "node" && (!nodeResolution || !nodeModule)) add("node-module-model", "Review a Node-aware module/resolution pair matching the supported Node version. Bundler or legacy resolution can accept imports the runtime cannot load.");
      if (environment === "bundler") {
        if (options.moduleResolution !== ts.ModuleResolutionKind.Bundler) add("bundler-resolution", "Check this configuration against the actual bundler's module resolution behavior.");
        if (!options.isolatedModules) add("isolated-transpilation", "Enable isolatedModules or verbatimModuleSyntax when the bundler transpiles files independently.");
        if (!options.noEmit && !options.emitDeclarationOnly) add("duplicate-emit", "Verify that emitting JavaScript with TypeScript alongside the bundler is intentional; consider noEmit or declaration-only emit.");
      }
      if (environment === "browser" && !nodeResolution) add("browser-module-resolution", "Unbundled browser modules need runtime-valid specifiers. Review Node-aware ESM checking together with import maps or URL mappings; bundler resolution alone does not establish browser compatibility.");
      if (environment === "library") {
        if (options.moduleResolution === ts.ModuleResolutionKind.Bundler) add("library-consumer-resolution", "Validate externalized imports and emitted declarations under consumer resolution modes. Bundler-only resolution can hide extensionless imports in published files.");
        if (!options.declaration) add("library-declaration-output", "Verify how consumer declarations are produced: this tsconfig does not enable declaration emit. An external declaration pipeline may satisfy this requirement.");
        if (options.target_explicit === false || options.target === ts.ScriptTarget.ESNext) add("library-runtime-floor", "Declare the lowest supported output target or verify that an external emitter enforces it. A floating/latest target does not state a stable consumer runtime floor.");
        if (!options.noEmit && !options.outDir) add("library-output-location", "Review a separate output directory to avoid mixing emitted JavaScript/declarations with published source.");
      }
    }
    return { tsconfig: file, environment, status, options: options ?? null,
      reason: status === "unknown" ? "No runtime environment declared." : status === "unavailable" ? "Target tsconfig was not successfully analyzed or compiler defaults are unavailable." : null };

    function add(rule: string, message: string): void {
      records.push({ id: `compiler-target:${file}:${rule}`, rule_id: `ts-react-quality-lens/${rule}`, kind: "compiler_target_review",
        tsconfig: file, environment, message, evidence_kind: "diagnostic", disposition: "review", semantic_decision: "unresolved",
        finding_confidence: "medium", scope: "project", score: 25, risk: "low", source: "typescript-compiler-options" });
    }
  });
  return { report: { contexts, limitations: "Declared runtime contexts only. Does not execute a bundler, verify package formats, browser versions, dual emit, or external declaration pipelines." }, records };
}
