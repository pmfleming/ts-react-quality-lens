import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { webFixture } from "./modern-web-helpers.js";

test("modernization is opt-in with explicit, bounded configuration", () => webFixture(({ root, config }) => {
  const defaults = config().modernWeb;
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.roots, [root]);
  assert.equal(defaults.browsers.targets, null);
  assert.equal(defaults.browsers.environment, "production");
  const selected = config({ modern_web: { enabled: true, roots: ["src", "public"], exclude: ["vendor"],
    timeout_ms: 5000, browsers: { targets: ["chrome 120"], environment: "development" } } }).modernWeb;
  assert.deepEqual(selected.roots, [path.join(root, "src"), path.join(root, "public")]);
  assert.deepEqual(selected.browsers, { targets: ["chrome 120"], environment: "development" });
  assert.equal(selected.timeoutMs, 5000);
}));

test("modernization rejects invalid and misspelled config instead of silently ignoring it", () => webFixture(({ root, write }) => {
  for (const modern_web of [{ enabled: "true" }, { roots: [] }, { timeout_ms: 0 }, { max_output_bytes: -1 },
    { browsers: { targets: [] } }, { browsers: { environment: "" } }, { browser: {} }, { required: true }]) {
    write("lens.json", JSON.stringify({ modern_web }));
    assert.throws(() => loadConfig(path.join(root, "lens.json")), /Invalid config/);
  }
}));
