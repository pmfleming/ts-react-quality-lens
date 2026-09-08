import { parentPort, workerData } from "node:worker_threads";
import { isSuppressed } from "./actions.js";
import { createAnalysisContext } from "./analysis-context.js";
import { artifactFindings } from "./findings.js";
import { runMeasure } from "./measure-runner.js";
import type { Config } from "./types.js";

const tasks = [
  "quality.type_health", "quality.lint", "quality.dependency_health", "quality.react_health",
  "quality.cleanup", "quality.sarif", "quality.runtime",
];

const config = workerData as Config;
const context = createAnalysisContext(config);
const findings = tasks.flatMap((taskId) => runMeasure(config, taskId, `lsp ${taskId}`, {
  context, allowTestExecution: false,
}).flatMap(artifactFindings)).filter((finding) => !isSuppressed(finding));
parentPort?.postMessage(findings);
