import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../collections.js";
import { analysisConfidence, artifactBase, createAnalysisContext, sourceSetHash, stableHash, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Config, RelatedLocation, ScoredRecord } from "../types.js";

type RuntimeInput = { name: string; file: string | null; parse: (config: Config, value: unknown) => ScoredRecord[] };

type RuntimeStatus = {
  available: boolean;
  ran: boolean;
  complete: boolean;
  reason: string | null;
  path: string | null;
  records: number;
};

export function measureRuntime(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const inputs: RuntimeInput[] = [
    { name: "react_profiler", file: config.runtimeInputs.reactProfiler, parse: profilerRecords },
    { name: "axe", file: config.runtimeInputs.axe, parse: axeRecords },
    { name: "react_doctor", file: config.runtimeInputs.reactDoctor, parse: reactDoctorRecords },
  ];
  const parsed = inputs.map((input) => parseRuntimeInput(config, input));
  const records = parsed.flatMap((item) => item.records);
  const configured = parsed.filter((item) => item.status.path !== null);
  const requiredInputs = configured.map((item) => `${item.name}_complete`);
  const artifact = {
    ...artifactBase(config, "quality.runtime", command, analysisConfidence(config, project, {
      runtime_inputs_configured: configured.length,
      runtime_inputs_complete: configured.every((item) => item.status.complete),
      ...Object.fromEntries(parsed.map((item) => [`${item.name}_complete`, item.status.complete])),
      ...(requiredInputs.length ? { required_inputs: ["source_roots_exist", "package_json_found", ...requiredInputs] } : {}),
    }), sourceSetHash(project)),
    summary: {
      status: configured.length === 0 ? "not_configured" : configured.every((item) => item.status.complete) ? "complete" : "incomplete",
      configured_inputs: configured.length,
      complete_inputs: configured.filter((item) => item.status.complete).length,
      records: records.length,
      profiler_findings: records.filter((record) => record.source === "react-profiler").length,
      accessibility_findings: records.filter((record) => record.source === "axe").length,
      react_doctor_findings: records.filter((record) => record.source === "react-doctor").length,
    },
    tool_status: Object.fromEntries(parsed.map((item) => [item.name, item.status])),
    records,
  };
  writeArtifact(config, "runtime_health.json", artifact);
  return artifact;
}

function parseRuntimeInput(config: Config, input: RuntimeInput): { name: string; status: RuntimeStatus; records: ScoredRecord[] } {
  if (!input.file) return {
    name: input.name,
    status: { available: false, ran: false, complete: false, reason: "input is not configured", path: null, records: 0 },
    records: [],
  };
  if (!fs.existsSync(input.file)) return {
    name: input.name,
    status: { available: false, ran: false, complete: false, reason: "configured input file does not exist", path: input.file, records: 0 },
    records: [runtimeInputFailure(input.name, input.file, "Configured runtime input file does not exist.")],
  };
  try {
    const records = input.parse(config, JSON.parse(fs.readFileSync(input.file, "utf8")));
    return {
      name: input.name,
      status: { available: true, ran: true, complete: true, reason: null, path: input.file, records: records.length },
      records,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      name: input.name,
      status: { available: true, ran: false, complete: false, reason, path: input.file, records: 0 },
      records: [runtimeInputFailure(input.name, input.file, reason)],
    };
  }
}

function profilerRecords(config: Config, value: unknown): ScoredRecord[] {
  const commits = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.commits) ? value.commits : [];
  return commits.flatMap((commit, index): ScoredRecord[] => {
    if (!isRecord(commit)) return [];
    const duration = numberValue(commit.duration_ms, commit.actualDuration, commit.duration);
    if (duration === null) return [];
    const component = stringValue(commit.component, commit.componentName, commit.name) ?? `commit-${index + 1}`;
    const file = typeof commit.file === "string" ? normalizePath(config, commit.file) : null;
    const renderCount = numberValue(commit.render_count, commit.renderCount) ?? 1;
    const score = Math.min(100, Math.round(duration * 2 + Math.max(0, renderCount - 1) * 5));
    return [{
      id: `runtime:profiler:${stableHash(`${component}:${index}:${duration}`)}`,
      rule_id: "react-profiler/expensive-commit",
      kind: "react_render_cost",
      evidence_kind: "metric",
      disposition: duration > 50 || renderCount > 10 ? "warn" : "review",
      finding_confidence: "high",
      scope: file ? "file" : "project",
      ...(file ? { file } : {}),
      ...(typeof commit.line === "number" ? { line: commit.line } : {}),
      score,
      risk: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
      source: "react-profiler",
      message: `${component} committed in ${duration}ms across ${renderCount} observed render${renderCount === 1 ? "" : "s"}.`,
      component,
      duration_ms: duration,
      render_count: renderCount,
      phase: typeof commit.phase === "string" ? commit.phase : null,
      signals: [{ kind: "commit_duration_ms", value: duration }, { kind: "render_count", value: renderCount }],
    }];
  });
}

function axeRecords(_config: Config, value: unknown): ScoredRecord[] {
  const violations = isRecord(value) && Array.isArray(value.violations) ? value.violations : [];
  return violations.flatMap((violation, violationIndex): ScoredRecord[] => {
    if (!isRecord(violation)) return [];
    const nodes = Array.isArray(violation.nodes) && violation.nodes.length ? violation.nodes : [{}];
    return nodes.flatMap((node, nodeIndex): ScoredRecord[] => {
      if (!isRecord(node)) return [];
      const id = typeof violation.id === "string" ? violation.id : `violation-${violationIndex + 1}`;
      const impact = typeof node.impact === "string" ? node.impact : typeof violation.impact === "string" ? violation.impact : "unknown";
      const targets = Array.isArray(node.target) ? node.target.filter((item): item is string => typeof item === "string") : [];
      return [{
        id: `runtime:axe:${id}:${nodeIndex + 1}:${stableHash(targets.join("|"))}`,
        rule_id: `axe/${id}`,
        kind: "runtime_accessibility_violation",
        evidence_kind: "tool-rule",
        disposition: impact === "critical" ? "block" : impact === "serious" ? "warn" : "review",
        finding_confidence: "high",
        scope: "project",
        score: impact === "critical" ? 100 : impact === "serious" ? 75 : impact === "moderate" ? 50 : 25,
        risk: impact === "critical" ? "high" : impact === "serious" || impact === "moderate" ? "medium" : "low",
        source: "axe",
        message: stringValue(node.failureSummary, violation.help, violation.description) ?? `axe reported ${id}.`,
        impact,
        targets,
        html: typeof node.html === "string" ? node.html : null,
        help_url: typeof violation.helpUrl === "string" ? violation.helpUrl : null,
        signals: [{ kind: id, value: impact }],
      }];
    });
  });
}

function reactDoctorRecords(config: Config, value: unknown): ScoredRecord[] {
  const diagnostics = isRecord(value) && Array.isArray(value.diagnostics)
    ? value.diagnostics
    : isRecord(value) && Array.isArray(value.projects)
      ? value.projects.flatMap((project) => isRecord(project) && Array.isArray(project.diagnostics) ? project.diagnostics : [])
      : [];
  return diagnostics.flatMap((diagnostic, index): ScoredRecord[] => {
    if (!isRecord(diagnostic)) return [];
    const plugin = typeof diagnostic.plugin === "string" ? diagnostic.plugin : "react-doctor";
    const rule = typeof diagnostic.rule === "string" ? diagnostic.rule : `diagnostic-${index + 1}`;
    const file = stringValue(diagnostic.normalizedFilePath, diagnostic.filePath);
    const related = Array.isArray(diagnostic.relatedLocations)
      ? diagnostic.relatedLocations.flatMap((location): RelatedLocation[] => {
          if (!isRecord(location) || typeof location.filePath !== "string" || typeof location.line !== "number") return [];
          return [{
            file: normalizePath(config, location.filePath),
            start_line: location.line,
            ...(typeof location.column === "number" ? { start_column: location.column } : {}),
            ...(typeof location.endLine === "number" ? { end_line: location.endLine } : {}),
            ...(typeof location.endColumn === "number" ? { end_column: location.endColumn } : {}),
            role: "related",
            ...(typeof location.message === "string" ? { message: location.message } : {}),
          }];
        })
      : [];
    const error = diagnostic.severity === "error";
    return [{
      id: typeof diagnostic.id === "string" ? `react-doctor:${diagnostic.id}` : `react-doctor:${stableHash(`${file}:${rule}:${index}`)}`,
      rule_id: `${plugin}/${rule}`,
      kind: "react_doctor_finding",
      evidence_kind: "tool-rule",
      disposition: error ? "warn" : "review",
      finding_confidence: "high",
      scope: file ? "file" : "project",
      ...(file ? { file: normalizePath(config, file) } : {}),
      ...(typeof diagnostic.line === "number" ? { line: diagnostic.line } : {}),
      ...(typeof diagnostic.column === "number" ? { column: diagnostic.column } : {}),
      ...(typeof diagnostic.endLine === "number" ? { end_line: diagnostic.endLine } : {}),
      ...(typeof diagnostic.endColumn === "number" ? { end_column: diagnostic.endColumn } : {}),
      ...(related.length ? { related_locations: related } : {}),
      ...(typeof diagnostic.fixGroupId === "string" ? { fix_group_id: diagnostic.fixGroupId } : {}),
      score: error ? 75 : 50,
      risk: error ? "high" : "medium",
      source: "react-doctor",
      message: stringValue(diagnostic.message, diagnostic.title) ?? `${plugin}/${rule}`,
      category: typeof diagnostic.category === "string" ? diagnostic.category : null,
      help: typeof diagnostic.help === "string" ? diagnostic.help : null,
      url: typeof diagnostic.url === "string" ? diagnostic.url : null,
      signals: [{ kind: rule }],
    }];
  });
}

function runtimeInputFailure(name: string, file: string, reason: string): ScoredRecord {
  return {
    id: `runtime:input-incomplete:${name}`,
    rule_id: "ts-react-quality-lens/runtime-input-complete",
    kind: "runtime_input_incomplete",
    evidence_kind: "diagnostic",
    disposition: "warn",
    finding_confidence: "high",
    scope: "project",
    score: 60,
    risk: "medium",
    source: name,
    message: reason,
    input_path: file,
    semantic_decision: "unavailable",
    signals: [{ kind: "runtime_input_incomplete", value: name }],
  };
}

function normalizePath(config: Config, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(config.projectRoot, file);
  const relative = path.relative(config.projectRoot, absolute).replace(/\\/g, "/");
  return relative && !relative.startsWith("../") ? relative : file.replace(/\\/g, "/");
}

function numberValue(...values: unknown[]): number | null {
  const value = values.find((item) => typeof item === "number" && Number.isFinite(item));
  return typeof value === "number" ? value : null;
}

function stringValue(...values: unknown[]): string | null {
  const value = values.find((item) => typeof item === "string" && item.length > 0);
  return typeof value === "string" ? value : null;
}
