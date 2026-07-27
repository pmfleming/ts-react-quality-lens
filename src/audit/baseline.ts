import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../collections.js";
import { loadConfig } from "../config.js";
import { createAnalysisContext } from "../analysis-context.js";
import { collectFindings, runAuditMeasurements } from "./findings.js";
import type { AuditFinding, Config } from "../types.js";

export function readBaselineIds(file: string | null | undefined): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    return baselineIds(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}

export function writeBaseline(file: string, findings: AuditFinding[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ids = [...new Set(findings.map((finding) => finding.id))].sort();
  fs.writeFileSync(file, `${JSON.stringify({ findings: ids }, null, 2)}\n`, "utf8");
}

export function baseSnapshotFindingIds(
  config: Config,
  base: string,
  command: string,
  baselineIds: Set<string>,
): Set<string> | null {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-react-quality-lens-audit-base-"));
  try {
    addWorktree(config, tempRoot, base);
    return measureBaseSnapshot(config, tempRoot, command, baselineIds);
  } catch {
    return null;
  } finally {
    removeWorktree(config, tempRoot);
  }
}

function baselineIds(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string"));
  if (!isRecord(value) || !Array.isArray(value.findings)) return new Set();
  return new Set(value.findings.flatMap(findingId));
}

function findingId(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return isRecord(value) && typeof value.id === "string" ? [value.id] : [];
}

function measureBaseSnapshot(
  config: Config,
  tempRoot: string,
  command: string,
  baselineIds: Set<string>,
): Set<string> | null {
  const baseConfigPath = path.join(tempRoot, path.relative(config.projectRoot, config.configPath));
  if (!fs.existsSync(baseConfigPath)) return null;
  const baseConfig = loadConfig(baseConfigPath);
  baseConfig.outputDir = path.join(tempRoot, "target", "audit-base-analysis");
  baseConfig.cache.enabled = false;
  runAuditMeasurements(baseConfig, command, createAnalysisContext(baseConfig), false);
  const findings = collectFindings(baseConfig, {
    changedFiles: [],
    changedLines: new Map(),
    baselineIds,
    includeAll: true,
  });
  return new Set(findings.map((finding) => finding.id));
}

function addWorktree(config: Config, tempRoot: string, base: string): void {
  childProcess.execFileSync("git", ["worktree", "add", "--detach", "--quiet", tempRoot, base], {
    cwd: config.projectRoot,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function removeWorktree(config: Config, tempRoot: string): void {
  try {
    childProcess.execFileSync("git", ["worktree", "remove", "--force", tempRoot], {
      cwd: config.projectRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
