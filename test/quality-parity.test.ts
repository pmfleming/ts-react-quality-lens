import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { inputSnapshot } from "../src/input-snapshot.js";
import { escapeRecords } from "../src/scoring.js";

function project(run: (root: string, config: ReturnType<typeof loadConfig>) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-parity-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"parity"}');
  fs.writeFileSync(path.join(root, "src/main.ts"), `
export const state = { kind: "ready" } as const;
export const checked = { kind: "ready" } satisfies { kind: string };
const element = document.querySelector("#app");
const other = document.getElementById("app");
const unsafe = state as unknown as number;
element!.innerHTML = "changed";
`);
  const configPath = path.join(root, "ts-react-quality-lens.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
  try { run(root, loadConfig(configPath)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("const assertions, satisfies and DOM reads are not escape hatches", () => project((_root, config) => {
  const records = createAnalysisContext(config).project().modules.flatMap(escapeRecords);
  assert.equal(records.filter((record) => record.kind === "type_assertion").length, 1);
  assert.equal(records.filter((record) => record.kind === "double_assertion").length, 1);
  assert.equal(records.filter((record) => record.kind === "direct_dom_mutation").length, 1);
}));

test("input snapshots detect edits, discovery changes and configuration changes", () => project((root, config) => {
  const context = createAnalysisContext(config);
  const unchanged = inputSnapshot(config, context.project());
  assert.equal(unchanged(), null);
  fs.appendFileSync(path.join(root, "src/main.ts"), "\nexport const added = 1;\n");
  assert.match(unchanged() ?? "", /changed/);
  const discovery = inputSnapshot(config, context.project());
  fs.writeFileSync(path.join(root, "src/new.ts"), "export {};\n");
  assert.match(discovery() ?? "", /changed/);
  const configuration = inputSnapshot(config, context.project());
  fs.appendFileSync(config.configPath, "\n");
  assert.match(configuration() ?? "", /changed/);
}));
