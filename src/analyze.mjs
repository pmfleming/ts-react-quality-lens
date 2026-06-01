import childProcess from "node:child_process";
import path from "node:path";
import { createConfidence } from "./config.mjs";
import {
  discoverSourceFiles,
  discoverTestFiles,
  lineForIndex,
  normalizeImportPath,
  readSourceFile,
  relativeModuleId,
  toPosix,
} from "./files.mjs";
import {
  detectFrameworkDetails,
  loadTypeScriptProject,
  runDependencyCruiser,
  runJscpd,
  runReactHooksLint,
} from "./integrations.mjs";
import { artifactBase } from "./provenance.mjs";
import { readArtifact, writeArtifact } from "./writer.mjs";

export function analyzeProject(config) {
  const sourceFiles = discoverSourceFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const testFiles = discoverTestFiles(config).map((file) => readSourceFile(file, config.projectRoot));
  const tsProject = loadTypeScriptProject(config, sourceFiles);
  const modules = sourceFiles.map((file) => analyzeModule(config, file, tsProject));
  const imports = modules.flatMap((module) => module.imports);
  const frameworkDetails = detectFrameworkDetails(config, { sourceFiles, testFiles, modules, imports });
  return { sourceFiles, testFiles, modules, imports, tsProject, frameworkDetails };
}

function analysisConfidence(config, project, extra = {}) {
  return createConfidence(config, {
    typescript_compiler_api_available: project.tsProject.available,
    typescript_program_loaded: project.tsProject.loaded,
    typescript_program_reason: project.tsProject.reason,
    type_information_available: project.tsProject.loaded,
    framework_conventions_detected: Object.values(project.frameworkDetails.conventions).some(Boolean),
    ...extra,
  });
}

export function measureHotspots(config, command) {
  const project = analyzeProject(config);
  const records = [];
  for (const module of project.modules) {
    records.push(fileHotspotRecord(module));
    for (const fn of module.functions) records.push(functionHotspotRecord(module, fn));
  }
  records.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const artifact = {
    ...artifactBase(config, "quality.hotspots", command, analysisConfidence(config, project)),
    summary: {
      source_files: project.sourceFiles.length,
      records: records.length,
      high_risk_records: records.filter((record) => record.risk === "high").length,
    },
    records,
  };
  writeArtifact(config, "hotspots.json", artifact);
  return artifact;
}

export function measureClones(config, command) {
  const project = analyzeProject(config);
  const jscpd = runJscpd(config);
  const blocks = [];
  for (const file of [...project.sourceFiles, ...project.testFiles]) {
    const relevantLines = file.lines
      .map((line, index) => ({ index: index + 1, text: line.trim() }))
      .filter((line) => line.text && !line.text.startsWith("//") && !line.text.startsWith("*"));
    for (let index = 0; index <= relevantLines.length - 6; index += 1) {
      const window = relevantLines.slice(index, index + 6);
      const normalized = window.map((line) => normalizeCloneLine(line.text)).join("\n");
      if (normalized.length < 80) continue;
      blocks.push({
        hash: stableHash(normalized),
        normalized,
        file: file.relativePath,
        start_line: window[0].index,
        end_line: window.at(-1).index,
        test_code: file.isTest,
      });
    }
  }
  const heuristicGroups = [...groupBy(blocks, (block) => block.hash).values()]
    .filter((group) => new Set(group.map((block) => `${block.file}:${block.start_line}`)).size > 1)
    .map((group) => cloneGroup(group))
    .sort((left, right) => right.score - left.score);
  const jscpdGroups = jscpd.ran ? jscpd.duplicates.map((duplicate, index) => jscpdCloneGroup(config, duplicate, index)) : [];
  const groups = [...jscpdGroups, ...heuristicGroups].sort((left, right) => right.score - left.score);
  const artifact = {
    ...artifactBase(
      config,
      "quality.clones",
      command,
      analysisConfidence(config, project, {
        jscpd_available: jscpd.available,
        jscpd_ran: jscpd.ran,
      }),
    ),
    summary: {
      clone_groups: groups.length,
      jscpd_clone_groups: jscpdGroups.length,
      heuristic_clone_groups: heuristicGroups.length,
      source_clone_groups: groups.filter((group) => !group.test_code).length,
      test_clone_groups: groups.filter((group) => group.test_code).length,
    },
    tool_status: {
      jscpd: {
        available: jscpd.available,
        ran: jscpd.ran,
        reason: jscpd.reason ?? null,
        statistics: jscpd.statistics ?? {},
      },
    },
    groups,
  };
  writeArtifact(config, "clones.json", artifact);
  return artifact;
}

export function measureEscapeHatches(config, command) {
  const project = analyzeProject(config);
  const records = project.modules.flatMap((module) => escapeRecords(module));
  const byKind = countBy(records, (record) => record.kind);
  const artifact = {
    ...artifactBase(config, "quality.escape_hatches", command, analysisConfidence(config, project)),
    summary: {
      records: records.length,
      files_with_escape_hatches: new Set(records.map((record) => record.file)).size,
      by_kind: Object.fromEntries(byKind),
    },
    records,
  };
  writeArtifact(config, "ts_escape_hatches.json", artifact);
  return artifact;
}

export function measureTypeHealth(config, command) {
  const project = analyzeProject(config);
  const records = project.modules.flatMap((module) => typeHealthRecords(module));
  const diagnostics = project.tsProject.diagnostics ?? [];
  const artifact = {
    ...artifactBase(config, "quality.type_health", command, analysisConfidence(config, project)),
    summary: {
      records: records.length,
      high_risk_records: records.filter((record) => record.risk === "high").length,
      wide_types: records.filter((record) => record.signals.some((signal) => signal.kind === "wide_surface")).length,
      compiler_diagnostics: diagnostics.length,
    },
    compiler_options: project.tsProject.compiler_options ?? null,
    diagnostics,
    records,
  };
  writeArtifact(config, "type_health.json", artifact);
  return artifact;
}

export function measureDependencyHealth(config, command) {
  const project = analyzeProject(config);
  const depcruise = runDependencyCruiser(config);
  const internalEdges = project.imports.filter((edge) => edge.to_kind === "relative");
  const externalEdges = project.imports.filter((edge) => edge.to_kind === "external");
  const cycles = findCycles(internalEdges);
  const depcruiseCycles = depcruise.ran ? dependencyCruiserCycles(config, depcruise.modules) : [];
  const deepRelativeImports = project.imports.filter((edge) => edge.specifier.startsWith("../../"));
  const barrelModules = project.modules.filter((module) => module.isBarrel);
  const records = [
    ...cycles.map((cycle, index) => ({
      id: `cycle:${index + 1}`,
      kind: "import_cycle",
      severity: cycle.length > 3 ? "high" : "medium",
      score: Math.min(100, cycle.length * 18),
      files: cycle,
      evidence: cycle.join(" -> "),
    })),
    ...depcruiseCycles.map((cycle, index) => ({
      id: `depcruise-cycle:${index + 1}`,
      kind: "import_cycle",
      severity: cycle.length > 3 ? "high" : "medium",
      score: Math.min(100, cycle.length * 20),
      files: cycle,
      evidence: cycle.join(" -> "),
      source: "dependency-cruiser",
    })),
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
      edges: depcruise.ran ? dependencyCruiserEdges(config, depcruise.modules) : project.imports.map((edge) => ({
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

export function measureCorrectnessCatalog(config, command, runTests = false) {
  const project = analyzeProject(config);
  const tests = project.testFiles.map((file) => testRecord(config, file, project.modules));
  const execution = runTests ? runTestCommand(config) : { status: "not_run", command: config.testCommand };
  const summary = {
    tests: tests.length,
    colocated_tests: tests.filter((test) => test.locality === "colocated").length,
    external_tests: tests.filter((test) => test.locality !== "colocated").length,
    execution_status: execution.status,
  };
  const review = {
    ...artifactBase(
      config,
      runTests ? "correctness.all" : "correctness.catalog",
      command,
      analysisConfidence(config, project, { test_command_configured: Boolean(config.testCommand) }),
    ),
    summary,
    execution,
    tests,
  };
  const catalog = {
    ...artifactBase(config, "correctness.catalog", command, analysisConfidence(config, project)),
    summary,
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      path: test.path,
      framework: test.framework,
      source_mapping: test.source_mapping,
      status: execution.status === "passed" ? "unknown" : "not_run",
      command_hint: config.testCommand,
    })),
  };
  writeArtifact(config, "correctness_review.json", review);
  writeArtifact(config, "test_catalog.json", catalog);
  return review;
}

export function measureLocality(config, command) {
  const project = analyzeProject(config);
  const testCatalog = readArtifact(config, "test_catalog.json");
  const testEvidence = new Set((testCatalog?.tests ?? []).flatMap((test) => test.source_mapping ?? []));
  const churn = gitChurn(config);
  const records = project.modules.map((module) => {
    const internalImports = module.imports.filter((edge) => edge.to_kind === "relative");
    const farImports = internalImports.filter((edge) => edge.specifier.startsWith("../"));
    const hiddenCoupling = hiddenCouplingSignals(module);
    const hasTestEvidence = testEvidence.has(module.file);
    const score = Math.min(
      100,
      farImports.length * 12 +
        hiddenCoupling.length * 18 +
        (hasTestEvidence ? 0 : 18) +
        Math.min(20, (churn.get(module.file)?.commits ?? 0) * 2),
    );
    return {
      id: `locality:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk: riskForScore(score),
      dependency_distance: farImports.length,
      hidden_coupling: hiddenCoupling,
      test_locality: hasTestEvidence ? "direct_evidence" : "no_evidence",
      churn: churn.get(module.file) ?? { commits: 0, contributors: 0 },
      signals: [
        ...farImports.map((edge) => ({ kind: "far_import", line: edge.line, specifier: edge.specifier })),
        ...hiddenCoupling.map((signal) => ({ kind: signal.kind, line: signal.line })),
        ...(hasTestEvidence ? [] : [{ kind: "missing_direct_test_evidence" }]),
      ],
    };
  });
  const artifact = {
    ...artifactBase(config, "quality.locality_dynamic", command, analysisConfidence(config, project)),
    summary: {
      records: records.length,
      high_risk_records: records.filter((record) => record.risk === "high").length,
    },
    records,
  };
  writeArtifact(config, "locality_metrics.json", artifact);
  return artifact;
}

export function measureLeverage(config, command) {
  const project = analyzeProject(config);
  const inbound = new Map();
  for (const edge of project.imports.filter((item) => item.to_kind === "relative")) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  const records = project.modules.map((module) => {
    const inboundReach = inbound.get(module.id) ?? 0;
    const publicSurface = module.exports.length + module.types.length;
    const weakSurface = module.escapeCounts.any + module.escapeCounts.assertions + module.escapeCounts.suppressions;
    const score = Math.max(0, Math.min(100, inboundReach * 10 + publicSurface * 2 - weakSurface * 8));
    const risk = inboundReach > 4 && weakSurface > 0 ? "high" : inboundReach > 2 && weakSurface > 0 ? "medium" : "low";
    return {
      id: `leverage:${module.id}`,
      module_id: module.id,
      file: module.file,
      score,
      risk,
      inbound_reach: inboundReach,
      public_surface: publicSurface,
      weak_surface: weakSurface,
      classification: inboundReach > 3 ? "shared_hub" : inboundReach === 0 ? "leaf" : "local_dependency",
      signals: [
        ...(inboundReach > 3 ? [{ kind: "broad_inbound_reach", value: inboundReach }] : []),
        ...(weakSurface > 0 ? [{ kind: "weak_public_surface", value: weakSurface }] : []),
      ],
    };
  });
  const artifact = {
    ...artifactBase(config, "quality.locality_leverage", command, analysisConfidence(config, project)),
    summary: {
      records: records.length,
      shared_hubs: records.filter((record) => record.classification === "shared_hub").length,
    },
    records,
  };
  writeArtifact(config, "leverage_metrics.json", artifact);
  return artifact;
}

export function measureReactHealth(config, command) {
  const project = analyzeProject(config);
  const hooksLint = runReactHooksLint(config);
  const records = [];
  for (const module of project.modules) {
    for (const component of module.components) {
      const signals = [];
      if (component.lines > 120) signals.push({ kind: "oversized_component", value: component.lines });
      if (component.hooks > 5) signals.push({ kind: "many_hooks", value: component.hooks });
      if (component.effects > 2) signals.push({ kind: "many_effects", value: component.effects });
      if (component.jsxConditionals > 4) {
        signals.push({ kind: "render_branch_complexity", value: component.jsxConditionals });
      }
      const score =
        component.lines * 0.25 + component.hooks * 8 + component.effects * 12 + component.jsxConditionals * 6;
      records.push({
        id: `component:${module.id}:${component.name}`,
        module_id: module.id,
        file: module.file,
        name: component.name,
        line: component.line,
        score: Math.round(score),
        risk: riskForScore(score),
        signals,
      });
    }
  }
  for (const message of hooksLint.messages ?? []) {
    records.push({
      id: `react-hooks:${message.file}:${message.line}:${message.rule_id}`,
      module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
      file: message.file,
      name: message.rule_id,
      line: message.line,
      score: message.severity === "error" ? 85 : 55,
      risk: message.severity === "error" ? "high" : "medium",
      source: "eslint-plugin-react-hooks",
      signals: [
        {
          kind: message.rule_id === "react-hooks/rules-of-hooks" ? "rules_of_hooks_violation" : "exhaustive_deps_violation",
          message: message.message,
        },
      ],
    });
  }
  const artifact = {
    ...artifactBase(
      config,
      "quality.react_health",
      command,
      analysisConfidence(config, project, {
        eslint_react_hooks_available: hooksLint.available,
        eslint_react_hooks_ran: hooksLint.ran,
      }),
    ),
    summary: {
      components: project.modules.reduce((count, module) => count + module.components.length, 0),
      records: records.length,
      hook_lint_findings: hooksLint.messages?.length ?? 0,
      high_risk_components: records.filter((record) => record.risk === "high").length,
    },
    framework: project.frameworkDetails,
    tool_status: {
      eslint_react_hooks: {
        available: hooksLint.available,
        ran: hooksLint.ran,
        reason: hooksLint.reason ?? null,
      },
    },
    records,
  };
  writeArtifact(config, "react_health.json", artifact);
  return artifact;
}

export function measureArchitectureMap(config, command) {
  const project = analyzeProject(config);
  const artifacts = {
    hotspots: readArtifact(config, "hotspots.json"),
    escape_hatches: readArtifact(config, "ts_escape_hatches.json"),
    type_health: readArtifact(config, "type_health.json"),
    dependency_health: readArtifact(config, "dependency_health.json"),
    correctness: readArtifact(config, "correctness_review.json"),
    locality: readArtifact(config, "locality_metrics.json"),
    leverage: readArtifact(config, "leverage_metrics.json"),
    react_health: readArtifact(config, "react_health.json"),
  };
  const nodes = project.modules.map((module) => mapNode(module, artifacts));
  const edges = project.imports.map((edge) => ({
    id: `import:${edge.from}:${edge.to}:${edge.line}`,
    from: edge.from,
    to: edge.to,
    type: edge.import_kind === "dynamic" ? "dynamic_import" : edge.import_kind === "type" ? "type_only_import" : "static_import",
    source: edge.source,
    line: edge.line,
  }));
  const artifact = {
    ...artifactBase(config, "map.architecture", command, analysisConfidence(config, project)),
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      high_risk_nodes: nodes.filter((node) => node.risk === "high").length,
      artifact_status: Object.fromEntries(
        Object.entries(artifacts).map(([name, value]) => [name, value ? "available" : "missing"]),
      ),
    },
    groups: groupMapNodes(nodes),
    framework: project.frameworkDetails,
    nodes,
    edges,
  };
  writeArtifact(config, "map.json", artifact);
  return artifact;
}

function analyzeModule(config, file, tsProject) {
  const id = relativeModuleId(config.projectRoot, file.path);
  const typed = tsProject.modules.get(id) ?? null;
  const imports = extractImports(config, file, id);
  const functions = extractFunctions(file);
  const types = extractTypes(file);
  const exports = extractExports(file);
  const components = functions.filter((fn) => fn.kind === "component");
  const escapeCounts = {
    any: countMatches(file.text, /\bany\b/g),
    assertions: countMatches(file.text, /\bas\s+(?:any|never|unknown|[A-Z_a-z])/g) + countMatches(file.text, /!\./g),
    suppressions: countMatches(file.text, /@ts-(?:ignore|expect-error|nocheck)|eslint-disable/g),
  };
  return {
    id,
    file: file.relativePath,
    absolutePath: file.path,
    lines: file.lines.length,
    imports,
    functions,
    components,
    types,
    exports,
    escapeCounts,
    isBarrel: isBarrel(file),
    typed,
    text: file.text,
    sourceFile: file,
  };
}

function extractImports(config, file, fromId) {
  const imports = [];
  const re =
    /import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = re.exec(file.text))) {
    const specifier = match[2] ?? match[3] ?? match[4];
    if (!specifier) continue;
    const importKind = match[4] ? "dynamic" : match[1] ? "type" : "static";
    const normalized = normalizeImportPath(file.path, specifier, config);
    imports.push({
      from: fromId,
      to: normalized.id,
      to_kind: normalized.kind === "external" ? "external" : normalized.kind === "relative" ? "relative" : "unresolved",
      resolved: normalized.resolved,
      specifier,
      import_kind: importKind,
      line: lineForIndex(file.text, match.index),
      source: match[0].replace(/\s+/g, " ").slice(0, 180),
    });
  }
  return imports;
}

function extractFunctions(file) {
  const records = [];
  const patterns = [
    /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g,
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /\b(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(file.text))) {
      const name = match[1] || "default";
      const bodyStart = file.text.indexOf("{", match.index);
      const bodyEnd = findMatchingBrace(file.text, bodyStart);
      const body = bodyEnd > bodyStart ? file.text.slice(bodyStart, bodyEnd + 1) : "";
      const line = lineForIndex(file.text, match.index);
      const lines = body.split(/\r?\n/).length;
      const jsxDensity = countMatches(body, /<[A-Z_a-z][^>]*>/g);
      const hooks = countMatches(body, /\buse[A-Z][A-Za-z0-9_]*\s*\(/g);
      const effects = countMatches(body, /\buse(?:Effect|LayoutEffect|InsertionEffect)\s*\(/g);
      const jsxConditionals = countMatches(body, /\?\s*<|&&\s*<|\.map\s*\([^)]*=>\s*</g);
      const kind = classifyFunction(name, body, jsxDensity);
      records.push({
        id: `${file.relativePath}:${name}:${line}`,
        name,
        kind,
        line,
        lines,
        complexity: complexityForText(body),
        nesting_depth: maxNestingDepth(body),
        jsx_density: jsxDensity,
        hooks,
        effects,
        jsxConditionals,
      });
    }
  }
  return dedupeBy(records, (record) => record.id);
}

function extractTypes(file) {
  const records = [];
  const re = /\b(export\s+)?(interface|type|class)\s+([A-Za-z_$][\w$]*)[^{=]*(?:\{|=)/g;
  let match;
  while ((match = re.exec(file.text))) {
    const start = file.text.indexOf(match[2] === "type" ? "=" : "{", match.index);
    const end = match[2] === "type" ? findStatementEnd(file.text, start) : findMatchingBrace(file.text, start);
    const body = end > start ? file.text.slice(start, end + 1) : "";
    records.push({
      name: match[3],
      kind: match[2],
      exported: Boolean(match[1]),
      line: lineForIndex(file.text, match.index),
      field_count: countTypeFields(body),
      optional_count: countMatches(body, /\w+\??\s*:/g) - countMatches(body, /\w+\s*:/g),
      union_members: countMatches(body, /\|/g),
      generic_params: countGenericParams(match[0]),
      body,
    });
  }
  return records;
}

function extractExports(file) {
  const records = [];
  const re = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)|\bexport\s*\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(file.text))) {
    if (match[1]) {
      records.push({ name: match[1], line: lineForIndex(file.text, match.index) });
    } else if (match[2]) {
      for (const name of match[2].split(",").map((part) => part.trim().split(/\s+as\s+/)[0].trim())) {
        if (name) records.push({ name, line: lineForIndex(file.text, match.index) });
      }
    }
  }
  return records;
}

function fileHotspotRecord(module) {
  const branchCount = countMatches(module.text, /\b(if|for|while|switch|catch|case)\b|\?|\&\&|\|\|/g);
  const score = Math.round(module.lines * 0.3 + branchCount * 4 + module.imports.length * 2);
  return {
    id: `file:${module.id}`,
    kind: "file",
    module_id: module.id,
    file: module.file,
    line: 1,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "line_count", value: module.lines },
      { kind: "branch_count", value: branchCount },
      { kind: "import_count", value: module.imports.length },
    ],
  };
}

function functionHotspotRecord(module, fn) {
  const score = Math.round(
    fn.complexity * 8 + fn.nesting_depth * 5 + fn.lines * 0.4 + fn.jsx_density * 2 + fn.jsxConditionals * 6,
  );
  return {
    id: fn.id,
    kind: fn.kind,
    module_id: module.id,
    file: module.file,
    name: fn.name,
    line: fn.line,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "cognitive_complexity_proxy", value: fn.complexity },
      { kind: "nesting_depth", value: fn.nesting_depth },
      { kind: "line_count", value: fn.lines },
      ...(fn.jsx_density ? [{ kind: "jsx_density", value: fn.jsx_density }] : []),
      ...(fn.jsxConditionals ? [{ kind: "render_branch_complexity", value: fn.jsxConditionals }] : []),
    ],
  };
}

function escapeRecords(module) {
  const specs = [
    ["explicit_any", /\bany\b/g, "medium"],
    ["unknown_without_narrowing", /\bunknown\b/g, "low"],
    ["non_null_assertion", /[A-Za-z0-9_$\])]\s*!\s*(?:[.;,\)\]\}]|\.|\[)/g, "medium"],
    ["type_assertion", /\bas\s+(?:any|never|unknown|[A-Za-z_$][\w$.<>]*)/g, "medium"],
    ["double_assertion", /\bas\s+(?:unknown|any)\s+as\s+/g, "high"],
    ["ts_suppression", /@ts-(?:ignore|expect-error|nocheck)/g, "high"],
    ["eslint_suppression", /eslint-disable(?:-next-line)?/g, "medium"],
    ["dangerous_html", /dangerouslySetInnerHTML/g, "high"],
    ["eval_like_api", /\b(?:eval|Function)\s*\(/g, "high"],
    ["direct_dom_mutation", /\bdocument\.(?:querySelector|getElementById)|\.innerHTML\s*=/g, "medium"],
    ["module_level_mutable_state", /^\s*(?:let|var)\s+[A-Za-z_$][\w$]*\s*=/gm, "medium"],
    ["browser_global", /\b(?:window|localStorage|sessionStorage)\./g, "low"],
  ];
  return specs.flatMap(([kind, re, severity]) => {
    const records = [];
    let match;
    while ((match = re.exec(module.text))) {
      records.push({
        id: `escape:${module.id}:${kind}:${lineForIndex(module.text, match.index)}:${match.index}`,
        module_id: module.id,
        file: module.file,
        kind,
        severity,
        line: lineForIndex(module.text, match.index),
        evidence: match[0].replace(/\s+/g, " ").slice(0, 120),
      });
    }
    return records;
  });
}

function typeHealthRecords(module) {
  const records = module.types.map((type) => {
    const signals = [];
    if (type.field_count > 10) signals.push({ kind: "wide_surface", value: type.field_count });
    if (type.union_members > 6) signals.push({ kind: "large_union", value: type.union_members });
    if (type.optional_count > 5) signals.push({ kind: "many_optional_fields", value: type.optional_count });
    if (type.generic_params > 3) signals.push({ kind: "many_type_parameters", value: type.generic_params });
    if (/\bany\b/.test(type.body)) signals.push({ kind: "weak_type_member", value: "any" });
    const score =
      type.field_count * 4 + type.union_members * 5 + type.optional_count * 3 + type.generic_params * 8 + signals.length * 8;
    return {
      id: `type:${module.id}:${type.name}:${type.line}`,
      module_id: module.id,
      file: module.file,
      name: type.name,
      kind: type.kind,
      exported: type.exported,
      line: type.line,
      score,
      risk: riskForScore(score),
      signals,
      metrics: {
        field_count: type.field_count,
        optional_count: type.optional_count,
        union_members: type.union_members,
        generic_params: type.generic_params,
      },
    };
  });
  for (const declaration of module.typed?.declarations ?? []) {
    if (records.some((record) => record.name === declaration.name && record.line === declaration.line)) continue;
    const weakType = !declaration.type || declaration.type === "any" || declaration.type === "Function";
    const score = weakType ? 45 : 10;
    records.push({
      id: `typed-symbol:${module.id}:${declaration.name}:${declaration.line}`,
      module_id: module.id,
      file: module.file,
      name: declaration.name,
      kind: declaration.kind,
      exported: declaration.exported,
      line: declaration.line,
      score,
      risk: riskForScore(score),
      source: "typescript-compiler-api",
      signals: weakType ? [{ kind: "weak_inferred_type", value: declaration.type ?? "unknown" }] : [],
      metrics: {
        inferred_type: declaration.type,
      },
    });
  }
  for (const exported of module.typed?.exports ?? []) {
    if (!exported.type || exported.type === "any") {
      records.push({
        id: `typed-export:${module.id}:${exported.name}`,
        module_id: module.id,
        file: module.file,
        name: exported.name,
        kind: "export",
        exported: true,
        line: null,
        score: 55,
        risk: "medium",
        source: "typescript-compiler-api",
        signals: [{ kind: "weak_export_type", value: exported.type ?? "unknown" }],
        metrics: {
          inferred_type: exported.type,
        },
      });
    }
  }
  return records;
}

function testRecord(config, file, modules) {
  const sameStem = file.relativePath
    .replace(/(?:\.test|\.spec|\.e2e)?\.[cm]?[jt]sx?$/, "")
    .replace(/\/__tests__\//, "/");
  const sourceMapping = modules
    .filter((module) => sameStem.endsWith(module.id) || module.id.endsWith(path.basename(sameStem)))
    .map((module) => module.file);
  return {
    id: `test:${file.relativePath}`,
    name: path.basename(file.relativePath),
    path: file.relativePath,
    framework: inferTestFramework(config, file.text),
    locality: sourceMapping.length > 0 ? "colocated" : "external",
    source_mapping: sourceMapping,
    assertions: countMatches(file.text, /\b(?:expect|assert|should)\s*(?:\(|\.)/g),
    skipped: countMatches(file.text, /\b(?:it|test|describe)\.skip\s*\(/g),
    todo: countMatches(file.text, /\b(?:it|test)\.todo\s*\(/g),
  };
}

function mapNode(module, artifacts) {
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

function groupMapNodes(nodes) {
  return [...groupBy(nodes, (node) => node.group).entries()].map(([id, groupNodes]) => ({
    id,
    label: id === "." ? "root" : id,
    node_count: groupNodes.length,
    risk_score: Math.max(0, ...groupNodes.map((node) => node.risk_score)),
  }));
}

function findCycles(edges) {
  const graph = new Map();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from).push(edge.to);
  }
  const cycles = new Set();
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

function canonicalCycle(cycle) {
  const bare = cycle.slice(0, -1);
  const rotations = bare.map((_, index) => [...bare.slice(index), ...bare.slice(0, index)]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...rotations[0], rotations[0][0]].join(" -> ");
}

function runTestCommand(config) {
  if (!config.testCommand) return { status: "unknown", reason: "No test command configured." };
  try {
    childProcess.execSync(config.testCommand, {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000,
    });
    return { status: "passed", command: config.testCommand };
  } catch (error) {
    return {
      status: "failed",
      command: config.testCommand,
      exit_code: error.status ?? null,
      stderr: String(error.stderr ?? "").slice(0, 4000),
      stdout: String(error.stdout ?? "").slice(0, 4000),
    };
  }
}

function gitChurn(config) {
  const result = new Map();
  try {
    const output = childProcess.execFileSync("git", ["log", "--name-only", "--format=%an"], {
      cwd: config.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    });
    let author = "unknown";
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (!/\.[cm]?[jt]sx?$/.test(line)) {
        author = line.trim();
        continue;
      }
      const current = result.get(toPosix(line)) ?? { commits: 0, contributors: 0, contributor_names: new Set() };
      current.commits += 1;
      current.contributor_names.add(author);
      current.contributors = current.contributor_names.size;
      result.set(toPosix(line), current);
    }
  } catch {
    return result;
  }
  for (const [key, value] of result) {
    result.set(key, {
      commits: value.commits,
      contributors: value.contributors,
    });
  }
  return result;
}

function hiddenCouplingSignals(module) {
  const specs = [
    ["window_global", /\bwindow\./g],
    ["local_storage", /\blocalStorage\./g],
    ["session_storage", /\bsessionStorage\./g],
    ["event_bus", /\b(?:EventEmitter|mitt|eventBus|publish|subscribe)\b/g],
    ["react_context", /\b(?:createContext|useContext)\s*\(/g],
    ["singleton_registry", /\b(?:registry|singleton)\b/gi],
  ];
  return specs.flatMap(([kind, re]) => {
    const records = [];
    let match;
    while ((match = re.exec(module.text))) {
      records.push({ kind, line: lineForIndex(module.text, match.index) });
    }
    return records;
  });
}

function complexityForText(text) {
  return (
    1 +
    countMatches(text, /\b(if|else if|for|for await|while|case|catch)\b/g) +
    countMatches(text, /\?|&&|\|\|/g) +
    countMatches(text, /\bawait\b/g) +
    countMatches(text, /\btry\b/g)
  );
}

function maxNestingDepth(text) {
  let depth = 0;
  let max = 0;
  for (const char of text) {
    if (char === "{") {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

function findMatchingBrace(text, start) {
  if (start < 0) return -1;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return text.length - 1;
}

function findStatementEnd(text, start) {
  const semicolon = text.indexOf(";", start);
  const newlineDouble = text.indexOf("\n\n", start);
  if (semicolon >= 0) return semicolon;
  if (newlineDouble >= 0) return newlineDouble;
  return text.length - 1;
}

function classifyFunction(name, body, jsxDensity) {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name) && (jsxDensity > 0 || /\bReact\./.test(body))) return "component";
  if (/\bswitch\s*\([^)]*(?:state|action)/.test(body) || /\bcase\s+["']/.test(body)) return "reducer";
  return "function";
}

function isBarrel(file) {
  const statements = file.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  return statements.length > 1 && statements.every((line) => line.startsWith("export "));
}

function countTypeFields(body) {
  return countMatches(body, /(?:^|[;,{]\s*)(?:readonly\s+)?[A-Za-z_$][\w$-]*\??\s*:/g);
}

function countGenericParams(text) {
  const match = text.match(/<([^>]+)>/);
  return match ? match[1].split(",").filter(Boolean).length : 0;
}

function countMatches(text, re) {
  return [...text.matchAll(re)].length;
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function countBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCloneLine(line) {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "STRING")
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUMBER")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, (word) =>
      ["if", "else", "for", "while", "return", "const", "let", "function", "export", "import", "from"].includes(word)
        ? word
        : "ID",
    );
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cloneGroup(group) {
  const files = new Set(group.map((block) => block.file));
  const testCode = group.every((block) => block.test_code);
  const score = Math.min(100, group.length * 10 + files.size * 16 + (testCode ? 0 : 10));
  return {
    id: `clone:${group[0].hash}`,
    engine: "line-window-normalized",
    hash: group[0].hash,
    classification: testCode ? "test_clone" : "source_clone",
    test_code: testCode,
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "instance_count", value: group.length },
      { kind: "file_count", value: files.size },
    ],
    instances: group.map((block) => ({
      file: block.file,
      start_line: block.start_line,
      end_line: block.end_line,
    })),
  };
}

function jscpdCloneGroup(config, duplicate, index) {
  const first = duplicate.firstFile ?? {};
  const second = duplicate.secondFile ?? {};
  const instances = [first, second]
    .filter((item) => item.name)
    .map((item) => ({
      file: toPosix(path.relative(config.projectRoot, path.resolve(item.name))),
      start_line: item.start ?? item.startLoc?.line ?? null,
      end_line: item.end ?? item.endLoc?.line ?? null,
    }));
  const fileCount = new Set(instances.map((item) => item.file)).size;
  const lines = duplicate.lines ?? duplicate.fragment?.split(/\r?\n/).length ?? 0;
  const score = Math.min(100, lines * 4 + fileCount * 18 + 15);
  return {
    id: `jscpd:${duplicate.format ?? "unknown"}:${index + 1}`,
    engine: "jscpd",
    hash: duplicate.hash ?? null,
    classification: instances.every((item) => /(?:\.test|\.spec)\.[jt]sx?$/.test(item.file)) ? "test_clone" : "source_clone",
    test_code: instances.every((item) => /(?:\.test|\.spec)\.[jt]sx?$/.test(item.file)),
    score,
    risk: riskForScore(score),
    signals: [
      { kind: "line_count", value: lines },
      { kind: "file_count", value: fileCount },
      { kind: "format", value: duplicate.format ?? "unknown" },
    ],
    instances,
  };
}

function inferTestFramework(config, text) {
  if (config.testRunner !== "unknown") return config.testRunner;
  if (/\bimport\s+\{[^}]*test[^}]*\}\s+from\s+["']node:test/.test(text)) return "node";
  if (/\bvi\./.test(text)) return "vitest";
  if (/\bjest\./.test(text)) return "jest";
  return "unknown";
}

function maxScoreFor(records = [], file, mode = "score") {
  const candidates = records.filter((record) => record.file === file || record.files?.includes(file));
  if (mode === "severity") {
    return Math.max(
      0,
      ...candidates.map((record) => ({ high: 75, medium: 45, low: 20 }[record.severity] ?? record.score ?? 0)),
    );
  }
  return Math.max(0, ...candidates.map((record) => record.score ?? 0));
}

function dependencyCruiserEdges(config, modules) {
  return modules.flatMap((module) => {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    if (!from) return [];
    return (module.dependencies ?? []).map((dependency) => ({
      from,
      to: dependency.resolved ? stripSourceExtension(toPosix(dependency.resolved)) : dependency.module,
      kind: dependency.coreModule || dependency.npm ? "external" : dependency.resolved ? "relative" : "unresolved",
      import_kind: dependency.dependencyTypes?.includes("dynamic") ? "dynamic" : "static",
      line: dependency.moduleSystem === "es6" ? null : null,
      source: "dependency-cruiser",
    }));
  });
}

function dependencyCruiserCycles(config, modules) {
  const cycles = [];
  for (const module of modules) {
    const from = module.source ? stripSourceExtension(toPosix(module.source)) : null;
    for (const dependency of module.dependencies ?? []) {
      for (const cycle of dependency.cycle ?? []) {
        const files = [from, ...cycle.map((item) => stripSourceExtension(toPosix(item.name ?? item)))]
          .filter(Boolean)
          .map((file) => stripProjectPrefix(config, file));
        if (files.length > 1) cycles.push(files);
      }
    }
  }
  return dedupeBy(cycles, (cycle) => canonicalCycle([...cycle, cycle[0]]));
}

function uniqueCycleCount(...cycleSets) {
  return new Set(
    cycleSets.flat().map((cycle) => {
      if (!cycle.length) return "";
      const closed = cycle[0] === cycle.at(-1) ? cycle : [...cycle, cycle[0]];
      return canonicalCycle(closed);
    }),
  ).size;
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

function riskForScore(score) {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}
