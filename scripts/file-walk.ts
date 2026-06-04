import fs from "node:fs";
import path from "node:path";

export function collectFiles(root: string, ignored = new Set<string>()): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(fullPath, ignored));
    if (entry.isFile()) result.push(fullPath);
  }
  return result;
}
