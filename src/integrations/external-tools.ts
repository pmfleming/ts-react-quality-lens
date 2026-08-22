import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  existingRelativeRoots,
  runLocalTool,
  runToolAdapter,
  toolRunOptions,
  toolPackageVersion,
} from "./tool-runner.js";
import { isRecord, parseJson } from "../collections.js";
import { readPackageJson } from "../entrypoints.js";
import type { Config, DependencyCruiserModule, DependencyCruiserResult, JscpdDuplicate, JscpdResult, KnipIssueEntry, KnipResult } from "../types.js";

export function runDependencyCruiser(config: Config): DependencyCruiserResult {
  const args = [
    "--no-config",
    "--output-type",
    "json",
    "--output-to",
    "-",
    "--progress",
    "none",
    ...existingRelativeRoots(config),
  ];
  return runToolAdapter(
    config,
    "depcruise",
    "dependency-cruiser executable was not found",
    { modules: [], summary: {} },
    (executable) => {
      const stdout = runLocalTool(executable, args, toolRunOptions(config));
      const json = parseJson(stdout);
      return isRecord(json)
        ? {
            modules: Array.isArray(json.modules) ? json.modules.filter(isDependencyCruiserModule) : [],
            summary: isRecord(json.summary) ? json.summary : {},
          }
        : { modules: [], summary: {} };
    },
  );
}

export function runKnip(config: Config): KnipResult {
  const version = toolPackageVersion("knip");
  const exclusions = knipExclusions(config.projectRoot);
  if (!config.cleanup.knip) {
    return {
      available: version !== null,
      ran: false,
      reason: "Knip cleanup analysis is disabled",
      duration_ms: 0,
      issues: [],
      version,
      complete: false,
      excluded_dependencies: exclusions.dependencies,
      exclusions_complete: exclusions.complete,
    };
  }
  const args = [
    "--reporter",
    "json",
    "--no-exit-code",
    "--no-progress",
    "--no-config-hints",
    "--no-tag-hints",
    ...(config.cleanup.production ? ["--production"] : []),
  ];
  const result = runToolAdapter(
    config,
    "knip",
    "Knip executable was not found",
    { issues: [] },
    (executable) => {
      const json = parseJson(runLocalTool(executable, args, toolRunOptions(config)));
      return { issues: isRecord(json) && Array.isArray(json.issues) ? json.issues.filter(isKnipIssueEntry) : [] };
    },
    null,
    true,
  );
  return {
    ...result,
    version,
    complete: result.ran,
    excluded_dependencies: exclusions.dependencies,
    exclusions_complete: exclusions.complete,
  };
}

function knipExclusions(root: string): { dependencies: string[]; complete: boolean } {
  const dependencies = new Set(readPackageJson(path.join(root, "package.json"))?.knip?.ignoreDependencies ?? []);
  const staticConfigs = ["knip.json", ".knip.json"].map((name) => readKnipExclusions(path.join(root, name)));
  for (const config of staticConfigs) for (const dependency of config.dependencies) dependencies.add(dependency);
  const dynamicConfig = ["knip.jsonc", ".knip.jsonc", "knip.config.js", "knip.config.cjs", "knip.config.mjs", "knip.config.ts"]
    .some((name) => fs.existsSync(path.join(root, name)));
  return { dependencies: [...dependencies].sort(), complete: !dynamicConfig && staticConfigs.every((config) => config.complete) };
}

function readKnipExclusions(file: string): { dependencies: string[]; complete: boolean } {
  if (!fs.existsSync(file)) return { dependencies: [], complete: true };
  try {
    const value = parseJson(fs.readFileSync(file, "utf8"));
    const dependencies = isRecord(value) && Array.isArray(value.ignoreDependencies)
      ? value.ignoreDependencies.filter((dependency): dependency is string => typeof dependency === "string")
      : [];
    return { dependencies, complete: true };
  } catch {
    return { dependencies: [], complete: false };
  }
}

export function runJscpd(config: Config): JscpdResult {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-jscpd-${process.pid}-`));
  try {
    return runToolAdapter(
      config,
      "jscpd",
      "jscpd executable was not found",
      { duplicates: [], statistics: {} },
      (executable) => {
        runLocalTool(executable, jscpdArgs(config, outputDir), toolRunOptions(config));
        const reportPath = path.join(outputDir, "jscpd-report.json");
        const report = fs.existsSync(reportPath) ? parseJson(fs.readFileSync(reportPath, "utf8")) : {};
        return isRecord(report)
          ? {
              duplicates: Array.isArray(report.duplicates) ? report.duplicates.filter(isJscpdDuplicate) : [],
              statistics: isRecord(report.statistics) ? report.statistics : {},
            }
          : { duplicates: [], statistics: {} };
      },
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function isDependencyCruiserModule(value: unknown): value is DependencyCruiserModule {
  return isRecord(value) && (value.source === undefined || typeof value.source === "string");
}

function isKnipIssueEntry(value: unknown): value is KnipIssueEntry {
  return isRecord(value) && typeof value.file === "string";
}

function isJscpdDuplicate(value: unknown): value is JscpdDuplicate {
  return isRecord(value);
}

function jscpdArgs(config: Config, outputDir: string): string[] {
  return [
    "--reporters",
    "json",
    "--output",
    outputDir,
    "--min-lines",
    "5",
    "--min-tokens",
    "45",
    "--format",
    "typescript,javascript,tsx,jsx",
    "--exitCode",
    "0",
    ...existingRelativeRoots(config),
  ];
}

