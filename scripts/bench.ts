import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { createAnalysisContext } from "../src/analysis-context.js";
import { runMeasure } from "../src/measure-runner.js";

const sizes = [10, 50, 100];
const results = [];

for (const files of sizes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-bench-${files}-`));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `bench-${files}`, type: "module" }), "utf8");
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }),
      "utf8",
    );
    for (let index = 0; index < files; index += 1) {
      const next = index + 1 < files ? `import { value${index + 1} } from "./file${index + 1}.js";\n` : "";
      fs.writeFileSync(
        path.join(root, "src", `file${index}.ts`),
        `${next}export const value${index} = ${index};\nexport function fn${index}() { return value${index}${index + 1 < files ? ` + value${index + 1}` : ""}; }\n`,
        "utf8",
      );
    }
    fs.writeFileSync(
      path.join(root, "ts-react-quality-lens.config.json"),
      JSON.stringify({ project_name: `bench-${files}`, project_root: ".", source_roots: ["src"], output_dir: "target/analysis", tsconfig: "tsconfig.json", cache: { enabled: false } }),
      "utf8",
    );
    const config = loadConfig(path.join(root, "ts-react-quality-lens.config.json"));
    const context = createAnalysisContext(config);
    for (const run of ["cold-context", "warm-context"]) {
      const before = process.memoryUsage();
      const start = performance.now();
      runMeasure(config, "all", `bench ${files}`, { context, allowTestExecution: false });
      const memory = process.memoryUsage();
      results.push({ files, run, duration_ms: Math.round(performance.now() - start),
        rss_before_bytes: before.rss, rss_after_bytes: memory.rss, heap_used_after_bytes: memory.heapUsed,
        process_peak_rss_kib: process.resourceUsage().maxRSS });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ benchmark: "synthetic", node: process.version, platform: process.platform,
  scope: "same process and context; disk cache disabled; no project tests; process RSS peak is cumulative", results }, null, 2));
