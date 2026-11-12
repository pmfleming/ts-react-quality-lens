import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAnalysisContext } from "../src/analysis-context.js";
import { runAudit } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { deterministicEvidence } from "../src/deterministic-evidence.js";
import { runMeasure } from "../src/measure-runner.js";
import { artifactNames, withStore } from "../src/store.js";
import { readArtifact } from "../src/writer.js";

const [rootArg, outputArg, profile, scope = "app"] = process.argv.slice(2);
if (!rootArg || !outputArg || !["focused", "audit"].includes(profile ?? "") || !["app", "functions"].includes(scope)) {
  throw new Error("Usage: trust-campaign ROOT OUTPUT focused|audit app|functions");
}
const root = path.resolve(rootArg), output = path.resolve(outputArg);
const project = scope === "functions" ? path.join(root, "functions") : root;
const config = loadConfig(path.join(project, "ts-react-quality-lens.config.json"));
config.outputDir = path.join(output, "artifacts");
config.cache = { enabled: true, dir: path.join(config.outputDir, ".cache") };
if (scope === "functions") {
  config.sourceRoots = [path.join(project, "src")];
  config.testRoots = [];
  config.policy = { profile: "recommended", requiredChecks: ["compiler", "typed-lint"] };
}
fs.mkdirSync(config.outputDir, { recursive: true });
const start = performance.now();
if (profile === "audit") {
  runAudit(config, "acceptance trust campaign", { gate: "all", compareBase: false, runTests: true });
} else {
  const context = createAnalysisContext(config);
  for (const task of ["quality.hotspots", "quality.escape_hatches", "quality.type_health", "quality.lint"]) {
    runMeasure(config, task, "acceptance trust campaign", { context });
  }
}
const raw = Object.fromEntries(withStore(config.outputDir, artifactNames).map((name) => {
  const artifact = readArtifact(config, name);
  if (!artifact) throw new Error(`Invalid published artifact ${name}`);
  return [name, artifact];
}));
const semantic = Object.fromEntries(Object.entries(raw).map(([name, artifact]) => [name, deterministicEvidence(artifact)]));
const bytes = JSON.stringify(semantic, null, 2) + "\n";
fs.writeFileSync(path.join(output, "snapshot.raw.json"), JSON.stringify(raw, null, 2) + "\n");
fs.writeFileSync(path.join(output, "snapshot.semantic.json"), bytes);
const audit = raw["audit.json"];
console.log(JSON.stringify({ profile, scope, node: process.version,
  duration_ms: Math.round(performance.now() - start), node_peak_rss_kib: process.resourceUsage().maxRSS,
  memory_scope: "Node analyzer process only; excludes subprocess peaks", artifacts: Object.keys(raw).length,
  semantic_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  audit: audit?.summary ?? null,
  capabilities: Object.fromEntries(Object.entries(raw).map(([name, artifact]) => [name, artifact.capabilities])),
  source_hash: Object.values(raw)[0]?.provenance.source_set_hash,
  analysis_identity: Object.values(raw)[0]?.analysis_identity,
}));
