import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../collections.js";
import type { Config, ScoredRecord } from "../types.js";

export type LineRange = { start: number; end: number };

export type ChangeSet = {
  complete: boolean;
  reason: string | null;
  comparisonBase: string | null;
  files: string[];
  lines: Map<string, LineRange[]>;
};

// Compare the merge base to the analyzed working tree, including untracked files.
export function changeSetSince(config: Config, base: string): ChangeSet {
  try {
    const comparisonBase = gitOutput(config, ["merge-base", base, "HEAD"]).trim();
    const files = gitOutput(config, ["diff", "--relative", "--name-only", "-z", comparisonBase, "--"]).split("\0").filter(Boolean);
    const lines = parseChangedLineRanges(gitOutput(config, [
      "-c", "core.quotepath=false", "diff", "--relative", "--src-prefix=a/", "--dst-prefix=b/",
      "--unified=0", "--no-ext-diff", "--no-textconv", comparisonBase, "--",
    ]));
    const untracked = gitOutput(config, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const file of untracked) {
      const text = fs.readFileSync(path.resolve(config.projectRoot, file), "utf8");
      lines.set(stripSourceExtension(file), [{ start: 1, end: text.split(/\r?\n/).length }]);
    }
    return { complete: true, reason: null, comparisonBase, files: [...new Set([...files, ...untracked])], lines };
  } catch (error) {
    return {
      complete: false,
      reason: `Git comparison against ${base} failed: ${error instanceof Error ? error.message : String(error)}`,
      comparisonBase: null,
      files: [],
      lines: new Map(),
    };
  }
}

export function changedFilesSince(config: Config, base: string): string[] {
  return changeSetSince(config, base).files;
}

export function changedLineRangesSince(config: Config, base: string): Map<string, LineRange[]> {
  return changeSetSince(config, base).lines;
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
  return typeof record.line === "number"
    ? rangesOverlap({ start: record.line, end: record.end_line ?? record.line }, ranges) : ranges.length > 0;
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

function rangesOverlap(target: LineRange, ranges: LineRange[]): boolean {
  return ranges.some((range) => target.start <= range.end && range.start <= target.end);
}

function gitOutput(config: Config, args: string[]): string {
  return childProcess.execFileSync("git", args, {
    cwd: config.projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseChangedLineRanges(diff: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let currentFile: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      const raw = line.slice(4).replace(/\t$/, "");
      const file: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw;
      currentFile = typeof file === "string" && file.startsWith("b/") ? normalizePath(file.slice(2)) : null;
    }
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
