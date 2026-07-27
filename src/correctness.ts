import childProcess from "node:child_process";
import path from "node:path";
import { isRecord } from "./collections.js";
import { countMatches } from "./collections.js";
import type { Config, ModuleRecord, SourceFileRecord, TestExecution, TestRecord } from "./types.js";

export function testRecord(config: Config, file: SourceFileRecord, modules: ModuleRecord[]): TestRecord {
  const sameStem = file.relativePath
    .replace(/(?:\.test|\.spec|\.e2e)?\.[cm]?[jt]sx?$/, "")
    .replace(/\/__tests__\//, "/");
  const sourceMapping = [...new Set([
    ...modules
      .filter((module) => sameStem.endsWith(module.id) || module.id.endsWith(path.basename(sameStem)))
      .map((module) => module.file),
    ...importedSourceMappings(file, modules),
  ])];
  return {
    id: `test:${file.relativePath}`,
    name: path.basename(file.relativePath),
    path: file.relativePath,
    framework: inferTestFramework(config, file.text),
    locality: sourceMapping.length > 0 ? "colocated" : "external",
    source_mapping: sourceMapping,
    assertions: countMatches(file.text, /\b(?:expect|assert|should)\s*(?:\(|\.)/g),
    skipped: countMatches(file.text, /\b(?:it|test|describe)\.skip\s*\(/g),
    todo: countMatches(file.text, /\b(?:it|test)\.todo\s*\(/g),
  };
}

export function runTestCommand(config: Config): TestExecution {
  if (!config.testCommand) return { status: "unknown", reason: "No test command configured." };
  try {
    // Config files are trusted input: test commands intentionally run with the project shell.
    childProcess.execSync(config.testCommand, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
    });
    return { status: "passed", command: config.testCommand };
  } catch (error) {
    const execError = isRecord(error) ? error : {};
    return {
      status: "failed",
      command: config.testCommand,
      exit_code: typeof execError.status === "number" ? execError.status : null,
      stderr: String(execError.stderr ?? "").slice(0, 4000),
      stdout: String(execError.stdout ?? "").slice(0, 4000),
    };
  }
}

function importedSourceMappings(file: SourceFileRecord, modules: ModuleRecord[]): string[] {
  const moduleById = new Map(modules.map((module) => [module.id, module.file]));
  return [...file.text.matchAll(/\b(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].flatMap((match) => {
    const specifier = match[1];
    if (!specifier) return [];
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(file.relativePath), specifier))
      .replace(/\.[cm]?[jt]sx?$/, "");
    const source = moduleById.get(resolved);
    return source ? [source] : [];
  });
}

function inferTestFramework(config: Config, text: string): string {
  if (config.testRunner !== "unknown") return config.testRunner;
  if (/\bimport\s+\{[^}]*test[^}]*\}\s+from\s+["']node:test/.test(text)) return "node";
  if (/\bvi\./.test(text)) return "vitest";
  if (/\bjest\./.test(text)) return "jest";
  return "unknown";
}
