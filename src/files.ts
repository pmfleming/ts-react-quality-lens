import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const TEST_RE = /(?:^|[./\\])(?:__tests__|test|tests|spec|e2e|cypress)(?:[./\\]|$)|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

export function discoverSourceFiles(config) {
  const files = [];
  for (const root of config.sourceRoots) {
    if (fs.existsSync(root)) walk(root, config, files);
  }
  return unique(files).sort();
}

export function discoverTestFiles(config) {
  const files = [];
  for (const root of config.testRoots) {
    if (fs.existsSync(root)) walk(root, config, files, true);
  }
  return unique(files).filter((file) => isTestPath(file)).sort();
}

export function readSourceFile(file, projectRoot) {
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

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function isTestPath(file) {
  return TEST_RE.test(toPosix(file));
}

export function lineForIndex(text, index) {
  return text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

export function relativeModuleId(projectRoot, file) {
  return toPosix(path.relative(projectRoot, file)).replace(/\.[cm]?[jt]sx?$/, "");
}

export function normalizeImportPath(fromFile, specifier, config) {
  if (!specifier.startsWith(".")) return { kind: "external", id: specifier, resolved: null };
  const base = path.resolve(path.dirname(fromFile), specifier);
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

function resolveSourcePath(base) {
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

function walk(dir, config, files, includeTests = false) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (isExcluded(fullPath, entry.name, config)) continue;
    if (entry.isDirectory()) {
      walk(fullPath, config, files, includeTests);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      if (includeTests || !isTestPath(fullPath)) files.push(fullPath);
    }
  }
}

function isExcluded(fullPath, name, config) {
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

function unique(values) {
  return [...new Set(values)];
}
