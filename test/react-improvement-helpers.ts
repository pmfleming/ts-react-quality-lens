import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/types.js";

export function reactFixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-react-next-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "react-next", dependencies: { react: "^19.2.0" } }));
  fs.writeFileSync(path.join(root, "src/main.tsx"), "export function App() { return <div />; }\n");
  fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], cache: { enabled: false }, policy: { required_checks: [] } }));
  try { run(root, loadConfig(path.join(root, "lens.json"))); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
