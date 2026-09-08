import fs from "node:fs";
import path from "node:path";
import * as tsTypes from "typescript";
import { isRecord } from "../collections.js";
import { relativeModuleId, toPosix } from "../files.js";
import type {
  Config,
  DiagnosticRecord,
  SourceFileRecord,
  TypedDeclaration,
  TypedModuleRecord,
  TypeCoverageFile,
  TypeCoverageSummary,
  TypeScriptProject,
} from "../types.js";

type LoadedWorkspaceProject = {
  item: { workspaceId: string; path: string };
  project: TypeScriptProject;
};

type ParsedConfigResult =
  | { parsed: tsTypes.ParsedCommandLine; failure?: never }
  | { parsed?: never; failure: TypeScriptProject };

export function loadTypeScriptProjects(
  config: Config,
  sourceFiles: SourceFileRecord[],
  projectConfigs: Array<{ workspaceId: string; path: string }>,
): TypeScriptProject {
  const uniqueConfigs = projectConfigs.filter((item, index, values) =>
    values.findIndex((candidate) => path.resolve(candidate.path) === path.resolve(item.path)) === index);
  if (!uniqueConfigs.length) return loadTypeScriptProject(config, sourceFiles);
  const projects: LoadedWorkspaceProject[] = uniqueConfigs.map((item) => ({
    item,
    project: loadTypeScriptProject({ ...config, tsconfig: item.path }, sourceFiles),
  }));
  const modules = new Map<string, TypedModuleRecord>();
  const diagnostics = new Map<string, DiagnosticRecord>();
  const coverageFiles = new Map<string, TypeCoverageFile>();
  for (const { project } of projects) {
    for (const [id, module] of project.modules) modules.set(id, module);
    for (const diagnostic of project.diagnostics) {
      diagnostics.set(`${diagnostic.code}:${diagnostic.file}:${diagnostic.line}:${diagnostic.character}:${diagnostic.message}`, diagnostic);
    }
    for (const file of project.type_coverage?.files ?? []) coverageFiles.set(file.file, file);
  }
  const files = [...coverageFiles.values()];
  const totals = files.reduce((result, file) => ({
    analyzed_symbols: result.analyzed_symbols + file.analyzed_symbols,
    typed_symbols: result.typed_symbols + file.typed_symbols,
    explicit_any: result.explicit_any + file.explicit_any,
    inferred_any: result.inferred_any + file.inferred_any,
    error_types: result.error_types + file.error_types,
    unknown: result.unknown + file.unknown,
  }), emptyCoverageCounts());
  const loaded = projects.every(({ project }) => project.loaded);
  return {
    available: projects.every(({ project }) => project.available),
    loaded,
    reason: loaded ? null : projects.filter(({ project }) => !project.loaded).map(({ item, project }) =>
      `${toPosix(path.relative(config.projectRoot, item.path))}: ${project.reason ?? "project did not load"}`).join("; "),
    diagnostics: [...diagnostics.values()],
    input_files: [...new Set(projects.flatMap(({ project }) => project.input_files ?? []))],
    modules,
    ...firstCompilerOptions(projects),
    type_coverage: {
      summary: {
        files: files.length,
        ...totals,
        type_coverage_percent: coveragePercent(totals.typed_symbols, totals.analyzed_symbols),
      },
      files,
    },
    project_configs: projects.map(({ item, project }) => ({
      tsconfig: toPosix(path.relative(config.projectRoot, item.path)),
      workspace_id: item.workspaceId,
      loaded: project.loaded,
      reason: project.reason,
    })),
  };
}

function firstCompilerOptions(projects: LoadedWorkspaceProject[]): Pick<TypeScriptProject, "compiler_options"> | {} {
  const options = projects.find(({ project }) => project.compiler_options)?.project.compiler_options;
  return options ? { compiler_options: options } : {};
}

function loadTypeScriptProject(config: Config, sourceFiles: SourceFileRecord[]): TypeScriptProject {
  const ts = tsTypes;
  if (!config.tsconfig || !fs.existsSync(config.tsconfig)) return unloadedProject(true, "tsconfig was not found");
  try {
    const result = parseCompilerConfig(ts, config);
    return result.failure ?? createTypedProject(ts, config, sourceFiles, result.parsed);
  } catch (error) {
    return unloadedProject(true, error instanceof Error ? error.message : String(error));
  }
}

function parseCompilerConfig(ts: typeof tsTypes, config: Config): ParsedConfigResult {
  const configPath = config.tsconfig;
  if (!configPath) return { failure: unloadedProject(true, "tsconfig was not found") };
  const configText = ts.sys.readFile(configPath);
  if (configText === undefined) return { failure: unloadedProject(true, "tsconfig could not be read") };
  const parsedJson = ts.parseConfigFileTextToJson(configPath, configText);
  if (parsedJson.error) {
    return {
      failure: unloadedProject(true, flattenMessage(ts, parsedJson.error.messageText), [
        diagnosticRecord(ts, parsedJson.error, config.projectRoot),
      ]),
    };
  }
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, path.dirname(configPath), {}, configPath);
  if (parsed.errors.length) {
    return {
      failure: unloadedProject(true, "TypeScript configuration is invalid", parsed.errors.map((diagnostic) =>
        diagnosticRecord(ts, diagnostic, config.projectRoot))),
    };
  }
  return { parsed };
}

function createTypedProject(
  ts: typeof tsTypes,
  config: Config,
  sourceFiles: SourceFileRecord[],
  parsed: tsTypes.ParsedCommandLine,
): TypeScriptProject {
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  const checker = program.getTypeChecker();
  return {
    available: true,
    loaded: true,
    reason: null,
    compiler_options: compilerOptionSummary(parsed.options),
    input_files: program.getSourceFiles().map((file) => path.resolve(file.fileName)),
    diagnostics: ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnosticRecord(ts, diagnostic, config.projectRoot)),
    modules: collectTypedModules(ts, config, sourceFiles, program, checker),
    type_coverage: collectTypeCoverage(ts, config, sourceFiles, program, checker),
  };
}

function collectTypedModules(
  ts: typeof tsTypes,
  config: Config,
  sourceFiles: SourceFileRecord[],
  program: tsTypes.Program,
  checker: tsTypes.TypeChecker,
): Map<string, TypedModuleRecord> {
  const wanted = new Set(sourceFiles.map((file) => path.resolve(file.path).toLowerCase()));
  const modules = new Map<string, TypedModuleRecord>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !wanted.has(path.resolve(sourceFile.fileName).toLowerCase())) continue;
    modules.set(
      relativeModuleId(config.projectRoot, sourceFile.fileName),
      typedModuleRecord(ts, checker, config, sourceFile),
    );
  }
  return modules;
}

function collectTypeCoverage(
  ts: typeof tsTypes,
  config: Config,
  sourceFiles: SourceFileRecord[],
  program: tsTypes.Program,
  checker: tsTypes.TypeChecker,
): { summary: TypeCoverageSummary; files: TypeCoverageFile[] } {
  const wanted = new Set(sourceFiles.map((file) => path.resolve(file.path).toLowerCase()));
  const files = program.getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && wanted.has(path.resolve(sourceFile.fileName).toLowerCase()))
    .map((sourceFile) => typeCoverageForFile(ts, checker, config, sourceFile));
  const totals = files.reduce((result, file) => ({
    analyzed_symbols: result.analyzed_symbols + file.analyzed_symbols,
    typed_symbols: result.typed_symbols + file.typed_symbols,
    explicit_any: result.explicit_any + file.explicit_any,
    inferred_any: result.inferred_any + file.inferred_any,
    error_types: result.error_types + file.error_types,
    unknown: result.unknown + file.unknown,
  }), emptyCoverageCounts());
  return {
    summary: {
      files: files.length,
      ...totals,
      type_coverage_percent: coveragePercent(totals.typed_symbols, totals.analyzed_symbols),
    },
    files,
  };
}

function typeCoverageForFile(
  ts: typeof tsTypes,
  checker: tsTypes.TypeChecker,
  config: Config,
  sourceFile: tsTypes.SourceFile,
): TypeCoverageFile {
  const counts = emptyCoverageCounts();
  visit(sourceFile);
  return {
    file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)),
    ...counts,
    type_coverage_percent: coveragePercent(counts.typed_symbols, counts.analyzed_symbols),
  };

  function visit(node: tsTypes.Node): void {
    if (ts.isIdentifier(node) && countableIdentifier(ts, node)) classifyIdentifier(ts, checker, node, counts);
    ts.forEachChild(node, visit);
  }
}

function emptyCoverageCounts() {
  return { analyzed_symbols: 0, typed_symbols: 0, explicit_any: 0, inferred_any: 0, error_types: 0, unknown: 0 };
}

function classifyIdentifier(
  ts: typeof tsTypes,
  checker: tsTypes.TypeChecker,
  node: tsTypes.Identifier,
  counts: ReturnType<typeof emptyCoverageCounts>,
): void {
  try {
    const type = checker.getTypeAtLocation(node);
    counts.analyzed_symbols += 1;
    if ((type.flags & ts.TypeFlags.Any) !== 0) {
      const intrinsicName = isRecord(type) && typeof type.intrinsicName === "string" ? type.intrinsicName : null;
      if (intrinsicName === "error") counts.error_types += 1;
      else if (symbolHasExplicitAny(ts, checker.getSymbolAtLocation(node))) counts.explicit_any += 1;
      else counts.inferred_any += 1;
      return;
    }
    counts.typed_symbols += 1;
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) counts.unknown += 1;
  } catch {
    counts.analyzed_symbols += 1;
    counts.error_types += 1;
  }
}

function symbolHasExplicitAny(ts: typeof tsTypes, symbol: tsTypes.Symbol | undefined): boolean {
  return symbol?.declarations?.some((declaration) => {
    const typeNode = declarationTypeNode(ts, declaration);
    return typeNode ? containsAnyKeyword(ts, typeNode) : false;
  }) ?? false;
}

function declarationTypeNode(ts: typeof tsTypes, declaration: tsTypes.Declaration): tsTypes.TypeNode | undefined {
  if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) || ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    return declaration.type;
  }
  return undefined;
}

function containsAnyKeyword(ts: typeof tsTypes, node: tsTypes.Node): boolean {
  if (node.kind === ts.SyntaxKind.AnyKeyword) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsAnyKeyword(ts, child)) found = true;
  });
  return found;
}

const IGNORED_IDENTIFIER_PARENTS = new Set<tsTypes.SyntaxKind>([
  tsTypes.SyntaxKind.ImportSpecifier, tsTypes.SyntaxKind.ExportSpecifier, tsTypes.SyntaxKind.ImportClause,
  tsTypes.SyntaxKind.NamespaceImport, tsTypes.SyntaxKind.TypeReference, tsTypes.SyntaxKind.TypeQuery,
  tsTypes.SyntaxKind.QualifiedName, tsTypes.SyntaxKind.TypeParameter, tsTypes.SyntaxKind.JsxOpeningElement,
  tsTypes.SyntaxKind.JsxClosingElement, tsTypes.SyntaxKind.JsxSelfClosingElement, tsTypes.SyntaxKind.JsxAttribute,
]);

function countableIdentifier(ts: typeof tsTypes, node: tsTypes.Identifier): boolean {
  const parent = node.parent;
  if (IGNORED_IDENTIFIER_PARENTS.has(parent.kind)) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== node;
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return parent.name !== node;
  return !(ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isClassDeclaration(parent)) || parent.name !== node;
}

function coveragePercent(typed: number, analyzed: number): number {
  return analyzed === 0 ? 100 : Math.round((typed / analyzed) * 10_000) / 100;
}

function unloadedProject(available: boolean, reason: string, diagnostics: DiagnosticRecord[] = []): TypeScriptProject {
  return { available, loaded: false, reason, diagnostics, modules: new Map() };
}

function typedModuleRecord(
  ts: typeof tsTypes,
  checker: tsTypes.TypeChecker,
  config: Config,
  sourceFile: tsTypes.SourceFile,
): TypedModuleRecord {
  const exports = moduleExports(checker, sourceFile);
  const declarations: TypedDeclaration[] = [];
  visit(sourceFile);
  const record = {
    file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)),
    exports,
    declarations,
    surface_type_references: moduleSurfaceTypeReferences(checker, sourceFile),
  };
  Object.defineProperty(record, "sourceFile", { value: sourceFile, enumerable: false });
  return record;

  function visit(node: tsTypes.Node): void {
    if (isNamedDeclarationNode(ts, node)) declarations.push(typedDeclaration(ts, checker, sourceFile, node));
    ts.forEachChild(node, visit);
  }
}

function moduleSurfaceTypeReferences(checker: tsTypes.TypeChecker, sourceFile: tsTypes.SourceFile): string[] {
  const references = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!hasModifier(tsTypes, statement, tsTypes.SyntaxKind.ExportKeyword)) continue;
    visit(statement);
  }
  return [...references].sort();

  function visit(node: tsTypes.Node): void {
    if (tsTypes.isBlock(node)) return;
    if (tsTypes.isTypeReferenceNode(node)) addLocalSymbol(node.typeName);
    if (tsTypes.isExpressionWithTypeArguments(node)) addLocalSymbol(node.expression);
    if (tsTypes.isTypeQueryNode(node)) addLocalSymbol(node.exprName);
    tsTypes.forEachChild(node, visit);
  }

  function addLocalSymbol(node: tsTypes.Node): void {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile)) references.add(symbol.getName());
  }
}

function moduleExports(checker: tsTypes.TypeChecker, sourceFile: tsTypes.SourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  return moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).map((symbol) => ({
        name: symbol.getName(),
        type: safeTypeString(checker, symbol),
      }))
    : [];
}

function typedDeclaration(
  ts: typeof tsTypes,
  checker: tsTypes.TypeChecker,
  sourceFile: tsTypes.SourceFile,
  node: tsTypes.Declaration & { name: tsTypes.Identifier },
): TypedDeclaration {
  const symbol = checker.getSymbolAtLocation(node.name);
  return {
    name: node.name.text,
    kind: ts.SyntaxKind[node.kind],
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    type: symbol ? safeTypeString(checker, symbol, node) : null,
    exported: hasModifier(ts, node, ts.SyntaxKind.ExportKeyword),
  };
}

function diagnosticRecord(ts: typeof tsTypes, diagnostic: tsTypes.Diagnostic, projectRoot: string): DiagnosticRecord {
  const file = diagnostic.file?.fileName ? toPosix(path.relative(projectRoot, diagnostic.file.fileName)) : null;
  const lineChar = diagnostic.file && typeof diagnostic.start === "number"
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : null;
  const endLineChar = diagnostic.file && typeof diagnostic.start === "number"
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + (diagnostic.length ?? 0))
    : null;
  return {
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    file,
    line: lineChar ? lineChar.line + 1 : null,
    character: lineChar ? lineChar.character + 1 : null,
    end_line: endLineChar ? endLineChar.line + 1 : null,
    end_character: endLineChar ? endLineChar.character + 1 : null,
    message: flattenMessage(ts, diagnostic.messageText),
  };
}

function isNamedDeclarationNode(
  ts: typeof tsTypes,
  node: tsTypes.Node,
): node is tsTypes.Declaration & { name: tsTypes.Identifier } {
  const named = ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node);
  return named && Boolean(node.name && ts.isIdentifier(node.name));
}

function hasModifier(ts: typeof tsTypes, node: tsTypes.Node, kind: tsTypes.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function safeTypeString(checker: tsTypes.TypeChecker, symbol: tsTypes.Symbol, node?: tsTypes.Node): string | null {
  try {
    const declaration = node ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return null;
    const type = symbol.valueDeclaration || node
      ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
      : checker.getDeclaredTypeOfSymbol(symbol);
    return checker.typeToString(type);
  } catch {
    return null;
  }
}

function compilerOptionSummary(options: tsTypes.CompilerOptions) {
  return {
    strict: Boolean(options.strict),
    noImplicitAny: Boolean(options.noImplicitAny || options.strict),
    strictNullChecks: Boolean(options.strictNullChecks || options.strict),
    noUncheckedIndexedAccess: Boolean(options.noUncheckedIndexedAccess),
    exactOptionalPropertyTypes: Boolean(options.exactOptionalPropertyTypes),
    noImplicitOverride: Boolean(options.noImplicitOverride),
    noImplicitReturns: Boolean(options.noImplicitReturns),
    noFallthroughCasesInSwitch: Boolean(options.noFallthroughCasesInSwitch),
    forceConsistentCasingInFileNames: Boolean(options.forceConsistentCasingInFileNames),
    noPropertyAccessFromIndexSignature: Boolean(options.noPropertyAccessFromIndexSignature),
    noUncheckedSideEffectImports: Boolean(options.noUncheckedSideEffectImports),
    useUnknownInCatchVariables: Boolean(options.useUnknownInCatchVariables || options.strict),
    verbatimModuleSyntax: Boolean(options.verbatimModuleSyntax),
    erasableSyntaxOnly: Boolean(options.erasableSyntaxOnly),
    declaration: Boolean(options.declaration),
    isolatedDeclarations: Boolean(options.isolatedDeclarations),
    jsx: options.jsx,
    moduleResolution: options.moduleResolution,
    target: options.target,
  };
}

function flattenMessage(ts: typeof tsTypes, message: string | tsTypes.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, "\n");
}
