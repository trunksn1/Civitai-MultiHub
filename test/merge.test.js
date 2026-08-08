import test from "node:test";
import assert from "node:assert/strict";

import { dedupe, hasFrontier, mergeAndSort } from "../extension/merge.js";

test("dedupe retains every matching source", () => {
  const items = dedupe([
    { id: 1, _source: "A" },
    { id: 1, _source: "B" },
    { id: 1, _source: "A" },
  ]);
  assert.deepEqual(items[0]._sources, ["A", "B"]);
});

test("mergeAndSort handles date and engagement sorts", () => {
  const older = { id: 1, createdAt: "2024-01-01", stats: { likeCount: 20, commentCount: 1 } };
  const newer = { id: 2, createdAt: "2025-01-01", stats: { likeCount: 2, commentCount: 5 } };
  assert.deepEqual(mergeAndSort([older, newer], "newest").map((x) => x.id), [2, 1]);
  assert.deepEqual(mergeAndSort([older, newer], "reactions").map((x) => x.id), [1, 2]);
  assert.deepEqual(mergeAndSort([older, newer], "comments").map((x) => x.id), [2, 1]);
  assert.equal(hasFrontier("newest"), true);
  assert.equal(hasFrontier("reactions"), false);
});
