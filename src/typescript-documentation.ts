import path from "node:path";
import { matchesPathPattern as matches } from "./files.js";
import * as ts from "typescript";
import { arrayOf, boolean, count, finite, nonempty, nullable, oneOf, positiveInteger, shape, string } from "./validation.js";
import type { Config, ProjectAnalysis, ScoredRecord } from "./types.js";

export type ExportDocumentation = {
  name: string;
  declaration_file: string | null;
  line: number | null;
  documented: boolean;
  deprecated: boolean;
  deprecation_guidance: boolean;
};
type DocumentationItem = ExportDocumentation & {
  file: string;
  status: "evaluated" | "excluded" | "unavailable";
  reason: string | null;
};
type DocumentationFile = { file: string; status: "evaluated" | "excluded" | "unavailable"; reason: string | null };

/** Resolve aliases/re-exports to their declarations; do not retain compiler objects. */
export function collectExportDocumentation(checker: ts.TypeChecker, source: ts.SourceFile, root: string): ExportDocumentation[] {
  const module = checker.getSymbolAtLocation(source);
  return (module ? checker.getExportsOfModule(module) : []).map((exported) => {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target.declarations?.[0];
    const tags = [...exported.getJsDocTags(checker), ...(target === exported ? [] : target.getJsDocTags(checker))];
    const text = (parts: ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts).trim();
    const deprecated = tags.filter((tag) => tag.name === "deprecated");
    return {
      name: exported.getName(),
      declaration_file: declaration ? path.relative(root, declaration.getSourceFile().fileName).replace(/\\/g, "/") : null,
      line: declaration ? declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1 : null,
      documented: Boolean(text(exported.getDocumentationComment(checker)) || text(target.getDocumentationComment(checker)) ||
        tags.some((tag) => ["param", "returns", "return", "remarks", "example", "deprecated"].includes(tag.name) && text(tag.text))),
      deprecated: deprecated.length > 0,
      deprecation_guidance: deprecated.some((tag) => Boolean(text(tag.text))),
    };
  });
}

/** Measure a declared public surface, never treating missing inventory as zero defects. */
export function documentationEvidence(config: Config, project: ProjectAnalysis) {
  const files: DocumentationFile[] = [];
  const items: DocumentationItem[] = [];
  const unmatched: string[] = [];
  const modules = new Map(project.modules.map((module) => [module.file, module]));
  const hasExplicitScope = config.publicApi.entry.length > 0 || config.publicApi.exports.length > 0;
  const entireFile = (file: string) => !hasExplicitScope || config.publicApi.entry.some((pattern) => matches(file, pattern));
  const selectors = (file: string) => config.publicApi.exports.filter((rule) => matches(file, rule.file));
  if (config.documentation.enabled) {
    for (const pattern of config.publicApi.entry) {
      if (!project.modules.some((module) => matches(module.file, pattern))) unmatched.push(`entry:${pattern}`);
    }
    for (const rule of config.publicApi.exports) {
      const matching = project.modules.filter((module) => matches(module.file, rule.file));
      if (!matching.length) unmatched.push(`exports:${rule.file}`);
      for (const module of matching) {
        const inventory = module.typed?.documentation;
        if (!inventory) continue;
        unmatched.push(...rule.names.filter((name) => !inventory.exports.some((item) => item.name === name)).map((name) => `export:${module.file}:${name}`));
      }
    }
    for (const module of project.modules) {
      const rules = selectors(module.file), names = rules.flatMap((rule) => rule.names);
      const selected = hasExplicitScope ? entireFile(module.file) || rules.length > 0
        : module.entrypointRoles.some((role) => ["package_export", "package_main", "package_module", "package_types"].includes(role));
      if (!selected) continue;
      const excluded = exclusion(module.file);
      const inventory = module.typed?.documentation;
      files.push({ file: module.file, ...assessment(excluded, Boolean(inventory?.complete), "Compiler export inventory is missing or has diagnostics.") });
      for (const item of inventory?.exports ?? []) {
        if (!entireFile(module.file) && !names.includes(item.name)) continue;
        items.push({ ...item, file: module.file, ...assessment(exportExclusion(module.file, item, excluded),
          Boolean(inventory?.complete && item.declaration_file), "Export could not be evaluated reliably.") });
      }
    }
  }
  const evaluated = items.filter((item) => item.status === "evaluated");
  const status = documentationStatusFor(config.documentation.enabled, files, items, unmatched);
  return {
    report: {
      status,
      scope: hasExplicitScope ? "configured-public-api" : "detected-package-entrypoints",
      limitations: "Top-level exported names only, counted per entrypoint/name. Presence of documentation and deprecation text is measured; prose quality and migration correctness are not verified. External or unselected declaration files are excluded.",
      summary: documentationSummary(items, status),
      files, exports: items, unmatched_selectors: unmatched,
    },
    records: evaluated.flatMap((item) => [
      ...(!item.documented ? [documentationFinding(item, "undocumented-public-export", `Public export ${item.name} has no descriptive JSDoc. Review whether documentation would help its consumers.`)] : []),
      ...(item.deprecated && !item.deprecation_guidance ? [documentationFinding(item, "missing-deprecation-guidance", `Deprecated export ${item.name} has no guidance text. Document a replacement, migration steps, or why no replacement exists.`)] : []),
    ]),
  };

  function exportExclusion(file: string, item: ExportDocumentation, excluded: string | null): string | null {
    const exemption = config.documentation.exemptExports.find((rule) => matches(file, rule.file) && rule.names.includes(item.name));
    const origin = item.declaration_file;
    return excluded ?? exemption?.reason ?? (origin ? exclusion(origin) ?? (!modules.has(origin) ? "Declaration is outside selected source files." : null) : null);
  }

  function exclusion(file: string): string | null {
    const module = modules.get(file);
    if (config.documentation.exclude.some((pattern) => matches(file, pattern))) return "Configured documentation exclusion.";
    if (/(?:^|\/)[^/]*\.(?:generated|gen)\.[^/]+$/.test(file) || module && ts.getLeadingCommentRanges(module.text, 0)?.some((range) => /@generated\b/.test(module.text.slice(range.pos, range.end)))) return "Generated source.";
    return null;
  }
}

function documentationFinding(item: DocumentationItem, kind: string, message: string): ScoredRecord {
  return {
    id: `documentation:${kind}:${item.file}:${item.name}`,
    rule_id: `ts-react-quality-lens/${kind}`, kind, file: item.declaration_file ?? item.file,
    public_entrypoint: item.file, line: item.line, name: item.name, message,
    evidence_kind: "metric", disposition: "review", semantic_decision: "unresolved", finding_confidence: "high",
    scope: "file", source: "typescript-documentation", score: 15, risk: "low", documentation_quality_verified: false,
  };
}

function assessment(reason: string | null, available: boolean, unavailable: string): Pick<DocumentationFile, "status" | "reason"> {
  if (reason) return { status: "excluded", reason };
  return available ? { status: "evaluated", reason: null } : { status: "unavailable", reason: unavailable };
}

function documentationStatusFor(enabled: boolean, files: DocumentationFile[], items: DocumentationItem[], unmatched: string[]) {
  if (!enabled) return "disabled";
  if (unmatched.length || [...files, ...items].some((item) => item.status === "unavailable")) return "incomplete";
  return items.some((item) => item.status === "evaluated") ? "complete" : "not_applicable";
}

function documentationSummary(items: DocumentationItem[], status: string) {
  const evaluated = items.filter((item) => item.status === "evaluated");
  const documented = evaluated.filter((item) => item.documented).length;
  const deprecated = evaluated.filter((item) => item.deprecated);
  const guidance = deprecated.filter((item) => item.deprecation_guidance).length;
  return { public_exports: items.length, evaluated_exports: evaluated.length,
    excluded_exports: items.filter((item) => item.status === "excluded").length,
    unavailable_exports: items.filter((item) => item.status === "unavailable").length,
    documented_exports: documented, undocumented_exports: evaluated.length - documented,
    coverage_percent: status === "complete" ? Math.round(documented / evaluated.length * 10_000) / 100 : null,
    deprecated_exports: deprecated.length, deprecated_with_guidance_text: guidance, missing_deprecation_guidance: deprecated.length - guidance };
}

const documentationStatus = oneOf("evaluated", "excluded", "unavailable");
const reportShape = shape({
  status: oneOf("disabled", "complete", "incomplete", "not_applicable"),
  scope: oneOf("configured-public-api", "detected-package-entrypoints"),
  files: arrayOf(shape({ file: nonempty, status: documentationStatus, reason: nullable(string) })),
  exports: arrayOf(shape({ file: nonempty, name: nonempty, declaration_file: nullable(nonempty), line: nullable(positiveInteger),
    documented: boolean, deprecated: boolean, deprecation_guidance: boolean, status: documentationStatus, reason: nullable(string) })),
  unmatched_selectors: arrayOf(nonempty),
  summary: shape({ public_exports: count, evaluated_exports: count, excluded_exports: count, unavailable_exports: count,
    documented_exports: count, undocumented_exports: count, coverage_percent: nullable(finite), deprecated_exports: count,
    deprecated_with_guidance_text: count, missing_deprecation_guidance: count }),
});

export function validDocumentationReport(value: unknown): boolean {
  if (!reportShape(value)) return false;
  const evaluated = value.exports.filter((item) => item.status === "evaluated");
  if (evaluated.some((item) => item.declaration_file === null || item.line === null)) return false;
  const expectedStatus = documentationStatusFor(value.status !== "disabled", value.files, value.exports, value.unmatched_selectors);
  if (value.status !== expectedStatus || value.status === "disabled" && (value.files.length || value.exports.length || value.unmatched_selectors.length)) return false;
  return Object.entries(documentationSummary(value.exports, expectedStatus)).every(([key, expected]) => value.summary[key] === expected);
}
