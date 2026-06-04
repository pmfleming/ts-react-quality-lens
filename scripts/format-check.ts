import fs from "node:fs";
import path from "node:path";
import { collectFiles } from "./file-walk.js";

const checkedExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".html", ".yml", ".yaml"]);
const ignored = new Set(["node_modules", ".git", "target", "coverage", "dist", "build"]);
const failures: string[] = [];

for (const file of collectFiles(".", ignored)) {
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
