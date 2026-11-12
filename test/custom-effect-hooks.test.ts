import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConfig } from "../src/config.js";
import { analysisIdentity } from "../src/provenance.js";
import { measureReactHealth } from "../src/measures/react-health.js";
import { readArtifact } from "../src/writer.js";
import { reactFixture } from "./react-improvement-helpers.js";

test("custom Effect settings drive managed lint, inventory and freshness in both profiles", () => reactFixture((root, config) => {
  const code = `import { useRemoteEffect } from './hooks';
export function App({value}) { useRemoteEffect(() => { console.log(value); }, []); return <div />; }
`;
  fs.writeFileSync(path.join(root, "src/main.tsx"), code);
  const before = analysisIdentity(config).id;
  assert.equal(config.react.additionalEffectHooks, null);
  assert.ok(!measureReactHealth(config, "before").records.some((record) => record.rule_id === "react-hooks/exhaustive-deps"));
  config.react.additionalEffectHooks = "^(useRemoteEffect|useSubscriptionEffect)$";
  assert.notEqual(analysisIdentity(config).id, before);
  for (const profile of ["classic-v1", "recommended-v2"] as const) {
    config.react.ruleset = profile;
    const artifact = measureReactHealth(config, "configured");
    assert.ok(artifact.records.some((record) => record.rule_id === "react-hooks/exhaustive-deps" && record.message?.includes("value")));
    assert.equal(artifact.custom_effect_hooks.status, "evaluated");
    assert.deepEqual(artifact.custom_effect_hooks.calls, [{ name: "useRemoteEffect", file: "src/main.tsx", line: 2 }]);
    assert.ok(readArtifact(config, "react_health.json"));
    const validate = new Ajv2020({ strict: false }).compile(JSON.parse(fs.readFileSync("ts-react-quality-lens.schema.json", "utf8")));
    assert.ok(validate(artifact), JSON.stringify(validate.errors));
  }
  fs.writeFileSync(path.join(root, "src/main.tsx"), code.replace("}, []);", "}, [value]);"));
  assert.ok(!measureReactHealth(config, "fixed").records.some((record) => record.rule_id === "react-hooks/exhaustive-deps"));
}));

test("custom Effect expression configuration rejects malformed and empty patterns", () => reactFixture((root, config) => {
  for (const pattern of ["[", "", "x".repeat(257)]) {
    fs.writeFileSync(config.configPath, JSON.stringify({ react: { additional_effect_hooks: pattern } }));
    assert.throws(() => loadConfig(config.configPath));
  }
  fs.writeFileSync(config.configPath, JSON.stringify({ react: { additional_effect_hooks: "^useRemoteEffect$" } }));
  assert.equal(loadConfig(path.join(root, "lens.json")).react.additionalEffectHooks, "^useRemoteEffect$");
}));
