import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  existingRelativeRoots,
  runLocalTool,
  runToolAdapter,
  toolRunOptions,
} from "./tool-runner.js";
import type { Config, DependencyCruiserResult, JscpdResult } from "../types.js";

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

