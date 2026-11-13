import path from "node:path";
import { dedupeBy, groupBy } from "./collections.js";
import { isTestPath, toPosix } from "./files.js";
import { directTestSources } from "./test-mapping.js";
import {
  architectureRiskScores,
  riskForScore,
  riskModelRecordMetadata,
  type ArtifactFreshnessLookup,
  type RiskArtifactLookup,
} from "./risk-model.js";
import type { Config, DependencyCruiserDependency, DependencyCruiserModule, ImportRecord, ModuleRecord } from "./types.js";

type ArtifactLookup = RiskArtifactLookup;

export function mapNode(
  module: ModuleRecord,
  artifacts: ArtifactLookup,
  artifactStatus: ArtifactFreshnessLookup = defaultArtifactStatus(artifacts),
  correctnessFiles = correctnessMap(artifacts.correctness),
) {
  const scores = architectureRiskScores(module, artifacts, artifactStatus, correctnessFiles);
  return {
    id: module.id,
    label: path.basename(module.file),
    file: module.file,
    type: module.components.length ? "component" : module.file.includes("/hooks/") ? "hook" : "module",
    group: module.id.split("/").slice(0, -1).join("/") || ".",
    workspace_id: module.workspace_id,
    workspace_name: module.workspace_name,
    entrypoint_roles: module.entrypointRoles,
    risk_score: scores.risk_score,
    risk: riskForScore(scores.risk_score),
    classification: scores.classification,
    category_scores: scores.category_scores,
    maintainability_risk: scores.maintainability_risk,
    change_risk: scores.change_risk,
    performance_risk: scores.performance_risk,
    correctness_risk: scores.correctness_risk,
    architectural_risk: scores.architectural_risk,
    quality_risk: scores.quality_risk,
    total_score: scores.total_score,
    unknown_metrics: scores.unknown_metrics,
    ...riskModelRecordMetadata(),
    evidence: {
      imports: module.imports.length,
      exports: module.exports.length,
      functions: module.functions.length,
      components: module.components.length,
      types: module.types.length,
      entrypoint_roles: module.entrypointRoles.length,
    },
    test_evidence: {
      direct_import_association: correctnessFiles.has(module.file),
      suite_status: artifacts.correctness?.execution?.status ?? "unknown",
      coverage_status: "not_collected",
    },
  };
}

function defaultArtifactStatus(artifacts: ArtifactLookup): ArtifactFreshnessLookup {
  return Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, value ? "available" : "missing"]));
}

export function groupMapNodes(nodes: Array<{ group: string; risk_score: number }>) {
  return [...groupBy(nodes, (node) => node.group).entries()].map(([id, groupNodes]) => ({
    id,
    label: id === "." ? "root" : id,
    node_count: groupNodes.length,
    risk_score: Math.max(0, ...groupNodes.map((node) => node.risk_score)),
  }));
}

export function findCycles(edges: Array<Pick<ImportRecord, "from" | "to">>): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    if (!graph.has(edge.to)) graph.set(edge.to, []);
    graph.get(edge.from)?.push(edge.to);
  }
  return new TarjanCycleFinder(graph).run();
}

class TarjanCycleFinder {
  private readonly graph: Map<string, string[]>;
  private readonly indexes = new Map<string, number>();
  private readonly lowlinks = new Map<string, number>();
  private readonly stack: string[] = [];
  private readonly onStack = new Set<string>();
  private readonly cycles: string[][] = [];
  private index = 0;

  constructor(graph: Map<string, string[]>) {
    this.graph = graph;
  }

  run(): string[][] {
    for (const node of [...this.graph.keys()].sort()) {
      if (!this.indexes.has(node)) this.strongConnect(node);
    }
    return this.cycles.sort((left, right) => compareCodeUnits(cycleKey(left), cycleKey(right)));
  }

  private strongConnect(node: string): void {
    this.indexes.set(node, this.index);
    this.lowlinks.set(node, this.index);
    this.index += 1;
    this.stack.push(node);
    this.onStack.add(node);

    for (const next of this.graph.get(node) ?? []) {
      if (!this.indexes.has(next)) {
        this.strongConnect(next);
        this.lowlinks.set(node, Math.min(this.lowlinks.get(node) ?? 0, this.lowlinks.get(next) ?? 0));
      } else if (this.onStack.has(next)) {
        this.lowlinks.set(node, Math.min(this.lowlinks.get(node) ?? 0, this.indexes.get(next) ?? 0));
      }
    }

    if (this.lowlinks.get(node) !== this.indexes.get(node)) return;
    this.emitComponent(node);
  }

  private emitComponent(node: string): void {
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = this.stack.pop();
      if (current === undefined) break;
      this.onStack.delete(current);
      component.push(current);
    } while (current !== node);

    const onlyNode = component[0];
    const hasSelfLoop = component.length === 1 && onlyNode !== undefined &&
      (this.graph.get(onlyNode) ?? []).includes(onlyNode);
    if (component.length > 1 || hasSelfLoop) {
      this.cycles.push(cycleWitness(this.graph, component));
    }
  }
}

/** One real directed cycle per cyclic component; this does not enumerate all cycles. */
function cycleWitness(graph: Map<string, string[]>, component: string[]): string[] {
  const members = new Set(component);
  const start = [...members].sort()[0];
  if (start === undefined) return [];
  const parents = new Map<string, string | null>([[start, null]]);
  for (const current of parents.keys()) {
    for (const next of [...new Set(graph.get(current))].sort()) {
      if (!members.has(next)) continue;
      if (next === start && (current !== start || members.size === 1)) {
        const path = [start];
        for (let node: string | null = current; node !== null; node = parents.get(node) ?? null) path.push(node);
        return path.reverse();
      }
      if (!parents.has(next)) parents.set(next, current);
    }
  }
  throw new Error("Cyclic component has no directed cycle witness");
}

export function dependencyCruiserEdges(project: { imports: ImportRecord[] }, modules: DependencyCruiserModule[]) {
  const sourceModules = new Set(project.imports.map((edge) => edge.from));
  const lineIndex = new Map<string, number>();
  const targetIndex = new Map<string, string>();
  for (const edge of project.imports) {
    lineIndex.set(`${edge.from}->${stripSourceExtension(edge.to)}`, edge.line);
    lineIndex.set(`${edge.from}->${edge.specifier}`, edge.line);
    targetIndex.set(`${edge.from}->${edge.specifier}`, edge.to);
    if (edge.specifier.startsWith("node:")) lineIndex.set(`${edge.from}->${edge.specifier.slice(5)}`, edge.line);
  }
  return modules.flatMap((module) => {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    if (!from || isTestPath(from) || !sourceModules.has(from)) return [];
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
        to: targetIndex.get(`${edge.from}->${edge.to}`) ?? edge.to,
        line: lineIndex.get(`${edge.from}->${edge.to}`) ?? null,
      }));
  });
}

export function dependencyCruiserCycles(config: Config, modules: DependencyCruiserModule[]): string[][] {
  const cycles: string[][] = [];
  for (const module of modules) {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    for (const dependency of module.dependencies ?? []) {
      const cyclePath = normalizeDependencyCruiserCycle(dependency.cycle);
      if (!cyclePath.length) continue;
      for (const cycle of [cyclePath]) {
        const files = [from, ...cycle.map((item) => stripSourceExtension(toPosix(item)))]
          .filter((file): file is string => typeof file === "string" && file.length > 0)
          .map((file) => stripProjectPrefix(config, file));
        if (files.length > 1 && files.every((file) => isMeasuredSource(config, file))) cycles.push(files);
      }
    }
  }
  // dependency-cruiser's path already returns to `from`; every rotation of one cycle must share one key.
  return dedupeBy(cycles, cycleKey);
}

export function uniqueCycleCount(...cycleSets: string[][][]): number {
  return new Set(cycleSets.flat().map(cycleKey)).size;
}

/** The members of a cycle path without the closing repetition, accepting open or closed paths. */
export function cycleMembers(cycle: string[]): string[] {
  return cycle.length > 1 && cycle[0] === cycle.at(-1) ? cycle.slice(0, -1) : cycle;
}

/** Rotation-independent identity of a directed cycle, as its least rotation closed back to its start. */
export function cycleKey(cycle: string[]): string {
  const bare = cycleMembers(cycle);
  const rotations = bare.map((_, index) => [...bare.slice(index), ...bare.slice(0, index)]);
  rotations.sort((left, right) => compareCodeUnits(left.join("\0"), right.join("\0")));
  const first = rotations[0] ?? [];
  return [...first, first[0] ?? ""].join(" -> ");
}

/** Locale-independent ordering: cycle keys become finding identities and must match on every host. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dependencyTarget(dependency: DependencyCruiserDependency): string {
  const resolved = dependency.resolved ? toPosix(dependency.resolved) : null;
  if (dependency.coreModule || dependency.npm || resolved?.includes("/node_modules/")) return dependency.module ?? resolved ?? "unknown";
  return resolved ? stripSourceExtension(resolved) : dependency.module ?? "unknown";
}

function dependencyKind(dependency: DependencyCruiserDependency) {
  const resolved = dependency.resolved ? toPosix(dependency.resolved) : null;
  if (dependency.coreModule || dependency.npm || resolved?.includes("/node_modules/")) return "external";
  return resolved ? "relative" : "unresolved";
}

function normalizeDependencyCruiserCycle(cycle: DependencyCruiserDependency["cycle"]): string[] {
  if (!cycle) return [];
  if (typeof cycle === "string") return [cycle];
  if (!Array.isArray(cycle)) return [];
  return cycle
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof item.name === "string") return item.name;
      return null;
    })
    .filter((item): item is string => typeof item === "string");
}

function isMeasuredSource(config: Config, file: string): boolean {
  const absolute = path.resolve(config.projectRoot, file);
  return config.sourceRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`));
}

function stripProjectPrefix(config: Config, value: string): string {
  const absolute = path.resolve(config.projectRoot, value);
  if (absolute.startsWith(config.projectRoot)) {
    return stripSourceExtension(toPosix(path.relative(config.projectRoot, absolute)));
  }
  return stripSourceExtension(value);
}

function stripSourceExtension(value: string): string {
  return value.replace(/\.[cm]?[jt]sx?$/, "");
}

function correctnessMap(artifact: ArtifactLookup["correctness"] | undefined): Set<string> {
  const result = new Set<string>();
  for (const test of artifact?.tests ?? []) {
    for (const file of directTestSources(test)) result.add(file);
  }
  return result;
}
