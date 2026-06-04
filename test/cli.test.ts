import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { runCli, runMeasure } from "../src/cli.js";
import { auditMarkdown, runAudit } from "../src/audit.js";
import { projectContext } from "../src/context.js";
import { catalogForConfig } from "../src/tasks.js";
import type { AnalysisContext, Artifact, ProjectAnalysis, ScoredRecord } from "../src/types.js";

const repoRoot = path.resolve();
const fixtureConfig = path.join(repoRoot, "examples/basic/ts-react-quality-lens.config.json");
const goldenConfig = path.join(repoRoot, "test/fixtures/golden/ts-react-quality-lens.config.json");
type ToolArtifact = Artifact & { tool_status: NonNullable<Artifact["tool_status"]> };
type SummaryArtifact<T extends Record<string, unknown>> = Artifact & { summary: T };

test("catalog exposes stable board task metadata", () => {
  const config = loadConfig(fixtureConfig);
  const catalog = catalogForConfig(config);
  assert.equal(catalog.lens, "ts-react-quality-lens");
  assert.equal(catalog.tasks.length, 12);
  assert.ok(catalog.tasks.some((task) => task.id === "quality.hotspots"));
  assert.ok(catalog.tasks.some((task) => task.id === "quality.cleanup"));
  assert.ok(catalog.tasks.some((task) => task.id === "map.architecture"));
});

test("measure all writes MVP artifacts", () => {
  const config = loadConfig(fixtureConfig);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  const results = runMeasure(config, "all", "test measure all");
  const taskIds = new Set(results.map((result) => result.task_id));
  assert.ok(taskIds.has("quality.hotspots"));
  assert.ok(taskIds.has("quality.escape_hatches"));
  assert.ok(taskIds.has("quality.type_health"));
  assert.ok(taskIds.has("quality.dependency_health"));
  assert.ok(taskIds.has("correctness.catalog"));
  assert.ok(taskIds.has("map.architecture"));

  for (const artifact of [
    "hotspots.json",
    "clones.json",
    "ts_escape_hatches.json",
    "type_health.json",
    "dependency_health.json",
    "cleanup.json",
    "correctness_review.json",
    "test_catalog.json",
    "locality_metrics.json",
    "leverage_metrics.json",
    "react_health.json",
    "map.json",
  ]) {
    assert.ok(fs.existsSync(path.join(config.outputDir, artifact)), `${artifact} should exist`);
  }

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8")) as Artifact & {
    meta?: { risk_model_id?: string; risk_model_version?: number };
    nodes: Array<{
      risk_model_id?: string;
      risk_model_version?: number;
      total_score?: number | null;
      unknown_metrics?: string[];
    }>;
    edges: Array<{ from: string; source?: unknown; line?: unknown }>;
    summary: { artifact_status?: Record<string, string>; unknown_metric_nodes?: number };
  };
  assert.ok(map.nodes.length > 0);
  assert.ok(map.edges.length > 0);
  assert.equal(map.meta?.risk_model_id, "tsrqlens.architecture_risk");
  assert.equal(map.meta?.risk_model_version, 1);
  assert.ok(map.nodes.every((node) => node.risk_model_id === "tsrqlens.architecture_risk"));
  assert.ok(map.nodes.every((node) => node.risk_model_version === 1));
  assert.ok(map.nodes.every((node) => Array.isArray(node.unknown_metrics)));
  assert.ok(Object.entries(map.summary.artifact_status ?? {}).every(([name, status]) => name === "performance" || status === "available"));
  assert.equal(map.summary.unknown_metric_nodes, 0);

  const typeHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "type_health.json"), "utf8")) as Artifact;
  assert.equal(typeHealth.confidence.typescript_compiler_api_available, true);
  assert.equal(typeHealth.confidence.typescript_program_loaded, true);
  assert.ok(typeHealth.records?.some((record: ScoredRecord) => record.source === "typescript-compiler-api"));

  const dependencyHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8")) as ToolArtifact & {
    graph: { edges: Array<{ from: string; source?: unknown; line?: unknown }> };
  };
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.available, true);
  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
  const dependencyEdges = dependencyHealth.graph.edges as Array<{ from: string; source?: unknown; line?: unknown }>;
  assert.ok(dependencyEdges.every((edge) => !edge.from.includes(".test")));
  assert.ok(dependencyEdges.some((edge) => edge.source === "dependency-cruiser" && edge.line !== null));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ jscpd_clone_groups: number; duplication_records: number }>;
  assert.equal(clones.tool_status.jscpd.available, true);
  assert.equal(clones.tool_status.jscpd.ran, true);
  assert.ok(clones.summary.jscpd_clone_groups > 0);
  assert.ok(clones.summary.duplication_records > 0);
  assert.ok(clones.records?.some((record) => record.kind === "duplication_pressure"));

  const reactHealth = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as ToolArtifact &
    SummaryArtifact<{ hook_lint_findings: number }>;
  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
  assert.ok(reactHealth.summary.hook_lint_findings > 0);
  assert.ok(reactHealth.records?.some((record: ScoredRecord) => record.source === "framework-adapter"));

  const correctness = JSON.parse(fs.readFileSync(path.join(config.outputDir, "correctness_review.json"), "utf8"));
  assert.equal(correctness.summary.execution_status, "passed");

  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(cleanup.records?.some((record) => Array.isArray(record.actions) && record.actions.length > 0));

  assert.ok(fs.existsSync(path.join(config.outputDir, ".cache", "analysis.json")));
});

test("config accepts JSONC comments and rejects unknown keys through schema-backed validation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-config-`));
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.jsonc");
  fs.writeFileSync(
    configPath,
    `{
      // JSONC comments are accepted for user configs.
      "project_name": "jsonc-fixture",
      "project_root": ${JSON.stringify(repoRoot)},
      "source_roots": ["src"],
      "output_dir": "target/jsonc-analysis"
    }`,
    "utf8",
  );
  assert.equal(loadConfig(configPath).projectName, "jsonc-fixture");

  const badConfigPath = path.join(tempDir, "bad.config.json");
  fs.writeFileSync(badConfigPath, `{"project_name": "bad", "surprise": true}`, "utf8");
  assert.throws(() => loadConfig(badConfigPath), /Unknown config key "surprise"/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("init writes a starter schema-backed config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-init-`));
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  await withSilencedConsole(() => runCli(["init", "--config", configPath]));

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(raw.$schema, "./ts-react-quality-lens.config.schema.json");
  assert.equal(raw.audit.gate, "new-only");
  await assert.rejects(() => runCli(["init", "--config", configPath]), /Config already exists/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("audit writes changed-code verdict artifact with actions", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-audit`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const audit = runAudit(config, "test audit", { base: "__missing_base__", gate: "new-only" });

  assert.equal(audit.task_id, "audit");
  assert.ok(["pass", "warn", "fail"].includes(audit.summary.verdict));
  assert.ok(fs.existsSync(path.join(config.outputDir, "audit.json")));
  assert.ok(audit.findings.some((finding) => Array.isArray(finding.actions) && finding.actions.length > 0));
  assert.match(auditMarkdown(audit), /# ts-react-quality-lens audit:/);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("audit reports stale configured suppressions", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-stale-suppression`);
  config.suppressions = [{ id: "missing:finding", reason: "used to be noisy" }];
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const audit = runAudit(config, "test audit stale suppression", { base: "__missing_base__", gate: "new-only" });

  assert.equal(audit.summary.stale_suppressions, 1);
  assert.ok(audit.findings.some((finding) => finding.kind === "stale_suppression"));
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("audit marks unchanged-line findings as inherited context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-git-audit-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "git-audit-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "git-audit-fixture",
      project_root: ".",
      source_roots: ["src"],
      test_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      test_command: null,
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "lib.ts"),
    [
      "export function used(): number {",
      "  return 1;",
      "}",
      "",
      "export function oldUnused(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), 'import { used } from "./lib.js";\nconsole.log(used());\n', "utf8");
  git(tempDir, "init");
  git(tempDir, "config", "user.email", "test@example.com");
  git(tempDir, "config", "user.name", "Test User");
  git(tempDir, "add", ".");
  git(tempDir, "commit", "-m", "initial");
  fs.writeFileSync(
    path.join(tempDir, "src", "lib.ts"),
    [
      "export function used(): number {",
      "  return 10;",
      "}",
      "",
      "export function oldUnused(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const audit = runAudit(config, "test audit changed lines", { base: "HEAD", gate: "new-only" });
  const oldUnused = audit.findings.find((finding) => finding.id === "cleanup:unused-export:src/lib:oldUnused");

  assert.ok(oldUnused, "old unused export should be included as changed-file context");
  assert.equal(oldUnused.introduced, false);
  assert.ok(audit.summary.changed_hunks > 0);
  assert.equal(audit.summary.base_snapshot_available, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("context command writes compact project context and cache can hit", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-context`);
  config.cache.dir = path.join(config.outputDir, ".cache");
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const first = projectContext(config, "test context first");
  const second = projectContext(config, "test context second");

  assert.equal(first.task_id, "context.project");
  assert.ok(fs.existsSync(path.join(config.outputDir, "context.json")));
  assert.equal(second.summary.cache_status, "hit");
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("project analysis marks package tool entrypoints", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-entrypoints-`));
  fs.mkdirSync(path.join(tempDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({
      name: "entrypoint-fixture",
      type: "module",
      main: "./dist/src/index.js",
      bin: { fixture: "./dist/bin/tool.js" },
      scripts: { smoke: "node ./scripts/smoke.ts" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["bin", "src", "scripts"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "bin", "tool.ts"), "export function run(): void {}\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const api = 1;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "scripts", "smoke.ts"), "export const smoke = true;\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "entrypoint-fixture",
      project_root: ".",
      source_roots: ["bin", "src", "scripts"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
    }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  const context = projectContext(config, "test entrypoint context") as {
    summary: { entrypoint_modules?: number };
    modules: Array<{ file: string; entrypoint_roles: string[] }>;
  };
  assert.equal(context.summary.entrypoint_modules, 3);
  assert.deepEqual(context.modules.find((module) => module.file === "bin/tool.ts")?.entrypoint_roles, ["cli_bin"]);
  assert.deepEqual(context.modules.find((module) => module.file === "src/index.ts")?.entrypoint_roles, ["package_main"]);
  assert.deepEqual(context.modules.find((module) => module.file === "scripts/smoke.ts")?.entrypoint_roles, ["npm_script"]);

  runMeasure(config, "quality.cleanup", "test entrypoint cleanup");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(!cleanup.records?.some((record) => record.kind === "unused_file"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("clone measure reports same-purpose exports and hooks without clone-like bodies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-same-purpose-`));
  fs.mkdirSync(path.join(tempDir, "src", "billing"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "src", "profile"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "same-purpose-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "billing", "format.ts"),
    [
      "export function formatCurrency(cents: number): string {",
      "  const whole = Math.trunc(cents / 100);",
      "  const fraction = String(Math.abs(cents % 100)).padStart(2, '0');",
      "  return `USD ${whole}.${fraction}`;",
      "}",
      "",
      "export function useUserState(id: string): { id: string; loading: boolean } {",
      "  return { id, loading: false };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "src", "profile", "money.ts"),
    [
      "export const currencyFormatter = (amount: number): string => {",
      "  const value = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });",
      "  return value.format(amount);",
      "};",
      "",
      "export function useStateUser(userId: string): { userId: string; ready: boolean } {",
      "  return { userId, ready: true };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "same-purpose-fixture",
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
    }),
    "utf8",
  );

  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.clones", "test same purpose");
  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as Artifact &
    SummaryArtifact<{ same_purpose_records: number }>;
  assert.ok(clones.summary.same_purpose_records >= 2);
  assert.ok(clones.records?.some((record) => record.kind === "same_purpose_export" && record.purpose_key === "currency:format"));
  assert.ok(clones.records?.some((record) => record.kind === "same_purpose_hook" && record.purpose_key === "state:user"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup honors configured public API exports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-public-api-`));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ name: "public-api-fixture", type: "module" }), "utf8");
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "src", "lib.ts"), "export const publicHelper = 1;\nexport const unusedHelper = 2;\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "ts-react-quality-lens.config.json"),
    JSON.stringify({
      project_name: "public-api-fixture",
      project_root: ".",
      source_roots: ["src"],
      output_dir: "target/analysis",
      tsconfig: "tsconfig.json",
      public_api: { exports: [{ file: "src/lib.ts", names: ["publicHelper"] }] },
    }),
    "utf8",
  );
  const config = loadConfig(path.join(tempDir, "ts-react-quality-lens.config.json"));
  runMeasure(config, "quality.cleanup", "test public api cleanup");
  const cleanup = JSON.parse(fs.readFileSync(path.join(config.outputDir, "cleanup.json"), "utf8")) as Artifact;
  assert.ok(!cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/lib:publicHelper"));
  assert.ok(cleanup.records?.some((record) => record.id === "cleanup:unused-export:src/lib:unusedHelper"));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("react hooks lint resolves dependencies when output dir is outside the project", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-react-hooks`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });

  const [reactHealth] = runMeasure(config, "quality.react_health", "test react hooks temp output") as [ToolArtifact];

  assert.equal(reactHealth.tool_status.eslint_react_hooks.available, true);
  assert.equal(reactHealth.tool_status.eslint_react_hooks.ran, true);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("dependency health tolerates dependency-cruiser cycle shape variants", () => {
  const config = loadConfig(fixtureConfig);
  config.outputDir = path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-depcruise`);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  const project = {
    sourceFiles: [],
    testFiles: [],
    modules: [
      { id: "src/a", file: "src/a.ts", imports: [], exports: [], types: [], components: [] },
      { id: "src/b", file: "src/b.ts", imports: [], exports: [], types: [], components: [] },
    ],
    imports: [{ from: "src/a", to: "src/b", to_kind: "relative", specifier: "./b", import_kind: "static", line: 1 }],
    tsProject: { available: false, loaded: false, reason: null },
    frameworkDetails: { conventions: {} },
    unsupportedPatterns: [],
  } as unknown as ProjectAnalysis;
  const context: AnalysisContext = {
    project: () => project,
    jscpd: () => ({ available: false, ran: false, reason: "not used", duplicates: [], statistics: {} }),
    dependencyCruiser: () => ({
      available: true,
      ran: true,
      reason: null,
      modules: [
        { source: "src/a.ts", dependencies: [{ resolved: "src/b.ts", cycle: true }] },
        { source: "src/b.ts", dependencies: [{ resolved: "src/a.ts", cycle: [{ name: "src/a.ts" }] }] },
      ],
      summary: {},
    }),
    reactHooksLint: () => ({ available: false, ran: false, reason: "not used", messages: [] }),
  };

  const [dependencyHealth] = runMeasure(config, "quality.dependency_health", "test depcruise cycle shape", { context }) as [
    ToolArtifact & SummaryArtifact<{ dependency_cruiser_cycles: number }>,
  ];

  assert.equal(dependencyHealth.tool_status.dependency_cruiser.ran, true);
  assert.equal(dependencyHealth.summary.dependency_cruiser_cycles, 1);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
});

test("golden fixture exercises edge-case artifact signals", () => {
  const config = loadConfig(goldenConfig);
  fs.rmSync(config.outputDir, { recursive: true, force: true });
  runMeasure(config, "all", "test golden fixture");

  const dependency = JSON.parse(fs.readFileSync(path.join(config.outputDir, "dependency_health.json"), "utf8")) as Artifact & {
    graph: { edges: Array<{ from: string; to: string; kind: string }> };
    summary: { layer_violations?: number; unsupported_patterns?: number };
  };
  assert.ok(dependency.summary.layer_violations && dependency.summary.layer_violations > 0);
  assert.ok(dependency.summary.unsupported_patterns && dependency.summary.unsupported_patterns > 0);
  assert.ok(dependency.records?.some((record) => record.kind === "layer_violation"));
  assert.ok(dependency.records?.some((record) => record.kind === "unsupported_pattern"));
  assert.ok(dependency.graph.edges.some((edge) => edge.from === "src/app/page" && edge.to === "src/lib/math" && edge.kind === "relative"));

  const clones = JSON.parse(fs.readFileSync(path.join(config.outputDir, "clones.json"), "utf8")) as Artifact &
    SummaryArtifact<{ ast_clone_groups: number }>;
  assert.ok(clones.summary.ast_clone_groups > 0);
  assert.ok((clones.groups as Array<{ engine: string }>).some((group) => group.engine === "ast"));

  const react = JSON.parse(fs.readFileSync(path.join(config.outputDir, "react_health.json"), "utf8")) as Artifact &
    SummaryArtifact<{ a11y_findings: number }>;
  assert.ok(react.summary.a11y_findings > 0);
  assert.ok(react.records?.some((record) => record.kind === "img_missing_alt"));
  assert.ok(react.records?.some((record) => record.id === "framework:transitive-client-server-boundary:src/app/page.tsx"));

  const leverage = JSON.parse(fs.readFileSync(path.join(config.outputDir, "leverage_metrics.json"), "utf8")) as Artifact;
  assert.ok(leverage.records?.some((record) => Number(record.dead_export_surface ?? 0) > 0));

  const map = JSON.parse(fs.readFileSync(path.join(config.outputDir, "map.json"), "utf8")) as Artifact & {
    meta?: { performance_inputs?: Record<string, unknown> };
  };
  assert.ok(map.meta?.performance_inputs);
});

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function withSilencedConsole<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = originalLog;
  }
}
