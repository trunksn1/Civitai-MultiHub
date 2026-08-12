function meaningful(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function generationMeta(item) {
  if (item?._generationMeta && typeof item._generationMeta === "object") return item._generationMeta;
  return item?.meta && typeof item.meta === "object" ? item.meta : {};
}

export function generationContentSignals(item) {
  const meta = generationMeta(item);
  const prompt = typeof meta.prompt === "string" ? meta.prompt.trim() : "";
  const resourceArrays = [
    item?._generationResources,
    item?.modelVersionIds,
    item?.modelVersionIdsManual,
    meta.resources,
    meta.additionalResources,
    meta.civitaiResources,
  ];
  const hasResources = resourceArrays.some((resources) =>
    Array.isArray(resources) && resources.length > 0
  );
  const hasPrompt = item?.hasPositivePrompt === true || Boolean(prompt);
  const hasMetadata = item?.hasMeta === true || Object.values(meta).some(meaningful) || hasResources;
  return { hasMetadata, hasPrompt, hasResources };
}

export function matchesGenerationFilters(item, feed) {
  const filter = feed?.generationFilter || "all";
  if (filter === "all") return true;
  const { hasMetadata, hasPrompt, hasResources } = generationContentSignals(item);
  if (filter === "no-metadata") return hasMetadata;
  if (filter === "prompt") return hasPrompt;
  if (filter === "resources") return hasResources;
  if (filter === "complete-metadata") return hasPrompt && hasResources;
  return true;
}

export function isUnviewedNewImage(item, previousVisitAt, viewedIds = new Set()) {
  if (!previousVisitAt || !item?.id || viewedIds.has(Number(item.id))) return false;
  const createdAt = Date.parse(item.createdAt);
  const threshold = Date.parse(previousVisitAt);
  return Number.isFinite(createdAt) && Number.isFinite(threshold) && createdAt > threshold;
}
