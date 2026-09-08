import { isRecord } from "./collections.js";
import type { ScoredRecord } from "./types.js";

export function artifactFindings(value: unknown): ScoredRecord[] {
  if (!isRecord(value)) return [];
  return [value.findings, value.records, value.groups, value.disagreements, value.unconfirmed].flatMap((group) =>
    Array.isArray(group) ? group.filter((item): item is ScoredRecord => isRecord(item) && typeof item.id === "string") : []);
}
