export const LENS_NAME = "ts-react-quality-lens";
export const SCHEMA_VERSION = "0.1.0";

export const TASKS = [
  {
    id: "quality.hotspots",
    category: "quality",
    title: "Complexity hotspots",
    artifact: "hotspots.json",
    description:
      "Ranks complex files, functions, components, hooks, reducers, route modules, and utilities.",
  },
  {
    id: "quality.clones",
    category: "quality",
    title: "Clone pressure",
    artifact: "clones.json",
    description:
      "Finds repeated TypeScript, JSX, component, hook, style, and test structures.",
  },
  {
    id: "quality.escape_hatches",
    category: "quality",
    title: "TypeScript escape hatches",
    artifact: "ts_escape_hatches.json",
    description:
      "Tracks type-system, runtime, React, module, and lint-suppression escape hatches.",
  },
  {
    id: "quality.type_health",
    category: "quality",
    title: "Type health",
    artifact: "type_health.json",
    description:
      "Measures interfaces, type aliases, component props, generics, exports, and public APIs.",
  },
  {
    id: "quality.locality_dynamic",
    category: "quality",
    title: "Dynamic locality",
    artifact: "locality_metrics.json",
    description:
      "Measures dependency distance, hidden coupling, test locality, churn, contributors, and ownership spread.",
  },
  {
    id: "quality.locality_leverage",
    category: "quality",
    title: "Architecture leverage",
    artifact: "leverage_metrics.json",
    description:
      "Measures architectural leverage, reach, abstraction value, divergence pressure, and co-change ripple.",
  },
  {
    id: "quality.react_health",
    category: "quality",
    title: "React health",
    artifact: "react_health.json",
    description:
      "Measures component size, props, hooks, effects, render risk, context coupling, and state complexity.",
  },
  {
    id: "quality.dependency_health",
    category: "quality",
    title: "Dependency health",
    artifact: "dependency_health.json",
    description:
      "Measures import cycles, layer violations, package boundaries, barrels, deep imports, and dependency pressure.",
  },
  {
    id: "correctness.catalog",
    category: "correctness",
    title: "Correctness catalog",
    artifact: "correctness_review.json",
    extraArtifacts: ["test_catalog.json"],
    description:
      "Discovers tests and maps them to modules, routes, features, components, and hooks.",
  },
  {
    id: "correctness.all",
    category: "correctness",
    title: "Correctness run",
    artifact: "correctness_review.json",
    description:
      "Runs the configured test command and attaches status to the correctness catalog.",
  },
  {
    id: "map.architecture",
    category: "map",
    title: "Architecture map",
    artifact: "map.json",
    description:
      "Builds the dashboard-ready architecture graph and combined risk map.",
  },
];

export function findTask(taskId) {
  return TASKS.find((task) => task.id === taskId);
}

export function catalogForConfig(config) {
  return {
    schema_version: SCHEMA_VERSION,
    lens: LENS_NAME,
    project_name: config.projectName,
    project_root: config.projectRoot,
    output_dir: config.outputDir,
    generated_at: new Date().toISOString(),
    tasks: TASKS.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      lens: LENS_NAME,
      description: task.description,
      artifact: task.artifact,
      extra_artifacts: task.extraArtifacts ?? [],
      command: `ts-react-quality-lens measure ${task.id} --config ${config.configPath}`,
    })),
  };
}
