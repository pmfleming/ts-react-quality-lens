import path from "node:path";
import { validateArtifactReferences } from "./artifact-references.js";
import { isArtifactEnvelope } from "./producer-payload.js";
import { attachArtifactEvidence, validNativeEvidence } from "./artifact-evidence.js";
import { validWireExtension } from "./wire-evidence.js";
import { enrichArtifactFindings } from "./actions.js";
import { isRecord, parseJson } from "./collections.js";
import { artifactText, newGeneration, pruneGenerations, putArtifact, transaction, withStore } from "./store.js";
import type { Artifact, Config } from "./types.js";

export function writeArtifact<T extends Artifact>(config: Config, artifactName: string, value: T): T;
export function writeArtifact(config: Config, artifactName: string, value: unknown): unknown;
export function writeArtifact(config: Config, artifactName: string, value: unknown): unknown {
  validateArtifactName(artifactName);
  if (isRecord(value) && !validWireExtension(value.evidence_contract)) throw new Error("Invalid cross-lens evidence contract");
  const normalized = enrichArtifactFindings(config, value);
  const enriched = isArtifactEnvelope(normalized) ? attachArtifactEvidence(config, normalized) : normalized;
  withStore(config.outputDir, (db) => transaction(db, () => {
    putArtifact(db, artifactName, enriched, newGeneration(db));
    pruneGenerations(db);
  }));
  return enriched;
}

function validateArtifactName(artifactName: string): void {
  if (artifactName !== path.basename(artifactName) || /[\\:]/.test(artifactName) || !artifactName.endsWith(".json")) {
    throw new Error("Artifact names must be JSON resource names without path components.");
  }
}

export function readArtifact(config: Config, artifactName: string): Artifact | null {
  validateArtifactName(artifactName);
  return withStore(config.outputDir, (db) => transaction(db, () => {
    const text = artifactText(db, artifactName);
    if (text === null) return null;
    const value = parseJson(text);
    if (!isArtifactEnvelope(value) || !validNativeEvidence(value, config)) return null;
    if (value.task_id === "audit") validateArtifactReferences(db, value.artifact_inputs);
    return value;
  }, false));
}
