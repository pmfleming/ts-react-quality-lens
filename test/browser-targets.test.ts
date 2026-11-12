import assert from "node:assert/strict";
import test from "node:test";
import { browserDataVersions, browserTargetsFingerprint, resolveWebBrowserTargets } from "../src/browser-targets.js";
import { featureSupport, qualifyModernWeb, supportStatement } from "../src/modern-web-compatibility.js";
import { discoverWebInputs, type WebInput } from "../src/web-inputs.js";
import type { BrowserTargets, ModernWebCandidate } from "../src/modern-web-types.js";
import { webFixture } from "./modern-web-helpers.js";

test("browser targets use explicit configuration, nearest workspace config and named environments", () => webFixture(({ config, write }) => {
  write(".browserslistrc", "[production]\nchrome 120\n[development]\nfirefox 120\n");
  write("packages/app/package.json", JSON.stringify({ name: "app", browserslist: ["safari 17"] }));
  write("packages/app/view.css", "a {}\n");
  let c = config({ modern_web: { enabled: true } });
  let targets = resolveWebBrowserTargets(c, discoverWebInputs(c));
  assert.deepEqual(targets["src/index.ts"]?.resolved, ["chrome 120"]);
  assert.deepEqual(targets["packages/app/view.css"]?.resolved, ["safari 17.0"]);
  assert.equal(targets["packages/app/view.css"]?.workspace, "packages/app");
  assert.equal(targets["packages/app/view.css"]?.source, "packages/app/package.json");
  c = config({ modern_web: { enabled: true, browsers: { environment: "development" } } });
  targets = resolveWebBrowserTargets(c, discoverWebInputs(c));
  assert.deepEqual(targets["src/index.ts"]?.resolved, ["firefox 120"]);
  c = config({ modern_web: { enabled: true, browsers: { targets: ["chrome 130"] } } });
  assert.ok(Object.values(resolveWebBrowserTargets(c, discoverWebInputs(c))).every((target) => target.resolved[0] === "chrome 130"));
}));

test("missing, invalid, conflicting and external target configurations stay unknown", () => webFixture(({ config, write }) => {
  const c = config({ modern_web: { enabled: true } });
  const target = () => resolveWebBrowserTargets(c, discoverWebInputs(c))["src/index.ts"]!;
  assert.equal(target().status, "unknown");
  write(".browserslistrc", "extends browserslist-config-private\n");
  assert.match(target().reason ?? "", /outside/);
  write(".browserslistrc", "not-a-browser\n");
  assert.equal(target().status, "unknown");
  write(".browserslistrc", "chrome 120\n");
  write("package.json", JSON.stringify({ browserslist: ["firefox 120"] }));
  assert.match(target().reason ?? "", /Conflicting/);
}));

test("target resolution ignores ambient browser configuration and fingerprints resolved targets", () => webFixture(({ config, write }) => {
  const prior = process.env.BROWSERSLIST;
  process.env.BROWSERSLIST = "safari 15";
  try {
    const c = config({ modern_web: { enabled: true } });
    assert.equal(resolveWebBrowserTargets(c, discoverWebInputs(c))["src/index.ts"]?.status, "unknown");
    write(".browserslistrc", "chrome 120\n");
    const before = browserTargetsFingerprint(c, discoverWebInputs(c));
    assert.deepEqual(resolveWebBrowserTargets(c, discoverWebInputs(c))["src/index.ts"]?.resolved, ["chrome 120"]);
    write(".browserslistrc", "chrome 130\n");
    assert.notEqual(browserTargetsFingerprint(c, discoverWebInputs(c)), before);
    assert.equal(browserDataVersions()["@mdn/browser-compat-data"], "8.1.8");
    assert.equal(browserDataVersions().browserslist, "4.29.5");
  } finally {
    if (prior === undefined) delete process.env.BROWSERSLIST; else process.env.BROWSERSLIST = prior;
  }
}));

function target(resolved: string[]): BrowserTargets {
  return { status: "resolved", workspace: ".", source: "explicit", environment: "production", queries: resolved,
    resolved, reason: null, config_files: [] };
}
function candidate(rule = "form-fields-automatically-fit-contents", line = 1): ModernWebCandidate {
  return { rule_id: rule, guide_id: rule.split("/")[0]!, summary: "candidate", message: "candidate", file: "src/view.ts", line,
    line_content: "resize();", verification: null };
}

test("compatibility separates supported, mixed, incompatible and unassessed replacements", () => {
  const item = candidate();
  assert.equal(qualifyModernWeb(item, undefined, target(["chrome 130"])).status, "supported");
  assert.equal(qualifyModernWeb(item, undefined, target(["chrome 130", "firefox 120"])).status, "fallback_required");
  assert.equal(qualifyModernWeb(item, undefined, target(["firefox 120"])).status, "incompatible");
  assert.equal(qualifyModernWeb(item, undefined, undefined).remediation, "withheld");
  assert.equal(qualifyModernWeb(candidate("future-rule"), undefined, target(["chrome 130"])).status, "unknown");
  assert.equal(featureSupport("css.properties.field-sizing.content", "unknown 120"), "unknown");
  assert.equal(featureSupport("nonexistent.feature", "chrome 130"), "unknown");
  assert.equal(supportStatement({ version_added: "120", partial_implementation: true }, "130"), "unknown");
  assert.equal(supportStatement({ version_added: "120", flags: [{ type: "preference", name: "experimental" }] }, "130"), "unknown");
  assert.equal(supportStatement({ version_added: "120", version_removed: "130" }, "129-130"), "unsupported");
  assert.equal(supportStatement({ version_added: "≤120" }, "119"), "unknown");
  assert.equal(supportStatement({ version_added: "≤120" }, "121"), "supported");
  assert.equal(supportStatement({ version_added: "preview" }, "26"), "unknown");
});

test("guard evidence is limited to enclosing literal checks and does not prove contextual validity", () => {
  const input: WebInput = { path: "src/view.ts", relativePath: "src/view.ts", kind: "script",
    text: 'if (!CSS.supports("field-sizing", "content")) {\n  resize();\n}\nresize();\n' };
  assert.equal(qualifyModernWeb(candidate(undefined, 2), input, target(["chrome 130"])).guard, "observed");
  assert.equal(qualifyModernWeb(candidate(undefined, 4), input, target(["chrome 130"])).guard, "not_observed");
  assert.equal(qualifyModernWeb(candidate(undefined, 2), input, undefined).remediation, "withheld");
});

test("declarative controls distinguish popover targeting from dialog invoker commands", () => {
  const item = candidate("declarative-dialog-popover-control/click-listener");
  const input: WebInput = { path: item.file, relativePath: item.file, kind: "script",
    text: 'button.addEventListener("click", () => popup.showPopover());\n' };
  item.line_content = input.text.trim();
  assert.equal(qualifyModernWeb(item, input, target(["chrome 120"])).status, "supported");
  input.text = 'button.addEventListener("click", () => modal.showModal());\n';
  item.line_content = input.text.trim();
  assert.equal(qualifyModernWeb(item, input, target(["chrome 120"])).status, "incompatible");
});
