import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "./collections.js";
import { arrayOf, nullable, shape, string } from "./validation.js";
import { deterministicEvidence } from "./deterministic-evidence.js";

export type ArtifactReference = { file: string; sha256: string; semantic_sha256: string; run_id: string | null };
const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const hash = (value: unknown): value is string => string(value) && /^[a-f0-9]{64}$/.test(value);
const reference = arrayOf(shape({ file: string, sha256: hash, semantic_sha256: hash, run_id: nullable(string) }));
const run = shape({ provenance: shape({ run_id: string }) });

function describe(bytes: string, file: string): ArtifactReference {
  const value = parseJson(bytes);
  return { file, sha256: digest(bytes), semantic_sha256: digest(JSON.stringify(deterministicEvidence(value))),
    run_id: run(value) ? value.provenance.run_id : null };
}
export function artifactReferences(directory: string, names: string[]): ArtifactReference[] {
  return names.map((file) => describe(fs.readFileSync(path.join(directory, file), "utf8"), file));
}

/** Audit references bind the entire consumed generation, not just whichever file is opened first. */
export function validateArtifactReferences(directory: string, references: unknown): void {
  if (references === undefined) return; // legacy artifacts do not claim generation integrity
  if (!reference(references)) throw new Error("Invalid audit artifact references");
  const seen = new Set<string>();
  for (const item of references) {
    if (item.file === "audit.json" || path.basename(item.file) !== item.file || /[\\:]/.test(item.file) || !item.file.endsWith(".json") || seen.has(item.file)) {
      throw new Error("Invalid audit artifact reference");
    }
    seen.add(item.file);
    const target = path.join(directory, item.file);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`Missing audit generation member: ${item.file}`);
    const bytes = fs.readFileSync(target, "utf8");
    if (digest(bytes) !== item.sha256) throw new Error(`Mixed audit generation: ${item.file}`);
    const actual = describe(bytes, item.file);
    if (actual.run_id !== item.run_id || actual.semantic_sha256 !== item.semantic_sha256) throw new Error(`Invalid audit generation evidence: ${item.file}`);
  }
}
