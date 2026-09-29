import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createLspSession } from "../src/lsp.js";
import { dispatchMcp } from "../src/mcp.js";
import { MEASURE_TASKS } from "../src/measures/registry.js";
import { enrichArtifactFindings, enrichFinding } from "../src/actions.js";
import { writeArtifact } from "../src/writer.js";
import type { Artifact, Config, ScoredRecord } from "../src/types.js";

async function fixture(run: (root: string, config: Config) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-editor-agent-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "editor-agent", type: "module" }));
  fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), '{\n  // Keep this comment\n  "source_roots": ["src"],\n  "policy": {"required_checks": []}\n}\n');
  try { await run(root, loadConfig(path.join(root, "ts-react-quality-lens.config.json"))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const finding: ScoredRecord = { id: "example", file: "src/a.ts", line: 1, rule_id: "example/rule", disposition: "warn" };
function artifact(): Artifact {
  return {
    schema_version: "test", task_id: "quality.hotspots",
    project: { name: "test", root: ".", framework: "unknown", package_manager: "npm", test_runner: "unknown" },
    provenance: {}, confidence: {}, summary: {},
  };
}

test("LSP clears resolved diagnostics and respects configured suppressions after reload", () => fixture(async (_root, config) => {
  const notifications: Array<{ uri: string; diagnostics: unknown[] }> = [];
  let records = [finding];
  const session = createLspSession(config, async (current) => records.map((record) => ({
    ...record, suppressed: current.suppressions.some((suppression) => suppression.id === record.id),
  })), (_method, value) => notifications.push(value as { uri: string; diagnostics: unknown[] }));
  try {
    await session.handle({ method: "initialized" });
    assert.equal(notifications.at(-1)?.diagnostics.length, 1);
    assert.equal(await session.handle({ id: 1, method: "toString" }), null);
    assert.deepEqual(await session.handle({ method: "workspace/executeCommand", params: {
      command: "tsrqlens.explainFinding", arguments: [finding.id],
    } }), { ...finding, suppressed: false });
    records = [];
    await session.handle({ method: "textDocument/didSave" });
    assert.equal(notifications.at(-1)?.diagnostics.length, 0);
    const workspace = await session.handle({ method: "workspace/diagnostic" }) as { items: Array<{ items: unknown[] }> };
    assert.deepEqual(workspace.items.map((item) => item.items), [[]]);
    records = [finding];
    fs.writeFileSync(config.configPath, JSON.stringify({ source_roots: ["src"], suppressions: [{ id: finding.id, reason: "intentional" }] }));
    await session.handle({ method: "workspace/didChangeConfiguration" });
    assert.equal(notifications.at(-1)?.diagnostics.length, 0);
  } finally { session.dispose(); }
}));

type Position = { line: number; character: number };
type TextEdit = { range: { start: Position; end: Position }; newText: string };
type CodeAction = { edit?: { changes: Record<string, TextEdit[]> }; kind?: string };

function applyEdits(text: string, edits: TextEdit[]): string {
  const offset = (position: Position) => text.split("\n").slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  const ranges = edits.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText }));
  for (const edit of ranges.sort((left, right) => right.start - left.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

test("editor suppression actions are executable JSONC-preserving edits", () => fixture(async (_root, config) => {
  for (const text of [
    fs.readFileSync(config.configPath, "utf8"),
    '{ "suppressions": [ /* keep */ ], }',
    '{ "suppressions": [{ "id": "other", "reason": "keep" } /* keep */] }',
    '{ "suppressions": [{ "id": "other", "reason": "keep" }, /* keep */] }',
  ]) {
    fs.writeFileSync(config.configPath, text);
    const session = createLspSession(config, async () => [finding], () => {});
    try {
      const actions = await session.handle({ method: "textDocument/codeAction", params: {
        context: { diagnostics: [{ data: { finding_id: finding.id } }] },
      } }) as CodeAction[];
      const action = actions.find((item) => item.edit);
      assert.ok(action?.edit);
      const edits = action.edit.changes[pathToFileURL(config.configPath).href];
      assert.ok(edits);
      const updated = applyEdits(text, edits);
      assert.ok(updated.includes(text.includes("Keep this comment") ? "Keep this comment" : "/* keep */"));
      fs.writeFileSync(config.configPath, updated);
      assert.ok(loadConfig(config.configPath).suppressions.some((suppression) => suppression.id === finding.id));
    } finally { session.dispose(); }
  }
  const enriched = enrichArtifactFindings(config, { ...artifact(), records: [finding] });
  assert.ok(enriched.records?.every((record) => record.actions?.every((action) => action.type !== "suppress-line" && action.type !== "suppress-file")));
  assert.equal(enrichFinding(config, { id: "diagnostic", kind: "compiler_diagnostic" }).finding_confidence, "high");
  assert.equal(enrichFinding(config, { id: "heuristic", source: "structural-type-scan" }).finding_confidence, "medium");
  assert.equal(enrichFinding(config, { id: "explicit", evidence_kind: "metric", finding_confidence: "low" }).finding_confidence, "low");
}));

test("LSP handles shutdown while analysis is pending without publishing stale results", () => fixture(async (_root, config) => {
  let finish: (records: ScoredRecord[]) => void = () => {};
  const pending = new Promise<ScoredRecord[]>((resolve) => { finish = resolve; });
  const notifications: unknown[] = [];
  const session = createLspSession(config, () => pending, (_method, value) => notifications.push(value));
  const initial = session.handle({ method: "initialized" });
  await session.handle({ id: 1, method: "shutdown" });
  assert.equal(session.wasShutdown(), true);
  finish([finding]);
  await initial;
  assert.deepEqual(notifications, []);
  session.dispose();
}));

test("MCP restricts resources and explains grouped and audit findings", () => fixture((root, config) => {
  writeArtifact(config, "hotspots.json", { ...artifact(), groups: [finding] });
  const request = { method: "tools/call", params: { name: "explain", arguments: { finding_id: finding.id } } };
  let response = dispatchMcp(config, request) as { structuredContent: { finding: ScoredRecord } };
  assert.equal(response.structuredContent.finding.id, finding.id);
  writeArtifact(config, "audit.json", { ...artifact(), findings: [{ ...finding, introduced: true }] });
  response = dispatchMcp(config, request) as typeof response;
  assert.equal(response.structuredContent.finding.introduced, true);
  assert.throws(() => dispatchMcp(config, { method: "resources/read", params: { uri: "tsrqlens://artifact/../../private.json" } }));
  assert.throws(() => dispatchMcp(config, { method: "resources/read", params: { uri: "tsrqlens://artifact/private.json" } }));
  fs.rmSync(path.join(config.outputDir, "hotspots.json"));
  // Junctions exercise real-path containment on Windows without file-symlink privileges.
  fs.symlinkSync(process.platform === "win32" ? root : config.configPath,
    path.join(config.outputDir, "hotspots.json"), process.platform === "win32" ? "junction" : "file");
  assert.throws(() => dispatchMcp(config, { method: "resources/read", params: { uri: "tsrqlens://artifact/hotspots.json" } }), /outside/);
}));

test("MCP requires explicit permission to execute project tests", () => fixture((root, config) => {
  config.testCommand = `node -e "require('node:fs').writeFileSync('test-ran', 'yes')"`;
  assert.throws(() => dispatchMcp(config, { method: "tools/call", params: { name: "measure", arguments: { task_id: "correctness.all" } } }), /permission/);
  assert.equal(fs.existsSync(path.join(root, "test-ran")), false);
  dispatchMcp(config, { method: "tools/call", params: { name: "run_tests", arguments: {} } });
  assert.equal(fs.readFileSync(path.join(root, "test-ran"), "utf8"), "yes");
  const tasks = new Map(MEASURE_TASKS);
  const ran: string[] = [];
  for (const [id, task] of tasks) MEASURE_TASKS.set(id, { ...task, handler: () => { ran.push(id); return artifact(); } });
  try {
    dispatchMcp(config, { method: "tools/call", params: { name: "measure", arguments: { task_id: "all" } } });
    assert.ok(!ran.includes("correctness.all"));
    ran.length = 0;
    dispatchMcp(config, { method: "tools/call", params: { name: "audit", arguments: {} } });
    assert.ok(ran.includes("correctness.catalog"));
    assert.ok(!ran.includes("correctness.all"));
    dispatchMcp(config, { method: "tools/call", params: { name: "audit", arguments: { run_tests: true } } });
    assert.ok(ran.includes("correctness.all"));
  } finally { for (const [id, task] of tasks) MEASURE_TASKS.set(id, task); }
}));
