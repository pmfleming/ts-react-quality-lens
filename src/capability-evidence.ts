/** Cross-lens capability contract v1. Quality verdict is deliberately separate. */
export type CapabilityStatus = "completed" | "partial" | "unavailable" | "disabled" | "not_applicable" | "failed_execution";
export type CapabilityEvidence = {
  schema_version: 1;
  capability: string;
  scope: string;
  status: CapabilityStatus;
  evaluated: number;
  skipped: number;
  reasons: string[];
};

export function capabilityEvidence(capability: string, scope: string, evaluated: number, skipped: number, reasons: string[] = [], status?: CapabilityStatus): CapabilityEvidence {
  const result: CapabilityEvidence = { schema_version: 1, capability, scope, status: status ?? (skipped ? "partial" : "completed"), evaluated, skipped, reasons };
  if (!validCapabilityEvidence(result)) throw new Error("Invalid capability evidence");
  return result;
}

export function validCapabilityEvidence(value: unknown): value is CapabilityEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const statuses: string[] = ["completed", "partial", "unavailable", "disabled", "not_applicable", "failed_execution"];
  return item.schema_version === 1 && typeof item.capability === "string" && item.capability.trim().length > 0 &&
    typeof item.scope === "string" && item.scope.trim().length > 0 && typeof item.status === "string" && statuses.includes(item.status) &&
    Number.isSafeInteger(item.evaluated) && Number(item.evaluated) >= 0 && Number.isSafeInteger(item.skipped) && Number(item.skipped) >= 0 &&
    Array.isArray(item.reasons) && item.reasons.every((reason) => typeof reason === "string" && reason.trim().length > 0) &&
    (item.status === "completed" ? item.skipped === 0 && item.reasons.length === 0 : item.reasons.length > 0) &&
    (!["disabled", "not_applicable", "unavailable", "failed_execution"].includes(item.status) || item.evaluated === 0);
}
