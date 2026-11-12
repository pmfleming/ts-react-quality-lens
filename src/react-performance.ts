import { nonempty, nonnegative, oneOf, shape } from "./validation.js";
import { isRecord } from "./collections.js";
import { stableHash } from "./clone-utils.js";
import { featureSupport } from "./react-support.js";
import type { ScoredRecord } from "./types.js";

const TRACK_PHASES = new Map<string, string[]>([
  ["scheduler", ["update", "render", "commit", "remaining-effects", "cascading-update"]],
  ["components", ["render", "effect", "mount", "unmount", "reconnect", "disconnect"]],
  ["server", ["request", "component"]],
]);

/** Explicit lens interchange format. This is not a parser for arbitrary Chrome trace JSON. */
export function performanceTrackRecords(value: Record<string, unknown>, environment: Record<string, unknown>): ScoredRecord[] {
  if (!Array.isArray(value.events) || !["development", "profiling"].includes(String(environment.build)) ||
      typeof environment.react_version !== "string" || featureSupport(environment.react_version, "19.2.0") !== "supported") {
    throw new Error("React performance tracks require events, environment.build (development or profiling), and a supported environment.react_version (19.2+).");
  }
  const ids = new Set<string>();
  return value.events.map((event, index) => {
    if (!isRecord(event) || typeof event.id !== "string" || !event.id.trim() || ids.has(event.id) ||
        typeof event.track !== "string" || typeof event.phase !== "string" || !TRACK_PHASES.get(event.track)?.includes(event.phase) ||
        typeof event.name !== "string" || !event.name.trim() || typeof event.duration_ms !== "number" ||
        !Number.isFinite(event.duration_ms) || event.duration_ms < 0 || typeof event.start_ms !== "number" ||
        !Number.isFinite(event.start_ms) || event.start_ms < 0) throw new Error(`Invalid normalized React performance event at index ${index}.`);
    if (event.track === "server" && environment.build !== "development") throw new Error("Server performance tracks require a development build.");
    ids.add(event.id);
    return {
      id: `runtime:react-track:${stableHash(event.id)}`, rule_id: `react-performance/${event.track}-${event.phase}`,
      kind: "react_performance_observation", source: "react-performance-tracks", evidence_kind: "metric",
      disposition: "review", finding_confidence: "high", semantic_decision: "unresolved", scope: "project", score: 0, risk: "low",
      message: `${event.name}: ${event.track}/${event.phase} observed for ${event.duration_ms}ms. Compare equivalent workloads before diagnosing a regression.`,
      event_id: event.id, track: event.track, phase: event.phase, name: event.name, duration_ms: event.duration_ms, start_ms: event.start_ms,
      observation_environment: environment, production_representative: false,
      measurement_scope: "Imported span; durations may overlap or include descendants and must not be summed as exclusive CPU time.",
      guidance_url: "https://react.dev/reference/dev-tools/react-performance-tracks",
      signals: [{ kind: "observed_duration_ms", value: event.duration_ms }],
    };
  });
}

const trackRecord = shape({ event_id: nonempty, name: nonempty, track: nonempty, phase: nonempty, start_ms: nonnegative,
  duration_ms: nonnegative, disposition: oneOf("review"), evidence_kind: oneOf("metric"), observation_environment: isRecord });
export function validPerformanceTrackRecord(value: unknown): boolean {
  return trackRecord(value) && Boolean(TRACK_PHASES.get(value.track)?.includes(value.phase)) && value.production_representative === false &&
    ["development", "profiling"].includes(String(value.observation_environment.build)) &&
    typeof value.observation_environment.react_version === "string" && featureSupport(value.observation_environment.react_version, "19.2.0") === "supported" &&
    (value.track !== "server" || value.observation_environment.build === "development");
}
