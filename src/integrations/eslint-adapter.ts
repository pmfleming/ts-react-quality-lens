import fs from "node:fs";
import { enabledReactRules, selectReactRules } from "../react-guidance.js";
import { TYPED_RULES } from "../rule-policy.js";
import { discoverSourceFiles } from "../files.js";
import os from "node:os";
import path from "node:path";
import { parseJson } from "../collections.js";
import { arrayOf, shape, string } from "../validation.js";
import { discoverWorkspaces } from "../workspaces.js";
import type { Config, EslintAccessibilityResult, EslintMessage, EslintReactHooksResult, EslintTypeAwareResult } from "../types.js";
import {
  existingRelativeRoots,
  managedPackageJsonUrl,
  runLocalTool,
  runToolAdapter,
  toolAvailable,
  toolPackageVersion,
  toolRunOptions,
  recoverToolJson,
} from "./tool-runner.js";

export function runTypedLint(config: Config): EslintTypeAwareResult {
  const version = toolPackageVersion("@typescript-eslint/eslint-plugin");
  const customProject = config.tsconfig && path.resolve(config.tsconfig) !== path.join(config.projectRoot, "tsconfig.json");
  const projectMode = config.typedLint.mode === "auto"
    ? (customProject ? "project" : "project-service")
    : config.typedLint.mode;
  const selection = {
    project_mode: projectMode,
    configured_project: projectMode === "project" && config.tsconfig ? relativePath(config.projectRoot, config.tsconfig) : null,
  };
  const hasConfig = projectMode === "project"
    ? Boolean(config.tsconfig && fs.existsSync(config.tsconfig))
    : discoverWorkspaces(config).tsconfigPaths.length > 0;
  if (!hasConfig || !existingRelativeRoots(config).length) {
    return {
      ...selection,
      available: toolAvailable(config.projectRoot, "eslint", true),
      ran: false,
      reason: hasConfig ? "typed lint has no existing source roots" : "typed lint requires a readable tsconfig",
      messages: [],
      evaluated_files: [],
      version,
      complete: false,
      duration_ms: 0,
    };
  }
  const raw = runTemporaryEslint(config, "typed", typedLintConfig(config, projectMode));
  // Project inline config comments (`/* eslint no-console: "error" */`) can enable rules outside the managed ruleset.
  const result = { ...raw, messages: raw.messages.filter((message) => message.rule_id === "eslint/parser" || Object.hasOwn(TYPED_RULES, message.rule_id)) };
  const parserFailures = result.messages.filter((message) => message.rule_id === "eslint/parser");
  return {
    ...result,
    ...selection,
    version,
    reason: result.reason ?? (parserFailures.length ? `Typed lint could not obtain type information or parse ${parserFailures.length} file(s). See eslint/parser findings.` : null),
    complete: result.ran && parserFailures.length === 0 && selectedFilesEvaluated(config, result.evaluated_files, /\.(?:ts|tsx|mts|cts)$/),
  };
}

type SyntaxMode = "react-hooks" | "jsx-a11y" | "combined";
type LintResult = ReturnType<typeof runTemporaryEslint>;

export function runReactSyntaxLint(config: Config): { hooks: EslintReactHooksResult; accessibility: EslintAccessibilityResult } {
  const selection = selectReactRules(config.react.ruleset);
  const run = (mode: SyntaxMode) => runTemporaryEslint(config, mode, syntaxLintConfig(config, selection.rules, mode));
  const combined = run(config.accessibility.enabled ? "combined" : "react-hooks");
  // Configuration/plugin failures must not hide an independently runnable family.
  const isolate = config.accessibility.enabled && combined.available && !combined.ran;
  const hooks = lintFamily(isolate ? run("react-hooks") : combined, "react-hooks/");
  const accessibility = lintFamily(isolate ? run("jsx-a11y") : combined, "jsx-a11y/");
  const version = toolPackageVersion("eslint-plugin-jsx-a11y");
  return {
    hooks: { ...hooks, version: toolPackageVersion("eslint-plugin-react-hooks"), ruleset: config.react.ruleset,
      selected_preset: selection.preset, enabled_rules: enabledReactRules(selection.rules),
      complete: hooks.ran && !hooks.messages.some((message) => message.rule_id === "eslint/parser") && selectedFilesEvaluated(config, hooks.evaluated_files, /\.[jt]sx?$/) },
    accessibility: config.accessibility.enabled
      ? { ...accessibility, version, complete: accessibility.ran && !accessibility.messages.some((message) => message.rule_id === "eslint/parser") }
      : disabledAccessibilityLint(),
  };
}

export function disabledAccessibilityLint(): EslintAccessibilityResult {
  const version = toolPackageVersion("eslint-plugin-jsx-a11y");
  return { available: version !== null, ran: false, reason: "managed accessibility lint is disabled", duration_ms: 0, messages: [], version, complete: false };
}

function lintFamily(result: LintResult, prefix: string): LintResult {
  return { ...result, messages: result.messages.filter((message) => message.rule_id.startsWith(prefix) || message.rule_id === "eslint/parser") };
}

function runTemporaryEslint(
  config: Config,
  name: string,
  configText: string,
) {
  const toolingDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-eslint-${name}-${process.pid}-`));
  const configPath = path.join(toolingDir, `eslint-${name}.config.mjs`);
  try {
    fs.writeFileSync(configPath, configText, "utf8");
    return runEslint(config, configPath);
  } finally {
    fs.rmSync(toolingDir, { recursive: true, force: true });
  }
}

function runEslint(config: Config, configPath: string) {
  const args = [
    "--config",
    configPath,
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    ...existingRelativeRoots(config),
  ];
  const parse = (stdout: string) => normalizeEslintReport(parseJson(stdout), config);
  return runToolAdapter<{ messages: EslintMessage[]; evaluated_files: string[] }>(
    config,
    "eslint",
    "managed eslint executable was not found",
    { messages: [], evaluated_files: [] },
    (executable) => parse(runLocalTool(executable, args, toolRunOptions(config))),
    (error) => recoverToolJson(error, "[", parse),
    true,
  );
}

function selectedFilesEvaluated(config: Config, evaluated: string[], language: RegExp): boolean {
  const seen = new Set(evaluated);
  const selected = discoverSourceFiles(config).filter((file) => language.test(file));
  return selected.every((file) => seen.has(relativePath(config.projectRoot, file)));
}

function typedLintConfig(config: Config, mode: EslintTypeAwareResult["project_mode"]): string {
  const projectOptions = mode === "project-service"
    ? { projectService: { loadTypeScriptPlugins: false } }
    : { project: [config.tsconfig] };
  return `import { createRequire } from "node:module";
const toolRequire = createRequire(${JSON.stringify(managedPackageJsonUrl())});
const parser = toolRequire("@typescript-eslint/parser");
const plugin = toolRequire("@typescript-eslint/eslint-plugin");
export default [{
  // ESLint lints JavaScript by default; typed lint is scoped to TypeScript, so JavaScript is not parsed here.
  ignores: ["**/*.{js,jsx,mjs,cjs}"],
}, {
  files: ["**/*.{ts,tsx,mts,cts}"],
  ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  linterOptions: ${LINTER_OPTIONS},
  languageOptions: {
    parser,
    parserOptions: {
      ...${JSON.stringify(projectOptions)},
      tsconfigRootDir: ${JSON.stringify(config.projectRoot)},
      ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module"
    }
  },
  plugins: { "@typescript-eslint": plugin },
  rules: ${JSON.stringify(TYPED_RULES)}
}];
`;
}

function syntaxLintConfig(config: Config, rules: Record<string, unknown>, mode: SyntaxMode): string {
  const hooks = mode !== "jsx-a11y", accessibility = mode !== "react-hooks";
  const settings = {
    ...(hooks ? { "react-hooks": config.react.additionalEffectHooks ? { additionalEffectHooks: config.react.additionalEffectHooks } : {} } : {}),
    ...(accessibility ? { "jsx-a11y": { components: config.accessibility.components,
      ...(config.accessibility.polymorphicPropName ? { polymorphicPropName: config.accessibility.polymorphicPropName } : {}) } } : {}),
  };
  return `import { createRequire } from "node:module";
const toolRequire = createRequire(${JSON.stringify(managedPackageJsonUrl())});
const tsParser = toolRequire("@typescript-eslint/parser");
${hooks ? 'const reactHooks = toolRequire("eslint-plugin-react-hooks");' : ""}
${accessibility ? 'const jsxA11y = toolRequire("eslint-plugin-jsx-a11y");' : ""}
export default [{
  files: ["**/*.{js,jsx,ts,tsx}"], ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  linterOptions: ${LINTER_OPTIONS},
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module" } },
  plugins: { ${hooks ? '"react-hooks": reactHooks,' : ""} ${accessibility ? '"jsx-a11y": jsxA11y,' : ""} },
  settings: ${JSON.stringify(settings)},
  rules: { ...${JSON.stringify(hooks ? rules : {})}, ...${accessibility ? "jsxA11y.configs.recommended.rules" : "{}"} }
}];
`;
}

/**
 * Project inline directives target the project's own ESLint configuration. The managed runs load a subset of
 * rules, so "unused" directives and directives naming unloaded plugins describe the managed config, not the code.
 */
const LINTER_OPTIONS = JSON.stringify({ reportUnusedDisableDirectives: "off" });
const UNLOADED_RULE = /^Definition for rule '[^']+' was not found\.?$/;

/** Only parse failures and ignore notices mean a file was not evaluated; other rule-less notices do not. */
function unevaluated(message: { message: string; ruleId?: unknown; fatal?: unknown }): boolean {
  return message.fatal === true || (typeof message.ruleId !== "string" && /^File ignored\b/.test(message.message));
}

const eslintReport = arrayOf(shape({ filePath: string, messages: arrayOf(shape({ message: string })) }));
function normalizeEslintReport(value: unknown, config: Config) {
  if (!eslintReport(value)) throw new Error("Invalid ESLint report");
  const selected = new Set(discoverSourceFiles(config).map((file) => relativePath(config.projectRoot, file)));
  const messages = value.flatMap((result) => result.messages.flatMap((message): EslintMessage[] => {
    if (![1, 2].includes(Number(message.severity))) throw new Error("Invalid ESLint diagnostic");
    const ruleId = typeof message.ruleId === "string" ? message.ruleId : null;
    const fatal = message.fatal === true;
    if ((!ruleId && !fatal) || UNLOADED_RULE.test(message.message)) return [];
    return [{
      file: relativePath(config.projectRoot, result.filePath),
      line: numberOrNull(message.line),
      column: numberOrNull(message.column),
      end_line: numberOrNull(message.endLine),
      end_column: numberOrNull(message.endColumn),
      rule_id: ruleId ?? "eslint/parser",
      severity: message.severity === 2 ? "error" : "warning",
      message: message.message,
    }];
  })).filter((message) => selected.has(message.file));
  const evaluated_files = value.filter((file) => !file.messages.some(unevaluated))
    .map((file) => relativePath(config.projectRoot, file.filePath)).filter((file) => selected.has(file)).sort();
  return { messages, evaluated_files };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function relativePath(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}
