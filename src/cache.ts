import fs from "node:fs";
import path from "node:path";
import { sourceSetHash } from "./provenance.js";
import type { Config, ProjectAnalysis } from "./types.js";

type CacheMetadata = {
  source_set_hash: string;
  source_files: number;
  measured_at: string;
};

export function updateAnalysisCache(config: Config, project: Omit<ProjectAnalysis, "cache">): ProjectAnalysis["cache"] {
  if (!config.cache.enabled) {
    return { enabled: false, status: "disabled", file: null, previous_source_set_hash: null };
  }
  const file = path.join(config.cache.dir, "analysis.json");
  const currentHash = sourceSetHash(project);
  const previous = readCache(file);
  const status = previous?.source_set_hash === currentHash ? "hit" : "miss";
  fs.mkdirSync(config.cache.dir, { recursive: true });
  const metadata: CacheMetadata = {
    source_set_hash: currentHash,
    source_files: project.sourceFiles.length,
    measured_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return {
    enabled: true,
    status,
    file,
    previous_source_set_hash: previous?.source_set_hash ?? null,
  };
}

function readCache(file: string): CacheMetadata | null {
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value.source_set_hash === "string" ? value as CacheMetadata : null;
  } catch {
    return null;
  }
}
