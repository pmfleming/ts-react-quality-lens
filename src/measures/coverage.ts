import fs from "node:fs";
import { analysisConfidence } from "../analysis-context.js";
import { changeSetSince, stripSourceExtension } from "../audit/change-set.js";
import { isRecord, parseJson } from "../collections.js";
import { parseExecutionCoverage, type CoveredFile } from "../coverage.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Artifact, Config } from "../types.js";

export function measureExecutionCoverage(config: Config, command: string, context: AnalysisContext): Artifact {
  const project = context.project(), sourceHash = sourceSetHash(project);
  let files: CoveredFile[] = [], reason: string | null = null;
  let status = config.coverageReport ? "incomplete" : "not_configured";
  if (config.coverageReport) {
    try {
      const report = parseJson(fs.readFileSync(config.coverageReport, "utf8"));
      if (!isRecord(report) || !isRecord(report.provenance) || report.provenance.source_set_hash !== sourceHash ||
        !isRecord(report.producer) || typeof report.producer.name !== "string" || !report.producer.name.trim() ||
        typeof report.producer.version !== "string" || !report.producer.version.trim()) throw new Error("Coverage needs matching source_set_hash and producer name/version");
      files = parseExecutionCoverage(report.format, report.data, config.projectRoot, project.sourceFiles);
      const measured = new Set(files.map((file) => file.file));
      const missing = project.modules.filter((module) => module.functions.length && !measured.has(module.file));
      status = missing.length ? "incomplete" : "complete";
      if (missing.length) reason = `No execution observations for ${missing.length} files containing functions.`;
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  }
  const base = config.audit.changedSince ?? config.audit.base;
  const changes = base ? changeSetSince(config, base) : null;
  const observed = files.flatMap((file) => file.line_hits);
  const changed = changes?.complete ? files.flatMap((file) => file.line_hits.filter((hit) =>
    changes.lines.get(stripSourceExtension(file.file))?.some((range) => range.start <= hit.line && hit.line <= range.end))) : null;
  const percent = (hits: Array<{ hits: number }>) => hits.length ? 100 * hits.filter((hit) => hit.hits > 0).length / hits.length : null;
  const index = new Map(files.map((file) => [file.file, file.line_hits]));
  const functions = project.modules.flatMap((module) => module.functions.map((fn) => {
    const hits = (index.get(module.file) ?? []).filter((hit) => hit.line >= fn.line && hit.line < fn.line + fn.lines);
    const coverage = percent(hits), cc = fn.cyclomatic_complexity;
    return { file: module.file, name: fn.name, line: fn.line, executable_lines: hits.length, coverage_percent: coverage,
      complexity_coverage_risk: coverage === null ? null : cc * cc * Math.pow(1 - coverage / 100, 3) + cc };
  }));
  const artifact: Artifact = {
    ...artifactBase(config, "testing.coverage", command, analysisConfidence(config, project, {
      coverage_complete: status === "complete", required_inputs: config.coverageReport ? ["coverage_complete"] : [],
    }), sourceHash),
    summary: { status, reason, observed_files: files.length, observed_executable_lines: observed.length, line_coverage_percent: percent(observed),
      changed_line_coverage_percent: changed ? percent(changed) : null, changed_executable_lines: changed?.length ?? null,
      changed_scope_status: changes ? changes.complete ? "available" : "incomplete" : "not_configured" },
    files, functions, records: [], limitations: ["Observed execution is not proof of correctness.", "Line/range observations are not branch coverage.", "Function risk is advisory, not a correctness verdict."],
  };
  return writeArtifact(config, "execution_coverage.json", artifact);
}
