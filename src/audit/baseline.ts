import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord, parseJson } from "../collections.js";
import { loadConfig } from "../config.js";
import { createAnalysisContext } from "../analysis-context.js";
import { analysisIdentity, artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import { isWireEvidence, type WireEvidence } from "../wire-evidence.js";
import { arrayOf } from "../validation.js";
import { collectFindings, runAuditMeasurements } from "./findings.js";
import type { AnalysisIdentity, Artifact, AuditFinding, Config } from "../types.js";

type BaseSnapshot = {
  findingIds: Set<string>;
  analysisIdentity: AnalysisIdentity;
  run: Extract<WireEvidence, { kind: "run" }>;
};

/** A missing snapshot always carries the reason, so an incomplete audit can say why comparison failed. */
export type BaseSnapshotResult = { snapshot: BaseSnapshot; reason: null } | { snapshot: null; reason: string };

function unavailable(reason: string): BaseSnapshotResult {
  return { snapshot: null, reason };
}

export function readBaselineIds(file: string | null | undefined): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    return baselineIds(parseJson(fs.readFileSync(file, "utf8")));
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
): BaseSnapshotResult {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-react-quality-lens-audit-base-"));
  try {
    addWorktree(config, tempRoot, base);
    return measureBaseSnapshot(config, tempRoot, command, baselineIds);
  } catch (error) {
    return unavailable(`base measurement failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000));
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
): BaseSnapshotResult {
  const repositoryRoot = childProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: config.projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const baseConfigPath = path.join(tempRoot, path.relative(repositoryRoot, config.configPath));
  const baseProjectRoot = path.join(tempRoot, path.relative(repositoryRoot, config.projectRoot));
  // Reuse installed dependencies without running install scripts in the snapshot.
  for (const root of new Set([repositoryRoot, config.projectRoot])) {
    const installed = path.join(root, "node_modules");
    const target = path.join(tempRoot, path.relative(repositoryRoot, root), "node_modules");
    if (fs.existsSync(installed) && !fs.existsSync(target)) fs.symlinkSync(installed, target, "junction");
  }
  if (!fs.existsSync(baseConfigPath)) return unavailable(`the lens config does not exist at the base (${path.relative(tempRoot, baseConfigPath)})`);
  const baseConfig = loadConfig(baseConfigPath);
  if (path.resolve(baseConfig.projectRoot) !== path.resolve(baseProjectRoot)) return unavailable("the base config resolves to a different project root");
  baseConfig.outputDir = path.join(tempRoot, "target", "audit-base-analysis");
  baseConfig.cache.enabled = false;
  const context = createAnalysisContext(baseConfig);
  runAuditMeasurements(baseConfig, command, context, false);
  const findings = collectFindings(baseConfig, {
    changedFiles: [],
    changedLines: new Map(),
    baselineIds,
    includeAll: true,
  });
  const snapshot: Artifact = writeArtifact(baseConfig, "base_snapshot.json", {
    ...artifactBase(baseConfig, "audit.baseline", command, { complete: true }, sourceSetHash(context.project())),
    summary: { findings: findings.length },
  });
  if (!arrayOf(isWireEvidence)(snapshot.evidence_contract)) return unavailable("the base snapshot has invalid run evidence");
  const run = snapshot.evidence_contract.find((entry) => entry.kind === "run");
  if (!run) return unavailable("the base snapshot has no run evidence");
  return {
    snapshot: { findingIds: new Set(findings.map((finding) => finding.id)), analysisIdentity: analysisIdentity(baseConfig), run },
    reason: null,
  };
}

function addWorktree(config: Config, tempRoot: string, base: string): void {
  // stderr is captured so a failed checkout explains itself in the audit's incomplete reason.
  childProcess.execFileSync("git", ["worktree", "add", "--detach", "--quiet", tempRoot, base], {
    cwd: config.projectRoot,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
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
