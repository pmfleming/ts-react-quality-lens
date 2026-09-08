import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { stableHash } from "./clone-utils.js";
import { isRecord } from "./collections.js";
import type { Config } from "./types.js";

const SEMANTIC_SOURCES = new Set([
  "typescript-compiler", "typescript-eslint", "eslint-plugin-react-hooks", "eslint-plugin-jsx-a11y",
]);

// Location is presentation data, not identity. Occurrence suffixes preserve multiplicity.
export function normalizeFindingIdentities(config: Config, records: unknown[]): unknown[] {
  const sources = new Map<string, ts.SourceFile | null>();
  const occurrences = new Map<string, number>();
  return records.map((record) => {
    if (!isRecord(record) || typeof record.id !== "string" || typeof record.source !== "string" ||
        !SEMANTIC_SOURCES.has(record.source)) return record;
    const file = typeof record.file === "string" ? record.file : "project";
    const line = typeof record.line === "number" ? record.line : null;
    const column = typeof record.column === "number" ? record.column : 1;
    const source = file === "project" ? null : sourceFile(config, file, sources);
    const anchor = source && line !== null ? semanticAnchor(source, line, column) : "project";
    const fingerprint = stableHash(JSON.stringify([record.source, record.rule_id, file, record.message, anchor]));
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return { ...record, id: `${record.source}:${fingerprint}:${occurrence}`, fingerprint, occurrence };
  });
}

function sourceFile(config: Config, file: string, sources: Map<string, ts.SourceFile | null>): ts.SourceFile | null {
  if (!sources.has(file)) {
    try {
      sources.set(file, ts.createSourceFile(file, fs.readFileSync(path.resolve(config.projectRoot, file), "utf8"), ts.ScriptTarget.Latest, true));
    } catch {
      sources.set(file, null);
    }
  }
  return sources.get(file) ?? null;
}

function semanticAnchor(source: ts.SourceFile, line: number, column: number): string {
  const starts = source.getLineStarts();
  const start = starts[Math.max(0, line - 1)];
  if (start === undefined) return "unknown-location";
  const offset = Math.min(source.end, start + Math.max(0, column - 1));
  let statement: ts.Node | null = null;
  const containers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(source) || offset >= node.end) return;
    if (ts.isStatement(node) && !ts.isBlock(node)) statement = node;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isVariableDeclaration(node) || ts.isModuleDeclaration(node)) && node.name) {
      containers.push(node.name.getText(source));
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  const text = statement ? (statement as ts.Node).getText(source) : source.text.slice(start, starts[line] ?? source.end);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return JSON.stringify([containers, tokens]);
}
