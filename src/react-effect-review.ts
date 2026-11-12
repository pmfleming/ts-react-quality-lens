import * as ts from "typescript";

export type EffectCandidate = { node: ts.Node; rule: string; message: string; keep: string; drop: string };
type Callback = ts.ArrowFunction | ts.FunctionExpression;
type Effect = { node: ts.ExpressionStatement; callback: Callback; reads: Set<ts.Symbol>; writes: Set<ts.Symbol> };

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
    effects.push({ node: statement, callback, reads, writes });
    if (unguardedAsyncWrites(callback, checker, setters).length) candidates.push({ node: statement, rule: "async-effect-race",
      message: "An asynchronous callback writes local state without a recognized cleanup-invalidated guard. Review whether an older response can overwrite newer state.",
      keep: "Keep when requests can overlap or finish after the Effect is invalidated and stale results can still update state. Verify with reordered-response tests.",
      drop: "Drop when request generations, cancellation, framework ownership, or another verified mechanism prevents stale writes. Unrecognized protection remains a review candidate, not proof of a race." });
  }
  // One record per connected chain component, including cycles; never infer additional render counts.
  const edges = effects.map((effect, from) => effects.flatMap((other, to) => from !== to && [...effect.writes].some((state) => other.reads.has(state)) ? [to] : []));
  const visited = new Set<number>();
  for (let start = 0; start < effects.length; start++) {
    if (visited.has(start)) continue;
    const group = new Set<number>();
    const pending = [start];
    while (pending.length) {
      const index = pending.pop()!;
      if (group.has(index)) continue;
      group.add(index); visited.add(index);
      pending.push(...edges[index]!, ...edges.flatMap((targets, from) => targets.includes(index) ? [from] : []));
    }
    if (group.size < 2) continue;
    const ordered = [...group].sort((a, b) => a - b);
    candidates.push({ node: effects[ordered[0]!]!.node, rule: "effect-state-chain",
      message: `${group.size} Effects are connected through local state writes and dependency arrays. Review whether the chain only derives state or handles one user event indirectly.`,
      keep: "Keep when intermediate state only triggers another computation; consider deriving values during render or updating related state in the initiating event.",
      drop: "Drop when the Effects synchronize distinct external systems or dependent network resources. Static edges do not prove execution order, unnecessary renders, or a cycle at runtime." });
  }
  return candidates;
}

function unguardedAsyncWrites(effect: Callback, checker: ts.TypeChecker, setters: Map<ts.Symbol, ts.Symbol>): ts.Node[] {
  const invalidated = new Map<ts.Symbol, boolean>();
  const flags = new Map<ts.Symbol, boolean>();
  const cleanupAssignments = new Set<ts.Node>();
  if (ts.isBlock(effect.body)) for (const statement of effect.body.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.flags & ts.NodeFlags.Const) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(declaration.initializer.kind)) continue;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (symbol) flags.set(symbol, declaration.initializer.kind === ts.SyntaxKind.TrueKeyword);
    }
  }
  const asyncFunctions = new Map<ts.Symbol, ts.FunctionDeclaration | Callback>();
  if (ts.isBlock(effect.body)) for (const statement of effect.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression && isCallback(statement.expression)) {
      const cleanup = statement.expression.body;
      const expressions = ts.isBlock(cleanup) ? cleanup.statements.flatMap((item) => ts.isExpressionStatement(item) ? [item.expression] : []) : [cleanup];
      for (const expression of expressions) {
        if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(expression.left)) continue;
        const symbol = checker.getSymbolAtLocation(expression.left);
        if (symbol && flags.has(symbol) && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expression.right.kind) &&
            flags.get(symbol) !== (expression.right.kind === ts.SyntaxKind.TrueKeyword)) {
          invalidated.set(symbol, expression.right.kind === ts.SyntaxKind.TrueKeyword); cleanupAssignments.add(expression);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      const symbol = checker.getSymbolAtLocation(statement.name); if (symbol) asyncFunctions.set(symbol, statement);
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !isCallback(declaration.initializer) ||
          !declaration.initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) continue;
      const symbol = checker.getSymbolAtLocation(declaration.name); if (symbol) asyncFunctions.set(symbol, declaration.initializer);
    }
  }
  function rejectRearmedFlags(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(node.left) && !cleanupAssignments.has(node)) invalidated.delete(checker.getSymbolAtLocation(node.left)!);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isIdentifier(node.operand)) invalidated.delete(checker.getSymbolAtLocation(node.operand)!);
    ts.forEachChild(node, rejectRearmedFlags);
  }
  rejectRearmedFlags(effect.body);
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
    if (ts.isPropertyAccessExpression(node.expression) && ["then", "catch", "finally"].includes(node.expression.name.text)) {
      for (const argument of node.arguments) if (isCallback(argument)) inspect(argument, false);
    }
    const symbol = ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined;
    const local = symbol && asyncFunctions.get(symbol);
    if (local) inspect(local, true);
    if (isCallback(node.expression) && node.expression.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) inspect(node.expression, true);
  });
  return [...writes];
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
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? setters.get(checker.getSymbolAtLocation(node.expression)!) : undefined;
}
function isCallback(node: ts.Node): node is Callback { return ts.isArrowFunction(node) || ts.isFunctionExpression(node); }
function visitImmediate(root: ts.Node, visit: (node: ts.Node) => void): void {
  function walk(node: ts.Node) { if (ts.isFunctionLike(node)) return; visit(node); ts.forEachChild(node, walk); }
  walk(root);
}
