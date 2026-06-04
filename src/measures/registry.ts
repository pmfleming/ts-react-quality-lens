import { measureArchitectureMap } from "./architecture.js";
import { measureClones } from "./clones.js";
import { measureCleanup } from "./cleanup.js";
import { measureCorrectnessCatalog } from "./correctness.js";
import { measureDependencyHealth } from "./dependency.js";
import { measureHotspots } from "./hotspots.js";
import {
  measureEscapeHatches,
  measureLeverage,
  measureLocality,
  measureReactHealth,
  measureTypeHealth,
} from "./quality.js";
import type { AnalysisContext, Artifact, Config } from "../types.js";

type MeasureTask = {
  handler: (config: Config, command: string, context: AnalysisContext) => Artifact;
  prerequisites?: string[];
};

export const MEASURE_ORDER = [
  "quality.hotspots",
  "quality.clones",
  "quality.escape_hatches",
  "quality.type_health",
  "quality.dependency_health",
  "correctness.catalog",
  "quality.locality_dynamic",
  "quality.locality_leverage",
  "quality.react_health",
  "quality.cleanup",
  "correctness.all",
  "map.architecture",
] as const;

export const MEASURE_TASKS = new Map<string, MeasureTask>(
  [
    ["quality.hotspots", { handler: measureHotspots }],
    ["quality.clones", { handler: measureClones }],
    ["quality.escape_hatches", { handler: measureEscapeHatches }],
    ["quality.type_health", { handler: measureTypeHealth }],
    ["quality.dependency_health", { handler: measureDependencyHealth }],
    ["quality.cleanup", { handler: measureCleanup }],
    ["correctness.catalog", { handler: (config, command, context) => measureCorrectnessCatalog(config, command, false, context) }],
    ["quality.locality_dynamic", { handler: measureLocality, prerequisites: ["correctness.catalog"] }],
    ["quality.locality_leverage", { handler: measureLeverage }],
    ["quality.react_health", { handler: measureReactHealth }],
    ["correctness.all", { handler: (config, command, context) => measureCorrectnessCatalog(config, command, true, context) }],
    [
      "map.architecture",
      {
        handler: measureArchitectureMap,
        prerequisites: [
          "quality.hotspots",
          "quality.escape_hatches",
          "quality.type_health",
          "quality.dependency_health",
          "correctness.catalog",
          "quality.locality_dynamic",
          "quality.locality_leverage",
          "quality.react_health",
          "quality.cleanup",
        ],
      },
    ],
  ],
);
