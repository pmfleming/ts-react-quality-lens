import fs from "node:fs";
import path from "node:path";
import type { Config, EntryPointReference, EntryPointRole, PackageJson } from "./types.js";

export function readPackageJson(packageJsonPath: string): PackageJson | null {
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

export function projectEntrypoints(config: Config, packageJson = readPackageJson(path.join(config.projectRoot, "package.json"))): EntryPointReference[] {
  const entries = [
    ...packageEntryReferences(config, packageJson),
    ...configuredPublicApiReferences(config),
  ];
  return dedupeEntrypoints(entries);
}

export function packageEntryFiles(config: Config, packageJson = readPackageJson(path.join(config.projectRoot, "package.json"))): Set<string> {
  return new Set(projectEntrypoints(config, packageJson).map((entry) => entry.file));
}

export function entrypointRolesForFile(entrypoints: EntryPointReference[], file: string): EntryPointRole[] {
  return [...new Set(entrypoints.filter((entry) => entry.file === file).map((entry) => entry.role))].sort();
}

export function isEntrypointFile(module: { file: string; entrypointRoles?: EntryPointRole[] }, entryFiles: Set<string> = new Set()): boolean {
  return Boolean(module.entrypointRoles?.length) || entryFiles.has(module.file);
}

function packageEntryReferences(config: Config, packageJson: PackageJson | null): EntryPointReference[] {
  const packageBin = typeof packageJson?.bin === "string" ? [packageJson.bin] : Object.values(packageJson?.bin ?? {});
  return [
    ...packageBin.flatMap((file) => sourceEntryReferences(config, file, "cli_bin", "package.json#bin")),
    ...Object.values(packageJson?.scripts ?? {}).flatMap((command) =>
      scriptFileReferences(command).flatMap((file) => sourceEntryReferences(config, file, "npm_script", "package.json#scripts")),
    ),
    ...sourceEntryReferences(config, packageJson?.main, "package_main", "package.json#main"),
    ...sourceEntryReferences(config, packageJson?.module, "package_module", "package.json#module"),
    ...sourceEntryReferences(config, packageJson?.types ?? packageJson?.typings, "package_types", "package.json#types"),
    ...packageExportFiles(packageJson?.exports).flatMap((file) =>
      sourceEntryReferences(config, file, "package_export", "package.json#exports"),
    ),
  ];
}

function configuredPublicApiReferences(config: Config): EntryPointReference[] {
  return config.publicApi.entry.flatMap((pattern) =>
    pattern.includes("*")
      ? []
      : sourceEntryReferences(config, pattern, "configured_public_api", "config.public_api.entry"),
  );
}

function scriptFileReferences(command: string): string[] {
  const matches = command.matchAll(/(?:^|\s)(\.?\.?\/?[\w./-]+\.(?:mjs|cjs|js|ts|tsx))/g);
  return [...matches].map((match) => match[1]);
}

function packageExportFiles(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith(".") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(packageExportFiles);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(packageExportFiles);
}

function sourceEntryReferences(
  config: Config,
  file: string | undefined,
  role: EntryPointRole,
  source: string,
): EntryPointReference[] {
  if (!file) return [];
  return sourceEntryCandidates(config, file).map((candidate) => ({ file: candidate, role, source }));
}

function sourceEntryCandidates(config: Config, file: string): string[] {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = [
    normalized,
    normalized.replace(/^dist\//, "").replace(/\.(?:mjs|cjs|js)$/, ".ts"),
    normalized.replace(/^dist\//, "").replace(/\.(?:jsx)$/, ".tsx"),
    normalized.replace(/\.(?:mjs|cjs|js)$/, ".ts"),
    normalized.replace(/\.(?:jsx)$/, ".tsx"),
  ];
  return candidates.filter((candidate) => fs.existsSync(path.join(config.projectRoot, candidate)));
}

function dedupeEntrypoints(entries: EntryPointReference[]): EntryPointReference[] {
  const seen = new Set<string>();
  const result: EntryPointReference[] = [];
  for (const entry of entries) {
    const key = `${entry.file}:${entry.role}:${entry.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result.sort((left, right) => left.file.localeCompare(right.file) || left.role.localeCompare(right.role));
}
