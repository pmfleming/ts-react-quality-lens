import fs from "node:fs";
import path from "node:path";
import { enrichArtifactFindings } from "./actions.js";
import { isRecord, parseJson } from "./collections.js";
import type { Artifact, Config } from "./types.js";

export function writeArtifact(config: Config, artifactName: string, value: unknown): string {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const target = path.join(config.outputDir, artifactName);
  const temp = path.join(
    config.outputDir,
    `.${artifactName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(enrichArtifactFindings(config, value), null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return target;
}

export function readArtifact(config: Config, artifactName: string): Artifact | null {
  const target = path.join(config.outputDir, artifactName);
  if (!fs.existsSync(target)) return null;
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
  return isRecord(value) &&
    typeof value.schema_version === "string" &&
    typeof value.task_id === "string" &&
    isRecord(value.project) &&
    isRecord(value.provenance) &&
    isRecord(value.confidence) &&
    isRecord(value.summary);
}
