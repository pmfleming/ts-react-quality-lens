import fs from "node:fs";
import { artifactReferences } from "./artifact-references.js";
import path from "node:path";
import { withPublicationLock, writeArtifact } from "./writer.js";
import type { AuditArtifact, Config } from "./types.js";

/** Native readers/writers cooperate on the lock; arbitrary filesystem readers do not. */
export function stagedAudit(config: Config, run: (staged: Config) => AuditArtifact): AuditArtifact {
  return withPublicationLock(config, () => {
    const directory = fs.mkdtempSync(path.join(config.outputDir, ".audit-run-"));
    const marker = path.join(config.outputDir, ".publication-incomplete");
    try {
      const staged = { ...config, outputDir: directory };
      const measured = run(staged);
      const names = measured.confidence.inputs_unchanged === false ? [] : fs.readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "audit.json").sort();
      const result = writeArtifact(staged, "audit.json", { ...measured, artifact_inputs: artifactReferences(directory, names) });
      publish(directory, config.outputDir, [...names, "audit.json"], marker);
      return result;
    } finally {
      // Failed recovery or process death leaves the marker and backup for an operator.
      if (!fs.existsSync(marker)) fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

function publish(directory: string, destination: string, names: string[], marker: string): void {
  const backup = path.join(directory, ".previous");
  fs.mkdirSync(backup);
  for (const name of names) {
    const previous = path.join(destination, name);
    if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`Invalid staged artifact: ${name}`);
    if (fs.existsSync(previous)) {
      if (!fs.lstatSync(previous).isFile()) throw new Error(`Existing artifact is not a regular file: ${name}`);
      fs.copyFileSync(previous, path.join(backup, name));
    }
  }
  fs.writeFileSync(marker, JSON.stringify({ directory, artifacts: names, previous: fs.readdirSync(backup).sort() }));
  try {
    for (const name of names) fs.renameSync(path.join(directory, name), path.join(destination, name));
    fs.unlinkSync(marker);
  } catch (error) {
    try {
      for (const name of names) {
        const previous = path.join(backup, name);
        if (fs.existsSync(previous)) fs.renameSync(previous, path.join(destination, name));
        else fs.rmSync(path.join(destination, name), { force: true });
      }
      fs.unlinkSync(marker);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Publication and recovery failed; retained backup in ${backup}`);
    }
    throw error;
  }
}
