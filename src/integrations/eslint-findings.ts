import type { EslintMessage, FindingDisposition, ScoredRecord } from "../types.js";

type EslintFindingOptions = {
  id: string;
  kind: string;
  disposition: FindingDisposition;
  source: string;
  signal?: string;
  score?: number;
};

export function eslintFindingRecord(message: EslintMessage, options: EslintFindingOptions): ScoredRecord {
  const score = options.score ?? (options.disposition === "block" ? 90 : options.disposition === "warn" ? 60 : options.disposition === "review" ? 45 : 20);
  const severity = options.disposition === "block" ? "high" : options.disposition === "info" ? "low" : "medium";
  return {
    id: options.id,
    rule_id: message.rule_id,
    kind: options.kind,
    evidence_kind: "tool-rule",
    disposition: options.disposition,
    finding_confidence: "high",
    scope: "file",
    module_id: message.file.replace(/\.[cm]?[jt]sx?$/, ""),
    file: message.file,
    line: message.line,
    column: message.column,
    end_line: message.end_line,
    end_column: message.end_column,
    score,
    severity,
    risk: severity,
    source: options.source,
    message: message.message,
    signals: [{ kind: options.signal ?? options.kind, message: message.message }],
  };
}
