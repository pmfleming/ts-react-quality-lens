import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { eslintFindingRecord } from "../integrations/eslint-findings.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { riskForScore } from "../risk-model.js";
import { frameworkRiskRecords } from "../scoring.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, Config, EslintMessage, FindingDisposition, FunctionRecord, ModuleRecord, ScoredRecord } from "../types.js";

export function measureReactHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const hooksLint = context.reactHooksLint();
  const a11yLint = context.jsxA11yLint();
  const records = [
    ...project.modules.flatMap((module) => reactModuleRecords(module, !a11yLint.complete)),
    ...hooksLint.messages.map(hookLintRecord),
    ...a11yLint.messages.map(a11yLintRecord),
    ...frameworkRiskRecords(project),
  ];
  const artifact = {
    ...artifactBase(config, "quality.react_health", command, analysisConfidence(config, project, {
      eslint_react_hooks_available: hooksLint.available,
      eslint_react_hooks_ran: hooksLint.ran,
      eslint_react_hooks_complete: hooksLint.complete,
      jsx_a11y_available: a11yLint.available,
      jsx_a11y_ran: a11yLint.ran,
      jsx_a11y_complete: a11yLint.complete,
    }), sourceSetHash(project)),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages.length,
      a11y_findings: records.filter(isAccessibilityFinding).length,
      a11y_tool_findings: a11yLint.messages.length,
      a11y_heuristic_findings: records.filter((record) => record.source === "jsx-a11y-heuristic").length,
      high_risk_components: records.filter((record) => record.risk === "high").length,
    },
    framework: project.frameworkDetails,
    tool_status: {
      eslint_react_hooks: {
        available: hooksLint.available,
        ran: hooksLint.ran,
        complete: hooksLint.complete,
        reason: hooksLint.reason,
        version: hooksLint.version,
        ruleset: hooksLint.ruleset,
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
    records,
  };
  writeArtifact(config, "react_health.json", artifact);
  return artifact;
}

function isAccessibilityFinding(record: ScoredRecord): boolean {
  return record.source === "eslint-plugin-jsx-a11y" || record.source === "jsx-a11y-heuristic";
}

function reactModuleRecords(module: ModuleRecord, includeA11yFallback: boolean): ScoredRecord[] {
  return [
    ...(includeA11yFallback ? jsxA11yRecords(module) : []),
    ...module.components.map((component) => componentHealthRecord(module, component)),
  ];
}

function componentHealthRecord(module: ModuleRecord, component: FunctionRecord): ScoredRecord {
  const signals = [
    ...(component.lines > 120 ? [{ kind: "oversized_component", value: component.lines }] : []),
    ...(component.hooks > 5 ? [{ kind: "many_hooks", value: component.hooks }] : []),
    ...(component.effects > 2 ? [{ kind: "many_effects", value: component.effects }] : []),
    ...(component.jsxConditionals > 4 ? [{ kind: "render_branch_complexity", value: component.jsxConditionals }] : []),
  ];
  const score = component.lines * 0.25 + component.hooks * 8 + component.effects * 12 + component.jsxConditionals * 6;
  return {
    id: `component:${module.id}:${component.name}`,
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
  const disposition = reactRuleDisposition(ruleName);
  const kind = `${ruleName.replace(/-/g, "_")}_violation`;
  return eslintFindingRecord(message, {
    id: eslintFindingId(message, "eslint-plugin-react-hooks"), kind, disposition, source: "eslint-plugin-react-hooks",
  });
}

function reactRuleDisposition(ruleName: string): FindingDisposition {
  if (["rules-of-hooks", "set-state-in-render"].includes(ruleName)) return "block";
  if (["exhaustive-deps", "immutability", "globals", "refs", "purity", "static-components", "error-boundaries"].includes(ruleName)) {
    return "warn";
  }
  return ruleName === "unsupported-syntax" ? "info" : "review";
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
  return [
    ...[...module.text.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/g)]
      .map((match) => a11yRecord(module, "img_missing_alt", match.index ?? 0, 45)),
    ...[...module.text.matchAll(/<(?:div|span)\b(?=[^>]*\bonClick=)(?![^>]*\brole=)[^>]*>/g)]
      .map((match) => a11yRecord(module, "interactive_non_semantic_element", match.index ?? 0, 55)),
  ];
}

function a11yRecord(module: ModuleRecord, kind: string, index: number, score: number): ScoredRecord {
  const line = module.text.slice(0, index).split(/\r?\n/).length;
  return {
    id: `a11y:${module.id}:${kind}:${line}`,
    module_id: module.id,
    file: module.file,
    line,
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
