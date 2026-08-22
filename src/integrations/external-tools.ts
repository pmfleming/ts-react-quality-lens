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
import type { Config, DependencyCruiserResult, JscpdResult, KnipResult } from "../types.js";

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
      const json = JSON.parse(stdout);
      return { modules: json.modules ?? [], summary: json.summary ?? {} };
    },
  );
}

export function runKnip(config: Config): KnipResult {
  const version = toolPackageVersion("knip");
  if (!config.cleanup.knip) {
    return {
      available: version !== null,
      ran: false,
      reason: "Knip cleanup analysis is disabled",
      duration_ms: 0,
      issues: [],
      version,
      complete: false,
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
      const json = JSON.parse(runLocalTool(executable, args, toolRunOptions(config)));
      return { issues: Array.isArray(json.issues) ? json.issues : [] };
    },
    null,
    true,
  );
  return { ...result, version, complete: result.ran };
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
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {};
        return { duplicates: report.duplicates ?? [], statistics: report.statistics ?? {} };
      },
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
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

