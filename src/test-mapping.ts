import path from "node:path";
import * as ts from "typescript";
import { discoverWorkspaces } from "./workspaces.js";
import type { Config, ModuleRecord, SourceFileRecord, TestAssociation } from "./types.js";

type CompilerConfig = { directory: string; parsed: ts.ParsedCommandLine };

export function createTestMapper(config: Config, modules: ModuleRecord[]) {
  const moduleFiles = new Map(modules.map((module) => [path.resolve(module.absolutePath), module.file]));
  const compilerConfigs = discoverWorkspaces(config).tsconfigPaths.flatMap((item): CompilerConfig[] => {
    const parsed = ts.getParsedCommandLineOfConfigFile(item.path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    return parsed ? [{ directory: path.dirname(item.path), parsed }] : [];
  }).sort((left, right) => right.directory.length - left.directory.length);
  const resolutionCaches = new WeakMap<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const fallbackOptions: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Node10, allowJs: true };

  return (file: SourceFileRecord): { source: ts.SourceFile; associations: TestAssociation[] } => {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const compiler = compilerConfigs.find((item) => item.parsed.fileNames.includes(file.path)) ??
      compilerConfigs.find((item) => withinDirectory(item.directory, file.path));
    const options = compiler?.parsed.options ?? fallbackOptions;
    let resolutionCache = resolutionCaches.get(options);
    if (!resolutionCache) {
      resolutionCache = ts.createModuleResolutionCache(config.projectRoot, (file) => file, options);
      resolutionCaches.set(options, resolutionCache);
    }
    const associations: TestAssociation[] = [];
    const sameStem = file.relativePath.replace(/(?:\.test|\.spec|\.e2e)?\.[cm]?[jt]sx?$/, "")
      .replace(/(^|\/)__tests__\//, "$1");
    for (const module of modules) if (module.id === sameStem) {
      associations.push({ file: module.file, kind: "filename", confidence: "low" });
    }
    const addImport = (specifier: string, typeOnly: boolean) => {
      const resolved = ts.resolveModuleName(specifier, file.path, options, ts.sys, resolutionCache).resolvedModule;
      const target = resolved ? moduleFiles.get(path.resolve(resolved.resolvedFileName)) : null;
      if (target) associations.push({ file: target, kind: typeOnly ? "type-only-import" : "direct-import", confidence: "high" });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
        addImport(node.moduleSpecifier.text, Boolean(typeOnly));
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        addImport(node.moduleReference.expression.text, node.isTypeOnly);
      } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        addImport(node.arguments[0].text, false);
      }
      node.forEachChild(visit);
    };
    visit(source);
    return { source, associations: [...new Map(associations.map((item) => [`${item.file}:${item.kind}`, item])).values()] };
  };
}

export function directTestSources(test: { source_associations?: TestAssociation[] }): string[] {
  return (test.source_associations ?? []).filter((association) => association.kind === "direct-import").map((association) => association.file);
}

function withinDirectory(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
