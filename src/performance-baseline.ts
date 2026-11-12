import fs from "node:fs";
import semver from "semver";
import { isRecord, parseJson } from "./collections.js";
import { stableHash } from "./clone-utils.js";
import { arrayOf, boolean, count, nonempty, nonnegative, oneOf, optional, shape } from "./validation.js";
import type { ImportedEvidence } from "./react-compiler-report.js";
import type { Config, ScoredRecord } from "./types.js";

const strings = arrayOf(nonempty);
const encoding = oneOf("raw", "gzip", "brotli");
const bundleEntry = shape({ route: nonempty, chunk: nonempty, loading: oneOf("initial", "deferred"), encoding, bytes: count });
const bundleData = shape({ complete: boolean, routes: strings, encodings: arrayOf(encoding), entries: arrayOf(bundleEntry) });
const sample = shape({ run_id: nonempty, value: nonnegative });
const runtimeEntry = shape({ scenario: nonempty, metric: nonempty, unit: oneOf("ms"), samples: arrayOf(sample) });
const runtimeData = shape({ complete: boolean, entries: arrayOf(runtimeEntry) });
const runtimeContext = shape({ browser: nonempty, browser_version: nonempty, os: nonempty, device: nonempty, network: nonempty,
  viewport: nonempty, harness_version: nonempty, scenario_version: nonempty, cache_state: nonempty });
const snapshot = shape({ provenance: shape({ source_set_hash: nonempty }), producer: shape({ name: nonempty, version: nonempty }),
  environment: shape({ build_id: nonempty, build: oneOf("production", "profiling", "development"), build_config_hash: nonempty,
    toolchain_hash: nonempty, react_version: nonempty, browser_targets: strings, runtime_context: optional(runtimeContext) }),
  data: shape({ format: oneOf("react-performance-snapshot-v1"), bundles: optional(bundleData), runtime: optional(runtimeData) }) });
type Snapshot = ExtractValidated<typeof snapshot>;
type ExtractValidated<T> = T extends (value: unknown) => value is infer R ? R : never;
const MIN_SAMPLES = 5;
const identity = (parts: unknown[]) => JSON.stringify(parts);

function readSnapshot(value: unknown): Snapshot {
  if (!snapshot(value) || !semver.valid(value.environment.react_version) || !value.data.bundles && !value.data.runtime) {
    throw new Error("Expected react-performance-snapshot-v1 with source, producer, concrete React version, build identity, and bundle or runtime evidence.");
  }
  if (!value.environment.browser_targets.length || new Set(value.environment.browser_targets).size !== value.environment.browser_targets.length) throw new Error("Declare unique browser targets for the snapshot build.");
  const bundles = value.data.bundles;
  if (bundles) {
    if (new Set(bundles.routes).size !== bundles.routes.length || new Set(bundles.encodings).size !== bundles.encodings.length ||
        !bundles.encodings.length) throw new Error("Bundle scope must declare unique routes and nonempty unique encodings.");
    const keys = new Set<string>();
    for (const entry of bundles.entries) {
      const key = identity([entry.route, entry.chunk, entry.encoding]);
      if (keys.has(key) || !bundles.routes.includes(entry.route) || !bundles.encodings.includes(entry.encoding)) throw new Error("Duplicate or out-of-scope bundle entry.");
      keys.add(key);
    }
  }
  const runtime = value.data.runtime;
  if (runtime) {
    if (!runtimeContext(value.environment.runtime_context)) throw new Error("Runtime snapshots require complete browser/device/network/harness/scenario/cache context.");
    const keys = new Set<string>();
    for (const entry of runtime.entries) {
      const key = identity([entry.scenario, entry.metric, entry.unit]);
      if (keys.has(key) || new Set(entry.samples.map((item) => item.run_id)).size !== entry.samples.length) throw new Error("Duplicate runtime metric or sample run ID.");
      keys.add(key);
    }
  }
  return value;
}

export function performanceComparisonRecords(config: Config, _value: unknown, _environment: Record<string, unknown>, sourceVerified: boolean,
  envelope: unknown): ImportedEvidence {
  if (!config.runtimeInputs.performanceCurrent || !config.runtimeInputs.performanceBaseline) throw new Error("Configure both performance_current and performance_baseline snapshots.");
  const current = readSnapshot(envelope);
  const baseline = readSnapshot(parseJson(fs.readFileSync(config.runtimeInputs.performanceBaseline, "utf8")));
  const reasons: string[] = [];
  const records: ScoredRecord[] = [];
  const notCompared: string[] = [];
  if (!sourceVerified) reasons.push("Current snapshot does not match the analyzed source/producer provenance.");
  if (current.producer.name !== baseline.producer.name || current.producer.version !== baseline.producer.version) reasons.push("Snapshot producers differ.");
  for (const key of ["build", "build_config_hash", "toolchain_hash", "react_version"] as const) {
    if (current.environment[key] !== baseline.environment[key]) reasons.push(`Environment differs: ${key}.`);
  }
  if (identity([...current.environment.browser_targets].sort()) !== identity([...baseline.environment.browser_targets].sort())) reasons.push("Build browser targets differ.");
  if (current.environment.build === "development" || baseline.environment.build === "development") reasons.push("Development measurements are not accepted for baseline comparisons.");
  if (!reasons.length) {
    compareBundles(current, baseline, records, notCompared);
    compareRuntime(current, baseline, records, notCompared);
  }
  const status = !sourceVerified ? "unverified" : reasons.length || !records.length ? "incompatible" : "comparable";
  if (!records.length && !reasons.length) reasons.push("No matched measurements with complete scope and sufficient samples.");
  if (status !== "comparable") records.push({
    id: "performance-baseline:unavailable", source: "performance-baseline", rule_id: "performance/comparison-unavailable",
    kind: "performance_comparison_unavailable", evidence_kind: "diagnostic", disposition: "review", finding_confidence: "high", semantic_decision: "unresolved",
    scope: "project", score: 0, risk: "low", message: reasons.join(" "), signals: [{ kind: "comparison_unavailable" }],
  });
  return { records, complete: true, reason: null, metadata: { status, reasons, not_compared: notCompared.sort(),
    current: { source_set_hash: current.provenance.source_set_hash, build_id: current.environment.build_id },
    baseline: { source_set_hash: baseline.provenance.source_set_hash, build_id: baseline.environment.build_id, verification: "declared_historical_source" },
    comparisons: records.filter((record) => record.kind === "performance_delta").length, minimum_runtime_samples: MIN_SAMPLES,
    interpretation: "Observed differences under declared matching conditions; not causal attribution, statistical significance, or an automatic regression gate." } };
}

function deltaRecord(subject: string, metric: string, unit: string, before: number, after: number, details: Record<string, unknown>): ScoredRecord {
  const delta = after - before;
  if (!Number.isFinite(delta)) throw new Error("Performance delta exceeds finite numeric range.");
  const percent = before === 0 ? null : delta / before * 100;
  return { id: `performance-baseline:${stableHash(identity([subject, metric]))}`, source: "performance-baseline", rule_id: `performance/${metric}`,
    kind: "performance_delta", evidence_kind: "metric", disposition: "review", finding_confidence: "high", semantic_decision: "unresolved",
    scope: "project", score: 0, risk: "low", message: `${subject}: ${metric} changed from ${before} to ${after} ${unit}. This is an observed difference, not a proven regression or gain.`,
    comparison_status: "comparable", subject, metric, unit, baseline_value: before, current_value: after,
    delta, delta_percent: percent !== null && Number.isFinite(percent) ? percent : null,
    ...details, signals: [{ kind: "observed_delta", value: delta }],
  };
}

function compareBundles(current: Snapshot, baseline: Snapshot, records: ScoredRecord[], notCompared: string[]): void {
  const a = current.data.bundles, b = baseline.data.bundles;
  if (!a && !b) return;
  if (!a?.complete || !b?.complete || current.environment.build !== "production") { notCompared.push("bundles: requires complete inventories from production builds on both sides"); return; }
  for (const route of [...new Set([...a.routes, ...b.routes])].sort()) {
    for (const code of [...new Set([...a.encodings, ...b.encodings])].sort()) {
      if (!a.routes.includes(route) || !b.routes.includes(route) || !a.encodings.includes(code) || !b.encodings.includes(code)) {
        notCompared.push(`bundle route/encoding: ${route}/${code}`); continue;
      }
      for (const loading of ["initial", "deferred"] as const) {
        const entriesA = a.entries.filter((entry) => entry.route === route && entry.encoding === code && entry.loading === loading);
        const entriesB = b.entries.filter((entry) => entry.route === route && entry.encoding === code && entry.loading === loading);
        const sum = (entries: typeof entriesA) => entries.reduce((total, entry) => total + entry.bytes, 0);
        const after = sum(entriesA), before = sum(entriesB);
        if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before)) throw new Error("Bundle total exceeds safe integer range.");
        records.push(deltaRecord(identity([route, loading, code]), "route-bundle-bytes", "bytes", before, after,
          { route, loading, encoding: code, current_chunks: entriesA.map((entry) => ({ chunk: entry.chunk, bytes: entry.bytes })).sort((l, r) => l.chunk.localeCompare(r.chunk)),
            baseline_chunks: entriesB.map((entry) => ({ chunk: entry.chunk, bytes: entry.bytes })).sort((l, r) => l.chunk.localeCompare(r.chunk)),
            measurement_scope: "Per-route bytes for this loading phase and encoding; shared chunks must not be summed across routes.",
            guidance_url: "https://nextjs.org/docs/app/guides/production-checklist#analyzing-bundles" }));
      }
    }
  }
}

function compareRuntime(current: Snapshot, baseline: Snapshot, records: ScoredRecord[], notCompared: string[]): void {
  const a = current.data.runtime, b = baseline.data.runtime;
  if (!a && !b) return;
  if (!a?.complete || !b?.complete) { notCompared.push("runtime: requires complete reports on both sides"); return; }
  const contextKeys = ["browser", "browser_version", "os", "device", "network", "viewport", "harness_version", "scenario_version", "cache_state"] as const;
  if (contextKeys.some((key) => current.environment.runtime_context?.[key] !== baseline.environment.runtime_context?.[key])) {
    notCompared.push("runtime: browser/device/network/harness/scenario/cache conditions differ"); return;
  }
  const key = (entry: (typeof a.entries)[number]) => identity([entry.scenario, entry.metric, entry.unit]);
  const entriesA = new Map(a.entries.map((entry) => [key(entry), entry]));
  const entriesB = new Map(b.entries.map((entry) => [key(entry), entry]));
  for (const subject of [...new Set([...entriesA.keys(), ...entriesB.keys()])].sort()) {
    const after = entriesA.get(subject), before = entriesB.get(subject);
    if (!after || !before || after.samples.length < MIN_SAMPLES || before.samples.length < MIN_SAMPLES) {
      notCompared.push(`runtime: ${subject} missing or fewer than ${MIN_SAMPLES} samples`); continue;
    }
    const currentStats = statistics(after.samples.map((item) => item.value));
    const baselineStats = statistics(before.samples.map((item) => item.value));
    for (const statistic of ["median", "p95"] as const) records.push(deltaRecord(subject, `runtime-${statistic}`, "ms", baselineStats[statistic], currentStats[statistic],
      { scenario: after.scenario, measured_metric: after.metric, current_statistics: currentStats, baseline_statistics: baselineStats,
        measurement_scope: "Repeated scenario runs; p95 uses nearest rank. Sample counts and ranges are descriptive, not significance estimates.",
        guidance_url: "https://react.dev/reference/dev-tools/react-performance-tracks" }));
  }
}
function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
  return { count: sorted.length, min: sorted[0]!, max: sorted.at(-1)!, median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]! };
}

const deltaShape = shape({ baseline_value: nonnegative, current_value: nonnegative, delta: (value): value is number => typeof value === "number" && Number.isFinite(value),
  comparison_status: oneOf("comparable"), disposition: oneOf("review"), evidence_kind: oneOf("metric") });
export function validPerformanceDelta(value: unknown): boolean {
  if (!deltaShape(value) || value.delta !== value.current_value - value.baseline_value) return false;
  const percent = value.baseline_value === 0 ? null : value.delta / value.baseline_value * 100;
  return value.delta_percent === (percent !== null && Number.isFinite(percent) ? percent : null);
}
export function validPerformanceComparisonMetadata(value: unknown, verified: boolean): boolean {
  return isRecord(value) && shape({ current: shape({ source_set_hash: nonempty, build_id: nonempty }), baseline: shape({ source_set_hash: nonempty, build_id: nonempty }) })(value) && oneOf("comparable", "incompatible", "unverified")(value.status) && strings(value.reasons) && strings(value.not_compared) &&
    count(value.comparisons) && (!verified ? value.status === "unverified" && value.comparisons === 0 : value.status !== "unverified") &&
    (value.status === "comparable" ? value.comparisons > 0 && value.reasons.length === 0 : value.comparisons === 0 && value.reasons.length > 0);
}
