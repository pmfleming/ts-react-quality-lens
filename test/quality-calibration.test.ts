import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { loadConfig } from "../src/config.js";
import { evaluateLabels, type LabeledObservation } from "../src/labeled-evaluation.js";
import { runMeasure } from "../src/measure-runner.js";
import { escapeRecords } from "../src/scoring.js";

test("labeled evaluation includes abstention and keeps holdout results separate", () => {
  const fixture: { observations: LabeledObservation[]; expected: unknown } = JSON.parse(fs.readFileSync("contracts/calibration-cases.json", "utf8"));
  assert.deepEqual(evaluateLabels(fixture.observations), [fixture.expected]);
  assert.throws(() => evaluateLabels([...fixture.observations, ...fixture.observations]), /Duplicate/);
});

test("quality corpus preserves positive and negative verdicts after renaming and movement", (t) => {
  const cases: Array<Omit<LabeledObservation, "observed"> & { source: string }> = JSON.parse(fs.readFileSync("test/rule-corpus/quality.json", "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ts-quality-corpus-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"corpus"}');
    fs.writeFileSync(path.join(root, "ts-react-quality-lens.config.json"), JSON.stringify({ source_roots: ["src"], cache: { enabled: false } }));
    const config = loadConfig(path.join(root, "ts-react-quality-lens.config.json"));
    const observations: LabeledObservation[] = [];
    for (const item of cases) {
      for (const mutation of [false, true]) {
        fs.writeFileSync(path.join(root, "src/case.ts"), mutation ? `// moved\n${item.source.replaceAll("value", "renamed")}` : item.source);
        const findings = createAnalysisContext(config).project().modules.flatMap(escapeRecords);
        const observed = findings.some((finding) => finding.kind === item.rule);
        assert.equal(observed, item.expected, item.id);
        observations.push({ ...item, id: `${item.id}:${mutation}`, observed });
      }
    }
    t.diagnostic(JSON.stringify(evaluateLabels(observations)));
    fs.writeFileSync(path.join(root, "src/case.ts"), "export const value = 1;\n");
    const first = runMeasure(config, "quality.locality_leverage", "test")[0]?.records?.[0];
    fs.appendFileSync(path.join(root, "src/case.ts"), "export const unused = 2;\n");
    const second = runMeasure(config, "quality.locality_leverage", "test")[0]?.records?.[0];
    assert.equal(first?.leverage_score, 0);
    assert.equal(second?.leverage_score, first?.leverage_score, "unused public surface must not improve reuse");
    assert.ok(Number(second?.public_surface) > Number(first?.public_surface));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
