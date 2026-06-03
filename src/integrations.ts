import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as tsTypes from "typescript";
import { relativeModuleId, toPosix } from "./files.js";
import type {
  Config,
  DependencyCruiserResult,
  DiagnosticRecord,
  EslintReactHooksResult,
  JscpdResult,
  SourceFileRecord,
  TypedDeclaration,
  TypedModuleRecord,
  TypeScriptProject,
} from "./types.js";

const require = createRequire(import.meta.url);
const TOOL_TIMEOUT_MS = 120000;

type ExecError = Error & { stdout?: unknown; stderr?: unknown; status?: number };
type ToolRunOptions = childProcess.ExecFileSyncOptionsWithStringEncoding;

export function loadTypeScriptProject(config: Config, sourceFiles: SourceFileRecord[]): TypeScriptProject {
  const ts = requireOptional("typescript");
  if (!ts) {
    return unloadedTypeScriptProject(false, "typescript package is not installed");
  }
  if (!config.tsconfig || !fs.existsSync(config.tsconfig)) {
    return unloadedTypeScriptProject(true, "tsconfig was not found");
  }

  try {
    const configText = ts.sys.readFile(config.tsconfig);
    if (configText === undefined) return unloadedTypeScriptProject(true, "tsconfig could not be read");
    const parsedJson = ts.parseConfigFileTextToJson(config.tsconfig, configText);
    if (parsedJson.error) {
      return unloadedTypeScriptProject(true, flattenTsMessage(ts, parsedJson.error.messageText), [
        diagnosticRecord(ts, parsedJson.error, config.projectRoot),
      ]);
    }
    const parsed = ts.parseJsonConfigFileContent(
      parsedJson.config,
      ts.sys,
      path.dirname(config.tsconfig),
      {},
      config.tsconfig,
    );
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        noEmit: true,
      },
    });
    const checker = program.getTypeChecker();
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic: tsTypes.Diagnostic) =>
      diagnosticRecord(ts, diagnostic, config.projectRoot),
    );
    const wanted = new Set(sourceFiles.map((file) => path.resolve(file.path).toLowerCase()));
    const modules = new Map();
    for (const sourceFile of program.getSourceFiles()) {
      const normalized = path.resolve(sourceFile.fileName).toLowerCase();
      if (sourceFile.isDeclarationFile || !wanted.has(normalized)) continue;
      modules.set(
        relativeModuleId(config.projectRoot, sourceFile.fileName),
        typedModuleRecord(ts, checker, program, config, sourceFile),
      );
    }
    return {
      available: true,
      loaded: true,
      reason: null,
      compiler_options: compilerOptionSummary(parsed.options),
      diagnostics,
      modules,
    };
  } catch (error) {
    return unloadedTypeScriptProject(true, error instanceof Error ? error.message : String(error));
  }
}

function unloadedTypeScriptProject(
  available: boolean,
  reason: string,
  diagnostics: DiagnosticRecord[] = [],
): TypeScriptProject {
  return {
    available,
    loaded: false,
    reason,
    diagnostics,
    modules: new Map(),
  };
}

export function runDependencyCruiser(config: Config): DependencyCruiserResult {
  const args = [
    "--no-config",
    "--output-type",
    "json",
    "--output-to",
    "-",
    "--progress",
    "none",
    ...existingRelativeRoots(config),
  ];
  return runToolAdapter(
    config,
    "depcruise",
    "dependency-cruiser executable was not found",
    { modules: [], summary: {} },
    (executable: string) => {
      const stdout = runLocalTool(executable, args, {
        cwd: config.projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TOOL_TIMEOUT_MS,
      });
      const json = JSON.parse(stdout);
      return {
        modules: json.modules ?? [],
        summary: json.summary ?? {},
      };
    },
  );
}

export function runJscpd(config: Config): JscpdResult {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-jscpd-${process.pid}-`));
  const args = [
    "--reporters",
    "json",
    "--output",
    outputDir,
    "--min-lines",
    "5",
    "--min-tokens",
    "45",
    "--format",
    "typescript,javascript,tsx,jsx",
    "--exitCode",
    "0",
    ...existingRelativeRoots(config),
  ];
  return runToolAdapter(
    config,
    "jscpd",
    "jscpd executable was not found",
    { duplicates: [], statistics: {} },
    (executable: string) => {
      try {
        runLocalTool(executable, args, {
          cwd: config.projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: TOOL_TIMEOUT_MS,
        });
        const reportPath = path.join(outputDir, "jscpd-report.json");
        const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {};
        return {
          duplicates: report.duplicates ?? [],
          statistics: report.statistics ?? {},
        };
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
    },
  );
}

export function runReactHooksLint(config: Config): EslintReactHooksResult {
  const toolingDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-eslint-${process.pid}-`));
  const configPath = path.join(toolingDir, "eslint-react-hooks.config.mjs");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const projectPackageUrl = packageJsonUrl(config.projectRoot);
  const toolPackageUrl = packageJsonUrl(repoRoot());
  fs.writeFileSync(configPath, reactHooksConfig(projectPackageUrl, toolPackageUrl), "utf8");
  const args = [
    "--config",
    configPath,
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    ...existingRelativeRoots(config),
  ];
  return runToolAdapter(
    config,
    "eslint",
    "eslint executable was not found",
    { messages: [] },
    (executable: string) => {
      try {
        const stdout = runLocalTool(executable, args, {
          cwd: config.projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: TOOL_TIMEOUT_MS,
        });
        return { messages: normalizeEslintMessages(JSON.parse(stdout), config) };
      } finally {
        fs.rmSync(toolingDir, { recursive: true, force: true });
      }
    },
    (error: ExecError) => {
      const stdout = String(error.stdout ?? "");
      try {
        return stdout.trim().startsWith("[") ? { messages: normalizeEslintMessages(JSON.parse(stdout), config) } : null;
      } finally {
        fs.rmSync(toolingDir, { recursive: true, force: true });
      }
    },
  );
}

function reactHooksConfig(projectPackageUrl: string, toolPackageUrl: string): string {
  return `import { createRequire } from "node:module";
const projectRequire = createRequire(${JSON.stringify(projectPackageUrl)});
const toolRequire = createRequire(${JSON.stringify(toolPackageUrl)});
function requireTool(name) { try { return projectRequire(name); } catch { return toolRequire(name); } }
const reactHooks = requireTool("eslint-plugin-react-hooks");
const tsParser = requireTool("@typescript-eslint/parser");
export default [{
  files: ["**/*.{js,jsx,ts,tsx}"], ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: "latest", sourceType: "module" } },
  plugins: { "react-hooks": reactHooks },
  rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" }
}];
`;
}

function runToolAdapter<T extends Record<string, unknown>>(
  config: Config,
  executableName: string,
  missingReason: string,
  empty: T,
  run: (executable: string) => T,
  recover: ((error: ExecError) => T | null) | null = null,
) {
  const executable = localBin(config.projectRoot, executableName);
  if (!executable) {
    return { available: false, ran: false, reason: missingReason, ...empty };
  }
  try {
    return { available: true, ran: true, reason: null, ...run(executable) };
  } catch (error) {
    const execError = error as ExecError;
    const recovered = recover?.(execError);
    if (recovered) return { available: true, ran: true, reason: null, ...recovered };
    return { available: true, ran: false, reason: toolError(execError), ...empty };
  }
}

export function detectFrameworkDetails(
  config: Config,
  project: { sourceFiles: SourceFileRecord[]; testFiles: SourceFileRecord[]; modules: Array<{ file: string }>; imports: unknown[] },
) {
  const files = new Set<string>(project.sourceFiles.map((file) => file.relativePath));
  const appRoutes = [...files].filter((file) => /(?:^|\/)app\/.*(?:page|layout|route|loading|error)\.[jt]sx?$/.test(file));
  const pagesRoutes = [...files].filter((file) => /(?:^|\/)pages\/.*\.[jt]sx?$/.test(file));
  const remixRoutes = [...files].filter((file) => /(?:^|\/)routes\/.*\.[jt]sx?$/.test(file));
  const stories = [...files].filter((file) => /\.stories\.[jt]sx?$/.test(file));
  const clientComponents = project.sourceFiles
    .filter((file) => file.text.trimStart().startsWith('"use client"') || file.text.trimStart().startsWith("'use client'"))
    .map((file) => file.relativePath);
  const serverOnlySignals = project.sourceFiles
    .filter((file) => /\b(?:fs|node:fs|process\.env)\b/.test(file.text))
    .map((file) => file.relativePath);
  const routeRecords = [
    ...appRoutes.map((file) => ({ kind: "next_app_route", file })),
    ...pagesRoutes.map((file) => ({ kind: "next_pages_route", file })),
    ...remixRoutes.map((file) => ({ kind: "remix_route", file })),
  ];
  return {
    framework: config.framework,
    routes: routeRecords,
    stories,
    client_components: clientComponents,
    server_only_signals: serverOnlySignals,
    conventions: {
      next_app_router: appRoutes.length > 0,
      next_pages_router: pagesRoutes.length > 0,
      remix_routes: remixRoutes.length > 0,
      storybook: stories.length > 0,
    },
  };
}

function typedModuleRecord(
  ts: typeof tsTypes,
  checker: tsTypes.TypeChecker,
  program: tsTypes.Program,
  config: Config,
  sourceFile: tsTypes.SourceFile,
): TypedModuleRecord {
  void program;
  const exports = [];
  const declarations: TypedDeclaration[] = [];
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      exports.push({
        name: symbol.getName(),
        type: safeTypeString(checker, symbol, undefined),
      });
    }
  }

  visit(sourceFile);

  const record = {
    file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)),
    exports,
    declarations,
  };
  Object.defineProperty(record, "sourceFile", {
    value: sourceFile,
    enumerable: false,
  });
  return record;

  function visit(node: tsTypes.Node): void {
    if (isNamedDeclarationNode(ts, node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      declarations.push({
        name: node.name.text,
        kind: ts.SyntaxKind[node.kind],
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        type: symbol ? safeTypeString(checker, symbol, node) : null,
        exported: hasModifier(ts, node, ts.SyntaxKind.ExportKeyword),
      });
    }
    ts.forEachChild(node, visit);
  }
}

function diagnosticRecord(ts: typeof tsTypes, diagnostic: tsTypes.Diagnostic, projectRoot: string): DiagnosticRecord {
  const file = diagnostic.file?.fileName ? toPosix(path.relative(projectRoot, diagnostic.file.fileName)) : null;
  const lineChar =
    diagnostic.file && typeof diagnostic.start === "number"
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
  return {
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    file,
    line: lineChar ? lineChar.line + 1 : null,
    character: lineChar ? lineChar.character + 1 : null,
    message: flattenTsMessage(ts, diagnostic.messageText),
  };
}

function isNamedDeclarationNode(
  ts: typeof tsTypes,
  node: tsTypes.Node,
): node is tsTypes.Declaration & { name: tsTypes.Identifier } {
  if (
    !(
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isVariableDeclaration(node)
    )
  ) {
    return false;
  }
  const name = node.name;
  return Boolean(name && ts.isIdentifier(name));
}

function hasModifier(ts: typeof tsTypes, node: tsTypes.Node, kind: tsTypes.SyntaxKind): boolean {
  return Boolean(ts.getModifiers?.(node as tsTypes.HasModifiers)?.some((modifier) => modifier.kind === kind));
}

function safeTypeString(checker: tsTypes.TypeChecker, symbol: tsTypes.Symbol, node?: tsTypes.Node): string | null {
  try {
    const declaration = node ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return null;
    const type =
      symbol.valueDeclaration || node
        ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
        : checker.getDeclaredTypeOfSymbol(symbol);
    return checker.typeToString(type);
  } catch {
    return null;
  }
}

function flattenTsMessage(ts: typeof tsTypes, messageText: string | tsTypes.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(messageText, "\n");
}

function compilerOptionSummary(options: tsTypes.CompilerOptions) {
  return {
    strict: Boolean(options.strict),
    noImplicitAny: Boolean(options.noImplicitAny || options.strict),
    strictNullChecks: Boolean(options.strictNullChecks || options.strict),
    noUncheckedIndexedAccess: Boolean(options.noUncheckedIndexedAccess),
    exactOptionalPropertyTypes: Boolean(options.exactOptionalPropertyTypes),
    jsx: options.jsx,
    moduleResolution: options.moduleResolution,
    target: options.target,
  };
}

function localBin(projectRoot: string, name: string): string | null {
  const names = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  for (const root of [projectRoot, repoRoot()]) {
    for (const candidate of names.map((binName) => path.join(root, "node_modules", ".bin", binName))) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function packageJsonUrl(root: string): string {
  return pathToFileURL(path.join(root, "package.json")).href;
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function existingAbsoluteRoots(config: Config): string[] {
  return config.sourceRoots.filter((root) => fs.existsSync(root));
}

function existingRelativeRoots(config: Config): string[] {
  return existingAbsoluteRoots(config).map((root) => toPosix(path.relative(config.projectRoot, root)) || ".");
}

function normalizeEslintMessages(results: Array<{ filePath: string; messages: Array<{ ruleId?: string; line?: number; column?: number; severity?: number; message: string }> }>, config: Config) {
  return results.flatMap((result) =>
    result.messages
      .filter((message): message is { ruleId: string; line?: number; column?: number; severity?: number; message: string } =>
        Boolean(message.ruleId?.startsWith("react-hooks/")),
      )
      .map((message) => ({
        file: toPosix(path.relative(config.projectRoot, result.filePath)),
        line: message.line ?? null,
        column: message.column ?? null,
        rule_id: message.ruleId,
        severity: message.severity === 2 ? "error" as const : "warning" as const,
        message: message.message,
      })),
  );
}

function requireOptional(name: "typescript"): typeof tsTypes | null;
function requireOptional(name: string): unknown;
function requireOptional(name: string): unknown {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function runLocalTool(executable: string, args: string[], options: ToolRunOptions): string {
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    const commandLine = [executable, ...args].map(quoteWindowsArg).join(" ");
    return childProcess.execFileSync("cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return childProcess.execFileSync(executable, args, {
    ...options,
  });
}

function quoteWindowsArg(value: string): string {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toolError(error: ExecError): string {
  const stderr = String(error.stderr ?? "").trim();
  const stdout = String(error.stdout ?? "").trim();
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || stdout || message).slice(0, 4000);
}
