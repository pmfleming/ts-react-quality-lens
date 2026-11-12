import * as ts from "typescript";
import { webContentHash } from "./web-inputs.js";
import type { ModernWebCandidate } from "./modern-web-types.js";
import type { ScoredRecord } from "./types.js";

export function modernWebFindings(candidates: ModernWebCandidate[]): ScoredRecord[] {
  const occurrences = new Map<string, number>();
  return candidates.map((candidate) => {
    const fingerprint = webContentHash([candidate.rule_id, candidate.guide_id, candidate.file, anchor(candidate)]);
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return {
      id: `modern-web:${fingerprint}:${occurrence}`, fingerprint, occurrence,
      rule_id: `modern-web-guidance/${candidate.rule_id}`, source: "modern-web-guidance",
      kind: "web_modernization_candidate", evidence_kind: "heuristic", disposition: "review", finding_confidence: "low",
      semantic_decision: "unresolved", reason_code: "contextual-verification-required", scope: "file", score: 0, risk: "low",
      file: candidate.file, line: candidate.line, message: candidate.message, guide_id: candidate.guide_id,
      guide_url: "https://developer.chrome.com/docs/modern-web-guidance/guides", verification: candidate.verification,
      contextual_verification: "pending", actions: [{ type: "fix", auto_fixable: false,
        description: "Review this modernization candidate.",
        fix: "Verify the keep/drop criteria and browser targets before selecting a replacement. No automatic edit is available." }],
    };
  });
}

function anchor(candidate: ModernWebCandidate): string {
  if (!/\.[cm]?[jt]sx?$/.test(candidate.file)) {
    // Keep internal HTML/CSS whitespace: collapsing it could conflate different selectors or text.
    return candidate.line_content.trim();
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, candidate.line_content);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return JSON.stringify(tokens);
}
