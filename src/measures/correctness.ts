import { analysisConfidence, artifactBase, createAnalysisContext, runTestCommand, sourceSetHash, testRecord, writeArtifact } from "../measure-shared.js";
import type { AnalysisContext, Config, TestExecution } from "../types.js";

export function measureCorrectnessCatalog(
  config: Config,
  command: string,
  runTests = false,
  context: AnalysisContext = createAnalysisContext(config),
) {
  const project = context.project();
  const tests = project.testFiles.map((file) => testRecord(config, file, project.modules));
  const execution: TestExecution = runTests ? runTestCommand(config) : { status: "not_run", command: config.testCommand };
  const summary = {
    tests: tests.length,
    colocated_tests: tests.filter((test) => test.locality === "colocated").length,
    external_tests: tests.filter((test) => test.locality !== "colocated").length,
    execution_status: execution.status,
  };
  const review = {
    ...artifactBase(
      config,
      runTests ? "correctness.all" : "correctness.catalog",
      command,
      analysisConfidence(config, project, { test_command_configured: Boolean(config.testCommand) }),
      sourceSetHash(project),
    ),
    summary,
    execution,
    tests,
  };
  const catalog = {
    ...artifactBase(config, "correctness.catalog", command, analysisConfidence(config, project), sourceSetHash(project)),
    summary,
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      path: test.path,
      framework: test.framework,
      source_mapping: test.source_mapping,
      status: "not_run",
      suite_status: execution.status,
      command_hint: config.testCommand,
    })),
  };
  writeArtifact(config, "correctness_review.json", review);
  writeArtifact(config, "test_catalog.json", catalog);
  return review;
}
