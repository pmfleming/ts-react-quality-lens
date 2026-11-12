import { randomUUID } from "node:crypto";
import path from "node:path";
import { artifactReferences } from "./artifact-references.js";
import { parseJson } from "./collections.js";
import { artifactNames, artifactText, newGeneration, openDatabase, pruneGenerations, putArtifact, transaction, usingStore, withStore } from "./store.js";
import { writeArtifact } from "./writer.js";
import type { AuditArtifact, Config } from "./types.js";

/** Measure in memory, then atomically replace the whole generation in a short write transaction. */
export function stagedAudit(config: Config, run: (staged: Config) => AuditArtifact): AuditArtifact {
  const directory = path.join(config.outputDir, `.audit-${randomUUID()}`);
  return usingStore(directory, openDatabase(":memory:"), (staging) => {
    const staged = { ...config, outputDir: directory };
    const measured = run(staged);
    const names = measured.confidence.inputs_unchanged === false ? [] : artifactNames(staging).filter((name) => name !== "audit.json");
    const result = writeArtifact(staged, "audit.json", { ...measured, artifact_inputs: artifactReferences(staging, names) });
    withStore(config.outputDir, (db) => transaction(db, () => {
      const generation = newGeneration(db);
      for (const name of [...names, "audit.json"]) {
        const text = artifactText(staging, name);
        if (text === null) throw new Error(`Missing staged artifact: ${name}`);
        putArtifact(db, name, parseJson(text), generation);
      }
      pruneGenerations(db);
    }));
    return result;
  });
}
