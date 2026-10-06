import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./collections.js";
import { deterministicEvidence } from "./deterministic-evidence.js";

export type ArtifactReference = { file: string; sha256: string; semantic_sha256: string; run_id: string | null };
export const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export function artifactReferences(directory: string, names: string[]): ArtifactReference[] {
  return names.map((file) => {
    const bytes = fs.readFileSync(path.join(directory, file), "utf8");
    const value = JSON.parse(bytes);
    return { file, sha256: digest(bytes), semantic_sha256: digest(JSON.stringify(deterministicEvidence(value))),
      run_id: typeof value.provenance?.run_id === "string" ? value.provenance.run_id : null };
  });
}

/** Audit references bind the entire consumed generation, not just whichever file is opened first. */
export function validateArtifactReferences(directory: string, references: unknown): void {
  if (references === undefined) return; // legacy artifacts do not claim generation integrity
  if (!Array.isArray(references)) throw new Error("Invalid audit artifact references");
  const seen = new Set<string>();
  for (const item of references) {
    if (!isRecord(item) || typeof item.file !== "string" || item.file === "audit.json" ||
        path.basename(item.file) !== item.file || /[\\:]/.test(item.file) || !item.file.endsWith(".json") || seen.has(item.file) ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.semantic_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.semantic_sha256) ||
        !(item.run_id === null || typeof item.run_id === "string")) throw new Error("Invalid audit artifact reference");
    seen.add(item.file);
    const target = path.join(directory, item.file);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`Missing audit generation member: ${item.file}`);
    const bytes = fs.readFileSync(target, "utf8");
    if (digest(bytes) !== item.sha256) throw new Error(`Mixed audit generation: ${item.file}`);
    const value = JSON.parse(bytes);
    if ((value.provenance?.run_id ?? null) !== item.run_id || digest(JSON.stringify(deterministicEvidence(value))) !== item.semantic_sha256) {
      throw new Error(`Invalid audit generation evidence: ${item.file}`);
    }
  }
}
