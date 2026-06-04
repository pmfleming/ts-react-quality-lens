import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { isEntrypointFile, packageEntryFiles, readPackageJson } from "../entrypoints.js";
import { analysisConfidence, artifactBase, createAnalysisContext, sourceSetHash, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Config, ModuleRecord, PackageJson, ScoredRecord } from "../types.js";

const BUILTINS = new Set([...module.builtinModules, ...module.builtinModules.map((name) => `node:${name}`)]);
const TOOL_ADAPTER_DEPENDENCIES = new Set([
  "@typescript-eslint/parser",
  "dependency-cruiser",
  "eslint",
  "eslint-plugin-react-hooks",
  "jscpd",
  "typescript",
]);

type ExternalUsage = { source: boolean; test: boolean; typeOnly: boolean };

export function measureCleanup(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const packageJson = readPackageJson(path.join(config.projectRoot, "package.json"));
  const dependencySets = dependencySetsFor(packageJson);
  const entryFiles = packageEntryFiles(config, packageJson);
  const internalInbound = new Map<string, number>();
  const importedNamesByModule = new Map<string, Set<string>>();
  const opaqueExportUsage = new Set<string>();
  const externalImports = new Map<string, ExternalUsage>();

  for (const edge of project.imports) {
    if (edge.to_kind === "relative") {
      internalInbound.set(edge.to, (internalInbound.get(edge.to) ?? 0) + 1);
      if (edge.namespace_import || edge.side_effect_import || edge.import_kind === "dynamic") {
        opaqueExportUsage.add(edge.to);
      } else {
        const names = importedNamesByModule.get(edge.to) ?? new Set<string>();
        for (const name of edge.imported_names ?? []) names.add(name);
        importedNamesByModule.set(edge.to, names);
      }
    }
    if (edge.to_kind === "external" && !BUILTINS.has(edge.specifier)) {
      const packageName = externalPackageName(edge.specifier);
      const fromIsTest = project.modules.find((moduleRecord) => moduleRecord.id === edge.from)?.sourceFile.isTest ?? false;
      markExternalUsage(externalImports, packageName, { source: !fromIsTest, test: fromIsTest, typeOnly: edge.import_kind === "type" });
    }
  }
  for (const dependency of packageObservedDependencies(config, packageJson, dependencySets.allDeclared)) {
    markExternalUsage(externalImports, dependency, { source: true, test: false, typeOnly: dependency.startsWith("@types/") });
  }

  const records: ScoredRecord[] = [
    ...unusedFileRecords(config, project.modules, internalInbound, entryFiles),
    ...unusedExportRecords(config, project.modules, internalInbound, importedNamesByModule, opaqueExportUsage, entryFiles),
    ...unusedDependencyRecords(dependencySets.allDeclared, externalImports),
    ...unlistedDependencyRecords(dependencySets.allDeclared, externalImports),
    ...typeOnlyProductionDependencyRecords(dependencySets.dependencies, externalImports),
    ...testOnlyProductionDependencyRecords(dependencySets.dependencies, externalImports),
    ...duplicateExportRecords(project.modules),
  ];

  const artifact = {
    ...artifactBase(config, "quality.cleanup", command, analysisConfidence(config, project), sourceSetHash(project)),
    summary: {
      records: records.length,
      unused_files: records.filter((record) => record.kind === "unused_file").length,
      unused_exports: records.filter((record) => record.kind === "unused_export").length,
      unused_dependencies: records.filter((record) => record.kind === "unused_dependency").length,
      unlisted_dependencies: records.filter((record) => record.kind === "unlisted_dependency").length,
      type_only_production_dependencies: records.filter((record) => record.kind === "type_only_production_dependency").length,
      test_only_production_dependencies: records.filter((record) => record.kind === "test_only_production_dependency").length,
      duplicate_exports: records.filter((record) => record.kind === "duplicate_export").length,
      entrypoint_files: entryFiles.size,
    },
    records,
  };
  writeArtifact(config, "cleanup.json", artifact);
  return artifact;
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
): ScoredRecord[] {
  return modules.flatMap((moduleRecord) => {
    if (isEntryLike(moduleRecord, entryFiles) || opaqueExportUsage.has(moduleRecord.id) || isPublicApiFile(config, moduleRecord.file)) return [];
    const inboundCount = inbound.get(moduleRecord.id) ?? 0;
    const importedNames = importedNamesByModule.get(moduleRecord.id) ?? new Set<string>();
    return moduleRecord.exports.flatMap((exportRecord) => {
      const unused =
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

function unusedDependencyRecords(
  declared: Set<string>,
  imports: Map<string, ExternalUsage>,
): ScoredRecord[] {
  return [...declared]
    .filter((dependency) => !imports.has(dependency))
    .map((dependency) => dependencyRecord("unused_dependency", dependency, 55, "medium", "declared_but_not_observed"));
}

function unlistedDependencyRecords(
  declared: Set<string>,
  imports: Map<string, ExternalUsage>,
): ScoredRecord[] {
  return [...imports]
    .filter(([dependency]) => !declared.has(dependency))
    .map(([dependency]) => dependencyRecord("unlisted_dependency", dependency, 75, "high", "observed_but_not_declared"));
}

function typeOnlyProductionDependencyRecords(
  dependencies: Set<string>,
  imports: Map<string, ExternalUsage>,
): ScoredRecord[] {
  return [...imports]
    .filter(([dependency, usage]) => dependencies.has(dependency) && usage.typeOnly)
    .map(([dependency]) => dependencyRecord("type_only_production_dependency", dependency, 35, "medium", "only_type_usage_observed"));
}

function testOnlyProductionDependencyRecords(
  dependencies: Set<string>,
  imports: Map<string, ExternalUsage>,
): ScoredRecord[] {
  return [...imports]
    .filter(([dependency, usage]) => dependencies.has(dependency) && usage.test && !usage.source)
    .map(([dependency]) => dependencyRecord("test_only_production_dependency", dependency, 45, "medium", "only_test_usage_observed"));
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
    name: dependency,
    score,
    risk,
    signals: [{ kind: signalKind, value: dependency }],
  };
}

function duplicateExportRecords(modules: Array<{ id: string; file: string; exports: Array<{ name: string; line: number }> }>): ScoredRecord[] {
  const byName = new Map<string, Array<{ id: string; file: string; line: number }>>();
  for (const moduleRecord of modules) {
    for (const exportRecord of moduleRecord.exports) {
      const group = byName.get(exportRecord.name) ?? [];
      group.push({ id: moduleRecord.id, file: moduleRecord.file, line: exportRecord.line });
      byName.set(exportRecord.name, group);
    }
  }
  return [...byName.entries()].flatMap(([name, exports]) =>
    exports.length > 1
      ? exports.map((exportRecord) => ({
          id: `cleanup:duplicate-export:${name}:${exportRecord.id}`,
          kind: "duplicate_export",
          file: exportRecord.file,
          line: exportRecord.line,
          name,
          score: 40,
          risk: "medium",
          signals: [{ kind: "same_export_name_in_multiple_modules", value: exports.length }],
        }))
      : [],
  );
}

function dependencySetsFor(packageJson: PackageJson | null) {
  const dependencies = new Set(Object.keys(packageJson?.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(packageJson?.devDependencies ?? {}));
  const peerDependencies = new Set(Object.keys(packageJson?.peerDependencies ?? {}));
  const optionalDependencies = new Set(Object.keys(packageJson?.optionalDependencies ?? {}));
  return {
    dependencies,
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

function externalPackageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function packageObservedDependencies(config: Config, packageJson: PackageJson | null, declared: Set<string>): Set<string> {
  return new Set([
    ...scriptDependencyNames(packageJson?.scripts),
    ...workspaceTypeDependencies(config),
    ...[...TOOL_ADAPTER_DEPENDENCIES].filter((dependency) => declared.has(dependency)),
  ]);
}

function scriptDependencyNames(scripts: PackageJson["scripts"]): string[] {
  const text = Object.values(scripts ?? {}).join(" ");
  const toolNames = new Map([
    ["depcruise", "dependency-cruiser"],
    ["dependency-cruiser", "dependency-cruiser"],
    ["eslint", "eslint"],
    ["jscpd", "jscpd"],
    ["tsc", "typescript"],
    ["tsserver", "typescript"],
  ]);
  return [...toolNames.entries()].flatMap(([command, dependency]) =>
    commandAppearsInScript(text, command) ? [dependency] : [],
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
