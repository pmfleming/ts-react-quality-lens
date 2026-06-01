import {
  createAnalysisContext,
  analysisConfidence,
  cloneGroup,
  groupBy,
  jscpdCloneGroup,
  normalizeCloneLine,
  stableHash,
} from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { writeArtifact } from "../writer.js";

export function measureClones(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const jscpd = context.jscpd();
  const blocks = [];
  for (const file of [...project.sourceFiles, ...project.testFiles]) {
    const relevantLines = file.lines
      .map((line, index) => ({ index: index + 1, text: line.trim() }))
      .filter((line) => line.text && !line.text.startsWith("//") && !line.text.startsWith("*"));
    for (let index = 0; index <= relevantLines.length - 6; index += 1) {
      const lineWindow = relevantLines.slice(index, index + 6);
      const normalized = lineWindow.map((line) => normalizeCloneLine(line.text)).join("\n");
      if (normalized.length < 80) continue;
      blocks.push({
        hash: stableHash(normalized),
        normalized,
        file: file.relativePath,
        start_line: lineWindow[0].index,
        end_line: lineWindow.at(-1).index,
        test_code: file.isTest,
      });
    }
  }
  const rawHeuristicGroups = [...groupBy(blocks, (block) => block.hash).values()]
    .map(nonOverlappingBlocks)
    .filter((group) => new Set(group.map((block) => `${block.file}:${block.start_line}`)).size > 1)
    .map((group) => cloneGroup(group))
    .sort((left, right) => right.score - left.score);
  const jscpdGroups = jscpd.ran ? jscpd.duplicates.map((duplicate, index) => jscpdCloneGroup(config, duplicate, index)) : [];
  const heuristicGroups = dedupeCloneRegions(rawHeuristicGroups);
  const groups = dedupeCloneRegions([...jscpdGroups, ...heuristicGroups]).sort((left, right) => right.score - left.score);
  const artifact = {
    ...artifactBase(
      config,
      "quality.clones",
      command,
      analysisConfidence(config, project, {
        jscpd_available: jscpd.available,
        jscpd_ran: jscpd.ran,
      }),
    ),
    summary: {
      clone_groups: groups.length,
      jscpd_clone_groups: jscpdGroups.length,
      heuristic_clone_groups: heuristicGroups.length,
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

function nonOverlappingBlocks(group) {
  const blocks = [...group].sort((left, right) => left.file.localeCompare(right.file) || left.start_line - right.start_line);
  const result = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous?.file === block.file && block.start_line <= previous.end_line) continue;
    result.push(block);
  }
  return result;
}

function dedupeCloneRegions(groups) {
  const selected = [];
  for (const group of groups.sort((left, right) => right.score - left.score)) {
    if (!selected.some((existing) => sameCloneRegion(group, existing))) selected.push(group);
  }
  return selected;
}

function sameCloneRegion(left, right) {
  return left.instances.every((instance) =>
    right.instances.some((other) => instance.file === other.file && rangesOverlap(instance, other)),
  );
}

function rangesOverlap(left, right) {
  return left.start_line <= right.end_line && right.start_line <= left.end_line;
}
