import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { attachArtifactEvidence } from "../src/artifact-evidence.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { artifactFindings } from "../src/findings.js";
import { runTypedLint } from "../src/integrations/eslint-adapter.js";
import { measureHotspots } from "../src/measures/hotspots.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { readArtifact } from "../src/writer.js";
import { reactFixture } from "./react-improvement-helpers.js";
import { typescriptFixture } from "./project-fixture.js";

function assertUniqueIds(ids: string[]): void {
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "finding IDs must be unique");
}

test("same-named components, same-line fallback a11y hits and multi-convention routes get distinct IDs", () => reactFixture((root) => {
  fs.writeFileSync(path.join(root, "src/columns.tsx"), [
    "export const columns = [",
    '  { Header: "Name", Cell: ({ value }: { value: string }) => <b>{value}</b> },',
    '  { Header: "Age", Cell: ({ value }: { value: string }) => <i>{value}</i> },',
    "];",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src/Gallery.tsx"), 'export const Gallery = () => <div><img src="a.png" /><img src="b.png" /></div>;\n');
  fs.mkdirSync(path.join(root, "app/routes/dashboard"), { recursive: true });
  fs.writeFileSync(path.join(root, "app/routes/dashboard/route.tsx"),
    'export async function loader() { return fetch("/api"); }\nexport default function Dashboard() { return <main />; }\n');
  // Fallback a11y heuristics only run when managed accessibility lint is disabled. The route matches the Next and
  // Remix conventions at once; an empty suppression reason must not invalidate the evidence either.
  fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src", "app"], framework: "remix", cache: { enabled: false },
    accessibility: { enabled: false }, policy: { required_checks: [] }, suppressions: [{ id: "component:src/main:App", reason: "" }] }));
  const config = loadConfig(path.join(root, "lens.json"));

  const artifact = measureReactHealth(config, "test unique ids", createAnalysisContext(config));
  const ids = artifactFindings(artifact).map((finding) => finding.id);
  assertUniqueIds(ids);
  assert.deepEqual(ids.filter((id) => id.startsWith("component:src/columns:Cell")).sort(), ["component:src/columns:Cell@2:27", "component:src/columns:Cell@3:26"]);
  assert.ok(ids.includes("component:src/main:App"), "a unique component name keeps its position-free ID");
  assert.deepEqual(ids.filter((id) => id.startsWith("a11y:src/Gallery:img_missing_alt")).sort(),
    ["a11y:src/Gallery:img_missing_alt:1:35", "a11y:src/Gallery:img_missing_alt:1:54"]);
  assert.equal(ids.filter((id) => id === "framework:route-responsibility:app/routes/dashboard/route.tsx").length, 1);
  const app = artifactFindings(artifact).find((finding) => finding.id === "component:src/main:App");
  assert.equal(app?.suppressed, true);
  assert.equal(app?.suppression_reason, "Configured suppression.");
  assert.ok(readArtifact(config, "react_health.json"), "the published artifact is readable");
}));

test("invalid native evidence names the duplicated identity or the offending wire entry", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/a.ts"), "export function a(value: number): number { return value > 0 ? value : -value; }\n");
  const artifact = measureHotspots(config, "test evidence problems", createAnalysisContext(config));
  const record = artifact.records?.[0];
  assert.ok(record);
  assert.throws(() => attachArtifactEvidence(config, { ...artifact, records: [record, { ...record }] }),
    (error: Error) => error.message.includes("Invalid native evidence projection for quality.hotspots: duplicate evidence identities") &&
      error.message.includes(`finding:${record.id}`));
  assert.throws(() => attachArtifactEvidence(config, { ...artifact, records: [{ ...record, rule_id: "no-console" }] }),
    /quality\.hotspots: invalid wire evidence \{.*"rule_id":"no-console"/);
}));

test("typed lint reports only the managed ruleset, not rules enabled by project inline config", () => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/say.ts"), '/* eslint no-console: "error" */\nexport function say(): void { console.log("x"); }\n');
  const lint = runTypedLint(config);
  assert.equal(lint.complete, true, lint.reason ?? "");
  assert.deepEqual(lint.messages, []);
}));
