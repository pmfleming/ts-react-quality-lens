import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { executablePackageVersion, toolPackageVersion } from "./integrations/tool-runner.js";
import { LENS_NAME, SCHEMA_VERSION } from "./tasks.js";
import { discoverWorkspaces } from "./workspaces.js";
import { gitHistoryFingerprint } from "./history.js";
import type { AnalysisIdentity, Confidence, Config, ProjectAnalysis } from "./types.js";

function provenance(command: string, sourceType = "static") {
  return {
    lens: LENS_NAME,
    schema_version: SCHEMA_VERSION,
    command,
    host: os.hostname(),
    measured_at: new Date().toISOString(),
    source_type: sourceType,
  };
}

export function artifactBase(
  config: Config,
  taskId: string,
  command: string,
  confidence: Confidence,
  sourceSetHash: string | null = null,
) {
  const identity = analysisIdentity(config);
  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    project: {
      name: config.projectName,
      root: config.projectRoot,
      framework: config.framework,
      package_manager: config.packageManager,
      test_runner: config.testRunner,
    },
    provenance: {
      ...provenance(command),
      ...(sourceSetHash ? {
        source_set_hash: sourceSetHash,
        input_set_hash: taskInputHash(config, taskId, sourceSetHash, identity),
      } : {}),
    },
    analysis_identity: identity,
    confidence,
  };
}

export function analysisIdentity(config: Config): AnalysisIdentity {
  const integrationVersions = {
    typescript_eslint: toolPackageVersion("@typescript-eslint/eslint-plugin"),
    react_hooks: toolPackageVersion("eslint-plugin-react-hooks"),
    jsx_a11y: toolPackageVersion("eslint-plugin-jsx-a11y"),
    knip: toolPackageVersion("knip"),
    publint: toolPackageVersion("publint"),
    are_the_types_wrong: toolPackageVersion("@arethetypeswrong/cli"),
    dependency_cruiser: executablePackageVersion(config, "depcruise", "dependency-cruiser"),
    jscpd: executablePackageVersion(config, "jscpd", "jscpd"),
  };
  const configHash = configClosureHash(config);
  const rulesets = {
    builtin: "tsrqlens-analysis-v2",
    finding_identity: "semantic-occurrence-v1",
    sarif: "namespaced-fingerprint-occurrence-v2",
    test_mapping: "compiler-imports-v1",
    import_resolution: "path-aliases-v2",
    architecture: "risk-model-v3",
    typed_lint: "tsrqlens-typescript-recommended-v1",
    react: config.react.ruleset,
    accessibility: "jsx-a11y-recommended-v1",
    cleanup: config.cleanup.knip ? "knip-normalized-v1" : "builtin-cleanup-v1",
  };
  const identity = {
    schema_version: SCHEMA_VERSION,
    compiler_api_version: toolPackageVersion("typescript"),
    config_closure_hash: configHash,
    rulesets,
    integration_versions: integrationVersions,
  };
  return {
    id: `sha256:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    ...identity,
  };
}

function configClosureHash(config: Config): string {
  const hash = crypto.createHash("sha256");
  const files = new Map<string, string | null>([
    ["config", config.configPath],
    ["tsconfig", config.tsconfig],
    ["package", path.join(config.projectRoot, "package.json")],
    ...["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
      .map((name): [string, string] => [`lock:${name}`, path.join(config.projectRoot, name)]),
  ]);
  for (const file of workspaceConfigFiles(config)) {
    files.set(`workspace:${path.relative(config.projectRoot, file).replace(/\\/g, "/")}`, file);
  }
  const parsed = new Set<string>();
  for (const [label, file] of [...files]) {
    if (!file || (label !== "tsconfig" && !label.startsWith("workspace:")) || path.basename(file) === "package.json") continue;
    collectCompilerConfigInputs(file, parsed, files, config.projectRoot);
  }
  hash.update(JSON.stringify(effectiveSettings(config)));
  for (const [label, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(label);
    hash.update("\0");
    hash.update(file && fs.existsSync(file) ? fs.readFileSync(file) : "missing");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function workspaceConfigFiles(config: Config): string[] {
  const discovery = discoverWorkspaces(config);
  return [...new Set(discovery.records.flatMap((workspace) => [
    path.join(config.projectRoot, workspace.root, "package.json"),
    ...workspace.tsconfigs.map((tsconfig) => path.join(config.projectRoot, tsconfig)),
  ]))];
}

export function sourceSetHash(
  project: Pick<ProjectAnalysis, "sourceFiles"> & Partial<Pick<ProjectAnalysis, "testFiles">> & { tsProject?: { input_files?: string[] } },
): string {
  const files = new Map([...project.sourceFiles, ...(project.testFiles ?? [])].map((file) => [file.relativePath, file]));
  const measured = new Set([...files.values()].map((file) => path.resolve(file.path)));
  const first = project.sourceFiles[0];
  const root = first ? first.path.slice(0, -first.relativePath.length) : ".";
  const dependencies = (project.tsProject?.input_files ?? []).filter((file) => !measured.has(file)).map((file) => ({
    relativePath: `compiler-input:${path.relative(root, file).replace(/\\/g, "/")}`,
    text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "missing",
  }));
  return contentHash([...files.values(), ...dependencies]);
}

export function taskInputHash(config: Config, taskId: string, sourceHash: string, identity = analysisIdentity(config)): string {
  const files = taskId === "quality.runtime"
    ? Object.values(config.runtimeInputs)
    : taskId === "quality.sarif" ? config.sarifInputs.map((input) => input.path)
    : taskId === "quality.type_health" ? [config.typeCoverage.baseline]
    : taskId === "map.architecture" ? Object.values(config.performanceInputs) : [];
  return contentHash(files.filter((file): file is string => file !== null).map((file) => ({
    relativePath: path.relative(config.projectRoot, file),
    text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "missing",
  })), [sourceHash, identity.id, taskId, ...(taskId === "quality.locality_dynamic" ? [gitHistoryFingerprint(config)] : [])]);
}

function collectCompilerConfigInputs(
  file: string,
  seen: Set<string>,
  files: Map<string, string | null>,
  root: string,
): void {
  if (seen.has(file)) return;
  seen.add(file);
  ts.getParsedCommandLineOfConfigFile(file, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
    readFile: (input) => {
      files.set(`compiler:${path.relative(root, input).replace(/\\/g, "/")}`, input);
      return ts.sys.readFile(input);
    },
  });
}

function effectiveSettings(config: Config): unknown {
  const {
    configPath: _configPath, configDir: _configDir, projectRoot: _projectRoot,
    outputDir: _outputDir, cache: _cache, audit: _audit, raw: _raw, ...settings
  } = config;
  return normalizeSettings(settings, config.projectRoot);
}

function normalizeSettings(value: unknown, root: string): unknown {
  if (typeof value === "string" && path.isAbsolute(value)) return path.relative(root, value).replace(/\\/g, "/");
  if (Array.isArray(value)) return value.map((item) => normalizeSettings(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizeSettings(item, root)]));
  return value;
}

export function contentHash(files: Array<{ relativePath: string; text: string }>, seeds: string[] = []): string {
  const hash = crypto.createHash("sha256");
  for (const seed of seeds) hash.update(seed).update("\0");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath).update("\0").update(file.text).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
