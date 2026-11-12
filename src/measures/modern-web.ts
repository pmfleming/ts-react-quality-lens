import { artifactBase, taskInputHash } from "../provenance.js";
import { discoverWebInputs } from "../web-inputs.js";
import { runModernWeb } from "../integrations/modern-web-adapter.js";
import { browserDataVersions, resolveWebBrowserTargets } from "../browser-targets.js";
import { modernWebFindings } from "../modern-web-findings.js";
import { MODERN_WEB_MAPPING_VERSION, modernWebGuideUrl, qualifyModernWeb } from "../modern-web-compatibility.js";
import { readArtifact, writeArtifact } from "../writer.js";
import type { AnalysisContext, Config, ScoredRecord } from "../types.js";

export function measureModernWeb(config: Config, command: string, _context?: AnalysisContext) {
  const inputs = discoverWebInputs(config);
  const initialHash = taskInputHash(config, "quality.modern_web", inputs.fingerprint, undefined, inputs);
  const targets = config.modernWeb.enabled ? resolveWebBrowserTargets(config, inputs) : {};
  let execution = runModernWeb(config, inputs);
  const unchanged = initialHash === taskInputHash(config, "quality.modern_web", inputs.fingerprint);
  if (!unchanged) execution = { ...execution, status: "failed", complete: false, candidates: [],
    reason: "Modernization inputs changed during execution; rerun analysis." };
  const candidates = modernWebFindings(execution.candidates);
  const files = new Map(inputs.files.map((file) => [file.relativePath, file]));
  const records = candidates.map((record, index): ScoredRecord => {
    const candidate = execution.candidates[index]!;
    const input = files.get(candidate.file);
    const compatibility = qualifyModernWeb(candidate, input, targets[candidate.file]);
    const guardNote = compatibility.guard === "observed" ? " An enclosing fallback guard was observed; verify that this code should remain." : "";
    return { ...record, upstream_message: record.message,
      message: `Review ${candidate.guide_id}: ${compatibility.reason}${guardNote}`,
      guide_url: modernWebGuideUrl(candidate, input), browser_targets: targets[candidate.file] ?? null, compatibility,
      actions: [{ type: "fix", auto_fixable: false, description: "Review modernization evidence and browser compatibility.",
        fix: `${compatibility.reason}${guardNote} Apply the keep/drop criteria before editing.`,
        note: compatibility.remediation === "withheld" ? "Replacement advice is withheld." : "This is advisory evidence, not an automatic fix." }],
    };
  });
  const { candidates: _candidates, ...toolStatus } = execution;
  const base = artifactBase(config, "quality.modern_web", command, {
    complete: false, partial: execution.status !== "disabled", confidence_scope: "selected_web_inputs; provisional modernization candidates",
    inputs_unchanged: unchanged, required_inputs: [], missing_input: [], stale_input: unchanged ? [] : ["web_inputs_changed"],
    unsupported_pattern: [{ kind: "unverified_scanner_coverage", message: execution.reason ?? execution.limitations.join(" ") }],
  }, inputs.fingerprint);
  return writeArtifact(config, "modern_web.json", {
    ...base, provenance: { ...base.provenance, input_set_hash: initialHash },
    summary: { status: execution.status, records: records.length, selected_files: inputs.files.length, skipped_files: inputs.skipped.length,
      coverage: execution.coverage, contextual_verification: "pending", mapping_version: MODERN_WEB_MAPPING_VERSION },
    tool_status: { modern_web: toolStatus },
    inputs: { fingerprint: inputs.fingerprint, files: inputs.files.map(({ relativePath, kind }) => ({ file: relativePath, kind })),
      skipped: inputs.skipped, configuration_files: inputs.configuration.map((file) => file.relativePath) },
    browser_data_versions: config.modernWeb.enabled ? browserDataVersions() : {}, browser_targets: targets,
    limitations: execution.limitations, records,
  });
}

/** Editors consume current saved evidence; they never launch the optional scanner. */
export function savedModernWebFindings(config: Config): ScoredRecord[] {
  if (!config.modernWeb.enabled) return [];
  const artifact = readArtifact(config, "modern_web.json");
  if (!artifact || artifact.summary.status !== "succeeded" ||
      artifact.provenance.input_set_hash !== taskInputHash(config, "quality.modern_web", "web-inputs")) return [];
  return artifact.records ?? [];
}
