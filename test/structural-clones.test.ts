import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAnalysisContext } from "../src/analysis-context.js";
import { measureClones } from "../src/measures/clones.js";
import { structuralCloneGroups } from "../src/structural-clones.js";
import { typescriptFixture } from "./project-fixture.js";

test("structural clones preserve local binding relationships, properties, literals, and shadowing", () => typescriptFixture((root, config) => {
  config.cache.enabled = false;
  const pairs: Array<[string, string, boolean]> = [
    ["const total = a + b; if (total > 0) return total; return 0;", "const sum = x + y; if (sum > 0) return sum; return 0;", true],
    ["const total = a + b; if (total > 0) return total; return 0;", "const sum = x + x; if (sum > 0) return sum; return 0;", false],
    ["const total = a - b; if (total > 0) return total; return 0;", "const sum = y - x; if (sum > 0) return sum; return 0;", false],
    ["const total = a + b; if (total > 0) return total; return 0;", "const sum = x - y; if (sum > 0) return sum; return 0;", false],
    ["const total = a.left + b.right; if (total > 0) return total; return 0;", "const sum = x.left + y.wrong; if (sum > 0) return sum; return 0;", false],
    ["const total = a + b; if (total > 0) return total; return 0;", "const sum = x + y; if (sum > 1) return sum; return 0;", false],
    ["let value = a; { let value = b; value++; } return value + 1;", "let result = x; { let inner = y; inner++; } return result + 1;", true],
    ["let value = a; { let value = b; value++; } return value + 1;", "let result = x; { let inner = y; result++; } return result + 1;", false],
    ["let value = a; value++; if (value > 0) return value; return b;", "let result = x; result--; if (result > 0) return result; return y;", false],
  ];
  for (const [left, right, expected] of pairs) {
    fs.writeFileSync(path.join(root, "src/a.ts"), `export function first(a, b) { ${left} }\n`);
    fs.writeFileSync(path.join(root, "src/b.ts"), `export function second(x, y) { ${right} }\n`);
    const groups = structuralCloneGroups(createAnalysisContext(config).project());
    assert.equal(groups.some((group) => new Set(group.instances.map((instance) => instance.file)).size === 2), expected, right);
  }
}));

test("boilerplate observations remain visible without implementation duplication pressure", () => typescriptFixture((root, config) => {
  const imports = "import fs from 'node:fs';\nimport path from 'node:path';\n";
  for (const file of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(root, "src", file), imports);
  for (const [file, input] of [["one.ts", "row"], ["two.ts", "item"]] as const) fs.writeFileSync(path.join(root, "src", file),
    `export const project = (${input}) => ({id:${input}.id, name:${input}.name, line:${input}.line, file:${input}.file});\n`);
  const context = createAnalysisContext(config);
  context.jscpd = () => ({ available: true, ran: true, reason: null, statistics: {}, duplicates: [{ lines: 2,
    firstFile: { name: path.join(root, "src/a.ts"), start: 1, end: 2 }, secondFile: { name: path.join(root, "src/b.ts"), start: 1, end: 2 } }] });
  const artifact = measureClones(config, "boilerplate", context);
  assert.equal(artifact.summary.boilerplate_clone_groups, 2);
  assert.equal(artifact.summary.implementation_clone_groups, 0);
  assert.equal(artifact.summary.clone_pressure_records, 0);
  assert.ok(artifact.groups.every((group) => group.disposition === "info" && group.pressure_included === false && (group.producer_score ?? 0) > 0));
  assert.equal(artifact.engine_observations.length, 2);
}));
