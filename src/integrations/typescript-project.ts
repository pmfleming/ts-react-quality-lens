import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { dedupeBy, isRecord } from "../collections.js";
import { trackCompilerInputs } from "./compiler-inputs.js";
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
  | { parsed: ts.ParsedCommandLine; failure?: never }
  | { parsed?: never; failure: TypeScriptProject };

export function loadTypeScriptProjects(
  config: Config,
  sourceFiles: SourceFileRecord[],
  projectConfigs: Array<{ workspaceId: string; path: string }>,
): TypeScriptProject {
  const uniqueConfigs = dedupeBy(projectConfigs, (item) => path.resolve(item.path));
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
  const loaded = projects.every(({ project }) => project.loaded);
  return {
    available: projects.every(({ project }) => project.available),
    loaded,
    reason: loaded ? null : projects.filter(({ project }) => !project.loaded).map(({ item, project }) =>
      `${toPosix(path.relative(config.projectRoot, item.path))}: ${project.reason ?? "project did not load"}`).join("; "),
    diagnostics: [...diagnostics.values()],
    input_files: [...new Set(projects.flatMap(({ project }) => project.input_files ?? []))],
    input_queries: projects.flatMap(({ project }) => project.input_queries ?? []),
    modules,
    ...firstCompilerOptions(projects),
    type_coverage: summarizeCoverage(files),
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
  if (!config.tsconfig || !fs.existsSync(config.tsconfig)) return unloadedProject(true, "tsconfig was not found");
  try {
    const inputs = trackCompilerInputs();
    const result = parseCompilerConfig(config, inputs.system);
    return result.failure ?? createTypedProject(config, sourceFiles, result.parsed, inputs);
  } catch (error) {
    return unloadedProject(true, error instanceof Error ? error.message : String(error));
  }
}

function parseCompilerConfig(config: Config, system: ts.System): ParsedConfigResult {
  const configPath = config.tsconfig;
  if (!configPath) return { failure: unloadedProject(true, "tsconfig was not found") };
  const configText = system.readFile(configPath);
  if (configText === undefined) return { failure: unloadedProject(true, "tsconfig could not be read") };
  const parsedJson = ts.parseConfigFileTextToJson(configPath, configText);
  if (parsedJson.error) {
    return {
      failure: unloadedProject(true, flattenMessage(parsedJson.error.messageText), [
        diagnosticRecord(parsedJson.error, config.projectRoot),
      ]),
    };
  }
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, system, path.dirname(configPath), {}, configPath);
  if (parsed.errors.length) {
    return {
      failure: unloadedProject(true, "TypeScript configuration is invalid", parsed.errors.map((diagnostic) =>
        diagnosticRecord(diagnostic, config.projectRoot))),
    };
  }
  return { parsed };
}

function createTypedProject(
  config: Config,
  sourceFiles: SourceFileRecord[],
  parsed: ts.ParsedCommandLine,
  inputs: ReturnType<typeof trackCompilerInputs>,
): TypeScriptProject {
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  Object.assign(host, {
    readFile: inputs.system.readFile,
    fileExists: inputs.system.fileExists,
    directoryExists: inputs.system.directoryExists,
    getDirectories: inputs.system.getDirectories,
    readDirectory: inputs.system.readDirectory,
    ...(inputs.system.realpath ? { realpath: inputs.system.realpath } : {}),
  });
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
    host,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  const checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnosticRecord(diagnostic, config.projectRoot));
  return {
    available: true,
    loaded: true,
    reason: null,
    compiler_options: compilerOptionSummary(parsed.options),
    input_files: [...new Set([
      ...program.getSourceFiles().map((file) => path.resolve(file.fileName)),
      ...[...inputs.files].map((file) => path.resolve(file)),
    ])],
    input_queries: [...inputs.queries.values()],
    diagnostics,
    modules: collectTypedModules(config, sourceFiles, program, checker),
    type_coverage: collectTypeCoverage(config, sourceFiles, program, checker),
  };
}

function collectTypedModules(
  config: Config,
  sourceFiles: SourceFileRecord[],
  program: ts.Program,
  checker: ts.TypeChecker,
): Map<string, TypedModuleRecord> {
  const wanted = new Set(sourceFiles.map((file) => path.resolve(file.path).toLowerCase()));
  const modules = new Map<string, TypedModuleRecord>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !wanted.has(path.resolve(sourceFile.fileName).toLowerCase())) continue;
    modules.set(
      relativeModuleId(config.projectRoot, sourceFile.fileName),
      typedModuleRecord(checker, config, sourceFile),
    );
  }
  return modules;
}

function collectTypeCoverage(
  config: Config,
  sourceFiles: SourceFileRecord[],
  program: ts.Program,
  checker: ts.TypeChecker,
): { summary: TypeCoverageSummary; files: TypeCoverageFile[] } {
  const wanted = new Set(sourceFiles.map((file) => path.resolve(file.path).toLowerCase()));
  const files = program.getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && wanted.has(path.resolve(sourceFile.fileName).toLowerCase()))
    .map((sourceFile) => typeCoverageForFile(checker, config, sourceFile));
  return summarizeCoverage(files);
}

function summarizeCoverage(files: TypeCoverageFile[]): { summary: TypeCoverageSummary; files: TypeCoverageFile[] } {
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
  checker: ts.TypeChecker,
  config: Config,
  sourceFile: ts.SourceFile,
): TypeCoverageFile {
  const counts = emptyCoverageCounts();
  visit(sourceFile);
  return {
    file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)),
    ...counts,
    type_coverage_percent: coveragePercent(counts.typed_symbols, counts.analyzed_symbols),
  };

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && countableIdentifier(node)) classifyIdentifier(checker, node, counts);
    ts.forEachChild(node, visit);
  }
}

function emptyCoverageCounts() {
  return { analyzed_symbols: 0, typed_symbols: 0, explicit_any: 0, inferred_any: 0, error_types: 0, unknown: 0 };
}

function classifyIdentifier(
  checker: ts.TypeChecker,
  node: ts.Identifier,
  counts: ReturnType<typeof emptyCoverageCounts>,
): void {
  try {
    const type = checker.getTypeAtLocation(node);
    counts.analyzed_symbols += 1;
    if ((type.flags & ts.TypeFlags.Any) !== 0) {
      const intrinsicName = isRecord(type) && typeof type.intrinsicName === "string" ? type.intrinsicName : null;
      if (intrinsicName === "error") counts.error_types += 1;
      else if (symbolHasExplicitAny(checker.getSymbolAtLocation(node))) counts.explicit_any += 1;
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

function symbolHasExplicitAny(symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some((declaration) => {
    const typeNode = declarationTypeNode(declaration);
    return typeNode ? containsAnyKeyword(typeNode) : false;
  }) ?? false;
}

function declarationTypeNode(declaration: ts.Declaration): ts.TypeNode | undefined {
  if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) || ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    return declaration.type;
  }
  return undefined;
}

function containsAnyKeyword(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.AnyKeyword) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsAnyKeyword(child)) found = true;
  });
  return found;
}

const IGNORED_IDENTIFIER_PARENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.ExportSpecifier, ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport, ts.SyntaxKind.TypeReference, ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.QualifiedName, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.JsxOpeningElement,
  ts.SyntaxKind.JsxClosingElement, ts.SyntaxKind.JsxSelfClosingElement, ts.SyntaxKind.JsxAttribute,
]);

function countableIdentifier(node: ts.Identifier): boolean {
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
  checker: ts.TypeChecker,
  config: Config,
  sourceFile: ts.SourceFile,
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

  function visit(node: ts.Node): void {
    if (isNamedDeclarationNode(node)) declarations.push(typedDeclaration(checker, sourceFile, node));
    ts.forEachChild(node, visit);
  }
}

function moduleSurfaceTypeReferences(checker: ts.TypeChecker, sourceFile: ts.SourceFile): string[] {
  const references = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    visit(statement);
  }
  return [...references].sort();

  function visit(node: ts.Node): void {
    if (ts.isBlock(node)) return;
    if (ts.isTypeReferenceNode(node)) addLocalSymbol(node.typeName);
    if (ts.isExpressionWithTypeArguments(node)) addLocalSymbol(node.expression);
    if (ts.isTypeQueryNode(node)) addLocalSymbol(node.exprName);
    ts.forEachChild(node, visit);
  }

  function addLocalSymbol(node: ts.Node): void {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile)) references.add(symbol.getName());
  }
}

function moduleExports(checker: ts.TypeChecker, sourceFile: ts.SourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  return moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).map((symbol) => ({
        name: symbol.getName(),
        type: safeTypeString(checker, symbol),
      }))
    : [];
}

function typedDeclaration(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Declaration & { name: ts.Identifier },
): TypedDeclaration {
  const symbol = checker.getSymbolAtLocation(node.name);
  return {
    name: node.name.text,
    kind: ts.SyntaxKind[node.kind],
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    type: symbol ? safeTypeString(checker, symbol, node) : null,
    exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
  };
}

function diagnosticRecord(diagnostic: ts.Diagnostic, projectRoot: string): DiagnosticRecord {
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
    message: flattenMessage(diagnostic.messageText),
  };
}

function isNamedDeclarationNode(
  node: ts.Node,
): node is ts.Declaration & { name: ts.Identifier } {
  const named = ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node);
  return named && Boolean(node.name && ts.isIdentifier(node.name));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function safeTypeString(checker: ts.TypeChecker, symbol: ts.Symbol, node?: ts.Node): string | null {
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

function compilerOptionSummary(options: ts.CompilerOptions) {
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

function flattenMessage(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, "\n");
}
