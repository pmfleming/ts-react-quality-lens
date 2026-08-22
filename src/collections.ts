export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function groupBy<T, K>(values: T[], keyFn: (value: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
  }
  return map;
}

export function countBy<T, K>(values: T[], keyFn: (value: T) => K): Map<K, number> {
  const map = new Map<K, number>();
  for (const value of values) {
    const key = keyFn(value);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function dedupeBy<T, K>(values: T[], keyFn: (value: T) => K): T[] {
  const seen = new Set<K>();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}
