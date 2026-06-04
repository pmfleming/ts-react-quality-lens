import { analysisConfidence, artifactBase, cloneGroup, cloneGroupFromBlocks, createAnalysisContext, groupBy, jscpdCloneGroup, normalizeCloneLine, riskForScore, sourceSetHash, stableHash, writeArtifact } from "../measure-shared.js";
import * as ts from "typescript";
import type { AnalysisContext, CloneBlock, CloneGroup, CloneInstance, Config, EntryPointRole, ModuleRecord, ProjectAnalysis, ScoredRecord } from "../types.js";

type PurposeCandidate = {
  category: "export" | "component" | "hook";
  purposeKey: string;
  purposeTerms: string[];
  moduleId: string;
  file: string;
  name: string;
  line: number | null;
  signature: string | null;
  exported: boolean;
  entrypointRoles: EntryPointRole[];
};

export function measureClones(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const jscpd = context.jscpd();
  const jscpdGroups = jscpd.ran ? jscpd.duplicates.map((duplicate, index) => jscpdCloneGroup(config, duplicate, index)) : [];
  const rawHeuristicGroups = jscpd.ran ? [] : heuristicCloneGroups(project);
  const heuristicGroups = dedupeCloneRegions(rawHeuristicGroups);
  const astGroups = structuralCloneGroups(project);
  const groups = dedupeCloneRegions([...jscpdGroups, ...heuristicGroups, ...astGroups]).sort((left, right) => right.score - left.score);
  const duplicationPressure = duplicationPressureRecords(project, groups);
  const samePurpose = samePurposeRecords(project);
  const records = [...duplicationPressure, ...samePurpose].sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
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
      duplication_records: records.length,
      high_duplication_records: records.filter((record) => record.risk === "high").length,
      clone_pressure_records: duplicationPressure.length,
      same_purpose_records: samePurpose.length,
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
    records,
  };
  writeArtifact(config, "clones.json", artifact);
  return artifact;
}

function samePurposeRecords(project: ProjectAnalysis): ScoredRecord[] {
  const candidates = project.modules.flatMap((module) => purposeCandidatesForModule(module));
  return [...groupBy(candidates, (candidate) => `${candidate.category}:${candidate.purposeKey}`).values()]
    .filter((group) => group.length > 1)
    .filter((group) => new Set(group.map((candidate) => candidate.file)).size > 1)
    .filter((group) => group[0]?.category !== "export" || new Set(group.map((candidate) => candidate.name)).size > 1)
    .map(samePurposeRecord)
    .filter((record): record is ScoredRecord => Boolean(record))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
}

function purposeCandidatesForModule(module: ModuleRecord): PurposeCandidate[] {
  const functionByName = new Map(module.functions.map((fn) => [fn.name, fn]));
  const exportCandidates = module.exports.flatMap((exportRecord) => {
    const fn = functionByName.get(exportRecord.name);
    const category = fn?.kind === "hook" ? "hook" : fn?.kind === "component" ? "component" : "export";
    return purposeCandidate(module, {
      category,
      name: exportRecord.name,
      line: exportRecord.line,
      signature: typedExportType(module, exportRecord.name),
      exported: true,
    });
  });
  const exportedKeys = new Set(exportCandidates.map((candidate) => `${candidate.category}:${candidate.name}:${candidate.line ?? 0}`));
  const functionCandidates = module.functions
    .filter((fn) => fn.kind === "component" || fn.kind === "hook")
    .flatMap((fn) => {
      const category = fn.kind === "component" ? "component" : "hook";
      if (exportedKeys.has(`${category}:${fn.name}:${fn.line}`)) return [];
      return purposeCandidate(module, {
        category,
        name: fn.name,
        line: fn.line,
        signature: typedDeclarationType(module, fn.name, fn.line),
        exported: false,
      });
    });
  return [...exportCandidates, ...functionCandidates];
}

function purposeCandidate(
  module: ModuleRecord,
  input: Pick<PurposeCandidate, "category" | "name" | "line" | "signature" | "exported">,
): PurposeCandidate[] {
  const purposeTerms = purposeTermsForName(input.name, input.category);
  if (purposeTerms.length < 2) return [];
  return [{
    ...input,
    purposeKey: purposeTerms.join(":"),
    purposeTerms,
    moduleId: module.id,
    file: module.file,
    entrypointRoles: module.entrypointRoles,
  }];
}

function samePurposeRecord(group: PurposeCandidate[]): ScoredRecord | null {
  const first = group[0];
  if (!first) return null;
  const files = [...new Set(group.map((candidate) => candidate.file))].sort();
  const names = [...new Set(group.map((candidate) => candidate.name))].sort();
  const exportedCount = group.filter((candidate) => candidate.exported).length;
  const typedCount = group.filter((candidate) => Boolean(candidate.signature)).length;
  const entrypointCount = group.filter((candidate) => candidate.entrypointRoles.length > 0).length;
  const categoryWeight = first.category === "export" ? 8 : first.category === "hook" ? 12 : 10;
  const score = Math.min(100, Math.round(22 + group.length * 6 + files.length * 10 + names.length * 4 + exportedCount * 5 + typedCount * 3 + categoryWeight));
  return {
    id: `same-purpose:${first.category}:${stableHash(`${first.purposeKey}:${files.join(",")}:${names.join(",")}`)}`,
    kind: `same_purpose_${first.category}`,
    file: files[0],
    files,
    line: group.find((candidate) => candidate.file === files[0])?.line ?? null,
    score,
    risk: riskForScore(score),
    purpose_key: first.purposeKey,
    purpose_terms: first.purposeTerms,
    candidates: group.map((candidate) => ({
      module_id: candidate.moduleId,
      file: candidate.file,
      name: candidate.name,
      line: candidate.line,
      exported: candidate.exported,
      signature: candidate.signature,
      entrypoint_roles: candidate.entrypointRoles,
    })),
    signals: [
      { kind: "same_purpose_name_heuristic", value: first.purposeKey },
      { kind: "candidate_count", value: group.length },
      { kind: "file_count", value: files.length },
      { kind: "distinct_name_count", value: names.length },
      { kind: "exported_candidate_count", value: exportedCount },
      { kind: "typed_candidate_count", value: typedCount },
      ...(entrypointCount ? [{ kind: "entrypoint_candidate_count", value: entrypointCount }] : []),
    ],
  };
}

function purposeTermsForName(name: string, category: PurposeCandidate["category"]): string[] {
  const tokens = splitNameTokens(name)
    .map((token) => normalizePurposeToken(token, category))
    .filter((token) => token && !ignoredPurposeToken(token, category));
  return [...new Set(tokens)].sort();
}

function splitNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function normalizePurposeToken(token: string, category: PurposeCandidate["category"]): string {
  const normalized = token
    .replace(/ies$/, "y")
    .replace(/s$/, "")
    .replace(/formatter$/, "format")
    .replace(/formatted$/, "format")
    .replace(/validator$/, "validate")
    .replace(/validated$/, "validate")
    .replace(/loader$/, "load")
    .replace(/loaded$/, "load")
    .replace(/fetcher$/, "fetch")
    .replace(/selector$/, "select")
    .replace(/renderer$/, "render")
    .replace(/provider$/, "provide")
    .replace(/builder$/, "build")
    .replace(/creator$/, "create")
    .replace(/calculator$/, "calculate")
    .replace(/computer$/, "compute");
  if (category === "hook" && normalized === "use") return "";
  return normalized;
}

function ignoredPurposeToken(token: string, category: PurposeCandidate["category"]): boolean {
  const common = new Set(["the", "a", "an", "to", "from", "by", "for", "with", "and", "or", "of", "helper", "util", "utils", "service"]);
  const component = new Set(["component", "view", "container", "panel", "section"]);
  const hook = new Set(["hook"]);
  return common.has(token) || (category === "component" && component.has(token)) || (category === "hook" && hook.has(token));
}

function typedExportType(module: ModuleRecord, name: string): string | null {
  return module.typed?.exports.find((item) => item.name === name)?.type ?? typedDeclarationType(module, name, null);
}

function typedDeclarationType(module: ModuleRecord, name: string, line: number | null): string | null {
  const declarations = module.typed?.declarations ?? [];
  return declarations.find((item) => item.name === name && (line === null || item.line === line))?.type ??
    declarations.find((item) => item.name === name)?.type ??
    null;
}

function duplicationPressureRecords(project: ProjectAnalysis, groups: CloneGroup[]): ScoredRecord[] {
  return project.modules
    .flatMap((module) => {
      const sourceGroups = groups.filter((group) => !group.test_code && group.instances.some((instance) => instance.file === module.file));
      if (!sourceGroups.length) return [];
      const duplicatedLines = duplicatedLineCount(sourceGroups.flatMap((group) => group.instances.filter((instance) => instance.file === module.file)));
      const crossFileGroups = sourceGroups.filter((group) => new Set(group.instances.map((instance) => instance.file)).size > 1).length;
      const astGroups = sourceGroups.filter((group) => group.engine === "ast").length;
      const engines = new Set(sourceGroups.map((group) => group.engine));
      const score = Math.min(100, Math.round(sourceGroups.length * 9 + crossFileGroups * 12 + astGroups * 8 + duplicatedLines * 0.75));
      if (score < 20) return [];
      return [{
        id: `duplication-pressure:${module.id}`,
        kind: "duplication_pressure",
        module_id: module.id,
        file: module.file,
        line: 1,
        score,
        risk: riskForScore(score),
        duplicated_lines: duplicatedLines,
        clone_group_ids: sourceGroups.map((group) => group.id),
        entrypoint_roles: module.entrypointRoles,
        signals: [
          { kind: "clone_group_count", value: sourceGroups.length },
          { kind: "cross_file_clone_groups", value: crossFileGroups },
          { kind: "ast_clone_groups", value: astGroups },
          { kind: "duplicated_line_count", value: duplicatedLines },
          { kind: "clone_engine_count", value: engines.size },
          ...module.entrypointRoles.map((role) => ({ kind: "entrypoint_role", value: role })),
        ],
      }];
    })
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id));
}

function duplicatedLineCount(instances: CloneInstance[]): number {
  const ranges = instances
    .filter((instance): instance is CloneInstance & { start_line: number; end_line: number } =>
      typeof instance.start_line === "number" && typeof instance.end_line === "number",
    )
    .map((instance) => ({ start: instance.start_line, end: instance.end_line }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let current: { start: number; end: number } | null = null;
  for (const range of ranges) {
    if (!current) {
      current = { ...range };
      continue;
    }
    if (range.start <= current.end + 1) {
      current.end = Math.max(current.end, range.end);
      continue;
    }
    total += current.end - current.start + 1;
    current = { ...range };
  }
  if (current) total += current.end - current.start + 1;
  return total;
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
