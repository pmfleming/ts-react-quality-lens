import { customEffectHookCalls } from "../custom-effect-hooks.js";
import { fileRuleApplicability } from "../rule-applicability.js";
import { BLOCKING_REACT_RULES } from "../rule-policy.js";
import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { eslintFindingRecord } from "../integrations/eslint-findings.js";
import { artifactBase } from "../provenance.js";
import { riskForScore } from "../risk-model.js";
import { reactSupport } from "../react-support.js";
import { reactRuleCoverage, reactRuleDocumentation, REACT_GUIDANCE_VERSION } from "../react-guidance.js";
import { reactReviewRecords } from "../react-review.js";
import { reactRulePolicy } from "../react-rules.js";
import { frameworkRiskRecords } from "../scoring.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Config, EslintMessage, FunctionRecord, ModuleRecord, ScoredRecord } from "../types.js";

export function measureReactHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const hooksLint = context.reactHooksLint();
  const a11yLint = context.jsxA11yLint();
  const records = [
    ...project.modules.flatMap((module) => reactModuleRecords(module, !a11yLint.complete)),
    ...hooksLint.messages.map(hookLintRecord),
    ...a11yLint.messages.map(a11yLintRecord),
    ...frameworkRiskRecords(project),
    ...reactReviewRecords(config, project, context.syntaxProgram(), context.workspaceManifest),
  ];
  const artifact = {
    ...artifactBase(config, "quality.react_health", command, analysisConfidence(config, project, {
      eslint_react_hooks_available: hooksLint.available,
      eslint_react_hooks_ran: hooksLint.ran,
      eslint_react_hooks_complete: hooksLint.complete,
      jsx_a11y_available: a11yLint.available,
      jsx_a11y_ran: a11yLint.ran,
      jsx_a11y_complete: a11yLint.complete,
      required_inputs: ["source_roots_exist", "package_json_found", "eslint_react_hooks_complete",
        ...(config.accessibility.enabled ? ["jsx_a11y_complete"] : [])],
    }), context.sourceHash(), context.identity()),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages.length,
      guidance_review_candidates: records.filter((record) => record.source === "react-guidance-review").length,
      correctness_findings: records.filter((record) => record.react_category === "correctness").length,
      optimization_findings: records.filter((record) => record.react_category === "optimization").length,
      configuration_findings: records.filter((record) => record.react_category === "configuration").length,
      unclassified_hook_findings: records.filter((record) => record.react_category === "unknown").length,
      a11y_findings: records.filter(isAccessibilityFinding).length,
      a11y_tool_findings: a11yLint.messages.length,
      a11y_heuristic_findings: records.filter((record) => record.source === "jsx-a11y-heuristic").length,
      high_risk_components: records.filter((record) => record.risk === "high").length,
    },
    framework: project.frameworkDetails,
    guidance_version: REACT_GUIDANCE_VERSION,
    rule_coverage: reactRuleCoverage(hooksLint),
    custom_effect_hooks: { pattern: config.react.additionalEffectHooks, calls: customEffectHookCalls(config),
      status: !config.react.additionalEffectHooks ? "not_configured" : hooksLint.complete ? "evaluated" : "incomplete",
      scope: "Syntactic direct named calls matching the configured expression; not per-call semantic coverage." },
    react_support: reactSupport(config, project.workspaces),
    tool_status: {
      eslint_react_hooks: {
        available: hooksLint.available,
        ran: hooksLint.ran,
        complete: hooksLint.complete,
        reason: hooksLint.reason,
        version: hooksLint.version,
        ruleset: hooksLint.ruleset,
        selected_preset: hooksLint.selected_preset ?? null,
        enabled_rules: hooksLint.enabled_rules ?? [],
        evaluated_files: hooksLint.evaluated_files ?? [],
      },
      jsx_a11y: {
        available: a11yLint.available,
        ran: a11yLint.ran,
        complete: a11yLint.complete,
        reason: a11yLint.reason,
        version: a11yLint.version,
        ruleset: "jsx-a11y-recommended-v1",
      },
    },
    engine_relationships: [{ capability: "jsx-accessibility", producers: ["eslint-plugin-jsx-a11y", "jsx-a11y-heuristic"],
      mode: "alternative", external_evaluated: a11yLint.complete,
      scope: "Heuristic fallback is used only when managed accessibility is incomplete; not an independent standards check",
      selected_files: project.sourceFiles.map((file) => file.relativePath), exclusions: config.exclude,
      comparison: "not_comparable", reason: "Regex candidates and managed accessibility rules do not establish equivalent semantic predicates." }],
    rule_applicability: fileRuleApplicability(BLOCKING_REACT_RULES, project.sourceFiles.map((file) => file.relativePath),
      hooksLint.evaluated_files ?? [], (file) => /\.[jt]sx?$/.test(file)).map((entry) =>
        (hooksLint.enabled_rules ? !hooksLint.enabled_rules.includes(entry.contract_id) : config.react.ruleset === "classic-v1" && entry.contract_id === "react-hooks/set-state-in-render")
          ? { ...entry, evaluated: 0, abstained: 0, skipped: project.sourceFiles.length, status: "not_applicable" as const, reasons: ["Rule is disabled in the selected managed preset."] } : entry),
    records,
  };
  return writeArtifact(config, "react_health.json", artifact);
}

function isAccessibilityFinding(record: ScoredRecord): boolean {
  return record.source === "eslint-plugin-jsx-a11y" || record.source === "jsx-a11y-heuristic";
}

function reactModuleRecords(module: ModuleRecord, includeA11yFallback: boolean): ScoredRecord[] {
  return [
    ...(includeA11yFallback ? jsxA11yRecords(module) : []),
    ...componentHealthRecords(module),
  ];
}

/**
 * Component IDs are name-based so they survive edits; names repeated within one module (for example inline
 * `Cell` renderers in a column list) are distinguished by their source position.
 */
function componentHealthRecords(module: ModuleRecord): ScoredRecord[] {
  const counts = new Map<string, number>();
  for (const component of module.components) counts.set(component.name, (counts.get(component.name) ?? 0) + 1);
  return module.components.map((component) => componentHealthRecord(module, component,
    (counts.get(component.name) ?? 0) > 1 ? `@${component.id.split(":").slice(-2).join(":")}` : ""));
}

function componentHealthRecord(module: ModuleRecord, component: FunctionRecord, position: string): ScoredRecord {
  const signals = [
    ...(component.lines > 120 ? [{ kind: "oversized_component", value: component.lines }] : []),
    ...(component.hooks > 5 ? [{ kind: "many_hooks", value: component.hooks }] : []),
    ...(component.effects > 2 ? [{ kind: "many_effects", value: component.effects }] : []),
    ...(component.jsxConditionals > 4 ? [{ kind: "render_branch_complexity", value: component.jsxConditionals }] : []),
  ];
  const score = component.lines * 0.25 + component.hooks * 8 + component.effects * 12 + component.jsxConditionals * 6;
  return {
    id: `component:${module.id}:${component.name}${position}`,
    module_id: module.id,
    file: module.file,
    name: component.name,
    line: component.line,
    score: Math.round(score),
    risk: riskForScore(score),
    signals,
  };
}

function hookLintRecord(message: EslintMessage): ScoredRecord {
  const ruleName = message.rule_id.replace(/^react-hooks\//, "");
  const policy = reactRulePolicy(message.rule_id);
  const kind = `${ruleName.replace(/-/g, "_")}_violation`;
  return {
    ...eslintFindingRecord(message, {
      id: eslintFindingId(message, "eslint-plugin-react-hooks"), kind, disposition: policy.disposition, source: "eslint-plugin-react-hooks",
    }),
    react_category: policy.category,
    guidance_url: reactRuleDocumentation(message.rule_id),
  };
}

function a11yLintRecord(message: EslintMessage): ScoredRecord {
  const kind = message.rule_id.replace(/^jsx-a11y\//, "a11y_").replace(/-/g, "_");
  return eslintFindingRecord(message, {
    id: eslintFindingId(message, "eslint-plugin-jsx-a11y"), kind, disposition: "warn", source: "eslint-plugin-jsx-a11y",
  });
}

function eslintFindingId(message: EslintMessage, source: string): string {
  const location = `${message.file}:${message.line ?? 0}:${message.column ?? 0}`;
  return source === "eslint-plugin-react-hooks"
    ? `react-hooks:${location}:${message.rule_id}`
    : `jsx-a11y:${message.rule_id}:${location}`;
}

function jsxA11yRecords(module: ModuleRecord): ScoredRecord[] {
  const records = [
    ...[...module.text.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/g)]
      .map((match) => a11yRecord(module, "img_missing_alt", match.index ?? 0, 45)),
    ...[...module.text.matchAll(/<(?:div|span)\b(?=[^>]*\bonClick=)(?![^>]*\brole=)[^>]*>/g)]
      .map((match) => a11yRecord(module, "interactive_non_semantic_element", match.index ?? 0, 55)),
  ];
  // Line-based IDs stay stable; several hits of one kind on a line are distinguished by column.
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  return records.map((record) => (counts.get(record.id) ?? 0) > 1 ? { ...record, id: `${record.id}:${record.column}` } : record);
}

function a11yRecord(module: ModuleRecord, kind: string, index: number, score: number): ScoredRecord {
  const before = module.text.slice(0, index).split(/\r?\n/);
  const line = before.length;
  return {
    id: `a11y:${module.id}:${kind}:${line}`,
    module_id: module.id,
    file: module.file,
    line,
    column: (before.at(-1)?.length ?? 0) + 1,
    kind,
    rule_id: `ts-react-quality-lens/${kind}`,
    evidence_kind: "heuristic",
    disposition: "review",
    finding_confidence: "medium",
    scope: "file",
    score,
    risk: riskForScore(score),
    source: "jsx-a11y-heuristic",
    signals: [{ kind }],
  };
}
