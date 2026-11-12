import * as ts from "typescript";
import { cloneGroupFromBlocks, stableHash } from "./clone-utils.js";
import { groupBy } from "./collections.js";
import { syntaxProgram } from "./syntax-program.js";
import { isFunctionWithBody, lineForNode } from "./ts-ast.js";
import type { CloneBlock, CloneGroup, ProjectAnalysis } from "./types.js";

type FunctionNode = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
type StructuralBlock = CloneBlock & { projection: boolean };

export function structuralCloneGroups(project: ProjectAnalysis, program = syntaxProgram(project.modules)): CloneGroup[] {
  const checker = program.getTypeChecker();
  const blocks: StructuralBlock[] = [];
  for (const module of project.modules) {
    const source = program.getSourceFile(module.absolutePath);
    if (!source || program.getSyntacticDiagnostics(source).length) continue;
    function visit(node: ts.Node): void {
      if (isFunctionWithBody(node)) {
        const { normalized, nodeCount } = normalizeFunction(node, checker);
        if (nodeCount >= 18) blocks.push({ normalized, hash: stableHash(normalized), file: module.file,
          start_line: lineForNode(node.getSourceFile(), node.body), end_line: node.getSourceFile().getLineAndCharacterOfPosition(node.body.end).line + 1,
          test_code: module.sourceFile.isTest, projection: isProjection(node.body) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  // Hashes identify groups; equality is checked against the full normalized representation.
  return [...groupBy(blocks, (block) => block.normalized).values()].filter((group) => group.length > 1).map((group) => ({
    ...cloneGroupFromBlocks(group, { idPrefix: "ast-clone", engine: "ast", weights: { block: 12, file: 18, source: 12 },
      extraSignals: [{ kind: "confidence_scope", value: "local-binding-syntax; not behavioral equivalence" }] }),
    ...(group.every((block) => block.projection) ? { boilerplate_reason: "data-projection" } : {}),
  }));
}

function normalizeFunction(fn: FunctionNode, checker: ts.TypeChecker) {
  const bindings = new Map<ts.Symbol, string>();
  const self = fn.name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined);
  const symbol = self && checker.getSymbolAtLocation(self);
  if (symbol) bindings.set(symbol, "self");
  let nextBinding = 0;
  function bind(node: ts.Node): void {
    if (ts.isIdentifier(node) && isBinding(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && !bindings.has(symbol)) bindings.set(symbol, `local:${nextBinding++}`);
    }
    ts.forEachChild(node, bind);
  }
  // Declaration order preserves parameter roles and distinguishes shadowed bindings.
  bind(fn);
  const parts: string[] = [];
  let nodeCount = 0;
  function visit(node: ts.Node): void {
    nodeCount++;
    if (ts.isIdentifier(node)) {
      if (isPropertyName(node)) parts.push(`property:${JSON.stringify(node.text)}`);
      else {
        const parent = node.parent;
        const symbol = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
        if (ts.isShorthandPropertyAssignment(parent) || ts.isBindingElement(parent) && !parent.propertyName && ts.isObjectBindingPattern(parent.parent)) parts.push(`property:${JSON.stringify(node.text)}`);
        parts.push(symbol && bindings.get(symbol) || `external:${JSON.stringify(node.text)}`);
      }
    } else if (ts.isLiteralExpression(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) parts.push(`${ts.SyntaxKind[node.kind]}:${JSON.stringify(node.text)}`);
    else {
      parts.push(ts.SyntaxKind[node.kind] ?? String(node.kind));
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) parts.push(`operator:${node.operator}`);
      if (ts.isVariableDeclarationList(node)) parts.push(`binding-kind:${node.flags & ts.NodeFlags.BlockScoped}`);
      ts.forEachChild(node, visit);
    }
  }
  visit(fn.body);
  return { normalized: parts.join(" "), nodeCount };
}

function isBinding(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isTypeParameterDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node;
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) return parent.name === node;
  return ts.isBindingElement(parent) && parent.propertyName === node || ts.isQualifiedName(parent) && parent.right === node;
}

function isProjection(body: ts.ConciseBody): boolean {
  const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  const expression = ts.isBlock(body) ? only && ts.isReturnStatement(only) ? only.expression : undefined : body;
  const value = expression && ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  return Boolean(value && ts.isObjectLiteralExpression(value) && value.properties.every((property) =>
    ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && isAccess(property.initializer)));
}
function isAccess(node: ts.Expression): boolean {
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) && isAccess(node.expression);
}
