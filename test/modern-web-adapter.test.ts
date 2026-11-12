import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseModernWebReport, runModernWeb } from "../src/integrations/modern-web-adapter.js";
import { modernWebUnavailableReason, resolveModernWebTool } from "../src/integrations/modern-web-tool.js";
import { modernWebFindings } from "../src/modern-web-findings.js";
import { discoverWebInputs } from "../src/web-inputs.js";
import { webFixture } from "./modern-web-helpers.js";

function payload(targetDir: string) {
  return { targetDir, totalFindings: 1, activeRuleCount: 1, activeGuideCount: 1, guides: [{ guideId: "field-sizing", count: 1,
    rules: [{ ruleId: "textarea-size", summary: "Consider native sizing", count: 1,
      verifierRubric: { keepWhen: ["textarea sizing"], dropWhen: ["virtualized list"] },
      findings: [{ file: "src/index.ts", line: 1, message: "Candidate", lineContent: "export const value = 1;" }] }] }] };
}

test("scanner boundary validates counts, file scope, source locations and verification rubrics", () => webFixture(({ config }) => {
  const c = config({ modern_web: { enabled: true } }), inputs = discoverWebInputs(c), snapshot = path.resolve("snapshot");
  const value = payload(snapshot);
  const parsed = parseModernWebReport(value, inputs, snapshot);
  assert.deepEqual(parsed.candidates[0]?.verification?.dropWhen, ["virtualized list"]);
  for (const mutate of [
    (v: ReturnType<typeof payload>) => { v.totalFindings = 0; },
    (v: ReturnType<typeof payload>) => { v.guides[0]!.count = 2; },
    (v: ReturnType<typeof payload>) => { v.guides[0]!.rules[0]!.count = 2; },
    (v: ReturnType<typeof payload>) => { v.guides[0]!.rules[0]!.findings[0]!.file = "../escape.ts"; },
    (v: ReturnType<typeof payload>) => { v.guides[0]!.rules[0]!.findings[0]!.line = 99; },
    (v: ReturnType<typeof payload>) => { v.guides[0]!.rules[0]!.findings[0]!.lineContent = "stale"; },
  ]) {
    const copy = structuredClone(value); mutate(copy);
    assert.throws(() => parseModernWebReport(copy, inputs, snapshot));
  }
  assert.throws(() => parseModernWebReport({ ...value, error: "failure" }, inputs, snapshot));
  assert.throws(() => parseModernWebReport({}, inputs, snapshot));
  assert.equal(parseModernWebReport({ targetDir: snapshot, totalFindings: 0, guides: [] }, inputs, snapshot).candidates.length, 0);
}));

test("candidate identities survive line shifts and preserve duplicates and CSS semantics", () => webFixture(({ config }) => {
  const inputs = discoverWebInputs(config({ modern_web: { enabled: true } })), snapshot = path.resolve("snapshot");
  const candidate = parseModernWebReport(payload(snapshot), inputs, snapshot).candidates[0]!;
  const [original, duplicate] = modernWebFindings([candidate, candidate]);
  assert.notEqual(original?.id, duplicate?.id);
  assert.equal(original?.id, modernWebFindings([{ ...candidate, line: 90, line_content: "  export const value = 1; // moved" }])[0]?.id);
  const css = { ...candidate, file: "style.css", line_content: "a .b {color:red}" };
  assert.notEqual(modernWebFindings([css])[0]?.id, modernWebFindings([{ ...css, line_content: "a.b {color:red}" }])[0]?.id);
  assert.equal(original?.disposition, "review");
  assert.equal(original?.semantic_decision, "unresolved");
}));

test("adapter enforces process limits and reports unavailable or failed execution", () => webFixture(({ write, config }) => {
  const install = (script: string, version = "1.0.0") => {
    write("node_modules/modern-web-guidance/package.json", JSON.stringify({ name: "modern-web-guidance", version,
      bin: { "modern-web-guidance": "cli.cjs" }, engines: { node: ">=22" } }));
    write("node_modules/modern-web-guidance/cli.cjs", script);
  };
  install("throw new Error('must not execute');");
  let c = config();
  assert.equal(runModernWeb(c, discoverWebInputs(c)).status, "disabled");
  c = config({ modern_web: { enabled: true, timeout_ms: 200, max_output_bytes: 1024 } });
  const inputs = discoverWebInputs(c);
  assert.match(modernWebUnavailableReason(resolveModernWebTool(c), "20.19.0") ?? "", /Node/);
  assert.match(modernWebUnavailableReason(null) ?? "", /Install/);
  if (Number(process.versions.node.split(".")[0]) < 22) return;
  install("", "99.0.0");
  assert.equal(runModernWeb(c, inputs).status, "unavailable");
  install("process.stdout.write('not json');");
  assert.equal(runModernWeb(c, inputs).status, "failed");
  install("setInterval(() => {}, 1000);");
  assert.equal(runModernWeb(c, inputs).status, "failed");
  install("process.stdout.write('x'.repeat(10000));");
  assert.equal(runModernWeb(c, inputs).status, "failed");
  install("console.log(JSON.stringify({targetDir:process.argv[3],totalFindings:0,guides:[]}));");
  const result = runModernWeb(c, inputs);
  assert.equal(result.status, "succeeded");
  assert.equal(result.complete, true);
  assert.equal(result.coverage, "unknown");
  assert.ok(result.limitations.some((item) => item.includes("empty results")));
}));

test("pinned scanner executes on the selected HTML/CSS snapshot", { skip: Number(process.versions.node.split(".")[0]) < 22 }, () => webFixture(({ write, config }) => {
  write("index.html", '<img src="hero.jpg" importance="high" loading="auto">\n');
  write("style.css", ".accordion { max-height: 0; transition: max-height 0.3s; }\n.accordion.open { max-height: 9999px; }\n");
  const c = config({ modern_web: { enabled: true } });
  const result = runModernWeb(c, discoverWebInputs(c));
  assert.equal(result.status, "succeeded", result.reason ?? "");
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every((item) => ["index.html", "style.css", "src/index.ts", "package.json"].includes(item.file)));
  assert.equal(result.coverage, "unknown");
}));
