import assert from "node:assert/strict";
import test from "node:test";
import { syntaxProgram } from "../src/syntax-program.js";

test("syntax programs bind Windows-style module paths that the compiler normalizes", () => {
  const modules = [
    { absolutePath: "C:\\project\\src\\a.ts", text: "export const a = 1;\n" },
    { absolutePath: "C:\\project\\src\\View.tsx", text: "export const View = () => <div />;\n" },
  ];
  const program = syntaxProgram(modules);
  for (const module of modules) {
    const source = program.getSourceFile(module.absolutePath);
    assert.ok(source, `${module.absolutePath} must be part of the syntax program`);
    assert.equal(source.text, module.text);
  }
  assert.equal(program.getRootFileNames().length, 2);
});
