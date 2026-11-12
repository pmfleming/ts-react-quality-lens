import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isExcluded, isTestPath, toPosix } from "./files.js";
import type { Config } from "./types.js";

export type WebInput = { path: string; relativePath: string; text: string; kind: "script" | "html" | "css" | "manifest" };
export type WebInputSet = {
  files: WebInput[];
  skipped: Array<{ file: string; reason: string }>;
  configuration: Array<{ relativePath: string; text: string }>;
  fingerprint: string;
};

const SCRIPTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const UNSUPPORTED = new Set([".scss", ".sass", ".less", ".vue", ".svelte", ".astro", ".hbs", ".ejs"]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 10000;

/** This inventory never enters the compiler module graph or its project cache. */
export function discoverWebInputs(config: Config): WebInputSet {
  const files = new Map<string, WebInput>();
  const skipped = new Map<string, string>();
  const directories = new Set<string>();
  const visited = new Set<string>();
  const selection = { projectRoot: config.projectRoot, exclude: [...config.exclude, ...config.modernWeb.exclude] };
  const relative = (file: string) => toPosix(path.relative(config.projectRoot, file)) || ".";
  const skip = (file: string, reason: string) => { skipped.set(relative(file), reason); };
  const read = (file: string, kind: WebInput["kind"]) => {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return skip(file, "size_limit");
      if (files.size >= MAX_FILES) return skip(file, "file_limit");
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("\0")) return skip(file, "binary_content");
      files.set(relative(file), { path: file, relativePath: relative(file), text, kind });
      for (let dir = path.dirname(file); within(config.projectRoot, dir); dir = path.dirname(dir)) {
        directories.add(dir);
        if (dir === config.projectRoot) break;
      }
    } catch { skip(file, "unreadable"); }
  };
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    if (!within(config.projectRoot, file)) return skip(file, "outside_project");
    if (within(config.outputDir, file) || isExcluded(file, path.basename(file), selection)) return;
    if (isTestPath(relative(file)) || /(?:^|\/)(?:docs?|examples?|demos?)(?:\/|$)/.test(relative(file))) return;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(fs.realpathSync(config.projectRoot), path.relative(config.projectRoot, file))) {
        return skip(file, "symlink");
      }
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      } else if (stat.isFile()) {
        const extension = path.extname(file).toLowerCase();
        if (path.basename(file) === "package.json") read(file, "manifest");
        else if (SCRIPTS.has(extension)) read(file, "script");
        else if ([".html", ".htm"].includes(extension)) read(file, "html");
        else if (extension === ".css") read(file, "css");
        else if (UNSUPPORTED.has(extension)) skip(file, "unsupported_format");
      }
    } catch { skip(file, "missing_or_unreadable"); }
  };
  if (config.modernWeb.enabled) {
    directories.add(config.projectRoot);
    for (const root of [...config.modernWeb.roots].sort()) visit(root);
    for (const dir of [...directories].sort()) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) visit(manifest);
    }
  }
  const configuration = [...directories].sort().flatMap((dir) => ["package.json", ".browserslistrc", "browserslist"].map((name) => {
    const file = path.join(dir, name);
    let text = "missing";
    try {
      if (fs.lstatSync(file).isSymbolicLink()) text = "unsupported:symlink";
      else if (fs.statSync(file).size > MAX_FILE_BYTES) text = "unsupported:size_limit";
      else text = fs.readFileSync(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") text = "unreadable"; }
    return { relativePath: relative(file), text };
  }));
  const result = {
    files: [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    skipped: [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([file, reason]) => ({ file, reason })),
    configuration,
  };
  const fingerprint = webContentHash({ ...result, files: result.files.map(({ path: _path, ...file }) => file),
    settings: { ...config.modernWeb, roots: config.modernWeb.roots.map(relative) } });
  return { ...result, fingerprint };
}

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function webContentHash(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
