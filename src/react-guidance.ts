import { createRequire } from "node:module";
import { isRecord } from "./collections.js";
import { reactRulePolicy } from "./react-rules.js";
import type { EslintReactHooksResult, ReactRuleset } from "./types.js";

export const REACT_GUIDANCE_VERSION = "react-guidance-v1";
export const OFFICIAL_REACT_RULES = ["exhaustive-deps", "rules-of-hooks", "component-hook-factories", "config", "error-boundaries", "gating",
  "globals", "immutability", "incompatible-library", "preserve-manual-memoization", "purity", "refs", "set-state-in-effect",
  "set-state-in-render", "static-components", "unsupported-syntax", "use-memo"];
const classicRules = { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" };

export function reactRuleDocumentation(ruleId: string): string | null {
  if (!ruleId.startsWith("react-hooks/")) return null;
  const rule = ruleId.slice("react-hooks/".length);
  return OFFICIAL_REACT_RULES.includes(rule) ? `https://react.dev/reference/eslint-plugin-react-hooks/lints/${rule}`
    : "https://react.dev/reference/eslint-plugin-react-hooks";
}

/** The inventory and generated ESLint config share the same managed rule selection. */
export function selectReactRules(ruleset: ReactRuleset) {
  if (ruleset === "classic-v1") return { preset: "classic-v1", rules: classicRules };
  try {
    const plugin = createRequire(import.meta.url)("eslint-plugin-react-hooks");
    for (const [preset, config] of [
      ["flat/recommended-latest", plugin.configs?.flat?.["recommended-latest"]],
      ["recommended-latest", plugin.configs?.["recommended-latest"]],
      ["flat/recommended", plugin.configs?.flat?.recommended],
      ["recommended", plugin.configs?.recommended],
    ] as const) if (isRecord(config) && isRecord(config.rules)) return { preset, rules: config.rules };
  } catch { /* Tool execution reports unavailable packages separately. */ }
  return { preset: "classic-fallback", rules: classicRules };
}

export function enabledReactRules(rules: Record<string, unknown>): string[] {
  return Object.entries(rules).filter(([, value]) => {
    const severity = Array.isArray(value) ? value[0] : value;
    return severity === "warn" || severity === "error" || severity === 1 || severity === 2;
  }).map(([id]) => id).sort();
}

export function reactRuleCoverage(result: EslintReactHooksResult) {
  const enabled = new Set(result.enabled_rules ?? []);
  const ids = [...new Set([...OFFICIAL_REACT_RULES.map((rule) => `react-hooks/${rule}`), ...enabled])].sort();
  return ids.map((rule_id) => ({ rule_id, ...reactRulePolicy(rule_id),
    status: !result.enabled_rules ? "unknown" : !enabled.has(rule_id) ? "disabled" : result.complete ? result.evaluated_files?.length === 0 ? "not_applicable" : "evaluated" : "incomplete",
    source: OFFICIAL_REACT_RULES.includes(rule_id.replace(/^react-hooks\//, ""))
      ? `https://react.dev/reference/eslint-plugin-react-hooks/lints/${rule_id.replace(/^react-hooks\//, "")}` : null,
  }));
}
