import { isRecord } from "./collections.js";
import type { Artifact } from "./types.js";

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const status = (value: unknown): value is Record<string, unknown> => isRecord(value) &&
  ["available", "ran", "complete"].every((key) => typeof value[key] === "boolean") &&
  (value.reason === null || typeof value.reason === "string") &&
  (value.complete !== true || value.available === true && value.ran === true);

export function validPublintMessages(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item) && text(item.code) &&
    ["error", "warning", "suggestion"].includes(String(item.type)) && strings(item.path) && isRecord(item.args));
}

export function validAttwProblems(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item) && text(item.kind) &&
    (item.entrypoint === undefined || text(item.entrypoint)) && (item.resolutionKind === undefined || text(item.resolutionKind)));
}

/** Critical native payloads are checked even when an enclosing wire projection is self-consistent. */
export function validProducerPayload(artifact: Artifact): boolean {
  const tools = artifact.tool_status ?? {};
  switch (artifact.task_id) {
    case "quality.type_health": return typeof artifact.confidence.typescript_program_loaded === "boolean" &&
      isRecord(tools.compiler_api) && typeof tools.compiler_api.loaded === "boolean" &&
      tools.compiler_api.loaded === artifact.confidence.typescript_program_loaded && Array.isArray(artifact.diagnostics);
    case "quality.lint": return status(tools.typed_eslint) && strings(tools.typed_eslint.evaluated_files);
    case "quality.react_health": return status(tools.eslint_react_hooks) && status(tools.jsx_a11y);
    case "correctness.all": {
      const execution = artifact.execution;
      if (!execution) return false;
      if (execution.status === "unknown") return text(execution.reason);
      if (execution.status === "not_run") return execution.command === null || text(execution.command);
      return text(execution.command) && (execution.status === "passed" || execution.status === "failed" &&
        (execution.exit_code === null || Number.isSafeInteger(execution.exit_code)) && typeof execution.stdout === "string" && typeof execution.stderr === "string");
    }
    case "quality.package_health": {
      const statuses = ["declaration_emit", "npm_pack", "publint", "are_the_types_wrong"].map((name) => tools[name]);
      return statuses.every(status) && isRecord(artifact.package_evidence) &&
        validPublintMessages(artifact.package_evidence.publint_messages) && validAttwProblems(artifact.package_evidence.attw_problems) &&
        ["disabled", "complete", "incomplete"].includes(String(artifact.summary.status)) &&
        artifact.summary.complete === (artifact.summary.status === "complete") &&
        (artifact.summary.complete !== true || statuses.every((item) => item?.complete === true));
    }
    case "quality.sarif":
    case "quality.runtime": {
      const statuses = Object.values(tools);
      return statuses.every(status) && ["not_configured", "complete", "incomplete"].includes(String(artifact.summary.status)) &&
        (artifact.summary.status !== "complete" || statuses.some((item) => item.path !== null) &&
          statuses.filter((item) => item.path !== null).every((item) => item.complete === true));
    }
    case "testing.coverage": return ["not_configured", "complete", "incomplete"].includes(String(artifact.summary.status)) &&
      Array.isArray(artifact.files) && Array.isArray(artifact.functions) && artifact.files.every((file) => isRecord(file) &&
        text(file.file) && Array.isArray(file.line_hits) && file.line_hits.every((hit) => isRecord(hit) &&
          Number.isSafeInteger(hit.line) && Number(hit.line) > 0 && typeof hit.hits === "number" && Number.isFinite(hit.hits) && hit.hits >= 0));
    case "audit": return Array.isArray(artifact.findings) && typeof artifact.summary.complete === "boolean" &&
      strings(artifact.summary.incomplete_reasons) && strings(artifact.summary.verification_failures) &&
      ["pass", "warn", "fail", "incomplete"].includes(String(artifact.summary.verdict));
    default: return true;
  }
}
