import childProcess from "node:child_process";
import path from "node:path";
import { isRecord } from "./collections.js";
import * as ts from "typescript";
import { createTestMapper } from "./test-mapping.js";
import type { Config, ModuleRecord, SourceFileRecord, TestExecution, TestRecord } from "./types.js";

export function testRecord(
  config: Config,
  file: SourceFileRecord,
  modules: ModuleRecord[],
  mapper = createTestMapper(config, modules),
): TestRecord {
  const { source, associations } = mapper(file);
  const sourceMapping = [...new Set(associations.filter((item) => item.kind !== "type-only-import").map((item) => item.file))];
  return {
    id: `test:${file.relativePath}`,
    name: path.basename(file.relativePath),
    path: file.relativePath,
    framework: inferTestFramework(config, file.text),
    locality: associations.some((item) => item.kind === "filename") ? "colocated" : "external",
    source_mapping: sourceMapping,
    source_associations: associations,
    coverage_status: "not_collected",
    ...testSyntaxCounts(source),
  };
}

export function runTestCommand(config: Config): TestExecution {
  if (!config.testCommand) return { status: "unknown", reason: "No test command configured." };
  try {
    // Config files are trusted input: test commands intentionally run with the project shell.
    childProcess.execSync(config.testCommand, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
      env: { ...process.env, PATH: `${path.join(config.projectRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}` },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: "passed", command: config.testCommand };
  } catch (error) {
    const execError = isRecord(error) ? error : {};
    return {
      status: "failed",
      command: config.testCommand,
      exit_code: typeof execError.status === "number" ? execError.status : null,
      stderr: String(execError.stderr ?? "").slice(0, 4000),
      stdout: String(execError.stdout ?? "").slice(0, 4000),
    };
  }
}

function testSyntaxCounts(source: ts.SourceFile): Pick<TestRecord, "assertions" | "skipped" | "todo"> {
  const counts = { assertions: 0, skipped: 0, todo: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const root = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
      if (ts.isIdentifier(root) && ["expect", "assert", "should"].includes(root.text)) counts.assertions += 1;
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(root) && ["it", "test", "describe"].includes(root.text)) {
        if (expression.name.text === "skip") counts.skipped += 1;
        if (expression.name.text === "todo" && root.text !== "describe") counts.todo += 1;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return counts;
}

function inferTestFramework(config: Config, text: string): string {
  if (config.testRunner !== "unknown") return config.testRunner;
  if (/\bimport\s+\{[^}]*test[^}]*\}\s+from\s+["']node:test/.test(text)) return "node";
  if (/\bvi\./.test(text)) return "vitest";
  if (/\bjest\./.test(text)) return "jest";
  return "unknown";
}
