import * as ts from "typescript";

export type EffectCandidate = { node: ts.Node; rule: string; message: string; keep: string; drop: string };
type Callback = ts.ArrowFunction | ts.FunctionExpression;
type Effect = { node: ts.ExpressionStatement; reads: Set<ts.Symbol>; writes: Set<ts.Symbol> };

/** Named local state and direct useEffect calls only; paths/async scheduling remain unproven. */
export function effectCandidates(body: ts.Block, checker: ts.TypeChecker, isEffect: (expression: ts.Expression) => boolean,
  setters: Map<ts.Symbol, ts.Symbol>): EffectCandidate[] {
  const effects: Effect[] = [];
  const candidates: EffectCandidate[] = [];
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || !isEffect(statement.expression.expression)) continue;
    const [callback, dependencies] = statement.expression.arguments;
    if (!callback || !isCallback(callback) || callback.parameters.length || !dependencies || !ts.isArrayLiteralExpression(dependencies)) continue;
    const reads = new Set(dependencies.elements.flatMap((element) => {
      const symbol = ts.isIdentifier(element) ? checker.getSymbolAtLocation(element) : undefined;
      return symbol ? [symbol] : [];
    }));
    const writes = new Set<ts.Symbol>();
    visitImmediate(callback.body, (node) => {
      const state = setterState(node, checker, setters);
      if (state) writes.add(state);
    });
    effects.push({ node: statement, reads, writes });
    if (unguardedAsyncWrites(callback, checker, setters).length) candidates.push({ node: statement, rule: "async-effect-race",
      message: "An asynchronous callback writes local state without a recognized cleanup-invalidated guard. Review whether an older response can overwrite newer state.",
      keep: "Keep when requests can overlap or finish after the Effect is invalidated and stale results can still update state. Verify with reordered-response tests.",
      drop: "Drop when request generations, cancellation, framework ownership, or another verified mechanism prevents stale writes. Unrecognized protection remains a review candidate, not proof of a race." });
  }
  // One record per connected chain component, including cycles; never infer additional render counts.
  const connected = (left: Effect, right: Effect) => [...left.writes].some((state) => right.reads.has(state));
  const visited = new Set<Effect>();
  for (const start of effects) {
    if (visited.has(start)) continue;
    const group = new Set([start]);
    for (const effect of group) {
      visited.add(effect);
      for (const other of effects) {
        if (connected(effect, other) || connected(other, effect)) group.add(other);
      }
    }
    if (group.size < 2) continue;
    candidates.push({ node: start.node, rule: "effect-state-chain",
      message: `${group.size} Effects are connected through local state writes and dependency arrays. Review whether the chain only derives state or handles one user event indirectly.`,
      keep: "Keep when intermediate state only triggers another computation; consider deriving values during render or updating related state in the initiating event.",
      drop: "Drop when the Effects synchronize distinct external systems or dependent network resources. Static edges do not prove execution order, unnecessary renders, or a cycle at runtime." });
  }
  return candidates;
}

function unguardedAsyncWrites(effect: Callback, checker: ts.TypeChecker, setters: Map<ts.Symbol, ts.Symbol>): ts.Node[] {
  const statements = ts.isBlock(effect.body) ? [...effect.body.statements] : [];
  const invalidated = cleanupGuards(effect.body, statements, checker);
  const asyncFunctions = new Map<ts.Symbol, ts.FunctionDeclaration | Callback>();
  const declarations = statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  for (const declaration of [...statements.filter(ts.isFunctionDeclaration), ...declarations]) {
    const value = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    const symbol = declaration.name && checker.getSymbolAtLocation(declaration.name);
    if (symbol && value && isAsyncFunction(value)) asyncFunctions.set(symbol, value);
  }
  const writes = new Set<ts.Node>();
  const inspect = (callback: ts.FunctionDeclaration | Callback, requireAwait: boolean) => {
    if (!callback.body) return;
    const awaitPositions: number[] = [];
    visitImmediate(callback.body, (node) => { if (ts.isAwaitExpression(node)) awaitPositions.push(node.getStart()); });
    visitImmediate(callback.body, (node) => {
      if (setterState(node, checker, setters) && (!requireAwait || awaitPositions.some((position) => position < node.end)) &&
          !guarded(node, callback, checker, invalidated)) writes.add(node);
    });
  };
  visitImmediate(effect.body, (node) => {
    if (!ts.isCallExpression(node)) return;
    let expression: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isPropertyAccessExpression(node.expression) && ["then", "catch", "finally"].includes(node.expression.name.text)) {
      for (const argument of node.arguments) if (isCallback(argument)) inspect(argument, false);
    }
    const symbol = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
    const local = symbol && asyncFunctions.get(symbol);
    if (local) inspect(local, true);
    if (isAsyncFunction(expression)) inspect(expression, true);
  });
  return [...writes];
}

function isAsyncFunction(node: ts.Node): node is ts.FunctionDeclaration | Callback {
  return (ts.isFunctionDeclaration(node) || isCallback(node)) && Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function booleanValue(node: ts.Node | undefined): boolean | undefined {
  if (node?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function cleanupGuards(body: ts.Node, statements: ts.Statement[], checker: ts.TypeChecker): Map<ts.Symbol, boolean> {
  const flags = new Map<ts.Symbol, boolean>();
  const mutable = statements.filter(ts.isVariableStatement).filter((statement) => !(statement.declarationList.flags & ts.NodeFlags.Const));
  for (const declaration of mutable.flatMap((statement) => [...statement.declarationList.declarations])) {
    const value = booleanValue(declaration.initializer);
    const symbol = ts.isIdentifier(declaration.name) && checker.getSymbolAtLocation(declaration.name);
    if (symbol && value !== undefined) flags.set(symbol, value);
  }
  const invalidated = new Map<ts.Symbol, boolean>();
  const assignments = new Set<ts.Node>();
  for (const statement of statements.filter(ts.isReturnStatement)) {
    if (!statement.expression || !isCallback(statement.expression)) continue;
    const cleanup = statement.expression.body;
    const expressions = ts.isBlock(cleanup) ? cleanup.statements.filter(ts.isExpressionStatement).map((item) => item.expression) : [cleanup];
    for (const expression of expressions) {
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(expression.left)) continue;
      const symbol = checker.getSymbolAtLocation(expression.left), value = booleanValue(expression.right);
      if (symbol && value !== undefined && flags.has(symbol) && flags.get(symbol) !== value) {
        invalidated.set(symbol, value); assignments.add(expression);
      }
    }
  }
  function rejectRearmed(node: ts.Node): void {
    const target = assignmentTarget(node);
    const symbol = target && checker.getSymbolAtLocation(target);
    if (symbol && !assignments.has(node)) invalidated.delete(symbol);
    ts.forEachChild(node, rejectRearmed);
  }
  rejectRearmed(body);
  return invalidated;
}

function assignmentTarget(node: ts.Node): ts.Identifier | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) return node.left;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isIdentifier(node.operand)) return node.operand;
  return undefined;
}

function guarded(node: ts.Node, boundary: ts.Node, checker: ts.TypeChecker, invalidated: Map<ts.Symbol, boolean>): boolean {
  for (let child = node, parent = node.parent; parent && child !== boundary; child = parent, parent = parent.parent) {
    if (!ts.isIfStatement(parent) || parent.thenStatement !== child) continue;
    const condition = parent.expression;
    const negated = ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken;
    const identifier = negated ? condition.operand : condition;
    if (!ts.isIdentifier(identifier)) continue;
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol && invalidated.get(symbol) === negated) return true;
  }
  return false;
}
function setterState(node: ts.Node, checker: ts.TypeChecker, setters: Map<ts.Symbol, ts.Symbol>): ts.Symbol | undefined {
  const symbol = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression);
  return symbol ? setters.get(symbol) : undefined;
}
function isCallback(node: ts.Node): node is Callback { return ts.isArrowFunction(node) || ts.isFunctionExpression(node); }
function visitImmediate(root: ts.Node, visit: (node: ts.Node) => void): void {
  function walk(node: ts.Node) { if (ts.isFunctionLike(node)) return; visit(node); ts.forEachChild(node, walk); }
  walk(root);
}
