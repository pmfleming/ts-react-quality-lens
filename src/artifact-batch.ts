import fs from "node:fs";
import path from "node:path";
import { writeArtifact } from "./writer.js";
import type { AuditArtifact, Config } from "./types.js";

/** Isolate producers and serialize publication. A failed run leaves previous evidence intact. */
export function stagedAudit(config: Config, run: (staged: Config) => AuditArtifact): AuditArtifact {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const lock = path.join(config.outputDir, ".audit.lock");
  const fd = fs.openSync(lock, "wx");
  let directory: string | undefined;
  try {
    directory = fs.mkdtempSync(path.join(config.outputDir, ".audit-run-"));
    const result = run({ ...config, outputDir: directory });
    if (result.confidence.inputs_unchanged !== false) {
      for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "audit.json")) {
        fs.renameSync(path.join(directory, name), path.join(config.outputDir, name));
      }
    }
    // Publish the verdict last. Consumers still validate artifact input identity;
    // this is not a lock-free, multi-file transaction for arbitrary readers.
    writeArtifact(config, "audit.json", result);
    return result;
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
