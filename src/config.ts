import fs from "node:fs";
import path from "node:path";
import type {
  Config,
  Confidence,
  ConfidenceSignal,
  JsonValue,
  LayerRule,
  PackageJson,
  PackageManagerDetection,
  PathAliasRule,
  PerformanceInputConfig,
  RawConfig,
} from "./types.js";

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  "target",
  "out",
  "*.snap",
  "*.generated.*",
  "*.gen.*",
  "*.d.ts",
];

const FRAMEWORK_RULES = [
  { name: "next", deps: ["next"], files: ["next.config.js"] },
  { name: "remix", deps: ["@remix-run/react", "@remix-run/node"] },
  { name: "expo", deps: ["expo"] },
  { name: "astro-react", deps: ["astro"] },
  { name: "vite", deps: ["vite"], files: ["vite.config.ts"] },
  { name: "react-router", deps: ["react-router", "react-router-dom"] },
  { name: "react", deps: ["react"] },
];

const TEST_RUNNER_RULES = [
  { name: "vitest", deps: ["vitest"], scriptIncludes: ["vitest"] },
  { name: "jest", deps: ["jest"], scriptIncludes: ["jest"] },
  { name: "playwright", deps: ["@playwright/test"], files: ["playwright.config.ts"] },
  { name: "cypress", deps: ["cypress"], files: ["cypress.config.ts"] },
  { name: "node", scriptIncludes: ["node --test"] },
];

const PACKAGE_MANAGER_RULES = [
  { name: "pnpm", files: ["pnpm-lock.yaml"] },
  { name: "yarn", files: ["yarn.lock"] },
  { name: "bun", files: ["bun.lockb", "bun.lock"] },
  { name: "npm", files: ["package-lock.json"] },
];

const CONFIG_KEYS = new Set([
  "project_name",
  "project_root",
  "source_roots",
  "test_roots",
  "output_dir",
  "tsconfig",
  "package_manager",
  "framework",
  "test_runner",
  "test_command",
  "exclude",
  "layer_rules",
  "performance_inputs",
]);

export function loadConfig(configArg?: string | null): Config {
  const configPath = path.resolve(configArg ?? "ts-react-quality-lens.config.json");
  const configDir = path.dirname(configPath);
  const rawConfig = fs.existsSync(configPath) ? validateRawConfig(JSON.parse(fs.readFileSync(configPath, "utf8"))) : {};
  const root = resolveFromConfig(configDir, rawConfig.project_root ?? ".");
  const sourceRoots = normalizeRoots(configDir, root, rawConfig.source_roots, [
    "src",
    "app",
    "pages",
    "components",
    "packages",
    "libs",
  ]);
  const testRoots = normalizeRoots(configDir, root, rawConfig.test_roots, [
    "src",
    "test",
    "tests",
    "__tests__",
    "e2e",
    "cypress",
  ]);
  const outputDir = resolveFromConfig(configDir, rawConfig.output_dir ?? "target/analysis");
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const packageManager = rawConfig.package_manager
    ? { name: rawConfig.package_manager, detected: rawConfig.package_manager !== "unknown" }
    : detectPackageManager(root);
  const tsconfig = resolveOptional(configDir, rawConfig.tsconfig) ?? autoPath(root, "tsconfig.json");

  return {
    configPath,
    configDir,
    projectName: rawConfig.project_name ?? packageJson?.name ?? path.basename(root),
    projectRoot: root,
    sourceRoots,
    testRoots,
    outputDir,
    tsconfig,
    packageManager: packageManager.name,
    packageManagerDetected: packageManager.detected,
    framework: normalizeAuto(rawConfig.framework, () => detectFramework(root, packageJson)),
    testRunner: normalizeAuto(rawConfig.test_runner, () => detectTestRunner(root, packageJson)),
    testCommand: rawConfig.test_command ?? packageJson?.scripts?.test ?? null,
    exclude: [...DEFAULT_EXCLUDES, ...(rawConfig.exclude ?? [])],
    layerRules: normalizeLayerRules(rawConfig.layer_rules),
    performanceInputs: normalizePerformanceInputs(configDir, rawConfig.performance_inputs),
    pathAliases: tsconfig ? readPathAliases(tsconfig) : [],
    raw: rawConfig,
  };
}

export function createConfidence(config: Config, extra: Record<string, JsonValue> = {}): Confidence {
  const base: Record<string, JsonValue> = {
    source_roots_exist: config.sourceRoots.some((root) => fs.existsSync(root)),
    tsconfig_found: Boolean(config.tsconfig && fs.existsSync(config.tsconfig)),
    package_json_found: fs.existsSync(path.join(config.projectRoot, "package.json")),
    package_manager_detected: config.packageManagerDetected,
    framework_detected: config.framework !== "unknown",
    test_runner_detected: config.testRunner !== "unknown",
    git_history_available: fs.existsSync(path.join(config.projectRoot, ".git")),
    excludes_applied: config.exclude.length > 0,
    type_information_available: false,
    dependencies_installed: fs.existsSync(path.join(config.projectRoot, "node_modules")),
    ...extra,
  };
  const requiredInputs = stringArray(base.required_inputs) ?? [
    "source_roots_exist",
    "package_json_found",
    "dependencies_installed",
  ];
  const observedInputs = stringArray(base.observed_inputs) ?? Object.entries(base)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const missingInput = stringArray(base.missing_input) ?? requiredInputs.filter((key) => base[key] === false || base[key] === null);
  const staleInput = stringArray(base.stale_input) ?? [];
  const unsupportedPattern = confidenceSignals(base.unsupported_pattern);

  return {
    ...base,
    complete: missingInput.length === 0 && staleInput.length === 0,
    partial: missingInput.length > 0 || staleInput.length > 0 || unsupportedPattern.length > 0,
    confidence_scope: typeof base.confidence_scope === "string" ? base.confidence_scope : "project_static_analysis",
    required_inputs: requiredInputs,
    observed_inputs: observedInputs,
    missing_input: missingInput,
    stale_input: staleInput,
    unsupported_pattern: unsupportedPattern,
  };
}

function stringArray(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function confidenceSignals(value: JsonValue | undefined): ConfidenceSignal[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ConfidenceSignal => isRecord(item) && typeof item.kind === "string");
}

function validateRawConfig(value: unknown): RawConfig {
  if (!isRecord(value)) throw new Error("Config must be a JSON object.");
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`Unknown config key "${key}".`);
  }
  validateString(value, "project_name", errors);
  validateString(value, "project_root", errors);
  validateStringArray(value, "source_roots", errors);
  validateStringArray(value, "test_roots", errors);
  validateString(value, "output_dir", errors);
  validateString(value, "tsconfig", errors);
  validateString(value, "package_manager", errors);
  validateString(value, "framework", errors);
  validateString(value, "test_runner", errors);
  validateNullableString(value, "test_command", errors);
  validateStringArray(value, "exclude", errors);
  validateLayerRules(value, "layer_rules", errors);
  validatePerformanceInputs(value, "performance_inputs", errors);
  if (errors.length) throw new Error(`Invalid config:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return value as RawConfig;
}

function validateString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && typeof record[key] !== "string") errors.push(`"${key}" must be a string.`);
}

function validateNullableString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "string") {
    errors.push(`"${key}" must be a string or null.`);
  }
}

function validateStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] === undefined) return;
  if (!Array.isArray(record[key]) || !record[key].every((item) => typeof item === "string")) {
    errors.push(`"${key}" must be an array of strings.`);
  }
}

function validateLayerRules(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`"${key}" must be an array.`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.layer !== "string" || !Array.isArray(item.patterns)) {
      errors.push(`"${key}[${index}]" must include "layer" and string array "patterns".`);
    } else if (!item.patterns.every((pattern) => typeof pattern === "string")) {
      errors.push(`"${key}[${index}].patterns" must be an array of strings.`);
    }
  }
}

function validatePerformanceInputs(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`"${key}" must be an object.`);
    return;
  }
  validateString(value, "bundle_stats", errors);
  validateString(value, "render_costs", errors);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveFromConfig(configDir: string, value: string): string {
  return path.resolve(configDir, value);
}

function resolveOptional(configDir: string, value?: string): string | null {
  return value ? path.resolve(configDir, value) : null;
}

function normalizeRoots(configDir: string, projectRoot: string, configured: string[] | undefined, defaults: string[]): string[] {
  const roots = configured ?? defaults;
  return roots.map((root) => {
    const resolved = path.resolve(configDir, root);
    if (fs.existsSync(resolved)) return resolved;
    return path.resolve(projectRoot, root);
  });
}

function readPackageJson(packageJsonPath: string): PackageJson | null {
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function autoPath(root: string, name: string): string | null {
  const candidate = path.join(root, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function detectPackageManager(root: string): PackageManagerDetection {
  const match = matchingRule(PACKAGE_MANAGER_RULES, root, new Set());
  if (match) return { name: match.name, detected: true };
  return fs.existsSync(path.join(root, "package.json"))
    ? { name: "npm", detected: false }
    : { name: "unknown", detected: false };
}

function normalizeAuto(value: string | undefined, detector: () => string): string {
  if (!value || value === "auto") return detector();
  return value;
}

function detectFramework(root: string, packageJson: PackageJson | null): string {
  const deps = dependencyNames(packageJson);
  return matchingRule(FRAMEWORK_RULES, root, deps)?.name ?? "unknown";
}

function detectTestRunner(root: string, packageJson: PackageJson | null): string {
  const deps = dependencyNames(packageJson);
  const scripts = Object.values(packageJson?.scripts ?? {}).join(" ");
  return matchingRule(TEST_RUNNER_RULES, root, deps, scripts)?.name ?? "unknown";
}

function matchingRule(
  rules: Array<{ name: string; deps?: string[]; files?: string[]; scriptIncludes?: string[] }>,
  root: string,
  deps: Set<string>,
  scripts = "",
): { name: string } | undefined {
  return rules.find((rule) => {
    const hasDependency = (rule.deps ?? []).some((dependency) => deps.has(dependency));
    const hasFile = (rule.files ?? []).some((file) => fs.existsSync(path.join(root, file)));
    const hasScript = (rule.scriptIncludes ?? []).some((snippet) => scripts.includes(snippet));
    return hasDependency || hasFile || hasScript;
  });
}

function dependencyNames(packageJson: PackageJson | null): Set<string> {
  return new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
    ...Object.keys(packageJson?.peerDependencies ?? {}),
    ...Object.keys(packageJson?.optionalDependencies ?? {}),
  ]);
}

function normalizeLayerRules(value: LayerRule[] | undefined): LayerRule[] {
  return value?.length
    ? value
    : [
        { layer: "route", patterns: ["app/**", "pages/**", "routes/**"] },
        { layer: "feature", patterns: ["features/**", "src/features/**"] },
        { layer: "ui", patterns: ["components/**", "src/components/**", "**/*.tsx", "**/*.jsx"] },
        { layer: "hook", patterns: ["hooks/**", "src/hooks/**", "**/hooks/**", "**/use*.ts", "**/use*.tsx"] },
        { layer: "lib", patterns: ["lib/**", "src/lib/**", "utils/**", "src/utils/**"] },
        { layer: "core", patterns: ["src/**"] },
      ];
}

function normalizePerformanceInputs(configDir: string, value: PerformanceInputConfig | undefined): Config["performanceInputs"] {
  return {
    bundleStats: value?.bundle_stats ? path.resolve(configDir, value.bundle_stats) : null,
    renderCosts: value?.render_costs ? path.resolve(configDir, value.render_costs) : null,
  };
}

function readPathAliases(tsconfig: string): PathAliasRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(tsconfig, "utf8"));
    const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : {};
    const paths = isRecord(compilerOptions.paths) ? compilerOptions.paths : {};
    const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
    const baseDir = path.resolve(path.dirname(tsconfig), baseUrl);
    return Object.entries(paths)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"))
      .map(([pattern, replacements]) => ({
        pattern,
        replacements: replacements.map((replacement) => path.resolve(baseDir, replacement)),
      }));
  } catch {
    return [];
  }
}
