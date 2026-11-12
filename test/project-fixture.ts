import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/types.js";

/** Isolated compiler project; each test owns its source and configuration changes. */
export function typescriptFixture(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-typescript-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","type":"module"}');
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, include: ["src"] }));
    fs.writeFileSync(path.join(root, "lens.json"), '{"source_roots":["src"]}');
    run(root, loadConfig(path.join(root, "lens.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
