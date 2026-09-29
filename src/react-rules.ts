import type { FindingDisposition } from "./types.js";

export type ReactFindingCategory = "correctness" | "optimization" | "configuration" | "unknown" | "tool-failure";

export function reactRulePolicy(ruleId: string): { category: ReactFindingCategory; disposition: FindingDisposition } {
  const rule = ruleId.replace(/^react-hooks\//, "");
  if (ruleId === "eslint/parser") return { category: "tool-failure", disposition: "info" };
  if (["rules-of-hooks", "set-state-in-render"].includes(rule)) return { category: "correctness", disposition: "block" };
  if (["exhaustive-deps", "immutability", "globals", "refs", "purity", "static-components", "error-boundaries", "component-hook-factories"].includes(rule)) {
    return { category: "correctness", disposition: "warn" };
  }
  if (["unsupported-syntax", "incompatible-library", "preserve-manual-memoization", "use-memo", "void-use-memo", "set-state-in-effect"].includes(rule)) {
    return { category: "optimization", disposition: "info" };
  }
  if (["config", "gating"].includes(rule)) return { category: "configuration", disposition: "review" };
  return { category: "unknown", disposition: "review" };
}
