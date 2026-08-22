import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as tsTypes from "typescript";
import { readPackageJson } from "./entrypoints.js";
import { toPosix } from "./files.js";
import type { Config, PackageJson, SourceFileRecord, WorkspaceRecord } from "./types.js";

const require = createRequire(import.meta.url);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "target", "coverage", ".next", ".turbo"]);

type WorkspaceDiscovery = {
  records: WorkspaceRecord[];
  tsconfigPaths: Array<{ workspaceId: string; path: string }>;
};

export function discoverWorkspaces(config: Config, sourceFiles: SourceFileRecord[] = []): WorkspaceDiscovery {
  const rootManifest = readPackageJson(path.join(config.projectRoot, "package.json"));
  const patterns = config.workspaces.enabled ? workspacePatterns(config, rootManifest) : [];
  const packageDirectories = patterns.length ? matchingPackageDirectories(config.projectRoot, patterns) : [];
  const roots = [config.projectRoot, ...packageDirectories].filter((value, index, values) => values.indexOf(value) === index);
  const records = roots.map((root) => workspaceRecord(config, root, sourceFiles));
  const tsconfigPaths = records.flatMap((record) =>
    record.tsconfigs.map((tsconfig) => ({ workspaceId: record.id, path: path.resolve(config.projectRoot, tsconfig) })));
  return { records, tsconfigPaths };
}

export function workspaceForFile(workspaces: WorkspaceRecord[], file: string): WorkspaceRecord {
  const normalized = toPosix(file);
  return [...workspaces]
    .sort((left, right) => right.root.length - left.root.length)
    .find((workspace) => workspace.root === "." || normalized === workspace.root || normalized.startsWith(`${workspace.root}/`))
    ?? workspaces[0]
    ?? {
      id: ".",
      name: ".",
      root: ".",
      private: true,
      framework: "unknown",
      policy_profile: "baseline",
      tsconfigs: [],
      source_files: 0,
      project_loaded: false,
      project_reason: "workspace discovery did not produce a root workspace",
    };
}

export function workspacePackageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function workspaceRecord(config: Config, root: string, sourceFiles: SourceFileRecord[]): WorkspaceRecord {
  const relativeRoot = toPosix(path.relative(config.projectRoot, root)) || ".";
  const manifest = readPackageJson(path.join(root, "package.json"));
  const name = manifest?.name ?? (relativeRoot === "." ? config.projectName : relativeRoot);
  const override = config.workspaces.overrides.find((item) =>
    item.workspace === name || item.workspace === relativeRoot);
  const tsconfigs = discoverTsconfigClosure(config, root).map((file) => toPosix(path.relative(config.projectRoot, file)));
  return {
    id: name,
    name,
    root: relativeRoot,
    private: manifest?.private === true,
    framework: override?.framework ?? detectWorkspaceFramework(manifest),
    policy_profile: override?.policy_profile ?? config.policy.profile,
    tsconfigs,
    source_files: sourceFiles.filter((file) => fileInWorkspace(file.relativePath, relativeRoot)).length,
    project_loaded: false,
    project_reason: tsconfigs.length ? "TypeScript project has not been loaded" : "workspace has no tsconfig",
  };
}

function workspacePatterns(config: Config, manifest: PackageJson | null): string[] {
  if (config.workspaces.patterns.length) return config.workspaces.patterns;
  const packagePatterns = Array.isArray(manifest?.workspaces)
    ? manifest.workspaces
    : manifest?.workspaces?.packages ?? [];
  if (packagePatterns.length) return packagePatterns;
  return pnpmWorkspacePatterns(config.projectRoot);
}

function pnpmWorkspacePatterns(root: string): string[] {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = /^\s*-\s*["']?([^"'#]+)["']?\s*(?:#.*)?$/.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
}

function matchingPackageDirectories(root: string, patterns: string[]): string[] {
  const manifests: string[] = [];
  collectPackageDirectories(root, manifests, true);
  const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  return manifests.filter((directory) => {
    const relative = toPosix(path.relative(root, directory));
    return positives.some((pattern) => globMatches(relative, pattern)) && !negatives.some((pattern) => globMatches(relative, pattern));
  });
}

function collectPackageDirectories(root: string, result: string[], isRoot: boolean): void {
  if (!fs.existsSync(root)) return;
  if (!isRoot && fs.existsSync(path.join(root, "package.json"))) result.push(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
    collectPackageDirectories(path.join(root, entry.name), result, false);
  }
}

function globMatches(value: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  const expression = normalized
    .split("**")
    .map((chunk) => chunk
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function discoverTsconfigClosure(config: Config, workspaceRoot: string): string[] {
  const initial = workspaceRoot === config.projectRoot && config.tsconfig
    ? config.tsconfig
    : existingTsconfig(workspaceRoot);
  if (!initial) return [];
  const result = new Set<string>();
  collectProjectReferences(initial, result);
  return [...result];
}

function collectProjectReferences(tsconfig: string, result: Set<string>): void {
  const normalized = path.resolve(tsconfig);
  if (result.has(normalized) || !fs.existsSync(normalized)) return;
  result.add(normalized);
  const ts = loadTypeScript();
  if (!ts) return;
  const read = ts.readConfigFile(normalized, ts.sys.readFile);
  if (read.error || !read.config || !Array.isArray(read.config.references)) return;
  for (const reference of read.config.references) {
    if (!reference || typeof reference.path !== "string") continue;
    const candidate = path.resolve(path.dirname(normalized), reference.path);
    const referencedConfig = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      ? path.join(candidate, "tsconfig.json")
      : candidate.endsWith(".json") ? candidate : `${candidate}.json`;
    collectProjectReferences(referencedConfig, result);
  }
}

function existingTsconfig(root: string): string | null {
  const candidate = path.join(root, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : null;
}

function detectWorkspaceFramework(manifest: PackageJson | null): string {
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
    ...Object.keys(manifest?.peerDependencies ?? {}),
  ]);
  if (dependencies.has("next")) return "next";
  if (dependencies.has("@remix-run/react")) return "remix";
  if (dependencies.has("expo")) return "expo";
  if (dependencies.has("astro")) return "astro-react";
  if (dependencies.has("react-router") || dependencies.has("react-router-dom")) return "react-router";
  if (dependencies.has("react")) return "react";
  if (dependencies.has("vite")) return "vite";
  return "unknown";
}

function fileInWorkspace(file: string, root: string): boolean {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function loadTypeScript(): typeof tsTypes | null {
  try {
    return require("typescript");
  } catch {
    return null;
  }
}
