import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRecord, parseJson } from "./collections.js";
import { packageRootFrom } from "./package-root.js";
import type { Config, ScoredRecord } from "./types.js";

export type EditorRequest = { version: 1; config: Config };
type EditorResult = { version: 1; findings: ScoredRecord[] };
const string = { type: "string" }, boolean = { type: "boolean" }, number = { type: "number" };
const nullableString = { type: ["string", "null"] }, nullableNumber = { type: ["number", "null"] };
const array = (items: object) => ({ type: "array", items });
const strings = array(string);
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const enumeration = (...values: string[]) => ({ enum: values });
const profile = enumeration("baseline", "recommended", "strict", "react", "library");
const raw = (name: string) => ({ $ref: `config#/properties/${name}` });

// Every normalized field is checked; using the snapshot preserves caller overrides and
// avoids re-reading a changed config file between the request and worker startup.
const configProperties = {
  configPath: string, configDir: string, projectName: string, projectRoot: string,
  sourceRoots: strings, testRoots: strings, outputDir: string, tsconfig: nullableString,
  packageManager: string, packageManagerDetected: boolean, framework: string, testRunner: string,
  testCommand: nullableString, testTimeoutMs: number, coverageReport: nullableString, exclude: strings,
  layerRules: array(object({ layer: string, patterns: strings })),
  performanceInputs: object({ bundleStats: nullableString, renderCosts: nullableString }),
  publicApi: object({ entry: strings, exports: array(object({ file: string, names: strings })) }),
  cache: object({ enabled: boolean, dir: string }),
  react: object({ ruleset: enumeration("classic-v1", "recommended-v2"), version: nullableString, additionalEffectHooks: nullableString }),
  typedLint: object({ mode: enumeration("auto", "project-service", "project") }),
  typescript: object({ targets: array(object({ tsconfig: string, environment: enumeration("node", "bundler", "browser", "library") })), measurePerformance: boolean }),
  documentation: object({ enabled: boolean, exclude: strings, exemptExports: array(object({ file: string, names: strings, reason: string })) }),
  accessibility: object({ enabled: boolean, components: { type: "object", additionalProperties: string }, polymorphicPropName: nullableString }),
  cleanup: object({ knip: boolean, production: boolean }),
  typeCoverage: object({ minimumPercent: nullableNumber, perFileMinimumPercent: nullableNumber, changedFileMinimumPercent: nullableNumber, baseline: nullableString }),
  packageHealth: object({ enabled: boolean, attwProfile: enumeration("strict", "node16", "esm-only") }),
  sarifInputs: array(object({ path: string, name: string, required: boolean })),
  workspaces: object({ enabled: boolean, patterns: strings, overrides: array(object({ workspace: string, framework: string, policy_profile: profile }, ["workspace"])) }),
  runtimeInputs: object({ reactProfiler: nullableString, reactCompiler: nullableString, performanceCurrent: nullableString, performanceBaseline: nullableString, axe: nullableString, reactDoctor: nullableString }),
  modernWeb: object({ enabled: boolean, roots: strings, exclude: strings, timeoutMs: number, maxOutputBytes: number,
    browsers: object({ targets: { anyOf: [strings, { type: "null" }] }, environment: string }) }),
  policy: object({ profile, requiredChecks: array(enumeration("compiler", "typed-lint", "tests", "react-hooks", "package")) }),
  suppressions: raw("suppressions"),
  audit: object({ base: nullableString, changedSince: nullableString, gate: enumeration("new-only", "all"), baseline: nullableString }),
  pathAliases: array(object({ pattern: string, replacements: strings })), raw: { $ref: "config" },
} satisfies Record<keyof Config, object>;

const validators = (() => {
  let cached: ReturnType<typeof compile> | undefined;
  function compile() {
    const root = packageRootFrom(import.meta.url);
    const read = (file: string) => {
      const schema = parseJson(fs.readFileSync(path.join(root, file), "utf8"));
      if (!isRecord(schema)) throw new Error(`Invalid schema: ${file}`);
      return schema;
    };
    const artifact = read("ts-react-quality-lens.schema.json");
    const defs = artifact.$defs;
    if (!isRecord(defs) || !isRecord(defs.finding) || !isRecord(defs.finding.properties)) throw new Error("Missing finding schema");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(read("ts-react-quality-lens.config.schema.json"), "config");
    // ScoredRecord allows partially enriched findings; all present fields still use
    // the artifact contract, including nested locations and actions.
    const action = (type: string, fields: Record<string, object>, required: string[]) => object({
      type: { const: type }, auto_fixable: boolean, description: string, ...fields,
    }, ["type", "auto_fixable", "description", ...required]);
    const actions = array({ anyOf: [
      action("fix", { fix: string, note: string }, ["fix"]),
      action("suppress-line", { auto_fixable: { const: false }, comment: string }, ["comment"]),
      action("suppress-file", { auto_fixable: { const: false }, comment: string }, ["comment"]),
      action("add-to-config", { config_key: string, value: { $ref: "#/$defs/jsonValue" } }, ["config_key", "value"]),
    ] });
    const finding = { ...defs.finding, required: ["id"], properties: { ...defs.finding.properties, actions } };
    const jsonValue = { anyOf: [{ type: ["string", "number", "boolean", "null"] }, array({ $ref: "#/$defs/jsonValue" }),
      { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } }] };
    return {
      request: ajv.compile<EditorRequest>(object({ version: { const: 1 }, config: object(configProperties) })),
      result: ajv.compile<EditorResult>({ ...object({ version: { const: 1 }, findings: array(finding) }), $defs: { ...defs, jsonValue } }),
    };
  }
  return () => cached ??= compile();
})();

export function decodeEditorRequest(value: unknown): Config {
  if (!validators().request(value)) throw new Error("Invalid editor analysis request");
  return value.config;
}
export function decodeEditorResult(value: unknown): ScoredRecord[] {
  if (!validators().result(value)) throw new Error("Invalid editor analysis result");
  return value.findings;
}
