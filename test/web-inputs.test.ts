import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { inputSnapshot } from "../src/input-snapshot.js";
import { taskInputHash } from "../src/provenance.js";
import { discoverWebInputs } from "../src/web-inputs.js";
import { webFixture } from "./modern-web-helpers.js";

test("web discovery is scoped, deduplicated, and independent of compiler files", () => webFixture(({ write, config }) => {
  write("index.html", "<main>Hello</main>\n");
  write("src/view.module.css", ".view { color: red; }\n");
  write("src/view.scss", "$color: red;\n");
  write("src/view.test.ts", "export {};\n");
  write("docs/example.html", "<div>documentation</div>\n");
  write("vendor/widget.css", "a {}\n");
  write("target/analysis/generated.html", "generated\n");
  const c = config({ modern_web: { enabled: true, roots: [".", "src"], exclude: ["vendor"] } });
  const inventory = discoverWebInputs(c);
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ["index.html", "package.json", "src/index.ts", "src/view.module.css"]);
  assert.deepEqual(inventory.skipped, [{ file: "src/view.scss", reason: "unsupported_format" }]);
  const project = createAnalysisContext(c).project();
  assert.deepEqual(project.sourceFiles.map((file) => file.relativePath), ["src/index.ts"]);
}));

test("CSS edits, additions, removals and browser config invalidate only relevant evidence", () => webFixture(({ root, write, config }) => {
  write("src/view.css", "a { color: red; }\n");
  const c = config({ modern_web: { enabled: true, exclude: ["vendor"] } });
  const project = createAnalysisContext(c).project();
  const guard = inputSnapshot(c, project);
  const hash = () => taskInputHash(c, "quality.modern_web", "ignored-source-hash");
  let previous = hash();
  write("vendor/ignored.css", "a {}\n");
  assert.equal(hash(), previous);
  assert.equal(guard(), null);
  write("src/view.css", "a { color: blue; }\n");
  assert.notEqual(hash(), previous);
  assert.match(guard() ?? "", /changed/);
  assert.equal(createAnalysisContext(c).project().cache.status, "hit");
  previous = hash();
  write("src/new.html", "<main />\n");
  assert.notEqual(hash(), previous);
  previous = hash();
  fs.unlinkSync(path.join(root, "src/new.html"));
  assert.notEqual(hash(), previous);
  previous = hash();
  write(".browserslistrc", "chrome 120\n");
  assert.notEqual(hash(), previous);
}));

test("disabled discovery and out-of-scope roots do not read arbitrary web assets", () => webFixture(({ root, config }) => {
  assert.deepEqual(discoverWebInputs(config()).files, []);
  const c = config({ modern_web: { enabled: true, roots: ["../outside", "missing"] } });
  const result = discoverWebInputs(c);
  assert.ok(result.skipped.some((item) => item.reason === "outside_project"));
  assert.ok(result.skipped.some((item) => item.reason === "missing_or_unreadable"));
  fs.symlinkSync(path.join(root, "src"), path.join(root, "linked"), "junction");
  const linked = discoverWebInputs(config({ modern_web: { enabled: true, roots: ["linked/index.ts"] } }));
  assert.ok(linked.skipped.some((item) => item.reason === "symlink"));
}));
