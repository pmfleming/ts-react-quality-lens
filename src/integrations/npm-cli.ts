import fs from "node:fs";
import { isRecord, isUnknownArray } from "../collections.js";
import { arrayOf, shape, string } from "../validation.js";
import path from "node:path";

/** npm <=11 returns an array; npm 12 returns a package-name keyed object. */
export function npmPackResult(value: unknown): { filename: string; files: Array<{ path: string }>; size: number | null } {
  const entries = isUnknownArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  const item = entries.length === 1 ? entries[0] : null;
  if (!isRecord(item) || typeof item.filename !== "string" || !item.filename.endsWith(".tgz") ||
      path.basename(item.filename) !== item.filename || /[\\\\:]/.test(item.filename) ||
      !arrayOf(shape({ path: string }))(item.files)) {
    throw new Error("npm pack did not return one valid tarball report");
  }
  return { filename: item.filename, files: item.files, size: typeof item.size === "number" ? item.size : null };
}

/** Resolve npm's JavaScript entrypoint without executing platform-specific shims. */
export function resolveNpmCli(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath) === "npm-cli.js" && isFile(npmExecPath)) {
    return npmExecPath;
  }

  const nodeDirectory = path.dirname(execPath);
  const candidates = npmCliCandidates(nodeDirectory);
  // Windows environment keys are case-insensitive, but plain environment objects aren't.
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of ["npm", "npm.cmd"]) {
      try {
        const executable = fs.realpathSync(path.join(directory, name));
        if (path.basename(executable) === "npm-cli.js") candidates.push(executable);
        candidates.push(...npmCliCandidates(path.dirname(executable)));
      } catch {
        // npm need not be installed in every PATH directory.
      }
    }
  }
  const cli = candidates.find(isFile);
  if (!cli) throw new Error("npm JavaScript CLI (npm-cli.js) was not found; install npm or add it to PATH");
  return cli;
}

function npmCliCandidates(directory: string): string[] {
  return [
    path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

function isFile(filename: string): boolean {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}
