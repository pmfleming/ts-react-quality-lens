import * as ts from "typescript";

/** Fresh, locally bound ASTs without loading libraries or resolving external packages. */
export function syntaxProgram(modules: Array<{ absolutePath: string; text: string }>): ts.Program {
  const sources = new Map(modules.map((module) => [sourceKey(module.absolutePath), module.text]));
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file, languageVersion) => {
    const text = sources.get(sourceKey(file));
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  return ts.createProgram(modules.map((module) => module.absolutePath), options, host);
}

/** The compiler normalizes root names to "/" before asking the host, including on Windows. */
function sourceKey(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}
