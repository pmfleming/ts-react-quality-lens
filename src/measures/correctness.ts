import { createAnalysisContext, analysisConfidence, runTestCommand, testRecord } from "../measure-support.js";
import { artifactBase } from "../provenance.js";
import { writeArtifact } from "../writer.js";

export function measureCorrectnessCatalog(config, command, runTests = false, context = createAnalysisContext(config)) {
  const project = context.project();
  const tests = project.testFiles.map((file) => testRecord(config, file, project.modules));
  const execution = runTests ? runTestCommand(config) : { status: "not_run", command: config.testCommand };
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
    ),
    summary,
    execution,
    tests,
  };
  const catalog = {
    ...artifactBase(config, "correctness.catalog", command, analysisConfidence(config, project)),
    summary,
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      path: test.path,
      framework: test.framework,
      source_mapping: test.source_mapping,
      status: execution.status === "passed" ? "unknown" : "not_run",
      command_hint: config.testCommand,
    })),
  };
  writeArtifact(config, "correctness_review.json", review);
  writeArtifact(config, "test_catalog.json", catalog);
  return review;
}
