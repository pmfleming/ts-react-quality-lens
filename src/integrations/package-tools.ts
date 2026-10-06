import childProcess from "node:child_process";
import { validAttwProblems, validPublintMessages } from "../producer-payload.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isRecord, parseJson } from "../collections.js";
import { npmPackResult, resolveNpmCli } from "./npm-cli.js";
import type { AttwProblem, Config, PackageHealthResult, PackageToolStatus, PublintMessage } from "../types.js";
import {
  runLocalTool,
  runToolAdapter,
  toolAvailable,
  toolPackageVersion,
  toolRunOptions,
  toolResult,
  toolError,
  recoverToolJson,
} from "./tool-runner.js";

const require = createRequire(import.meta.url);

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
      ...disabledStatus("declaration emit requires a readable tsconfig"),
      available: toolAvailable(config.projectRoot, "tsc", true),
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
    ], toolRunOptions(config));
    const result = npmPackResult(parseJson(stdout));
    return {
      status: toolResult(true, true, null, startedAt, { complete: true, files: result.files.length, size: result.size }),
      tarball: path.join(tempDir, result.filename),
    };
  } catch (error) {
    return {
      status: toolResult(true, false, toolError(error), startedAt, { complete: false, files: 0, size: null }),
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
    const stdout = childProcess.execFileSync(process.execPath, [runner], toolRunOptions(config));
    const parsed = parseJson(stdout);
    return toolResult(true, true, null, startedAt, {
      complete: true, version, messages: normalizePublintMessages(isRecord(parsed) ? parsed.messages : null),
    });
  } catch (error) {
    return toolResult(version !== null, false, toolError(error), startedAt, { complete: false, version, messages: [] });
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
    (error) => recoverToolJson(error, "{", parse),
    true,
  );
}

function normalizePublintMessages(value: unknown): PublintMessage[] {
  if (!validPublintMessages(value)) throw new Error("Invalid publint messages payload");
  return value.map(({ code, type, path, args }) => ({ code, type, path, args }));
}

function normalizeAttwProblems(
  value: unknown,
  profile: Config["packageHealth"]["attwProfile"],
): AttwProblem[] {
  const groups = isRecord(value) && isRecord(value.problems) ? Object.values(value.problems) : null;
  if (!groups?.every(validAttwProblems)) throw new Error("Invalid ATTW problems payload");
  return groups.flat().filter(({ resolutionKind }) => !(profile === "esm-only" && resolutionKind?.endsWith("-cjs")) &&
    !(profile === "node16" && resolutionKind === "node10")).map(({ kind, entrypoint, resolutionKind }) => ({
      kind, ...(entrypoint ? { entrypoint } : {}), ...(resolutionKind ? { resolutionKind } : {}),
    }));
}

function skippedAttw(config: Config, reason: string): PackageHealthResult["attw"] {
  return {
    ...disabledStatus(reason),
    available: toolAvailable(config.projectRoot, "attw", true),
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
