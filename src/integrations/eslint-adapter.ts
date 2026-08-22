import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageJsonUrl } from "../package-root.js";
import type { Config, EslintAccessibilityResult, EslintMessage, EslintReactHooksResult, EslintTypeAwareResult, ReactRuleset } from "../types.js";
import {
  existingRelativeRoots,
  managedPackageJsonUrl,
  runLocalTool,
  runToolAdapter,
  toolAvailable,
  toolPackageVersion,
  toolRunOptions,
  type ExecError,
} from "./tool-runner.js";

export function runTypedLint(config: Config): EslintTypeAwareResult {
  const version = toolPackageVersion("@typescript-eslint/eslint-plugin");
  if (!config.tsconfig || !fs.existsSync(config.tsconfig)) {
    return {
      available: toolAvailable(config.projectRoot, "eslint", true),
      ran: false,
      reason: "typed lint requires a readable tsconfig",
      messages: [],
      version,
      complete: false,
      duration_ms: 0,
    };
  }
  const result = runTemporaryEslint(config, "typed", typedLintConfig(config), undefined, true);
  return {
    ...result,
    version,
    complete: result.ran && !result.messages.some((message) => message.rule_id === "eslint/parser"),
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
  const projectPackageUrl = packageJsonUrl(config.projectRoot);
  const result = runTemporaryEslint(
    config,
    "react-hooks",
    reactHooksConfig(projectPackageUrl, managedPackageJsonUrl(), config.react.ruleset),
    "react-hooks/",
    false,
  );
  return {
    ...result,
    version: toolPackageVersion("eslint-plugin-react-hooks"),
    ruleset: config.react.ruleset,
    complete: result.ran && !result.messages.some((message) => message.rule_id === "eslint/parser"),
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
  const parse = (stdout: string) => ({ messages: normalizeEslintMessages(JSON.parse(stdout), config, rulePrefix) });
  return runToolAdapter(
    config,
    "eslint",
    preferManaged ? "managed eslint executable was not found" : "eslint executable was not found",
    { messages: [] },
    (executable) => parse(runLocalTool(executable, args, toolRunOptions(config))),
    (error: ExecError) => recoverEslint(error, parse),
    preferManaged,
  );
}

function recoverEslint(error: ExecError, parse: (stdout: string) => { messages: EslintMessage[] }) {
  const stdout = String(error.stdout ?? "");
  return stdout.trim().startsWith("[") ? parse(stdout) : null;
}


function typedLintConfig(config: Config): string {
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
      project: [${JSON.stringify(config.tsconfig)}],
      tsconfigRootDir: ${JSON.stringify(config.projectRoot)},
      ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module"
    }
  },
  plugins: { "@typescript-eslint": plugin },
  rules: {
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    "@typescript-eslint/no-unsafe-type-assertion": "warn",
    "@typescript-eslint/ban-ts-comment": ["error", {
      "ts-check": false, "ts-expect-error": "allow-with-description",
      "ts-ignore": true, "ts-nocheck": true, "minimumDescriptionLength": 3
    }]
  }
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

function reactHooksConfig(projectPackageUrl: string, toolPackageUrl: string, ruleset: ReactRuleset): string {
  const classicRules = {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  };
  return `import { createRequire } from "node:module";
const projectRequire = createRequire(${JSON.stringify(projectPackageUrl)});
const toolRequire = createRequire(${JSON.stringify(toolPackageUrl)});
function requireTool(name) { try { return projectRequire(name); } catch { return toolRequire(name); } }
const reactHooks = requireTool("eslint-plugin-react-hooks");
const tsParser = requireTool("@typescript-eslint/parser");
const classicRules = ${JSON.stringify(classicRules)};
const recommendedRules = reactHooks.configs?.flat?.["recommended-latest"]?.rules
  ?? reactHooks.configs?.["recommended-latest"]?.rules
  ?? reactHooks.configs?.flat?.recommended?.rules
  ?? classicRules;
export default [{
  files: ["**/*.{js,jsx,ts,tsx}"], ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module" } },
  plugins: { "react-hooks": reactHooks },
  rules: ${ruleset === "recommended-v2" ? "recommendedRules" : "classicRules"}
}];
`;
}

function normalizeEslintMessages(
  results: Array<{
    filePath: string;
    messages: Array<{
      ruleId?: string | null;
      fatal?: boolean;
      line?: number;
      column?: number;
      severity?: number;
      message: string;
    }>;
  }>,
  config: Config,
  rulePrefix?: string,
): EslintMessage[] {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => rulePrefix
        ? Boolean(message.ruleId?.startsWith(rulePrefix) || message.fatal)
        : Boolean(message.ruleId || message.fatal))
      .map((message) => ({
        file: relativePath(config.projectRoot, result.filePath),
        line: message.line ?? null,
        column: message.column ?? null,
        rule_id: message.ruleId ?? "eslint/parser",
        severity: message.severity === 2 ? "error" : "warning",
        message: message.message,
      })),
  );
}

function relativePath(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, "/");
}
