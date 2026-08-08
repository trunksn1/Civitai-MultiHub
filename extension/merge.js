// Dedupe images from multiple sources and sort the merged pool.

export function dedupe(items) {
  const byId = new Map();
  for (const item of items) {
    const existing = byId.get(item.id);
    if (existing) {
      if (item._source && !existing._sources.includes(item._source)) {
        existing._sources.push(item._source);
      }
    } else {
      byId.set(item.id, { ...item, _sources: item._source ? [item._source] : [] });
    }
  }
  return [...byId.values()];
}

function reactions(item) {
  const s = item.stats || {};
  return (s.likeCount || 0) + (s.heartCount || 0) + (s.laughCount || 0) + (s.cryCount || 0);
}

const comparators = {
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  reactions: (a, b) => reactions(b) - reactions(a),
  comments: (a, b) => (b.stats?.commentCount || 0) - (a.stats?.commentCount || 0),
};

export function getComparator(globalSort) {
  return comparators[globalSort] || comparators.newest;
}

// Whether a stream's last fetched item is a valid bound for incremental
// merging. Only date sorts qualify: the API pages them strictly by createdAt.
// Civitai's "Most Reactions"/"Most Comments" use an internal weighting that
// does not match the raw counts (verified: adjacent API results can have
// counts out of order), so those merges are best-effort over fetched pages.
export function hasFrontier(globalSort) {
  return globalSort === "newest" || globalSort === "oldest";
}

export function mergeAndSort(items, globalSort) {
  return dedupe(items).sort(getComparator(globalSort));
}
