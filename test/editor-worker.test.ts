import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { isRecord, isUnknownArray, parseJson } from "../src/collections.js";
import { loadConfig } from "../src/config.js";
import { decodeEditorRequest, decodeEditorResult } from "../src/lsp-protocol.js";
import { workerFindings } from "../src/lsp.js";

const config = loadConfig("examples/basic/ts-react-quality-lens.config.json");
const workerUrl = new URL("../src/lsp-worker.js", import.meta.url);

test("editor boundary validates snapshots, versions, and nested findings", () => {
  const snapshot = { ...config, outputDir: "/caller/override", cache: { enabled: false, dir: "/custom/cache" } };
  assert.deepEqual(decodeEditorRequest({ version: 1, config: structuredClone(snapshot) }), snapshot);
  for (const field of Object.keys(config)) {
    const partial: Record<string, unknown> = { ...config };
    delete partial[field];
    assert.throws(() => decodeEditorRequest({ version: 1, config: partial }), /Invalid editor analysis request/, field);
  }
  for (const value of [null, [], { version: 2, config }, { version: 1, config: { ...config, sourceRoots: [7] } },
    { version: 1, config: { ...config, react: { ...config.react, ruleset: "future" } } },
    { version: 1, config: { ...config, raw: { unknown_setting: true } } }]) {
    assert.throws(() => decodeEditorRequest(value), /Invalid editor analysis request/);
  }
  const finding = { id: "sample", line: 1, related_locations: [{ file: "src/a.ts", start_line: 1, role: "cause" }],
    actions: [{ type: "add-to-config", auto_fixable: false, description: "Suppress", config_key: "suppressions", value: { id: "sample" } }] };
  assert.deepEqual(decodeEditorResult({ version: 1, findings: [finding] }), [finding]);
  for (const value of [null, [], { version: 2, findings: [] }, { version: 1, findings: [{ id: 7 }] },
    ...[{ line: "1" }, { related_locations: [{}] }, { actions: [{ type: "fix", auto_fixable: true, description: "Missing fix" }] },
      { signals: [{ kind: "x", value: {} }] }].map((patch) => ({ version: 1, findings: [{ ...finding, ...patch }] }))]) {
    assert.throws(() => decodeEditorResult(value), /Invalid editor analysis result/);
  }
});

test("worker transport rejects invalid requests, invalid results, crashes, and missing results", async () => {
  const invalid = new Worker(workerUrl, { workerData: { version: 1, config: {} } });
  const error = await new Promise<Error>((resolve) => invalid.once("error", resolve));
  assert.match(error.message, /Invalid editor analysis request/);
  const workers = new Set<Worker>();
  const run = (code: string) => workerFindings(config, workers, new URL(`data:text/javascript,${encodeURIComponent(code)}`));
  for (const [code, expected] of [
    ['import {parentPort} from "node:worker_threads"; parentPort.postMessage({version:1, findings:[{id:"bad", line:"one"}]});', /Invalid editor analysis result/],
    ['throw new Error("worker crashed")', /worker crashed/],
    ["", /exited without a result/],
  ] as const) await assert.rejects(run(code), expected);
  const result = await run('import {parentPort} from "node:worker_threads"; parentPort.postMessage({version:1, findings:[{id:"recovered"}]});');
  assert.deepEqual(result, [{ id: "recovered" }]);
  await Promise.all([...workers].map((worker) => once(worker, "exit")));
  assert.equal(workers.size, 0);
  const pending = run("setInterval(() => {}, 1000)");
  const rejected = assert.rejects(pending, /exited without a result/);
  await Promise.all([...workers].map((worker) => worker.terminate()));
  await rejected;
  assert.equal(workers.size, 0);
});

test("CLI diagnostic roundtrip records subprocess and real worker coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-worker-coverage-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const value: any = 1;\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"worker-fixture","type":"module"}');
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], cleanup: { knip: false }, cache: { enabled: false } }));
    const coverage = process.env.NODE_V8_COVERAGE ?? path.join(root, "coverage");
    const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "workspace/diagnostic" });
    const result = spawnSync(process.execPath, [path.resolve("dist/bin/ts-react-quality-lens.js"), "lsp", "--config", path.join(root, "lens.json")], {
      input: `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`, encoding: "utf8", timeout: 60000,
      env: { ...process.env, NODE_V8_COVERAGE: coverage },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const response = parseJson(result.stdout.slice(result.stdout.indexOf("\r\n\r\n") + 4));
    assert.ok(isRecord(response) && response.id === 7 && isRecord(response.result) && isUnknownArray(response.result.items), result.stdout);
    assert.ok(response.result.items.length > 0, "real worker returned source diagnostics");
    const executed = new Set<string>();
    for (const file of fs.readdirSync(coverage).filter((name) => name.startsWith("coverage-") && name.endsWith(".json"))) {
      const trace = parseJson(fs.readFileSync(path.join(coverage, file), "utf8"));
      if (!isRecord(trace) || !isUnknownArray(trace.result)) continue;
      for (const script of trace.result) {
        if (!isRecord(script) || typeof script.url !== "string" || !isUnknownArray(script.functions)) continue;
        if (script.functions.some((fn) => isRecord(fn) && isUnknownArray(fn.ranges) && fn.ranges.some((range) => isRecord(range) && typeof range.count === "number" && range.count > 0))) executed.add(script.url);
      }
    }
    for (const module of ["cli.js", "lsp.js", "lsp-worker.js", "lsp-protocol.js"]) assert.ok([...executed].some((url) => url.endsWith(`/src/${module}`)), `coverage includes executed ${module}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
