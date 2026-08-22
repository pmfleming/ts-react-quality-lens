import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { runMeasure } from "../src/cli.js";
import type { Artifact } from "../src/types.js";

type CorpusCase = {
  id: string;
  contract_id: string;
  verdict: "true-positive" | "false-positive";
  file: string;
  source: string;
  mutation: { search: string; replace: string };
};

type Corpus = { schema_version: string; cases: CorpusCase[] };

const repoRoot = path.resolve();
const corpus = JSON.parse(fs.readFileSync(path.join(repoRoot, "test", "rule-corpus", "cases.json"), "utf8")) as Corpus;

test("rule corpus preserves true and false-positive verdicts after identifier and location mutations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ts-react-quality-lens-${process.pid}-rule-corpus-`));
  const sourceDir = path.join(tempDir, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({ name: "rule-corpus", type: "module", dependencies: { react: "catalog:" } }),
    "utf8",
  );
  for (const item of corpus.cases) writeCaseFiles(sourceDir, item);
  const configPath = path.join(tempDir, "ts-react-quality-lens.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ project_root: ".", source_roots: ["src"], output_dir: "target/analysis", framework: "react" }),
    "utf8",
  );

  try {
    const config = loadConfig(configPath);
    const [managed] = runMeasure(config, "quality.react_health", "rule corpus managed") as [Artifact];
    assertCorpus(managed, corpus.cases.filter((item) => item.contract_id !== "ts-react-quality-lens/img_missing_alt"));

    config.accessibility.enabled = false;
    const [fallback] = runMeasure(config, "quality.react_health", "rule corpus fallback") as [Artifact];
    assertCorpus(fallback, corpus.cases.filter((item) => item.contract_id === "ts-react-quality-lens/img_missing_alt"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeCaseFiles(sourceDir: string, item: CorpusCase): void {
  fs.writeFileSync(path.join(sourceDir, item.file), item.source, "utf8");
  const mutated = `// verdict-preserving location mutation\n${item.source.replaceAll(item.mutation.search, item.mutation.replace)}`;
  fs.writeFileSync(path.join(sourceDir, mutatedFile(item.file)), mutated, "utf8");
}

function assertCorpus(artifact: Artifact, cases: CorpusCase[]): void {
  for (const item of cases) {
    assertVerdict(artifact, item, `src/${item.file}`);
    assertVerdict(artifact, item, `src/${mutatedFile(item.file)}`);
  }
}

function assertVerdict(artifact: Artifact, item: CorpusCase, file: string): void {
  const present = artifact.records?.some((record) => record.rule_id === item.contract_id && record.file === file) ?? false;
  assert.equal(
    present,
    item.verdict === "true-positive",
    `${item.id} should remain ${item.verdict} for ${file}`,
  );
}

function mutatedFile(file: string): string {
  const extension = path.extname(file);
  return `${file.slice(0, -extension.length)}.mutated${extension}`;
}
