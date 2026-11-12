import assert from "node:assert/strict";
import test from "node:test";
import { findCycles } from "../src/graph.js";

test("cycle witnesses use actual directed edges and are stable under input permutations", () => {
  const cases: Array<{ pairs: string[][]; expected: string[][] }> = [
    { pairs: [], expected: [] },
    { pairs: [["a", "b"], ["b", "c"]], expected: [] },
    { pairs: [["a", "c"], ["c", "b"], ["b", "a"]], expected: [["a", "c", "b", "a"]] },
    { pairs: [["a", "b"], ["b", "a"], ["b", "c"], ["c", "b"], ["a", "a"], ["d", "d"], ["d", "e"]], expected: [["a", "b", "a"], ["d", "d"]] },
  ];
  for (const { pairs, expected } of cases) {
    const edges = pairs.map(([from = "", to = ""]) => ({ from, to }));
    for (const input of [edges, [...edges].reverse(), [...edges.slice(1), ...edges.slice(0, 1)], [...edges, ...edges]]) {
      const cycles = findCycles(input);
      assert.deepEqual(cycles, expected);
      for (const cycle of cycles) {
        assert.equal(cycle[0], cycle.at(-1));
        assert.equal(new Set(cycle.slice(0, -1)).size, cycle.length - 1);
        assert.ok(cycle.slice(1).every((to, index) => edges.some((edge) => edge.from === cycle[index] && edge.to === to)));
      }
    }
  }
});
