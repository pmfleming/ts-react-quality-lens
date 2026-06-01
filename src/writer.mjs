import fs from "node:fs";
import path from "node:path";

export function writeArtifact(config, artifactName, value) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const target = path.join(config.outputDir, artifactName);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

export function readArtifact(config, artifactName) {
  const target = path.join(config.outputDir, artifactName);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, "utf8"));
}
