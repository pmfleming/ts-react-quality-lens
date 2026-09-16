import * as ts from "typescript";

export type CompilerInputQuery =
  | { kind: "fileExists" | "directoryExists" | "getDirectories" | "realpath"; path: string }
  | {
      kind: "readDirectory";
      path: string;
      extensions?: readonly string[];
      excludes?: readonly string[];
      includes?: readonly string[];
      depth?: number;
    };

// Preserve negative resolution probes and directory queries, not just files that
// made it into the Program. New declarations/packages can change the old result.
export function trackCompilerInputs() {
  const files = new Set<string>();
  const queries = new Map<string, CompilerInputQuery>();
  function query<T>(input: CompilerInputQuery, read: () => T): T {
    queries.set(JSON.stringify(input), input);
    return read();
  }
  const system: ts.System = {
    ...ts.sys,
    readFile: (file) => { files.add(file); return ts.sys.readFile(file); },
    fileExists: (file) => query({ kind: "fileExists", path: file }, () => ts.sys.fileExists(file)),
    directoryExists: (dir) => query({ kind: "directoryExists", path: dir }, () => ts.sys.directoryExists(dir)),
    getDirectories: (dir) => query({ kind: "getDirectories", path: dir }, () => ts.sys.getDirectories(dir)),
    readDirectory: (dir, extensions, excludes, includes, depth) => query({
      kind: "readDirectory", path: dir,
      ...(extensions ? { extensions } : {}), ...(excludes ? { excludes } : {}),
      ...(includes ? { includes } : {}), ...(depth !== undefined ? { depth } : {}),
    }, () => ts.sys.readDirectory(dir, extensions, excludes, includes, depth)),
    ...(ts.sys.realpath ? {
      realpath: (file: string) => query({ kind: "realpath", path: file }, () => ts.sys.realpath!(file)),
    } : {}),
  };
  return { system, files, queries };
}

export function compilerInputQueryResults(queries: CompilerInputQuery[]): string {
  return JSON.stringify(queries.map((query) => {
    switch (query.kind) {
      case "readDirectory": return ts.sys.readDirectory(
        query.path, query.extensions, query.excludes, query.includes, query.depth,
      ).sort();
      case "fileExists": return ts.sys.fileExists(query.path);
      case "directoryExists": return ts.sys.directoryExists(query.path);
      case "getDirectories": return ts.sys.getDirectories(query.path).sort();
      case "realpath": return ts.sys.realpath?.(query.path) ?? query.path;
    }
  }));
}
