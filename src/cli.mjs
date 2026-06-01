import { loadConfig } from "./config.mjs";
import { catalogForConfig, findTask, TASKS } from "./tasks.mjs";
import {
  measureArchitectureMap,
  measureClones,
  measureCorrectnessCatalog,
  measureDependencyHealth,
  measureEscapeHatches,
  measureHotspots,
  measureLeverage,
  measureLocality,
  measureReactHealth,
  measureTypeHealth,
} from "./analyze.mjs";

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

export function runMeasure(config, taskId, command) {
  if (taskId === "all") {
    const results = [];
    for (const id of TASKS.map((task) => task.id)) {
      results.push(...runMeasure(config, id, command));
    }
    return results;
  }

  if (!findTask(taskId)) {
    throw new Error(`Unknown task id: ${taskId}`);
  }

  switch (taskId) {
    case "quality.hotspots":
      return [measureHotspots(config, command)];
    case "quality.clones":
      return [measureClones(config, command)];
    case "quality.escape_hatches":
      return [measureEscapeHatches(config, command)];
    case "quality.type_health":
      return [measureTypeHealth(config, command)];
    case "quality.locality_dynamic":
      ensurePrerequisites(config, command, ["correctness.catalog"]);
      return [measureLocality(config, command)];
    case "quality.locality_leverage":
      return [measureLeverage(config, command)];
    case "quality.react_health":
      return [measureReactHealth(config, command)];
    case "quality.dependency_health":
      return [measureDependencyHealth(config, command)];
    case "correctness.catalog":
      return [measureCorrectnessCatalog(config, command, false)];
    case "correctness.all":
      return [measureCorrectnessCatalog(config, command, true)];
    case "map.architecture":
      ensurePrerequisites(
        config,
        command,
        [
          "quality.hotspots",
          "quality.escape_hatches",
          "quality.type_health",
          "quality.dependency_health",
          "correctness.catalog",
          "quality.locality_dynamic",
          "quality.locality_leverage",
          "quality.react_health",
        ],
      );
      return [measureArchitectureMap(config, command)];
    default:
      throw new Error(`Task is registered but has no measurement handler: ${taskId}`);
  }
}

function ensurePrerequisites(config, command, taskIds) {
  for (const taskId of taskIds) {
    runMeasure(config, taskId, command);
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
