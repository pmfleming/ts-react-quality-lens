import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isRecord, parseJson } from "../collections.js";
import { resolveNpmCli } from "./npm-cli.js";
import type { AttwProblem, Config, PackageHealthResult, PackageToolStatus, PublintMessage } from "../types.js";
import {
  runLocalTool,
  runToolAdapter,
  toolAvailable,
  toolPackageVersion,
  toolRunOptions,
  type ExecError,
} from "./tool-runner.js";

const require = createRequire(import.meta.url);
const PACKAGE_TIMEOUT_MS = 120_000;

export function runPackageHealth(config: Config): PackageHealthResult {
  if (!config.packageHealth.enabled) return disabledResult(config);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-package-${process.pid}-`));
  try {
    const declaration = runDeclarationEmit(config, path.join(tempDir, "declarations"));
    const packed = packProject(config, tempDir);
    const publint = runPublint(config, tempDir);
    const attw = packed.tarball
      ? runAttw(config, packed.tarball)
      : skippedAttw(config, "package tarball was not available");
    return {
      enabled: true,
      declaration,
      pack: packed.status,
      publint,
      attw,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runDeclarationEmit(config: Config, outputDir: string): PackageToolStatus {
  const tsconfig = config.tsconfig;
  if (!tsconfig || !fs.existsSync(tsconfig)) {
    return {
      available: toolAvailable(config.projectRoot, "tsc", true),
      ran: false,
      complete: false,
      reason: "declaration emit requires a readable tsconfig",
      duration_ms: 0,
      version: null,
    };
  }
  return runToolAdapter<{ complete: boolean; version: string | null }>(
    config,
    "tsc",
    "TypeScript compiler executable was not found",
    { complete: false, version: null },
    (executable) => {
      const versionOutput = runLocalTool(executable, ["--version"], toolRunOptions(config));
      fs.mkdirSync(outputDir, { recursive: true });
      runLocalTool(executable, [
        "-p",
        tsconfig,
        "--declaration",
        "--emitDeclarationOnly",
        "--noEmit",
        "false",
        "--incremental",
        "false",
        "--outDir",
        outputDir,
      ], toolRunOptions(config));
      return { complete: true, version: versionOutput.trim().replace(/^Version\s+/, "") };
    },
    null,
    true,
  );
}

function packProject(config: Config, tempDir: string): {
  status: PackageHealthResult["pack"];
  tarball: string | null;
} {
  const startedAt = Date.now();
  try {
    const stdout = childProcess.execFileSync(process.execPath, [
      resolveNpmCli(),
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      tempDir,
    ], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PACKAGE_TIMEOUT_MS,
    });
    const parsed = parseJson(stdout);
    const result = Array.isArray(parsed) && isRecord(parsed[0]) ? parsed[0] : null;
    if (!result || typeof result.filename !== "string") throw new Error("npm pack did not return a tarball filename");
    return {
      status: {
        available: true,
        ran: true,
        complete: true,
        reason: null,
        duration_ms: Date.now() - startedAt,
        files: Array.isArray(result.files) ? result.files.length : 0,
        size: typeof result.size === "number" ? result.size : null,
      },
      tarball: path.join(tempDir, result.filename),
    };
  } catch (error) {
    return {
      status: {
        available: true,
        ran: false,
        complete: false,
        reason: processError(error),
        duration_ms: Date.now() - startedAt,
        files: 0,
        size: null,
      },
      tarball: null,
    };
  }
}

function runPublint(config: Config, tempDir: string): PackageHealthResult["publint"] {
  const startedAt = Date.now();
  const version = toolPackageVersion("publint");
  const runner = path.join(tempDir, "publint-runner.mjs");
  try {
    const entry = pathToFileURL(require.resolve("publint")).href;
    fs.writeFileSync(runner, [
      `import { publint } from ${JSON.stringify(entry)};`,
      `const result = await publint({ pkgDir: ${JSON.stringify(config.projectRoot)}, pack: "npm", level: "suggestion" });`,
      "process.stdout.write(JSON.stringify({ messages: result.messages }));",
      "",
    ].join("\n"), "utf8");
    const stdout = childProcess.execFileSync(process.execPath, [runner], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PACKAGE_TIMEOUT_MS,
    });
    const parsed = parseJson(stdout);
    return {
      available: true,
      ran: true,
      complete: true,
      reason: null,
      duration_ms: Date.now() - startedAt,
      version,
      messages: normalizePublintMessages(isRecord(parsed) ? parsed.messages : null),
    };
  } catch (error) {
    return {
      available: version !== null,
      ran: false,
      complete: false,
      reason: processError(error),
      duration_ms: Date.now() - startedAt,
      version,
      messages: [],
    };
  }
}

function runAttw(config: Config, tarball: string): PackageHealthResult["attw"] {
  const parse = (stdout: string) => ({
    complete: true,
    version: toolPackageVersion("@arethetypeswrong/cli"),
    problems: normalizeAttwProblems(parseJson(stdout), config.packageHealth.attwProfile),
    profile: config.packageHealth.attwProfile,
  });
  return runToolAdapter(
    config,
    "attw",
    "Are The Types Wrong executable was not found",
    {
      complete: false,
      version: toolPackageVersion("@arethetypeswrong/cli"),
      problems: [],
      profile: config.packageHealth.attwProfile,
    },
    (executable) => parse(runLocalTool(executable, [
      tarball,
      "--format",
      "json",
      "--profile",
      config.packageHealth.attwProfile,
      "--no-summary",
      "--no-emoji",
      "--no-color",
    ], toolRunOptions(config))),
    (error: ExecError) => {
      const stdout = String(error.stdout ?? "");
      return stdout.trim().startsWith("{") ? parse(stdout) : null;
    },
    true,
  );
}

function normalizePublintMessages(value: unknown): PublintMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message): PublintMessage[] => {
    if (!isRecord(message) || typeof message.code !== "string") return [];
    const type = message.type === "error" || message.type === "warning" ? message.type : "suggestion";
    return [{
      code: message.code,
      type,
      path: Array.isArray(message.path) ? message.path.filter((item): item is string => typeof item === "string") : [],
      args: isRecord(message.args) ? message.args : {},
    }];
  });
}

function normalizeAttwProblems(
  value: unknown,
  profile: Config["packageHealth"]["attwProfile"],
): AttwProblem[] {
  if (!isRecord(value) || !isRecord(value.problems)) return [];
  return Object.values(value.problems).flatMap((items): AttwProblem[] => {
    if (!Array.isArray(items)) return [];
    return items.flatMap((item): AttwProblem[] => {
      if (!isRecord(item) || typeof item.kind !== "string") return [];
      const resolutionKind = typeof item.resolutionKind === "string" ? item.resolutionKind : undefined;
      if (profile === "esm-only" && resolutionKind?.endsWith("-cjs")) return [];
      if (profile === "node16" && resolutionKind === "node10") return [];
      return [{
        kind: item.kind,
        ...(typeof item.entrypoint === "string" ? { entrypoint: item.entrypoint } : {}),
        ...(resolutionKind ? { resolutionKind } : {}),
      }];
    });
  });
}

function skippedAttw(config: Config, reason: string): PackageHealthResult["attw"] {
  return {
    available: toolAvailable(config.projectRoot, "attw", true),
    ran: false,
    complete: false,
    reason,
    duration_ms: 0,
    version: toolPackageVersion("@arethetypeswrong/cli"),
    problems: [],
    profile: config.packageHealth.attwProfile,
  };
}

function disabledResult(config: Config): PackageHealthResult {
  const reason = "package health is disabled; enable it directly or select the library policy profile";
  return {
    enabled: false,
    declaration: disabledStatus(reason),
    pack: { ...disabledStatus(reason), files: 0, size: null },
    publint: { ...disabledStatus(reason), version: toolPackageVersion("publint"), messages: [] },
    attw: {
      ...disabledStatus(reason),
      version: toolPackageVersion("@arethetypeswrong/cli"),
      problems: [],
      profile: config.packageHealth.attwProfile,
    },
  };
}

function disabledStatus(reason: string): PackageToolStatus {
  return { available: true, ran: false, complete: false, reason, duration_ms: 0 };
}

function processError(error: unknown): string {
  if (isRecord(error)) {
    const stderr = String(error.stderr ?? "").trim();
    const stdout = String(error.stdout ?? "").trim();
    if (stderr || stdout) return (stderr || stdout).slice(0, 4000);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
