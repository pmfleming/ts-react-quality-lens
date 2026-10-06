import { arrayOf, count, nonempty, oneOf, shape } from "./validation.js";

/** Cross-lens capability contract v1. Quality verdict is deliberately separate. */
export type CapabilityStatus = "completed" | "partial" | "unavailable" | "disabled" | "not_applicable" | "failed_execution";
export type CapabilityEvidence = {
  schema_version: 1;
  capability: string;
  scope: string;
} & (
  | { status: "completed"; evaluated: number; skipped: 0; reasons: [] }
  | { status: "partial"; evaluated: number; skipped: number; reasons: [string, ...string[]] }
  | { status: "unavailable" | "disabled" | "not_applicable" | "failed_execution"; evaluated: 0; skipped: number; reasons: [string, ...string[]] }
);

export function capabilityEvidence(capability: string, scope: string, evaluated: number, skipped: number, reasons: string[] = [], status?: CapabilityStatus): CapabilityEvidence {
  const result = { schema_version: 1, capability, scope, status: status ?? (skipped ? "partial" : "completed"), evaluated, skipped, reasons };
  if (!validCapabilityEvidence(result)) throw new Error("Invalid capability evidence");
  return result;
}

const capability = shape({ schema_version: count, capability: nonempty, scope: nonempty, evaluated: count, skipped: count, reasons: arrayOf(nonempty),
  status: oneOf("completed", "partial", "unavailable", "disabled", "not_applicable", "failed_execution") });
export function validCapabilityEvidence(value: unknown): value is CapabilityEvidence {
  return capability(value) && value.schema_version === 1 && (value.status === "completed"
    ? value.skipped === 0 && value.reasons.length === 0
    : value.reasons.length > 0 && (value.status === "partial" || value.evaluated === 0));
}
