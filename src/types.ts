import type * as ts from "typescript";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RiskLevel = "low" | "medium" | "high";
export type Severity = RiskLevel;
export type ImportKind = "static" | "dynamic" | "type";
type ImportTargetKind = "external" | "relative" | "unresolved";

export type RawConfig = {
  $schema?: string;
  project_name?: string;
  project_root?: string;
  source_roots?: string[];
  test_roots?: string[];
  output_dir?: string;
  tsconfig?: string;
  package_manager?: string;
  framework?: string;
  test_runner?: string;
  test_command?: string | null;
  exclude?: string[];
  layer_rules?: LayerRule[];
  performance_inputs?: PerformanceInputConfig;
  public_api?: PublicApiConfig;
  cache?: CacheConfig;
  suppressions?: SuppressionConfig[];
  audit?: AuditConfig;
};

export type PublicApiConfig = {
  entry?: string[];
  exports?: Array<{ file: string; names: string[] }>;
};

type CacheConfig = {
  enabled?: boolean;
};

export type SuppressionConfig = {
  id?: string;
  file?: string;
  kind?: string;
  reason?: string;
};

export type AuditConfig = {
  base?: string;
  changed_since?: string;
  gate?: "new-only" | "all";
  baseline?: string;
};

export type LayerRule = {
  layer: string;
  patterns: string[];
};

export type PerformanceInputConfig = {
  bundle_stats?: string;
  render_costs?: string;
};

export type PathAliasRule = {
  pattern: string;
  replacements: string[];
};

export type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type EntryPointRole =
  | "cli_bin"
  | "npm_script"
  | "package_export"
  | "package_main"
  | "package_module"
  | "package_types"
  | "configured_public_api";

export type EntryPointReference = {
  file: string;
  role: EntryPointRole;
  source: string;
};

export type PackageManagerDetection = {
  name: string;
  detected: boolean;
};

export type Config = {
  configPath: string;
  configDir: string;
  projectName: string;
  projectRoot: string;
  sourceRoots: string[];
  testRoots: string[];
  outputDir: string;
  tsconfig: string | null;
  packageManager: string;
  packageManagerDetected: boolean;
  framework: string;
  testRunner: string;
  testCommand: string | null;
  exclude: string[];
  layerRules: LayerRule[];
  performanceInputs: {
    bundleStats: string | null;
    renderCosts: string | null;
  };
  publicApi: {
    entry: string[];
    exports: Array<{ file: string; names: string[] }>;
  };
  cache: {
    enabled: boolean;
    dir: string;
  };
  suppressions: SuppressionConfig[];
  audit: {
    base: string | null;
    changedSince: string | null;
    gate: "new-only" | "all";
    baseline: string | null;
  };
  pathAliases: PathAliasRule[];
  raw: RawConfig;
};

export type ConfidenceSignal = {
  kind: string;
  file?: string;
  line?: number | null;
  message?: string;
};

export type Confidence = Record<string, JsonValue> & {
  complete?: boolean;
  partial?: boolean;
  confidence_scope?: string;
  required_inputs?: string[];
  observed_inputs?: string[];
  missing_input?: string[];
  stale_input?: string[];
  unsupported_pattern?: ConfidenceSignal[];
};

export type SourceFileRecord = {
  path: string;
  relativePath: string;
  text: string;
  lines: string[];
  extension: string;
  isTest: boolean;
};

export type ImportRecord = {
  from: string;
  to: string;
  to_kind: ImportTargetKind;
  resolved: string | null;
  specifier: string;
  import_kind: ImportKind;
  imported_names?: string[];
  namespace_import?: boolean;
  side_effect_import?: boolean;
  line: number;
  source: string;
};

export type FunctionRecord = {
  id: string;
  name: string;
  kind: "component" | "hook" | "reducer" | "function";
  line: number;
  lines: number;
  complexity: number;
  nesting_depth: number;
  jsx_density: number;
  hooks: number;
  effects: number;
  jsxConditionals: number;
};

export type TypeRecord = {
  name: string;
  kind: "interface" | "type" | "class";
  exported: boolean;
  line: number;
  field_count: number;
  optional_count: number;
  union_members: number;
  generic_params: number;
  body: string;
};

export type ExportRecord = {
  name: string;
  line: number;
};

type EscapeCounts = {
  any: number;
  assertions: number;
  suppressions: number;
};

export type TypedDeclaration = {
  name: string;
  kind: string;
  line: number;
  type: string | null;
  exported: boolean;
};

export type TypedExport = {
  name: string;
  type: string | null;
};

export type TypedModuleRecord = {
  file: string;
  exports: TypedExport[];
  declarations: TypedDeclaration[];
  sourceFile?: ts.SourceFile;
};

export type TypeScriptProject = {
  available: boolean;
  loaded: boolean;
  reason: string | null;
  diagnostics: DiagnosticRecord[];
  modules: Map<string, TypedModuleRecord>;
  compiler_options?: Record<string, string | number | boolean | undefined>;
};

export type ModuleRecord = {
  id: string;
  file: string;
  absolutePath: string;
  lines: number;
  imports: ImportRecord[];
  functions: FunctionRecord[];
  components: FunctionRecord[];
  types: TypeRecord[];
  exports: ExportRecord[];
  escapeCounts: EscapeCounts;
  isBarrel: boolean;
  typed: TypedModuleRecord | null;
  text: string;
  sourceFile: SourceFileRecord;
  entrypointRoles: EntryPointRole[];
  unsupportedPatterns: ConfidenceSignal[];
  astSourceFile?: ts.SourceFile;
};

export type FrameworkDetails = {
  framework: string;
  routes: Array<{ kind: string; file: string }>;
  stories: string[];
  client_components: string[];
  server_only_signals: string[];
  conventions: Record<string, boolean>;
};

export type ProjectAnalysis = {
  sourceFiles: SourceFileRecord[];
  testFiles: SourceFileRecord[];
  modules: ModuleRecord[];
  imports: ImportRecord[];
  tsProject: TypeScriptProject;
  frameworkDetails: FrameworkDetails;
  unsupportedPatterns: ConfidenceSignal[];
  cache: {
    enabled: boolean;
    status: "hit" | "miss" | "disabled";
    file: string | null;
    previous_source_set_hash: string | null;
  };
};

export type AnalysisContext = {
  project: () => ProjectAnalysis;
  jscpd: () => JscpdResult;
  dependencyCruiser: () => DependencyCruiserResult;
  reactHooksLint: () => EslintReactHooksResult;
};

export type Signal = {
  kind: string;
  value?: string | number | boolean | null;
  line?: number | null;
  specifier?: string;
  message?: string;
};

export type IssueAction =
  | {
      type: "fix";
      auto_fixable: boolean;
      description: string;
      fix: string;
      note?: string;
    }
  | {
      type: "suppress-line";
      auto_fixable: false;
      description: string;
      comment: string;
    }
  | {
      type: "suppress-file";
      auto_fixable: false;
      description: string;
      comment: string;
    }
  | {
      type: "add-to-config";
      auto_fixable: boolean;
      description: string;
      config_key: string;
      value: JsonValue;
    };

export type ScoredRecord = {
  id: string;
  file?: string;
  files?: string[];
  score?: number;
  severity?: string;
  risk?: string;
  signals?: Signal[];
  actions?: IssueAction[];
  suppressed?: boolean;
  suppression_reason?: string;
  [key: string]: unknown;
};

export type Artifact = {
  schema_version: string;
  task_id: string;
  project: {
    name: string;
    root: string;
    framework: string;
    package_manager: string;
    test_runner: string;
  };
  provenance: Record<string, unknown>;
  confidence: Confidence;
  summary: Record<string, unknown>;
  records?: ScoredRecord[];
  tests?: TestRecord[];
  tool_status?: Record<string, { available?: boolean; ran?: boolean; [key: string]: unknown }>;
  graph?: { edges?: Array<Record<string, unknown>>; [key: string]: unknown };
  [key: string]: unknown;
};

export type AuditVerdict = "pass" | "warn" | "fail";

export type AuditFinding = ScoredRecord & {
  task_id: string;
  introduced: boolean;
};

export type AuditArtifact = Artifact & {
  task_id: "audit";
  summary: {
    verdict: AuditVerdict;
    gate: "new-only" | "all";
    base: string | null;
    changed_files: number;
    changed_hunks: number;
    base_snapshot_available: boolean;
    findings: number;
    active_findings: number;
    introduced_findings: number;
    inherited_findings: number;
    high_risk_findings: number;
    baseline_suppressed: number;
    config_suppressed: number;
    stale_suppressions: number;
  };
  findings: AuditFinding[];
};

export type TestRecord = {
  id: string;
  name: string;
  path: string;
  framework: string;
  locality: "colocated" | "external";
  source_mapping: string[];
  assertions: number;
  skipped: number;
  todo: number;
};

export type TestExecution =
  | { status: "not_run"; command: string | null }
  | { status: "unknown"; reason: string; command?: string | null }
  | { status: "passed"; command: string }
  | { status: "failed"; command: string; exit_code: number | null; stderr: string; stdout: string };

export type CloneBlock = {
  hash: string;
  normalized: string;
  file: string;
  start_line: number;
  end_line: number;
  test_code: boolean;
};

export type CloneInstance = {
  file: string;
  start_line: number | null;
  end_line: number | null;
};

export type CloneGroup = {
  id: string;
  engine: string;
  hash: string | null;
  classification: "test_clone" | "source_clone";
  test_code: boolean;
  score: number;
  risk: RiskLevel;
  signals: Signal[];
  instances: CloneInstance[];
};

type JscpdDuplicateFile = {
  name?: string;
  start?: number;
  end?: number;
  startLoc?: { line?: number };
  endLoc?: { line?: number };
};

export type JscpdDuplicate = {
  firstFile?: JscpdDuplicateFile;
  secondFile?: JscpdDuplicateFile;
  lines?: number;
  fragment?: string;
  format?: string;
  hash?: string;
};

type ToolResult = {
  available: boolean;
  ran: boolean;
  reason: string | null;
};

export type JscpdResult = ToolResult & {
  duplicates: JscpdDuplicate[];
  statistics: Record<string, unknown>;
};

export type DependencyCruiserDependency = {
  module?: string;
  resolved?: string;
  coreModule?: boolean;
  npm?: boolean;
  dependencyTypes?: string[];
  cycle?: boolean | string | Array<string | { name?: string }>;
};

export type DependencyCruiserModule = {
  source?: string;
  dependencies?: DependencyCruiserDependency[];
};

export type DependencyCruiserResult = ToolResult & {
  modules: DependencyCruiserModule[];
  summary: Record<string, unknown>;
};

export type EslintMessage = {
  file: string;
  line: number | null;
  column: number | null;
  rule_id: string;
  severity: "error" | "warning";
  message: string;
};

export type EslintReactHooksResult = ToolResult & {
  messages: EslintMessage[];
};

export type DiagnosticRecord = {
  code: number;
  category: string;
  file: string | null;
  line: number | null;
  character: number | null;
  message: string;
};
