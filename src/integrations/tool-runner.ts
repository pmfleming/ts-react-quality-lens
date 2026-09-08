import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isRecord, parseJson } from "../collections.js";
import { toPosix } from "../files.js";
import { packageJsonUrl, packageRootFrom } from "../package-root.js";
import type { Config } from "../types.js";

const require = createRequire(import.meta.url);
const TOOL_TIMEOUT_MS = 120000;

export type ExecError = Error & { stdout?: unknown; stderr?: unknown; status?: number };
type ToolRunOptions = childProcess.ExecFileSyncOptionsWithStringEncoding;

export function runToolAdapter<T extends Record<string, unknown>>(
  config: Config,
  executableName: string,
  missingReason: string,
  empty: T,
  run: (executable: string) => T,
  recover: ((error: ExecError) => T | null) | null = null,
  preferManaged = false,
) {
  const startedAt = Date.now();
  const executable = localBin(config.projectRoot, executableName, preferManaged);
  if (!executable) return toolResult(false, false, missingReason, startedAt, empty);
  try {
    return toolResult(true, true, null, startedAt, run(executable));
  } catch (error) {
    const execError = normalizeExecError(error);
    const recovered = recover?.(execError);
    return recovered
      ? toolResult(true, true, null, startedAt, recovered)
      : toolResult(true, false, toolError(execError), startedAt, empty);
  }
}

export function toolAvailable(projectRoot: string, name: string, preferManaged = false): boolean {
  return Boolean(localBin(projectRoot, name, preferManaged));
}

export function runLocalTool(executable: string, args: string[], options: ToolRunOptions): string {
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    const commandLine = [executable, ...args].map(quoteWindowsArg).join(" ");
    return childProcess.execFileSync("cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return childProcess.execFileSync(executable, args, options);
}

export function toolRunOptions(config: Config): ToolRunOptions {
  return {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TOOL_TIMEOUT_MS,
  };
}

export function existingRelativeRoots(config: Config): string[] {
  return config.sourceRoots
    .filter((root) => fs.existsSync(root))
    .map((root) => toPosix(path.relative(config.projectRoot, root)) || ".");
}

export function managedPackageJsonUrl(): string {
  return packageJsonUrl(managedRoot());
}

export function executablePackageVersion(config: Config, executableName: string, packageName: string): string | null {
  const executable = localBin(config.projectRoot, executableName, false);
  if (!executable) return null;
  let directory = path.dirname(fs.realpathSync(executable));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = parseJson(fs.readFileSync(manifestPath, "utf8"));
      if (isRecord(manifest) && manifest.name === packageName && typeof manifest.version === "string") return manifest.version;
    }
    directory = path.dirname(directory);
  }
  return null;
}

export function toolPackageVersion(name: string): string | null {
  try {
    const manifest: unknown = require(`${name}/package.json`);
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return packageVersionFromResolvedEntry(name);
  }
}

function packageVersionFromResolvedEntry(name: string): string | null {
  try {
    let directory = path.dirname(require.resolve(name));
    while (directory !== path.dirname(directory)) {
      const manifestPath = path.join(directory, "package.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = parseJson(fs.readFileSync(manifestPath, "utf8"));
        if (isRecord(manifest) && manifest.name === name && typeof manifest.version === "string") return manifest.version;
      }
      directory = path.dirname(directory);
    }
  } catch {
    return null;
  }
  return null;
}

function toolResult<T extends Record<string, unknown>>(
  available: boolean,
  ran: boolean,
  reason: string | null,
  startedAt: number,
  value: T,
) {
  return { available, ran, reason, duration_ms: Date.now() - startedAt, ...value };
}

function localBin(projectRoot: string, name: string, preferManaged: boolean): string | null {
  const names = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  const roots = preferManaged ? [managedRoot(), projectRoot] : [projectRoot, managedRoot()];
  for (const root of roots) {
    const executable = names
      .map((binName) => path.join(root, "node_modules", ".bin", binName))
      .find((candidate) => fs.existsSync(candidate));
    if (executable) return executable;
  }
  return null;
}

function managedRoot(): string {
  return packageRootFrom(new URL("../integrations.js", import.meta.url).href);
}

function normalizeExecError(value: unknown): ExecError {
  const details = isRecord(value) ? value : {};
  return Object.assign(value instanceof Error ? value : new Error(String(value)), {
    stdout: details.stdout,
    stderr: details.stderr,
    ...(typeof details.status === "number" ? { status: details.status } : {}),
  });
}

function quoteWindowsArg(value: string): string {
  return /[ \t"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toolError(error: ExecError): string {
  return (String(error.stderr ?? "").trim() || String(error.stdout ?? "").trim() || error.message).slice(0, 4000);
}
