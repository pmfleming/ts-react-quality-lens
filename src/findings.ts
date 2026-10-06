import { isRecord, isUnknownArray } from "./collections.js";
import type { ScoredRecord } from "./types.js";

export const FINDING_COLLECTIONS = ["records", "groups", "findings", "disagreements", "unconfirmed"] as const;
export function isScoredRecord(value: unknown): value is ScoredRecord {
  return isRecord(value) && typeof value.id === "string";
}
export function findingRecords(value: unknown): ScoredRecord[] {
  return isUnknownArray(value) ? value.filter(isScoredRecord) : [];
}
export function artifactFindings(value: unknown): ScoredRecord[] {
  return isRecord(value) ? ["findings", "records", "groups", "disagreements", "unconfirmed"].flatMap((key) => findingRecords(value[key])) : [];
}
