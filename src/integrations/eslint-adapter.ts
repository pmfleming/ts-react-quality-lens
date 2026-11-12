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
  const result = runTemporaryEslint(config, "typed", typedLintConfig(config, projectMode), undefined, true);
  const parserFailures = result.messages.filter((message) => message.rule_id === "eslint/parser");
  return {
    ...result,
    ...selection,
    version,
    reason: result.reason ?? (parserFailures.length ? `Typed lint could not obtain type information or parse ${parserFailures.length} file(s). See eslint/parser findings.` : null),
    complete: result.ran && parserFailures.length === 0 && selectedFilesEvaluated(config, result.evaluated_files, /\.(?:ts|tsx|mts|cts)$/),
  };
}

export function runJsxA11yLint(config: Config): EslintAccessibilityResult {
  const version = toolPackageVersion("eslint-plugin-jsx-a11y");
  if (!config.accessibility.enabled) {
    return {
      available: version !== null,
      ran: false,
      reason: "managed accessibility lint is disabled",
      duration_ms: 0,
      messages: [],
      version,
      complete: false,
    };
  }
  const result = runTemporaryEslint(
    config,
    "jsx-a11y",
    jsxA11yConfig(managedPackageJsonUrl(), config),
    "jsx-a11y/",
    true,
  );
  return {
    ...result,
    version,
    complete: result.ran && !result.messages.some((message) => message.rule_id === "eslint/parser"),
  };
}

export function runReactHooksLint(config: Config): EslintReactHooksResult {
  const selection = selectReactRules(config.react.ruleset);
  const result = runTemporaryEslint(
    config,
    "react-hooks",
    reactHooksConfig(managedPackageJsonUrl(), selection.rules, config.react.additionalEffectHooks),
    "react-hooks/",
    true,
  );
  return {
    ...result,
    version: toolPackageVersion("eslint-plugin-react-hooks"),
    ruleset: config.react.ruleset,
    selected_preset: selection.preset,
    enabled_rules: enabledReactRules(selection.rules),
    complete: result.ran && !result.messages.some((message) => message.rule_id === "eslint/parser") && selectedFilesEvaluated(config, result.evaluated_files, /\.[jt]sx?$/),
  };
}

function runTemporaryEslint(
  config: Config,
  name: string,
  configText: string,
  rulePrefix: string | undefined,
  preferManaged: boolean,
) {
  const toolingDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-eslint-${name}-${process.pid}-`));
  const configPath = path.join(toolingDir, `eslint-${name}.config.mjs`);
  try {
    fs.writeFileSync(configPath, configText, "utf8");
    return runEslint(config, configPath, rulePrefix, preferManaged);
  } finally {
    fs.rmSync(toolingDir, { recursive: true, force: true });
  }
}

function runEslint(config: Config, configPath: string, rulePrefix: string | undefined, preferManaged: boolean) {
  const args = [
    "--config",
    configPath,
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    ...existingRelativeRoots(config),
  ];
  const parse = (stdout: string) => normalizeEslintReport(parseJson(stdout), config, rulePrefix);
  return runToolAdapter<{ messages: EslintMessage[]; evaluated_files: string[] }>(
    config,
    "eslint",
    preferManaged ? "managed eslint executable was not found" : "eslint executable was not found",
    { messages: [], evaluated_files: [] },
    (executable) => parse(runLocalTool(executable, args, toolRunOptions(config))),
    (error) => recoverToolJson(error, "[", parse),
    preferManaged,
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
  files: ["**/*.{ts,tsx,mts,cts}"],
  ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
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

function jsxA11yConfig(toolPackageUrl: string, config: Config): string {
  const settings = {
    components: config.accessibility.components,
    ...(config.accessibility.polymorphicPropName
      ? { polymorphicPropName: config.accessibility.polymorphicPropName }
      : {}),
  };
  return `import { createRequire } from "node:module";
const toolRequire = createRequire(${JSON.stringify(toolPackageUrl)});
const jsxA11y = toolRequire("eslint-plugin-jsx-a11y");
const tsParser = toolRequire("@typescript-eslint/parser");
export default [{
  files: ["**/*.{js,jsx,ts,tsx}"], ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module" } },
  plugins: { "jsx-a11y": jsxA11y },
  settings: { "jsx-a11y": ${JSON.stringify(settings)} },
  rules: jsxA11y.configs.recommended.rules
}];
`;
}

function reactHooksConfig(toolPackageUrl: string, rules: Record<string, unknown>, additionalEffectHooks: string | null): string {
  return `import { createRequire } from "node:module";
const toolRequire = createRequire(${JSON.stringify(toolPackageUrl)});
const reactHooks = toolRequire("eslint-plugin-react-hooks");
const tsParser = toolRequire("@typescript-eslint/parser");
export default [{
  files: ["**/*.{js,jsx,ts,tsx}"], ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module" } },
  plugins: { "react-hooks": reactHooks },
  settings: { "react-hooks": ${JSON.stringify(additionalEffectHooks ? { additionalEffectHooks } : {})} },
  rules: ${JSON.stringify(rules)}
}];
`;
}

const eslintReport = arrayOf(shape({ filePath: string, messages: arrayOf(shape({ message: string })) }));
function normalizeEslintReport(value: unknown, config: Config, rulePrefix?: string) {
  if (!eslintReport(value)) throw new Error("Invalid ESLint report");
  const selected = new Set(discoverSourceFiles(config).map((file) => relativePath(config.projectRoot, file)));
  const messages = value.flatMap((result) => result.messages.flatMap((message): EslintMessage[] => {
    if (![1, 2].includes(Number(message.severity))) throw new Error("Invalid ESLint diagnostic");
    const ruleId = typeof message.ruleId === "string" ? message.ruleId : null;
    const fatal = message.fatal === true;
    if (rulePrefix ? !ruleId?.startsWith(rulePrefix) && !fatal : !ruleId && !fatal) return [];
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
  const evaluated_files = value.filter((file) => !file.messages.some((message) => message.fatal || !message.ruleId))
    .map((file) => relativePath(config.projectRoot, file.filePath)).filter((file) => selected.has(file)).sort();
  return { messages, evaluated_files };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function relativePath(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}
