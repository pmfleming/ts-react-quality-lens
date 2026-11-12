import * as ts from "typescript";
import type { ScoredRecord } from "./types.js";

/** Source-backed public contracts only: declarations without implementations cannot prove callback usage. */
export function callbackContractRecords(checker: ts.TypeChecker, source: ts.SourceFile, file: string): ScoredRecord[] {
  const records: ScoredRecord[] = [];
  const module = checker.getSymbolAtLocation(source);
  const visited = new Set<ts.Node>();
  for (let symbol of module ? checker.getExportsOfModule(module) : []) {
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (declaration.getSourceFile() !== source) continue;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) inspect(declaration.initializer);
      else if (ts.isClassDeclaration(declaration)) {
        for (const member of declaration.members) {
          if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
          if (member.name && ts.isPrivateIdentifier(member.name)) continue;
          inspect(member);
        }
      } else inspect(declaration);
    }
  }
  return records;

  function inspect(node: ts.Node): void {
    if (visited.has(node)) return;
    visited.add(node);
    if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) || !node.body) return;
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name) || !parameter.type) continue;
      let callbackType = parameter.type;
      while (ts.isParenthesizedTypeNode(callbackType)) callbackType = callbackType.type;
      if (!ts.isFunctionTypeNode(callbackType)) continue;
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (!symbol) continue;
      const calls: ts.CallExpression[] = [];
      let escapes = false;
      function visit(child: ts.Node): void {
        if (ts.isIdentifier(child) && checker.getSymbolAtLocation(child) === symbol) {
          const parent = child.parent;
          if (ts.isCallExpression(parent) && parent.expression === child && !parent.questionDotToken && !parent.arguments.some(ts.isSpreadElement)) calls.push(parent);
          else escapes = true;
        }
        ts.forEachChild(child, visit);
      }
      visit(node.body);
      if (escapes || !calls.length) continue;
      if (callbackType.type.kind === ts.SyntaxKind.AnyKeyword && calls.every((call) => ts.isExpressionStatement(call.parent))) {
        add(parameter, "discarded-callback-any-result", `Every observed direct call to ${parameter.name.text} discards its any result. Review using void in the callback contract.`, calls);
      }
      let argumentIndex = 0;
      for (const input of callbackType.parameters) {
        if (ts.isIdentifier(input.name) && input.name.text === "this") continue;
        const index = argumentIndex++;
        if (!input.questionToken || input.dotDotDotToken) continue;
        if (calls.every((call) => {
          const argument = call.arguments[index];
          if (!argument) return false;
          const type = checker.getTypeAtLocation(argument);
          return !mayBeUndefined(type);
        })) add(input, "always-supplied-optional-callback-argument", `Optional callback argument ${input.name.getText(source)} is supplied by every observed direct call. Review whether optionality belongs in this contract.`, calls);
      }
    }
  }
  function add(node: ts.Node, rule: string, message: string, calls: ts.CallExpression[]): void {
    const start = node.getStart(source);
    const location = source.getLineAndCharacterOfPosition(start);
    records.push({ id: `callback-contract:${file}:${rule}:${start}`, rule_id: `ts-react-quality-lens/${rule}`,
      kind: "callback_contract_review", file, line: location.line + 1, column: location.character + 1,
      message, evidence_kind: "tool-rule", disposition: "review", semantic_decision: "unresolved", finding_confidence: "medium",
      scope: "file", source: "typescript-compiler-api", score: 25, risk: "low", observed_calls: calls.length,
      related_locations: calls.map((call) => ({ file, start_line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1, role: "related", message: "Observed direct callback call." })),
      limitations: "Public source implementations with inline callback types and direct non-spread calls only. Not path-sensitive, not a breaking-change safety proof; existing consumer contracts may justify the signature.",
    });
  }
}

function mayBeUndefined(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(mayBeUndefined);
  return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.TypeParameter));
}
