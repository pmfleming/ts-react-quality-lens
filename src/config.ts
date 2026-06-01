import fs from "node:fs";
import path from "node:path";

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
  { name: "npm", files: ["package-lock.json", "package.json"] },
];

export function loadConfig(configArg) {
  const configPath = path.resolve(configArg ?? "ts-react-quality-lens.config.json");
  const configDir = path.dirname(configPath);
  const rawConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
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

  return {
    configPath,
    configDir,
    projectName: rawConfig.project_name ?? packageJson?.name ?? path.basename(root),
    projectRoot: root,
    sourceRoots,
    testRoots,
    outputDir,
    tsconfig: resolveOptional(configDir, rawConfig.tsconfig) ?? autoPath(root, "tsconfig.json"),
    packageManager: rawConfig.package_manager ?? detectPackageManager(root),
    framework: normalizeAuto(rawConfig.framework, () => detectFramework(root, packageJson)),
    testRunner: normalizeAuto(rawConfig.test_runner, () => detectTestRunner(root, packageJson)),
    testCommand: rawConfig.test_command ?? packageJson?.scripts?.test ?? null,
    exclude: [...DEFAULT_EXCLUDES, ...(rawConfig.exclude ?? [])],
    raw: rawConfig,
  };
}

export function createConfidence(config, extra = {}) {
  return {
    source_roots_exist: config.sourceRoots.some((root) => fs.existsSync(root)),
    tsconfig_found: Boolean(config.tsconfig && fs.existsSync(config.tsconfig)),
    package_json_found: fs.existsSync(path.join(config.projectRoot, "package.json")),
    package_manager_detected: config.packageManager !== "unknown",
    framework_detected: config.framework !== "unknown",
    test_runner_detected: config.testRunner !== "unknown",
    git_history_available: fs.existsSync(path.join(config.projectRoot, ".git")),
    excludes_applied: config.exclude.length > 0,
    type_information_available: false,
    dependencies_installed: fs.existsSync(path.join(config.projectRoot, "node_modules")),
    ...extra,
  };
}

function resolveFromConfig(configDir, value) {
  return path.resolve(configDir, value);
}

function resolveOptional(configDir, value) {
  return value ? path.resolve(configDir, value) : null;
}

function normalizeRoots(configDir, projectRoot, configured, defaults) {
  const roots = configured ?? defaults;
  return roots.map((root) => {
    const resolved = path.resolve(configDir, root);
    if (fs.existsSync(resolved)) return resolved;
    return path.resolve(projectRoot, root);
  });
}

function readPackageJson(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function autoPath(root, name) {
  const candidate = path.join(root, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function detectPackageManager(root) {
  return matchingRule(PACKAGE_MANAGER_RULES, root, new Set())?.name ?? "unknown";
}

function normalizeAuto(value, detector) {
  if (!value || value === "auto") return detector();
  return value;
}

function detectFramework(root, packageJson) {
  const deps = dependencyNames(packageJson);
  return matchingRule(FRAMEWORK_RULES, root, deps)?.name ?? "unknown";
}

function detectTestRunner(root, packageJson) {
  const deps = dependencyNames(packageJson);
  const scripts = Object.values(packageJson?.scripts ?? {}).join(" ");
  return matchingRule(TEST_RUNNER_RULES, root, deps, scripts)?.name ?? "unknown";
}

function matchingRule(rules, root, deps, scripts = "") {
  return rules.find((rule) => {
    const hasDependency = (rule.deps ?? []).some((dependency) => deps.has(dependency));
    const hasFile = (rule.files ?? []).some((file) => fs.existsSync(path.join(root, file)));
    const hasScript = (rule.scriptIncludes ?? []).some((snippet) => scripts.includes(snippet));
    return hasDependency || hasFile || hasScript;
  });
}

function dependencyNames(packageJson) {
  return new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
    ...Object.keys(packageJson?.peerDependencies ?? {}),
    ...Object.keys(packageJson?.optionalDependencies ?? {}),
  ]);
}
