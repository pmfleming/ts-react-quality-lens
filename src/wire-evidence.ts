import { isRecord } from "./collections.js";

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

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const producer = (value: unknown): value is Producer => isRecord(value) && text(value.name) && text(value.version);
const member = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value);

/** Validate optional cross-lens evidence once at an untrusted JSON boundary. */
export function isWireEvidence(value: unknown): value is WireEvidence {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  switch (value.kind) {
    case "run": return [value.id, value.ruleset, value.config_fingerprint, value.input_fingerprint, value.language_profile].every(text)
      && producer(value.analyzer) && Array.isArray(value.producers) && value.producers.every(producer);
    case "finding": return [value.id, value.rule_id, value.subject, value.run_id, value.message].every(text)
      && typeof value.rule_id === "string" && /[./:]/.test(value.rule_id)
      && member(value.evidence_kind, ["diagnostic", "test", "metric", "heuristic", "semantic", "tool-rule"])
      && member(value.confidence, ["high", "medium", "low"]) && member(value.severity, ["error", "warning", "note"])
      && member(value.disposition, ["block", "warn", "review", "info"])
      && Array.isArray(value.locations) && value.locations.every((location) => isRecord(location) && text(location.file) && Number.isSafeInteger(location.line) && Number(location.line) > 0)
      && (value.suppression === null || (isRecord(value.suppression) && text(value.suppression.reason)));
    case "measurement": return [value.name, value.unit, value.scope, value.model, value.run_id].every(text) && strings(value.limitations)
      && (finite(value.value) || (value.value === null && value.limitations.length > 0))
      && (value.uncertainty === null || (finite(value.value) && isRecord(value.uncertainty) && finite(value.uncertainty.lower) && finite(value.uncertainty.upper) && value.uncertainty.lower <= value.uncertainty.upper));
    case "comparison": return text(value.current_run) && (value.baseline_run === null || text(value.baseline_run)) && strings(value.reasons)
      && member(value.status, ["compatible", "incompatible", "unknown"])
      && (value.status === "compatible" ? text(value.baseline_run) && value.reasons.length === 0 : value.reasons.length > 0);
    default: return false;
  }
}

export function validWireExtension(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isWireEvidence));
}
