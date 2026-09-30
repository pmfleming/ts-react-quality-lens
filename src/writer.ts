import fs from "node:fs";
import { validWireExtension } from "./wire-evidence.js";
import path from "node:path";
import { enrichArtifactFindings } from "./actions.js";
import { isRecord, parseJson } from "./collections.js";
import type { Artifact, Config } from "./types.js";

export function writeArtifact<T extends Artifact>(config: Config, artifactName: string, value: T): T;
export function writeArtifact(config: Config, artifactName: string, value: unknown): unknown;
export function writeArtifact(config: Config, artifactName: string, value: unknown): unknown {
  validateArtifactName(artifactName);
  if (isRecord(value) && !validWireExtension(value.evidence_contract)) throw new Error("Invalid cross-lens evidence contract");
  const enriched = enrichArtifactFindings(config, value);
  fs.mkdirSync(config.outputDir, { recursive: true });
  const target = path.join(config.outputDir, artifactName);
  const temp = path.join(
    config.outputDir,
    `.${artifactName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temp, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
    return enriched;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function validateArtifactName(artifactName: string): void {
  if (artifactName !== path.basename(artifactName) || artifactName.includes("\\") || !artifactName.endsWith(".json")) {
    throw new Error("Artifact names must be JSON filenames without path components.");
  }
}

export function readArtifact(config: Config, artifactName: string): Artifact | null {
  validateArtifactName(artifactName);
  const target = path.join(config.outputDir, artifactName);
  if (!fs.existsSync(target)) return null;
  const relative = path.relative(fs.realpathSync(config.outputDir), fs.realpathSync(target));
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Artifact resolves outside the output directory.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = parseJson(fs.readFileSync(target, "utf8"));
      return isArtifact(value) ? value : null;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return null;
}

function isArtifact(value: unknown): value is Artifact {
  return isRecord(value) && validWireExtension(value.evidence_contract) &&
    typeof value.schema_version === "string" &&
    typeof value.task_id === "string" &&
    isRecord(value.project) &&
    isRecord(value.provenance) &&
    isRecord(value.confidence) &&
    isRecord(value.summary);
}
