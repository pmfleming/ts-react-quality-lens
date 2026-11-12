import { isRecord } from "./collections.js";
import { arrayOf, boolean, count, nonempty, nullable, oneOf, positiveInteger, shape, string } from "./validation.js";
import type { Artifact } from "./types.js";

const strings = arrayOf(string);
const executionStatus = oneOf("disabled", "unavailable", "failed", "succeeded");
const execution = shape({ status: executionStatus, available: boolean, ran: boolean, complete: boolean,
  reason: nullable(string), version: nullable(nonempty), active_rules: nullable(count), active_guides: nullable(count),
  coverage: oneOf("not_run", "unknown"), limitations: arrayOf(nonempty) });
const targets = shape({ status: oneOf("resolved", "unknown"), workspace: nonempty, source: nullable(string), environment: nonempty,
  queries: strings, resolved: strings, reason: nullable(string), config_files: strings });
const compatibility = shape({ status: oneOf("supported", "fallback_required", "incompatible", "unknown"), feature_ids: strings,
  unsupported_targets: strings, unknown_targets: strings, reason: nonempty,
  remediation: oneOf("review_replacement", "review_fallback", "withheld"), guard: oneOf("observed", "not_observed", "not_assessed") });
const record = shape({ source: oneOf("modern-web-guidance"), disposition: oneOf("review"), evidence_kind: oneOf("heuristic"),
  semantic_decision: oneOf("unresolved"), contextual_verification: oneOf("pending"), guide_id: nonempty, guide_url: nonempty,
  upstream_message: nonempty, file: nonempty, line: positiveInteger, compatibility,
  verification: nullable(shape({ keepWhen: strings, dropWhen: strings })), browser_targets: nullable(targets) });
const inputs = shape({ fingerprint: nonempty, files: arrayOf(shape({ file: nonempty, kind: oneOf("script", "html", "css", "manifest") })),
  skipped: arrayOf(shape({ file: nonempty, reason: nonempty })), configuration_files: strings });

export function validModernWebPayload(artifact: Artifact): boolean {
  const tool = artifact.tool_status?.modern_web;
  const inventory = artifact.inputs;
  const records: unknown = artifact.records;
  if (!execution(tool) || !inputs(inventory) || !arrayOf(record)(records) ||
      !isRecord(artifact.browser_targets) || !Object.values(artifact.browser_targets).every(targets) ||
      !isRecord(artifact.browser_data_versions) || !Object.values(artifact.browser_data_versions).every(nullable(nonempty))) return false;
  const succeeded = tool.status === "succeeded";
  if (artifact.summary.status !== tool.status || artifact.summary.records !== records.length ||
      artifact.summary.selected_files !== inventory.files.length || artifact.summary.skipped_files !== inventory.skipped.length ||
      artifact.summary.coverage !== tool.coverage || artifact.summary.contextual_verification !== "pending" ||
      artifact.provenance.source_set_hash !== inventory.fingerprint || tool.complete !== succeeded ||
      succeeded && (!tool.available || !tool.ran || tool.coverage !== "unknown" || tool.reason !== null) ||
      !succeeded && records.length > 0) return false;
  if (tool.status === "disabled" && (tool.available || tool.ran || tool.version !== null) ||
      tool.status === "unavailable" && tool.ran || tool.status === "failed" && !tool.available) return false;
  return records.every((item) => {
    const c = item.compatibility;
    if (!inventory.files.some((input) => input.file === item.file)) return false;
    if (c.status === "unknown") return c.remediation === "withheld";
    if (item.browser_targets?.status !== "resolved" || !item.browser_targets.resolved.length || !c.feature_ids.length || c.unknown_targets.length) return false;
    if (!c.unsupported_targets.every((target) => item.browser_targets?.resolved.includes(target))) return false;
    return c.status === "supported" ? c.remediation === "review_replacement" && c.unsupported_targets.length === 0
      : c.status === "incompatible" ? c.remediation === "withheld" && c.unsupported_targets.length === item.browser_targets.resolved.length
        : c.remediation === "review_fallback" && c.unsupported_targets.length > 0 && c.unsupported_targets.length < item.browser_targets.resolved.length;
  });
}
