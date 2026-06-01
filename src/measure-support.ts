export { analyzeProject, analysisConfidence, createAnalysisContext } from "./analysis-context.js";
export { cloneGroup, jscpdCloneGroup, normalizeCloneLine, stableHash } from "./clone-utils.js";
export { countBy, dedupeBy, groupBy } from "./collections.js";
export { runTestCommand, testRecord } from "./correctness.js";
export { gitChurn } from "./history.js";
export {
  dependencyCruiserCycles,
  dependencyCruiserEdges,
  findCycles,
  groupMapNodes,
  mapNode,
  uniqueCycleCount,
} from "./graph.js";
export {
  escapeRecords,
  fileHotspotRecord,
  frameworkRiskRecords,
  functionHotspotRecord,
  hiddenCouplingSignals,
  maxScoreFor,
  riskForScore,
  typeHealthRecords,
} from "./scoring.js";
