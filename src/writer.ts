import fs from "node:fs";
import { validateArtifactReferences } from "./artifact-references.js";
import { attachArtifactEvidence, validNativeEvidence } from "./artifact-evidence.js";
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
  return withPublicationLock(config, () => {
    const normalized = enrichArtifactFindings(config, value);
    const enriched = isArtifactEnvelope(normalized) ? attachArtifactEvidence(config, normalized) : normalized;
    const target = path.join(config.outputDir, artifactName);
    const temp = path.join(config.outputDir, `.${artifactName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      fs.writeFileSync(temp, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
      fs.renameSync(temp, target);
      return enriched;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  });
}

/** Cooperative publication only; an interrupted batch requires explicit recovery. */
export function withPublicationLock<T>(config: Config, run: () => T): T {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const lock = path.join(config.outputDir, ".audit.lock");
  const fd = fs.openSync(lock, "wx");
  try {
    if (fs.existsSync(path.join(config.outputDir, ".publication-incomplete"))) throw new Error("Interrupted evidence publication requires recovery.");
    return run();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function assertReadable(config: Config): void {
  if ([".audit.lock", ".publication-incomplete"].some((name) => fs.existsSync(path.join(config.outputDir, name)))) {
    throw new Error("Evidence publication is active or interrupted; refusing possibly mixed artifacts.");
  }
}

function validateArtifactName(artifactName: string): void {
  if (artifactName !== path.basename(artifactName) || /[\\:]/.test(artifactName) || !artifactName.endsWith(".json")) {
    throw new Error("Artifact names must be JSON filenames without path components.");
  }
}

export function readArtifact(config: Config, artifactName: string): Artifact | null {
  validateArtifactName(artifactName);
  assertReadable(config);
  const target = path.join(config.outputDir, artifactName);
  if (!fs.existsSync(target)) return null;
  const relative = path.relative(fs.realpathSync(config.outputDir), fs.realpathSync(target));
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Artifact resolves outside the output directory.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = parseJson(fs.readFileSync(target, "utf8"));
      assertReadable(config);
      if (!isArtifact(value, config)) return null;
      if (value.task_id === "audit") validateArtifactReferences(config.outputDir, value.artifact_inputs);
      assertReadable(config);
      return value;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return null;
}

function isArtifact(value: unknown, config: Config): value is Artifact {
  return isArtifactEnvelope(value) && validNativeEvidence(value, config);
}

function isArtifactEnvelope(value: unknown): value is Artifact {
  return isRecord(value) && validWireExtension(value.evidence_contract) &&
    typeof value.schema_version === "string" &&
    typeof value.task_id === "string" &&
    isRecord(value.project) &&
    isRecord(value.provenance) &&
    isRecord(value.confidence) &&
    isRecord(value.summary);
}
