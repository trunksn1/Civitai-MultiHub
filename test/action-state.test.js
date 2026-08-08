import test from "node:test";
import assert from "node:assert/strict";

import { beginOptimisticReaction } from "../extension/action-state.js";

test("optimistic reaction updates immediately and commits", () => {
  const item = { stats: { likeCount: 8 } };
  const action = beginOptimisticReaction(item, "Like", "likeCount");
  assert.equal(item.stats.likeCount, 9);
  assert.equal(item._sessionReactions.has("Like"), true);
  assert.equal(action.removing, false);
  action.commit();
  action.rollback();
  assert.equal(item.stats.likeCount, 9);
});

test("failed optimistic reaction restores the prior count and selection", () => {
  const item = { stats: { heartCount: 3 }, _sessionReactions: new Set(["Heart"]) };
  const action = beginOptimisticReaction(item, "Heart", "heartCount");
  assert.equal(item.stats.heartCount, 2);
  assert.equal(item._sessionReactions.has("Heart"), false);
  assert.equal(action.removing, true);
  action.rollback();
  assert.equal(item.stats.heartCount, 3);
  assert.equal(item._sessionReactions.has("Heart"), true);
});
