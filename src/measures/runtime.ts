import { performanceComparisonRecords } from "../performance-baseline.js";
import { compilerExecutionRecords, type ImportedEvidence } from "../react-compiler-report.js";
import { performanceTrackRecords } from "../react-performance.js";
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "../collections.js";
import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { stableHash } from "../clone-utils.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Config, RelatedLocation, ScoredRecord } from "../types.js";
type RuntimeInput = { name: string; file: string | null; parse: (config: Config, value: unknown, environment: Record<string, unknown>, sourceVerified: boolean, envelope: unknown) => ScoredRecord[] | ImportedEvidence };
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
    { name: "performance_comparison", file: config.runtimeInputs.performanceCurrent ?? config.runtimeInputs.performanceBaseline, parse: performanceComparisonRecords },
    { name: "react_compiler", file: config.runtimeInputs.reactCompiler, parse: compilerExecutionRecords },
    { name: "react_profiler", file: config.runtimeInputs.reactProfiler, parse: profilerRecords },
    { name: "axe", file: config.runtimeInputs.axe, parse: axeRecords },
    { name: "react_doctor", file: config.runtimeInputs.reactDoctor, parse: reactDoctorRecords },
  ];
  const parsed = inputs.map((input) => parseRuntimeInput(config, input, sourceSetHash(project)));
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
      performance_track_observations: records.filter((record) => record.source === "react-performance-tracks").length,
      accessibility_findings: records.filter((record) => record.source === "axe").length,
      performance_comparisons: records.filter((record) => record.kind === "performance_delta").length,
      compiler_observations: records.filter((record) => record.source === "react-compiler-report").length,
      react_doctor_findings: records.filter((record) => record.source === "react-doctor").length,
    },
    import_metadata: Object.fromEntries(parsed.filter((item) => item.metadata).map((item) => [item.name, item.metadata])),
    tool_status: Object.fromEntries(parsed.map((item) => [item.name, item.status])),
    records,
  };
  return writeArtifact(config, "runtime_health.json", artifact);
}
function parseRuntimeInput(config: Config, input: RuntimeInput, sourceHash: string): { name: string; status: RuntimeStatus; records: ScoredRecord[]; metadata?: Record<string, unknown> } {
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
    const value = parseJson(fs.readFileSync(input.file, "utf8"));
    const linked = isRecord(value) && isRecord(value.provenance) && value.provenance.source_set_hash === sourceHash &&
      isRecord(value.producer) && typeof value.producer.name === "string" && Boolean(value.producer.name.trim()) &&
      typeof value.producer.version === "string" && Boolean(value.producer.version.trim()) &&
      isRecord(value.environment) && Object.keys(value.environment).length > 0;
    const environment = isRecord(value) && isRecord(value.environment) ? value.environment : {};
    const result = input.parse(config, isRecord(value) && "data" in value ? value.data : value, environment, linked, value);
    const imported = Array.isArray(result) ? { records: result, complete: true, reason: null, metadata: undefined } : result;
    const records = imported.records.map((record) => ({ ...record, observation_environment: environment,
        ...(record.source === "react-profiler" && environment.build === "development"
          ? { disposition: "review" as const, production_representative: false, measurement_caveat: "Development timings include instrumentation and may include Strict Mode work; verify with a profiling build and representative workload." } : {}) }));
    return {
      name: input.name,
      status: { available: true, ran: true, complete: linked && imported.complete, reason: !linked ? "Imported observations lack matching source/producer/environment provenance." : imported.reason, path: input.file, records: records.length },
      ...(imported.metadata ? { metadata: { source_verified: linked, report: imported.metadata } } : {}),
      records: linked ? records : records.map((record) => ({ ...record, disposition: "review", finding_confidence: "low", semantic_decision: "unresolved", reason_code: "unverified-runtime-provenance" })),
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
function profilerRecords(config: Config, value: unknown, environment: Record<string, unknown>): ScoredRecord[] {
  if (isRecord(value) && "format" in value) {
    if (value.format !== "react-performance-tracks-v1") throw new Error("Unsupported React profiler input format.");
    return performanceTrackRecords(value, environment);
  }
  const commits = Array.isArray(value) ? value : requiredArray(value, "commits");
  return commits.map((commit, index) => {
    const record = profilerRecord(config, commit, index);
    if (!record) throw new Error(`Invalid profiler commit at index ${index}: a nonnegative finite duration and positive integer render count are required.`);
    return record;
  });
}
function profilerRecord(config: Config, value: unknown, index: number): ScoredRecord | null {
  if (!isRecord(value)) return null;
  const duration = numberValue(value.duration_ms, value.actualDuration, value.duration);
  if (duration === null || duration < 0) return null;
  const component = stringValue(value.component, value.componentName, value.name) ?? `commit-${index + 1}`;
  const file = typeof value.file === "string" ? normalizePath(config, value.file) : null;
  const renderCount = value.render_count === undefined && value.renderCount === undefined ? 1 : numberValue(value.render_count, value.renderCount);
  if (renderCount === null || !Number.isInteger(renderCount) || renderCount < 1) return null;
  const measurementKind = value.duration_ms === undefined && typeof value.actualDuration === "number" ? "render_duration" : "reported_duration";
  const score = Math.min(100, Math.round(duration * 2 + Math.max(0, renderCount - 1) * 5));
  return {
    id: `runtime:profiler:${stableHash(`${component}:${index}:${duration}`)}`,
    rule_id: "react-profiler/render-cost",
    kind: "react_render_cost",
    evidence_kind: "metric",
    disposition: duration > 50 || renderCount > 10 ? "warn" : "review",
    finding_confidence: "high",
    scope: file ? "file" : "project",
    ...(file ? { file } : {}),
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    score,
    risk: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    source: "react-profiler",
    message: `${component}: ${duration}ms ${measurementKind === "render_duration" ? "render time" : "reported duration"} across ${renderCount} observed render${renderCount === 1 ? "" : "s"}.`,
    measurement_kind: measurementKind,
    guidance_url: "https://react.dev/reference/react/Profiler",
    component,
    duration_ms: duration,
    render_count: renderCount,
    phase: typeof value.phase === "string" ? value.phase : null,
    signals: [{ kind: measurementKind === "render_duration" ? "render_duration_ms" : "reported_duration_ms", value: duration }, { kind: "render_count", value: renderCount }],
  };
}
function axeRecords(_config: Config, value: unknown): ScoredRecord[] {
  const violations = requiredArray(value, "violations");
  return violations.flatMap((violation, violationIndex) => {
    if (!isRecord(violation) || typeof violation.id !== "string" ||
        !Array.isArray(violation.nodes) || !violation.nodes.every(isRecord)) {
      throw new Error(`Invalid axe violation at index ${violationIndex}.`);
    }
    return axeViolationRecords(violation, violationIndex);
  });
}
function axeViolationRecords(value: unknown, violationIndex: number): ScoredRecord[] {
  if (!isRecord(value)) return [];
  const nodes = Array.isArray(value.nodes) && value.nodes.length ? value.nodes : [{}];
  return nodes.flatMap((node, nodeIndex) => optionalRecord(axeNodeRecord(value, node, violationIndex, nodeIndex)));
}
function axeNodeRecord(violation: Record<string, unknown>, value: unknown, violationIndex: number, nodeIndex: number): ScoredRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof violation.id === "string" ? violation.id : `violation-${violationIndex + 1}`;
  const impact = stringValue(value.impact, violation.impact) ?? "unknown";
  const targets = Array.isArray(value.target) ? value.target.filter((item): item is string => typeof item === "string") : [];
  const score = axeScore(impact);
  return {
    id: `runtime:axe:${id}:${nodeIndex + 1}:${stableHash(targets.join("|"))}`,
    rule_id: `axe/${id}`,
    kind: "runtime_accessibility_violation",
    evidence_kind: "tool-rule",
    disposition: impact === "critical" ? "block" : impact === "serious" ? "warn" : "review",
    finding_confidence: "high",
    scope: "project",
    score,
    risk: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    source: "axe",
    message: stringValue(value.failureSummary, violation.help, violation.description) ?? `axe reported ${id}.`,
    impact,
    targets,
    html: typeof value.html === "string" ? value.html : null,
    help_url: typeof violation.helpUrl === "string" ? violation.helpUrl : null,
    signals: [{ kind: id, value: impact }],
  };
}
function axeScore(impact: string): number {
  return { critical: 100, serious: 75, moderate: 50, minor: 25 }[impact] ?? 25;
}
function reactDoctorRecords(config: Config, value: unknown): ScoredRecord[] {
  return reactDoctorDiagnostics(value).map((diagnostic, index) => {
    if (!isRecord(diagnostic) || typeof diagnostic.rule !== "string") {
      throw new Error(`Invalid React Doctor diagnostic at index ${index}.`);
    }
    const record = reactDoctorRecord(config, diagnostic, index);
    if (!record) throw new Error(`Invalid React Doctor diagnostic at index ${index}.`);
    return record;
  });
}
function reactDoctorDiagnostics(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.diagnostics)) return value.diagnostics;
  return requiredArray(value, "projects").flatMap((project) => requiredArray(project, "diagnostics"));
}
function requiredArray(value: unknown, property: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[property])) {
    throw new Error(`Unsupported runtime input: expected an array at ${property}.`);
  }
  return value[property];
}
function reactDoctorRecord(config: Config, value: unknown, index: number): ScoredRecord | null {
  if (!isRecord(value)) return null;
  const plugin = typeof value.plugin === "string" ? value.plugin : "react-doctor";
  const rule = typeof value.rule === "string" ? value.rule : `diagnostic-${index + 1}`;
  const file = stringValue(value.normalizedFilePath, value.filePath);
  const error = value.severity === "error";
  return {
    id: typeof value.id === "string" ? `react-doctor:${value.id}` : `react-doctor:${stableHash(`${file}:${rule}:${index}`)}`,
    rule_id: `${plugin}/${rule}`,
    kind: "react_doctor_finding",
    evidence_kind: "tool-rule",
    disposition: error ? "warn" : "review",
    finding_confidence: "high",
    scope: file ? "file" : "project",
    ...(file ? { file: normalizePath(config, file) } : {}),
    ...sourceRange(value),
    ...reactDoctorRelations(config, value),
    score: error ? 75 : 50,
    risk: error ? "high" : "medium",
    source: "react-doctor",
    message: stringValue(value.message, value.title) ?? `${plugin}/${rule}`,
    category: typeof value.category === "string" ? value.category : null,
    help: typeof value.help === "string" ? value.help : null,
    url: typeof value.url === "string" ? value.url : null,
    signals: [{ kind: rule }],
  };
}
function sourceRange(value: Record<string, unknown>): Pick<ScoredRecord, "line" | "column" | "end_line" | "end_column"> {
  return {
    ...(typeof value.line === "number" ? { line: value.line } : {}),
    ...(typeof value.column === "number" ? { column: value.column } : {}),
    ...(typeof value.endLine === "number" ? { end_line: value.endLine } : {}),
    ...(typeof value.endColumn === "number" ? { end_column: value.endColumn } : {}),
  };
}
function reactDoctorRelations(config: Config, value: Record<string, unknown>): Pick<ScoredRecord, "related_locations" | "fix_group_id"> {
  const related = Array.isArray(value.relatedLocations)
    ? value.relatedLocations.flatMap((location) => optionalRecord(reactDoctorLocation(config, location)))
    : [];
  return {
    ...(related.length ? { related_locations: related } : {}),
    ...(typeof value.fixGroupId === "string" ? { fix_group_id: value.fixGroupId } : {}),
  };
}
function reactDoctorLocation(config: Config, value: unknown): RelatedLocation | null {
  if (!isRecord(value) || typeof value.filePath !== "string" || typeof value.line !== "number") return null;
  return {
    file: normalizePath(config, value.filePath),
    start_line: value.line,
    ...(typeof value.column === "number" ? { start_column: value.column } : {}),
    ...(typeof value.endLine === "number" ? { end_line: value.endLine } : {}),
    ...(typeof value.endColumn === "number" ? { end_column: value.endColumn } : {}),
    role: "related",
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}
function optionalRecord<T>(value: T | null): T[] {
  return value === null ? [] : [value];
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
  const value = values.find((item) => item !== undefined);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringValue(...values: unknown[]): string | null {
  const value = values.find((item) => typeof item === "string" && item.length > 0);
  return typeof value === "string" ? value : null;
}
