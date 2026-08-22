import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../collections.js";
import { analysisConfidence, artifactBase, createAnalysisContext, sourceSetHash, stableHash, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Config, FindingDisposition, RelatedLocation, ScoredRecord } from "../types.js";

type SarifInputStatus = {
  available: boolean;
  ran: boolean;
  complete: boolean;
  required: boolean;
  reason: string | null;
  path: string;
  runs: number;
  results: number;
};

type ParsedInput = { status: SarifInputStatus; records: ScoredRecord[] };

export function measureSarif(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const parsed = config.sarifInputs.map((input) => parseSarifInput(config, input));
  const records = parsed.flatMap((input) => input.records);
  const requiredKeys = parsed.flatMap((input, index) => input.status.required ? [`sarif_input_${index + 1}_complete`] : []);
  const completionSignals = Object.fromEntries(parsed.map((input, index) => [`sarif_input_${index + 1}_complete`, input.status.complete]));
  const confidence = analysisConfidence(config, project, {
    sarif_inputs_configured: parsed.length > 0,
    sarif_inputs_complete: parsed.every((input) => input.status.complete),
    ...completionSignals,
    ...(requiredKeys.length
      ? { required_inputs: ["source_roots_exist", "package_json_found", ...requiredKeys] }
      : {}),
  });
  const artifact = {
    ...artifactBase(config, "quality.sarif", command, confidence, sourceSetHash(project)),
    summary: {
      status: parsed.length === 0 ? "not_configured" : parsed.every((input) => input.status.complete) ? "complete" : "incomplete",
      inputs: parsed.length,
      complete_inputs: parsed.filter((input) => input.status.complete).length,
      required_inputs: parsed.filter((input) => input.status.required).length,
      records: records.length,
      blocking_findings: records.filter((record) => record.disposition === "block").length,
      code_flow_findings: records.filter((record) => Array.isArray(record.code_flows) && record.code_flows.length > 0).length,
      fixable_findings: records.filter((record) => Array.isArray(record.sarif_fixes) && record.sarif_fixes.length > 0).length,
    },
    tool_status: Object.fromEntries(parsed.map((input, index) => [
      toolStatusKey(config.sarifInputs[index]?.name ?? `sarif-${index + 1}`, index),
      input.status,
    ])),
    records,
  };
  writeArtifact(config, "sarif_findings.json", artifact);
  return artifact;
}

function parseSarifInput(config: Config, input: Config["sarifInputs"][number]): ParsedInput {
  if (!fs.existsSync(input.path)) return unavailableInput(input, "SARIF input file does not exist");
  try {
    const document: unknown = JSON.parse(fs.readFileSync(input.path, "utf8"));
    if (!isRecord(document) || document.version !== "2.1.0" || !Array.isArray(document.runs)) {
      return unavailableInput(input, "SARIF input is not a SARIF 2.1.0 document", true);
    }
    const runResults = document.runs.flatMap((run, runIndex) => parseRun(config, input, run, runIndex));
    const records = runResults.flatMap((run) => run.records);
    const invocationComplete = runResults.every((run) => run.complete);
    return {
      status: {
        available: true,
        ran: true,
        complete: invocationComplete,
        required: input.required,
        reason: invocationComplete ? null : "one or more SARIF invocations reported failure or incomplete execution",
        path: input.path,
        runs: document.runs.length,
        results: records.filter((record) => record.kind !== "sarif_invocation_incomplete").length,
      },
      records,
    };
  } catch (error) {
    return unavailableInput(input, error instanceof Error ? error.message : String(error), true);
  }
}

function parseRun(
  config: Config,
  input: Config["sarifInputs"][number],
  value: unknown,
  runIndex: number,
): { records: ScoredRecord[]; complete: boolean } {
  if (!isRecord(value)) {
    return { records: [inputFailureRecord(input, `run-${runIndex + 1}`, "SARIF run is not an object")], complete: false };
  }
  const tool = sarifTool(value.tool);
  const rules = sarifRules(value.tool);
  const automationDetails = isRecord(value.automationDetails) ? value.automationDetails : null;
  const results = Array.isArray(value.results) ? value.results : [];
  const resultRecords = results.flatMap((result, resultIndex) =>
    parseResult(config, input, tool, rules, automationDetails, result, runIndex, resultIndex));
  const invocations = Array.isArray(value.invocations) ? value.invocations : [];
  const failures = invocations.flatMap((invocation, index) => invocationFailures(input, tool, invocation, runIndex, index));
  return { records: [...resultRecords, ...failures], complete: failures.length === 0 };
}

function parseResult(
  config: Config,
  input: Config["sarifInputs"][number],
  tool: { name: string; version: string | null },
  rules: Map<string, Record<string, unknown>>,
  automationDetails: Record<string, unknown> | null,
  value: unknown,
  runIndex: number,
  resultIndex: number,
): ScoredRecord[] {
  if (!isRecord(value)) return [];
  const ruleId = typeof value.ruleId === "string" ? value.ruleId : `result-${resultIndex + 1}`;
  const rule = rules.get(ruleId);
  const level = sarifLevel(value.level, rule?.defaultConfiguration);
  const disposition = dispositionForLevel(level);
  const message = sarifMessage(value.message) ?? `${tool.name} reported ${ruleId}.`;
  const locations = Array.isArray(value.locations) ? value.locations : [];
  const primary = physicalLocation(config, locations[0]);
  const related = [
    ...sarifRelatedLocations(config, value.relatedLocations),
    ...sarifCodeFlowLocations(config, value.codeFlows),
  ];
  const fingerprints = isRecord(value.partialFingerprints) ? value.partialFingerprints : {};
  const identity = Object.keys(fingerprints).length
    ? JSON.stringify(Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right)))
    : `${tool.name}:${ruleId}:${primary?.file ?? "project"}:${primary?.start_line ?? 0}:${message}`;
  const securitySeverity = isRecord(value.properties) && typeof value.properties["security-severity"] === "string"
    ? value.properties["security-severity"]
    : null;
  return [{
    id: `sarif:${stableHash(identity)}`,
    rule_id: `${tool.name}/${ruleId}`,
    kind: "sarif_finding",
    evidence_kind: "tool-rule",
    disposition,
    finding_confidence: "high",
    scope: primary ? "file" : "project",
    ...(primary
      ? {
          file: primary.file,
          line: primary.start_line,
          column: primary.start_column ?? null,
          end_line: primary.end_line ?? null,
          end_column: primary.end_column ?? null,
        }
      : {}),
    ...(related.length ? { related_locations: dedupeLocations(related) } : {}),
    score: sarifScore(level, securitySeverity),
    severity: level,
    risk: level === "error" ? "high" : level === "warning" ? "medium" : "low",
    source: tool.name,
    message,
    sarif_level: level,
    tool_version: tool.version,
    original_rule_id: ruleId,
    rule_metadata: rule ?? null,
    security_severity: securitySeverity,
    partial_fingerprints: fingerprints,
    baseline_state: typeof value.baselineState === "string" ? value.baselineState : null,
    automation_details: automationDetails,
    code_flows: normalizeCodeFlows(config, value.codeFlows),
    sarif_fixes: normalizeFixes(config, value.fixes),
    properties: isRecord(value.properties) ? value.properties : {},
    input_name: input.name,
    input_path: input.path,
    run_index: runIndex,
    signals: [{ kind: ruleId, message }],
  }];
}

function invocationFailures(
  input: Config["sarifInputs"][number],
  tool: { name: string; version: string | null },
  value: unknown,
  runIndex: number,
  invocationIndex: number,
): ScoredRecord[] {
  if (!isRecord(value)) return [inputFailureRecord(input, `${runIndex}:${invocationIndex}`, "SARIF invocation is malformed")];
  const notifications = Array.isArray(value.toolExecutionNotifications) ? value.toolExecutionNotifications : [];
  const errors = notifications.filter((notification) => isRecord(notification) && notification.level === "error");
  if (value.executionSuccessful !== false && errors.length === 0) return [];
  const messages = errors.flatMap((notification) => isRecord(notification) ? [sarifMessage(notification.message) ?? "tool execution error"] : []);
  return [{
    ...inputFailureRecord(input, `${runIndex}:${invocationIndex}`, messages.join("; ") || "SARIF invocation reported unsuccessful execution"),
    source: tool.name,
    tool_version: tool.version,
    invocation: value,
  }];
}

function inputFailureRecord(input: Config["sarifInputs"][number], identity: string, reason: string): ScoredRecord {
  return {
    id: `sarif:input-incomplete:${input.name}:${stableHash(identity)}`,
    rule_id: "ts-react-quality-lens/sarif-input-complete",
    kind: "sarif_invocation_incomplete",
    evidence_kind: "diagnostic",
    disposition: input.required ? "block" : "warn",
    finding_confidence: "high",
    scope: "project",
    score: input.required ? 100 : 60,
    severity: input.required ? "error" : "warning",
    risk: input.required ? "high" : "medium",
    source: "sarif-importer",
    message: reason,
    input_name: input.name,
    input_path: input.path,
    signals: [{ kind: "sarif_input_incomplete", message: reason }],
  };
}

function unavailableInput(
  input: Config["sarifInputs"][number],
  reason: string,
  ran = false,
): ParsedInput {
  return {
    status: {
      available: fs.existsSync(input.path),
      ran,
      complete: false,
      required: input.required,
      reason,
      path: input.path,
      runs: 0,
      results: 0,
    },
    records: [inputFailureRecord(input, input.path, reason)],
  };
}

function sarifTool(value: unknown): { name: string; version: string | null } {
  const driver = isRecord(value) && isRecord(value.driver) ? value.driver : {};
  return {
    name: typeof driver.name === "string" ? driver.name : "sarif-tool",
    version: typeof driver.semanticVersion === "string"
      ? driver.semanticVersion
      : typeof driver.version === "string" ? driver.version : null,
  };
}

function sarifRules(value: unknown): Map<string, Record<string, unknown>> {
  const driver = isRecord(value) && isRecord(value.driver) ? value.driver : {};
  const rules = Array.isArray(driver.rules) ? driver.rules : [];
  return new Map(rules.flatMap((rule): Array<[string, Record<string, unknown>]> =>
    isRecord(rule) && typeof rule.id === "string" ? [[rule.id, rule]] : []));
}

function sarifLevel(value: unknown, defaultConfiguration: unknown): "error" | "warning" | "note" | "none" {
  if (["error", "warning", "note", "none"].includes(String(value))) return value as "error" | "warning" | "note" | "none";
  if (isRecord(defaultConfiguration) && ["error", "warning", "note", "none"].includes(String(defaultConfiguration.level))) {
    return defaultConfiguration.level as "error" | "warning" | "note" | "none";
  }
  return "warning";
}

function dispositionForLevel(level: "error" | "warning" | "note" | "none"): FindingDisposition {
  if (level === "error") return "block";
  if (level === "warning") return "warn";
  if (level === "note") return "info";
  return "review";
}

function sarifScore(level: string, securitySeverity: string | null): number {
  const numericSecurity = securitySeverity === null ? 0 : Number(securitySeverity);
  if (Number.isFinite(numericSecurity) && numericSecurity > 0) return Math.min(100, Math.round(numericSecurity * 10));
  return level === "error" ? 100 : level === "warning" ? 60 : level === "note" ? 20 : 10;
}

function sarifMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.text === "string") return value.text;
  return typeof value.markdown === "string" ? value.markdown : null;
}

function physicalLocation(config: Config, value: unknown): RelatedLocation | null {
  const location = isRecord(value) && isRecord(value.location) ? value.location : value;
  const locationRecord = isRecord(location) ? location : {};
  const physical = isRecord(locationRecord.physicalLocation) ? locationRecord.physicalLocation : null;
  if (!physical || !isRecord(physical.artifactLocation) || typeof physical.artifactLocation.uri !== "string") return null;
  const region = isRecord(physical.region) ? physical.region : {};
  return {
    file: normalizeSarifPath(config, physical.artifactLocation.uri),
    start_line: typeof region.startLine === "number" ? region.startLine : 1,
    ...(typeof region.startColumn === "number" ? { start_column: region.startColumn } : {}),
    ...(typeof region.endLine === "number" ? { end_line: region.endLine } : {}),
    ...(typeof region.endColumn === "number" ? { end_column: region.endColumn } : {}),
    role: "related",
    ...(isRecord(locationRecord.message) && sarifMessage(locationRecord.message)
      ? { message: sarifMessage(locationRecord.message)! }
      : {}),
  };
}

function sarifRelatedLocations(config: Config, value: unknown): RelatedLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((location): RelatedLocation[] => {
    const parsed = physicalLocation(config, location);
    return parsed ? [{ ...parsed, role: "related" }] : [];
  });
}

function sarifCodeFlowLocations(config: Config, value: unknown): RelatedLocation[] {
  const flows = normalizeCodeFlows(config, value);
  return flows.flatMap((flow) => flow.map((location, index) => ({
    ...location,
    role: index === 0 ? "source" as const : index === flow.length - 1 ? "sink" as const : "related" as const,
  })));
}

function normalizeCodeFlows(config: Config, value: unknown): RelatedLocation[][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((flow): RelatedLocation[][] => {
    if (!isRecord(flow) || !Array.isArray(flow.threadFlows)) return [];
    return flow.threadFlows.flatMap((thread): RelatedLocation[][] => {
      if (!isRecord(thread) || !Array.isArray(thread.locations)) return [];
      const locations = thread.locations.flatMap((location): RelatedLocation[] => {
        const parsed = physicalLocation(config, location);
        return parsed ? [parsed] : [];
      });
      return locations.length ? [locations] : [];
    });
  });
}

function normalizeFixes(config: Config, value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((fix): unknown[] => {
    if (!isRecord(fix)) return [];
    const artifactChanges = Array.isArray(fix.artifactChanges) ? fix.artifactChanges : [];
    return [{
      description: sarifMessage(fix.description),
      artifact_changes: artifactChanges.flatMap((change): unknown[] => {
        if (!isRecord(change) || !isRecord(change.artifactLocation) || typeof change.artifactLocation.uri !== "string") return [];
        return [{
          file: normalizeSarifPath(config, change.artifactLocation.uri),
          replacements: Array.isArray(change.replacements) ? change.replacements : [],
        }];
      }),
    }];
  });
}

function normalizeSarifPath(config: Config, uri: string): string {
  try {
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : path.resolve(config.projectRoot, decodeURIComponent(uri));
    const relative = path.relative(config.projectRoot, file).replace(/\\/g, "/");
    return relative && !relative.startsWith("../") ? relative : file.replace(/\\/g, "/");
  } catch {
    return uri;
  }
}

function dedupeLocations(locations: RelatedLocation[]): RelatedLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.role}:${location.file}:${location.start_line}:${location.start_column ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolStatusKey(name: string, index: number): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${normalized || "sarif"}_${index + 1}`;
}
