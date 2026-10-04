import type { ScoredRecord } from "./types.js";

/** One authority for enabled managed TS rules and their blocking inventory. */
export const TYPED_RULES = {
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "warn",
  "@typescript-eslint/no-unsafe-type-assertion": "warn",
  "@typescript-eslint/ban-ts-comment": ["error", {
    "ts-check": false, "ts-expect-error": "allow-with-description", "ts-ignore": true,
    "ts-nocheck": true, minimumDescriptionLength: 3,
  }],
} as const;

export const BLOCKING_TYPED_RULES = Object.entries(TYPED_RULES)
  .filter(([, setting]) => (Array.isArray(setting) ? setting[0] : setting) === "error")
  .map(([id]) => id);
export const BLOCKING_REACT_RULES = ["react-hooks/rules-of-hooks", "react-hooks/set-state-in-render"];
export const BLOCKING_FAMILIES = ["compiler", "test-execution", "package-execution", "publint", "attw", "sarif-execution", "sarif-result", "axe"];

/** Dynamic upstream IDs remain exact on findings; family contracts bound their interpretation. */
export function blockingContract(record: ScoredRecord): string | null {
  const id = record.rule_id ?? "";
  if ([...BLOCKING_TYPED_RULES, ...BLOCKING_REACT_RULES].includes(id)) return id;
  if (record.kind === "compiler_diagnostic") return "compiler";
  if (id === "test-runner/execution") return "test-execution";
  if (record.kind === "package_tool_incomplete") return "package-execution";
  if (record.source === "publint" && id.startsWith("publint/")) return "publint";
  if (record.source === "are-the-types-wrong" && id.startsWith("are-the-types-wrong/")) return "attw";
  if (record.kind === "sarif_invocation_incomplete") return "sarif-execution";
  if (record.kind === "sarif_finding") return "sarif-result";
  if (record.source === "axe" && id.startsWith("axe/")) return "axe";
  return null;
}
