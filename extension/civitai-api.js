// All Civitai API access lives here. Base docs: https://developer.civitai.com
//
// Civitai splits its catalogue across two hosts: civitai.com serves the SFW tier
// and clamps every response to PG/PG-13 no matter which browsing level is asked
// for, while civitai.red serves R, X and XXX as well. The host is therefore part
// of the request, not a cosmetic link preference — a feed pinned to civitai.com
// can never show mature media. `settings.linkDomain` carries the host the user is
// actually browsing (the embedding page when embedded, their chosen domain when
// standalone) and every request below is built against it.
import {
  ALLOWED_BROWSING_LEVELS,
  ALLOWED_CIVITAI_HOSTS,
  DEFAULT_CIVITAI_HOST,
} from "./distribution.js";

const API_HOSTS = ALLOWED_CIVITAI_HOSTS;
const IMAGE_CDN_BASE = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA";
export const PAGE_LIMIT = 30;

export function apiHost(settings) {
  return API_HOSTS.has(settings?.linkDomain) ? settings.linkDomain : DEFAULT_CIVITAI_HOST;
}

function apiBase(settings) {
  return `https://${apiHost(settings)}/api/v1`;
}

function trpcBase(settings) {
  return `https://${apiHost(settings)}/api/trpc`;
}

// Civitai echoes the requested host back in metadata.nextPage, but a cross-host
// cursor would silently drop the feed back to the SFW tier mid-scroll.
function pinHost(url, settings) {
  try {
    const parsed = new URL(url);
    if (API_HOSTS.has(parsed.hostname)) parsed.hostname = apiHost(settings);
    return parsed.toString();
  } catch {
    return url;
  }
}

export const CIVITAI_CAPABILITIES = Object.freeze({
  reactions: "reactions",
  commentPreview: "comment-preview",
  comments: "comments",
  collectionSources: "collection-sources",
  collectionList: "collection-list",
  collectionWrite: "collection-write",
  generationDetails: "generation-details",
});

export class CivitaiApiError extends Error {
  constructor(message, { code = "unknown", status = null, capability = null, retryable = false } = {}) {
    super(message);
    this.name = "CivitaiApiError";
    this.code = code;
    this.status = status;
    this.capability = capability;
    this.retryable = retryable;
  }
}

const capabilityStates = new Map();

export function getCivitaiCapabilityState(capability) {
  return capabilityStates.get(capability) || { available: true, reason: null };
}

export function resetCivitaiCapabilities() {
  capabilityStates.clear();
}

function errorCodeForStatus(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404 || status === 410) return "unsupported";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "request";
}

function httpError(status, capability) {
  const code = errorCodeForStatus(status);
  return new CivitaiApiError(`Civitai API ${status}`, {
    code, status, capability, retryable: code === "rate-limit" || code === "server",
  });
}

function normalizeApiError(error, capability = null) {
  if (error?.name === "AbortError") return error;
  if (error instanceof CivitaiApiError) {
    if (!error.capability && capability) error.capability = capability;
    return error;
  }
  return new CivitaiApiError("Civitai could not be reached", {
    code: "network", capability, retryable: true,
  });
}

function invalidResponse(capability) {
  return new CivitaiApiError("Civitai returned an unexpected response", {
    code: "invalid-response", capability,
  });
}

function noteCapabilityFailure(capability, error) {
  if (!capability || !["unsupported", "invalid-response"].includes(error?.code)) return;
  capabilityStates.set(capability, { available: false, reason: error.code });
}

function ensureCapability(capability) {
  const state = getCivitaiCapabilityState(capability);
  if (state.available) return;
  throw new CivitaiApiError("This Civitai capability is unavailable", {
    code: "capability-disabled", capability,
  });
}

async function withCapability(capability, operation) {
  ensureCapability(capability);
  try {
    return await operation();
  } catch (error) {
    const normalized = normalizeApiError(error, capability);
    noteCapabilityFailure(capability, normalized);
    throw normalized;
  }
}

function requireApiKey(settings, capability, purpose = "this feature") {
  if (settings?.apiKey) return;
  throw new CivitaiApiError(`An API key is required for ${purpose}`, {
    code: "missing-key", capability,
  });
}

// Civitai is migrating tRPC responses from SuperJSON to devalue one server pool
// at a time. The browser client accepts both. Keep this focused decoder in sync
// with the JSON-compatible values returned by collection/image reads.
function parseDevalueData(serialized) {
  const values = JSON.parse(serialized);
  if (!Array.isArray(values) || values.length === 0 || values.length > 200000) {
    throw new Error("Invalid devalue payload");
  }
  const hydrated = new Array(values.length);

  function hydrate(index) {
    if (index === -1) return undefined;
    if (index === -3) return NaN;
    if (index === -4) return Infinity;
    if (index === -5) return -Infinity;
    if (index === -6) return -0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
      throw new Error("Invalid devalue reference");
    }
    if (Object.prototype.hasOwnProperty.call(hydrated, index)) return hydrated[index];

    const value = values[index];
    if (!value || typeof value !== "object") {
      hydrated[index] = value;
      return value;
    }
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        const type = value[0];
        if (type === "Date" || type === "BigInt" || type === "URL" ||
            type.startsWith("Temporal.")) {
          hydrated[index] = String(value[1]);
        } else if (type === "Set") {
          const set = new Set();
          hydrated[index] = set;
          for (let i = 1; i < value.length; i += 1) set.add(hydrate(value[i]));
        } else if (type === "Map") {
          const map = new Map();
          hydrated[index] = map;
          for (let i = 1; i < value.length; i += 2) {
            map.set(hydrate(value[i]), hydrate(value[i + 1]));
          }
        } else if (type === "Object") {
          hydrated[index] = Object(hydrate(value[1]));
        } else if (type === "null") {
          const object = Object.create(null);
          hydrated[index] = object;
          for (let i = 1; i < value.length; i += 2) {
            if (value[i] === "__proto__") throw new Error("Invalid devalue key");
            object[value[i]] = hydrate(value[i + 1]);
          }
        } else {
          throw new Error(`Unsupported devalue type ${type}`);
        }
        return hydrated[index];
      }
      if (value[0] === -7) throw new Error("Sparse devalue arrays are unsupported");
      const array = new Array(value.length);
      hydrated[index] = array;
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] !== -2) array[i] = hydrate(value[i]);
      }
      return array;
    }

    const object = {};
    hydrated[index] = object;
    for (const key of Object.keys(value)) {
      if (key === "__proto__") throw new Error("Invalid devalue key");
      object[key] = hydrate(value[key]);
    }
    return object;
  }

  return hydrate(0);
}

function unwrapTrpcData(payload, capability) {
  if (payload?.error) {
    const status = Number(payload.error?.json?.data?.httpStatus) || 400;
    throw httpError(status, capability);
  }
  const wrapped = payload?.result?.data;
  let value;
  try {
    value = typeof wrapped === "string"
      ? parseDevalueData(wrapped)
      : Array.isArray(wrapped)
        ? parseDevalueData(JSON.stringify(wrapped))
        : wrapped && Object.prototype.hasOwnProperty.call(wrapped, "json")
          ? wrapped.json : wrapped;
  } catch {
    throw invalidResponse(capability);
  }
  if (value === undefined) throw invalidResponse(capability);
  return value;
}

export function explainCivitaiError(error, {
  action = "The request", scope = "the required access", mutation = false,
} = {}) {
  const normalized = normalizeApiError(error, error?.capability);
  if (normalized?.name === "AbortError") return "";
  if (normalized.code === "missing-key") return `${action} requires a Civitai API key.`;
  if (normalized.code === "session-unavailable") {
    return `${action} needs a signed-in Civitai tab. Open or refresh ${
      [...API_HOSTS].join(" or ")
    } and try again.`;
  }
  if (normalized.code === "session-authentication") {
    return `${action} needs you to sign in to Civitai in the open browser tab.`;
  }
  if (normalized.code === "session-permission") {
    return `${action} was denied by the signed-in Civitai account.`;
  }
  if (normalized.code === "session-network") {
    return `${action} failed because the signed-in Civitai tab could not reach Civitai.`;
  }
  if (normalized.code === "authentication") {
    return `${action} was rejected because the Civitai API key is invalid or expired.`;
  }
  if (normalized.code === "permission") {
    return `${action} was denied. The Civitai API key may not include ${scope}.`;
  }
  if (["unsupported", "invalid-response", "capability-disabled"].includes(normalized.code)) {
    return `${action} is unavailable because Civitai's internal API changed. Open the item on Civitai instead.`;
  }
  if (mutation && ["network", "server", "rate-limit", "request"].includes(normalized.code)) {
    return `${action} was not confirmed by Civitai. Check the item on Civitai before trying again.`;
  }
  if (normalized.code === "rate-limit") return `${action} was rate-limited by Civitai. Please wait and try again.`;
  if (normalized.code === "server") return `${action} failed because Civitai is temporarily unavailable.`;
  if (normalized.code === "network") return `${action} failed because Civitai could not be reached.`;
  return `${action} could not be completed.`;
}

// In-memory cache of model id -> { name, type, versions } for this page session.
const modelCache = new Map();
const collectionCache = new Map();
const versionCache = new Map();
const creatorCache = new Map();
const generationDataCache = new Map();
const imageCommentsCache = new Map();

export function clearModelCache() {
  modelCache.clear();
  collectionCache.clear();
  versionCache.clear();
  creatorCache.clear();
  generationDataCache.clear();
  imageCommentsCache.clear();
}

function authHeaders(settings) {
  return settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function sessionUnavailable(message = "A signed-in Civitai tab is unavailable") {
  return new CivitaiApiError(message, {
    code: "session-unavailable",
  });
}

function sendRuntimeMessage(message, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) return Promise.reject(sessionUnavailable());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      runtime.sendMessage(message, (response) => {
        const lastError = runtime.lastError?.message;
        finish(() => {
          if (lastError) reject(sessionUnavailable(lastError));
          else if (!response) reject(sessionUnavailable());
          else resolve(response);
        });
      });
    } catch (error) {
      finish(() => reject(sessionUnavailable(error?.message)));
    }
  });
}

async function sessionRequest(operation, details, settings, signal, capability) {
  const response = await sendRuntimeMessage({
    type: "civitai-account-request",
    operation,
    preferredHost: settings?.linkDomain,
    ...details,
  }, signal);
  if (response.ok) return response.payload;
  if (response.code === "session-unavailable") throw sessionUnavailable(response.message);
  if (response.code === "network") {
    throw new CivitaiApiError("The signed-in Civitai tab could not reach Civitai", {
      code: "session-network", capability, retryable: true,
    });
  }
  if (response.status === 401) {
    throw new CivitaiApiError("The Civitai website session is not signed in", {
      code: "session-authentication", status: 401, capability,
    });
  }
  if (response.status === 403) {
    throw new CivitaiApiError("The signed-in Civitai account denied the request", {
      code: "session-permission", status: 403, capability,
    });
  }
  if (response.code === "invalid-request" || response.code === "unsupported-operation" ||
      response.code === "invalid-response") {
    throw invalidResponse(capability);
  }
  throw httpError(Number(response.status) || 400, capability);
}

const SESSION_TOKEN_FALLBACK_CODES = new Set([
  "session-unavailable", "session-authentication", "session-permission", "session-network",
]);

async function sessionFirst(sessionOperation, fallbackOperation, settings, {
  allowAnonymousFallback = false,
} = {}) {
  try {
    return await sessionOperation();
  } catch (sessionError) {
    const canFallback = settings?.apiKey || allowAnonymousFallback;
    if (canFallback && SESSION_TOKEN_FALLBACK_CODES.has(sessionError?.code)) {
      try {
        return await fallbackOperation();
      } catch (fallbackError) {
        if (!settings?.apiKey && fallbackError?.code === "authentication") {
          throw sessionError;
        }
        throw fallbackError;
      }
    }
    throw sessionError;
  }
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

// The images API sits behind Cloudflare with s-maxage=300, so identical URLs
// return an edge-cached snapshot for up to 5 minutes — that's why "Refresh"
// seemed to do nothing. A per-refresh token appended to every request URL
// makes each refresh a distinct URL (cache MISS = fresh data). Within one
// refresh the token is stable, so pagination still benefits from caching.
let cacheBuster = "";
export function setCacheBuster(token) {
  cacheBuster = token || "";
}

function withBuster(url) {
  if (!cacheBuster) return url;
  return url + (url.includes("?") ? "&" : "?") + "_cb=" + encodeURIComponent(cacheBuster);
}

// Rate limits and hiccups must not kill a feed stream: retry transient
// failures (429 / 5xx / network) with backoff before giving up.
function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(10_000, 700 * (2 ** attempt) + Math.random() * 400);
}

function requestUrl(url, attempt) {
  let result = withBuster(url);
  if (attempt > 0) {
    result += (result.includes("?") ? "&" : "?") + `_cmh_retry=${attempt}`;
  }
  return result;
}

async function apiGet(url, settings, signal, attempt = 0, capability = null, validate = null) {
  let res;
  try {
    // no-store bypasses the browser cache; the _cb token (added by withBuster
    // at the call sites) bypasses Cloudflare's edge cache.
    res = await fetch(requestUrl(url, attempt), {
      headers: authHeaders(settings), cache: "no-store", signal,
    });
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    if (attempt >= 2) throw normalizeApiError(err, capability);
    await sleep(retryDelay(null, attempt), signal);
    return apiGet(url, settings, signal, attempt + 1, capability, validate);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await sleep(retryDelay(res, attempt), signal);
    return apiGet(url, settings, signal, attempt + 1, capability, validate);
  }
  if (!res.ok) throw httpError(res.status, capability);
  let data;
  try {
    data = await res.json();
  } catch {
    if (attempt < 2) {
      await sleep(retryDelay(res, attempt), signal);
      return apiGet(url, settings, signal, attempt + 1, capability, validate);
    }
    throw invalidResponse(capability);
  }
  if (validate && !validate(data)) {
    if (attempt < 2) {
      await sleep(retryDelay(res, attempt), signal);
      return apiGet(url, settings, signal, attempt + 1, capability, validate);
    }
    throw invalidResponse(capability);
  }
  return data;
}

async function trpcMutation(procedure, input, settings, signal, capability) {
  return withCapability(capability, async () => {
    requireApiKey(settings, capability);
    let res;
    try {
      res = await fetch(`${trpcBase(settings)}/${procedure}`, {
        method: "POST",
        headers: { ...authHeaders(settings), "Content-Type": "application/json" },
        body: JSON.stringify({ json: input }),
        cache: "no-store",
        signal,
      });
    } catch (error) {
      throw normalizeApiError(error, capability);
    }
    if (!res.ok) throw httpError(res.status, capability);
    const text = await res.text();
    if (!text) return null;
    let payload;
    try { payload = JSON.parse(text); } catch { throw invalidResponse(capability); }
    if (payload?.error) unwrapTrpcData(payload, capability);
    return payload;
  });
}

export function toggleImageReaction(imageId, reaction, settings, signal) {
  const allowed = new Set(["Like", "Heart", "Laugh", "Cry", "Dislike"]);
  if (!allowed.has(reaction)) throw new Error("Unsupported reaction");
  const capability = CIVITAI_CAPABILITIES.reactions;
  const input = { entityId: Number(imageId), entityType: "image", reaction };
  return sessionFirst(
    () => withCapability(capability, () => sessionRequest(
      "toggle-image-reaction", { imageId: input.entityId, reaction }, settings, signal, capability
    )),
    () => trpcMutation("reaction.toggle", input, settings, signal, capability),
    settings
  );
}

export async function resolveWritableCollections(settings, signal) {
  const capability = CIVITAI_CAPABILITIES.collectionList;
  const input = encodeURIComponent(JSON.stringify({
    json: { permissions: ["ADD", "ADD_REVIEW"], type: "Image" },
  }));
  return withCapability(capability, async () => {
    const data = await sessionFirst(
      () => sessionRequest("list-writable-collections", {}, settings, signal, capability),
      () => apiGet(`${trpcBase(settings)}/collection.getAllUser?input=${input}`, settings, signal, 0, capability),
      settings
    );
    const collections = unwrapTrpcData(data, capability);
    if (!Array.isArray(collections)) throw invalidResponse(capability);
    return collections.filter((collection) => collection?.isOwner === true);
  });
}

export function addImageToCollections(imageId, collections, settings, signal) {
  const capability = CIVITAI_CAPABILITIES.collectionWrite;
  if (!Array.isArray(collections) || collections.length === 0 || collections.length > 50) {
    throw new Error("Select between 1 and 50 collections");
  }
  const input = {
    type: "Image",
    imageId: Number(imageId),
    collections: collections.map((collection) => ({
      collectionId: collection.id,
      userId: collection.userId,
      read: collection.read,
      tagId: null,
    })),
  };
  return sessionFirst(
    () => withCapability(capability, () => sessionRequest(
      "add-image-to-collection",
      {
        imageId: input.imageId,
        collections: collections.map((collection) => ({
          id: collection.id, userId: collection.userId, read: collection.read,
        })),
      },
      settings, signal, capability
    )),
    () => trpcMutation("collection.saveItem", input, settings, signal, capability),
    settings
  );
}

export function addImageToCollection(imageId, collection, settings, signal) {
  return addImageToCollections(imageId, [collection], settings, signal);
}

// Posted as the user, through their signed-in tab, so leaving a comment needs no
// more than being logged in to Civitai — the same bar the site itself sets. An
// API key is the fallback for a standalone tab with no Civitai page open.
//
// `image` posts to the image's own thread; `comment` posts into the child thread
// of that comment, which is what a reply is.
export async function postComment(entityType, entityId, content, settings, signal) {
  const capability = CIVITAI_CAPABILITIES.comments;
  const text = String(content || "").trim();
  if (!text) throw new Error("A comment cannot be empty");
  const input = { entityId: Number(entityId), entityType, content: text };
  const data = await sessionFirst(
    () => withCapability(capability, () => sessionRequest("post-comment", input, settings, signal, capability)),
    () => trpcMutation("commentv2.upsert", input, settings, signal, capability),
    settings
  );
  return data ? unwrapTrpcData(data, capability) : null;
}

// Resolve a model (checkpoint or LoRA) to its versions, newest first.
export async function resolveModel(modelId, settings, signal) {
  if (modelCache.has(modelId)) return modelCache.get(modelId);
  const data = await apiGet(`${apiBase(settings)}/models/${modelId}`, settings, signal);
  const info = {
    name: data.name,
    type: data.type,
    versions: (data.modelVersions || []).map((v) => ({ id: v.id, name: v.name })),
  };
  modelCache.set(modelId, info);
  return info;
}

export async function resolveModelVersion(versionId, settings, signal) {
  if (versionCache.has(versionId)) return versionCache.get(versionId);
  const pending = apiGet(`${apiBase(settings)}/model-versions/${versionId}`, settings, signal).then((data) => ({
    name: data.model?.name || data.name || `Version ${versionId}`,
    versionName: data.name || "",
    type: data.model?.type || "Model",
    modelId: data.modelId,
  }));
  versionCache.set(versionId, pending);
  try {
    return await pending;
  } catch (error) {
    versionCache.delete(versionId);
    throw error;
  }
}

export async function resolveCollection(collectionId, settings, signal) {
  if (collectionCache.has(collectionId)) return collectionCache.get(collectionId);
  const input = encodeURIComponent(JSON.stringify({ json: { id: Number(collectionId) } }));
  const pending = withCapability(CIVITAI_CAPABILITIES.collectionSources, async () => {
    const capability = CIVITAI_CAPABILITIES.collectionSources;
    const data = await sessionFirst(
      () => sessionRequest("get-collection", {
        collectionId: Number(collectionId),
      }, settings, signal, capability),
      () => apiGet(`${trpcBase(settings)}/collection.getById?input=${input}`, settings, signal, 0, capability),
      settings,
      { allowAnonymousFallback: true }
    );
    const payload = unwrapTrpcData(data, CIVITAI_CAPABILITIES.collectionSources);
    const collection = payload?.collection || payload;
    if (!collection?.id) {
      throw new CivitaiApiError("Collection was not found or is not public", {
        code: "not-found", capability: CIVITAI_CAPABILITIES.collectionSources,
      });
    }
    return collection;
  });
  collectionCache.set(collectionId, pending);
  try {
    return await pending;
  } catch (error) {
    collectionCache.delete(collectionId);
    throw error;
  }
}

// The v1 image feed often omits generation metadata even when Civitai's image
// page can display it. The site uses this read-only MediaRead tRPC procedure.
// Requested on demand from the lightbox, through the signed-in Civitai tab so
// the user sees exactly what the site would show them; an API key is only a
// fallback for when no such tab is open.
export async function resolveImageGenerationData(imageId, settings, signal) {
  if (generationDataCache.has(imageId)) return generationDataCache.get(imageId);
  const capability = CIVITAI_CAPABILITIES.generationDetails;
  const input = encodeURIComponent(JSON.stringify({ json: { id: Number(imageId) } }));
  const pending = withCapability(capability, async () => {
    const data = await sessionFirst(
      () => sessionRequest("get-image-generation-data", {
        imageId: Number(imageId),
      }, settings, signal, capability),
      () => apiGet(`${trpcBase(settings)}/image.getGenerationData?input=${input}`, settings, signal, 0,
        capability),
      settings,
      { allowAnonymousFallback: true }
    );
    const payload = unwrapTrpcData(data, CIVITAI_CAPABILITIES.generationDetails);
    if (payload === null) return { meta: null, resources: [] };
    if (typeof payload !== "object") throw invalidResponse(CIVITAI_CAPABILITIES.generationDetails);
    return payload;
  });
  generationDataCache.set(imageId, pending);
  try {
    return await pending;
  } catch (error) {
    generationDataCache.delete(imageId);
    throw error;
  }
}

// Read through the signed-in tab first, for the same reason as the generation
// data: a logged-in user already has access to these on the site. The limit
// matches the one the content script pins for the session request.
export const COMMENT_PREVIEW_LIMIT = 8;
export const COMMENT_REPLY_LIMIT = 10;

// One page of a comment thread. `image` reads an image's own comments; `comment`
// reads the replies hanging off one of them — Civitai models a reply as a comment
// in a child thread owned by its parent, so it is the same procedure either way.
async function fetchCommentPage(entityType, entityId, limit, settings, signal, capability) {
  const input = encodeURIComponent(JSON.stringify({
    json: { entityId, entityType, limit, hidden: false },
  }));
  const data = await sessionFirst(
    () => sessionRequest("get-comments", { entityType, entityId, limit }, settings, signal, capability),
    () => apiGet(`${trpcBase(settings)}/commentv2.getInfinite?input=${input}`, settings, signal, 0,
      capability),
    settings,
    { allowAnonymousFallback: true }
  );
  const payload = unwrapTrpcData(data, capability);
  if (payload === null) return [];
  if (!Array.isArray(payload?.comments)) throw invalidResponse(capability);
  return payload.comments;
}

// The thread as the site presents it: top-level comments, each carrying the
// replies made to it, so a discussion reads as a discussion rather than as a
// flat list in which nobody is answering anybody.
//
// Civitai's payload has no reply count on the parent — `childThread` is commented
// out in their own selector — so the only way to know whether a comment was
// answered is to ask for its thread. That is one small request per shown comment,
// issued in parallel and only when an image is opened; a reply page that fails
// costs that one comment its replies and nothing else.
export async function resolveImageComments(imageId, settings, signal) {
  if (imageCommentsCache.has(imageId)) return imageCommentsCache.get(imageId);
  const capability = CIVITAI_CAPABILITIES.commentPreview;
  const pending = withCapability(capability, async () => {
    const comments = await fetchCommentPage(
      "image", Number(imageId), COMMENT_PREVIEW_LIMIT, settings, signal, capability
    );
    return {
      comments: await Promise.all(comments.map(async (comment) => {
        const id = Number(comment?.id);
        if (!Number.isSafeInteger(id) || id <= 0) return { ...comment, replies: [] };
        try {
          return {
            ...comment,
            replies: await fetchCommentPage(
              "comment", id, COMMENT_REPLY_LIMIT, settings, signal, capability
            ),
          };
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          return { ...comment, replies: [] };
        }
      })),
    };
  });
  imageCommentsCache.set(imageId, pending);
  try {
    return await pending;
  } catch (error) {
    imageCommentsCache.delete(imageId);
    throw error;
  }
}

// Civitai stores a profile picture as a media key its own EdgeMedia component
// expands. A key is turned into a CDN URL; an absolute URL is used only when it
// is already Civitai's own media host, because an avatar URL comes from another
// user and pointing this page at an arbitrary host would hand that user a
// request from every reader. Anything else falls back to initials.
const AVATAR_HOSTS = new Set(["image.civitai.com", "civitai.com", "civitai.red"]);

export function userAvatarUrl(user, width = 96) {
  const picture = user?.profilePicture;
  const source = picture?.url || user?.image;
  if (typeof source !== "string" || !source) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    try {
      const parsed = new URL(source);
      return parsed.protocol === "https:" && AVATAR_HOSTS.has(parsed.hostname) ? parsed.toString() : null;
    } catch {
      return null;
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{15,63}$/.test(source)) return null;
  return `${IMAGE_CDN_BASE}/${source}/width=${Math.round(width)}/avatar.jpeg`;
}

export async function resolveCreatorProfile(username, settings, signal) {
  const normalized = typeof username === "string" ? username.trim() : "";
  if (!normalized) return null;
  const key = normalized.toLocaleLowerCase();
  if (creatorCache.has(key)) return creatorCache.get(key);
  const input = encodeURIComponent(JSON.stringify({ json: { username: normalized } }));
  const pending = apiGet(
    `${trpcBase(settings)}/user.getCreator?input=${input}`,
    settings,
    signal
  ).then((data) => {
    const user = unwrapTrpcData(data);
    return user && typeof user === "object" ? user : null;
  });
  creatorCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    creatorCache.delete(key);
    throw error;
  }
}

export function imageBuzzAmount(item) {
  const value = Number(item?.stats?.tippedAmountCountAllTime
    ?? item?.stats?.tippedAmountCount ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function imagesUrl(settings, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  }
  return `${apiBase(settings)}/images?${qs}`;
}

function collectionImagesUrl(settings, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  return `${trpcBase(settings)}/image.getInfinite?input=${encoded}`;
}

// The REST image API returns an absolute CDN URL. Civitai's tRPC image feed,
// used for collection filtering, instead returns the database storage key and
// expects the website's EdgeMedia component to expand it into a CDN URL.
function collectionMediaUrl(src, name, type = "image") {
  if (!src || /^(?:https?:|blob:|data:)/i.test(src)) return src;
  const extension = type === "video" ? ".mp4" : type === "audio" ? ".mp3" : ".jpeg";
  let filename = String(name || src).replaceAll("%", "");
  if (filename.includes(".")) filename = `${filename.split(".").slice(0, -1).join(".")}${extension}`;
  else filename += extension;
  return `${IMAGE_CDN_BASE}/${String(src).replace(/^\/+|\/+$/g, "")}/original=true/${filename}`;
}

function normalizeCollectionImage(item) {
  const stats = item.stats || {};
  const buzzAmount = imageBuzzAmount(item);
  const modelVersionIds = [...new Set([
    ...(Array.isArray(item.modelVersionIds) ? item.modelVersionIds : []),
    ...(Array.isArray(item.modelVersionIdsManual) ? item.modelVersionIdsManual : []),
  ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  return {
    ...item,
    url: collectionMediaUrl(item.url, item.name, item.type),
    thumbnailUrl: collectionMediaUrl(item.thumbnailUrl, item.name, "image"),
    username: item.username || item.user?.username || null,
    browsingLevel: Number(item.browsingLevel) || Number(item.nsfwLevel) || 0,
    createdAt: item.createdAt || item.publishedAt || item.sortAt,
    ...(modelVersionIds.length > 0 ? { modelVersionIds } : {}),
    stats: {
      likeCount: stats.likeCount ?? stats.likeCountAllTime ?? 0,
      heartCount: stats.heartCount ?? stats.heartCountAllTime ?? 0,
      laughCount: stats.laughCount ?? stats.laughCountAllTime ?? 0,
      cryCount: stats.cryCount ?? stats.cryCountAllTime ?? 0,
      dislikeCount: stats.dislikeCount ?? stats.dislikeCountAllTime ?? 0,
      commentCount: stats.commentCount ?? stats.commentCountAllTime ?? 0,
      collectedCount: stats.collectedCount ?? stats.collectedCountAllTime ?? 0,
      collectedCountAllTime: stats.collectedCountAllTime ?? stats.collectedCount ?? 0,
      tippedAmountCount: buzzAmount,
      tippedAmountCountAllTime: buzzAmount,
    },
  };
}

function normalizeUsername(value) {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  for (const candidate of [value.username, value.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function suggestionImageUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "image.civitai.com"
      ? url.toString() : null;
  } catch {
    return null;
  }
}

function suggestionQuery(raw) {
  return typeof raw === "string" ? raw.trim().slice(0, 100) : "";
}

// Search results are normalized into source drafts so the sidebar autocomplete
// and the existing paste/ID flow converge before any source is saved. The
// public users endpoint is used for Creators because it includes image-only
// posters; /creators omits accounts that have not published a model.
export async function searchSourceSuggestions(kind, rawQuery, settings, signal) {
  const query = suggestionQuery(rawQuery);
  if (!query) return [];
  if (!["user", "model", "collection"].includes(kind)) {
    throw new Error("Unsupported source search type");
  }
  const params = new URLSearchParams({ query, limit: "8" });
  if (["model", "collection"].includes(kind)
      && levelsFromMask(settings?.browsingLevel).some((level) => level > 2)) {
    params.set("nsfw", "true");
  }
  const endpoint = kind === "user" ? "users" : `${kind}s`;
  const data = await apiGet(
    `${apiBase(settings)}/${endpoint}?${params}`,
    settings,
    signal,
    0,
    null,
    (payload) => payload && Array.isArray(payload.items)
  );

  if (kind === "user") {
    return data.items.flatMap((item) => {
      const username = normalizeUsername(item);
      if (!username || !/^[\w.-]+$/u.test(username)) return [];
      return [{
        kind,
        key: `user:${username.toLocaleLowerCase()}`,
        primary: `@${username}`,
        secondary: "Creator",
        imageUrl: null,
        draft: { type: "user", username },
      }];
    }).slice(0, 8);
  }

  if (kind === "model") {
    return data.items.flatMap((item) => {
      const modelId = Number(item?.id);
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!Number.isSafeInteger(modelId) || modelId <= 0 || !name) return [];
      const modelType = typeof item.type === "string" && item.type.trim()
        ? item.type.trim() : "Model";
      const username = normalizeUsername(item.creator);
      const preview = (Array.isArray(item.modelVersions) ? item.modelVersions : [])
        .flatMap((version) => Array.isArray(version?.images) ? version.images : [])
        .find((image) => suggestionImageUrl(image?.url));
      const displayType = modelType === "LORA" ? "LoRA" : modelType;
      return [{
        kind,
        key: `model:${modelId}`,
        primary: name,
        secondary: [displayType, username ? `@${username}` : "", `#${modelId}`]
          .filter(Boolean).join(" · "),
        imageUrl: suggestionImageUrl(preview?.url),
        draft: { type: "model", modelId, label: `${displayType}: ${name}` },
      }];
    }).slice(0, 8);
  }

  return data.items.flatMap((item) => {
    const collectionId = Number(item?.id);
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!Number.isSafeInteger(collectionId) || collectionId <= 0 || !name
        || String(item.type).toLocaleLowerCase() !== "image") return [];
    const username = normalizeUsername(item.user);
    const itemCount = Number(item.itemCount);
    return [{
      kind,
      key: `collection:${collectionId}`,
      primary: name,
      secondary: ["Image collection", username ? `@${username}` : "",
        Number.isFinite(itemCount) ? `${itemCount} items` : "", `#${collectionId}`]
        .filter(Boolean).join(" · "),
      imageUrl: suggestionImageUrl(item.coverImageUrl),
      draft: { type: "collection", collectionId, label: `Collection: ${name}` },
    }];
  }).slice(0, 8);
}

function normalizeImage(item) {
  const modelVersionIds = [...new Set([
    ...(Array.isArray(item?.modelVersionIds) ? item.modelVersionIds : []),
    ...(Array.isArray(item?.modelVersionIdsManual) ? item.modelVersionIdsManual : []),
  ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  return {
    ...item,
    username: normalizeUsername(item?.username) || normalizeUsername(item?.user),
    ...(modelVersionIds.length > 0 ? { modelVersionIds } : {}),
  };
}

export const BROWSING_LEVEL_VALUES = ALLOWED_BROWSING_LEVELS;
export const BROWSING_LEVEL_LABELS = Object.freeze({ 1: "PG", 2: "PG-13", 4: "R", 8: "X", 16: "XXX" });

export function levelsFromMask(mask) {
  return BROWSING_LEVEL_VALUES.filter((level) => (Number(mask) & level) === level);
}

export function maskFromLevels(levels) {
  return levels.reduce((mask, level) => mask | Number(level), 0);
}

// The maturity setting currently active on the Civitai host being browsed,
// read from the user's signed-in session/settings cache. Hubs without a saved
// profile follow it; intentionally saved profiles use the write helper below
// before their feed starts.
//
// Civitai's BrowsingLevelProvider computes the effective level as
// `showNsfw ? browsingLevel : PG`, so the "show mature content" master switch is
// applied here the same way. Returns { levels, reason } — `levels` is null when
// the setting cannot be established (signed out, no open tab on that host, an
// unexpected session shape) and `reason` says which, so the panel can tell the
// user why their site setting is not being followed instead of failing silently.
export async function resolveAccountBrowsingLevels(settings, signal) {
  let response;
  try {
    response = await sendRuntimeMessage({
      type: "civitai-account-request",
      operation: "get-browsing-level",
      preferredHost: apiHost(settings),
    }, signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { levels: null, reason: error?.code === "session-unavailable" ? "no-tab" : "unreachable" };
  }
  if (!response?.ok) return { levels: null, reason: "unreachable" };
  const payload = response.payload || {};
  if (!payload.signedIn) return { levels: null, reason: "signed-out" };

  // getSettings is the fresher source for showNsfw; the session lags behind it.
  let showNsfw = payload.sessionShowNsfw;
  let browsingLevel = payload.browsingLevel;
  if (payload.settingsPayload) {
    try {
      const decoded = unwrapTrpcData(payload.settingsPayload, null);
      if (typeof decoded?.showNsfw === "boolean") showNsfw = decoded.showNsfw;
      const redLevel = Number(decoded?.redBrowsingLevel);
      if (apiHost(settings) === "civitai.red" && Number.isSafeInteger(redLevel) && redLevel > 0) {
        browsingLevel = redLevel;
      }
    } catch {
      // Serializer changed; the session value still applies.
    }
  }
  if (showNsfw === false) return { levels: [1], reason: "nsfw-disabled" };

  const levels = levelsFromMask(browsingLevel);
  if (levels.length === 0) return { levels: null, reason: "no-level-in-session" };
  return { levels, reason: "inherited" };
}

// Apply an intentionally saved hub profile to the user's Civitai.red setting.
// This is a single mutation: callers confirm an ambiguous
// failure by reading the setting back rather than risking duplicate writes.
export async function updateAccountBrowsingLevels(levels, settings, signal) {
  if (apiHost(settings) !== "civitai.red") {
    throw new CivitaiApiError("Hub content profiles are available only on civitai.red", {
      code: "invalid-request",
    });
  }
  const normalized = [...new Set((levels || []).map(Number))].sort((a, b) => a - b);
  if (normalized.length === 0
      || normalized.some((level) => !BROWSING_LEVEL_VALUES.includes(level))) {
    throw new CivitaiApiError("At least one valid browsing level is required", {
      code: "invalid-request",
    });
  }
  const mask = maskFromLevels(normalized);
  await sessionRequest("set-browsing-level", { browsingLevel: mask }, settings, signal, null);
  return levelsFromMask(mask);
}

const API_SORT = {
  newest: "Newest",
  oldest: "Oldest",
  reactions: "Most Reactions",
  comments: "Most Comments",
};

// A stream is one paged sequence of images from the API. User and collection
// sources have one stream; a model source has one per queried version (the
// modelId filter on /images is broken upstream). Streams keep their cursor in `nextUrl` and the
// worst-ranked item fetched so far in `lastItem` (the merge frontier). Every
// stream is fetched pre-sorted by the feed's global sort, so the merge only
// interleaves — sources have no sort of their own.
export async function openSourceStreams(source, feed, settings, signal) {
  const displayName = source.alias?.trim();
  // browsingLevel is an exact bitmask filter applied by Civitai itself, so a
  // selection of XXX only returns XXX. The legacy `nsfw` enum could only say
  // "up to this tier" and left the precise filtering to the client.
  const base = {
    sort: API_SORT[feed.globalSort] || "Newest",
    limit: PAGE_LIMIT,
    period: feed.period || "AllTime",
    browsingLevel: settings.browsingLevel || 1,
  };

  if (source.type === "user") {
    return [{
      label: displayName || `@${source.username}`,
      originalLabel: `@${source.username}`,
      href: `/user/${encodeURIComponent(source.username)}`,
      nextUrl: imagesUrl(settings, { ...base, username: source.username }),
      lastItem: null,
    }];
  }

  if (source.type === "collection") {
    const collection = await resolveCollection(source.collectionId, settings, signal);
    if (String(collection.type).toLocaleLowerCase() !== "image") {
      throw new Error(`Collection type ${collection.type || "unknown"} is not a media collection`);
    }
    const input = {
      collectionId: source.collectionId,
      limit: PAGE_LIMIT,
      sort: API_SORT[feed.globalSort] || "Newest",
      period: feed.period || "AllTime",
      browsingLevel: settings.browsingLevel || 1,
      includeBaseModel: true,
    };
    const originalLabel = `Collection: ${collection.name || `#${source.collectionId}`}`;
    return [{
      label: displayName || originalLabel,
      originalLabel,
      href: `/collections/${source.collectionId}`,
      nextUrl: collectionImagesUrl(settings, input),
      collectionInput: input,
      responseKind: "collection",
      lastItem: null,
    }];
  }

  const model = await resolveModel(source.modelId, settings, signal);
  const typeLabel = model.type === "LORA" ? "LoRA" : model.type;
  const specific = Array.isArray(source.versionIds) && source.versionIds.length > 0;
  // Explicitly selected versions are queried even if the models endpoint does
  // not list them (civitai hides some versions there, e.g. early access).
  const versions = specific
    ? source.versionIds.map(
        (id) => model.versions.find((v) => v.id === id) || { id, name: `version ${id}` }
      )
    : model.versions.slice(0, settings.maxVersionsPerModel || 10);
  return versions.map((v) => ({
    label: displayName || (specific
      ? `${typeLabel}: ${model.name} · ${v.name}`
      : `${typeLabel}: ${model.name}`),
    originalLabel: specific
      ? `${typeLabel}: ${model.name} · ${v.name}`
      : `${typeLabel}: ${model.name}`,
    href: specific
      ? `/models/${source.modelId}?modelVersionId=${v.id}`
      : `/models/${source.modelId}`,
    modelType: model.type,
    nextUrl: imagesUrl(settings, { ...base, modelVersionId: v.id }),
    lastItem: null,
  }));
}

// Fetch the next page of a stream and advance its cursor.
export async function fetchStreamPage(stream, settings, signal) {
  if (!stream.nextUrl) return [];
  const isCollection = stream.responseKind === "collection";
  const validate = isCollection
    ? (data) => Boolean(data?.error) || Array.isArray(
      data?.result?.data?.json?.items ?? data?.result?.data?.items
    )
    : (data) => Array.isArray(data?.items);
  const data = isCollection
    ? await withCapability(CIVITAI_CAPABILITIES.collectionSources, () => sessionFirst(
      () => sessionRequest("get-collection-page", {
        collectionInput: stream.collectionInput,
      }, settings, signal, CIVITAI_CAPABILITIES.collectionSources),
      () => apiGet(stream.nextUrl, settings, signal, 0,
        CIVITAI_CAPABILITIES.collectionSources, validate),
      settings,
      { allowAnonymousFallback: true }
    ))
    : await apiGet(stream.nextUrl, settings, signal, 0, null, validate);
  const payload = isCollection
    ? unwrapTrpcData(data, CIVITAI_CAPABILITIES.collectionSources)
    : data;
  if (!payload || !Array.isArray(payload.items)) {
    const error = invalidResponse(isCollection ? CIVITAI_CAPABILITIES.collectionSources : null);
    if (isCollection) noteCapabilityFailure(CIVITAI_CAPABILITIES.collectionSources, error);
    throw error;
  }
  const items = (payload.items || []).map((item) =>
    normalizeImage(isCollection ? normalizeCollectionImage(item) : item)
  );
  if (isCollection) {
    const cursor = payload.nextCursor;
    stream.nextUrl = items.length > 0 && cursor !== undefined && cursor !== null
      ? collectionImagesUrl(settings, { ...stream.collectionInput, cursor }) : null;
  } else {
    stream.nextUrl = items.length > 0 && payload.metadata?.nextPage
      ? pinHost(payload.metadata.nextPage, settings) : null;
  }
  if (items.length > 0) stream.lastItem = items[items.length - 1];
  for (const item of items) item._source = stream.label;
  return items;
}

// Civitai CDN URL transform: swap the "original=true" segment for a resize.
export function thumbnailUrl(url, width = 450) {
  return url.replace(/\/original=true\//, `/width=${width}/`);
}

function videoVariantUrl(url, variant, extension) {
  const transformed = String(url || "").replace(
    /\/(?:original=true|[^/]*(?:width|transcode|anim|optimized)=[^/]*)\//,
    `/${variant}/`
  );
  return transformed.replace(/\.[^./?#]+(?=\?|#|$)/, extension);
}

export function videoPlaybackUrl(url, width = 450) {
  return videoVariantUrl(url, `transcode=true,width=${width}`, ".mp4");
}

export function videoPosterUrl(url, width = 450) {
  return videoVariantUrl(
    url,
    `anim=false,transcode=true,width=${width},original=false,optimized=true`,
    ".jpeg"
  );
}
