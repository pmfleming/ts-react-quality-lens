import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { relativeModuleId, toPosix } from "./files.mjs";

const require = createRequire(import.meta.url);

export function loadTypeScriptProject(config, sourceFiles) {
  const ts = requireOptional("typescript");
  if (!ts) {
    return {
      available: false,
      loaded: false,
      reason: "typescript package is not installed",
      diagnostics: [],
      modules: new Map(),
    };
  }
  if (!config.tsconfig || !fs.existsSync(config.tsconfig)) {
    return {
      available: true,
      loaded: false,
      reason: "tsconfig was not found",
      diagnostics: [],
      modules: new Map(),
    };
  }

  try {
    const configText = ts.sys.readFile(config.tsconfig);
    const parsedJson = ts.parseConfigFileTextToJson(config.tsconfig, configText);
    if (parsedJson.error) {
      return {
        available: true,
        loaded: false,
        reason: flattenTsMessage(ts, parsedJson.error.messageText),
        diagnostics: [diagnosticRecord(ts, parsedJson.error, config.projectRoot)],
        modules: new Map(),
      };
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
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
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
    return {
      available: true,
      loaded: false,
      reason: error instanceof Error ? error.message : String(error),
      diagnostics: [],
      modules: new Map(),
    };
  }
}

export function runDependencyCruiser(config) {
  const executable = localBin(config.projectRoot, "depcruise");
  if (!executable) {
    return { available: false, ran: false, reason: "dependency-cruiser executable was not found" };
  }
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
  try {
    const stdout = runLocalTool(executable, args, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    const json = JSON.parse(stdout);
    return {
      available: true,
      ran: true,
      reason: null,
      modules: json.modules ?? [],
      summary: json.summary ?? {},
    };
  } catch (error) {
    return {
      available: true,
      ran: false,
      reason: toolError(error),
      modules: [],
      summary: {},
    };
  }
}

export function runJscpd(config) {
  const executable = localBin(config.projectRoot, "jscpd");
  if (!executable) {
    return { available: false, ran: false, reason: "jscpd executable was not found", duplicates: [] };
  }
  const outputDir = path.join(config.outputDir, ".tooling", "jscpd");
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
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
    "--silent",
    "--exitCode",
    "0",
    ...existingAbsoluteRoots(config),
  ];
  try {
    runLocalTool(executable, args, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    const reportPath = path.join(outputDir, "jscpd-report.json");
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : {};
    return {
      available: true,
      ran: true,
      reason: null,
      duplicates: report.duplicates ?? [],
      statistics: report.statistics ?? {},
    };
  } catch (error) {
    return {
      available: true,
      ran: false,
      reason: toolError(error),
      duplicates: [],
      statistics: {},
    };
  }
}

export function runReactHooksLint(config) {
  const executable = localBin(config.projectRoot, "eslint");
  if (!executable) {
    return { available: false, ran: false, reason: "eslint executable was not found", messages: [] };
  }
  const configPath = path.join(config.outputDir, ".tooling", "eslint-react-hooks.config.mjs");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".next/**", "target/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
];
`,
    "utf8",
  );
  const args = [
    "--config",
    configPath,
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    ...existingRelativeRoots(config),
  ];
  try {
    const stdout = runLocalTool(executable, args, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return {
      available: true,
      ran: true,
      reason: null,
      messages: normalizeEslintMessages(JSON.parse(stdout), config),
    };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    if (stdout.trim().startsWith("[")) {
      return {
        available: true,
        ran: true,
        reason: null,
        messages: normalizeEslintMessages(JSON.parse(stdout), config),
      };
    }
    return {
      available: true,
      ran: false,
      reason: toolError(error),
      messages: [],
    };
  }
}

export function detectFrameworkDetails(config, project) {
  const files = new Set(project.sourceFiles.map((file) => file.relativePath));
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

function typedModuleRecord(ts, checker, program, config, sourceFile) {
  const exports = [];
  const declarations = [];
  const imports = [];
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

  return {
    file: toPosix(path.relative(config.projectRoot, sourceFile.fileName)),
    exports,
    declarations,
    imports,
  };

  function visit(node) {
    if (isDeclarationNode(ts, node) && node.name && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      declarations.push({
        name: node.name.text,
        kind: ts.SyntaxKind[node.kind],
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        type: symbol ? safeTypeString(checker, symbol, node) : null,
        exported: hasModifier(ts, node, ts.SyntaxKind.ExportKeyword),
      });
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = ts.resolveModuleName(
        node.moduleSpecifier.text,
        sourceFile.fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule;
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        resolved_file: resolved?.resolvedFileName ? toPosix(path.relative(config.projectRoot, resolved.resolvedFileName)) : null,
        external: Boolean(resolved?.isExternalLibraryImport),
      });
    }
    ts.forEachChild(node, visit);
  }
}

function diagnosticRecord(ts, diagnostic, projectRoot) {
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

function isDeclarationNode(ts, node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node)
  );
}

function hasModifier(ts, node, kind) {
  return Boolean(ts.getModifiers?.(node)?.some((modifier) => modifier.kind === kind));
}

function safeTypeString(checker, symbol, node) {
  try {
    const declaration = node ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
    const type =
      symbol.valueDeclaration || node
        ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
        : checker.getDeclaredTypeOfSymbol(symbol);
    return checker.typeToString(type);
  } catch {
    return null;
  }
}

function flattenTsMessage(ts, messageText) {
  return ts.flattenDiagnosticMessageText(messageText, "\n");
}

function compilerOptionSummary(options) {
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

function localBin(projectRoot, name) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const names = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  for (const root of [projectRoot, repoRoot]) {
    for (const candidate of names.map((binName) => path.join(root, "node_modules", ".bin", binName))) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function existingAbsoluteRoots(config) {
  return config.sourceRoots.filter((root) => fs.existsSync(root));
}

function existingRelativeRoots(config) {
  return existingAbsoluteRoots(config).map((root) => toPosix(path.relative(config.projectRoot, root)) || ".");
}

function normalizeEslintMessages(results, config) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId?.startsWith("react-hooks/"))
      .map((message) => ({
        file: toPosix(path.relative(config.projectRoot, result.filePath)),
        line: message.line ?? null,
        column: message.column ?? null,
        rule_id: message.ruleId,
        severity: message.severity === 2 ? "error" : "warning",
        message: message.message,
      })),
  );
}

function requireOptional(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function runLocalTool(executable, args, options) {
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    const commandLine = [executable, ...args].map(quoteWindowsArg).join(" ");
    return childProcess.execFileSync("cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return childProcess.execFileSync(executable, args, {
    ...options,
  });
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[ \t"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toolError(error) {
  const stderr = String(error.stderr ?? "").trim();
  const stdout = String(error.stdout ?? "").trim();
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || stdout || message).slice(0, 4000);
}
