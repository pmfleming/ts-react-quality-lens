import * as ts from "typescript";

export function lineForNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function callExpressionName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

export function countMatchingNodes(node: ts.Node, predicate: (node: ts.Node) => boolean): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if (predicate(current)) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

export function isFunctionWithBody(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}
