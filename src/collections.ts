export function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

export function countBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function dedupeBy(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function countMatches(text, re) {
  return [...text.matchAll(re)].length;
}
