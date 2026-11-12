import path from "node:path";
import browserslist from "browserslist";
import { isRecord, parseJson } from "./collections.js";
import { toolPackageVersion } from "./integrations/tool-runner.js";
import { toPosix } from "./files.js";
import { webContentHash, type WebInputSet } from "./web-inputs.js";
import type { BrowserTargets } from "./modern-web-types.js";
import type { Config } from "./types.js";

export function browserDataVersions(): Record<string, string | null> {
  return Object.fromEntries(["browserslist", "caniuse-lite", "baseline-browser-mapping", "@mdn/browser-compat-data"]
    .map((name) => [name, toolPackageVersion(name)]));
}

export function resolveWebBrowserTargets(config: Config, inputs: WebInputSet): Record<string, BrowserTargets> {
  browserslist.clearCaches();
  const cache = new Map<string, BrowserTargets>();
  return Object.fromEntries(inputs.files.map((file) => {
    const dir = toPosix(path.dirname(file.relativePath));
    if (!cache.has(dir)) cache.set(dir, resolveTargets(config, inputs, dir));
    return [file.relativePath, cache.get(dir)!];
  }));
}

export function browserTargetsFingerprint(config: Config, inputs: WebInputSet): string {
  return webContentHash(["browser-targets-v1", browserDataVersions(), resolveWebBrowserTargets(config, inputs)]);
}

function resolveTargets(config: Config, inputs: WebInputSet, directory: string): BrowserTargets {
  const environment = config.modernWeb.browsers.environment;
  const base: BrowserTargets = { status: "unknown", workspace: owningPackage(inputs, directory), source: null, environment,
    queries: [], resolved: [], reason: null, config_files: [] };
  try {
    const selection = config.modernWeb.browsers.targets
      ? { queries: config.modernWeb.browsers.targets, source: "modern_web.browsers.targets", files: [] }
      : discoverTargets(inputs, directory, environment);
    if (!selection) return { ...base, reason: "No explicit browser targets or repository Browserslist configuration." };
    Object.assign(base, { source: selection.source, config_files: selection.files, queries: selection.queries });
    if (!selection.queries.length) throw new Error(`No browser queries for environment ${environment}.`);
    // These queries can read executable/shared configuration or external usage files outside the tracked closure.
    if (selection.queries.some((query) => /\bextends\b|\bmy\s+stats\b|\bin\s+browserslist-config-/i.test(query))) {
      throw new Error("Shared Browserslist configs and custom usage statistics are outside this resolver's supported scope; configure explicit queries.");
    }
    const resolved = browserslist(selection.queries, { path: false, env: environment, stats: {} }).sort();
    if (!resolved.length) throw new Error("Browser queries resolved to an empty target set.");
    return { ...base, status: "resolved", resolved };
  } catch (error) {
    return { ...base, reason: error instanceof Error ? error.message : String(error) };
  }
}

function ancestors(directory: string): string[] {
  const result: string[] = [];
  for (let dir = directory; ; dir = toPosix(path.dirname(dir))) {
    result.push(dir);
    if (dir === ".") break;
  }
  return result;
}

function owningPackage(inputs: WebInputSet, directory: string): string {
  const manifests = new Set(inputs.files.filter((file) => file.kind === "manifest").map((file) => file.relativePath));
  return ancestors(directory).find((dir) => manifests.has(toPosix(path.join(dir, "package.json")))) ?? ".";
}

function discoverTargets(inputs: WebInputSet, directory: string, environment: string) {
  const configuration = new Map(inputs.configuration.map((file) => [file.relativePath, file.text]));
  const checked: string[] = [];
  for (const dir of ancestors(directory)) {
    const choices: Array<{ source: string; queries: string[] }> = [];
    for (const name of ["package.json", ".browserslistrc", "browserslist"]) {
      const file = toPosix(path.join(dir, name));
      const text = configuration.get(file);
      checked.push(file);
      if (text === undefined || text === "missing") continue;
      if (text === "unreadable" || text.startsWith("unsupported:")) throw new Error(`Cannot read browser configuration ${file}: ${text}.`);
      if (name === "package.json") {
        const manifest = parseJson(text);
        if (!isRecord(manifest) || manifest.browserslist === undefined) continue;
        choices.push({ source: file, queries: packageQueries(manifest.browserslist, environment) });
      } else {
        const parsed = browserslist.parseConfig(text);
        choices.push({ source: file, queries: parsed[environment] ?? parsed.defaults });
      }
    }
    if (choices.length > 1) throw new Error(`Conflicting Browserslist configurations in ${dir}.`);
    if (choices[0]) return { ...choices[0], files: checked };
  }
  return null;
}

function packageQueries(value: unknown, environment: string): string[] {
  const selected = isRecord(value) ? value[environment] ?? value.defaults : value;
  if (typeof selected === "string") return [selected];
  if (Array.isArray(selected) && selected.every((query) => typeof query === "string")) return selected;
  throw new Error(`Invalid or missing package Browserslist queries for environment ${environment}.`);
}
