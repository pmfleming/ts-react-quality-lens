import { arrayOf, count, oneOf, shape, string } from "./validation.js";
import { BLOCKING_REACT_RULES, BLOCKING_TYPED_RULES } from "./rule-policy.js";
import type { Artifact, Config } from "./types.js";

export type RuleApplicability = {
  contract_id: string;
  unit: "file" | "producer-invocation";
  evaluated: number;
  skipped: number;
  abstained: number;
  status: "evaluated" | "partial" | "unavailable" | "not_applicable";
  reasons: string[];
  limitations: string[];
};

/** These counts describe rule dispatch/producer execution, never semantic proof or accuracy. */
export function fileRuleApplicability(ids: readonly string[], selected: string[], evaluated: string[], applicable: (file: string) => boolean): RuleApplicability[] {
  const eligible = selected.filter(applicable);
  const seen = new Set(evaluated);
  const completed = eligible.filter((file) => seen.has(file)).length;
  return ids.map((contract_id) => ({ contract_id, unit: "file", evaluated: completed,
    skipped: selected.length - eligible.length, abstained: eligible.length - completed,
    status: eligible.length === 0 ? "not_applicable" : completed === eligible.length ? "evaluated" : completed ? "partial" : "unavailable",
    reasons: [...(eligible.length === 0 ? ["No selected files in this rule's language scope."] : []),
      ...(selected.length > eligible.length ? ["Files outside the declared language scope are not evaluated negatives."] : []),
      ...(completed < eligible.length ? ["Selected files lack successful parser/rule execution evidence."] : [])],
    limitations: ["File-level rule dispatch only; upstream rules may abstain at individual expressions. Not a count of semantically resolved expressions."],
  }));
}

export function familyApplicability(config: Config, artifact: Artifact): RuleApplicability[] {
  const tool = (name: string) => artifact.tool_status?.[name]?.complete === true;
  const entry = (contract_id: string, selected: boolean, complete: boolean): RuleApplicability => ({
    contract_id, unit: "producer-invocation", evaluated: selected && complete ? 1 : 0,
    skipped: selected ? 0 : 1, abstained: selected && !complete ? 1 : 0,
    status: !selected ? "not_applicable" : complete ? "evaluated" : "unavailable",
    reasons: !selected ? ["Producer is not selected/configured in this profile."] : complete ? [] : ["Producer prerequisites or validated completion evidence are missing."],
    limitations: ["Bounded adapter-family execution only; no claim that every upstream diagnostic or runtime scenario was applicable or evaluated."],
  });
  switch (artifact.task_id) {
    case "quality.type_health": return [entry("compiler", true, artifact.confidence.typescript_program_loaded === true)];
    case "correctness.all": return [entry("test-execution", !!config.testCommand, ["passed", "failed"].includes(artifact.execution?.status ?? ""))];
    case "quality.package_health": return [entry("package-execution", config.packageHealth.enabled, artifact.summary.complete === true),
      entry("publint", config.packageHealth.enabled, tool("publint")), entry("attw", config.packageHealth.enabled, tool("are_the_types_wrong"))];
    case "quality.sarif": return [entry("sarif-execution", config.sarifInputs.some((input) => input.required),
      Object.values(artifact.tool_status ?? {}).filter((status) => status.required === true).every((status) => status.complete === true)),
      entry("sarif-result", config.sarifInputs.length > 0, artifact.summary.status === "complete")];
    case "quality.runtime": return [entry("axe", config.runtimeInputs.axe !== null, tool("axe"))];
    default: return [];
  }
}

const reasons = arrayOf((value: unknown): value is string => string(value) && value.length > 0);
const applicability = arrayOf(shape({ contract_id: string, unit: oneOf("file", "producer-invocation"), evaluated: count, skipped: count,
  abstained: count, reasons, limitations: reasons, status: oneOf("partial", "unavailable", "evaluated", "not_applicable") }));
export function validRuleApplicability(value: unknown, task: string): boolean {
  if (!applicability(value)) return false;
  const ids = new Set(value.map((item) => item.contract_id));
  const required = task === "quality.lint" ? BLOCKING_TYPED_RULES : task === "quality.react_health" ? BLOCKING_REACT_RULES : [];
  return ids.size === value.length && required.every((id) => ids.has(id)) && value.every((item) => {
    const expected = item.abstained > 0 ? item.evaluated > 0 ? "partial" : "unavailable" : item.evaluated > 0 ? "evaluated" : "not_applicable";
    return item.limitations.length > 0 && item.status === expected && (expected === "evaluated" || item.reasons.length > 0);
  });
}
