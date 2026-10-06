import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import * as ts from "typescript";
import { isRecord, parseJson } from "../collections.js";
import { analyzeModule } from "../extract.js";
import { isEntrypointFile, packageEntryFiles, readPackageJson } from "../entrypoints.js";
import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import { workspacePackageName } from "../workspaces.js";
import type { AnalysisContext, Config, KnipResult, ModuleRecord, PackageJson, ProjectAnalysis, ScoredRecord } from "../types.js";

const BUILTINS = new Set([...module.builtinModules, ...module.builtinModules.map((name) => `node:${name}`)]);
const TOOL_ADAPTER_DEPENDENCIES = new Set([
  "@arethetypeswrong/cli",
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "dependency-cruiser",
  "eslint",
  "eslint-plugin-jsx-a11y",
  "eslint-plugin-react-hooks",
  "jscpd",
  "knip",
  "publint",
  "typescript",
]);

type ExternalUsage = { source: boolean; test: boolean; typeOnly: boolean };
type CleanupUsage = {
  internalInbound: Map<string, number>;
  importedNamesByModule: Map<string, Set<string>>;
  opaqueExportUsage: Set<string>;
  externalImports: Map<string, ExternalUsage>;
};

export function measureCleanup(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const knip = context.knip();
  const packageJson = readPackageJson(path.join(config.projectRoot, "package.json"));
  const dependencySets = dependencySetsFor(packageJson);
  const entryFiles = packageEntryFiles(config, packageJson);
  const { internalInbound, importedNamesByModule, opaqueExportUsage, externalImports } = cleanupUsage(
    config,
    project,
    packageJson,
    dependencySets.allDeclared,
  );

  const builtInRecords: ScoredRecord[] = [
    ...unusedFileRecords(config, project.modules, internalInbound, entryFiles),
    ...unusedExportRecords(
      config,
      project.modules,
      internalInbound,
      importedNamesByModule,
      opaqueExportUsage,
      entryFiles,
      declarationSurfaceTypeReferences(project.modules),
    ),
    ...dependencyHygieneRecords(dependencySets, externalImports),
    ...conflictingPublicExportRecords(project.modules, entryFiles),
  ];
  const knipRecords = normalizeKnipRecords(knip.issues);
  const reconciliation = reconcileCleanupRecords(builtInRecords, knipRecords, knip);
  const records = reconciliation.records;

  const artifact = {
    ...artifactBase(config, "quality.cleanup", command, analysisConfidence(config, project, {
      knip_available: knip.available,
      knip_ran: knip.ran,
      knip_complete: knip.complete,
    }), sourceSetHash(project)),
    summary: {
      records: records.length,
      unused_files: records.filter((record) => record.kind === "unused_file").length,
      unused_exports: records.filter((record) => record.kind === "unused_export").length,
      unused_dependencies: records.filter((record) => record.kind === "unused_dependency").length,
      unused_dev_dependencies: records.filter((record) => record.kind === "unused_dev_dependency").length,
      unlisted_dependencies: records.filter((record) => record.kind === "unlisted_dependency").length,
      type_only_production_dependencies: records.filter((record) => record.kind === "type_only_production_dependency").length,
      test_only_production_dependencies: records.filter((record) => record.kind === "test_only_production_dependency").length,
      duplicate_exports: records.filter((record) => record.kind === "duplicate_export").length,
      entrypoint_files: entryFiles.size,
      knip_findings: records.filter((record) => record.source === "knip").length,
      tool_confirmed: records.filter((record) => record.tool_validation === "confirmed").length,
      tool_disagreed: reconciliation.disagreements.length,
      tool_not_comparable: reconciliation.unconfirmed.filter((record) => record.tool_validation === "not_comparable").length,
      tool_excluded: reconciliation.unconfirmed.filter((record) => record.tool_validation === "excluded_by_tool").length,
    },
    tool_status: {
      knip: {
        available: knip.available,
        ran: knip.ran,
        complete: knip.complete,
        reason: knip.reason,
        version: knip.version,
        production: config.cleanup.production,
        excluded_dependencies: knip.excluded_dependencies,
        exclusions_complete: knip.exclusions_complete,
      },
    },
    engine_relationships: [{ capability: "cleanup", producers: ["ts-react-quality-lens-cleanup", "knip"],
      mode: "reconciled", scope: "Exact file/name subjects; Knip silence supplies no evaluated negative",
      selected_files: project.sourceFiles.map((file) => file.relativePath), exclusions: config.exclude,
      excluded_dependencies: knip.excluded_dependencies, exclusions_complete: knip.exclusions_complete,
      producer_version: knip.version, external_complete: knip.complete }],
    disagreements: reconciliation.disagreements,
    unconfirmed: reconciliation.unconfirmed,
    records,
  };
  return writeArtifact(config, "cleanup.json", artifact);
}

const KNIP_KIND_BY_TYPE: Record<string, string> = {
  files: "unused_file",
  dependencies: "unused_dependency",
  devDependencies: "unused_dev_dependency",
  optionalPeerDependencies: "unused_optional_peer_dependency",
  unlisted: "unlisted_dependency",
  binaries: "unlisted_binary",
  unresolved: "unresolved_import",
  exports: "unused_export",
  nsExports: "unused_namespace_export",
  types: "unused_type",
  nsTypes: "unused_namespace_type",
  enumMembers: "unused_enum_member",
  namespaceMembers: "unused_namespace_member",
  duplicates: "duplicate_export",
  catalog: "unused_catalog_entry",
  catalogReferences: "unused_catalog_reference",
  cycles: "dependency_cycle",
};

function normalizeKnipRecords(issues: ReturnType<AnalysisContext["knip"]>["issues"]): ScoredRecord[] {
  return issues.flatMap((entry) => Object.entries(KNIP_KIND_BY_TYPE).flatMap(([issueType, kind]) => {
    const items = flattenKnipItems(entry[issueType]);
    return items.map((item, index): ScoredRecord => {
      const file = issueType === "files" ? item.name : entry.file;
      const name = issueType === "files" ? null : item.name;
      return {
        id: `knip:${issueType}:${file}:${name ?? index}:${item.line ?? 0}`,
        rule_id: `knip/${issueType}`,
        kind,
        evidence_kind: "tool-rule",
        disposition: ["unlisted_dependency", "unresolved_import"].includes(kind) ? "warn" : "review",
        finding_confidence: "high",
        scope: file === "package.json" ? "project" : "file",
        ...(file ? { file } : {}),
        ...(name ? { name } : {}),
        ...(item.line !== undefined ? { line: item.line } : {}),
        ...(item.col !== undefined ? { column: item.col } : {}),
        score: ["unlisted_dependency", "unresolved_import"].includes(kind) ? 75 : 50,
        risk: ["unlisted_dependency", "unresolved_import"].includes(kind) ? "high" : "medium",
        source: "knip",
        message: `Knip reported ${kind.replaceAll("_", " ")}${name ? `: ${name}` : ""}.`,
        issue_type: issueType,
        signals: [{ kind: `knip_${issueType}`, ...(name ? { value: name } : {}) }],
      };
    });
  }));
}

function flattenKnipItems(value: unknown): Array<{ name: string; line?: number; col?: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<{ name: string; line?: number; col?: number }> => {
    if (Array.isArray(item)) return flattenKnipItems(item);
    if (!isRecord(item) || typeof item.name !== "string") return [];
    return [{
      name: item.name,
      ...(typeof item.line === "number" ? { line: item.line } : {}),
      ...(typeof item.col === "number" ? { col: item.col } : {}),
    }];
  });
}

type CleanupReconciliation = {
  records: ScoredRecord[];
  disagreements: ScoredRecord[];
  unconfirmed: ScoredRecord[];
};

const KNIP_COMPARABLE_KINDS = new Set([
  "unused_file",
  "unused_export",
  "unused_dependency",
  "unused_dev_dependency",
  "unlisted_dependency",
  "duplicate_export",
]);

export function reconcileCleanupRecords(builtIn: ScoredRecord[], knipRecords: ScoredRecord[], knip: KnipResult): CleanupReconciliation {
  const matchedKnipIds = new Set<string>();
  const result: CleanupReconciliation = { records: [], disagreements: [], unconfirmed: [] };
  for (const record of builtIn) {
    const match = knipRecords.find((candidate) => cleanupRecordsMatch(record, candidate));
    if (match && knip.complete && knip.version && !dependencyExcludedByKnip(record, knip.excluded_dependencies) && record.validation_scope_complete !== false) {
      matchedKnipIds.add(match.id);
      result.records.push(confirmedCleanupRecord(record, match));
      continue;
    }
    const validation = cleanupValidation(record, knip);
    const candidate: ScoredRecord = {
      ...record,
      evidence_kind: "heuristic",
      disposition: "review",
      finding_confidence: validation === "unavailable" ? "medium" : "low",
      source: "ts-react-quality-lens-cleanup",
      tool_validation: validation,
      validation_scope: validationScope(record),
      reconciliation_reason: validation === "not_comparable" ? "No explicit same-scope evaluated negative was supplied by Knip; silence is not disagreement."
        : validation === "excluded_by_tool" ? "Dependency is explicitly excluded by Knip." : "Knip completion/version/scope prerequisites are unavailable.",
      ...(match ? { candidate_observation: match } : {}),
    };
    if (validation === "unavailable") result.records.push(candidate);
    else if (validation === "disagreed") result.disagreements.push(candidate);
    else result.unconfirmed.push(candidate);
  }
  result.records.push(...knipRecords.filter((record) => !matchedKnipIds.has(record.id)));
  return result;
}

function confirmedCleanupRecord(record: ScoredRecord, match: ScoredRecord): ScoredRecord {
  return {
    ...record,
    rule_id: match.rule_id ?? "knip/unknown",
    evidence_kind: "tool-rule",
    disposition: match.disposition ?? "review",
    finding_confidence: "high",
    source: "knip",
    upstream_finding_id: match.id,
    supporting_observations: [record, match],
    reconciliation_limitation: "Agreement on the exact bounded unused-subject claim; not independent proof of safe removal or runtime reachability.",
    corroborating_producers: ["ts-react-quality-lens-cleanup", "knip"],
    tool_validation: "confirmed",
    validation_scope: validationScope(record),
  };
}

function cleanupValidation(record: ScoredRecord, knip: KnipResult): "disagreed" | "not_comparable" | "excluded_by_tool" | "unavailable" {
  if (!knip.complete || !knip.version) return "unavailable";
  if (dependencyExcludedByKnip(record, knip.excluded_dependencies)) return "excluded_by_tool";
  if (record.validation_scope_complete === false || isDependencyRecord(record) && !knip.exclusions_complete) return "not_comparable";
  return "not_comparable";
}

function isDependencyRecord(record: ScoredRecord): boolean {
  return typeof record.kind === "string" && record.kind.includes("dependency");
}

function dependencyExcludedByKnip(record: ScoredRecord, patterns: string[]): boolean {
  const name = record.name;
  if (typeof name !== "string" || !isDependencyRecord(record)) return false;
  return patterns.some((pattern) => globMatch(name, pattern));
}

function validationScope(record: ScoredRecord): string {
  return typeof record.kind === "string" && KNIP_COMPARABLE_KINDS.has(record.kind)
    ? `knip/${record.kind}`
    : "ts-react-quality-lens-only";
}

function cleanupRecordsMatch(left: ScoredRecord, right: ScoredRecord): boolean {
  if (!cleanupKindsMatch(left.kind, right.kind)) return false;
  if (isDependencyRecord(left)) return typeof left.name === "string" && left.name === right.name &&
    typeof left.file === "string" && left.file === right.file;
  if (typeof left.file !== "string" || left.file !== right.file) return false;
  return left.kind === "unused_file" || typeof left.name === "string" && left.name === right.name;
}

function cleanupKindsMatch(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return left === "unused_export" && right === "unused_type" || left === "unused_type" && right === "unused_export";
}

function cleanupUsage(
  config: Config,
  project: ProjectAnalysis,
  packageJson: PackageJson | null,
  declared: Set<string>,
): CleanupUsage {
  const usage: CleanupUsage = {
    internalInbound: new Map(),
    importedNamesByModule: new Map(),
    opaqueExportUsage: new Set(),
    externalImports: new Map(),
  };
  const sourcePaths = new Set(project.sourceFiles.map((file) => file.path));
  const testModules = project.testFiles
    .filter((file) => !sourcePaths.has(file.path))
    .map((file) => analyzeModule(config, file, project.tsProject));
  const usageModules = [...project.modules, ...testModules];
  for (const edge of usageModules.flatMap((moduleRecord) => moduleRecord.imports)) collectImportUsage(usageModules, usage, edge);
  for (const dependency of packageObservedDependencies(config, packageJson, declared)) {
    markExternalUsage(usage.externalImports, dependency, {
      source: true,
      test: false,
      typeOnly: dependency.startsWith("@types/"),
    });
  }
  return usage;
}

function collectImportUsage(modules: ModuleRecord[], usage: CleanupUsage, edge: ProjectAnalysis["imports"][number]): void {
  if (edge.to_kind === "relative") {
    usage.internalInbound.set(edge.to, (usage.internalInbound.get(edge.to) ?? 0) + 1);
    if (edge.namespace_import || edge.side_effect_import || edge.import_kind === "dynamic") usage.opaqueExportUsage.add(edge.to);
    else addImportedNames(usage.importedNamesByModule, edge.to, edge.imported_names ?? []);
  }
  if (edge.to_kind !== "external" || BUILTINS.has(edge.specifier)) return;
  const packageName = workspacePackageName(edge.specifier);
  const fromIsTest = modules.find((moduleRecord) => moduleRecord.id === edge.from)?.sourceFile.isTest ?? false;
  markExternalUsage(usage.externalImports, packageName, {
    source: !fromIsTest,
    test: fromIsTest,
    typeOnly: edge.import_kind === "type",
  });
}

function addImportedNames(imports: Map<string, Set<string>>, moduleId: string, importedNames: string[]): void {
  const names = imports.get(moduleId) ?? new Set<string>();
  for (const name of importedNames) names.add(name);
  imports.set(moduleId, names);
}

function unusedFileRecords(
  config: Config,
  modules: ModuleRecord[],
  inbound: Map<string, number>,
  entryFiles: Set<string>,
): ScoredRecord[] {
  return modules
    .filter((moduleRecord) =>
      !moduleRecord.sourceFile.isTest &&
      (inbound.get(moduleRecord.id) ?? 0) === 0 &&
      !isEntryLike(moduleRecord, entryFiles) &&
      !isPublicApiFile(config, moduleRecord.file),
    )
    .map((moduleRecord) => ({
      id: `cleanup:unused-file:${moduleRecord.id}`,
      kind: "unused_file",
      file: moduleRecord.file,
      score: 60,
      risk: "medium",
      signals: [{ kind: "no_internal_importers" }, { kind: "exports", value: moduleRecord.exports.length }],
    }));
}

function unusedExportRecords(
  config: Config,
  modules: ModuleRecord[],
  inbound: Map<string, number>,
  importedNamesByModule: Map<string, Set<string>>,
  opaqueExportUsage: Set<string>,
  entryFiles: Set<string>,
  declarationSurfaceReferences: Map<string, Set<string>>,
): ScoredRecord[] {
  return modules.flatMap((moduleRecord) => {
    if (isEntryLike(moduleRecord, entryFiles) || opaqueExportUsage.has(moduleRecord.id) || isPublicApiFile(config, moduleRecord.file)) return [];
    const inboundCount = inbound.get(moduleRecord.id) ?? 0;
    const importedNames = importedNamesByModule.get(moduleRecord.id) ?? new Set<string>();
    const surfaceReferences = declarationSurfaceReferences.get(moduleRecord.id) ?? new Set<string>();
    return moduleRecord.exports.flatMap((exportRecord) => {
      const unused =
        !surfaceReferences.has(exportRecord.name) &&
        !isPublicApiExport(config, moduleRecord.file, exportRecord.name) &&
        (inboundCount === 0 || (importedNames.size > 0 && !importedNames.has(exportRecord.name)));
      if (!unused) return [];
      return [{
        id: `cleanup:unused-export:${moduleRecord.id}:${exportRecord.name}`,
        kind: "unused_export",
        file: moduleRecord.file,
        line: exportRecord.line,
        name: exportRecord.name,
        score: 45,
        risk: "medium",
        signals: [
          inboundCount === 0
            ? { kind: "module_has_no_internal_importers" }
            : { kind: "export_not_named_by_internal_imports", value: exportRecord.name },
        ],
      }];
    });
  });
}

function dependencyHygieneRecords(
  sets: ReturnType<typeof dependencySetsFor>,
  imports: Map<string, ExternalUsage>,
): ScoredRecord[] {
  const imported = [...imports];
  return [
    ...[...sets.allDeclared]
      .filter((dependency) => !imports.has(dependency))
      .map((dependency) => sets.devDependencies.has(dependency)
        ? { ...dependencyRecord("unused_dev_dependency", dependency, 45, "medium", "dev_dependency_not_observed"), validation_scope_complete: false }
        : dependencyRecord("unused_dependency", dependency, 55, "medium", "declared_but_not_observed")),
    ...imported
      .filter(([dependency]) => !sets.allDeclared.has(dependency))
      .map(([dependency]) => dependencyRecord("unlisted_dependency", dependency, 75, "high", "observed_but_not_declared")),
    ...imported
      .filter(([dependency, usage]) => sets.dependencies.has(dependency) && usage.typeOnly)
      .map(([dependency]) => dependencyRecord("type_only_production_dependency", dependency, 35, "medium", "only_type_usage_observed")),
    ...imported
      .filter(([dependency, usage]) => sets.dependencies.has(dependency) && usage.test && !usage.source)
      .map(([dependency]) => dependencyRecord("test_only_production_dependency", dependency, 45, "medium", "only_test_usage_observed")),
  ];
}

function dependencyRecord(
  kind: string,
  dependency: string,
  score: number,
  risk: string,
  signalKind: string,
): ScoredRecord {
  return {
    id: `cleanup:${kind.replaceAll("_", "-")}:${dependency}`,
    kind,
    file: "package.json",
    name: dependency,
    score,
    risk,
    signals: [{ kind: signalKind, value: dependency }],
  };
}

function declarationSurfaceTypeReferences(modules: ModuleRecord[]): Map<string, Set<string>> {
  return new Map(modules.map((moduleRecord) => [
    moduleRecord.id,
    new Set(moduleRecord.typed?.surface_type_references ?? []),
  ]));
}

type ExportOrigins = Map<string, Set<string>>;

function conflictingPublicExportRecords(modules: ModuleRecord[], entryFiles: Set<string>): ScoredRecord[] {
  const exports = new PublicExports(modules);
  return modules
    .filter((moduleRecord) => entryFiles.has(moduleRecord.file))
    .flatMap((moduleRecord) => [...exports.origins(moduleRecord).entries()].flatMap(([name, origins]) =>
      origins.size > 1 ? [conflictingExportRecord(moduleRecord, name, origins)] : [],
    ));
}

class PublicExports {
  private readonly modules: Map<string, ModuleRecord>;
  private readonly memo = new Map<string, ExportOrigins>();
  constructor(modules: ModuleRecord[]) {
    this.modules = new Map(modules.map((module) => [module.id, module]));
  }
  origins(module: ModuleRecord, visiting = new Set<string>()): ExportOrigins {
    const cached = this.memo.get(module.id);
    if (cached) return cached;
    if (visiting.has(module.id)) return new Map();
    const next = new Set(visiting).add(module.id), origins: ExportOrigins = new Map();
    const source = moduleSourceFile(module);
    for (const exported of module.exports) {
      const declaration = exportDeclarationAtLine(source, exported.line);
      const values = declaration?.moduleSpecifier && ts.isStringLiteral(declaration.moduleSpecifier)
        ? this.resolve(module, exported, declaration, next) : [`${module.id}:${exported.name}`];
      for (const value of values) addExportOrigin(origins, exported.name, value);
    }
    this.addWildcards(module, source, origins, next);
    this.memo.set(module.id, origins);
    return origins;
  }
  private resolve(module: ModuleRecord, exported: ModuleRecord["exports"][number], declaration: ts.ExportDeclaration, visiting: Set<string>): Iterable<string> {
    const element = declaration.exportClause && ts.isNamedExports(declaration.exportClause)
      ? declaration.exportClause.elements.find((candidate) => candidate.name.text === exported.name) : undefined;
    const name = element?.propertyName?.text ?? element?.name.text ?? exported.name;
    const target = relativeExportTarget(module, exported.line, this.modules);
    const resolved = target ? this.origins(target, visiting).get(name) : undefined;
    return resolved?.size ? resolved : [`${target?.id ?? "unresolved"}:${name}`];
  }
  private addWildcards(module: ModuleRecord, source: ts.SourceFile, origins: ExportOrigins, visiting: Set<string>): void {
    for (const declaration of source.statements.filter(ts.isExportDeclaration)) {
      if (declaration.exportClause || !declaration.moduleSpecifier) continue;
      const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
      const target = relativeExportTarget(module, line, this.modules);
      if (!target) continue;
      for (const [name, values] of this.origins(target, visiting)) {
        for (const value of values) addExportOrigin(origins, name, value);
      }
    }
  }
}

function relativeExportTarget(
  moduleRecord: ModuleRecord,
  line: number,
  modules: Map<string, ModuleRecord>,
): ModuleRecord | null {
  const edge = moduleRecord.imports.find((candidate) => candidate.line === line && candidate.to_kind === "relative");
  return edge ? modules.get(edge.to) ?? null : null;
}

function exportDeclarationAtLine(sourceFile: ts.SourceFile, line: number): ts.ExportDeclaration | null {
  const statement = sourceFile.statements.find((candidate) =>
    ts.isExportDeclaration(candidate) && sourceFile.getLineAndCharacterOfPosition(candidate.getStart(sourceFile)).line + 1 === line,
  );
  return statement && ts.isExportDeclaration(statement) ? statement : null;
}

function moduleSourceFile(moduleRecord: ModuleRecord): ts.SourceFile {
  return moduleRecord.astSourceFile ?? ts.createSourceFile(moduleRecord.file, moduleRecord.text, ts.ScriptTarget.Latest, true);
}

function addExportOrigin(origins: ExportOrigins, name: string, origin: string): void {
  const values = origins.get(name) ?? new Set<string>();
  values.add(origin);
  origins.set(name, values);
}

function conflictingExportRecord(moduleRecord: ModuleRecord, name: string, origins: Set<string>): ScoredRecord {
  return {
    id: `cleanup:duplicate-export:${moduleRecord.id}:${name}`,
    kind: "duplicate_export",
    file: moduleRecord.file,
    name,
    score: 40,
    risk: "medium",
    message: `Public export ${name} resolves to multiple declarations in ${moduleRecord.file}.`,
    signals: [...origins].sort().map((origin) => ({ kind: "conflicting_export_origin", value: origin })),
  };
}

function dependencySetsFor(packageJson: PackageJson | null) {
  const dependencies = new Set(Object.keys(packageJson?.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(packageJson?.devDependencies ?? {}));
  const peerDependencies = new Set(Object.keys(packageJson?.peerDependencies ?? {}));
  const optionalDependencies = new Set(Object.keys(packageJson?.optionalDependencies ?? {}));
  return {
    dependencies,
    devDependencies,
    allDeclared: new Set([...dependencies, ...devDependencies, ...peerDependencies, ...optionalDependencies]),
  };
}

function markExternalUsage(imports: Map<string, ExternalUsage>, dependency: string, usage: ExternalUsage): void {
  const previous = imports.get(dependency) ?? { source: false, test: false, typeOnly: true };
  imports.set(dependency, {
    source: previous.source || usage.source,
    test: previous.test || usage.test,
    typeOnly: previous.typeOnly && usage.typeOnly,
  });
}

function packageObservedDependencies(config: Config, packageJson: PackageJson | null, declared: Set<string>): Set<string> {
  return new Set([
    ...scriptDependencyNames(config.projectRoot, packageJson?.scripts, declared),
    ...configurationDependencyNames(config.projectRoot, declared),
    ...workspaceTypeDependencies(config),
    ...[...TOOL_ADAPTER_DEPENDENCIES].filter((dependency) => declared.has(dependency)),
  ]);
}

function configurationDependencyNames(root: string, declared: Set<string>): string[] {
  const rootConfigs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?:config\.[cm]?[jt]s|rc(?:\.[^.]+)?|\.config\.[cm]?[jt]s)$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
  const nativeManifests = [
    path.join(root, "android", "settings.gradle"),
    path.join(root, "android", "capacitor.settings.gradle"),
    path.join(root, "ios", "App", "Podfile"),
  ];
  const evidence = [...rootConfigs, ...nativeManifests]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  return [...declared].filter((dependency) => evidence.includes(dependency));
}

function scriptDependencyNames(root: string, scripts: PackageJson["scripts"], declared: Set<string>): string[] {
  const text = Object.values(scripts ?? {}).join(" ");
  const owners = declaredBinaryOwners(root, declared);
  const observed = new Set<string>();
  for (const [command, dependencies] of owners) {
    if (commandAppearsInScript(text, command)) for (const dependency of dependencies) observed.add(dependency);
  }
  const fallbackCommands = new Map([
    ["depcruise", "dependency-cruiser"],
    ["dependency-cruiser", "dependency-cruiser"],
    ["eslint", "eslint"],
    ["jscpd", "jscpd"],
    ["knip", "knip"],
    ["tsc", "typescript"],
    ["tsserver", "typescript"],
  ]);
  for (const [command, dependency] of fallbackCommands) {
    if (!owners.has(command) && declared.has(dependency) && commandAppearsInScript(text, command)) observed.add(dependency);
  }
  return [...observed];
}

function declaredBinaryOwners(root: string, declared: Set<string>): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  const lockPackages = packageLockPackages(root);
  for (const dependency of declared) {
    const installed = readPackageJson(path.join(root, "node_modules", dependency, "package.json"));
    const locked = lockPackages.get(`node_modules/${dependency}`);
    const manifest = installed ?? locked;
    if (!manifest) continue;
    for (const command of packageBinCommands(manifest, dependency)) {
      const dependencies = owners.get(command) ?? new Set<string>();
      dependencies.add(dependency);
      owners.set(command, dependencies);
    }
  }
  return owners;
}

function packageLockPackages(root: string): Map<string, PackageJson> {
  const lock = readJsonRecord(path.join(root, "package-lock.json"));
  const packages = lock?.packages;
  if (!isRecord(packages)) return new Map();
  return new Map(Object.entries(packages).flatMap(([name, value]): Array<[string, PackageJson]> =>
    isRecord(value) ? [[name, value]] : [],
  ));
}

function packageBinCommands(manifest: PackageJson, declaredName: string): string[] {
  if (typeof manifest.bin === "string") return [unscopedPackageName(manifest.name ?? declaredName)];
  return Object.keys(manifest.bin ?? {});
}

function unscopedPackageName(name: string): string {
  return name.split("/").at(-1) ?? name;
}

function commandAppearsInScript(text: string, command: string): boolean {
  return new RegExp(`(?:^|\\s|&&|\\|\\||;)${escapeRegExp(command)}(?:\\s|$)`).test(text);
}

function tsconfigTypeDependencies(tsconfig: string | null): string[] {
  if (!tsconfig || !fs.existsSync(tsconfig)) return [];
  const compilerOptions = readJsonRecord(tsconfig)?.compilerOptions;
  if (!isRecord(compilerOptions) || !Array.isArray(compilerOptions.types)) return [];
  return compilerOptions.types
    .filter((name): name is string => typeof name === "string")
    .map((name) => `@types/${name}`);
}

function workspaceTypeDependencies(config: Config): string[] {
  return [...new Set([config.tsconfig, ...findTsconfigs(config.projectRoot)].flatMap(tsconfigTypeDependencies))];
}

function findTsconfigs(root: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  collectTsconfigs(root, result);
  return result;
}

function collectTsconfigs(root: string, result: string[]): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "target", "coverage"].includes(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) collectTsconfigs(fullPath, result);
    if (entry.isFile() && entry.name === "tsconfig.json") result.push(fullPath);
  }
}

function isEntryLike(moduleRecord: ModuleRecord, entryFiles: Set<string>): boolean {
  const file = moduleRecord.file;
  return isEntrypointFile(moduleRecord, entryFiles) ||
    /(?:^|\/)(?:index|main|app|page|layout|route)\.[cm]?[jt]sx?$/.test(file) ||
    /(?:^|\/)(?:pages|app|routes)\//.test(file);
}

function isPublicApiFile(config: Config, file: string): boolean {
  return config.publicApi.entry.some((pattern) => globMatch(file, pattern));
}

function isPublicApiExport(config: Config, file: string, name: string): boolean {
  return config.publicApi.exports.some((rule) => globMatch(file, rule.file) && rule.names.includes(name));
}

function globMatch(file: string, pattern: string): boolean {
  if (!pattern.includes("*")) return file === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(file);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    const parsed = parseJson(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
