import {
  analysisConfidence,
  artifactBase,
  createAnalysisContext,
  dependencyCruiserCycles,
  dependencyCruiserEdges,
  findCycles,
  sourceSetHash,
  uniqueCycleCount,
  writeArtifact,
} from "../measure-shared.js";
import type { AnalysisContext, Config, ImportRecord, LayerRule } from "../types.js";

export function measureDependencyHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const depcruise = context.dependencyCruiser();
  const internalEdges = project.imports.filter((edge) => edge.to_kind === "relative");
  const externalEdges = project.imports.filter((edge) => edge.to_kind === "external");
  const depcruiseCycles = depcruise.ran ? dependencyCruiserCycles(config, depcruise.modules) : [];
  const cycles = depcruise.ran ? [] : findCycles(internalEdges);
  const deepRelativeImports = project.imports.filter((edge) => edge.specifier.startsWith("../../"));
  const barrelModules = project.modules.filter((module) => module.isBarrel);
  const layerByModule = new Map(project.modules.map((module) => [module.id, classifyLayer(module.file, config.layerRules)]));
  const layerViolations = internalEdges.filter((edge) => isLayerViolation(edge, layerByModule, config.layerRules));
  const records = [
    ...cycles.map((cycle, index) => cycleRecord(cycle, `cycle:${index + 1}`, 18)),
    ...depcruiseCycles.map((cycle, index) =>
      cycleRecord(cycle, `depcruise-cycle:${index + 1}`, 20, "dependency-cruiser"),
    ),
    ...deepRelativeImports.map((edge) => ({
      id: `deep-import:${edge.from}:${edge.line}`,
      kind: "deep_relative_import",
      severity: "medium",
      score: 35,
      file: edge.from,
      line: edge.line,
      specifier: edge.specifier,
      evidence: edge.source,
    })),
    ...barrelModules.map((module) => ({
      id: `barrel:${module.id}`,
      kind: "barrel_fanout",
      severity: module.exports.length > 10 ? "medium" : "low",
      score: Math.min(60, module.exports.length * 4),
      file: module.file,
      exports: module.exports.length,
      evidence: "Module is mostly re-export statements.",
    })),
    ...layerViolations.map((edge) => layerViolationRecord(edge, layerByModule)),
    ...project.unsupportedPatterns.map((signal, index) => ({
      id: `unsupported:${index + 1}:${signal.file}:${signal.line ?? 0}`,
      kind: "unsupported_pattern",
      severity: "medium",
      score: 35,
      file: signal.file,
      line: signal.line ?? null,
      evidence: signal.message ?? signal.kind,
      signals: [signal],
    })),
  ];
  const artifact = {
    ...artifactBase(
      config,
      "quality.dependency_health",
      command,
      analysisConfidence(config, project, {
        dependency_cruiser_available: depcruise.available,
        dependency_cruiser_ran: depcruise.ran,
      }),
      sourceSetHash(project),
    ),
    summary: {
      internal_edges: internalEdges.length,
      external_edges: externalEdges.length,
      cycles: uniqueCycleCount(cycles, depcruiseCycles),
      heuristic_cycles: cycles.length,
      dependency_cruiser_cycles: depcruiseCycles.length,
      deep_relative_imports: deepRelativeImports.length,
      barrel_modules: barrelModules.length,
      layer_violations: layerViolations.length,
      unsupported_patterns: project.unsupportedPatterns.length,
    },
    tool_status: {
      dependency_cruiser: {
        available: depcruise.available,
        ran: depcruise.ran,
        reason: depcruise.reason ?? null,
        summary: depcruise.summary ?? {},
      },
    },
    records,
    graph: {
      nodes: project.modules.map((module) => ({ id: module.id, file: module.file, layer: layerByModule.get(module.id) ?? null })),
      edges: depcruise.ran
        ? dependencyCruiserEdges(config, project, depcruise.modules)
        : project.imports.map((edge) => ({
            from: edge.from,
            to: edge.to,
            kind: edge.to_kind,
            import_kind: edge.import_kind,
            line: edge.line,
          })),
    },
  };
  writeArtifact(config, "dependency_health.json", artifact);
  return artifact;
}

function classifyLayer(file: string, rules: LayerRule[]): string | null {
  return rules.find((rule) => rule.patterns.some((pattern) => globMatch(file, pattern)))?.layer ?? null;
}

function isLayerViolation(edge: ImportRecord, layerByModule: Map<string, string | null>, rules: LayerRule[]): boolean {
  const fromLayer = layerByModule.get(edge.from);
  const toLayer = layerByModule.get(edge.to);
  if (!fromLayer || !toLayer || fromLayer === toLayer) return false;
  const fromIndex = rules.findIndex((rule) => rule.layer === fromLayer);
  const toIndex = rules.findIndex((rule) => rule.layer === toLayer);
  return fromIndex >= 0 && toIndex >= 0 && fromIndex > toIndex;
}

function layerViolationRecord(edge: ImportRecord, layerByModule: Map<string, string | null>) {
  const fromLayer = layerByModule.get(edge.from) ?? "unknown";
  const toLayer = layerByModule.get(edge.to) ?? "unknown";
  return {
    id: `layer:${edge.from}:${edge.line}:${edge.to}`,
    kind: "layer_violation",
    severity: "high",
    score: 75,
    file: edge.from,
    line: edge.line,
    target: edge.to,
    from_layer: fromLayer,
    to_layer: toLayer,
    specifier: edge.specifier,
    evidence: `${fromLayer} imports upward into ${toLayer}: ${edge.specifier}`,
  };
}

function globMatch(file: string, pattern: string): boolean {
  const tokenized = pattern.replace(/\*\*/g, "__GLOBSTAR__").replace(/\*/g, "__STAR__");
  const escaped = tokenized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/__GLOBSTAR__/g, ".*").replace(/__STAR__/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(file) || new RegExp(`(^|/)${escaped}$`).test(file);
}

function cycleRecord(cycle: string[], id: string, lineWeight: number, source: string | null = null) {
  return {
    id,
    kind: "import_cycle",
    severity: cycle.length > 3 ? "high" : "medium",
    score: Math.min(100, cycle.length * lineWeight),
    files: cycle,
    evidence: cycle.join(" -> "),
    ...(source ? { source } : {}),
  };
}
