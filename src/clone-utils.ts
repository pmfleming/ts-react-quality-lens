import path from "node:path";
import { toPosix } from "./files.js";
import { riskForScore } from "./scoring.js";
import type { CloneBlock, CloneGroup, Config, JscpdDuplicate, Signal } from "./types.js";

type CloneScoreWeights = { block: number; file: number; source: number };

export function normalizeCloneLine(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "STRING")
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUMBER")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) =>
      ["if", "else", "for", "while", "return", "const", "let", "function", "export", "import", "from"].includes(word)
        ? word
        : "ID",
    );
}

export function stableHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function cloneGroup(group: CloneBlock[]): CloneGroup {
  return cloneGroupFromBlocks(group, {
    idPrefix: "clone",
    engine: "line-window-normalized",
    weights: { block: 10, file: 16, source: 10 },
  });
}

export function cloneGroupFromBlocks(
  group: CloneBlock[],
  options: {
    idPrefix: string;
    engine: string;
    extraSignals?: Signal[];
    weights: CloneScoreWeights;
  },
): CloneGroup {
  const first = group[0];
  if (!first) throw new Error("Cannot create a clone group from an empty block list.");
  const files = new Set(group.map((block) => block.file));
  const testCode = group.every((block) => block.test_code);
  const score = Math.min(
    100,
    group.length * options.weights.block + files.size * options.weights.file + (testCode ? 0 : options.weights.source),
  );
  return {
    id: `${options.idPrefix}:${first.hash}`,
    engine: options.engine,
    hash: first.hash,
    classification: testCode ? "test_clone" : "source_clone",
    test_code: testCode,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "instance_count", value: group.length },
      { kind: "file_count", value: files.size },
      ...(options.extraSignals ?? []),
    ],
    instances: group.map((block) => ({
      file: block.file,
      start_line: block.start_line,
      end_line: block.end_line,
    })),
  };
}

export function jscpdCloneGroup(config: Config, duplicate: JscpdDuplicate, index: number): CloneGroup {
  const first = duplicate.firstFile ?? {};
  const second = duplicate.secondFile ?? {};
  const instances = [first, second]
    .filter((item): item is typeof item & { name: string } => typeof item.name === "string")
    .map((item) => ({
      file: toPosix(path.relative(config.projectRoot, path.resolve(item.name))),
      start_line: item.start ?? item.startLoc?.line ?? null,
      end_line: item.end ?? item.endLoc?.line ?? null,
    }));
  const fileCount = new Set(instances.map((item) => item.file)).size;
  const lines = duplicate.lines ?? duplicate.fragment?.split(/\r?\n/).length ?? 0;
  const score = Math.min(100, lines * 4 + fileCount * 18 + 15);
  return {
    id: `jscpd:${duplicate.format ?? "unknown"}:${index + 1}`,
    engine: "jscpd",
    hash: duplicate.hash ?? null,
    classification: instances.every((item) => /(?:\.test|\.spec)\.[jt]sx?$/.test(item.file)) ? "test_clone" : "source_clone",
    test_code: instances.every((item) => /(?:\.test|\.spec)\.[jt]sx?$/.test(item.file)),
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "line_count", value: lines },
      { kind: "file_count", value: fileCount },
      { kind: "format", value: duplicate.format ?? "unknown" },
    ],
    instances,
  };
}
