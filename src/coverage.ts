import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./collections.js";
import { arrayOf, count, shape, string } from "./validation.js";
import type { SourceFileRecord } from "./types.js";

export type CoveredFile = { file: string; line_hits: Array<{ line: number; hits: number }> };

/** Source-mapped reports only. Reject unknown files instead of fabricating attribution. */
export function parseExecutionCoverage(format: unknown, data: unknown, root: string, sources: SourceFileRecord[]): CoveredFile[] {
  const parse = typeof format === "string" ? readers.get(format) : undefined;
  if (!parse) throw new Error("Unsupported execution coverage format");
  const coverage = new Coverage(root, sources);
  parse(data, coverage);
  if (!coverage.files.size) throw new Error("Coverage contains no mapped executable lines");
  return [...coverage.files].sort(([a], [b]) => a.localeCompare(b)).map(([file, lines]) => ({ file,
    line_hits: [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits })) }));
}

class Coverage {
  readonly files = new Map<string, Map<number, number>>();
  private readonly known: Map<string, SourceFileRecord>;
  private readonly root: string;
  constructor(root: string, sources: SourceFileRecord[]) {
    this.root = root;
    this.known = new Map(sources.map((source) => [source.relativePath, source]));
  }
  source(file: string): SourceFileRecord | undefined {
    const absolute = file.startsWith("file:") ? fileURLToPath(file) : path.resolve(this.root, file);
    return this.known.get(path.relative(this.root, absolute).replace(/\\/g, "/"));
  }
  add(file: string, line: number, hits: number): void {
    const source = this.source(file);
    if (!source || !count(line) || line < 1 || line > source.lines.length || !count(hits)) throw new Error(`Invalid or unmapped execution coverage: ${file}:${line}`);
    const lines = this.files.get(source.relativePath) ?? new Map<number, number>();
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    this.files.set(source.relativePath, lines);
  }
}

function lcov(data: unknown, coverage: Coverage): void {
  if (!string(data)) throw new Error("Unsupported execution coverage format");
  let file: string | null = null;
  for (const line of data.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (file) throw new Error("Unterminated LCOV record");
      file = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const match = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line);
      if (!file || !match) throw new Error("Invalid LCOV line record");
      coverage.add(file, Number(match[1]), Number(match[2]));
    } else if (line === "end_of_record") file = null;
  }
  if (file) throw new Error("Unterminated LCOV record");
}

const istanbulFile = shape({ statementMap: isRecord, s: isRecord });
const statementRange = shape({ start: isRecord, end: isRecord });
function istanbul(data: unknown, coverage: Coverage): void {
  if (!isRecord(data)) throw new Error("Unsupported execution coverage format");
  for (const [file, value] of Object.entries(data)) {
    if (!istanbulFile(value)) throw new Error("Invalid Istanbul coverage");
    for (const [id, statement] of Object.entries(value.statementMap)) {
      if (!statementRange(statement)) throw new Error("Invalid Istanbul statement");
      const start = Number(statement.start.line), end = Number(statement.end.line), hits = value.s[id];
      if (!count(start) || !count(end) || start < 1 || end < start || end - start > 1_000_000 || typeof hits !== "number") throw new Error("Invalid Istanbul range");
      for (let line = start; line <= end; line++) coverage.add(file, line, hits);
    }
  }
}

const v8Report = shape({ result: arrayOf(shape({ url: string, functions: arrayOf(shape({
  ranges: arrayOf(shape({ startOffset: count, endOffset: count, count })),
})) })) });
function v8(data: unknown, coverage: Coverage): void {
  if (!v8Report(data)) throw new Error("Invalid V8 coverage");
  for (const script of data.result) {
    const source = coverage.source(script.url);
    if (!source || !/\.[cm]?jsx?$/.test(source.relativePath)) throw new Error("V8 coverage requires matching original JavaScript; transpiled sources need source-mapped LCOV/Istanbul");
    const ranges = script.functions.flatMap((fn) => fn.ranges);
    if (ranges.some((range) => range.endOffset <= range.startOffset || range.endOffset > source.text.length)) throw new Error("Invalid V8 offsets/count");
    // Sort once, stably: the first containing range is the innermost, with original tie order.
    ranges.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    let line = 1;
    for (let offset = 0; offset < source.text.length; offset++) {
      const char = source.text[offset];
      if (char === "\n") line++;
      if (!char || /\s/.test(char)) continue;
      const range = ranges.find((range) => range.startOffset <= offset && offset < range.endOffset);
      if (range) coverage.add(script.url, line, range.count);
    }
  }
}
const readers = new Map<string, (data: unknown, coverage: Coverage) => void>([["lcov", lcov], ["istanbul", istanbul], ["v8", v8]]);
