import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changeSetSince, defaultBase, findingTouchesChangedLine } from "../src/audit/change-set.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/types.js";

function git(root: string, ...args: string[]): string {
  return childProcess.execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Lens Test",
    "-c", "user.email=lens@example.com", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `export const ${prefix}${index + 1} = ${index + 1};`);

function repository(run: (root: string, config: Config) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-change-set-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "lens.json"), JSON.stringify({ source_roots: ["src"], test_command: null }));
    fs.writeFileSync(path.join(root, "src/edit.ts"), `${lines(10).join("\n")}\n`);
    fs.writeFileSync(path.join(root, "src/delete.ts"), `${lines(6).join("\n")}\n`);
    fs.writeFileSync(path.join(root, "src/old-name.ts"), `${lines(8).join("\n")}\n`);
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    run(root, loadConfig(path.join(root, "lens.json")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("changed line ranges match git hunks exactly for edits, appends, deletions and renames", () => repository((root, config) => {
  const edit = lines(10);
  edit[2] = "export const line3 = 30;";
  edit.splice(7, 0, "export const added1 = 1;", "export const added2 = 2;");
  fs.writeFileSync(path.join(root, "src/edit.ts"), `${edit.join("\n")}\n`);
  const remaining = lines(6);
  remaining.splice(3, 2);
  fs.writeFileSync(path.join(root, "src/delete.ts"), `${remaining.join("\n")}\n`);
  git(root, "mv", "src/old-name.ts", "src/new-name.ts");
  const renamed = lines(8);
  renamed[4] = "export const line5 = 50;";
  fs.writeFileSync(path.join(root, "src/new-name.ts"), `${renamed.join("\n")}\n`);

  const changes = changeSetSince(config, "HEAD");
  assert.equal(changes.complete, true, changes.reason ?? "");
  // Line 3 replaced; two lines inserted after original line 7 become lines 8-9 of the new file.
  assert.deepEqual(changes.lines.get("src/edit"), [{ start: 3, end: 3 }, { start: 8, end: 9 }]);
  // A pure deletion has no new lines; it is anchored at the line before the removed span.
  assert.deepEqual(changes.lines.get("src/delete"), [{ start: 3, end: 3 }]);
  assert.ok(changes.files.includes("src/new-name.ts"));
  assert.ok(changes.lines.get("src/new-name")?.some((range) => range.start <= 5 && range.end >= 5), JSON.stringify([...changes.lines]));

  const at = (line: number, end = line) => ({ id: "fixture", file: "src/edit.ts", line, end_line: end });
  assert.equal(findingTouchesChangedLine(at(3), changes.lines), true);
  assert.equal(findingTouchesChangedLine(at(4), changes.lines), false, "the line after a one-line hunk is unchanged");
  assert.equal(findingTouchesChangedLine(at(7), changes.lines), false, "the line before an insertion is unchanged");
  assert.equal(findingTouchesChangedLine(at(9), changes.lines), true);
  assert.equal(findingTouchesChangedLine(at(10), changes.lines), false, "the line after an insertion is unchanged");
  assert.equal(findingTouchesChangedLine(at(4, 8), changes.lines), true, "a span overlapping a hunk touches it");
}));

test("paths that git quotes or pads keep their exact names, and untracked files are whole-file changes", { skip: process.platform === "win32" }, () => repository((root, config) => {
  const spaced = "src/with space ü.ts", quoted = 'src/quote"d.ts';
  for (const file of [spaced, quoted]) fs.writeFileSync(path.join(root, file), `${lines(2).join("\n")}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "special names");
  for (const file of [spaced, quoted]) fs.writeFileSync(path.join(root, file), `${lines(2, "changed").join("\n")}\n`);
  fs.writeFileSync(path.join(root, "src/untracked.ts"), `${lines(4).join("\n")}\n`);
  fs.symlinkSync(path.join(root, "missing-target.ts"), path.join(root, "src/dangling.ts"));

  const changes = changeSetSince(config, "HEAD");
  assert.equal(changes.complete, true, changes.reason ?? "unreadable untracked entries must not abort the comparison");
  assert.deepEqual(changes.lines.get("src/with space ü"), [{ start: 1, end: 2 }]);
  assert.deepEqual(changes.lines.get('src/quote"d'), [{ start: 1, end: 2 }]);
  assert.deepEqual(changes.lines.get("src/untracked"), [{ start: 1, end: 4 }], "no phantom line after the final newline");
  assert.ok(changes.files.includes("src/dangling.ts"), "a dangling symlink still counts as a changed path");
  assert.equal(changes.lines.has("src/dangling"), false, "it has no readable lines");
}));

test("an unresolvable base is incomplete, and defaultBase only selects an existing origin/main", () => repository((root, config) => {
  const failed = changeSetSince(config, "__no_such_ref__");
  assert.equal(failed.complete, false);
  assert.match(failed.reason ?? "", /Git comparison against __no_such_ref__ failed/);
  assert.equal(defaultBase(config), null);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(defaultBase(config), "origin/main");
}));
