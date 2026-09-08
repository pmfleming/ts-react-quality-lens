import { enrichArtifactFindings } from "./actions.js";
import { createAnalysisContext } from "./analysis-context.js";
import { MEASURE_ORDER, MEASURE_TASKS } from "./measures/registry.js";
import { findTask, TASKS } from "./tasks.js";
import type { AnalysisContext, Artifact, Config } from "./types.js";
export type RunMeasureOptions = {
  context?: AnalysisContext;
  skipPrerequisites?: boolean;
  allowTestExecution?: boolean;
};
export function runMeasure(config: Config, taskId: string, command: string, options: RunMeasureOptions = {}): Artifact[] {
  const context = options.context ?? createAnalysisContext(config);
  if (taskId === "correctness.all" && options.allowTestExecution === false) {
    throw new Error("Test execution requires explicit permission. Use the run_tests tool.");
  }
  if (taskId === "all") return MEASURE_ORDER
    .filter((id) => options.allowTestExecution !== false || id !== "correctness.all")
    .flatMap((id) => runMeasure(config, id, command, { ...options, skipPrerequisites: true, context }));
  const task = MEASURE_TASKS.get(taskId);
  if (!findTask(taskId) || !task) {
    throw new Error(`Unknown task id: ${taskId}. Available task ids: all, ${TASKS.map((item) => item.id).join(", ")}`);
  }
  if (!options.skipPrerequisites) ensurePrerequisites(config, command, task.prerequisites ?? [], context);
  return [enrichArtifactFindings(config, task.handler(config, command, context))];
}
function ensurePrerequisites(config: Config, command: string, taskIds: string[], context: AnalysisContext): void {
  for (const taskId of taskIds) runMeasure(config, taskId, command, { context });
}
