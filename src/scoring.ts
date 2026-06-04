import * as ts from "typescript";
import { lineForIndex } from "./files.js";
import { RISK_MODEL, riskForScore, severityScore } from "./risk-model.js";
import { callExpressionName, lineForNode } from "./ts-ast.js";
import type { FunctionRecord, ModuleRecord, ProjectAnalysis, ScoredRecord, Severity, Signal, TypeRecord, TypedDeclaration, TypedExport } from "./types.js";

export { riskForScore } from "./risk-model.js";

export function fileHotspotRecord(module: ModuleRecord): ScoredRecord {
  const branchCount = module.functions.reduce((total, fn) => total + Math.max(0, fn.complexity - 1), 0);
  const score = Math.round(
    module.lines * RISK_MODEL.hotspot.file_line_weight +
      branchCount * RISK_MODEL.hotspot.file_branch_weight +
      module.imports.length * RISK_MODEL.hotspot.file_import_weight,
  );
  return {
    id: `file:${module.id}`,
    kind: "file",
    module_id: module.id,
    file: module.file,
    line: 1,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "line_count", value: module.lines },
      { kind: "branch_count", value: branchCount },
      { kind: "import_count", value: module.imports.length },
    ],
  };
}

export function functionHotspotRecord(module: ModuleRecord, fn: FunctionRecord): ScoredRecord {
  const score = Math.round(
    fn.complexity * RISK_MODEL.hotspot.function_complexity_weight +
      fn.nesting_depth * RISK_MODEL.hotspot.function_nesting_weight +
      fn.lines * RISK_MODEL.hotspot.function_line_weight +
      fn.jsx_density * RISK_MODEL.hotspot.function_jsx_density_weight +
      fn.jsxConditionals * RISK_MODEL.hotspot.function_jsx_conditional_weight,
  );
  return {
    id: fn.id,
    kind: fn.kind,
    module_id: module.id,
    file: module.file,
    name: fn.name,
    line: fn.line,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "cognitive_complexity_proxy", value: fn.complexity },
      { kind: "nesting_depth", value: fn.nesting_depth },
      { kind: "line_count", value: fn.lines },
      ...(fn.jsx_density ? [{ kind: "jsx_density", value: fn.jsx_density }] : []),
      ...(fn.jsxConditionals ? [{ kind: "render_branch_complexity", value: fn.jsxConditionals }] : []),
    ],
  };
}

export function escapeRecords(module: ModuleRecord): ScoredRecord[] {
  const sourceFile = module.astSourceFile;
  const records = [...suppressionRecords(module)];
  if (!sourceFile) return records;
  const astSourceFile = sourceFile;

  function add(kind: string, severity: Severity, node: ts.Node, evidence = node.getText(astSourceFile)): void {
    records.push({
      id: `escape:${module.id}:${kind}:${lineForNode(astSourceFile, node)}:${node.getStart(astSourceFile)}`,
      module_id: module.id,
      file: module.file,
      kind,
      severity,
      line: lineForNode(astSourceFile, node),
      evidence: evidence.replace(/\s+/g, " ").slice(0, 120),
    });
  }

  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) add("explicit_any", "medium", node);
    if (node.kind === ts.SyntaxKind.UnknownKeyword) add("unknown_without_narrowing", "low", node);
    if (ts.isNonNullExpression(node)) add("non_null_assertion", "medium", node);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      add(nestedAssertion(node) ? "double_assertion" : "type_assertion", nestedAssertion(node) ? "high" : "medium", node);
    }
    if (isTopLevelMutableStatement(astSourceFile, node)) add("module_level_mutable_state", "medium", node);
    if (isDangerousHtml(node)) add("dangerous_html", "high", node);
    if (isEvalLikeCall(node)) add("eval_like_api", "high", node);
    if (isDirectDomMutation(node)) add("direct_dom_mutation", "medium", node);
    if (isBrowserGlobalAccess(node)) add("browser_global", "low", node);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records;
}

export function typeHealthRecords(module: ModuleRecord): ScoredRecord[] {
  const typedDeclarations = new Map((module.typed?.declarations ?? []).map((item) => [`${item.name}:${item.line}`, item]));
  const structuralRecords = module.types.map((type) => structuralTypeRecord(module, type, typedDeclarations));
  const structuralKeys = new Set(module.types.map((type) => `${type.name}:${type.line}`));
  const declarationRecords = (module.typed?.declarations ?? [])
    .filter((declaration) => !structuralKeys.has(`${declaration.name}:${declaration.line}`))
    .map((declaration) => typedDeclarationRecord(module, declaration))
    .filter((record): record is ScoredRecord => Boolean(record));
  const exportRecords = (module.typed?.exports ?? [])
    .map((exported) => weakTypedExportRecord(module, exported))
    .filter((record): record is ScoredRecord => Boolean(record));
  return [...structuralRecords, ...declarationRecords, ...exportRecords];
}

function structuralTypeRecord(
  module: ModuleRecord,
  type: TypeRecord,
  typedDeclarations: Map<string, TypedDeclaration>,
): ScoredRecord {
  const signals = typeHealthSignals(type);
  const score =
    type.field_count * 4 + type.union_members * 5 + type.optional_count * 3 + type.generic_params * 8 + signals.length * 8;
  return {
    id: `type:${module.id}:${type.name}:${type.line}`,
    module_id: module.id,
    file: module.file,
    name: type.name,
    kind: type.kind,
    exported: type.exported,
    line: type.line,
    score,
    risk: riskForScore(score),
    signals,
    source: "structural-type-scan",
    typed_info: typedDeclarations.get(`${type.name}:${type.line}`) ?? null,
    metrics: {
      field_count: type.field_count,
      optional_count: type.optional_count,
      union_members: type.union_members,
      generic_params: type.generic_params,
    },
  };
}

function typeHealthSignals(type: TypeRecord): Signal[] {
  return [
    ...(type.field_count > 10 ? [{ kind: "wide_surface", value: type.field_count }] : []),
    ...(type.union_members > 6 ? [{ kind: "large_union", value: type.union_members }] : []),
    ...(type.optional_count > 5 ? [{ kind: "many_optional_fields", value: type.optional_count }] : []),
    ...(type.generic_params > 3 ? [{ kind: "many_type_parameters", value: type.generic_params }] : []),
    ...(/\bany\b/.test(type.body) ? [{ kind: "weak_type_member", value: "any" }] : []),
  ];
}

function typedDeclarationRecord(module: ModuleRecord, declaration: TypedDeclaration): ScoredRecord | null {
  const weakType = isWeakType(declaration.type);
  const exportedApi = declaration.exported && ["FunctionDeclaration", "ClassDeclaration", "EnumDeclaration"].includes(declaration.kind);
  if (!weakType && !exportedApi) return null;
  const score = weakType ? 45 : 18;
  return {
    id: `typed-symbol:${module.id}:${declaration.name}:${declaration.line}`,
    module_id: module.id,
    file: module.file,
    name: declaration.name,
    kind: declaration.kind,
    exported: declaration.exported,
    line: declaration.line,
    score,
    risk: riskForScore(score),
    source: "typescript-compiler-api",
    signals: weakType ? [{ kind: "weak_inferred_type", value: declaration.type ?? "unknown" }] : [],
    metrics: { inferred_type: declaration.type },
  };
}

function weakTypedExportRecord(module: ModuleRecord, exported: TypedExport): ScoredRecord | null {
  if (!isWeakType(exported.type)) return null;
  return {
    id: `typed-export:${module.id}:${exported.name}`,
    module_id: module.id,
    file: module.file,
    name: exported.name,
    kind: "export",
    exported: true,
    line: null,
    score: 55,
    risk: "medium",
    source: "typescript-compiler-api",
    signals: [{ kind: "weak_export_type", value: exported.type ?? "unknown" }],
    metrics: { inferred_type: exported.type },
  };
}

export function frameworkRiskRecords(project: ProjectAnalysis): ScoredRecord[] {
  const details = project.frameworkDetails;
  const clientFiles = new Set(details.client_components);
  const serverFiles = new Set(details.server_only_signals);
  const records: ScoredRecord[] = [];
  for (const file of details.client_components.filter((item) => serverFiles.has(item))) {
    records.push({
      id: `framework:client-server-boundary:${file}`,
      module_id: file.replace(/\.[cm]?[jt]sx?$/, ""),
      file,
      name: "client/server boundary",
      line: 1,
      score: 80,
      risk: "high",
      source: "framework-adapter",
      signals: [{ kind: "client_component_with_server_only_signal" }],
    });
  }
  for (const file of transitiveClientServerBoundaryFiles(project, clientFiles, serverFiles)) {
    records.push({
      id: `framework:transitive-client-server-boundary:${file}`,
      module_id: file.replace(/\.[cm]?[jt]sx?$/, ""),
      file,
      name: "transitive client/server boundary",
      line: 1,
      score: 70,
      risk: "high",
      source: "framework-adapter",
      signals: [{ kind: "client_component_transitively_imports_server_only" }],
    });
  }
  for (const route of details.routes) {
    const module = project.modules.find((item) => item.file === route.file);
    const responsibilitySignals: Signal[] = [];
    if (module?.components.length) responsibilitySignals.push({ kind: "route_renders_ui" });
    if (/\b(?:fetch|load|loader|action|process\.env|fs\.|node:fs)\b/.test(module?.text ?? "")) {
      responsibilitySignals.push({ kind: "route_data_or_server_responsibility" });
    }
    if (responsibilitySignals.length > 1) {
      records.push({
        id: `framework:route-responsibility:${route.file}`,
        module_id: route.file.replace(/\.[cm]?[jt]sx?$/, ""),
        file: route.file,
        name: route.kind,
        line: 1,
        score: 45,
        risk: "medium",
        source: "framework-adapter",
        signals: responsibilitySignals,
      });
    }
  }
  for (const story of details.stories) {
    if (clientFiles.has(story)) continue;
    records.push({
      id: `framework:storybook-evidence:${story}`,
      module_id: story.replace(/\.[cm]?[jt]sx?$/, ""),
      file: story,
      name: "storybook evidence",
      line: 1,
      score: 5,
      risk: "low",
      source: "framework-adapter",
      signals: [{ kind: "storybook_ui_evidence" }],
    });
  }
  return records;
}

function transitiveClientServerBoundaryFiles(
  project: ProjectAnalysis,
  clientFiles: Set<string>,
  serverFiles: Set<string>,
): string[] {
  const fileById = new Map(project.modules.map((module) => [module.id, module.file]));
  const graph = new Map<string, string[]>();
  for (const edge of project.imports.filter((item) => item.to_kind === "relative")) {
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  }
  return [...clientFiles].filter((file) => reachesServerOnly(file.replace(/\.[cm]?[jt]sx?$/, ""), graph, fileById, serverFiles));
}

function reachesServerOnly(
  start: string,
  graph: Map<string, string[]>,
  fileById: Map<string, string>,
  serverFiles: Set<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (serverFiles.has(fileById.get(current) ?? "")) return true;
    stack.push(...(graph.get(current) ?? []));
  }
  return false;
}

export function hiddenCouplingSignals(module: ModuleRecord): Array<{ kind: string; line: number }> {
  const sourceFile = module.astSourceFile;
  if (!sourceFile) return [];
  const astSourceFile = sourceFile;
  const records: Array<{ kind: string; line: number }> = [];
  function add(kind: string, node: ts.Node): void {
    records.push({ kind, line: lineForNode(astSourceFile, node) });
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "window") add("window_global", node);
      if (node.expression.text === "localStorage") add("local_storage", node);
      if (node.expression.text === "sessionStorage") add("session_storage", node);
    }
    if (ts.isCallExpression(node)) {
      const name = callExpressionName(node);
      if (name === "createContext" || name === "useContext") add("react_context", node);
      if (["publish", "subscribe", "mitt", "eventBus"].includes(name ?? "")) add("event_bus", node);
    }
    if (ts.isIdentifier(node) && /(?:registry|singleton)/i.test(node.text)) add("singleton_registry", node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return records;
}

function maxScoreFor(records: ScoredRecord[] = [], file: string, mode: "score" | "severity" = "score"): number {
  const candidates = records.filter((record) => record.file === file || record.files?.includes(file));
  if (mode === "severity") {
    return Math.max(
      0,
      ...candidates.map((record) => severityScore(record.severity) ?? record.score ?? 0),
    );
  }
  return Math.max(0, ...candidates.map((record) => record.score ?? 0));
}

function isWeakType(type: string | null): boolean {
  return !type || type === "any" || type === "Function" || type === "(...args: any[]) => any";
}

function suppressionRecords(module: ModuleRecord): ScoredRecord[] {
  const specs: Array<[string, RegExp, Severity]> = [
    ["ts_suppression", /^\s*(?:(?:\/\/.*)|(?:\/\*.*))@ts-(?:ignore|expect-error|nocheck)/gm, "high"],
    ["eslint_suppression", /^\s*(?:(?:\/\/.*)|(?:\/\*.*))eslint-disable(?:-next-line)?/gm, "medium"],
  ];
  return specs.flatMap(([kind, re, severity]) => {
    const records: ScoredRecord[] = [];
    let match;
    while ((match = re.exec(module.text))) {
      records.push({
        id: `escape:${module.id}:${kind}:${lineForIndex(module.text, match.index)}:${match.index}`,
        module_id: module.id,
        file: module.file,
        kind,
        severity,
        line: lineForIndex(module.text, match.index),
        evidence: match[0].replace(/\s+/g, " ").slice(0, 120),
      });
    }
    return records;
  });
}

function nestedAssertion(node: ts.AsExpression | ts.TypeAssertion): boolean {
  return ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression);
}

function isTopLevelMutableStatement(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  return (
    ts.isVariableStatement(node) &&
    node.parent === sourceFile &&
    (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === ts.NodeFlags.Let
  );
}

function isDangerousHtml(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === "dangerouslySetInnerHTML";
}

function isEvalLikeCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && ["eval", "Function"].includes(callExpressionName(node) ?? "");
}

function isDirectDomMutation(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = node.expression.expression;
    return (
      ts.isIdentifier(receiver) &&
      receiver.text === "document" &&
      ["querySelector", "getElementById"].includes(node.expression.name.text)
    );
  }
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "innerHTML"
  );
}

function isBrowserGlobalAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ["window", "localStorage", "sessionStorage"].includes(node.expression.text)
  );
}
