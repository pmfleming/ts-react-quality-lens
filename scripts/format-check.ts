import fs from "node:fs";
import path from "node:path";

const checkedExtensions = new Set([".js", ".jsx", ".js", ".ts", ".tsx", ".json", ".md", ".html", ".yml", ".yaml"]);
const ignored = new Set(["node_modules", ".git", "target", "coverage", "dist", "build"]);
const failures: string[] = [];

for (const file of collect(".")) {
  const extension = path.extname(file);
  if (!checkedExtensions.has(extension)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (!text.endsWith("\n")) failures.push(`${file}: missing final newline`);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/[ \t]$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
    if (line.includes("\t")) failures.push(`${file}:${index + 1}: tab character`);
  });
  if (extension === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      failures.push(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

function collect(root: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...collect(fullPath));
    if (entry.isFile()) result.push(fullPath);
  }
  return result;
}
