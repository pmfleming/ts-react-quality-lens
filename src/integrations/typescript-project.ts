import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as tsTypes from "typescript";
import { relativeModuleId, toPosix } from "../files.js";
import type {
  Config,
  DiagnosticRecord,
  SourceFileRecord,
  TypedDeclaration,
  TypedModuleRecord,
  TypeScriptProject,
} from "../types.js";

const require = createRequire(import.meta.url);

type ParsedConfigResult =
  | { parsed: tsTypes.ParsedCommandLine; failure?: never }
  | { parsed?: never; failure: TypeScriptProject };

export function loadTypeScriptProject(config: Config, sourceFiles: SourceFileRecord[]): TypeScriptProject {
  const ts = loadTypeScript();
  if (!ts) return unloadedProject(false, "typescript package is not installed");
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
  return {
    parsed: ts.parseJsonConfigFileContent(parsedJson.config, ts.sys, path.dirname(configPath), {}, configPath),
  };
}

function createTypedProject(
  ts: typeof tsTypes,
  config: Config,
  sourceFiles: SourceFileRecord[],
  parsed: tsTypes.ParsedCommandLine,
): TypeScriptProject {
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  return {
    available: true,
    loaded: true,
    reason: null,
    compiler_options: compilerOptionSummary(parsed.options),
    diagnostics: ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnosticRecord(ts, diagnostic, config.projectRoot)),
    modules: collectTypedModules(ts, config, sourceFiles, program, checker),
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
  const record = { file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)), exports, declarations };
  Object.defineProperty(record, "sourceFile", { value: sourceFile, enumerable: false });
  return record;

  function visit(node: tsTypes.Node): void {
    if (isNamedDeclarationNode(ts, node)) declarations.push(typedDeclaration(ts, checker, sourceFile, node));
    ts.forEachChild(node, visit);
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
  return {
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    file,
    line: lineChar ? lineChar.line + 1 : null,
    character: lineChar ? lineChar.character + 1 : null,
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
    useUnknownInCatchVariables: Boolean(options.useUnknownInCatchVariables || options.strict),
    declaration: Boolean(options.declaration),
    isolatedDeclarations: Boolean(options.isolatedDeclarations),
    verbatimModuleSyntax: Boolean(options.verbatimModuleSyntax),
    jsx: options.jsx,
    moduleResolution: options.moduleResolution,
    target: options.target,
  };
}

function flattenMessage(ts: typeof tsTypes, message: string | tsTypes.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, "\n");
}

function loadTypeScript(): typeof tsTypes | null {
  try {
    return require("typescript");
  } catch {
    return null;
  }
}
