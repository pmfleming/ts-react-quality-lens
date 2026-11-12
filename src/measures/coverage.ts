import fs from "node:fs";
import { analysisConfidence } from "../analysis-context.js";
import { changeSetSince, stripSourceExtension } from "../audit/change-set.js";
import { parseJson } from "../collections.js";
import { parseExecutionCoverage, type CoveredFile } from "../coverage.js";
import { artifactBase } from "../provenance.js";
import { nonempty, shape, string } from "../validation.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Artifact, Config, FunctionRecord, ProjectAnalysis } from "../types.js";

type CoverageReport = { files: CoveredFile[]; status: "not_configured" | "incomplete" | "complete"; reason: string | null };
const linkedReport = shape({ provenance: shape({ source_set_hash: string }), producer: shape({ name: nonempty, version: nonempty }) });

export function measureExecutionCoverage(config: Config, command: string, context: AnalysisContext): Artifact {
  const project = context.project(), sourceHash = context.sourceHash();
  const { files, status, reason } = readCoverageReport(config, project, sourceHash);
  const observed = files.flatMap((file) => file.line_hits);
  const artifact: Artifact = {
    ...artifactBase(config, "testing.coverage", command, analysisConfidence(config, project, {
      coverage_complete: status === "complete", required_inputs: config.coverageReport ? ["coverage_complete"] : [],
    }), sourceHash, context.identity()),
    summary: { status, reason, observed_files: files.length, observed_executable_lines: observed.length, line_coverage_percent: percent(observed),
      ...changedCoverage(config, files) },
    files, functions: functionCoverage(project, files), records: [],
    limitations: ["Observed execution is not proof of correctness.", "Line/range observations are not branch coverage.",
      "Exclusive function coverage excludes nested declarations; overlapping boundary lines have unknown attribution. Inclusive body coverage is reported separately.",
      "Function risk is withheld for ambiguous attribution or absent observations; line coverage cannot distinguish other same-line code."],
  };
  return writeArtifact(config, "execution_coverage.json", artifact);
}

function readCoverageReport(config: Config, project: ProjectAnalysis, sourceHash: string): CoverageReport {
  if (!config.coverageReport) return { files: [], status: "not_configured", reason: null };
  try {
    const report = parseJson(fs.readFileSync(config.coverageReport, "utf8"));
    if (!linkedReport(report) || report.provenance.source_set_hash !== sourceHash) throw new Error("Coverage needs matching source_set_hash and producer name/version");
    const files = parseExecutionCoverage(report.format, report.data, config.projectRoot, project.sourceFiles);
    const measured = new Set(files.map((file) => file.file));
    const missing = project.modules.filter((module) => module.functions.length && !measured.has(module.file));
    return { files, status: missing.length ? "incomplete" : "complete",
      reason: missing.length ? `No execution observations for ${missing.length} files containing functions.` : null };
  } catch (error) {
    return { files: [], status: "incomplete", reason: error instanceof Error ? error.message : String(error) };
  }
}

function changedCoverage(config: Config, files: CoveredFile[]) {
  const base = config.audit.changedSince ?? config.audit.base;
  const changes = base ? changeSetSince(config, base) : null;
  const changed = changes?.complete ? files.flatMap((file) => {
    const ranges = changes.lines.get(stripSourceExtension(file.file)) ?? [];
    return file.line_hits.filter((hit) => ranges.some((range) => range.start <= hit.line && hit.line <= range.end));
  }) : null;
  return { changed_line_coverage_percent: changed ? percent(changed) : null, changed_executable_lines: changed?.length ?? null,
    changed_scope_status: changes ? changes.complete ? "available" : "incomplete" : "not_configured" };
}

function functionCoverage(project: ProjectAnalysis, files: CoveredFile[]) {
  const index = new Map(files.map((file) => [file.file, file.line_hits]));
  return project.modules.flatMap((module) => module.functions.map((fn) => {
    const hits = (index.get(module.file) ?? []).filter((hit) => hit.line >= fn.body_line && hit.line < fn.body_line + fn.lines);
    const nested = module.functions.filter((other) => contains(fn, other));
    const hasParent = module.functions.some((other) => contains(other, fn));
    const siblings = module.functions.filter((other) => other !== fn && !contains(fn, other) && !contains(other, fn));
    const excluded = hits.filter((hit) => nested.some((child) => hit.line > child.body_line && hit.line < endLine(child)));
    const remaining = hits.filter((hit) => !excluded.includes(hit));
    const ambiguous = remaining.filter(({ line }) =>
      nested.some((child) => line >= child.line && line <= endLine(child)) ||
      hasParent && (line === fn.body_line || line === endLine(fn)) ||
      siblings.some((other) => line >= other.line && line <= endLine(other)));
    const exclusive = remaining.filter((hit) => !ambiguous.includes(hit));
    const coverage = ambiguous.length ? null : percent(exclusive), cc = fn.cyclomatic_complexity;
    return { id: fn.id, file: module.file, name: fn.name, line: fn.line, executable_lines: exclusive.length, coverage_percent: coverage,
      attribution_status: ambiguous.length ? "ambiguous" : exclusive.length ? "exclusive" : "unavailable",
      known_exclusive_coverage_percent: percent(exclusive), ambiguous_lines: ambiguous.map((hit) => hit.line),
      excluded_nested_lines: excluded.map((hit) => hit.line),
      inclusive_body_executable_lines: hits.length, inclusive_body_coverage_percent: percent(hits),
      complexity_coverage_risk: coverage === null ? null : cc * cc * Math.pow(1 - coverage / 100, 3) + cc };
  }));
}
function contains(parent: FunctionRecord, child: FunctionRecord): boolean {
  return parent.start < child.start && child.end <= parent.end;
}
function endLine(fn: FunctionRecord): number { return fn.body_line + fn.lines - 1; }
function percent(hits: Array<{ hits: number }>): number | null {
  return hits.length ? 100 * hits.filter((hit) => hit.hits > 0).length / hits.length : null;
}
