import path from "node:path";
import { dedupeBy, groupBy } from "./collections.js";
import { isTestPath, toPosix } from "./files.js";
import { maxScoreFor, riskForScore } from "./scoring.js";

export function mapNode(module, artifacts) {
  const risks = [
    maxScoreFor(artifacts.hotspots?.records, module.file),
    maxScoreFor(artifacts.escape_hatches?.records, module.file, "severity"),
    maxScoreFor(artifacts.type_health?.records, module.file),
    maxScoreFor(artifacts.dependency_health?.records, module.file),
    maxScoreFor(artifacts.locality?.records, module.file),
    maxScoreFor(artifacts.leverage?.records, module.file),
    maxScoreFor(artifacts.react_health?.records, module.file),
  ];
  const riskScore = Math.max(0, ...risks.filter((score) => Number.isFinite(score)));
  return {
    id: module.id,
    label: path.basename(module.file),
    file: module.file,
    type: module.components.length ? "component" : module.file.includes("/hooks/") ? "hook" : "module",
    group: module.id.split("/").slice(0, -1).join("/") || ".",
    risk_score: riskScore,
    risk: riskForScore(riskScore),
    category_scores: {
      maintainability: maxScoreFor(artifacts.hotspots?.records, module.file),
      correctness: module.file in correctnessMap(artifacts.correctness) ? 0 : 40,
      architecture: maxScoreFor(artifacts.dependency_health?.records, module.file),
      change: maxScoreFor(artifacts.locality?.records, module.file),
      render_performance: maxScoreFor(artifacts.react_health?.records, module.file),
    },
    evidence: {
      imports: module.imports.length,
      exports: module.exports.length,
      functions: module.functions.length,
      components: module.components.length,
      types: module.types.length,
    },
  };
}

export function groupMapNodes(nodes) {
  return [...groupBy(nodes, (node) => node.group).entries()].map(([id, groupNodes]) => ({
    id,
    label: id === "." ? "root" : id,
    node_count: groupNodes.length,
    risk_score: Math.max(0, ...groupNodes.map((node) => node.risk_score)),
  }));
}

export function findCycles(edges) {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from).push(edge.to);
  }
  const cycles = new Set<string>();
  for (const node of graph.keys()) {
    visit(node, node, [], new Set());
  }
  return [...cycles].map((cycle) => cycle.split(" -> "));

  function visit(start, current, pathItems, seen) {
    if (seen.has(current)) return;
    seen.add(current);
    for (const next of graph.get(current) ?? []) {
      if (next === start && pathItems.length > 0) {
        const cycle = canonicalCycle([...pathItems, current, next]);
        cycles.add(cycle);
      } else {
        visit(start, next, [...pathItems, current], new Set(seen));
      }
    }
  }
}

export function dependencyCruiserEdges(config, project, modules) {
  const lineIndex = new Map();
  for (const edge of project.imports) {
    lineIndex.set(`${edge.from}->${stripSourceExtension(edge.to)}`, edge.line);
    lineIndex.set(`${edge.from}->${edge.specifier}`, edge.line);
    if (edge.specifier.startsWith("node:")) lineIndex.set(`${edge.from}->${edge.specifier.slice(5)}`, edge.line);
  }
  return modules.flatMap((module) => {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    if (!from || isTestPath(from)) return [];
    return (module.dependencies ?? [])
      .map((dependency) => ({
        from,
        to: dependencyTarget(dependency),
        kind: dependencyKind(dependency),
        import_kind: dependency.dependencyTypes?.includes("dynamic") ? "dynamic" : "static",
        line: null,
        source: "dependency-cruiser",
      }))
      .filter((edge) => !isTestPath(edge.to))
      .map((edge) => ({
        ...edge,
        line: lineIndex.get(`${edge.from}->${edge.to}`) ?? null,
      }));
  });
}

export function dependencyCruiserCycles(config, modules) {
  const cycles = [];
  for (const module of modules) {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    for (const dependency of module.dependencies ?? []) {
      const cyclePath = normalizeDependencyCruiserCycle(dependency.cycle);
      if (!cyclePath.length) continue;
      for (const cycle of [cyclePath]) {
        const files = [from, ...cycle.map((item) => stripSourceExtension(toPosix(item)))]
          .filter(Boolean)
          .map((file) => stripProjectPrefix(config, file));
        if (files.length > 1) cycles.push(files);
      }
    }
  }
  return dedupeBy(cycles, (cycle) => canonicalCycle([...cycle, cycle[0]]));
}

export function uniqueCycleCount(...cycleSets) {
  return new Set(
    cycleSets.flat().map((cycle) => {
      if (!cycle.length) return "";
      const closed = cycle[0] === cycle.at(-1) ? cycle : [...cycle, cycle[0]];
      return canonicalCycle(closed);
    }),
  ).size;
}

function canonicalCycle(cycle) {
  const bare = cycle.slice(0, -1);
  const rotations = bare.map((_, index) => [...bare.slice(index), ...bare.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...rotations[0], rotations[0][0]].join(" -> ");
}

function dependencyTarget(dependency) {
  const resolved = dependency.resolved ? toPosix(dependency.resolved) : null;
  if (dependency.coreModule || dependency.npm || resolved?.includes("/node_modules/")) return dependency.module;
  return resolved ? stripSourceExtension(resolved) : dependency.module;
}

function dependencyKind(dependency) {
  const resolved = dependency.resolved ? toPosix(dependency.resolved) : null;
  if (dependency.coreModule || dependency.npm || resolved?.includes("/node_modules/")) return "external";
  return resolved ? "relative" : "unresolved";
}

function normalizeDependencyCruiserCycle(cycle) {
  if (!cycle) return [];
  if (typeof cycle === "string") return [cycle];
  if (!Array.isArray(cycle)) return [];
  return cycle
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof item.name === "string") return item.name;
      return null;
    })
    .filter(Boolean);
}

function stripProjectPrefix(config, value) {
  const absolute = path.resolve(config.projectRoot, value);
  if (absolute.startsWith(config.projectRoot)) {
    return stripSourceExtension(toPosix(path.relative(config.projectRoot, absolute)));
  }
  return stripSourceExtension(value);
}

function stripSourceExtension(value) {
  return value.replace(/\.[cm]?[jt]sx?$/, "");
}

function correctnessMap(artifact) {
  const result = {};
  for (const test of artifact?.tests ?? []) {
    for (const file of test.source_mapping ?? []) result[file] = true;
  }
  return result;
}
