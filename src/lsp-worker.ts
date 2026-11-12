import { parentPort, workerData } from "node:worker_threads";
import { isSuppressed } from "./actions.js";
import { createAnalysisContext } from "./analysis-context.js";
import { artifactFindings } from "./findings.js";
import { runMeasure } from "./measure-runner.js";
import { savedModernWebFindings } from "./measures/modern-web.js";
import { decodeEditorRequest } from "./lsp-protocol.js";

const tasks = [
  "quality.type_health", "quality.lint", "quality.dependency_health", "quality.react_health",
  "quality.cleanup", "quality.sarif", "quality.runtime",
];

const config = decodeEditorRequest(workerData);
const context = createAnalysisContext(config);
const findings = [...tasks.flatMap((taskId) => runMeasure(config, taskId, `lsp ${taskId}`, {
  context, allowTestExecution: false,
}).flatMap(artifactFindings)), ...savedModernWebFindings(config)].filter((finding) => !isSuppressed(finding));
parentPort?.postMessage({ version: 1, findings });
