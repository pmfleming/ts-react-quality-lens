import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import type { RawConfig } from "../src/types.js";

export function webFixture(run: (fixture: ReturnType<typeof createFixture>) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-modern-web-"));
  try { run(createFixture(root)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function createFixture(root: string) {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", JSON.stringify({ name: "modern-web-fixture" }));
  write("src/index.ts", "export const value = 1;\n");
  const config = (settings: RawConfig = {}) => {
    write("lens.json", JSON.stringify({ test_command: null, ...settings }));
    return loadConfig(path.join(root, "lens.json"));
  };
  return { root, write, config };
}
