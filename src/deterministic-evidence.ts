import { isRecord } from "./collections.js";
import { validNativeEvidence } from "./artifact-evidence.js";
import type { Artifact } from "./types.js";

/** Exact boundary: telemetry is separate; only declared timestamps/run identities are normalized. */
export function deterministicEvidence(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("Expected an artifact object");
  if (isRecord(value.provenance) && value.provenance.run_id !== undefined && !validNativeEvidence(value as Artifact)) {
    throw new Error("Refusing to normalize invalid native evidence");
  }
  const result = structuredClone(value);
  delete result.telemetry;
  if (isRecord(result.provenance)) {
    delete result.provenance.measured_at;
    if (typeof result.provenance.run_id === "string") result.provenance.run_id = "<producer-run>";
  }
  // Exact generation normalization: retain semantic digests, normalize only raw-byte/run identity.
  if (Array.isArray(result.artifact_inputs)) {
    result.artifact_inputs = result.artifact_inputs.map((item) => {
      if (!isRecord(item)) return item;
      const { sha256: _raw, ...semantic } = item;
      return { ...semantic, run_id: item.run_id === null ? null : `<producer-run:${String(item.file)}>` };
    });
  }
  const baseline = isRecord(result.comparison) && isRecord(result.comparison.baseline) ? result.comparison.baseline : null;
  const baselineId = baseline?.id;
  if (baseline) baseline.id = "<baseline-run>";
  if (Array.isArray(result.evidence_contract)) {
    result.evidence_contract = result.evidence_contract.map((entry) => {
      if (!isRecord(entry)) return entry;
      if (entry.kind === "run") return { ...entry, id: entry.id === baselineId ? "<baseline-run>" : "<producer-run>" };
      if (entry.kind === "finding" || entry.kind === "measurement") return { ...entry, run_id: "<producer-run>" };
      if (entry.kind === "comparison") return { ...entry, current_run: "<producer-run>", baseline_run: entry.baseline_run === null ? null : "<baseline-run>" };
      return entry;
    });
  }
  for (const key of ["records", "groups", "findings", "disagreements", "unconfirmed", "evidence_contract"]) {
    if (Array.isArray(result[key])) result[key] = result[key].map(canonical).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  }
  return canonical(result);
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, canonical(item)])) : value;
}
