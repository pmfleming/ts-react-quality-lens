import { loadConfig } from "./config.js";
import fs from "node:fs";
import { catalogForConfig, findTask, TASKS } from "./tasks.js";
import { createAnalysisContext } from "./analysis-context.js";
import { MEASURE_ORDER, MEASURE_TASKS } from "./measures/registry.js";
import { auditMarkdown, runAudit } from "./audit.js";
import { projectContext } from "./context.js";
import type { AnalysisContext, Artifact, Config } from "./types.js";

type RunMeasureOptions = {
  context?: AnalysisContext;
  skipPrerequisites?: boolean;
};

type ParsedArgs = {
  command: string | null;
  config: string | null;
  base: string | null;
  changedSince: string | null;
  gate: "new-only" | "all" | null;
  baseline: string | null;
  saveBaseline: string | null;
  format: "json" | "summary" | "markdown";
  force: boolean;
  help: boolean;
  positionals: string[];
};
type ValueFlag = {
  aliases: string[];
  set: (args: ParsedArgs, value: string, flag: string) => void;
};

const VALUE_FLAGS: ValueFlag[] = [
  { aliases: ["--config", "-c"], set: (args, value) => { args.config = value; } },
  { aliases: ["--base"], set: (args, value) => { args.base = value; } },
  { aliases: ["--changed-since"], set: (args, value) => { args.changedSince = value; } },
  { aliases: ["--baseline"], set: (args, value) => { args.baseline = value; } },
  { aliases: ["--save-baseline"], set: (args, value) => { args.saveBaseline = value; } },
  {
    aliases: ["--gate"],
    set: (args, value, flag) => {
      args.gate = oneOf(flag, value, ["new-only", "all"]);
    },
  },
  {
    aliases: ["--format"],
    set: (args, value, flag) => {
      args.format = oneOf(flag, value, ["json", "summary", "markdown"]);
    },
  },
];

type CommandHandler = (config: Config, args: ParsedArgs) => void;

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  catalog: runCatalogCommand,
  init: runInitCommand,
  audit: runAuditCommand,
  context: runContextCommand,
  measure: runMeasureCommand,
};

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help || !args.command) return printHelp();
  const handler = COMMAND_HANDLERS[args.command];
  if (!handler) throw new Error(`Unknown command: ${args.command}`);
  handler(loadConfig(args.config), args);
}

function runCatalogCommand(config: Config): void {
  console.log(JSON.stringify(catalogForConfig(config), null, 2));
}

function runInitCommand(config: Config, args: ParsedArgs): void {
  writeInitialConfig(config, args.force);
  console.log(JSON.stringify({ project_name: config.projectName, config: config.configPath, created: true }, null, 2));
}

function runAuditCommand(config: Config, args: ParsedArgs): void {
  const artifact = runAudit(config, `ts-react-quality-lens audit --config ${config.configPath}`, {
    base: args.base,
    changedSince: args.changedSince,
    gate: args.gate,
    baseline: args.baseline,
    saveBaseline: args.saveBaseline,
  });
  printAudit(config, args.format, artifact);
  if (artifact.summary.verdict === "fail" || artifact.summary.verdict === "incomplete") process.exitCode = 1;
}

function printAudit(config: Config, format: ParsedArgs["format"], artifact: ReturnType<typeof runAudit>): void {
  if (format === "json") console.log(JSON.stringify(artifact, null, 2));
  else if (format === "markdown") console.log(auditMarkdown(artifact));
  else console.log(JSON.stringify({ project_name: config.projectName, output_dir: config.outputDir, audit: artifact.summary }, null, 2));
}

function runContextCommand(config: Config): void {
  const context = projectContext(config, `ts-react-quality-lens context --config ${config.configPath}`);
  console.log(JSON.stringify(context, null, 2));
}

function runMeasureCommand(config: Config, args: ParsedArgs): void {
  const taskId = args.positionals[0] ?? "all";
  const results = runMeasure(config, taskId, `ts-react-quality-lens measure ${taskId} --config ${config.configPath}`);
  console.log(JSON.stringify({
    project_name: config.projectName,
    output_dir: config.outputDir,
    measured: results.map((result) => ({ task_id: result.task_id, summary: result.summary })),
  }, null, 2));
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
  const result = initialArgs();
  const args = [...argv];
  if (args[0] === "--help" || args[0] === "-h") {
    result.help = true;
    args.shift();
  } else {
    result.command = args.shift() ?? null;
  }
  while (args.length) applyArgument(result, args, args.shift());
  return result;
}

function applyArgument(result: ParsedArgs, remaining: string[], argument: string | undefined): void {
  if (!argument) return;
  const valueFlag = valueFlagFor(argument);
  if (valueFlag) valueFlag.set(result, requiredValue(argument, remaining), argument);
  else if (argument === "--help" || argument === "-h") result.help = true;
  else if (argument === "--force") result.force = true;
  else if (argument.startsWith("-")) throw new Error(`Unknown flag: ${argument}`);
  else result.positionals.push(argument);
}

function initialArgs(): ParsedArgs {
  return {
    command: null,
    config: null,
    base: null,
    changedSince: null,
    gate: null,
    baseline: null,
    saveBaseline: null,
    format: "summary",
    force: false,
    help: false,
    positionals: [],
  };
}

function valueFlagFor(arg: string): ValueFlag | undefined {
  return VALUE_FLAGS.find((flag) => flag.aliases.includes(arg));
}

function oneOf<const T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((item) => item === value);
  if (match) return match;
  throw new Error(`${flag} must be ${allowed.map((item) => `"${item}"`).join(", or ")}.`);
}

function writeInitialConfig(config: Config, force: boolean): void {
  if (fs.existsSync(config.configPath) && !force) {
    throw new Error(`Config already exists at ${config.configPath}. Use --force to overwrite it.`);
  }
  const value = {
    $schema: "./ts-react-quality-lens.config.schema.json",
    project_name: config.projectName,
    project_root: ".",
    source_roots: ["src"],
    test_roots: ["src", "test", "tests"],
    output_dir: "target/analysis",
    framework: "auto",
    test_runner: "auto",
    policy: {
      profile: "recommended",
    },
    audit: {
      base: "origin/main",
      gate: "new-only",
    },
  };
  fs.writeFileSync(config.configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requiredValue(flag: string, args: string[]): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`ts-react-quality-lens

Usage:
  ts-react-quality-lens catalog --config ./ts-react-quality-lens.config.json
  ts-react-quality-lens init --config ./ts-react-quality-lens.config.json
  ts-react-quality-lens measure <task-id|all> --config ./ts-react-quality-lens.config.json
  ts-react-quality-lens audit --config ./ts-react-quality-lens.config.json [--base origin/main]
  ts-react-quality-lens context --config ./ts-react-quality-lens.config.json

Commands:
  catalog       Print board-compatible task metadata.
  init          Write a starter schema-backed config.
  measure       Write one task artifact or all artifacts.
  audit         Run changed-code quality audit and write audit.json.
  context       Write and print compact agent-ready project context.
`);
}
