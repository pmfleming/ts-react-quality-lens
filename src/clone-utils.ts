import path from "node:path";
import { toPosix } from "./files.js";
import { riskForScore } from "./scoring.js";

export function normalizeCloneLine(line) {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "STRING")
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUMBER")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) =>
      ["if", "else", "for", "while", "return", "const", "let", "function", "export", "import", "from"].includes(word)
        ? word
        : "ID",
    );
}

export function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function cloneGroup(group) {
  const files = new Set(group.map((block) => block.file));
  const testCode = group.every((block) => block.test_code);
  const score = Math.min(100, group.length * 10 + files.size * 16 + (testCode ? 0 : 10));
  return {
    id: `clone:${group[0].hash}`,
    engine: "line-window-normalized",
    hash: group[0].hash,
    classification: testCode ? "test_clone" : "source_clone",
    test_code: testCode,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "instance_count", value: group.length },
      { kind: "file_count", value: files.size },
    ],
    instances: group.map((block) => ({
      file: block.file,
      start_line: block.start_line,
      end_line: block.end_line,
    })),
  };
}

export function jscpdCloneGroup(config, duplicate, index) {
  const first = duplicate.firstFile ?? {};
  const second = duplicate.secondFile ?? {};
  const instances = [first, second]
    .filter((item) => item.name)
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
