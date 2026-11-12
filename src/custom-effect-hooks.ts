import * as ts from "typescript";
import { discoverSourceFiles, readSourceFile } from "./files.js";
import type { Config } from "./types.js";

/** Syntactic inventory only; ESLint owns dependency and Hooks verdicts. */
export function customEffectHookCalls(config: Config): Array<{ name: string; file: string; line: number }> {
  if (!config.react.additionalEffectHooks) return [];
  const pattern = new RegExp(config.react.additionalEffectHooks);
  return discoverSourceFiles(config).filter((file) => /\.[jt]sx?$/.test(file)).flatMap((file) => {
    const input = readSourceFile(file, config.projectRoot);
    const source = ts.createSourceFile(file, input.text, ts.ScriptTarget.Latest, true);
    const matches: Array<{ name: string; file: string; line: number }> = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && pattern.test(node.expression.text)) {
        matches.push({ name: node.expression.text, file: input.relativePath, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return matches;
  });
}
