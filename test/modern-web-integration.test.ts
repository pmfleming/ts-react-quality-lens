import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runMeasure } from "../src/measure-runner.js";
import { runAudit } from "../src/audit.js";
import { auditVerdict, collectFindings, requiredEvidenceReasons, staleSuppressionFindings } from "../src/audit/findings.js";
import { savedModernWebFindings } from "../src/measures/modern-web.js";
import { validNativeEvidence } from "../src/artifact-evidence.js";
import { deterministicEvidence } from "../src/deterministic-evidence.js";
import { dispatchMcp } from "../src/mcp.js";
import { readArtifact } from "../src/writer.js";
import { webFixture } from "./modern-web-helpers.js";

const scannerRuntime = Number(process.versions.node.split(".")[0]) >= 22;
const schema = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8")));

test("disabled modernization exposes its state without required evidence or editor work", () => webFixture(({ config }) => {
  const c = config({ policy: { required_checks: [] } });
  const artifact = runMeasure(c, "quality.modern_web", "disabled-test")[0]!;
  assert.equal(artifact.summary.status, "disabled");
  assert.ok(validNativeEvidence(artifact, c));
  assert.ok(schema(artifact), JSON.stringify(schema.errors));
  assert.deepEqual(savedModernWebFindings(c), []);
  assert.deepEqual(requiredEvidenceReasons(c), []);
  c.suppressions = [{ id: "modern-web:accepted-candidate", reason: "previous review" }];
  assert.deepEqual(staleSuppressionFindings(c, []), []);
}));

test("web measurement preserves qualified advice through artifacts, MCP, audit selection and saved editor evidence", { skip: !scannerRuntime }, () => webFixture(({ write, config }) => {
  const css = ".accordion { max-height: 0; transition: max-height 0.3s; }\n.accordion.open { max-height: 9999px; }\n";
  write("style.css", css);
  write("index.html", '<main><input type="email"></main>\n');
  write(".browserslistrc", "chrome 130\nfirefox 120\n");
  const c = config({ modern_web: { enabled: true }, policy: { required_checks: [] } });
  const measure = () => runMeasure(c, "quality.modern_web", "integration-test")[0]!;
  const first = measure();
  assert.equal(first.summary.status, "succeeded");
  assert.equal(first.confidence.complete, false);
  assert.ok(Array.isArray(first.capabilities));
  assert.equal(first.capabilities[0]?.status, "partial");
  assert.ok(schema(first), JSON.stringify(schema.errors));
  assert.ok(validNativeEvidence(first, c));
  const cssRecord = first.records?.find((record) => record.file === "style.css");
  assert.ok(cssRecord);
  assert.equal(cssRecord.disposition, "review");
  assert.equal((cssRecord.compatibility as { status: string }).status, "fallback_required");
  assert.match(cssRecord.message ?? "", /fallback/);
  assert.ok(cssRecord.verification);
  assert.ok(cssRecord.upstream_message);
  assert.deepEqual(deterministicEvidence(first), deterministicEvidence(measure()));
  assert.equal(savedModernWebFindings(c).length, first.records?.length);
  const response = dispatchMcp(c, { method: "resources/read", params: { uri: "tsrqlens://artifact/modern_web.json" } }) as { contents: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(response.contents[0]!.text).records, first.records);
  const findings = collectFindings(c, { changedFiles: ["style.css"], changedLines: new Map([["style.css", [{ start: 1, end: 2 }]]]), baselineIds: new Set() });
  assert.ok(findings.some((record) => record.id === cssRecord.id && record.introduced));
  assert.equal(auditVerdict(findings, requiredEvidenceReasons(c)), "pass");
  const suppressed = collectFindings(c, { changedFiles: [], changedLines: new Map(), includeAll: true, baselineIds: new Set([cssRecord.id]) });
  assert.ok(suppressed.find((record) => record.id === cssRecord.id)?.suppressed);
  const corrupted = structuredClone(first);
  corrupted.records![0]!.compatibility = { status: "supported" };
  assert.equal(validNativeEvidence(corrupted, c), false);
  assert.equal(schema(corrupted), false);
  write("style.css", `\n${css}`);
  assert.deepEqual(savedModernWebFindings(c), []);
  const shifted = measure().records?.find((record) => record.file === "style.css");
  assert.equal(shifted?.id, cssRecord.id);
  c.suppressions = [{ id: cssRecord.id, reason: "accepted modernization debt" }];
  assert.ok(measure().records?.find((record) => record.id === cssRecord.id)?.suppressed);
  const audit = runAudit(c, "enabled-audit", { compareBase: false, runTests: false });
  assert.equal(audit.summary.verdict, "pass");
  assert.ok(audit.findings.some((finding) => finding.source === "modern-web-guidance" && finding.suppressed));
}));

test("inputs changed by a scanner invalidate standalone observations", { skip: !scannerRuntime }, () => webFixture(({ root, write, config }) => {
  write("node_modules/modern-web-guidance/package.json", JSON.stringify({ name: "modern-web-guidance", version: "1.0.0",
    bin: { "modern-web-guidance": "cli.cjs" }, engines: { node: ">=22" } }));
  write("node_modules/modern-web-guidance/cli.cjs", `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "src/index.ts"))}, 'export const changed = true;');\nconsole.log(JSON.stringify({targetDir:process.argv[3],totalFindings:0,guides:[]}));\n`);
  const c = config({ modern_web: { enabled: true } });
  const artifact = runMeasure(c, "quality.modern_web", "mutation-test")[0]!;
  assert.equal(artifact.summary.status, "failed");
  assert.equal(artifact.confidence.inputs_unchanged, false);
  assert.deepEqual(artifact.records, []);
  assert.deepEqual(savedModernWebFindings(c), []);
}));

test("optional scanner unavailability leaves audit verdict unchanged and is retained in the published artifact", () => webFixture(({ write, config }) => {
  write("node_modules/modern-web-guidance/package.json", JSON.stringify({ name: "modern-web-guidance", version: "99.0.0",
    bin: { "modern-web-guidance": "cli.cjs" }, engines: { node: ">=22" } }));
  write("node_modules/modern-web-guidance/cli.cjs", "throw new Error('must not execute');\n");
  const c = config({ modern_web: { enabled: true }, policy: { required_checks: [] }, cleanup: { knip: false } });
  const audit = runAudit(c, "optional-audit", { compareBase: false, runTests: false });
  const modern = readArtifact(c, "modern_web.json");
  assert.equal(modern?.summary.status, "unavailable");
  assert.ok(!audit.summary.incomplete_reasons.some((reason) => /modern/i.test(reason)));
  assert.equal(audit.summary.verdict, "pass");
  assert.ok(Array.isArray(audit.artifact_inputs));
  assert.ok(audit.artifact_inputs.some((entry) => entry.file === "modern_web.json"));
}));

test("CLI measurement supports HTML-only projects and retains unknown-target candidates", { skip: !scannerRuntime }, () => webFixture(({ root, write, config }) => {
  fs.rmSync(path.join(root, "src"), { recursive: true });
  write("style.css", ".panel { max-height: 0; transition: max-height 1s; }\n.panel.open { max-height: 9999px; }\n");
  const c = config({ modern_web: { enabled: true } });
  const run = childProcess.spawnSync(process.execPath, [path.resolve("dist/bin/ts-react-quality-lens.js"), "measure", "quality.modern_web", "--config", c.configPath],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const artifact = readArtifact(c, "modern_web.json");
  assert.equal(artifact?.summary.status, "succeeded");
  assert.ok(artifact?.records?.length);
  assert.ok(artifact.records.every((record) => (record.compatibility as { remediation: string }).remediation === "withheld"));
}));
