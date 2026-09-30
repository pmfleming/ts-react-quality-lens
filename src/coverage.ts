import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./collections.js";
import type { SourceFileRecord } from "./types.js";

export type CoveredFile = { file: string; line_hits: Array<{ line: number; hits: number }> };

/** Source-mapped reports only. Reject unknown files instead of fabricating attribution. */
export function parseExecutionCoverage(format: unknown, data: unknown, root: string, sources: SourceFileRecord[]): CoveredFile[] {
  const known = new Map(sources.map((source) => [source.relativePath, source]));
  const files = new Map<string, Map<number, number>>();
  const add = (file: string, line: number, hits: number) => {
    const absolute = file.startsWith("file:") ? fileURLToPath(file) : path.resolve(root, file);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    const source = known.get(relative);
    if (!source || !Number.isSafeInteger(line) || line < 1 || line > source.lines.length || !Number.isSafeInteger(hits) || hits < 0) {
      throw new Error(`Invalid or unmapped execution coverage: ${file}:${line}`);
    }
    const lines = files.get(relative) ?? new Map<number, number>();
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    files.set(relative, lines);
  };
  if (format === "lcov" && typeof data === "string") {
    let file: string | null = null;
    for (const line of data.split(/\r?\n/)) {
      if (line.startsWith("SF:")) { if (file) throw new Error("Unterminated LCOV record"); file = line.slice(3); }
      else if (line.startsWith("DA:")) {
        const match = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line);
        if (!file || !match) throw new Error("Invalid LCOV line record");
        add(file, Number(match[1]), Number(match[2]));
      } else if (line === "end_of_record") file = null;
    }
    if (file) throw new Error("Unterminated LCOV record");
  } else if (format === "istanbul" && isRecord(data)) {
    for (const [file, value] of Object.entries(data)) {
      if (!isRecord(value) || !isRecord(value.statementMap) || !isRecord(value.s)) throw new Error("Invalid Istanbul coverage");
      for (const [id, statement] of Object.entries(value.statementMap)) {
        if (!isRecord(statement) || !isRecord(statement.start) || !isRecord(statement.end)) throw new Error("Invalid Istanbul statement");
        const start = Number(statement.start.line), end = Number(statement.end.line), hits = value.s[id];
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 1_000_000 || typeof hits !== "number") throw new Error("Invalid Istanbul range");
        for (let line = start; line <= end; line++) add(file, line, hits);
      }
    }
  } else if (format === "v8" && isRecord(data) && Array.isArray(data.result)) {
    for (const script of data.result) {
      if (!isRecord(script) || typeof script.url !== "string" || !Array.isArray(script.functions)) throw new Error("Invalid V8 script");
      const absolute = script.url.startsWith("file:") ? fileURLToPath(script.url) : path.resolve(root, script.url);
      const source = known.get(path.relative(root, absolute).replace(/\\/g, "/"));
      if (!source || !/\.[cm]?jsx?$/.test(source.relativePath)) throw new Error("V8 coverage requires matching original JavaScript; transpiled sources need source-mapped LCOV/Istanbul");
      const ranges = script.functions.flatMap((fn) => {
        if (!isRecord(fn) || !Array.isArray(fn.ranges)) throw new Error("Invalid V8 function");
        return fn.ranges.map((range) => {
          if (!isRecord(range)) throw new Error("Invalid V8 range");
          const { startOffset: start, endOffset: end, count } = range;
          if (typeof start !== "number" || typeof end !== "number" || typeof count !== "number" ||
            ![start, end, count].every(Number.isSafeInteger) || start < 0 || end <= start || end > source.text.length || count < 0) throw new Error("Invalid V8 offsets/count");
          return { start, end, count };
        });
      });
      // Attribute each non-whitespace source position to its innermost range.
      // These are observed lines, not statement/branch coverage.
      let line = 1;
      for (let offset = 0; offset < source.text.length; offset++) {
        const char = source.text[offset];
        if (char === "\n") line++;
        if (!char || /\s/.test(char)) continue;
        const range = ranges.filter((range) => range.start <= offset && offset < range.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        if (range) add(script.url, line, range.count);
      }
    }
  } else throw new Error("Unsupported execution coverage format");
  if (!files.size) throw new Error("Coverage contains no mapped executable lines");
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, lines]) => ({ file,
    line_hits: [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits })) }));
}
