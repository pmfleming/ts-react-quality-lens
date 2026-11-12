import * as ts from "typescript";
import type { CompilerTarget, Config, ProjectAnalysis, ScoredRecord, TypeScriptProject } from "./types.js";

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
    if (status === "evaluated" && options && environment) {
      for (const policy of POLICIES[environment]) if (policy.applies(options)) add(policy.rule, policy.message);
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

type Options = NonNullable<TypeScriptProject["compiler_options"]>;
type Policy = { rule: string; applies: (options: Options) => boolean; message: string };
function nodeResolution(options: Options): boolean {
  return options.moduleResolution === ts.ModuleResolutionKind.Node16 || options.moduleResolution === ts.ModuleResolutionKind.NodeNext;
}
function nodeModule(options: Options): boolean {
  return typeof options.module === "number" && options.module >= ts.ModuleKind.Node16 && options.module <= ts.ModuleKind.NodeNext;
}

const POLICIES: Record<CompilerTarget["environment"], Policy[]> = {
  node: [
    { rule: "node-module-model", applies: (options) => !nodeResolution(options) || !nodeModule(options),
      message: "Review a Node-aware module/resolution pair matching the supported Node version. Bundler or legacy resolution can accept imports the runtime cannot load." },
  ],
  bundler: [
    { rule: "bundler-resolution", applies: (options) => options.moduleResolution !== ts.ModuleResolutionKind.Bundler,
      message: "Check this configuration against the actual bundler's module resolution behavior." },
    { rule: "isolated-transpilation", applies: (options) => !options.isolatedModules,
      message: "Enable isolatedModules or verbatimModuleSyntax when the bundler transpiles files independently." },
    { rule: "duplicate-emit", applies: (options) => !options.noEmit && !options.emitDeclarationOnly,
      message: "Verify that emitting JavaScript with TypeScript alongside the bundler is intentional; consider noEmit or declaration-only emit." },
  ],
  browser: [
    { rule: "browser-module-resolution", applies: (options) => !nodeResolution(options),
      message: "Unbundled browser modules need runtime-valid specifiers. Review Node-aware ESM checking together with import maps or URL mappings; bundler resolution alone does not establish browser compatibility." },
  ],
  library: [
    { rule: "library-consumer-resolution", applies: (options) => options.moduleResolution === ts.ModuleResolutionKind.Bundler,
      message: "Validate externalized imports and emitted declarations under consumer resolution modes. Bundler-only resolution can hide extensionless imports in published files." },
    { rule: "library-declaration-output", applies: (options) => !options.declaration,
      message: "Verify how consumer declarations are produced: this tsconfig does not enable declaration emit. An external declaration pipeline may satisfy this requirement." },
    { rule: "library-runtime-floor", applies: (options) => options.target_explicit === false || options.target === ts.ScriptTarget.ESNext,
      message: "Declare the lowest supported output target or verify that an external emitter enforces it. A floating/latest target does not state a stable consumer runtime floor." },
    { rule: "library-output-location", applies: (options) => !options.noEmit && !options.outDir,
      message: "Review a separate output directory to avoid mixing emitted JavaScript/declarations with published source." },
  ],
};
