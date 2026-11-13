import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { cycleKey } from "../src/graph.js";
import { runMeasure } from "../src/measure-runner.js";
import { readArtifact } from "../src/writer.js";
import type { Config, ScoredRecord } from "../src/types.js";

function project(files: Record<string, string>, run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-dependency-health-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dependency-health", private: true }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true, paths: { "@/*": ["./src/*"] },
    }, include: ["src"] }));
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], test_command: null, cache: { enabled: false },
      layer_rules: [{ layer: "ui", patterns: ["src/ui/**"] }, { layer: "core", patterns: ["src/core/**"] }] }));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    run(root, loadConfig(path.join(root, "lens.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const FILES = {
  "src/alias/a.ts": 'import { b } from "@/alias/b";\nexport const a = (): number => b() + 1;\n',
  "src/alias/b.ts": 'import { a } from "@/alias/a";\nexport const b = (): number => a() + 1;\n',
  "src/rel/c.ts": 'import { d } from "./d";\nexport const c = (): number => d() + 1;\n',
  "src/rel/d.ts": 'import { c } from "./c";\nexport const d = (): number => c() + 1;\n',
  "src/core/main.ts": 'import { helper } from "../ui/widget";\nexport const run = (): number => helper();\n',
  "src/ui/widget.ts": "export const helper = (): number => 1;\n",
};
const cyclesOf = (records: ScoredRecord[] = []) => records.filter((record) => record.kind === "import_cycle");

test("dependency cycles cover path aliases, are reported once per cycle and locate files", () => project(FILES, (_root, config) => {
  runMeasure(config, "map.architecture", "test dependency seam");
  const health = readArtifact(config, "dependency_health.json");
  assert.ok(health);
  assert.equal(health.tool_status?.dependency_cruiser?.ran, true, "the external engine ran, so the internal witness is supplemental");
  const cycles = cyclesOf(health.records);
  assert.deepEqual(cycles.map((record) => record.files).sort(), [["src/alias/a.ts", "src/alias/b.ts"], ["src/rel/c.ts", "src/rel/d.ts"]],
    "the alias cycle is reported, and each rotation of the relative cycle only once");
  assert.equal(health.summary.cycles, 2);
  assert.equal(cycles.find((record) => record.files?.includes("src/rel/c.ts"))?.source, "dependency-cruiser");
  const layer = health.records?.find((record) => record.kind === "layer_violation");
  assert.equal(layer?.file, "src/core/main.ts");
  for (const record of health.records ?? []) {
    for (const file of [record.file, ...(record.files ?? [])].filter((item): item is string => typeof item === "string")) {
      assert.ok(fs.existsSync(path.join(config.projectRoot, file)), `${record.id} locates a real file, not a module id: ${file}`);
    }
  }

  const map = readArtifact(config, "map.json");
  const risk = (file: string) => (map?.nodes as Array<{ file: string; architectural_risk: number }> | undefined)
    ?.find((node) => node.file === file)?.architectural_risk;
  for (const file of ["src/alias/a.ts", "src/rel/c.ts"]) assert.ok((risk(file) ?? 0) > 0, `${file} carries its cycle's architecture risk`);
  assert.equal(risk("src/core/main.ts"), 75, "the layer violation reaches its importing module");
  assert.equal(risk("src/ui/widget.ts"), 0);
}));

test("cycle IDs depend on the cycle, not its position, so a new cycle cannot take over an existing ID", () => project(FILES, (root, config) => {
  runMeasure(config, "quality.dependency_health", "test cycle identity");
  const before = new Map(cyclesOf(readArtifact(config, "dependency_health.json")?.records).map((record) => [record.files?.join(), record.id]));
  // A new cycle whose path sorts before both existing ones.
  fs.mkdirSync(path.join(root, "src/aaa"));
  fs.writeFileSync(path.join(root, "src/aaa/x.ts"), 'import { y } from "./y";\nexport const x = (): number => y();\n');
  fs.writeFileSync(path.join(root, "src/aaa/y.ts"), 'import { x } from "./x";\nexport const y = (): number => x();\n');
  runMeasure(config, "quality.dependency_health", "test cycle identity");
  const after = cyclesOf(readArtifact(config, "dependency_health.json")?.records);
  assert.equal(after.length, 3);
  for (const [files, id] of before) assert.equal(after.find((record) => record.files?.join() === files)?.id, id);
  assert.equal(new Set(after.map((record) => record.id)).size, 3);
}));

test("cycle keys are rotation-independent for open and closed paths", () => {
  const key = cycleKey(["a", "b", "c", "a"]);
  assert.equal(key, "a -> b -> c -> a");
  for (const path of [["b", "c", "a", "b"], ["c", "a", "b"], ["a", "b", "c"]]) assert.equal(cycleKey(path), key);
  assert.notEqual(cycleKey(["a", "c", "b"]), key, "direction is part of the identity");
});
