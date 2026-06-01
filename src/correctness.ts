import childProcess from "node:child_process";
import path from "node:path";
import { countMatches } from "./collections.js";

export function testRecord(config, file, modules) {
  const sameStem = file.relativePath
    .replace(/(?:\.test|\.spec|\.e2e)?\.[cm]?[jt]sx?$/, "")
    .replace(/\/__tests__\//, "/");
  const sourceMapping = modules
    .filter((module) => sameStem.endsWith(module.id) || module.id.endsWith(path.basename(sameStem)))
    .map((module) => module.file);
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

export function runTestCommand(config) {
  if (!config.testCommand) return { status: "unknown", reason: "No test command configured." };
  try {
    childProcess.execSync(config.testCommand, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
    });
    return { status: "passed", command: config.testCommand };
  } catch (error) {
    return {
      status: "failed",
      command: config.testCommand,
      exit_code: error.status ?? null,
      stderr: String(error.stderr ?? "").slice(0, 4000),
      stdout: String(error.stdout ?? "").slice(0, 4000),
    };
  }
}

function inferTestFramework(config, text) {
  if (config.testRunner !== "unknown") return config.testRunner;
  if (/\bimport\s+\{[^}]*test[^}]*\}\s+from\s+["']node:test/.test(text)) return "node";
  if (/\bvi\./.test(text)) return "vitest";
  if (/\bjest\./.test(text)) return "jest";
  return "unknown";
}
