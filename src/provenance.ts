import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toolPackageVersion } from "./integrations/tool-runner.js";
import { LENS_NAME, SCHEMA_VERSION } from "./tasks.js";
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
      ...(sourceSetHash ? { source_set_hash: sourceSetHash } : {}),
    },
    analysis_identity: analysisIdentity(config),
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
    dependency_cruiser: toolPackageVersion("dependency-cruiser"),
    jscpd: toolPackageVersion("jscpd"),
  };
  const configHash = configClosureHash(config);
  const rulesets = {
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
  const files = [
    ["config", config.configPath],
    ["tsconfig", config.tsconfig],
    ["package", path.join(config.projectRoot, "package.json")],
    ...["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
      .map((name): [string, string] => [`lock:${name}`, path.join(config.projectRoot, name)]),
  ] satisfies Array<[string, string | null]>;
  for (const [label, file] of files) {
    hash.update(label);
    hash.update("\0");
    hash.update(file && fs.existsSync(file) ? fs.readFileSync(file) : "missing");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function sourceSetHash(project: Pick<ProjectAnalysis, "sourceFiles">): string {
  const hash = crypto.createHash("sha256");
  for (const file of [...project.sourceFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.text);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
