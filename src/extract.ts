import * as ts from "typescript";
import { normalizeImportPath, relativeModuleId } from "./files.js";
import {
  complexityForNode,
  countJsxConditionals,
  countOptionalTypeFields,
  countTypeFieldsForNode,
  countUnionMembers,
  maxNestingDepthForNode,
} from "./ast-metrics.js";
import { countMatches, dedupeBy } from "./collections.js";
import { callExpressionName, lineForNode } from "./ts-ast.js";

export function analyzeModule(config, file, tsProject) {
  const id = relativeModuleId(config.projectRoot, file.path);
  const typed = tsProject.modules.get(id) ?? null;
  const sourceFile = typed?.sourceFile ?? parseSourceFile(file);
  const imports = extractImports(config, file, id, sourceFile);
  const functions = extractFunctions(file, sourceFile);
  const types = extractTypes(file, sourceFile);
  const exports = extractExports(file, sourceFile);
  const components = functions.filter((fn) => fn.kind === "component");
  const escapeCounts = {
    any: countMatches(file.text, /\bany\b/g),
    assertions: countMatches(file.text, /\bas\s+(?:any|never|unknown|[A-Z_a-z])/g) + countMatches(file.text, /!\./g),
    suppressions: countMatches(file.text, /@ts-(?:ignore|expect-error|nocheck)|eslint-disable/g),
  };
  const record = {
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
    isBarrel: isBarrel(file),
    typed,
    text: file.text,
    sourceFile: file,
  };
  Object.defineProperty(record, "astSourceFile", {
    value: sourceFile,
    enumerable: false,
  });
  return record;
}

function extractImports(config, file, fromId, sourceFile) {
  const imports = [];

  function addImport(specifier, node, importKind) {
    const normalized = normalizeImportPath(file.path, specifier, config);
    imports.push({
      from: fromId,
      to: normalized.id,
      to_kind: normalized.kind === "external" ? "external" : normalized.kind === "relative" ? "relative" : "unresolved",
      resolved: normalized.resolved,
      specifier,
      import_kind: importKind,
      line: lineForNode(sourceFile, node),
      source: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180),
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, node, node.importClause?.isTypeOnly ? "type" : "static");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addImport(node.moduleSpecifier.text, node, node.isTypeOnly ? "type" : "static");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      addImport(node.arguments[0].text, node, "dynamic");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function extractFunctions(file, sourceFile) {
  const records = [];

  function addFunction(name, node, bodyNode = node.body ?? node) {
    const body = bodyNode.getText(sourceFile);
    const line = lineForNode(sourceFile, node);
    const lines = lineSpanForNode(sourceFile, bodyNode);
    const jsxDensity = countJsxElements(bodyNode);
    const hooks = countCallsMatching(bodyNode, /^use[A-Z][A-Za-z0-9_]*$/);
    const effects = countCallsMatching(bodyNode, /^use(?:Effect|LayoutEffect|InsertionEffect)$/);
    const jsxConditionals = countJsxConditionals(bodyNode);
    const kind = classifyFunction(name, body, jsxDensity);
    records.push({
      id: `${file.relativePath}:${name}:${line}`,
      name,
      kind,
      line,
      lines,
      complexity: complexityForNode(bodyNode),
      nesting_depth: maxNestingDepthForNode(bodyNode),
      jsx_density: jsxDensity,
      hooks,
      effects,
      jsxConditionals,
    });
  }

  function visit(node) {
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

function extractTypes(file, sourceFile) {
  const records = [];

  function addType(node, kind, name, typeBody) {
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

  function visit(node) {
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

function extractExports(file, sourceFile) {
  const records = [];

  function addNamedExport(name, node) {
    records.push({ name, line: lineForNode(sourceFile, node) });
  }

  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      hasExportModifier(node) &&
      node.name
    ) {
      addNamedExport(node.name.text, node);
    } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addNamedExport(declaration.name.text, declaration);
      }
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        addNamedExport(element.name.text, element);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records;
}

function parseSourceFile(file) {
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindForExtension(file.extension));
}

function scriptKindForExtension(extension) {
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

function lineSpanForNode(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  return end - start + 1;
}

function hasExportModifier(node) {
  return Boolean(ts.getModifiers?.(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function classifyFunction(name, body, jsxDensity) {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name) && (jsxDensity > 0 || /\bReact\./.test(body))) return "component";
  if (/\bswitch\s*\([^)]*(?:state|action)/.test(body) || /\bcase\s+["']/.test(body)) return "reducer";
  return "function";
}

function isBarrel(file) {
  const statements = file.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  return statements.length > 1 && statements.every((line) => line.startsWith("export "));
}

function countJsxElements(node) {
  let count = 0;
  function visit(current) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

function countCallsMatching(node, namePattern) {
  let count = 0;
  function visit(current) {
    if (ts.isCallExpression(current)) {
      const name = callExpressionName(current);
      if (name && namePattern.test(name)) count += 1;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}
