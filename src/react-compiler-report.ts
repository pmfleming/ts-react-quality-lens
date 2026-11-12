import path from "node:path";
import semver from "semver";
import { discoverSourceFiles, readSourceFile } from "./files.js";
import { stableHash } from "./clone-utils.js";
import { arrayOf, boolean, count, nonempty, nonnegative, nullable, oneOf, optional, positiveInteger, shape } from "./validation.js";
import type { Config, ScoredRecord } from "./types.js";

export type ImportedEvidence = { records: ScoredRecord[]; complete: boolean; reason: string | null; metadata: Record<string, unknown> };
const functionEntry = shape({ id: nonempty, file: nonempty, line: positiveInteger, name: nonempty });
const eventEntry = shape({ function_id: nullable(nonempty), kind: oneOf("CompileSuccess", "CompileError", "CompileSkip", "CompileDiagnostic", "PipelineError", "Timing"),
  reason: optional(nonempty), duration_ms: optional(nonnegative) });
const report = shape({ format: oneOf("react-compiler-report-v1"), compiler: shape({ name: oneOf("babel-plugin-react-compiler"), version: nonempty }),
  scope: shape({ name: nonempty, complete: boolean, functions: arrayOf(functionEntry) }), events: arrayOf(eventEntry) });
const environmentShape = shape({ build_id: nonempty, react_version: nonempty, target: oneOf("17", "18", "19") });
const TERMINAL = new Set(["CompileSuccess", "CompileError", "CompileSkip"]);

/** Versioned normalization of logger output, not a compiler invocation or raw logger schema. */
export function compilerExecutionRecords(config: Config, value: unknown, environment: Record<string, unknown>, sourceVerified = false): ImportedEvidence {
  if (!report(value) || !environmentShape(environment) || !semver.valid(value.compiler.version) || !semver.valid(environment.react_version)) {
    throw new Error("Expected react-compiler-report-v1 with compiler version, scope inventory, events, and build_id/react_version/target environment.");
  }
  const sources = new Map(discoverSourceFiles(config).map((file) => {
    const input = readSourceFile(file, config.projectRoot); return [input.relativePath, input.text.split(/\r?\n/).length] as const;
  }));
  const inventory = new Map<string, (typeof value.scope.functions)[number]>();
  const locations = new Set<string>();
  for (const fn of value.scope.functions) {
    const location = `${fn.file}:${fn.line}:${fn.name}`;
    if (inventory.has(fn.id) || locations.has(location) || path.isAbsolute(fn.file) || fn.file.includes("\\") ||
        !sources.has(fn.file) || fn.line > sources.get(fn.file)!) throw new Error(`Invalid or duplicate compiler function inventory entry: ${fn.id}.`);
    inventory.set(fn.id, fn); locations.add(location);
  }
  const terminal = new Map<string, string>();
  let pipelineErrors = 0;
  const occurrences = new Map<string, number>();
  const records = value.events.map((event): ScoredRecord => {
    const fn = event.function_id === null ? undefined : inventory.get(event.function_id);
    if ((!fn && event.kind !== "PipelineError") || (event.function_id !== null && !fn) ||
        (["CompileError", "CompileSkip", "CompileDiagnostic", "PipelineError"].includes(event.kind) && !event.reason) ||
        (event.kind === "Timing" && event.duration_ms === undefined)) throw new Error(`Invalid compiler event: ${event.kind}.`);
    if (event.kind === "PipelineError") pipelineErrors++;
    if (TERMINAL.has(event.kind)) {
      if (terminal.has(event.function_id!)) throw new Error(`Duplicate compiler outcome for ${event.function_id}.`);
      terminal.set(event.function_id!, event.kind);
    }
    const identity = `${event.function_id ?? "global"}:${event.kind}:${event.reason ?? ""}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1; occurrences.set(identity, occurrence);
    return { id: `react-compiler:${stableHash(identity)}:${occurrence}`, source: "react-compiler-report",
      rule_id: `react-compiler/${event.kind}`, kind: "react_compiler_observation", evidence_kind: event.kind === "Timing" ? "metric" : "tool-rule",
      disposition: event.kind === "CompileSuccess" || event.kind === "Timing" ? "info" : "review", finding_confidence: "high",
      semantic_decision: "unresolved", scope: fn ? "file" : "project", ...(fn ? { file: fn.file, line: fn.line, name: fn.name } : {}),
      score: 0, risk: "low", message: `Imported ${event.kind}${fn ? ` for ${fn.name}` : ""}${event.reason ? `: ${event.reason}` : "."}`,
      compiler: value.compiler, compiler_event: event.kind, function_id: event.function_id,
      ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
      guidance_url: "https://react.dev/reference/react-compiler/logger", signals: [{ kind: event.kind }],
    };
  });
  const succeeded = [...terminal.values()].filter((kind) => kind === "CompileSuccess").length;
  const skipped = [...terminal.values()].filter((kind) => kind === "CompileSkip").length;
  const errors = [...terminal.values()].filter((kind) => kind === "CompileError").length;
  const complete = value.scope.complete && terminal.size === inventory.size && pipelineErrors === 0;
  return { records, complete, reason: complete ? null : "Compiler scope is partial, function outcomes are missing, or the compiler pipeline failed.",
    metadata: { compiler: value.compiler, scope: value.scope.name, inventory_functions: inventory.size, observed_outcomes: terminal.size,
      compiled_functions: succeeded, skipped_functions: skipped, errored_functions: errors, pipeline_errors: pipelineErrors,
      reported_coverage: { status: !sourceVerified ? "unverified" : complete ? "complete" : "partial", percent: sourceVerified && complete && inventory.size > 0 ? succeeded / inventory.size * 100 : null },
      limitation: "Imported build observations describe only the declared function inventory. Compilation success is not proof of runtime correctness or performance improvement." } };
}

const observation = shape({ compiler_event: oneOf("CompileSuccess", "CompileError", "CompileSkip", "CompileDiagnostic", "PipelineError", "Timing"),
  function_id: nullable(nonempty), disposition: oneOf("info", "review"), compiler: shape({ name: oneOf("babel-plugin-react-compiler"), version: nonempty }) });
export function validCompilerObservation(value: unknown): boolean {
  return observation(value) && Boolean(semver.valid(value.compiler.version)) &&
    (value.compiler_event !== "Timing" || nonnegative(value.duration_ms)) &&
    (value.function_id === null ? value.compiler_event === "PipelineError" : nonempty(value.file) && positiveInteger(value.line));
}
const metadata = shape({ inventory_functions: count, observed_outcomes: count, compiled_functions: count, skipped_functions: count,
  errored_functions: count, pipeline_errors: count, reported_coverage: shape({ status: oneOf("complete", "partial", "unverified"), percent: nullable(nonnegative) }) });
export function validCompilerMetadata(value: unknown, verified: boolean): boolean {
  if (!metadata(value) || value.observed_outcomes !== value.compiled_functions + value.skipped_functions + value.errored_functions ||
      value.observed_outcomes > value.inventory_functions || !verified && value.reported_coverage.status !== "unverified") return false;
  const complete = verified && value.reported_coverage.status === "complete";
  return (!complete || value.pipeline_errors === 0 && value.observed_outcomes === value.inventory_functions) &&
    value.reported_coverage.percent === (complete && value.inventory_functions > 0 ? value.compiled_functions / value.inventory_functions * 100 : null);
}
