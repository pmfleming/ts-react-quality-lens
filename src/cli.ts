import { loadConfig } from "./config.js";
import { catalogForConfig, findTask, TASKS } from "./tasks.js";
import { createAnalysisContext } from "./analysis-context.js";
import { MEASURE_ORDER, MEASURE_TASKS } from "./measures/registry.js";
import type { AnalysisContext, Artifact, Config } from "./types.js";

type RunMeasureOptions = {
  context?: AnalysisContext;
  skipPrerequisites?: boolean;
};

type ParsedArgs = {
  command: string | null;
  config: string | null;
  help: boolean;
  positionals: string[];
};

export async function runCli(argv: string[]): Promise<void> {
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
        measured: results.map((result: Artifact) => ({
          task_id: result.task_id,
          summary: result.summary,
        })),
      },
      null,
      2,
    ),
  );
}

export function runMeasure(config: Config, taskId: string, command: string, options: RunMeasureOptions = {}): Artifact[] {
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
    throw new Error(`Unknown task id: ${taskId}. Available task ids: all, ${TASKS.map((item) => item.id).join(", ")}`);
  }

  if (!options.skipPrerequisites) ensurePrerequisites(config, command, task.prerequisites ?? [], context);
  return [task.handler(config, command, context)];
}

function ensurePrerequisites(config: Config, command: string, taskIds: string[], context: AnalysisContext): void {
  for (const taskId of taskIds) {
    runMeasure(config, taskId, command, { context });
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: null, config: null, help: false, positionals: [] };
  const args = [...argv];
  result.command = args.shift() ?? null;
  while (args.length) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--config" || arg === "-c") {
      const value = args.shift();
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a config path value.`);
      result.config = value;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
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
