import * as ts from "typescript";

const COMPLEXITY_CHECKS = [
  ts.isIfStatement,
  ts.isForStatement,
  ts.isForInStatement,
  ts.isForOfStatement,
  ts.isWhileStatement,
  ts.isDoStatement,
  ts.isCaseClause,
  ts.isCatchClause,
  ts.isConditionalExpression,
  ts.isTryStatement,
  ts.isAwaitExpression,
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

const JSX_CONDITIONAL_CHECKS = [isConditionalJsx, isLogicalJsx, isMapJsx];

export function complexityForNode(node) {
  return 1 + countMatchingNodes(node, (current) => COMPLEXITY_CHECKS.some((check) => check(current)));
}

export function maxNestingDepthForNode(node) {
  let max = 0;
  function visit(current, depth) {
    const nested = NESTING_CHECKS.some((check) => check(current));
    const nextDepth = nested ? depth + 1 : depth;
    max = Math.max(max, nextDepth);
    ts.forEachChild(current, (child) => visit(child, nextDepth));
  }
  visit(node, 0);
  return max;
}

export function countJsxConditionals(node) {
  return countMatchingNodes(node, (current) => JSX_CONDITIONAL_CHECKS.some((check) => check(current)));
}

export function countTypeFieldsForNode(node) {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeLiteralNode(node)) {
    return node.members.filter((member) => ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)).length;
  }
  if (ts.isTypeAliasDeclaration(node)) return countTypeFieldsForNode(node.type);
  return 0;
}

export function countOptionalTypeFields(node) {
  let count = 0;
  function visit(current) {
    if ((ts.isPropertySignature(current) || ts.isPropertyDeclaration(current) || ts.isParameter(current)) && current.questionToken) {
      count += 1;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

export function countUnionMembers(node) {
  let count = 0;
  function visit(current) {
    if (ts.isUnionTypeNode(current)) count += current.types.length;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function countMatchingNodes(node, predicate) {
  let count = 0;
  function visit(current) {
    if (predicate(current)) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function hasJsx(node) {
  let found = false;
  function visit(current) {
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

function isLogicalExpression(node) {
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  );
}

function isConditionalJsx(node) {
  return ts.isConditionalExpression(node) && hasJsx(node);
}

function isLogicalJsx(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && hasJsx(node.right);
}

function isMapJsx(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "map" &&
    node.arguments.some((argument) => hasJsx(argument))
  );
}
