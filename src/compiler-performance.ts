import crypto from "node:crypto";
import path from "node:path";
import * as ts from "typescript";
import { isRecord } from "./collections.js";
import { arrayOf, boolean, count, nonempty, nonnegative, nullable, oneOf, shape } from "./validation.js";
import type { Config, ProjectAnalysis, SourceFileRecord } from "./types.js";

export type CompilerPerformanceSample = {
  sample_id: string;
  captured_at: string;
  compiler_version: string;
  node_version: string;
  platform: string;
  arch: string;
  checking_options: { skip_lib_check: boolean; skip_default_lib_check: boolean; no_emit: boolean };
  phases_ms: { program_creation: number; checker_initialization: number; diagnostics: number };
  counters: { nodes: number | null; identifiers: number | null; symbols: number | null; types: number | null; instantiations: number | null };
  files: Array<{ file: string; root: boolean; selected: boolean; declaration: boolean; default_library: boolean; external_library: boolean }>;
};

export function compilerPerformanceSample(program: ts.Program, config: Config, selected: SourceFileRecord[], phases: CompilerPerformanceSample["phases_ms"]): CompilerPerformanceSample {
  const selectedFiles = new Set(selected.map((file) => path.resolve(file.path)));
  const roots = new Set(program.getRootFileNames().map((file) => path.resolve(file)));
  return {
    sample_id: crypto.randomUUID(), captured_at: new Date().toISOString(), compiler_version: ts.version,
    node_version: process.version, platform: process.platform, arch: process.arch, phases_ms: phases,
    checking_options: { skip_lib_check: Boolean(program.getCompilerOptions().skipLibCheck),
      skip_default_lib_check: Boolean(program.getCompilerOptions().skipDefaultLibCheck), no_emit: Boolean(program.getCompilerOptions().noEmit) },
    counters: { nodes: counter("getNodeCount"), identifiers: counter("getIdentifierCount"), symbols: counter("getSymbolCount"),
      types: counter("getTypeCount"), instantiations: counter("getInstantiationCount") },
    files: program.getSourceFiles().map((file) => ({
      file: path.relative(config.projectRoot, file.fileName).replace(/\\/g, "/"),
      root: roots.has(path.resolve(file.fileName)), selected: selectedFiles.has(path.resolve(file.fileName)),
      declaration: file.isDeclarationFile, default_library: program.isSourceFileDefaultLibrary(file),
      external_library: program.isSourceFileFromExternalLibrary(file),
    })).sort((a, b) => a.file.localeCompare(b.file)),
  };

  function counter(name: string): number | null {
    const api: unknown = program;
    if (!isRecord(api) || typeof api[name] !== "function") return null;
    try {
      const value: unknown = Reflect.apply(api[name], program, []);
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  }
}

export function compilerPerformanceEvidence(config: Config, project: ProjectAnalysis) {
  const projects = config.typescript.measurePerformance ? (project.tsProject.project_configs ?? []).map((item) => ({
    tsconfig: item.tsconfig, status: item.performance ? "measured" as const : "unavailable" as const,
    observation_reused: item.performance ? project.cache.reused : false,
    reason: item.performance ? null : item.reason ?? "No compiler measurement was captured.",
    sample: item.performance ?? null,
    program_scope: item.performance ? scopeCounts(item.performance) : null,
  })) : [];
  return {
    status: !config.typescript.measurePerformance ? "disabled" : !projects.length || projects.some((item) => item.status === "unavailable") ? "incomplete" : "complete",
    projects,
    timing_scope: "Monotonic wall-clock durations for Program construction, checker initialization and pre-emit diagnostics in the lens analysis process; no emit. Config parsing and lens extraction are excluded. Not CLI parse/bind/check timings, native-compiler timings, or a build benchmark.",
    limitations: "One observation per analyzed config; OS/filesystem/JIT warmness uncontrolled. Cached observations retain their original sample identity/time. Overlapping project inputs are not summed. Counters are compiler-specific and null when unavailable. No speed thresholds, regression verdicts, or type-level hotspot claims.",
  };
}

function scopeCounts(sample: CompilerPerformanceSample) {
  return { program_files: sample.files.length, root_files: sample.files.filter((file) => file.root).length,
    selected_files: sample.files.filter((file) => file.selected).length,
    declaration_files: sample.files.filter((file) => file.declaration).length,
    default_library_files: sample.files.filter((file) => file.default_library).length,
    external_library_files: sample.files.filter((file) => file.external_library).length,
    unselected_source_files: sample.files.filter((file) => !file.selected && !file.declaration).length };
}

const sampleShape = shape({ sample_id: nonempty, captured_at: nonempty, compiler_version: nonempty, node_version: nonempty, platform: nonempty, arch: nonempty,
  checking_options: shape({ skip_lib_check: boolean, skip_default_lib_check: boolean, no_emit: boolean }),
  phases_ms: shape({ program_creation: nonnegative, checker_initialization: nonnegative, diagnostics: nonnegative }),
  counters: shape({ nodes: nullable(count), identifiers: nullable(count), symbols: nullable(count), types: nullable(count), instantiations: nullable(count) }),
  files: arrayOf(shape({ file: nonempty, root: boolean, selected: boolean, declaration: boolean, default_library: boolean, external_library: boolean })) });
const reportShape = shape({ status: oneOf("disabled", "complete", "incomplete"), projects: arrayOf(shape({ tsconfig: nonempty,
  status: oneOf("measured", "unavailable"), observation_reused: boolean, reason: nullable(nonempty), sample: nullable(sampleShape), program_scope: nullable(isRecord) })) });

export function validCompilerPerformanceReport(value: unknown): boolean {
  if (!reportShape(value)) return false;
  if (value.status === "disabled") return value.projects.length === 0;
  if ((value.projects.length > 0 && value.projects.every((item) => item.status === "measured")) !== (value.status === "complete")) return false;
  return value.projects.every((item) => {
    if (item.status === "unavailable") return item.sample === null && item.program_scope === null && !item.observation_reused && item.reason !== null;
    if (!item.sample || !item.program_scope || item.reason !== null || !item.sample.checking_options.no_emit || !Number.isFinite(Date.parse(item.sample.captured_at))) return false;
    if (new Set(item.sample.files.map((file) => file.file)).size !== item.sample.files.length) return false;
    return Object.entries(scopeCounts(item.sample)).every(([key, count]) => item.program_scope?.[key] === count);
  });
}
