import * as ts from "typescript";

const CYCLOMATIC_CHECKS = [
  ts.isIfStatement,
  ts.isForStatement,
  ts.isForInStatement,
  ts.isForOfStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isCaseClause,
  ts.isCatchClause,
  ts.isConditionalExpression,
  isLogicalExpression,
];

const NESTING_CHECKS = [
  ts.isBlock,
  ts.isIfStatement,
  ts.isForStatement,
  ts.isForInStatement,
  ts.isForOfStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isSwitchStatement,
  ts.isTryStatement,
];

const COGNITIVE_BREAKS = [
  ts.isIfStatement,
  ts.isForStatement,
  ts.isForInStatement,
  ts.isForOfStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isSwitchStatement,
  ts.isCatchClause,
  ts.isConditionalExpression,
];

const JSX_CONDITIONAL_CHECKS = [isConditionalJsx, isLogicalJsx, isMapJsx];

type HalsteadMetrics = {
  vocabulary: number;
  length: number;
  volume: number;
  difficulty: number;
  effort: number;
};

/** Compatibility alias: complexity is standard cyclomatic complexity. */
export function complexityForNode(node: ts.Node): number {
  return cyclomaticComplexityForNode(node);
}

function cyclomaticComplexityForNode(node: ts.Node): number {
  return 1 + countMatchingNodes(node, (current) => CYCLOMATIC_CHECKS.some((check) => check(current)));
}

export function cognitiveComplexityForNode(node: ts.Node): number {
  let complexity = 0;
  visit(node, 0, true);
  return complexity;

  function visit(current: ts.Node, nesting: number, root: boolean): void {
    if (!root && isFunctionLike(current)) return;
    const structuralBreak = COGNITIVE_BREAKS.some((check) => check(current));
    if (structuralBreak) complexity += 1 + nesting;
    else if (isLogicalExpression(current)) complexity += 1;
    const childNesting = structuralBreak ? nesting + 1 : nesting;
    ts.forEachChild(current, (child) => visit(child, childNesting, false));
  }
}

export function halsteadMetricsForNode(node: ts.Node): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.getText());
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const text = scanner.getTokenText();
    const target = isOperandToken(token) ? operands : operators;
    target.set(text, (target.get(text) ?? 0) + 1);
  }
  const distinctOperators = operators.size;
  const distinctOperands = operands.size;
  const totalOperators = sumCounts(operators);
  const totalOperands = sumCounts(operands);
  const vocabulary = distinctOperators + distinctOperands;
  const length = totalOperators + totalOperands;
  const volume = vocabulary > 1 ? length * Math.log2(vocabulary) : 0;
  const difficulty = distinctOperands > 0 ? (distinctOperators / 2) * (totalOperands / distinctOperands) : 0;
  return {
    vocabulary,
    length,
    volume: rounded(volume),
    difficulty: rounded(difficulty),
    effort: rounded(difficulty * volume),
  };
}

export function maxNestingDepthForNode(node: ts.Node): number {
  let max = 0;
  function visit(current: ts.Node, depth: number): void {
    const nested = NESTING_CHECKS.some((check) => check(current));
    const nextDepth = nested ? depth + 1 : depth;
    max = Math.max(max, nextDepth);
    ts.forEachChild(current, (child) => visit(child, nextDepth));
  }
  visit(node, 0);
  return max;
}

export function countJsxConditionals(node: ts.Node): number {
  return countMatchingNodes(node, (current) => JSX_CONDITIONAL_CHECKS.some((check) => check(current)));
}

export function countTypeFieldsForNode(node: ts.Node): number {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeLiteralNode(node)) {
    return node.members.filter((member) => ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)).length;
  }
  if (ts.isTypeAliasDeclaration(node)) return countTypeFieldsForNode(node.type);
  return 0;
}

export function countOptionalTypeFields(node: ts.Node): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if ((ts.isPropertySignature(current) || ts.isPropertyDeclaration(current) || ts.isParameter(current)) && current.questionToken) {
      count += 1;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

export function countUnionMembers(node: ts.Node): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if (ts.isUnionTypeNode(current)) count += current.types.length;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function countMatchingNodes(node: ts.Node, predicate: (node: ts.Node) => boolean): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if (predicate(current)) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function hasJsx(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) return;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isLogicalExpression(node: ts.Node): boolean {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  );
}

function isConditionalJsx(node: ts.Node): boolean {
  return ts.isConditionalExpression(node) && hasJsx(node);
}

function isLogicalJsx(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && hasJsx(node.right);
}

function isMapJsx(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "map" &&
    node.arguments.some((argument) => hasJsx(argument))
  );
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

function isOperandToken(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.Identifier ||
    token === ts.SyntaxKind.PrivateIdentifier ||
    token === ts.SyntaxKind.NumericLiteral ||
    token === ts.SyntaxKind.BigIntLiteral ||
    token === ts.SyntaxKind.StringLiteral ||
    token === ts.SyntaxKind.RegularExpressionLiteral ||
    token === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
}

function sumCounts(values: Map<string, number>): number {
  return [...values.values()].reduce((total, value) => total + value, 0);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
