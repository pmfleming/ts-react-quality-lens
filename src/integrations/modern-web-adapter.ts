import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJson } from "../collections.js";
import { arrayOf, count, nonempty, optional, positiveInteger, shape, string } from "../validation.js";
import { toPosix } from "../files.js";
import { within, type WebInputSet } from "../web-inputs.js";
import { modernWebUnavailableReason, resolveModernWebTool } from "./modern-web-tool.js";
import type { ModernWebCandidate, ModernWebExecution } from "../modern-web-types.js";
import type { Config } from "../types.js";

const LIMITATIONS = [
  "Scanner results are provisional and require contextual verification against the keep/drop criteria.",
  "Upstream does not report per-file parser failures or a complete evaluated-file inventory; empty results are not clean evidence.",
  "Upstream format, minification and size filters may skip selected inputs. Only the scanner's qualified rule subset is evaluated.",
  "The public CLI omits internal guide hashes and exact expression ranges.",
];

export function runModernWeb(config: Config, inputs: WebInputSet): ModernWebExecution {
  const started = Date.now();
  const initial: ModernWebExecution = { status: "disabled", available: false, ran: false, complete: false, reason: null,
    version: null, duration_ms: 0, candidates: [], active_rules: null, active_guides: null, coverage: "not_run", limitations: LIMITATIONS };
  if (!config.modernWeb.enabled) return initial;
  const tool = resolveModernWebTool(config);
  const reason = modernWebUnavailableReason(tool);
  if (!tool || reason) return { ...initial, status: "unavailable", available: tool !== null, version: tool?.version ?? null, reason };
  let snapshot: string | null = null;
  try {
    snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "lens-web-scan-"));
    for (const file of inputs.files) {
      const destination = path.resolve(snapshot, file.relativePath);
      if (!within(snapshot, destination)) throw new Error("Web input escapes the selected snapshot.");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.text);
    }
    const output = childProcess.execFileSync(process.execPath, [tool.executable, "legacy-scan", snapshot, "--json", "--include-docs-and-tests"], {
      cwd: snapshot, encoding: "utf8", timeout: config.modernWeb.timeoutMs, maxBuffer: config.modernWeb.maxOutputBytes,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DISABLE_TELEMETRY: "1", NO_COLOR: "1" },
    });
    const report = parseModernWebReport(parseJson(output), inputs, snapshot);
    return { ...initial, ...report, status: "succeeded", available: true, ran: true, complete: true, version: tool.version,
      duration_ms: Date.now() - started, coverage: "unknown" };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split(snapshot ?? "<no-snapshot>").join("<snapshot>").slice(0, 2000);
    return { ...initial, status: "failed", available: true, ran: true, version: tool.version,
      duration_ms: Date.now() - started, reason };
  } finally {
    if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

const rubric = shape({ keepWhen: arrayOf(string), dropWhen: arrayOf(string) });
const finding = shape({ file: nonempty, line: positiveInteger, message: nonempty, lineContent: string });
const rule = shape({ ruleId: nonempty, summary: nonempty, verifierRubric: optional(rubric), count,
  findings: arrayOf(finding) });
const guide = shape({ guideId: nonempty, count, rules: arrayOf(rule) });
const report = shape({ targetDir: nonempty, totalFindings: count, guides: arrayOf(guide), activeRuleCount: optional(count),
  activeGuideCount: optional(count), skippedDocsAndTestsCount: optional(count), error: optional(string) });

export function parseModernWebReport(value: unknown, inputs: WebInputSet, snapshot: string): Pick<ModernWebExecution, "candidates" | "active_rules" | "active_guides"> {
  if (!report(value) || value.error !== undefined) throw new Error("Invalid modernization report payload.");
  if (path.resolve(snapshot, value.targetDir) !== snapshot) throw new Error("Scanner returned a different target directory.");
  const selected = new Map(inputs.files.map((file) => [file.relativePath, file]));
  const candidates: ModernWebCandidate[] = [];
  for (const group of value.guides) {
    if (!/^[a-z0-9-]+$/.test(group.guideId) || group.count !== group.rules.reduce((sum, item) => sum + item.count, 0)) {
      throw new Error("Invalid modernization guide or count.");
    }
    for (const entry of group.rules) {
      if (entry.count !== entry.findings.length) throw new Error("Invalid modernization rule count.");
      for (const item of entry.findings) {
        const absolute = path.resolve(snapshot, item.file);
        const relative = toPosix(path.relative(snapshot, absolute));
        const file = selected.get(relative);
        const line = file?.text.split(/\r?\n/)[item.line - 1];
        if (!within(snapshot, absolute) || !file || line === undefined || line.trim() !== item.lineContent.trim()) {
          throw new Error("Scanner finding is outside the selected inputs or has a stale source location.");
        }
        candidates.push({ rule_id: entry.ruleId, guide_id: group.guideId, summary: entry.summary, file: relative, line: item.line,
          message: item.message, line_content: line, verification: entry.verifierRubric ?? null });
      }
    }
  }
  if (value.totalFindings !== candidates.length) throw new Error("Invalid modernization finding count.");
  return { candidates: candidates.sort((a,b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule_id.localeCompare(b.rule_id)),
    active_rules: value.activeRuleCount ?? null, active_guides: value.activeGuideCount ?? null };
}
