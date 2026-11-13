import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { typescriptFixture } from "./project-fixture.js";

test("syntax lint shares one invocation while preserving family findings, disabled status, and isolated failures", (t) => typescriptFixture((root, config) => {
  fs.writeFileSync(path.join(root, "src/Panel.tsx"), 'import { useEffect } from "react"; export function Panel({ ready }: { ready: boolean }) { if (ready) useEffect(() => {}, []); return <img src="x" />; }');
  config.accessibility.enabled = true;
  const execute = t.mock.method(childProcess, "execFileSync");
  const context = createAnalysisContext(config);
  const hooks = context.reactHooksLint(), accessibility = context.jsxA11yLint();
  // Windows launches the managed eslint.cmd through cmd.exe, so inspect the whole command line.
  const eslintCalls = () => execute.mock.calls.filter((call) => [call.arguments[0], ...(Array.isArray(call.arguments[1]) ? call.arguments[1] : [])]
    .some((part) => String(part).includes("eslint"))).length;
  assert.equal(eslintCalls(), 1);
  assert.equal(hooks.complete, true);
  assert.equal(accessibility.complete, true);
  assert.ok(hooks.messages.some((item) => item.rule_id === "react-hooks/rules-of-hooks"));
  assert.ok(accessibility.messages.some((item) => item.rule_id === "jsx-a11y/alt-text"));
  assert.ok(hooks.messages.every((item) => item.rule_id.startsWith("react-hooks/")));
  assert.ok(accessibility.messages.every((item) => item.rule_id.startsWith("jsx-a11y/")));
  config.react.additionalEffectHooks = "[";
  context.refresh();
  assert.equal(context.reactHooksLint().ran, false, "invalid hook configuration is reported");
  assert.equal(context.jsxA11yLint().complete, true, "accessibility survives a hook plugin failure");
  config.react.additionalEffectHooks = null;
  config.accessibility.enabled = false;
  context.refresh();
  const beforeDisabled = execute.mock.calls.length;
  assert.equal(context.jsxA11yLint().ran, false);
  assert.equal(execute.mock.calls.length, beforeDisabled, "disabled accessibility starts no tools");
  assert.equal(context.jsxA11yLint().complete, false);
  assert.equal(context.reactHooksLint().complete, true);
  config.accessibility.enabled = true;
  fs.writeFileSync(path.join(root, "src/Panel.tsx"), "export const broken = <;");
  context.refresh();
  for (const result of [context.reactHooksLint(), context.jsxA11yLint()]) {
    assert.equal(result.complete, false);
    assert.ok(result.messages.some((item) => item.rule_id === "eslint/parser"));
  }
}));
