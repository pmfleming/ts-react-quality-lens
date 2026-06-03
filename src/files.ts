import fs from "node:fs";
import path from "node:path";
import type { Config, PathAliasRule, SourceFileRecord } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const TEST_RE = /(?:^|[./\\])(?:__tests__|test|tests|spec|e2e|cypress)(?:[./\\]|$)|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

export function discoverSourceFiles(config: Config): string[] {
  const files: string[] = [];
  for (const root of config.sourceRoots) {
    if (fs.existsSync(root)) walk(root, config, files);
  }
  return unique(files).sort();
}

export function discoverTestFiles(config: Config): string[] {
  const files: string[] = [];
  for (const root of config.testRoots) {
    if (fs.existsSync(root)) walk(root, config, files, true);
  }
  return unique(files).filter((file) => isTestPath(file)).sort();
}

export function readSourceFile(file: string, projectRoot: string): SourceFileRecord {
  const text = fs.readFileSync(file, "utf8");
  return {
    path: file,
    relativePath: toPosix(path.relative(projectRoot, file)),
    text,
    lines: text.split(/\r?\n/),
    extension: path.extname(file),
    isTest: isTestPath(file),
  };
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isTestPath(file: string): boolean {
  return TEST_RE.test(toPosix(file));
}

export function lineForIndex(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

export function relativeModuleId(projectRoot: string, file: string): string {
  return toPosix(path.relative(projectRoot, file)).replace(/\.[cm]?[jt]sx?$/, "");
}

export function normalizeImportPath(fromFile: string, specifier: string, config: Config) {
  if (!specifier.startsWith(".")) {
    const resolvedAlias = resolveAliasImportPath(specifier, config.pathAliases);
    if (resolvedAlias) {
      return {
        kind: "relative",
        id: relativeModuleId(config.projectRoot, resolvedAlias),
        resolved: resolvedAlias,
      };
    }
    return { kind: "external", id: specifier, resolved: null };
  }
  return normalizeSourcePath(path.resolve(path.dirname(fromFile), specifier), config);
}

function normalizeSourcePath(base: string, config: Config) {
  const resolved = resolveSourcePath(base);
  if (!resolved) {
    return {
      kind: "relative_unresolved",
      id: toPosix(path.relative(config.projectRoot, base)),
      resolved: null,
    };
  }
  return {
    kind: "relative",
    id: relativeModuleId(config.projectRoot, resolved),
    resolved,
  };
}

function resolveAliasImportPath(specifier: string, aliases: PathAliasRule[]): string | null {
  for (const alias of aliases) {
    const match = aliasMatch(specifier, alias.pattern);
    if (!match) continue;
    for (const replacement of alias.replacements) {
      const resolved = resolveSourcePath(replacement.replace("*", match));
      if (resolved) return resolved;
    }
  }
  return null;
}

function aliasMatch(specifier: string, pattern: string): string | null {
  if (!pattern.includes("*")) return specifier === pattern ? "" : null;
  const [prefix, suffix = ""] = pattern.split("*");
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function resolveSourcePath(base: string): string | null {
  const parsed = path.parse(base);
  const sourceMappedCandidates =
    parsed.ext === ".js"
      ? [path.join(parsed.dir, `${parsed.name}.ts`), path.join(parsed.dir, `${parsed.name}.tsx`)]
      : parsed.ext === ".jsx"
        ? [path.join(parsed.dir, `${parsed.name}.tsx`)]
        : parsed.ext === ".mjs"
          ? [path.join(parsed.dir, `${parsed.name}.mts`), path.join(parsed.dir, `${parsed.name}.ts`)]
          : parsed.ext === ".cjs"
            ? [path.join(parsed.dir, `${parsed.name}.cts`), path.join(parsed.dir, `${parsed.name}.ts`)]
            : [];
  const candidates = [
    base,
    ...sourceMappedCandidates,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function walk(dir: string, config: Config, files: string[], includeTests = false): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (isExcluded(fullPath, entry.name, config)) continue;
    if (entry.isDirectory()) {
      walk(fullPath, config, files, includeTests);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      if (includeTests || !isTestPath(path.relative(config.projectRoot, fullPath))) files.push(fullPath);
    }
  }
}

function isExcluded(fullPath: string, name: string, config: Config): boolean {
  const rel = toPosix(path.relative(config.projectRoot, fullPath));
  return config.exclude.some((pattern) => {
    if (pattern.includes("*")) {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}$`).test(name) || new RegExp(escaped).test(rel);
    }
    return name === pattern || rel === pattern || rel.startsWith(`${pattern}/`) || rel.includes(`/${pattern}/`);
  });
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
