import path from "node:path";
import semver from "semver";
import { readPackageJson } from "./entrypoints.js";
import type { Config, WorkspaceRecord } from "./types.js";

const FEATURES = [
  { id: "ref-as-prop", minimum: "19.0.0", guidance: "New function components can accept ref as a prop.", source: "https://react.dev/blog/2024/12/05/react-19" },
  { id: "actions", minimum: "19.0.0", guidance: "Consider useActionState and useOptimistic for action results and pending UI.", source: "https://react.dev/blog/2024/12/05/react-19" },
  { id: "effect-events", minimum: "19.2.0", guidance: "Use useEffectEvent for non-reactive logic called from Effects; preserve genuine reactive dependencies.", source: "https://react.dev/reference/react/useEffectEvent" },
  { id: "view-transitions", minimum: "19.3.0", guidance: "Consider ViewTransition for transition animations when browser support is suitable.", source: "https://react.dev/blog/2026/09/09/react-19-3" },
  { id: "fragment-refs", minimum: "19.3.0", guidance: "Fragment refs can address grouped DOM children without adding a wrapper.", source: "https://react.dev/blog/2026/09/09/react-19-3" },
] as const;

export type ReactFeatureSupport = "supported" | "unsupported" | "mixed" | "unknown";

export function reactSupport(config: Config, workspaces: WorkspaceRecord[]) {
  return workspaces.map((workspace) => {
    const manifest = readPackageJson(path.join(config.projectRoot, workspace.root, "package.json"));
    // Peers define a library's compatibility promise, even if development uses a newer React.
    const declaration = (["peerDependencies", "dependencies", "optionalDependencies", "devDependencies"] as const)
      .flatMap((section) => typeof manifest?.[section]?.react === "string"
        ? [{ range: manifest[section].react, source: `${section}.react` }] : [])[0];
    const range = config.react.version ?? declaration?.range ?? null;
    const capabilities = FEATURES.map((feature) => ({
      id: feature.id,
      minimum_react: feature.minimum,
      support: featureSupport(range, feature.minimum),
      source: feature.source,
    }));
    return {
      workspace_id: workspace.id,
      root: workspace.root,
      declared_range: range,
      range_source: config.react.version ? "config.react.version" : declaration?.source ?? "unknown",
      capabilities,
      guidance: FEATURES.filter((_feature, index) => capabilities[index]?.support === "supported")
        .map((feature) => ({ capability: feature.id, message: feature.guidance, source: feature.source })),
    };
  });
}

export function featureSupport(range: string | null, minimum: string): ReactFeatureSupport {
  if (!range?.trim() || !semver.validRange(range)) return "unknown";
  const parsed = new semver.Range(range);
  // Preview versions, tags, catalogs, and unsatisfiable ranges cannot establish stable API support.
  if (/\d+\.\d+\.\d+-/.test(range) || !semver.minVersion(parsed)) return "unknown";
  const supported = `>=${minimum}`;
  if (semver.subset(parsed, supported)) return "supported";
  return semver.intersects(parsed, supported) ? "mixed" : "unsupported";
}
