import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readBaselineIds } from "../src/audit/baseline.js";
import { activeFindings, auditVerdict, gatedFindings } from "../src/audit/findings.js";
import { isRecord, parseJson } from "../src/collections.js";
import type { AuditFinding, FindingDisposition } from "../src/types.js";

const bin = fileURLToPath(new URL("../bin/ts-react-quality-lens.js", import.meta.url));

function finding(id: string, disposition: FindingDisposition, introduced: boolean, suppressed = false): AuditFinding {
  return {
    id, disposition, introduced, kind: "fixture", task_id: "fixture", rule_id: `fixture/${id}`, evidence_kind: "heuristic",
    finding_confidence: "high", ...(suppressed ? { suppressed: true, suppression_reason: "Configured suppression." } : {}),
  };
}

test("gate selection keeps unsuppressed findings in scope and only block/warn dispositions gate", () => {
  const findings = [
    finding("new-warn", "warn", true), finding("old-warn", "warn", false), finding("new-review", "review", true),
    finding("new-info", "info", true), finding("new-block-suppressed", "block", true, true), finding("old-block", "block", false),
  ];
  assert.deepEqual(activeFindings(findings, "new-only").map((item) => item.id), ["new-warn", "new-review", "new-info"]);
  assert.deepEqual(gatedFindings(findings, "new-only").map((item) => item.id), ["new-warn"]);
  assert.deepEqual(gatedFindings(findings, "all").map((item) => item.id), ["new-warn", "old-warn", "old-block"]);
});

test("verdict precedence is fail, then incomplete, then warn, then pass", () => {
  const warn = finding("warn", "warn", true), block = finding("block", "block", true);
  assert.equal(auditVerdict([], []), "pass");
  assert.equal(auditVerdict([warn], []), "warn");
  assert.equal(auditVerdict([warn], ["missing evidence"]), "incomplete");
  assert.equal(auditVerdict([block, warn], ["missing evidence"]), "fail");
  assert.equal(auditVerdict([], [], ["required verification failed"]), "fail");
  assert.equal(auditVerdict([finding("review", "review", true)], []), "pass");
});

test("audit baselines accept the documented object and top-level array formats", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lens-baseline-formats-"));
  try {
    const write = (name: string, text: string) => { const file = path.join(directory, name); fs.writeFileSync(file, text); return file; };
    assert.deepEqual([...readBaselineIds(write("ids.json", '{"findings":["a","b"]}'))], ["a", "b"]);
    assert.deepEqual([...readBaselineIds(write("records.json", '{"findings":[{"id":"a"},{"id":7},"b"]}'))], ["a", "b"]);
    assert.deepEqual([...readBaselineIds(write("array.json", '["a", 1, "b"]'))], ["a", "b"]);
    assert.deepEqual([...readBaselineIds(write("broken.json", "{"))], []);
    assert.deepEqual([...readBaselineIds(path.join(directory, "missing.json"))], []);
    assert.deepEqual([...readBaselineIds(null)], []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function git(root: string, ...args: string[]): string {
  // Neutralize user/global settings (signing, hooks, default branch) that would make the fixture environment-dependent.
  return childProcess.execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Lens Test",
    "-c", "user.email=lens@example.com", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type CliAudit = { status: number | null; artifact: Record<string, unknown>; summary: Record<string, unknown> };
function audit(root: string, ...args: string[]): CliAudit {
  const result = childProcess.spawnSync(process.execPath, [bin, "audit", "--config", path.join(root, "lens.json"), "--format", "json", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const artifact = parseJson(result.stdout);
  assert.ok(isRecord(artifact) && isRecord(artifact.summary), `audit printed no artifact: ${result.stderr}`);
  return { status: result.status, artifact, summary: artifact.summary };
}

const TS_IGNORE = (name: string) => [`// @ts-ignore`, `export const ${name}: number = 1;`];

test("CLI audit gates introduced findings by default, inherited ones with --gate all, and exits 0 on warn", { timeout: 300000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-audit-gate-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "gate-fixture", private: true, type: "module" }));
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "gate-fixture", lockfileVersion: 3, packages: {} }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, include: ["src"] }));
    fs.writeFileSync(path.join(root, ".gitignore"), "target/\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), [...TS_IGNORE("first"), ""].join("\n"));
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "without lens config");
    // The lens config is added after the first commit, so that commit is an unavailable base.
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({
      source_roots: ["src"], test_roots: ["src"], test_command: null, output_dir: "target/analysis",
      policy: { profile: "baseline" }, audit: { base: "__no_such_ref__" },
    }));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "inherited ts-ignore");

    const missing = audit(root, "--base", "HEAD~1");
    assert.equal(missing.summary.verdict, "incomplete");
    assert.equal(missing.status, 1);
    assert.ok((missing.summary.incomplete_reasons as string[]).some((reason) => /unavailable: the lens config does not exist at the base/.test(reason)),
      JSON.stringify(missing.summary.incomplete_reasons));

    // CLI --base outranks the unresolvable configured audit.base; an unchanged tree has nothing to gate.
    const clean = audit(root, "--base", "HEAD");
    assert.equal(clean.summary.verdict, "pass", JSON.stringify(clean.summary));
    assert.equal(clean.status, 0);
    assert.equal(clean.summary.complete, true);

    // --changed-since outranks --base.
    const precedence = audit(root, "--changed-since", "HEAD", "--base", "__no_such_ref__");
    assert.equal(precedence.summary.base, "HEAD");
    assert.equal(precedence.summary.complete, true);

    // Introduce one more warn finding at the end of the file, and change only the lockfile's bytes.
    fs.appendFileSync(path.join(root, "src/a.ts"), [...TS_IGNORE("second"), ""].join("\n"));
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "gate-fixture", lockfileVersion: 3, packages: { "": { name: "gate-fixture" } } }));

    const newOnly = audit(root, "--base", "HEAD");
    assert.equal(newOnly.summary.verdict, "warn", JSON.stringify(newOnly.summary));
    assert.equal(newOnly.status, 0, "warn must not fail the CLI");
    assert.equal(newOnly.summary.complete, true, "a lockfile change must not make the comparison incomplete");
    assert.equal(newOnly.summary.base_snapshot_compatible, false, "exact cross-lens compatibility still reports the config change");
    assert.equal((newOnly.artifact.confidence as Record<string, unknown>).base_snapshot_attributable, true);
    assert.equal(newOnly.summary.active_findings, 1);
    const ignores = (newOnly.artifact.findings as AuditFinding[]).filter((item) => item.kind === "ts_ignore");
    assert.deepEqual(ignores.map((item) => item.introduced).sort(), [false, true]);

    const all = audit(root, "--base", "HEAD", "--gate", "all");
    assert.equal(all.summary.gate, "all");
    assert.equal(all.summary.verdict, "warn");
    assert.equal(all.status, 0);
    assert.equal(all.summary.active_findings, 2, "--gate all also gates the inherited finding");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
