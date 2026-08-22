import { analysisConfidence, createAnalysisContext } from "../analysis-context.js";
import { stableHash } from "../clone-utils.js";
import { artifactBase, sourceSetHash } from "../provenance.js";
import { writeArtifact } from "../writer.js";
import type { AnalysisContext, AttwProblem, Config, PackageToolStatus, PublintMessage, ScoredRecord } from "../types.js";

export function measurePackageHealth(config: Config, command: string, context: AnalysisContext = createAnalysisContext(config)) {
  const project = context.project();
  const result = context.packageHealth();
  const records = result.enabled ? packageRecords(result) : [];
  const complete = result.enabled && [result.declaration, result.pack, result.publint, result.attw].every((status) => status.complete);
  const confidence = result.enabled
    ? analysisConfidence(config, project, {
        package_health_enabled: true,
        package_declaration_complete: result.declaration.complete,
        package_pack_complete: result.pack.complete,
        publint_complete: result.publint.complete,
        attw_complete: result.attw.complete,
        required_inputs: [
          "package_json_found",
          "package_declaration_complete",
          "package_pack_complete",
          "publint_complete",
          "attw_complete",
        ],
      })
    : analysisConfidence(config, project, { package_health_enabled: false });
  const artifact = {
    ...artifactBase(config, "quality.package_health", command, confidence, sourceSetHash(project)),
    summary: {
      status: result.enabled ? complete ? "complete" : "incomplete" : "disabled",
      complete,
      records: records.length,
      blocking_findings: records.filter((record) => record.disposition === "block").length,
      publint_messages: result.publint.messages.length,
      attw_problems: result.attw.problems.length,
      packed_files: result.pack.files,
      packed_size: result.pack.size,
    },
    tool_status: {
      declaration_emit: result.declaration,
      npm_pack: result.pack,
      publint: { ...result.publint, messages: undefined },
      are_the_types_wrong: { ...result.attw, problems: undefined },
    },
    package_evidence: {
      publint_messages: result.publint.messages,
      attw_problems: result.attw.problems,
    },
    records,
  };
  writeArtifact(config, "package_health.json", artifact);
  return artifact;
}

function packageRecords(result: ReturnType<AnalysisContext["packageHealth"]>): ScoredRecord[] {
  return [
    ...statusFailureRecord("declaration-emit", result.declaration, "TypeScript declaration emit did not complete."),
    ...statusFailureRecord("pack", result.pack, "Safe package packing did not complete."),
    ...statusFailureRecord("publint", result.publint, "Publint package validation did not complete."),
    ...statusFailureRecord("attw", result.attw, "Are The Types Wrong validation did not complete."),
    ...result.publint.messages.map(publintRecord),
    ...result.attw.problems.map(attwRecord),
  ];
}

function statusFailureRecord(name: string, status: PackageToolStatus, message: string): ScoredRecord[] {
  if (status.complete) return [];
  return [{
    id: `package:tool-failure:${name}`,
    rule_id: `ts-react-quality-lens/package-${name}-complete`,
    kind: "package_tool_incomplete",
    evidence_kind: "diagnostic",
    disposition: "block",
    finding_confidence: "high",
    scope: "project",
    score: 100,
    severity: "high",
    risk: "high",
    source: name,
    message: `${message}${status.reason ? ` ${status.reason}` : ""}`,
    signals: [{ kind: "tool_incomplete", value: name }],
  }];
}

function publintRecord(message: PublintMessage): ScoredRecord {
  const disposition = message.type === "error" ? "block" : message.type === "warning" ? "warn" : "info";
  return {
    id: `publint:${message.code}:${stableHash(JSON.stringify(message.path))}`,
    rule_id: `publint/${message.code}`,
    kind: "package_manifest_issue",
    evidence_kind: "tool-rule",
    disposition,
    finding_confidence: "high",
    scope: "project",
    file: "package.json",
    score: disposition === "block" ? 100 : disposition === "warn" ? 60 : 20,
    severity: disposition === "block" ? "high" : disposition === "warn" ? "medium" : "low",
    risk: disposition === "block" ? "high" : disposition === "warn" ? "medium" : "low",
    source: "publint",
    message: `Publint reported ${message.code} at ${message.path.join(".") || "package.json"}.`,
    package_path: message.path,
    details: message.args,
    signals: [{ kind: message.code }],
  };
}

function attwRecord(problem: AttwProblem): ScoredRecord {
  const advisory = ["CJSResolvesToESM", "FallbackCondition", "NamedExports"].includes(problem.kind);
  const disposition = advisory ? "warn" : "block";
  const identity = `${problem.kind}:${problem.entrypoint ?? "."}:${problem.resolutionKind ?? "unknown"}`;
  return {
    id: `attw:${stableHash(identity)}`,
    rule_id: `are-the-types-wrong/${problem.kind}`,
    kind: "package_type_resolution_issue",
    evidence_kind: "tool-rule",
    disposition,
    finding_confidence: "high",
    scope: "project",
    score: disposition === "block" ? 100 : 65,
    severity: disposition === "block" ? "high" : "medium",
    risk: disposition === "block" ? "high" : "medium",
    source: "are-the-types-wrong",
    message: `Package type resolution problem ${problem.kind} for ${problem.entrypoint ?? "."} under ${problem.resolutionKind ?? "an evaluated resolution mode"}.`,
    entrypoint: problem.entrypoint ?? ".",
    resolution_mode: problem.resolutionKind ?? null,
    signals: [{ kind: problem.kind, ...(problem.resolutionKind ? { value: problem.resolutionKind } : {}) }],
  };
}
