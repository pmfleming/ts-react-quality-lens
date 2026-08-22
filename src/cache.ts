import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { parseJson } from "./collections.js";
import { analysisIdentity, contentHash, sourceSetHash } from "./provenance.js";
import type { Config, ProjectAnalysis, SourceFileRecord, TypedModuleRecord } from "./types.js";

const CACHE_FORMAT = 2;

type CachePayload = {
  cache_format: number;
  key: string;
  project: Omit<ProjectAnalysis, "cache" | "tsProject"> & {
    tsProject: Omit<ProjectAnalysis["tsProject"], "modules"> & {
      modules: Array<[string, TypedModuleRecord]>;
    };
  };
};

export function readAnalysisCache(
  config: Config,
  sourceFiles: SourceFileRecord[],
  testFiles: SourceFileRecord[],
): ProjectAnalysis | null {
  if (!config.cache.enabled) return null;
  const file = cacheFile(config);
  if (!fs.existsSync(file)) return null;
  try {
    const payload = parseJson(fs.readFileSync(file, "utf8"));
    if (!isCachePayload(payload) || payload.key !== analysisCacheKey(config, sourceFiles, testFiles)) return null;
    return hydrateProject(payload.project, file);
  } catch {
    return null;
  }
}

export function writeAnalysisCache(
  config: Config,
  project: Omit<ProjectAnalysis, "cache">,
): ProjectAnalysis["cache"] {
  if (!config.cache.enabled) return disabledCache();
  const file = cacheFile(config);
  if (!cacheableProject(config, project)) {
    return { enabled: true, status: "miss", reused: false, file, previous_source_set_hash: null };
  }
  const payload: CachePayload = {
    cache_format: CACHE_FORMAT,
    key: analysisCacheKey(config, project.sourceFiles, project.testFiles),
    project: {
      ...project,
      tsProject: {
        ...project.tsProject,
        modules: [...project.tsProject.modules.entries()],
      },
    },
  };
  fs.mkdirSync(config.cache.dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(temp, file);
  return {
    enabled: true,
    status: "miss",
    reused: false,
    file,
    previous_source_set_hash: null,
  };
}

function hydrateProject(project: CachePayload["project"], file: string): ProjectAnalysis {
  const modules = project.modules;
  for (const module of modules) {
    const scriptKind = module.file.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : module.file.endsWith(".jsx") ? ts.ScriptKind.JSX : module.file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const ast = ts.createSourceFile(module.file, module.text, ts.ScriptTarget.Latest, true, scriptKind);
    Object.defineProperty(module, "astSourceFile", { value: ast, enumerable: false });
  }
  return {
    ...project,
    modules,
    tsProject: {
      ...project.tsProject,
      modules: new Map(project.tsProject.modules),
    },
    cache: {
      enabled: true,
      status: "hit",
      reused: true,
      file,
      previous_source_set_hash: sourceSetHash(project),
    },
  };
}

function analysisCacheKey(config: Config, sourceFiles: SourceFileRecord[], testFiles: SourceFileRecord[]): string {
  return contentHash([...sourceFiles, ...testFiles], [String(CACHE_FORMAT), analysisIdentity(config).id]);
}

function cacheableProject(config: Config, project: Omit<ProjectAnalysis, "cache">): boolean {
  if (!project.sourceFiles.length) return false;
  if (config.tsconfig && !project.tsProject.loaded) return false;
  return project.workspaces
    .filter((workspace) => workspace.tsconfigs.length > 0)
    .every((workspace) => workspace.project_loaded);
}

function cacheFile(config: Config): string {
  return path.join(config.cache.dir, "analysis-v2.json");
}

function disabledCache(): ProjectAnalysis["cache"] {
  return { enabled: false, status: "disabled", reused: false, file: null, previous_source_set_hash: null };
}

function isCachePayload(value: unknown): value is CachePayload {
  if (!value || typeof value !== "object") return false;
  if (!("cache_format" in value) || !("key" in value) || !("project" in value)) return false;
  return value.cache_format === CACHE_FORMAT && typeof value.key === "string" && Boolean(value.project);
}
