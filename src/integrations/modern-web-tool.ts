import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import semver from "semver";
import { isRecord, parseJson } from "../collections.js";
import { webContentHash, within } from "../web-inputs.js";
import type { Config } from "../types.js";

export const MODERN_WEB_VERSION = "1.0.0";
export type ModernWebTool = { manifest: string; executable: string; version: string; engine: string; fingerprint: string };

/** Resolve installed files only. The adapter never invokes npx or installs a package. */
export function resolveModernWebTool(config: Config): ModernWebTool | null {
  for (const require of [createRequire(path.join(config.projectRoot, "package.json")), createRequire(import.meta.url)]) {
    try {
      const manifest = require.resolve("modern-web-guidance/package.json");
      const text = fs.readFileSync(manifest, "utf8");
      const value = parseJson(text);
      if (!isRecord(value) || value.name !== "modern-web-guidance" || typeof value.version !== "string" ||
          !isRecord(value.bin) || typeof value.bin["modern-web-guidance"] !== "string" ||
          !isRecord(value.engines) || typeof value.engines.node !== "string") return null;
      const executable = path.resolve(path.dirname(manifest), value.bin["modern-web-guidance"]);
      if (!within(path.dirname(manifest), executable)) return null;
      const scanner = path.join(path.dirname(executable), "legacy-scan.mjs");
      const fingerprint = webContentHash([text, fs.readFileSync(executable, "utf8"),
        fs.existsSync(scanner) ? fs.readFileSync(scanner, "utf8") : "missing-scanner-bundle"]);
      return { manifest, executable, version: value.version, engine: value.engines.node, fingerprint };
    } catch { /* Try the lens installation after the project installation. */ }
  }
  return null;
}

export function modernWebUnavailableReason(tool: ModernWebTool | null, nodeVersion = process.versions.node): string | null {
  if (!tool) return "Install modern-web-guidance@1.0.0 locally to enable this optional integration.";
  if (tool.version !== MODERN_WEB_VERSION) return `Unsupported scanner version ${tool.version}; validated version is ${MODERN_WEB_VERSION}.`;
  if (!semver.satisfies(nodeVersion, ">=22.0.0") || !semver.satisfies(nodeVersion, tool.engine)) {
    return `Scanner requires Node >=22.0.0 and ${tool.engine}; current runtime is ${nodeVersion}.`;
  }
  return null;
}
