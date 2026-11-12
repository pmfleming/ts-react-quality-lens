import * as ts from "typescript";
import type { Config, JsonValue, ProjectAnalysis, ScoredRecord } from "./types.js";

export const STRICT_OPTIONS = ["noImplicitAny", "noImplicitThis", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply",
  "strictPropertyInitialization", "strictBuiltinIteratorReturn", "useUnknownInCatchVariables"] as const;

/** Defaults match the installed analysis compiler (6.x); explicit false always wins. */
export function compilerOptionSummary(options: ts.CompilerOptions): Record<string, JsonValue | undefined> {
  const modernDefaults = Number(ts.versionMajorMinor.split(".")[0]) >= 6;
  const strict = options.strict ?? modernDefaults;
  return {
    strict,
    ...Object.fromEntries(STRICT_OPTIONS.map((key) => [key, options[key] ?? strict])),
    noUncheckedIndexedAccess: options.noUncheckedIndexedAccess ?? false,
    exactOptionalPropertyTypes: options.exactOptionalPropertyTypes ?? false,
    noImplicitOverride: options.noImplicitOverride ?? false,
    noImplicitReturns: options.noImplicitReturns ?? false,
    noFallthroughCasesInSwitch: options.noFallthroughCasesInSwitch ?? false,
    forceConsistentCasingInFileNames: options.forceConsistentCasingInFileNames ?? true,
    noPropertyAccessFromIndexSignature: options.noPropertyAccessFromIndexSignature ?? false,
    noUncheckedSideEffectImports: options.noUncheckedSideEffectImports ?? modernDefaults,
    verbatimModuleSyntax: options.verbatimModuleSyntax ?? false,
    erasableSyntaxOnly: options.erasableSyntaxOnly ?? false,
    declaration: options.declaration ?? options.composite ?? false,
    isolatedDeclarations: options.isolatedDeclarations ?? false,
    isolatedModules: Boolean(options.isolatedModules || options.verbatimModuleSyntax),
    jsx: options.jsx, moduleResolution: options.moduleResolution, target: options.target,
  };
}

export function typeSafetyPostureRecords(config: Config, project: ProjectAnalysis): ScoredRecord[] {
  const projects = project.tsProject.project_configs ?? [{ tsconfig: config.tsconfig ?? "project", workspace_id: config.projectName,
    loaded: project.tsProject.loaded, reason: project.tsProject.reason, compiler_options: project.tsProject.compiler_options }];
  const expected = [...STRICT_OPTIONS, ...(config.policy.profile === "strict" ? ["noUncheckedIndexedAccess", "exactOptionalPropertyTypes",
    "noImplicitOverride", "noImplicitReturns", "noFallthroughCasesInSwitch", "forceConsistentCasingInFileNames", "noUncheckedSideEffectImports"] : [])];
  return projects.flatMap((item): ScoredRecord[] => {
    if (!item.loaded || !item.compiler_options || "root_file_count" in item && item.root_file_count === 0 &&
        "project_reference_count" in item && Number(item.project_reference_count) > 0) return [];
    const missing = expected.filter((key) => item.compiler_options?.[key] === false);
    if (!missing.length) return [];
    return [{
      id: `project:type-safety-posture:${item.tsconfig}`, rule_id: `ts-react-quality-lens/tsconfig-${config.policy.profile}`,
      kind: "type_safety_posture", evidence_kind: "diagnostic", disposition: config.policy.profile === "baseline" ? "info" : "warn",
      finding_confidence: "high", scope: "project", tsconfig: item.tsconfig, workspace_id: item.workspace_id,
      message: `Effective compiler checks disabled in ${item.tsconfig}: ${missing.join(", ")}.`,
      score: Math.min(69, missing.length * 12), risk: "medium", source: "typescript-compiler-options",
      signals: missing.map((key) => ({ kind: "compiler_option_disabled", value: key })),
    }];
  });
}
