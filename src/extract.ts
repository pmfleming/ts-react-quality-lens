import * as ts from "typescript";
import { normalizeImportPath, relativeModuleId } from "./files.js";
import { cognitiveComplexityForNode, complexityForNode, countJsxConditionals, countOptionalTypeFields, countTypeFieldsForNode, countUnionMembers, halsteadMetricsForNode, maxNestingDepthForNode } from "./ast-metrics.js";
import { countMatches, dedupeBy } from "./collections.js";
import { callExpressionName, lineForNode } from "./ts-ast.js";
import type { Config, ConfidenceSignal, ExportRecord, FunctionRecord, ImportKind, ImportRecord, ModuleRecord, SourceFileRecord, TypeRecord, TypeScriptProject } from "./types.js";

type ImportExtraction = { imports: ImportRecord[]; unsupportedPatterns: ConfidenceSignal[] };

type ImportCandidate = {
  specifier: string;
  node: ts.Node;
  importKind: ImportKind;
  importedNames: string[];
  namespaceImport: boolean;
  sideEffectImport: boolean;
  wildcardReExport?: boolean;
};
type BindingEvidence = Pick<ImportCandidate, "importedNames" | "namespaceImport" | "sideEffectImport"> & {
  allSpecifiersTypeOnly: boolean;
};

export function analyzeModule(config: Config, file: SourceFileRecord, tsProject: TypeScriptProject): ModuleRecord {
  const id = relativeModuleId(config.projectRoot, file.path);
  const typed = tsProject.modules.get(id) ?? null;
  const sourceFile = typed?.sourceFile ?? parseSourceFile(file);
  const { imports, unsupportedPatterns } = extractImports(config, file, id, sourceFile);
  const functions = extractFunctions(file, sourceFile);
  const types = extractTypes(file, sourceFile);
  const exports = extractExports(sourceFile);
  const components = functions.filter((fn) => fn.kind === "component");
  const escapeCounts = countAstEscapeHatches(file, sourceFile);
  const record: ModuleRecord = {
    id,
    file: file.relativePath,
    absolutePath: file.path,
    lines: file.lines.length,
    imports,
    functions,
    components,
    types,
    exports,
    escapeCounts,
    isBarrel: isBarrel(sourceFile),
    typed,
    text: file.text,
    sourceFile: file,
    entrypointRoles: [],
    workspace_id: config.projectName,
    workspace_name: config.projectName,
    unsupportedPatterns,
  };
  Object.defineProperty(record, "astSourceFile", {
    value: sourceFile,
    enumerable: false,
  });
  return record;
}

function extractImports(
  config: Config,
  file: SourceFileRecord,
  fromId: string,
  sourceFile: ts.SourceFile,
): ImportExtraction {
  const result: ImportExtraction = { imports: [], unsupportedPatterns: [] };

  function visit(node: ts.Node): void {
    const candidate = importCandidate(node);
    if (candidate) addImportCandidate(config, file, fromId, sourceFile, result, candidate);
    else if (isNonLiteralDynamicImport(node)) {
      result.unsupportedPatterns.push(
        unsupportedPattern(file, sourceFile, node, "dynamic_non_literal_import", "Dynamic import uses a non-literal specifier."),
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function importCandidate(node: ts.Node): ImportCandidate | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const evidence = importBindingEvidence(node.importClause);
    return {
      specifier: node.moduleSpecifier.text,
      node,
      importKind: node.importClause?.isTypeOnly || evidence.allSpecifiersTypeOnly ? "type" : "static",
      ...evidence,
    };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    const evidence = exportBindingEvidence(node.exportClause);
    return {
      specifier: node.moduleSpecifier.text,
      node,
      importKind: node.isTypeOnly || evidence.allSpecifiersTypeOnly ? "type" : "static",
      ...evidence,
      wildcardReExport: !node.exportClause,
    };
  }
  if (isLiteralDynamicImport(node)) {
    return {
      specifier: node.arguments[0].text,
      node,
      importKind: "dynamic",
      importedNames: [],
      namespaceImport: true,
      sideEffectImport: false,
    };
  }
  return null;
}

function importBindingEvidence(importClause: ts.ImportClause | undefined): BindingEvidence {
  if (!importClause) return bindingEvidence([], false, true, false);
  const importedNames = importClause.name ? ["default"] : [];
  const named = namedBindingEvidence(importClause.namedBindings, importedNames);
  return {
    ...named,
    allSpecifiersTypeOnly: importClause.isTypeOnly || (!importClause.name && named.allSpecifiersTypeOnly),
  };
}

function exportBindingEvidence(exportClause: ts.ExportDeclaration["exportClause"]): BindingEvidence {
  if (!exportClause || ts.isNamespaceExport(exportClause)) return bindingEvidence([], true, false, false);
  return namedBindingEvidence(exportClause, []);
}

function namedBindingEvidence(
  bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined,
  importedNames: string[],
): BindingEvidence {
  if (!bindings) return bindingEvidence(importedNames, false, false, false);
  if (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) return bindingEvidence(importedNames, true, false, false);
  const allSpecifiersTypeOnly = bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  return bindingEvidence([...importedNames, ...bindings.elements.map(importedBindingName)], false, false, allSpecifiersTypeOnly);
}

function importedBindingName(element: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return element.propertyName?.text ?? element.name.text;
}

function bindingEvidence(
  importedNames: string[],
  namespaceImport: boolean,
  sideEffectImport: boolean,
  allSpecifiersTypeOnly: boolean,
): BindingEvidence {
  return { importedNames, namespaceImport, sideEffectImport, allSpecifiersTypeOnly };
}

function isLiteralDynamicImport(node: ts.Node): node is ts.CallExpression & { arguments: [ts.StringLiteralLike, ...ts.Expression[]] } {
  if (!isDynamicImport(node)) return false;
  const firstArgument = node.arguments[0];
  return firstArgument !== undefined && ts.isStringLiteralLike(firstArgument);
}

function isNonLiteralDynamicImport(node: ts.Node): boolean {
  return isDynamicImport(node) && (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]));
}

function isDynamicImport(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function addImportCandidate(
  config: Config,
  file: SourceFileRecord,
  fromId: string,
  sourceFile: ts.SourceFile,
  result: ImportExtraction,
  candidate: ImportCandidate,
): void {
  const addUnsupported = (kind: string, message: string) =>
    result.unsupportedPatterns.push(unsupportedPattern(file, sourceFile, candidate.node, kind, message));
  if (candidate.wildcardReExport) {
    addUnsupported("wildcard_re_export", `Wildcard re-export from "${candidate.specifier}" can hide dependency fan-out.`);
  }
  const normalized = normalizeImportPath(file.path, candidate.specifier, config);
  if (normalized.kind === "external" && isAliasSpecifier(config, candidate.specifier)) {
    addUnsupported("unresolved_path_alias", `Could not resolve aliased import "${candidate.specifier}".`);
  }
  result.imports.push({
    from: fromId,
    to: normalized.id,
    to_kind: normalized.kind === "external" ? "external" : normalized.kind === "relative" ? "relative" : "unresolved",
    resolved: normalized.resolved,
    specifier: candidate.specifier,
    import_kind: candidate.importKind,
    imported_names: candidate.importedNames,
    namespace_import: candidate.namespaceImport,
    side_effect_import: candidate.sideEffectImport,
    line: lineForNode(sourceFile, candidate.node),
    source: candidate.node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180),
  });
}

function unsupportedPattern(
  file: SourceFileRecord,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kind: ConfidenceSignal["kind"],
  message: string,
): ConfidenceSignal {
  return { kind, file: file.relativePath, line: lineForNode(sourceFile, node), message };
}

function isAliasSpecifier(config: Config, specifier: string): boolean {
  return config.pathAliases.some((alias) => aliasPatternMatches(specifier, alias.pattern));
}

function aliasPatternMatches(specifier: string, pattern: string): boolean {
  if (!pattern.includes("*")) return specifier === pattern;
  const [prefix = "", suffix = ""] = pattern.split("*");
  return specifier.startsWith(prefix) && specifier.endsWith(suffix);
}

function extractFunctions(file: SourceFileRecord, sourceFile: ts.SourceFile): FunctionRecord[] {
  const records: FunctionRecord[] = [];

  function addFunction(name: string, node: ts.Node, bodyNode: ts.Node): void {
    const body = bodyNode.getText(sourceFile);
    const line = lineForNode(sourceFile, node);
    const lines = lineSpanForNode(sourceFile, bodyNode);
    const jsxDensity = countJsxElements(bodyNode);
    const hooks = countCallsMatching(bodyNode, /^use[A-Z][A-Za-z0-9_]*$/);
    const effects = countCallsMatching(bodyNode, /^use(?:Effect|LayoutEffect|InsertionEffect)$/);
    const jsxConditionals = countJsxConditionals(bodyNode);
    const kind = classifyFunction(name, body, jsxDensity);
    const cyclomaticComplexity = complexityForNode(bodyNode);
    const cognitiveComplexity = cognitiveComplexityForNode(bodyNode);
    const halstead = halsteadMetricsForNode(bodyNode);
    records.push({
      id: `${file.relativePath}:${name}:${line}`,
      name,
      kind,
      line,
      lines,
      complexity: cyclomaticComplexity,
      cyclomatic_complexity: cyclomaticComplexity,
      cognitive_complexity: cognitiveComplexity,
      halstead_effort: halstead.effort,
      nesting_depth: maxNestingDepthForNode(bodyNode),
      jsx_density: jsxDensity,
      hooks,
      effects,
      jsxConditionals,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.body) {
      addFunction(node.name?.text ?? "default", node, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      addFunction(node.name.text, node, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return dedupeBy(records, (record) => record.id);
}

function extractTypes(file: SourceFileRecord, sourceFile: ts.SourceFile): TypeRecord[] {
  const records: TypeRecord[] = [];

  function addType(
    node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration,
    kind: TypeRecord["kind"],
    name: string,
    typeBody: ts.Node,
  ): void {
    const body = typeBody.getText(sourceFile);
    records.push({
      name,
      kind,
      exported: hasExportModifier(node),
      line: lineForNode(sourceFile, node),
      field_count: countTypeFieldsForNode(typeBody),
      optional_count: countOptionalTypeFields(typeBody),
      union_members: countUnionMembers(typeBody),
      generic_params: node.typeParameters?.length ?? 0,
      body,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      addType(node, "interface", node.name.text, node);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addType(node, "type", node.name.text, node.type);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addType(node, "class", node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records;
}

function extractExports(sourceFile: ts.SourceFile): ExportRecord[] {
  return dedupeBy(
    sourceFile.statements.flatMap((statement) => exportRecordsForStatement(sourceFile, statement)),
    (record) => record.name,
  );
}

function exportRecordsForStatement(sourceFile: ts.SourceFile, statement: ts.Statement): ExportRecord[] {
  const name = exportedDeclarationName(statement);
  if (name) return [{ name, line: lineForNode(sourceFile, statement) }];
  if (ts.isVariableStatement(statement) && hasExportModifier(statement)) return variableExportRecords(sourceFile, statement);
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    return statement.exportClause.elements.map((element) => ({ name: element.name.text, line: lineForNode(sourceFile, element) }));
  }
  if (ts.isExportAssignment(statement)) {
    return [{ name: statement.isExportEquals ? "export=" : "default", line: lineForNode(sourceFile, statement) }];
  }
  return [];
}

function exportedDeclarationName(node: ts.Statement): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    if (!hasExportModifier(node)) return null;
    return hasDefaultModifier(node) ? "default" : node.name?.text ?? null;
  }
  return null;
}

function variableExportRecords(sourceFile: ts.SourceFile, statement: ts.VariableStatement): ExportRecord[] {
  return statement.declarationList.declarations
    .filter((declaration) => ts.isIdentifier(declaration.name))
    .map((declaration) => ({ name: declaration.name.getText(sourceFile), line: lineForNode(sourceFile, declaration) }));
}

function parseSourceFile(file: SourceFileRecord): ts.SourceFile {
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindForExtension(file.extension));
}

function scriptKindForExtension(extension: string): ts.ScriptKind {
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function lineSpanForNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  return end - start + 1;
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.HasModifiers): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.getModifiers?.(node)?.some((modifier) => modifier.kind === kind));
}

function classifyFunction(name: string, body: string, jsxDensity: number): FunctionRecord["kind"] {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name) && (jsxDensity > 0 || /\bReact\./.test(body))) return "component";
  if (/\bswitch\s*\([^)]*(?:state|action)/.test(body) || /\bcase\s+["']/.test(body)) return "reducer";
  return "function";
}

function isBarrel(sourceFile: ts.SourceFile): boolean {
  const statements = sourceFile.statements.filter((statement) => statement.kind !== ts.SyntaxKind.NotEmittedStatement);
  return (
    statements.length > 0 &&
    statements.some((statement) => ts.isExportDeclaration(statement)) &&
    statements.every((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
  );
}

function countAstEscapeHatches(file: SourceFileRecord, sourceFile: ts.SourceFile) {
  const counts = {
    any: 0,
    assertions: 0,
    suppressions: countMatches(file.text, /@ts-(?:ignore|expect-error|nocheck)|eslint-disable/g),
  };
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) counts.any += 1;
    if (ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) counts.assertions += 1;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return counts;
}

function countJsxElements(node: ts.Node): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function countCallsMatching(node: ts.Node, namePattern: RegExp): number {
  let count = 0;
  function visit(current: ts.Node): void {
    if (ts.isCallExpression(current)) {
      const name = callExpressionName(current);
      if (name && namePattern.test(name)) count += 1;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}
