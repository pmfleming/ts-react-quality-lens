import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const binPath = path.resolve("dist/bin/ts-react-quality-lens.js");
if (!fs.existsSync(binPath)) throw new Error("Built CLI bin is missing. Run npm run build first.");

const help = childProcess.execFileSync("node", [binPath, "--help"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
for (const command of ["catalog", "init", "measure", "audit", "context"]) {
  if (!help.includes(command)) throw new Error(`CLI help is missing ${command}.`);
}

const packJson = process.platform === "win32"
  ? childProcess.execFileSync("cmd.exe", ["/d", "/s", "/c", "npm pack --dry-run --json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  : childProcess.execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
const [pack] = JSON.parse(packJson) as Array<{ files?: Array<{ path?: string }> }>;
const files = new Set((pack?.files ?? []).map((file) => file.path));
for (const required of [
  "dist/bin/ts-react-quality-lens.js",
  "ts-react-quality-lens.schema.json",
  "ts-react-quality-lens.config.schema.json",
  "README.md",
]) {
  if (!files.has(required)) throw new Error(`Package dry-run is missing ${required}.`);
}

console.log(JSON.stringify({ package_smoke: "passed", files: files.size }, null, 2));
