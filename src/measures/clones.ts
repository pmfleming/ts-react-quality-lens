import { analysisConfidence, artifactBase, cloneGroup, cloneGroupFromBlocks, createAnalysisContext, groupBy, jscpdCloneGroup, normalizeCloneLine, sourceSetHash, stableHash, writeArtifact } from "../measure-shared.js";
import * as ts from "typescript";
import type { AnalysisContext, CloneBlock, CloneGroup, CloneInstance, Config, ProjectAnalysis } from "../types.js";

export function measureClones(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const jscpd = context.jscpd();
  const jscpdGroups = jscpd.ran ? jscpd.duplicates.map((duplicate, index) => jscpdCloneGroup(config, duplicate, index)) : [];
  const rawHeuristicGroups = jscpd.ran ? [] : heuristicCloneGroups(project);
  const heuristicGroups = dedupeCloneRegions(rawHeuristicGroups);
  const astGroups = structuralCloneGroups(project);
  const groups = dedupeCloneRegions([...jscpdGroups, ...heuristicGroups, ...astGroups]).sort((left, right) => right.score - left.score);
  const artifact = {
    ...artifactBase(
      config,
      "quality.clones",
      command,
      analysisConfidence(config, project, {
        jscpd_available: jscpd.available,
        jscpd_ran: jscpd.ran,
      }),
      sourceSetHash(project),
    ),
    summary: {
      clone_groups: groups.length,
      jscpd_clone_groups: jscpdGroups.length,
      heuristic_clone_groups: heuristicGroups.length,
      ast_clone_groups: astGroups.length,
      source_clone_groups: groups.filter((group) => !group.test_code).length,
      test_clone_groups: groups.filter((group) => group.test_code).length,
    },
    tool_status: {
      jscpd: {
        available: jscpd.available,
        ran: jscpd.ran,
        reason: jscpd.reason ?? null,
        statistics: jscpd.statistics ?? {},
      },
    },
    groups,
  };
  writeArtifact(config, "clones.json", artifact);
  return artifact;
}

function structuralCloneGroups(project: ProjectAnalysis): CloneGroup[] {
  const blocks = project.modules.flatMap((module) => structuralCloneBlocks(module.astSourceFile, module.file, module.sourceFile.isTest));
  return [...groupBy(blocks, (block) => block.hash).values()]
    .filter((group) => group.length > 1)
    .map(astCloneGroup)
    .sort((left, right) => right.score - left.score);
}

function structuralCloneBlocks(sourceFile: ts.SourceFile | undefined, file: string, testCode: boolean): CloneBlock[] {
  if (!sourceFile) return [];
  const astSourceFile = sourceFile;
  const blocks: CloneBlock[] = [];
  function visit(node: ts.Node): void {
    const body = functionBody(node);
    if (body) {
      const normalized = normalizeAst(body);
      const nodeCount = normalized.split(" ").length;
      if (nodeCount >= 18) {
        blocks.push({
          hash: stableHash(normalized),
          normalized,
          file,
          start_line: astSourceFile.getLineAndCharacterOfPosition(body.getStart(astSourceFile)).line + 1,
          end_line: astSourceFile.getLineAndCharacterOfPosition(body.getEnd()).line + 1,
          test_code: testCode,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(astSourceFile);
  return blocks;
}

function astCloneGroup(group: CloneBlock[]): CloneGroup {
  return cloneGroupFromBlocks(group, {
    idPrefix: "ast-clone",
    engine: "ast",
    extraSignals: [{ kind: "confidence_scope", value: "syntax_facts" }],
    weights: { block: 12, file: 18, source: 12 },
  });
}

function functionBody(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
    return node.body ?? null;
  }
  return null;
}

function normalizeAst(node: ts.Node): string {
  const parts: string[] = [];
  function visit(current: ts.Node): void {
    if (ts.isIdentifier(current)) {
      parts.push("Identifier");
      return;
    }
    if (ts.isStringLiteralLike(current) || current.kind === ts.SyntaxKind.NumericLiteral) {
      parts.push("Literal");
      return;
    }
    parts.push(ts.SyntaxKind[current.kind] ?? String(current.kind));
    ts.forEachChild(current, visit);
  }
  visit(node);
  return parts.join(" ");
}

function heuristicCloneGroups(project: { sourceFiles: Array<{ lines: string[]; relativePath: string; isTest: boolean }>; testFiles: Array<{ lines: string[]; relativePath: string; isTest: boolean }> }): CloneGroup[] {
  const blocks: CloneBlock[] = [];
  for (const file of [...project.sourceFiles, ...project.testFiles]) {
    const relevantLines = file.lines
      .map((line, index) => ({ index: index + 1, text: line.trim() }))
      .filter((line) => line.text && !line.text.startsWith("//") && !line.text.startsWith("*"));
    for (let index = 0; index <= relevantLines.length - 6; index += 1) {
      const lineWindow = relevantLines.slice(index, index + 6);
      const lastLine = lineWindow.at(-1);
      if (!lineWindow[0] || !lastLine) continue;
      const normalized = lineWindow.map((line) => normalizeCloneLine(line.text)).join("\n");
      if (normalized.length < 80) continue;
      blocks.push({
        hash: stableHash(normalized),
        normalized,
        file: file.relativePath,
        start_line: lineWindow[0].index,
        end_line: lastLine.index,
        test_code: file.isTest,
      });
    }
  }
  return [...groupBy(blocks, (block) => block.hash).values()]
    .map(nonOverlappingBlocks)
    .filter((group) => new Set(group.map((block) => `${block.file}:${block.start_line}`)).size > 1)
    .map((group) => cloneGroup(group))
    .sort((left, right) => right.score - left.score);
}

function nonOverlappingBlocks(group: CloneBlock[]): CloneBlock[] {
  const blocks = [...group].sort((left, right) => left.file.localeCompare(right.file) || left.start_line - right.start_line);
  const result: CloneBlock[] = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous?.file === block.file && block.start_line <= previous.end_line) continue;
    result.push(block);
  }
  return result;
}

function dedupeCloneRegions(groups: CloneGroup[]): CloneGroup[] {
  const selected: CloneGroup[] = [];
  for (const group of groups.sort((left, right) => right.score - left.score)) {
    if (!selected.some((existing) => sameCloneRegion(group, existing))) selected.push(group);
  }
  return selected;
}

function sameCloneRegion(left: CloneGroup, right: CloneGroup): boolean {
  return left.instances.every((instance) =>
    right.instances.some((other) => instance.file === other.file && rangesOverlap(instance, other)),
  );
}

function rangesOverlap(left: CloneInstance, right: CloneInstance): boolean {
  if (left.start_line === null || left.end_line === null || right.start_line === null || right.end_line === null) {
    return false;
  }
  return left.start_line <= right.end_line && right.start_line <= left.end_line;
}
