import fs from "node:fs";
import path from "node:path";

export function writeArtifact(config, artifactName, value) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const target = path.join(config.outputDir, artifactName);
  const temp = path.join(
    config.outputDir,
    `.${artifactName}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return target;
}

export function readArtifact(config, artifactName) {
  const target = path.join(config.outputDir, artifactName);
  if (!fs.existsSync(target)) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return null;
}
