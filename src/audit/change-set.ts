import childProcess from "node:child_process";
import { isRecord } from "../collections.js";
import type { Config, ScoredRecord } from "../types.js";

export type LineRange = { start: number; end: number };

export function changedFilesSince(config: Config, base: string): string[] {
  return gitDiff(config, [
    ["diff", "--name-only", `${base}...HEAD`],
    ["diff", "--name-only", base],
  ])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);
}

export function changedLineRangesSince(config: Config, base: string): Map<string, LineRange[]> {
  const diff = gitDiff(config, [
    ["diff", "--unified=0", "--no-ext-diff", `${base}...HEAD`],
    ["diff", "--unified=0", "--no-ext-diff", base],
  ]);
  return diff ? parseChangedLineRanges(diff) : new Map();
}

export function defaultBase(config: Config): string | null {
  try {
    const stdout = childProcess.execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() ? "origin/main" : null;
  } catch {
    return null;
  }
}

export function findingTouchesChangedFile(record: ScoredRecord, changedFiles: Set<string>): boolean {
  if (record.scope === "project") return true;
  if (record.file && changedFiles.has(stripSourceExtension(record.file))) return true;
  if (record.files?.some((file) => changedFiles.has(stripSourceExtension(file)))) return true;
  return findingInstances(record).some((instance) => changedFiles.has(stripSourceExtension(instance.file)));
}

export function findingTouchesChangedLine(record: ScoredRecord, changedLines: Map<string, LineRange[]>): boolean {
  if (record.scope === "project" || changedLines.size === 0) return true;
  if (record.file) return fileFindingTouchesLine(record, changedLines);
  const instances = findingInstances(record);
  if (instances.length) return instances.some((instance) => instanceTouchesLine(instance, changedLines));
  return record.files?.some((file) => changedLines.has(stripSourceExtension(file))) ?? false;
}

export function stripSourceExtension(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/, "");
}

function fileFindingTouchesLine(record: ScoredRecord, changedLines: Map<string, LineRange[]>): boolean {
  if (!record.file) return false;
  const ranges = changedLines.get(stripSourceExtension(record.file)) ?? [];
  return typeof record.line === "number" ? lineInRanges(record.line, ranges) : ranges.length > 0;
}

type FindingInstance = { file: string; start: number | null; end: number | null };

function findingInstances(record: ScoredRecord): FindingInstance[] {
  return Array.isArray(record.instances)
    ? record.instances.flatMap((instance) => {
        if (!isRecord(instance) || typeof instance.file !== "string") return [];
        const start = typeof instance.start_line === "number" ? instance.start_line : null;
        const end = typeof instance.end_line === "number" ? instance.end_line : start;
        return [{ file: instance.file, start, end }];
      })
    : [];
}

function instanceTouchesLine(instance: FindingInstance, changedLines: Map<string, LineRange[]>): boolean {
  const ranges = changedLines.get(stripSourceExtension(instance.file)) ?? [];
  return instance.start === null
    ? ranges.length > 0
    : rangesOverlap({ start: instance.start, end: instance.end ?? instance.start }, ranges);
}

function lineInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function rangesOverlap(target: LineRange, ranges: LineRange[]): boolean {
  return ranges.some((range) => target.start <= range.end && range.start <= target.end);
}

function gitDiff(config: Config, attempts: string[][]): string {
  for (const args of attempts) {
    const output = gitOutput(config, args);
    if (output.trim()) return output;
  }
  return "";
}

function gitOutput(config: Config, args: string[]): string {
  try {
    return childProcess.execFileSync("git", args, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function parseChangedLineRanges(diff: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let currentFile: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) currentFile = normalizePath(line.slice("+++ b/".length));
    else if (line.startsWith("+++ /dev/null")) currentFile = null;
    else if (currentFile && line.startsWith("@@")) addChangedRange(result, currentFile, line);
  }
  return result;
}

function addChangedRange(result: Map<string, LineRange[]>, file: string, header: string): void {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return;
  const start = Number(match[1]);
  const length = match[2] ? Number(match[2]) : 1;
  const key = stripSourceExtension(file);
  result.set(key, [...(result.get(key) ?? []), { start, end: length === 0 ? start : start + length - 1 }]);
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/");
}
