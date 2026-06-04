import { performance } from "node:perf_hooks";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/cli.js";

const configPath = path.resolve("examples/basic/ts-react-quality-lens.config.json");
const maxMs = Number(process.env.TSRQLENS_PERF_MAX_MS ?? 60000);
const config = loadConfig(configPath);
const start = performance.now();
runMeasure(config, "all", "perf smoke");
const durationMs = Math.round(performance.now() - start);

if (durationMs > maxMs) {
  throw new Error(`Perf smoke exceeded ${maxMs}ms: ${durationMs}ms`);
}

console.log(JSON.stringify({ fixture: "examples/basic", duration_ms: durationMs, max_ms: maxMs }, null, 2));
