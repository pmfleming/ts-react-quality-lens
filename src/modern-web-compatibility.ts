import bcd from "@mdn/browser-compat-data" with { type: "json" };
import semver from "semver";
import * as ts from "typescript";
import type { BrowserName, Identifier, SimpleSupportStatement } from "@mdn/browser-compat-data/types";
import type { BrowserTargets, ModernWebCandidate, ModernWebCompatibility } from "./modern-web-types.js";
import type { WebInput } from "./web-inputs.js";

export const MODERN_WEB_MAPPING_VERSION = "modern-web-feature-map-v1";
type Mapping = { features: string[]; guide: string; cssGuard?: [string, string] };
const MAPPINGS: Record<string, Mapping> = {
  "form-fields-automatically-fit-contents": { features: ["css.properties.field-sizing.content"],
    guide: "forms/form-fields-automatically-fit-contents", cssGuard: ["field-sizing", "content"] },
  "animate-to-intrinsic-sizes": { features: ["css.properties.interpolate-size.allow-keywords"],
    guide: "css/animate-to-intrinsic-sizes", cssGuard: ["interpolate-size", "allow-keywords"] },
  dialog: { features: ["html.elements.dialog.closedby"], guide: "ui-components/dialog" },
  "scroll-entry-exit-effects/js-scroll-reveal": { features: ["css.properties.animation-timeline.view", "css.properties.animation-range"],
    guide: "ui-behaviors/scroll-entry-exit-effects", cssGuard: ["animation-timeline", "view()"] },
};
const BROWSERS: Record<string, BrowserName> = { chrome: "chrome", and_chr: "chrome_android", edge: "edge", firefox: "firefox",
  and_ff: "firefox_android", safari: "safari", ios_saf: "safari_ios", opera: "opera", op_mob: "opera_android",
  samsung: "samsunginternet_android", ie: "ie" };
const { __meta: _meta, browsers: _browsers, ...features } = bcd;

export function qualifyModernWeb(candidate: ModernWebCandidate, input: WebInput | undefined, targets: BrowserTargets | undefined): ModernWebCompatibility {
  const mapping = featureMapping(candidate, input);
  const base: ModernWebCompatibility = { status: "unknown", feature_ids: mapping?.features ?? [], unsupported_targets: [], unknown_targets: [],
    reason: "This scanner rule has no precise replacement feature mapping.", remediation: "withheld", guard: "not_assessed" };
  if (!mapping) return base;
  base.guard = input ? fallbackGuard(candidate, input, mapping) : "not_assessed";
  if (!targets || targets.status !== "resolved") return { ...base, reason: targets?.reason ?? "Browser targets are unknown." };
  for (const target of targets.resolved) {
    const states = mapping.features.map((feature) => featureSupport(feature, target));
    if (states.includes("unsupported")) base.unsupported_targets.push(target);
    if (states.includes("unknown")) base.unknown_targets.push(target);
  }
  if (base.unknown_targets.length) return { ...base, reason: "Support data is missing, partial, flagged or ambiguous for one or more targets." };
  if (!base.unsupported_targets.length) return { ...base, status: "supported", remediation: "review_replacement",
    reason: "The mapped replacement features are supported across the resolved targets; contextual verification is still required." };
  if (base.unsupported_targets.length === targets.resolved.length) return { ...base, status: "incompatible",
    reason: "No resolved target fully supports this replacement; retain the existing behavior." };
  return { ...base, status: "fallback_required", remediation: "review_fallback",
    reason: "Some targets need the existing implementation or an equivalent fallback; do not remove it based on this candidate." };
}

export function modernWebGuideUrl(candidate: ModernWebCandidate, input?: WebInput): string {
  const mapping = featureMapping(candidate, input);
  return `https://developer.chrome.com/docs/modern-web-guidance/guides${mapping ? `/${mapping.guide}` : ""}`;
}

function featureMapping(candidate: ModernWebCandidate, input?: WebInput): Mapping | undefined {
  if (candidate.rule_id !== "declarative-dialog-popover-control/click-listener") return MAPPINGS[candidate.rule_id];
  if (!input || input.kind !== "script") return undefined;
  const source = ts.createSourceFile(input.relativePath, input.text, ts.ScriptTarget.Latest, true);
  const line = source.getLineStarts()[candidate.line - 1];
  const methods = new Set<string>();
  const visit = (node: ts.Node) => {
    if (line === undefined || node.getEnd() < line || node.getStart(source) > line + candidate.line_content.length) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener") {
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) methods.add(child.expression.name.text);
        child.forEachChild(collect);
      };
      collect(node);
    } else node.forEachChild(visit);
  };
  visit(source);
  const popover = ["showPopover", "hidePopover", "togglePopover"].some((method) => methods.has(method));
  const dialog = ["showModal", "close"].some((method) => methods.has(method));
  if (popover === dialog) return undefined;
  return { guide: "ui-behaviors/declarative-dialog-popover-control", features: popover
    ? ["api.HTMLButtonElement.popoverTargetElement", "api.HTMLButtonElement.popoverTargetAction"]
    : ["api.HTMLButtonElement.command", "api.HTMLButtonElement.commandForElement"] };
}

/** Recognize only an enclosing, literal !CSS.supports guard; do not infer cross-file guarantees. */
function fallbackGuard(candidate: ModernWebCandidate, input: WebInput, mapping: Mapping): ModernWebCompatibility["guard"] {
  if (input.kind !== "script" || !mapping.cssGuard) return "not_assessed";
  const source = ts.createSourceFile(input.relativePath, input.text, ts.ScriptTarget.Latest, true);
  const offset = source.getLineStarts()[candidate.line - 1];
  if (offset === undefined) return "not_assessed";
  let observed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.thenStatement.getStart(source) <= offset + candidate.line_content.length && node.thenStatement.end >= offset) {
      const condition = node.expression;
      if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken &&
          ts.isCallExpression(condition.operand) && condition.operand.expression.getText(source) === "CSS.supports") {
        const args = condition.operand.arguments;
        if (args.length === 2 && args.every(ts.isStringLiteral) && args[0]?.text === mapping.cssGuard?.[0] && args[1]?.text === mapping.cssGuard?.[1]) observed = true;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return observed ? "observed" : "not_observed";
}

export function featureSupport(feature: string, target: string): "supported" | "unsupported" | "unknown" {
  let entry: Identifier | undefined = features;
  for (const segment of feature.split(".")) entry = entry?.[segment];
  const [browser = "", version = ""] = target.split(" ");
  const mapped = BROWSERS[browser];
  const statements = mapped ? entry?.__compat?.support[mapped] : undefined;
  if (!statements) return "unknown";
  const values = (Array.isArray(statements) ? statements : [statements]).map((statement) => supportStatement(statement, version));
  return values.includes("supported") ? "supported" : values.includes("unknown") ? "unknown" : "unsupported";
}

export function supportStatement(statement: SimpleSupportStatement, target: string): "supported" | "unsupported" | "unknown" {
  if (statement.version_added === false) return "unsupported";
  if (statement.flags || statement.prefix || statement.alternative_name || statement.partial_implementation) return "unknown";
  const [lowText, highText = lowText] = target.split("-");
  const low = semver.coerce(lowText), high = semver.coerce(highText);
  const added = semver.coerce(statement.version_added);
  if (!low || !high || !added) return "unknown";
  if (semver.lt(low, added)) return statement.version_added.startsWith("≤") ? "unknown" : "unsupported";
  if (statement.version_removed) {
    const removed = semver.coerce(statement.version_removed);
    if (!removed) return "unknown";
    if (semver.gte(high, removed)) return "unsupported";
  }
  return "supported";
}
