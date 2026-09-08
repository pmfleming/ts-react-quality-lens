import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import type { Config, ScoredRecord } from "./types.js";

export function suppressionEdit(config: Config, finding: ScoredRecord): unknown | null {
  if (!fs.existsSync(config.configPath) || finding.suppressed) return null;
  const text = fs.readFileSync(config.configPath, "utf8");
  if (ts.parseConfigFileTextToJson(config.configPath, text).error) return null;
  const source = ts.parseJsonText(config.configPath, text);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) return null;
  const object = statement.expression;
  const property = object.properties.find((item) => ts.isPropertyAssignment(item) &&
    item.name && (ts.isStringLiteral(item.name) || ts.isIdentifier(item.name)) && item.name.text === "suppressions");
  const array = property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer)
    ? property.initializer : null;
  if (property && !array) return null;
  const value = JSON.stringify({ id: finding.id, reason: "Intentional finding; document the project-specific reason." });
  const container = array ?? object;
  const elements = array ? array.elements : object.properties;
  const last = elements.at(-1);
  const insertions = [
    ...(last && !elements.hasTrailingComma ? [{ offset: last.end, text: "," }] : []),
    { offset: container.end - 1, text: array ? `\n    ${value}\n  ` : `\n  "suppressions": [${value}]\n` },
  ];
  return {
    changes: {
      [pathToFileURL(config.configPath).href]: insertions.map((insertion) => {
        const position = source.getLineAndCharacterOfPosition(insertion.offset);
        return { range: { start: position, end: position }, newText: insertion.text };
      }),
    },
  };
}
