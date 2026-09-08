import { enrichArtifactFindings } from "./actions.js";
import { createAnalysisContext } from "./analysis-context.js";
import { MEASURE_ORDER, MEASURE_TASKS } from "./measures/registry.js";
import { analysisIdentity, sourceSetHash, taskInputHash } from "./provenance.js";
import { findTask, TASKS } from "./tasks.js";
import { readArtifact } from "./writer.js";
import type { AnalysisContext, Artifact, Config } from "./types.js";

export type RunMeasureOptions = {
  context?: AnalysisContext;
  skipPrerequisites?: boolean;
  allowTestExecution?: boolean;
};

type RunState = {
  context: AnalysisContext;
  completed: Set<string>;
  visiting: Set<string>;
  options: RunMeasureOptions;
};

export function runMeasure(config: Config, taskId: string, command: string, options: RunMeasureOptions = {}): Artifact[] {
  const state: RunState = {
    context: options.context ?? createAnalysisContext(config), completed: new Set(), visiting: new Set(), options,
  };
  return measureTask(config, taskId, command, state);
}

function measureTask(config: Config, taskId: string, command: string, state: RunState): Artifact[] {
  if (taskId === "correctness.all" && state.options.allowTestExecution === false) {
    throw new Error("Test execution requires explicit permission. Use the run_tests tool.");
  }
  if (taskId === "all") return MEASURE_ORDER
    .filter((id) => state.options.allowTestExecution !== false || id !== "correctness.all")
    .flatMap((id) => measureTask(config, id, command, state));
  const task = MEASURE_TASKS.get(taskId);
  if (!findTask(taskId) || !task) {
    throw new Error(`Unknown task id: ${taskId}. Available task ids: all, ${TASKS.map((item) => item.id).join(", ")}`);
  }
  if (state.completed.has(taskId)) return [];
  if (state.visiting.has(taskId)) throw new Error(`Circular measurement prerequisite: ${taskId}`);
  state.visiting.add(taskId);
  if (!state.options.skipPrerequisites) {
    for (const prerequisite of task.prerequisites ?? []) {
      // Mapping must not erase a current test run merely to refresh the catalog.
      if (prerequisite === "correctness.catalog" && currentTestExecution(config, state.context)) {
        state.completed.add(prerequisite);
      } else measureTask(config, prerequisite, command, state);
    }
  }
  const result = enrichArtifactFindings(config, task.handler(config, command, state.context));
  state.completed.add(taskId);
  state.visiting.delete(taskId);
  return [result];
}

function currentTestExecution(config: Config, context: AnalysisContext): boolean {
  const review = readArtifact(config, "correctness_review.json");
  if (review?.task_id !== "correctness.all" || !["passed", "failed"].includes(review.execution?.status ?? "")) return false;
  const catalog = readArtifact(config, "test_catalog.json");
  if (!catalog) return false;
  const identity = analysisIdentity(config);
  const sourceHash = sourceSetHash(context.project());
  return review.analysis_identity?.id === identity.id && catalog.analysis_identity?.id === identity.id &&
    review.provenance.input_set_hash === taskInputHash(config, "correctness.all", sourceHash, identity) &&
    catalog.provenance.input_set_hash === taskInputHash(config, "correctness.catalog", sourceHash, identity);
}
