import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["bin", "scripts", "src", "test"];
const files = roots.flatMap((root) => collect(root)).filter((file) => /\.(?:mjs|js|cjs)$/.test(file));

for (const file of files) {
  childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

function collect(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...collect(fullPath));
    if (entry.isFile()) result.push(fullPath);
  }
  return result;
}
