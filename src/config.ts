import fs from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isRecord } from "./collections.js";
import { readPackageJson } from "./entrypoints.js";
import { packageRootFrom } from "./package-root.js";
import type {
  AuditConfig,
  Config,
  Confidence,
  ConfidenceSignal,
  JsonValue,
  LayerRule,
  PackageJson,
  PackageManagerDetection,
  PathAliasRule,
  PerformanceInputConfig,
  PolicyCheck,
  PolicyConfig,
  PolicyProfile,
  PublicApiConfig,
  RawConfig,
  ReactConfig,
  SuppressionConfig,
} from "./types.js";

type JsonCommentScanner = {
  text: string;
  index: number;
  inString: boolean;
  escaped: boolean;
};

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

const getConfigValidator = (() => {
  let validator: ValidateFunction<RawConfig> | null = null;
  return (): ValidateFunction<RawConfig> => {
    if (validator) return validator;
    const schemaPath = path.join(packageRoot(), "ts-react-quality-lens.config.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    validator = new Ajv2020({ allErrors: true, strict: false }).compile<RawConfig>(schema);
    return validator;
  };
})();

export function loadConfig(configArg?: string | null): Config {
  const configPath = path.resolve(configArg ?? "ts-react-quality-lens.config.json");
  const configDir = path.dirname(configPath);
  const rawConfig = fs.existsSync(configPath) ? validateRawConfig(parseJsonConfig(fs.readFileSync(configPath, "utf8"))) : {};
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
    publicApi: normalizePublicApi(rawConfig.public_api),
    cache: normalizeCache(outputDir, rawConfig.cache),
    react: normalizeReact(rawConfig.react),
    policy: normalizePolicy(rawConfig.policy, Boolean(tsconfig), Boolean(rawConfig.test_command ?? packageJson?.scripts?.test)),
    suppressions: normalizeSuppressions(rawConfig.suppressions),
    audit: normalizeAuditConfig(configDir, rawConfig.audit),
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
  const validate = getConfigValidator();
  if (validate(value)) return value;
  const errors = (validate.errors ?? []).map(configErrorMessage);
  throw new Error(`Invalid config:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

function configErrorMessage(error: ErrorObject): string {
  if (error.keyword === "additionalProperties") return `Unknown config key "${String(error.params.additionalProperty)}".`;
  return `${error.instancePath || "/"} ${error.message ?? "is invalid"}.`;
}

function parseJsonConfig(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function stripJsonComments(text: string): string {
  const scanner: JsonCommentScanner = { text, index: 0, inString: false, escaped: false };
  const chunks: string[] = [];
  while (scanner.index < scanner.text.length) chunks.push(readJsoncChunk(scanner));
  return chunks.join("");
}

function readJsoncChunk(scanner: JsonCommentScanner): string {
  const char = scanner.text.charAt(scanner.index);
  const next = scanner.text.charAt(scanner.index + 1);
  scanner.index += 1;
  if (scanner.inString) return readStringChunk(scanner, char);
  if (char === "\"") return enterString(scanner, char);
  if (char === "/" && next === "/") return skipJsoncLineComment(scanner);
  if (char === "/" && next === "*") return skipJsoncBlockComment(scanner);
  return char;
}

function readStringChunk(scanner: JsonCommentScanner, char: string): string {
  const state = nextStringState(char, scanner.escaped, scanner.inString);
  scanner.escaped = state.escaped;
  scanner.inString = state.inString;
  return char;
}

function enterString(scanner: JsonCommentScanner, char: string): string {
  scanner.inString = true;
  return char;
}

function nextStringState(char: string, escaped: boolean, inString: boolean): Pick<JsonCommentScanner, "escaped" | "inString"> {
  const nextEscaped = char === "\\" && !escaped;
  return {
    escaped: char === "\\" ? nextEscaped : false,
    inString: char === "\"" && !escaped ? false : inString,
  };
}

function skipJsoncLineComment(scanner: JsonCommentScanner): string {
  scanner.index = skipLineComment(scanner.text, scanner.index - 1) + 1;
  return "\n";
}

function skipJsoncBlockComment(scanner: JsonCommentScanner): string {
  scanner.index = skipBlockComment(scanner.text, scanner.index - 1) + 1;
  return " ";
}

function skipLineComment(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && text[cursor] !== "\n") cursor += 1;
  return cursor;
}

function skipBlockComment(text: string, index: number): number {
  let cursor = index + 2;
  while (cursor < text.length && !(text[cursor] === "*" && text[cursor + 1] === "/")) cursor += 1;
  return cursor + 1;
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

function normalizePublicApi(value: PublicApiConfig | undefined): Config["publicApi"] {
  return {
    entry: value?.entry ?? [],
    exports: value?.exports ?? [],
  };
}

function normalizeCache(outputDir: string, value: RawConfig["cache"] | undefined): Config["cache"] {
  return {
    enabled: value?.enabled !== false,
    dir: path.join(outputDir, ".cache"),
  };
}

function normalizeReact(value: ReactConfig | undefined): Config["react"] {
  return { ruleset: value?.ruleset ?? "recommended-v2" };
}

function normalizePolicy(value: PolicyConfig | undefined, hasTsconfig: boolean, hasTestCommand: boolean): Config["policy"] {
  const profile: PolicyProfile = value?.profile ?? "baseline";
  const compiler: PolicyCheck[] = ["compiler"];
  const typed: PolicyCheck[] = ["compiler", "typed-lint"];
  const tests: PolicyCheck[] = ["tests"];
  const react: PolicyCheck[] = ["react-hooks"];
  const defaults: PolicyCheck[] = [
    ...(hasTsconfig ? compiler : []),
    ...(profile === "baseline" ? [] : typed),
    ...(hasTestCommand ? tests : []),
    ...(profile === "react" ? react : []),
  ];
  return {
    profile,
    requiredChecks: [...new Set(value?.required_checks ?? defaults)],
  };
}

function normalizeSuppressions(value: SuppressionConfig[] | undefined): SuppressionConfig[] {
  return value ?? [];
}

function normalizeAuditConfig(configDir: string, value: AuditConfig | undefined): Config["audit"] {
  return {
    base: value?.base ?? null,
    changedSince: value?.changed_since ?? null,
    gate: value?.gate ?? "new-only",
    baseline: value?.baseline ? path.resolve(configDir, value.baseline) : null,
  };
}

function readPathAliases(tsconfig: string): PathAliasRule[] {
  try {
    const parsed = parseJsonConfig(fs.readFileSync(tsconfig, "utf8"));
    const root = isRecord(parsed) ? parsed : {};
    const compilerOptions = isRecord(root.compilerOptions) ? root.compilerOptions : {};
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

function packageRoot(): string {
  return packageRootFrom(import.meta.url);
}
