import { loadConfig } from "./config.js";
import { catalogForConfig, findTask, TASKS } from "./tasks.js";
import { createAnalysisContext } from "./measure-support.js";
import { MEASURE_ORDER, MEASURE_TASKS } from "./measures/registry.js";

type AnalysisContext = ReturnType<typeof createAnalysisContext>;

type RunMeasureOptions = {
  context?: AnalysisContext;
  skipPrerequisites?: boolean;
};

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    printHelp();
    return;
  }

  const config = loadConfig(args.config);
  if (args.command === "catalog") {
    console.log(JSON.stringify(catalogForConfig(config), null, 2));
    return;
  }

  if (args.command !== "measure") {
    throw new Error(`Unknown command: ${args.command}`);
  }

  const taskId = args.positionals[0] ?? "all";
  const command = `ts-react-quality-lens measure ${taskId} --config ${config.configPath}`;
  const results = runMeasure(config, taskId, command);
  console.log(
    JSON.stringify(
      {
        project_name: config.projectName,
        output_dir: config.outputDir,
        measured: results.map((result) => ({
          task_id: result.task_id,
          summary: result.summary,
        })),
      },
      null,
      2,
    ),
  );
}

export function runMeasure(config, taskId, command, options: RunMeasureOptions = {}) {
  const context = options.context ?? createAnalysisContext(config);
  if (taskId === "all") {
    const results = [];
    for (const id of MEASURE_ORDER) {
      results.push(...runMeasure(config, id, command, { skipPrerequisites: true, context }));
    }
    return results;
  }

  const task = MEASURE_TASKS.get(taskId);
  if (!findTask(taskId) || !task) {
    throw new Error(`Unknown task id: ${taskId}`);
  }

  if (!options.skipPrerequisites) ensurePrerequisites(config, command, task.prerequisites ?? [], context);
  return [task.handler(config, command, context)];
}

function ensurePrerequisites(config, command, taskIds, context) {
  for (const taskId of taskIds) {
    runMeasure(config, taskId, command, { context });
  }
}

function parseArgs(argv) {
  const result = { command: null, config: null, help: false, positionals: [] };
  const args = [...argv];
  result.command = args.shift() ?? null;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--config" || arg === "-c") {
      result.config = args.shift();
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}

function printHelp() {
  console.log(`ts-react-quality-lens

Usage:
  ts-react-quality-lens catalog --config ./ts-react-quality-lens.config.json
  ts-react-quality-lens measure <task-id|all> --config ./ts-react-quality-lens.config.json

Commands:
  catalog       Print board-compatible task metadata.
  measure       Write one task artifact or all artifacts.
`);
}
