import { isRecord, isUnknownArray } from "./collections.js";
import { arrayOf, boolean, integer, nonempty, nonnegative, nullable, oneOf, optional, positiveInteger, shape, string } from "./validation.js";
import { validWireExtension } from "./wire-evidence.js";
import type { Artifact, AttwProblem } from "./types.js";
import { validPerformanceComparisonMetadata, validPerformanceDelta } from "./performance-baseline.js";
import { validCompilerMetadata, validCompilerObservation } from "./react-compiler-report.js";
import { validPerformanceTrackRecord } from "./react-performance.js";
import { validModernWebPayload } from "./modern-web-payload.js";
import { validDocumentationReport } from "./typescript-documentation.js";
import { validCompilerPerformanceReport } from "./compiler-performance.js";

const strings = arrayOf(string);
const toolStatus = shape({ available: boolean, ran: boolean, complete: boolean, reason: nullable(string) });
const status = (value: unknown): value is Record<string, unknown> => toolStatus(value) && (!value.complete || value.available && value.ran);
export const validPublintMessages = arrayOf(shape({ code: nonempty, type: oneOf("error", "warning", "suggestion"), path: strings, args: isRecord }));
const attw = shape({ kind: nonempty, entrypoint: optional(nonempty), resolutionKind: optional(nonempty) });
export const validAttwProblems = arrayOf((value: unknown): value is AttwProblem => attw(value));
const completed = (value: unknown) => isRecord(value) && value.complete === true;

function validPackage(artifact: Artifact): boolean {
  const statuses = ["declaration_emit", "npm_pack", "publint", "are_the_types_wrong"].map((name) => artifact.tool_status?.[name]);
  return statuses.every(status) && packageEvidence(artifact.package_evidence) &&
    oneOf("disabled", "complete", "incomplete")(artifact.summary.status) &&
    artifact.summary.complete === (artifact.summary.status === "complete") && (!artifact.summary.complete || statuses.every(completed));
}
const packageEvidence = shape({ publint_messages: validPublintMessages, attw_problems: validAttwProblems });
const execution = new Map<string, (value: unknown) => boolean>([
  ["unknown", shape({ reason: nonempty })], ["not_run", shape({ command: nullable(nonempty) })], ["passed", shape({ command: nonempty })],
  ["failed", shape({ command: nonempty, exit_code: nullable(integer), stdout: string, stderr: string })],
]);
const ruleCoverage = arrayOf(shape({ rule_id: nonempty, source: nullable(string),
  category: oneOf("correctness", "optimization", "configuration", "unknown", "tool-failure"),
  disposition: oneOf("block", "warn", "review", "info"), status: oneOf("evaluated", "incomplete", "disabled", "unknown", "not_applicable") }));
function validReact(artifact: Artifact): boolean {
  const tool = artifact.tool_status?.eslint_react_hooks;
  if (!status(tool) || !status(artifact.tool_status?.jsx_a11y)) return false;
  if (artifact.rule_coverage === undefined) return true;
  if (!ruleCoverage(artifact.rule_coverage) || !strings(tool.enabled_rules)) return false;
  const enabled = tool.enabled_rules;
  return new Set(artifact.rule_coverage.map((rule) => rule.rule_id)).size === artifact.rule_coverage.length &&
    artifact.rule_coverage.every((rule) => rule.status === "unknown" ||
      (rule.status === "disabled" ? !enabled.includes(rule.rule_id) : enabled.includes(rule.rule_id) &&
        (rule.status === "incomplete" ? !tool.complete : tool.complete && (rule.status !== "not_applicable" || Array.isArray(tool.evaluated_files) && tool.evaluated_files.length === 0))));
}
function validRuntime(artifact: Artifact): boolean {
  const imports = artifact.import_metadata;
  if (imports !== undefined && (!isRecord(imports) || !Object.values(imports).every(shape({ source_verified: boolean, report: isRecord })))) return false;
  for (const name of ["react_compiler", "performance_comparison"]) {
    if (artifact.tool_status?.[name]?.ran === true && (!isRecord(imports) || !isRecord(imports[name]))) return false;
  }
  if ((artifact.records ?? []).some((record) => record.kind === "performance_delta") && (!isRecord(imports) || !isRecord(imports.performance_comparison))) return false;
  if (isRecord(imports) && imports.react_compiler !== undefined) {
    const item = imports.react_compiler;
    if (!shape({ source_verified: boolean, report: isRecord })(item) || !validCompilerMetadata(item.report, item.source_verified)) return false;
  }
  if (isRecord(imports) && imports.performance_comparison !== undefined) {
    const item = imports.performance_comparison;
    if (!shape({ source_verified: boolean, report: isRecord })(item) || !validPerformanceComparisonMetadata(item.report, item.source_verified) ||
        item.report.comparisons !== (artifact.records ?? []).filter((record) => record.kind === "performance_delta").length) return false;
  }
  return validImports(artifact) && (artifact.records ?? []).every((record) =>
    record.kind === "performance_delta" ? validPerformanceDelta(record) : record.source === "react-compiler-report" ? validCompilerObservation(record) : record.source !== "react-performance-tracks" || validPerformanceTrackRecord(record));
}
function validImports(artifact: Artifact): boolean {
  const statuses = Object.values(artifact.tool_status ?? {});
  if (!statuses.every(status)) return false;
  const configured = statuses.filter((item) => item.path !== null);
  return importStatus(artifact.summary.status) &&
    (artifact.summary.status !== "complete" || configured.length > 0 && configured.every(completed));
}
const importStatus = oneOf("not_configured", "complete", "incomplete");
const coveredFiles = arrayOf(shape({ file: nonempty, line_hits: arrayOf(shape({ line: positiveInteger, hits: nonnegative })) }));
const checks = new Map<string, (artifact: Artifact) => boolean>([
  ["quality.modern_web", validModernWebPayload],
  ["quality.type_health", ({ confidence, tool_status, diagnostics, documentation, compiler_performance }) => boolean(confidence.typescript_program_loaded) &&
    shape({ loaded: boolean })(tool_status?.compiler_api) && tool_status?.compiler_api?.loaded === confidence.typescript_program_loaded && isUnknownArray(diagnostics) &&
    (documentation === undefined || validDocumentationReport(documentation)) &&
    (compiler_performance === undefined || validCompilerPerformanceReport(compiler_performance))],
  ["quality.lint", ({ tool_status }) => status(tool_status?.typed_eslint) && strings(tool_status?.typed_eslint?.evaluated_files)],
  ["quality.react_health", validReact],
  ["correctness.all", (artifact) => execution.get(artifact.execution?.status ?? "")?.(artifact.execution) ?? false],
  ["quality.package_health", validPackage], ["quality.sarif", validImports], ["quality.runtime", validRuntime],
  ["testing.coverage", (artifact) => importStatus(artifact.summary.status) && coveredFiles(artifact.files) && isUnknownArray(artifact.functions)],
  ["audit", (artifact) => isUnknownArray(artifact.findings) && boolean(artifact.summary.complete) &&
    strings(artifact.summary.incomplete_reasons) && strings(artifact.summary.verification_failures) && oneOf("pass", "warn", "fail", "incomplete")(artifact.summary.verdict)],
]);

/** Critical payload validation is independent of the common-wire projection. */
export function validProducerPayload(artifact: Artifact): boolean {
  return checks.get(artifact.task_id)?.(artifact) ?? true;
}
const envelope = shape({ schema_version: string, task_id: string, project: isRecord, provenance: isRecord, confidence: isRecord, summary: isRecord });
export function isArtifactEnvelope(value: unknown): value is Artifact {
  return envelope(value) && validWireExtension(value.evidence_contract);
}
