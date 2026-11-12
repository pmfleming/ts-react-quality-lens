import { syntaxProgram } from "./syntax-program.js";
import { effectCandidates } from "./react-effect-review.js";
import path from "node:path";
import * as ts from "typescript";
import { stableHash } from "./clone-utils.js";
import { readPackageJson } from "./entrypoints.js";
import { featureSupport } from "./react-support.js";
import { workspaceForFile } from "./workspaces.js";
import type { Config, ProjectAnalysis, ScoredRecord } from "./types.js";

const EFFECT_GUIDE = "https://react.dev/learn/you-might-not-need-an-effect";
const STATE_GUIDE = "https://react.dev/learn/choosing-the-state-structure";
const PERFORMANCE_GUIDE = "https://vercel.com/blog/introducing-react-best-practices";
const NEXT_GUIDE = "https://nextjs.org/docs/app/guides/production-checklist";

/** Bounded syntactic review, with local binding identity; no inferred purity or measured cost. */
export function reactReviewRecords(config: Config, project: ProjectAnalysis): ScoredRecord[] {
  const program = syntaxProgram(project.modules);
  const checker = program.getTypeChecker();
  return project.modules.flatMap((module) => {
    const source = program.getSourceFile(module.absolutePath);
    if (!source || program.getSyntacticDiagnostics(source).length) return [];
    const records: ScoredRecord[] = [];
    const occurrences = new Map<string, number>();
    function emit(node: ts.Node, rule: string, message: string, guides: string[], keep: string, drop: string) {
      const anchor = `${rule}:${node.getText(source).replace(/\s+/g, " ")}`;
      const occurrence = (occurrences.get(anchor) ?? 0) + 1;
      occurrences.set(anchor, occurrence);
      records.push({ id: `react-review:${module.file}:${rule}:${stableHash(anchor)}:${occurrence}`,
        rule_id: `ts-react-quality-lens/${rule}`, kind: rule, file: module.file,
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        source: "react-guidance-review", evidence_kind: "heuristic", disposition: "review", finding_confidence: "low",
        semantic_decision: "unresolved", scope: "file", score: 25, risk: "low", react_category: "optimization",
        message, guidance_sources: guides, verification: { keepWhen: [keep], dropWhen: [drop] },
        performance_verified: false, signals: [{ kind: rule }],
        actions: [{ type: "fix", auto_fixable: false, description: "Review the documented React pattern.", fix: keep, note: drop }],
      });
    }
    const hook = reactHooks(source, checker);
    const functions = source.statements.flatMap<{ name: string; fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression }>((statement) => {
      if (ts.isFunctionDeclaration(statement) && statement.name) return [{ name: statement.name.text, fn: statement }];
      if (!ts.isVariableStatement(statement)) return [];
      return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) && declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? [{ name: declaration.name.text, fn: declaration.initializer }] : []);
    });
    for (const { name, fn } of functions) reviewFunction(name, fn);

    function reviewFunction(name: string, fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): void {
      if (!/^(?:[A-Z]|use[A-Z])/.test(name) || !fn.body || !ts.isBlock(fn.body)) return;
      const { setters, stateSetters, reactive, initializers } = stateBindings(fn.parameters, fn.body, checker, hook);
      for (const initial of initializers) emit(initial, "eager-state-initializer",
        "The state initializer calls a function during each render. Review its cost and whether a lazy initializer preserves behavior.",
        [PERFORMANCE_GUIDE, "https://react.dev/reference/react/useState#avoiding-recreating-the-initial-state"],
        "Keep when repeated initialization is costly and the calculation can run as a pure initializer.",
        "Drop when the calculation is cheap, deliberately repeated, or changing when it runs would alter behavior. Measure before optimizing.");
      for (const candidate of effectCandidates(fn.body, checker, (expression) => hook(expression, "useEffect"), stateSetters)) {
        emit(candidate.node, candidate.rule, candidate.message, [EFFECT_GUIDE, STATE_GUIDE], candidate.keep, candidate.drop);
      }
      reviewDerivedEffects(fn.body, setters, reactive);
    }

    function reviewDerivedEffects(body: ts.Block, setters: Set<ts.Symbol>, reactive: Set<ts.Symbol>): void {
      for (const statement of body.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || !hook(statement.expression.expression, "useEffect")) continue;
        const [callback, dependencies] = statement.expression.arguments;
        if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length ||
            callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !dependencies || !ts.isArrayLiteralExpression(dependencies)) continue;
        const body = callback.body;
        const only = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
        const call = only && ts.isExpressionStatement(only) ? only.expression : undefined;
        if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !hasSymbol(setters, call.expression, checker) || call.arguments.length !== 1) continue;
        let usesReactive = false;
        const simple = (node: ts.Node): boolean => {
          if (ts.isIdentifier(node)) { if (hasSymbol(reactive, node, checker)) usesReactive = true; return true; }
          if (ts.isPropertyAccessExpression(node)) return node.name.text !== "current" && simple(node.expression);
          if (ts.isParenthesizedExpression(node)) return simple(node.expression);
          if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
            ts.SyntaxKind.SlashToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) && simple(node.left) && simple(node.right);
          return ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
        };
        const argument = call.arguments[0];
        if (argument && simple(argument) && usesReactive) emit(statement, "derived-state-effect",
          "This Effect only copies or derives props/state into state. Review whether the value can be calculated during render.", [EFFECT_GUIDE, STATE_GUIDE],
          "Keep when the value is fully derivable from current props/state and no independent edits or external synchronization are required.",
          "Drop when deferred synchronization, an editable draft, getters, or other intentional state lifetime semantics require this Effect.");
      }
    }
    const workspace = workspaceForFile(project.workspaces, module.file);
    const relative = path.posix.relative(workspace.root, module.file);
    const manifest = readPackageJson(path.join(config.projectRoot, workspace.root, "package.json"));
    const next = manifest?.peerDependencies?.next ?? manifest?.dependencies?.next ?? manifest?.devDependencies?.next ?? null;
    const directive = source.statements.find((statement, index) => source.statements.slice(0, index + 1).every((item) =>
      ts.isExpressionStatement(item) && ts.isStringLiteral(item.expression)) && ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) && statement.expression.text === "use client");
    if (workspace.framework === "next" && featureSupport(next, "13.4.0") === "supported" &&
        /^(?:src\/)?app\/layout\.[jt]sx?$/.test(relative) && directive) emit(directive, "next-root-client-boundary",
      "The Next.js App Router root layout declares a client boundary. Review whether interactive providers can move into a smaller client component.", [NEXT_GUIDE],
      "Keep when a narrower client boundary reduces shipped JavaScript; confirm with a production bundle report.",
      "Drop when the root boundary is intentional or extraction provides no benefit. Server-rendered children passed as props do not automatically become client modules.");
    return records;
  });
}

function reactHooks(source: ts.SourceFile, checker: ts.TypeChecker) {
  const bindings = new Map<ts.Symbol, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "react" || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const element of named.elements) {
      const symbol = checker.getSymbolAtLocation(element.name);
      if (symbol && !element.isTypeOnly) bindings.set(symbol, element.propertyName?.text ?? element.name.text);
    }
    for (const name of [clause?.name, named && ts.isNamespaceImport(named) ? named.name : undefined]) {
      const symbol = name && checker.getSymbolAtLocation(name);
      if (symbol) bindings.set(symbol, "namespace");
    }
  }
  const binding = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol ? bindings.get(symbol) : undefined;
  };
  return (expression: ts.Expression, name: string): boolean => {
    if (ts.isIdentifier(expression)) return binding(expression) === name;
    return ts.isPropertyAccessExpression(expression) && expression.name.text === name &&
      binding(expression.expression) === "namespace";
  };
}

function hasSymbol(symbols: Set<ts.Symbol>, node: ts.Node, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol !== undefined && symbols.has(symbol);
}

/** Collect only top-level hook declarations in this component's lexical scope. */
function stateBindings(parameters: ts.NodeArray<ts.ParameterDeclaration>, body: ts.Block, checker: ts.TypeChecker,
  hook: (expression: ts.Expression, name: string) => boolean) {
  const setters = new Set<ts.Symbol>(), stateSetters = new Map<ts.Symbol, ts.Symbol>(), reactive = new Set<ts.Symbol>();
  const initializers: ts.CallExpression[] = [];
  for (const parameter of parameters) captureBindings(parameter.name, checker, reactive);
  const declarations = body.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  for (const declaration of declarations) {
    const call = declaration.initializer;
    if (!call || !ts.isCallExpression(call) || !hook(call.expression, "useState")) continue;
    if (ts.isArrayBindingPattern(declaration.name)) {
      const [state, setter] = declaration.name.elements;
      if (state && ts.isBindingElement(state)) captureBindings(state.name, checker, reactive);
      const setterSymbol = bindingSymbol(setter, checker), stateSymbol = bindingSymbol(state, checker);
      if (setterSymbol) setters.add(setterSymbol);
      if (setterSymbol && stateSymbol) stateSetters.set(setterSymbol, stateSymbol);
    }
    const initial = call.arguments[0];
    if (initial && ts.isCallExpression(initial)) initializers.push(initial);
  }
  return { setters, stateSetters, reactive, initializers };
}
function captureBindings(node: ts.Node, checker: ts.TypeChecker, symbols: Set<ts.Symbol>): void {
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) symbols.add(symbol);
  }
  ts.forEachChild(node, (child) => captureBindings(child, checker, symbols));
}
function bindingSymbol(element: ts.ArrayBindingElement | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  return element && ts.isBindingElement(element) && ts.isIdentifier(element.name) ? checker.getSymbolAtLocation(element.name) : undefined;
}
