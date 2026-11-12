import * as ts from "typescript";

export type SafetyEvidence = {
  dynamic_code: Array<{ start: number; end: number; api: string }>;
  exported_bindings: string[];
};

/** Resolve direct standard-library calls while the compiler's checker is available. */
export function collectSafetyEvidence(checker: ts.TypeChecker, source: ts.SourceFile, program: ts.Program): SafetyEvidence {
  const evidence: SafetyEvidence = { dynamic_code: [], exported_bindings: [] };
  const module = checker.getSymbolAtLocation(source);
  for (let symbol of module ? checker.getExportsOfModule(module) : []) {
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (symbol.declarations?.some((d) => d.getSourceFile() === source && (ts.isVariableDeclaration(d) || ts.isBindingElement(d)))) {
      evidence.exported_bindings.push(symbol.getName());
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let target: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      const symbol = ts.isElementAccessExpression(target) && target.argumentExpression && ts.isStringLiteral(target.argumentExpression)
        ? checker.getTypeAtLocation(target.expression).getProperty(target.argumentExpression.text)
        : checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
      if (symbol && ["eval", "Function"].includes(symbol.getName()) && symbol.declarations?.length &&
          symbol.declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))) {
        evidence.dynamic_code.push({ start: node.getStart(source), end: node.end, api: symbol.getName() });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return evidence;
}
