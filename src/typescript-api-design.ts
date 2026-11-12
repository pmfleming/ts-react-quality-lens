import * as ts from "typescript";
import type { ScoredRecord } from "./types.js";

/** Deliberately bounded to explicit result annotations, preserving symbol identity. */
export function apiDesignRecords(checker: ts.TypeChecker, source: ts.SourceFile, file: string): ScoredRecord[] {
  const records: ScoredRecord[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node) && node.type && node.typeParameters?.length) {
      for (const parameter of node.typeParameters) {
        const symbol = checker.getSymbolAtLocation(parameter.name);
        if (!symbol || !references(node.type, symbol)) continue;
        // Constraints may connect an input type parameter to this output parameter.
        if (node.parameters.some((input) => references(input, symbol)) || node.typeParameters.some((other) =>
          other !== parameter && other.constraint && references(other.constraint, symbol))) continue;
        const start = parameter.getStart(source);
        const location = source.getLineAndCharacterOfPosition(start);
        records.push({
          id: `api-design:${file}:${start}:${parameter.name.text}`,
          rule_id: "ts-react-quality-lens/return-only-generic",
          kind: "return_only_generic", file, line: location.line + 1, column: location.character + 1,
          name: parameter.name.text, evidence_kind: "tool-rule", disposition: "review", finding_confidence: "medium",
          semantic_decision: "unresolved", source: "typescript-compiler-api", scope: "file", score: 30, risk: "low",
          message: `Type parameter ${parameter.name.text} appears in the explicit result but is not related to an input parameter. Review whether callers can select a result type the implementation cannot validate.`,
          evidence: node.type.getText(source),
          limitations: "Explicit annotations only. Factories, validators, overloads and framework contracts may intentionally use this pattern. No automatic rewrite is proposed.",
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  function references(node: ts.Node, symbol: ts.Symbol): boolean {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) return true;
    return ts.forEachChild(node, (child) => references(child, symbol) || undefined) === true;
  }
  visit(source);
  return records;
}
