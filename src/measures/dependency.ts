import { createAnalysisContext, analysisConfidence, dependencyCruiserCycles, dependencyCruiserEdges, findCycles, uniqueCycleCount } from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { writeArtifact } from "../writer.js";

export function measureDependencyHealth(config, command, context = createAnalysisContext(config)) {
  const project = context.project();
  const depcruise = context.dependencyCruiser();
  const internalEdges = project.imports.filter((edge) => edge.to_kind === "relative");
  const externalEdges = project.imports.filter((edge) => edge.to_kind === "external");
  const cycles = findCycles(internalEdges);
  const depcruiseCycles = depcruise.ran ? dependencyCruiserCycles(config, depcruise.modules) : [];
  const deepRelativeImports = project.imports.filter((edge) => edge.specifier.startsWith("../../"));
  const barrelModules = project.modules.filter((module) => module.isBarrel);
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
    ),
    summary: {
      internal_edges: internalEdges.length,
      external_edges: externalEdges.length,
      cycles: uniqueCycleCount(cycles, depcruiseCycles),
      heuristic_cycles: cycles.length,
      dependency_cruiser_cycles: depcruiseCycles.length,
      deep_relative_imports: deepRelativeImports.length,
      barrel_modules: barrelModules.length,
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
      nodes: project.modules.map((module) => ({ id: module.id, file: module.file })),
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

function cycleRecord(cycle, id, lineWeight, source = null) {
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
