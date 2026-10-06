import { isRecord } from "./collections.js";
import { arrayOf, finite, nonempty, nullable, oneOf, optional, positiveInteger, shape } from "./validation.js";

type Producer = { name: string; version: string };
type Base = { schema_version: 1 };
export type WireEvidence = Base & (
  | { kind: "run"; id: string; analyzer: Producer; ruleset: string; config_fingerprint: string; input_fingerprint: string; language_profile: string; producers: Producer[] }
  | { kind: "finding"; id: string; rule_id: string; subject: string; run_id: string; locations: Array<{ file: string; line: number }>;
      evidence_kind: "diagnostic" | "test" | "metric" | "heuristic" | "semantic" | "tool-rule";
      confidence: "high" | "medium" | "low"; severity: "error" | "warning" | "note"; disposition: "block" | "warn" | "review" | "info";
      message: string; suppression: { reason: string } | null }
  | { kind: "measurement"; name: string; value: number | null; unit: string; scope: string; model: string; run_id: string;
      uncertainty: { lower: number; upper: number } | null; limitations: string[] }
  | { kind: "comparison"; status: "compatible" | "incompatible" | "unknown"; current_run: string; baseline_run: string | null; reasons: string[] }
);

const producer = shape({ name: nonempty, version: nonempty });
const measurement = shape({ name: nonempty, value: nullable(finite), unit: nonempty, scope: nonempty, model: nonempty, run_id: nonempty,
  limitations: arrayOf(nonempty), uncertainty: nullable(shape({ lower: finite, upper: finite })) });
const comparison = shape({ current_run: nonempty, baseline_run: nullable(nonempty), reasons: arrayOf(nonempty),
  status: oneOf("compatible", "incompatible", "unknown") });
const variants = new Map<string, (value: unknown) => boolean>([
  ["run", shape({ id: nonempty, ruleset: nonempty, config_fingerprint: nonempty, input_fingerprint: nonempty,
    language_profile: nonempty, analyzer: producer, producers: arrayOf(producer) })],
  ["finding", shape({ id: nonempty, rule_id: (value): value is string => nonempty(value) && /[./:]/.test(value),
    subject: nonempty, run_id: nonempty, message: nonempty,
    evidence_kind: oneOf("diagnostic", "test", "metric", "heuristic", "semantic", "tool-rule"),
    confidence: oneOf("high", "medium", "low"), severity: oneOf("error", "warning", "note"), disposition: oneOf("block", "warn", "review", "info"),
    locations: arrayOf(shape({ file: nonempty, line: positiveInteger })), suppression: nullable(shape({ reason: nonempty })) })],
  ["measurement", (value) => measurement(value) && (value.value !== null || value.limitations.length > 0) &&
    (value.uncertainty === null || value.value !== null && value.uncertainty.lower <= value.uncertainty.upper)],
  ["comparison", (value) => comparison(value) && (value.status === "compatible"
    ? value.baseline_run !== null && value.reasons.length === 0 : value.reasons.length > 0)],
]);

/** Validate optional cross-lens evidence once at an untrusted JSON boundary. */
export function isWireEvidence(value: unknown): value is WireEvidence {
  return isRecord(value) && value.schema_version === 1 && typeof value.kind === "string" && (variants.get(value.kind)?.(value) ?? false);
}
export const validWireExtension = optional(arrayOf(isWireEvidence));
