// Optimistic UI state that has to survive a request failing.
//
// A browsing-level conflict resolver used to live here too, for deciding whose
// value won when the panel could also set the level. Civitai's own control is
// now the only place it is set, so there is nothing left to arbitrate.
export function beginOptimisticReaction(item, reaction, statKey) {
  if (!item.stats || typeof item.stats !== "object") item.stats = {};
  if (!(item._sessionReactions instanceof Set)) item._sessionReactions = new Set();

  const wasActive = item._sessionReactions.has(reaction);
  const previousCount = Math.max(0, Number(item.stats[statKey]) || 0);
  if (wasActive) item._sessionReactions.delete(reaction);
  else item._sessionReactions.add(reaction);
  item.stats[statKey] = Math.max(0, previousCount + (wasActive ? -1 : 1));

  let settled = false;
  return {
    removing: wasActive,
    rollback() {
      if (settled) return;
      settled = true;
      if (wasActive) item._sessionReactions.add(reaction);
      else item._sessionReactions.delete(reaction);
      item.stats[statKey] = previousCount;
    },
    commit() { settled = true; },
  };
}
