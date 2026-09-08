import type * as ts from "typescript";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RiskLevel = "low" | "medium" | "high";
export type Severity = RiskLevel;
export type FindingDisposition = "block" | "warn" | "review" | "info";
export type EvidenceKind = "diagnostic" | "tool-rule" | "test" | "metric" | "heuristic";
export type FindingConfidence = "low" | "medium" | "high";
export type PolicyProfile = "baseline" | "recommended" | "strict" | "react" | "library";
export type PolicyCheck = "compiler" | "typed-lint" | "tests" | "react-hooks" | "package";
export type ReactRuleset = "classic-v1" | "recommended-v2";
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
  react?: ReactConfig;
  accessibility?: AccessibilityConfig;
  cleanup?: CleanupConfig;
  type_coverage?: TypeCoverageConfig;
  package_health?: PackageHealthConfig;
  sarif_inputs?: SarifInputConfig[];
  workspaces?: WorkspacesConfig;
  runtime_inputs?: RuntimeInputConfig;
  policy?: PolicyConfig;
  suppressions?: SuppressionConfig[];
  audit?: AuditConfig;
};

export type PolicyConfig = { profile?: PolicyProfile; required_checks?: PolicyCheck[] };
export type PublicApiConfig = { entry?: string[]; exports?: Array<{ file: string; names: string[] }> };
type CacheConfig = { enabled?: boolean };
export type ReactConfig = { ruleset?: ReactRuleset };
export type AccessibilityConfig = {
  enabled?: boolean; components?: Record<string, string>; polymorphic_prop_name?: string;
};
export type CleanupConfig = { knip?: boolean; production?: boolean };
export type TypeCoverageConfig = {
  minimum_percent?: number; per_file_minimum_percent?: number; changed_file_minimum_percent?: number; baseline?: string;
};
export type PackageHealthConfig = { enabled?: boolean; attw_profile?: "strict" | "node16" | "esm-only" };
export type SarifInputConfig = { path: string; name?: string; required?: boolean };
type WorkspaceOverrideConfig = { workspace: string; framework?: string; policy_profile?: PolicyProfile };
export type WorkspacesConfig = {
  enabled?: boolean; patterns?: string[]; overrides?: WorkspaceOverrideConfig[];
};
export type RuntimeInputConfig = { react_profiler?: string; axe?: string; react_doctor?: string };
export type SuppressionConfig = { id?: string; file?: string; kind?: string; reason?: string };
export type AuditConfig = { base?: string; changed_since?: string; gate?: "new-only" | "all"; baseline?: string };
export type LayerRule = { layer: string; patterns: string[] };
export type PerformanceInputConfig = { bundle_stats?: string; render_costs?: string };
export type PathAliasRule = { pattern: string; replacements: string[] };

export type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[] };
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
  knip?: { ignoreDependencies?: string[] };
};

export type EntryPointRole =
  | "cli_bin"
  | "npm_script"
  | "html_module"
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
  react: {
    ruleset: ReactRuleset;
  };
  accessibility: {
    enabled: boolean;
    components: Record<string, string>;
    polymorphicPropName: string | null;
  };
  cleanup: {
    knip: boolean;
    production: boolean;
  };
  typeCoverage: {
    minimumPercent: number | null;
    perFileMinimumPercent: number | null;
    changedFileMinimumPercent: number | null;
    baseline: string | null;
  };
  packageHealth: {
    enabled: boolean;
    attwProfile: "strict" | "node16" | "esm-only";
  };
  sarifInputs: Array<{
    path: string;
    name: string;
    required: boolean;
  }>;
  workspaces: {
    enabled: boolean;
    patterns: string[];
    overrides: WorkspaceOverrideConfig[];
  };
  runtimeInputs: {
    reactProfiler: string | null;
    axe: string | null;
    reactDoctor: string | null;
  };
  policy: {
    profile: PolicyProfile;
    requiredChecks: PolicyCheck[];
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
  from_workspace?: string;
  to_workspace?: string;
  workspace_dependency?: boolean;
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
  cyclomatic_complexity: number;
  cognitive_complexity: number;
  halstead_effort: number;
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
  surface_type_references?: string[];
  sourceFile?: ts.SourceFile;
};

export type TypeCoverageFile = {
  file: string;
  analyzed_symbols: number;
  typed_symbols: number;
  explicit_any: number;
  inferred_any: number;
  error_types: number;
  unknown: number;
  type_coverage_percent: number;
};

export type TypeCoverageSummary = Omit<TypeCoverageFile, "file"> & {
  files: number;
};

type TypeScriptProjectConfig = {
  tsconfig: string;
  workspace_id: string;
  loaded: boolean;
  reason: string | null;
};

export type TypeScriptProject = {
  input_files?: string[];
  available: boolean;
  loaded: boolean;
  reason: string | null;
  diagnostics: DiagnosticRecord[];
  modules: Map<string, TypedModuleRecord>;
  compiler_options?: Record<string, JsonValue | undefined>;
  type_coverage?: {
    summary: TypeCoverageSummary;
    files: TypeCoverageFile[];
  };
  project_configs?: TypeScriptProjectConfig[];
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
  workspace_id: string;
  workspace_name: string;
  unsupportedPatterns: ConfidenceSignal[];
  astSourceFile?: ts.SourceFile;
};

export type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
  private: boolean;
  framework: string;
  policy_profile: PolicyProfile;
  tsconfigs: string[];
  source_files: number;
  project_loaded: boolean;
  project_reason: string | null;
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
  workspaces: WorkspaceRecord[];
  unsupportedPatterns: ConfidenceSignal[];
  cache: {
    enabled: boolean;
    status: "hit" | "miss" | "disabled";
    reused: boolean;
    file: string | null;
    previous_source_set_hash: string | null;
  };
};

export type AnalysisContext = {
  project: () => ProjectAnalysis;
  jscpd: () => JscpdResult;
  dependencyCruiser: () => DependencyCruiserResult;
  knip: () => KnipResult;
  packageHealth: () => PackageHealthResult;
  reactHooksLint: () => EslintReactHooksResult;
  jsxA11yLint: () => EslintAccessibilityResult;
  typedLint: () => EslintTypeAwareResult;
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

export type RelatedLocation = {
  file: string;
  start_line: number;
  start_column?: number;
  end_line?: number;
  end_column?: number;
  role: "source" | "sink" | "cause" | "related" | "duplicate" | "fix-site";
  message?: string;
};

export type SemanticDecision =
  | "confirmed"
  | "contract-preserved"
  | "disagreed"
  | "not-comparable"
  | "excluded-by-tool"
  | "unresolved"
  | "abstained"
  | "unavailable";

export type AnalysisIdentity = {
  id: string;
  schema_version: string;
  compiler_api_version: string | null;
  config_closure_hash: string;
  rulesets: Record<string, string>;
  integration_versions: Record<string, string | null>;
};

export type ScoredRecord = {
  id: string;
  rule_id?: string;
  evidence_kind?: EvidenceKind;
  disposition?: FindingDisposition;
  finding_confidence?: FindingConfidence;
  message?: string;
  scope?: "file" | "project";
  file?: string;
  files?: string[];
  workspace_id?: string;
  workspace_name?: string;
  line?: number | null;
  column?: number | null;
  end_line?: number | null;
  end_column?: number | null;
  related_locations?: RelatedLocation[];
  fix_group_id?: string;
  estimated_effort?: number;
  semantic_decision?: SemanticDecision;
  reason_code?: string;
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
  analysis_identity?: AnalysisIdentity;
  confidence: Confidence;
  summary: Record<string, unknown>;
  records?: ScoredRecord[];
  disagreements?: ScoredRecord[];
  unconfirmed?: ScoredRecord[];
  tests?: TestRecord[];
  execution?: TestExecution;
  tool_status?: Record<string, { available?: boolean; ran?: boolean; [key: string]: unknown }>;
  graph?: { edges?: Array<Record<string, unknown>>; [key: string]: unknown };
  [key: string]: unknown;
};

export type AuditVerdict = "pass" | "warn" | "fail" | "incomplete";

export type AuditFinding = ScoredRecord & {
  task_id: string;
  introduced: boolean;
};

export type AuditArtifact = Artifact & {
  task_id: "audit";
  summary: {
    verdict: AuditVerdict;
    complete: boolean;
    incomplete_reasons: string[];
    gate: "new-only" | "all";
    base: string | null;
    changed_files: number;
    changed_hunks: number;
    base_snapshot_available: boolean;
    base_snapshot_compatible: boolean | null;
    findings: number;
    active_findings: number;
    introduced_findings: number;
    inherited_findings: number;
    high_risk_findings: number;
    blocking_findings: number;
    warning_findings: number;
    baseline_suppressed: number;
    config_suppressed: number;
    stale_suppressions: number;
  };
  findings: AuditFinding[];
};

export type TestAssociation = {
  file: string;
  kind: "filename" | "direct-import" | "type-only-import";
  confidence: FindingConfidence;
};

export type TestRecord = {
  source_associations?: TestAssociation[];
  coverage_status?: "not_collected";
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

type ToolResult = { available: boolean; ran: boolean; reason: string | null; duration_ms?: number };

export type JscpdResult = ToolResult & { duplicates: JscpdDuplicate[]; statistics: Record<string, unknown> };

export type DependencyCruiserDependency = {
  module?: string; resolved?: string; coreModule?: boolean; npm?: boolean; dependencyTypes?: string[];
  cycle?: boolean | string | Array<string | { name?: string }>;
};
export type DependencyCruiserModule = { source?: string; dependencies?: DependencyCruiserDependency[] };
export type DependencyCruiserResult = ToolResult & {
  modules: DependencyCruiserModule[]; summary: Record<string, unknown>;
};

type KnipIssueItem = { name: string; namespace?: string; kind?: string; specifier?: string; line?: number; col?: number };
export type KnipIssueEntry = {
  file: string; [issueType: string]: string | KnipIssueItem[] | KnipIssueItem[][] | undefined;
};
export type KnipResult = ToolResult & {
  issues: KnipIssueEntry[];
  version: string | null;
  complete: boolean;
  excluded_dependencies: string[];
  exclusions_complete: boolean;
};

export type PackageToolStatus = ToolResult & { complete: boolean; version?: string | null };
export type PublintMessage = {
  code: string; type: "suggestion" | "warning" | "error"; path: string[]; args: Record<string, unknown>;
};
export type AttwProblem = { kind: string; entrypoint?: string; resolutionKind?: string };
export type PackageHealthResult = {
  enabled: boolean; declaration: PackageToolStatus;
  pack: PackageToolStatus & { files: number; size: number | null };
  publint: PackageToolStatus & { messages: PublintMessage[] };
  attw: PackageToolStatus & { problems: AttwProblem[]; profile: "strict" | "node16" | "esm-only" };
};

export type EslintMessage = {
  file: string; line: number | null; column: number | null; end_line: number | null; end_column: number | null;
  rule_id: string; severity: "error" | "warning"; message: string;
};
export type EslintReactHooksResult = ToolResult & {
  messages: EslintMessage[]; version: string | null; ruleset: ReactRuleset; complete: boolean;
};
export type EslintAccessibilityResult = ToolResult & {
  messages: EslintMessage[]; version: string | null; complete: boolean;
};
export type EslintTypeAwareResult = ToolResult & {
  messages: EslintMessage[]; version: string | null; complete: boolean;
};

export type DiagnosticRecord = {
  code: number; category: string; file: string | null; line: number | null; character: number | null;
  end_line: number | null; end_character: number | null; message: string;
};
