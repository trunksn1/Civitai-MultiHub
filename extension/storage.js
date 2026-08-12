// Config schema, chrome.storage wrapper, export/import.
// Supports multiple hubs (feeds); migrates the old single-feed format.

import {
  ALLOWED_BROWSING_LEVELS,
  ALLOWED_CIVITAI_HOSTS,
  DEFAULT_CIVITAI_HOST,
} from "./distribution.js";

const defaultBrowsingLevelsByDomain = Object.fromEntries([
  ...[...ALLOWED_CIVITAI_HOSTS].map((host) => [
    host,
    host === "civitai.red"
      ? [...ALLOWED_BROWSING_LEVELS]
      : ALLOWED_BROWSING_LEVELS.filter((level) => level <= 2),
  ]),
  ["standalone", ALLOWED_BROWSING_LEVELS.filter((level) => level <= 2)],
]);

const DEFAULT_SETTINGS = {
  linkDomain: DEFAULT_CIVITAI_HOST,
  apiKey: "",
  rememberApiKey: false, // preference only; the key remains a separate storage entry
  maxVersionsPerModel: 10, // safety cap when following "all versions" of a model
  hiddenCreators: [], // global creator blacklist shared by every hub
  // A cache of the browsing level last read from the signed-in Civitai session
  // on each host, which is the only thing that sets it. These are the fallbacks
  // used until that read succeeds: civitai.com never serves above PG-13 whatever
  // is asked for; civitai.red is the mature host, so nothing is withheld there.
  browsingLevelsByDomain: defaultBrowsingLevelsByDomain,
};
const API_KEY_SESSION = "apiKey";
const API_KEY_LOCAL = "apiKey";

const DEFAULT_FEED = {
  name: "My hub",
  globalSort: "newest", // newest | oldest | reactions | comments
  period: "AllTime",
  mediaType: "all", // all | image | video
  generationFilter: "all", // all | no-metadata | prompt | resources | complete-metadata
  hideViewed: false,
  aspectRatio: "all", // all | portrait | landscape | square
  density: "comfortable", // comfortable | compact
  autoplayVideos: true,
  groupPosts: false,
  viewedIds: [],
  lastVisitedAt: null,
  sources: [],
};

const LIMITS = {
  feeds: 50,
  sources: 200,
  versions: 100,
  name: 80,
  username: 80,
  label: 160,
  alias: 80,
  hiddenCreators: 200,
  viewedIds: 3000,
};
export const MAX_HUBS = LIMITS.feeds;
const SORTS = new Set(["newest", "oldest", "reactions", "comments"]);
const PERIODS = new Set(["AllTime", "Year", "Month", "Week", "Day"]);
const DOMAINS = ALLOWED_CIVITAI_HOSTS;
const BROWSING_LEVELS = new Set(ALLOWED_BROWSING_LEVELS);
const MEDIA_TYPES = new Set(["all", "image", "video"]);
const GENERATION_FILTERS = new Set([
  "all", "no-metadata", "prompt", "resources", "complete-metadata",
]);
const ASPECT_RATIOS = new Set(["all", "portrait", "landscape", "square"]);
const DENSITIES = new Set(["comfortable", "compact"]);

function boundedText(value, max, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function usableId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : newId();
}

export function normalizeSource(source, { strict = false } = {}) {
  const fail = (message) => {
    if (strict) throw new Error(message);
    return null;
  };
  if (!source || typeof source !== "object") return fail("Source must be an object");
  if (source.type === "user") {
    const username = boundedText(source.username, LIMITS.username);
    if (!username || !/^[\w.-]+$/u.test(username)) return fail("Invalid user source");
    const normalized = { id: usableId(source.id), type: "user", username };
    normalized.enabled = source.enabled !== false;
    const alias = boundedText(source.alias, LIMITS.alias);
    if (alias) normalized.alias = alias;
    return normalized;
  }
  if (source.type === "model") {
    const modelId = positiveInteger(source.modelId);
    if (!modelId) return fail("Invalid model source");
    const normalized = { id: usableId(source.id), type: "model", modelId };
    normalized.enabled = source.enabled !== false;
    const label = boundedText(source.label, LIMITS.label);
    if (label) normalized.label = label;
    const alias = boundedText(source.alias, LIMITS.alias);
    if (alias) normalized.alias = alias;
    if (source.versionIds !== undefined) {
      if (!Array.isArray(source.versionIds)) return fail("Model versionIds must be an array");
      const versionIds = [...new Set(source.versionIds.map(positiveInteger).filter(Boolean))];
      if (strict && versionIds.length !== source.versionIds.length) {
        return fail("Model versionIds must contain unique positive integers");
      }
      if (versionIds.length > LIMITS.versions) return fail("Too many model versions");
      if (versionIds.length > 0) normalized.versionIds = versionIds;
    }
    return normalized;
  }
  if (source.type === "collection") {
    const collectionId = positiveInteger(source.collectionId);
    if (!collectionId) return fail("Invalid collection source");
    const normalized = { id: usableId(source.id), type: "collection", collectionId };
    normalized.enabled = source.enabled !== false;
    const label = boundedText(source.label, LIMITS.label);
    if (label) normalized.label = label;
    const alias = boundedText(source.alias, LIMITS.alias);
    if (alias) normalized.alias = alias;
    return normalized;
  }
  return fail("Unknown source type");
}

export function normalizeFeed(value, { strict = false } = {}) {
  if (!value || typeof value !== "object") {
    if (strict) throw new Error("Feed must be an object");
    value = {};
  }
  if (strict && !Array.isArray(value.sources)) throw new Error("Feed sources must be an array");
  const inputSources = Array.isArray(value.sources) ? value.sources : [];
  if (inputSources.length > LIMITS.sources) throw new Error(`A hub can contain at most ${LIMITS.sources} sources`);
  if (strict && (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > LIMITS.name)) {
    throw new Error(`Hub name must be between 1 and ${LIMITS.name} characters`);
  }
  if (strict && !SORTS.has(value.globalSort)) throw new Error("Invalid hub sort");
  if (strict && !PERIODS.has(value.period)) throw new Error("Invalid hub period");
  if (strict && value.generationFilter !== undefined
      && !GENERATION_FILTERS.has(value.generationFilter)) {
    throw new Error("Invalid generation details filter");
  }
  const feed = {
    id: usableId(value.id),
    name: boundedText(value.name, LIMITS.name, DEFAULT_FEED.name),
    globalSort: SORTS.has(value.globalSort) ? value.globalSort : DEFAULT_FEED.globalSort,
    period: PERIODS.has(value.period) ? value.period : DEFAULT_FEED.period,
    mediaType: MEDIA_TYPES.has(value.mediaType) ? value.mediaType : DEFAULT_FEED.mediaType,
    generationFilter: GENERATION_FILTERS.has(value.generationFilter)
      ? value.generationFilter : DEFAULT_FEED.generationFilter,
    hideViewed: value.hideViewed === true,
    aspectRatio: ASPECT_RATIOS.has(value.aspectRatio) ? value.aspectRatio : DEFAULT_FEED.aspectRatio,
    density: DENSITIES.has(value.density) ? value.density : DEFAULT_FEED.density,
    autoplayVideos: value.autoplayVideos !== false,
    groupPosts: value.groupPosts === true,
    viewedIds: Array.isArray(value.viewedIds)
      ? [...new Set(value.viewedIds.map(positiveInteger).filter(Boolean))].slice(-LIMITS.viewedIds)
      : [],
    lastVisitedAt: typeof value.lastVisitedAt === "string" && Number.isFinite(Date.parse(value.lastVisitedAt))
      ? value.lastVisitedAt : null,
    sources: [],
  };
  for (const source of inputSources) {
    const normalized = normalizeSource(source, { strict });
    if (!normalized) continue;
    mergeSourceIntoFeed(feed, normalized);
  }
  return feed;
}

export function normalizeConfig(value = {}) {
  const storedSettings = value.settings && typeof value.settings === "object" ? value.settings : {};
  const inputFeeds = Array.isArray(value.feeds) ? value.feeds.slice(0, LIMITS.feeds) : [];
  const legacyHiddenCreators = inputFeeds.flatMap((feed) =>
    Array.isArray(feed?.hiddenCreators) ? feed.hiddenCreators : []
  );
  const settings = {
    linkDomain: DOMAINS.has(storedSettings.linkDomain)
      ? storedSettings.linkDomain : DEFAULT_SETTINGS.linkDomain,
    // Runtime field. loadConfig hydrates it from the dedicated Chrome-profile key entry.
    apiKey: "",
    rememberApiKey: storedSettings.rememberApiKey === true,
    // Older configs used "" for the API default, which is effectively None/SFW-only.
    maxVersionsPerModel: Math.min(50, Math.max(1,
      positiveInteger(storedSettings.maxVersionsPerModel) || DEFAULT_SETTINGS.maxVersionsPerModel)),
    hiddenCreators: [...new Set([
      ...(Array.isArray(storedSettings.hiddenCreators) ? storedSettings.hiddenCreators : []),
      ...legacyHiddenCreators,
    ].map((name) => boundedText(name, LIMITS.username)).filter(Boolean)
      .map((name) => name.toLocaleLowerCase()))].slice(0, LIMITS.hiddenCreators),
    browsingLevelsByDomain: Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.browsingLevelsByDomain).map(([scope, fallback]) => [
        scope,
        [...new Set(
          (Array.isArray(storedSettings.browsingLevelsByDomain?.[scope])
            ? storedSettings.browsingLevelsByDomain[scope] : fallback)
            .map(Number).filter((level) => BROWSING_LEVELS.has(level))
        )].sort((a, b) => a - b),
      ])
    ),
  };
  for (const [scope, fallback] of Object.entries(DEFAULT_SETTINGS.browsingLevelsByDomain)) {
    if (settings.browsingLevelsByDomain[scope].length === 0) {
      settings.browsingLevelsByDomain[scope] = [...fallback];
    }
  }
  const feeds = inputFeeds.map((feed) => normalizeFeed(feed));
  if (feeds.length === 0) feeds.push(makeFeed(DEFAULT_FEED.name));
  const activeFeedId = feeds.some((feed) => feed.id === value.activeFeedId)
    ? value.activeFeedId : feeds[0].id;
  return { settings, feeds, activeFeedId };
}

export function newId() {
  return crypto.randomUUID();
}

export function normalizeNewHubName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > LIMITS.name) {
    throw new Error(`Hub name must be between 1 and ${LIMITS.name} characters`);
  }
  return value.trim();
}

export function makeFeed(name) {
  return { ...DEFAULT_FEED, id: newId(), name: normalizeNewHubName(name), sources: [] };
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get(["settings", "feeds", "activeFeedId", "feed", API_KEY_LOCAL]);
  const session = await chrome.storage.session.get(API_KEY_SESSION);
  const legacyApiKey = boundedText(stored.settings?.apiKey, 500);
  const localApiKey = boundedText(stored[API_KEY_LOCAL] || legacyApiKey, 500);
  const apiKey = boundedText(localApiKey || session[API_KEY_SESSION], 500);
  if (legacyApiKey && !stored[API_KEY_LOCAL]) {
    await chrome.storage.local.set({ [API_KEY_LOCAL]: legacyApiKey });
  }
  if (legacyApiKey) {
    // Preserve the legacy persistence choice while moving the secret out of settings.
    if (!session[API_KEY_SESSION]) await chrome.storage.session.set({ [API_KEY_SESSION]: legacyApiKey });
    const settings = { ...(stored.settings || {}) };
    delete settings.apiKey;
    settings.rememberApiKey = true;
    await chrome.storage.local.set({ settings });
    stored.settings = settings;
  }
  let feeds = Array.isArray(stored.feeds) ? stored.feeds : [];
  if (feeds.length === 0) {
    // Migrate the pre-hubs single feed, or start with one empty hub.
    feeds = [{ ...DEFAULT_FEED, ...(stored.feed || {}), id: newId() }];
  }
  const config = normalizeConfig({ settings: stored.settings, feeds, activeFeedId: stored.activeFeedId });
  config.settings.apiKey = apiKey;
  config.settings.rememberApiKey = Boolean(localApiKey || config.settings.rememberApiKey);
  return config;
}

export function persistentConfig(config) {
  const settings = { ...(config.settings || {}) };
  delete settings.apiKey;
  return { settings, feeds: config.feeds, activeFeedId: config.activeFeedId };
}

export async function saveConfig(config) {
  const apiKey = boundedText(config.settings?.apiKey, 500);
  const rememberApiKey = config.settings?.rememberApiKey === true;
  await chrome.storage.local.set(persistentConfig(config));
  if (apiKey) {
    await chrome.storage.session.set({ [API_KEY_SESSION]: apiKey });
    if (rememberApiKey) await chrome.storage.local.set({ [API_KEY_LOCAL]: apiKey });
    else await chrome.storage.local.remove(API_KEY_LOCAL);
  } else {
    await chrome.storage.local.remove(API_KEY_LOCAL);
    await chrome.storage.session.remove(API_KEY_SESSION);
  }
  await chrome.storage.local.remove("feed"); // old single-feed key
}

export function activeFeed(config) {
  return config.feeds.find((f) => f.id === config.activeFeedId) || config.feeds[0];
}

// Auto-detect what the user pasted: a civitai model/user/collection URL, a
// numeric model id, @username, or a plain username. A model URL carrying
// ?modelVersionId=N adds only that version. Returns a source draft or null.
export function parseSourceInput(raw) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (!input) return null;
  let m = input.match(/civitai\.(?:com|red)\/models\/(\d+)/i);
  if (m) {
    const draft = { type: "model", modelId: Number(m[1]) };
    const v = input.match(/[?&]modelVersionId=(\d+)/i);
    if (v) draft.versionIds = [Number(v[1])];
    return draft;
  }
  m = input.match(/civitai\.(?:com|red)\/collections\/(\d+)/i);
  if (m) return { type: "collection", collectionId: Number(m[1]) };
  m = input.match(/civitai\.(?:com|red)\/user\/([^/?#]+)/i);
  if (m) {
    try {
      return normalizeSource({ type: "user", username: decodeURIComponent(m[1]) });
    } catch {
      return null;
    }
  }
  if (input.startsWith("@")) {
    const username = input.slice(1);
    return /^[\w.-]+$/.test(username) ? { type: "user", username } : null;
  }
  if (/^\d+$/.test(input)) return { type: "model", modelId: Number(input) };
  if (/^[\w.-]+$/.test(input)) return { type: "user", username: input };
  return null;
}

// Add a source draft to a feed, merging with an existing model source when it
// makes sense: adding a version to a partially-followed model appends it;
// adding "all versions" upgrades a partial source; anything already covered
// is a duplicate. Returns { status: "added" | "merged" | "duplicate" }.
export function mergeSourceIntoFeed(feed, draft) {
  const normalized = normalizeSource(draft, { strict: true });
  draft = { ...draft, ...normalized };
  if (draft.type === "user") {
    if (feed.sources.some((s) =>
      s.type === "user" && s.username.toLocaleLowerCase() === draft.username.toLocaleLowerCase())) {
      return { status: "duplicate" };
    }
    const source = { ...draft, id: newId() };
    feed.sources.push(source);
    return { status: "added", source };
  }
  if (draft.type === "collection") {
    const existing = feed.sources.find(
      (source) => source.type === "collection" && source.collectionId === draft.collectionId
    );
    if (existing) return { status: "duplicate", source: existing };
    const source = { ...draft, id: newId() };
    feed.sources.push(source);
    return { status: "added", source };
  }
  const existing = feed.sources.find((s) => s.type === "model" && s.modelId === draft.modelId);
  if (!existing) {
    const source = { ...draft, id: newId() };
    feed.sources.push(source);
    return { status: "added", source };
  }
  if (!existing.versionIds?.length) return { status: "duplicate" }; // already follows all versions
  if (!draft.versionIds?.length) {
    delete existing.versionIds; // upgrade to all versions
    if (draft.label) existing.label = draft.label;
    return { status: "merged", source: existing };
  }
  const fresh = draft.versionIds.filter((v) => !existing.versionIds.includes(v));
  if (fresh.length === 0) return { status: "duplicate" };
  existing.versionIds.push(...fresh);
  return { status: "merged", source: existing };
}

export function exportFeed(feed) {
  const { id, viewedIds, lastVisitedAt, ...rest } = feed;
  rest.sources = feed.sources.map(({ id: sourceId, ...source }) => source);
  const blob = new Blob([JSON.stringify({ format: "CMH1", feed: rest }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${feed.name.replace(/[^\w-]+/g, "_") || "feed"}.multihub.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importFeed(json) {
  const data = JSON.parse(json);
  if (data.format !== "CMH1" || !data.feed || !Array.isArray(data.feed.sources)) {
    throw new Error("Not a valid MultiHub feed file");
  }
  const imported = {
    ...data.feed,
    id: newId(),
    sources: data.feed.sources.map(({ id, ...source }) => source),
  };
  const feed = normalizeFeed(imported, { strict: true });
  return feed;
}
