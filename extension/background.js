import {
  loadConfig, saveConfig, mergeSourceIntoFeed, normalizeSource,
  makeFeed, normalizeNewHubName, MAX_HUBS,
} from "./storage.js";
import {
  ALLOWED_CIVITAI_HOSTS,
  DEFAULT_CIVITAI_HOST,
  isAllowedCivitaiHost,
} from "./distribution.js";

let openFeedPromise = null;

function openFeed() {
  if (openFeedPromise) return openFeedPromise;
  const url = chrome.runtime.getURL("feed.html");
  openFeedPromise = new Promise((resolve) => {
    chrome.tabs.query({ url }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true }, () => {
          chrome.windows.update(tabs[0].windowId, { focused: true }, resolve);
        });
      } else chrome.tabs.create({ url }, resolve);
    });
  }).finally(() => {
    openFeedPromise = null;
  });
  return openFeedPromise;
}

chrome.action.onClicked.addListener(openFeed);

const SESSION_OPERATIONS = new Set([
  "list-writable-collections",
  "get-collection",
  "get-collection-page",
  "add-image-to-collection",
  "get-browsing-level",
  "get-comments",
  "post-comment",
  "get-image-generation-data",
]);

// civitai.com and civitai.red carry separate browsing-level preferences, so
// reading one from the wrong host would report the wrong maturity setting.
const HOST_PINNED_OPERATIONS = new Set(["get-browsing-level"]);

function isCivitaiTab(tab) {
  try {
    return isAllowedCivitaiHost(new URL(tab?.url || "").hostname);
  } catch {
    return false;
  }
}

function queryCivitaiTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: [...ALLOWED_CIVITAI_HOSTS].map((host) => `https://${host}/*`) }, (tabs) => {
      resolve(chrome.runtime.lastError ? [] : tabs);
    });
  });
}

function sendAccountRequest(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response) reject(new Error("The Civitai session bridge did not respond"));
      else resolve(response);
    });
  });
}

async function routeAccountRequest(message, sender) {
  if (!SESSION_OPERATIONS.has(message.operation)) {
    return { ok: false, code: "unsupported-operation" };
  }

  const preferredHost = isAllowedCivitaiHost(message.preferredHost)
    ? message.preferredHost : DEFAULT_CIVITAI_HOST;
  const tabs = await queryCivitaiTabs();
  let candidates = [];
  if (isCivitaiTab(sender.tab)) candidates.push(sender.tab);
  for (const tab of tabs) {
    if (!candidates.some((candidate) => candidate.id === tab.id)) candidates.push(tab);
  }
  if (HOST_PINNED_OPERATIONS.has(message.operation)) {
    candidates = candidates.filter((tab) => new URL(tab.url).hostname === preferredHost);
  }
  candidates.sort((a, b) => {
    if (a.id === sender.tab?.id) return -1;
    if (b.id === sender.tab?.id) return 1;
    const aPreferred = new URL(a.url).hostname === preferredHost;
    const bPreferred = new URL(b.url).hostname === preferredHost;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  let lastAuthenticationResponse = null;
  for (const tab of candidates) {
    try {
      const response = await sendAccountRequest(tab.id, {
        type: "civitai-account-request",
        operation: message.operation,
        imageId: message.imageId,
        entityType: message.entityType,
        entityId: message.entityId,
        limit: message.limit,
        content: message.content,
        collection: message.collection,
        collectionId: message.collectionId,
        collectionInput: message.collectionInput,
      });
      if (response.ok || response.status !== 401) return response;
      lastAuthenticationResponse = response;
    } catch {
      // A tab opened before installation/reload may not have the current content script.
    }
  }
  if (lastAuthenticationResponse) return lastAuthenticationResponse;
  return {
    ok: false,
    code: "session-unavailable",
    message: "Open or refresh a signed-in Civitai tab and try again",
  };
}

// Messages from the content script injected on civitai pages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || sender.id !== chrome.runtime.id) return;
  if (msg.type === "civitai-account-request") {
    routeAccountRequest(msg, sender).then(sendResponse);
    return true;
  }
  if (msg.type === "open-feed") {
    openFeed();
    return;
  }
  if (msg.type === "get-hubs") {
    loadConfig().then((config) =>
      sendResponse({ hubs: config.feeds.map((f) => ({ id: f.id, name: f.name })) })
    );
    return true;
  }
  if (msg.type === "add-source") {
    addSource(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === "create-hub-with-source") {
    createHubWithSource(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// Mature media is only served from civitai.red, so background reads follow the
// same host the user browses rather than always hitting the SFW host.
function civitaiHost(config) {
  return isAllowedCivitaiHost(config?.settings?.linkDomain)
    ? config.settings.linkDomain : DEFAULT_CIVITAI_HOST;
}

function unwrapTrpcPayload(data) {
  return data?.result?.data?.json ?? data?.result?.data;
}

async function readCollection(collectionId, config, sender) {
  const sessionResponse = await routeAccountRequest({
    operation: "get-collection",
    collectionId,
    preferredHost: config.settings.linkDomain,
  }, sender);
  let data;
  if (sessionResponse.ok) {
    data = sessionResponse.payload;
  } else {
    const input = encodeURIComponent(JSON.stringify({ json: { id: collectionId } }));
    const headers = config.settings.apiKey
      ? { Authorization: `Bearer ${config.settings.apiKey}` }
      : {};
    const res = await fetch(
      `https://${civitaiHost(config)}/api/trpc/collection.getById?input=${input}`,
      { headers }
    );
    if (!res.ok) {
      if (!config.settings.apiKey && [401, 403].includes(res.status)) {
        const instruction = sessionResponse.status === 401
          ? "Sign in to Civitai in the open tab and try again"
          : sessionResponse.status === 403
            ? "The signed-in Civitai account cannot access this collection"
            : "Refresh or open a signed-in Civitai tab and try again";
        throw new Error(instruction);
      }
      throw new Error(`Could not read collection (${res.status})`);
    }
    data = await res.json();
  }
  const payload = unwrapTrpcPayload(data) || {};
  const collection = payload.collection || payload;
  if (!collection?.id) throw new Error("Collection was not found or is not public");
  return collection;
}

async function addSource({ feedId, source }, sender) {
  const config = await loadConfig();
  if (typeof feedId !== "string") throw new Error("Invalid hub id");
  const feed = config.feeds.find((f) => f.id === feedId);
  if (!feed) throw new Error("That hub no longer exists; refresh the Civitai page and try again");
  source = normalizeSource(source, { strict: true });
  if (source.type === "model" && !source.label) {
    try {
      const headers = config.settings.apiKey
        ? { Authorization: `Bearer ${config.settings.apiKey}` }
        : {};
      const res = await fetch(
        `https://${civitaiHost(config)}/api/v1/models/${source.modelId}`, { headers }
      );
      if (res.ok) {
        const data = await res.json();
        source.label = `${data.type === "LORA" ? "LoRA" : data.type}: ${data.name}`;
      }
    } catch {
      // Label resolution is best-effort; the feed page resolves it on fetch anyway.
    }
  }
  if (source.type === "collection" && !source.label) {
    const collection = await readCollection(source.collectionId, config, sender);
    if (String(collection.type).toLocaleLowerCase() !== "image") {
      throw new Error(`Collection type ${collection.type || "unknown"} is not supported by the media feed`);
    }
    source.label = `Collection: ${collection.name || `#${source.collectionId}`}`;
  }
  const result = mergeSourceIntoFeed(feed, source);
  if (result.status !== "duplicate") await saveConfig(config);
  return { ok: true, status: result.status, feedName: feed.name };
}

async function createHubWithSource({ name, source }, sender) {
  const config = await loadConfig();
  if (config.feeds.length >= MAX_HUBS) {
    throw new Error(`MultiHub supports at most ${MAX_HUBS} hubs`);
  }
  const feed = makeFeed(normalizeNewHubName(name));
  config.feeds.push(feed);
  source = normalizeSource(source, { strict: true });
  if (source.type === "model" && !source.label) {
    try {
      const headers = config.settings.apiKey
        ? { Authorization: `Bearer ${config.settings.apiKey}` }
        : {};
      const res = await fetch(
        `https://${civitaiHost(config)}/api/v1/models/${source.modelId}`, { headers }
      );
      if (res.ok) {
        const data = await res.json();
        source.label = `${data.type === "LORA" ? "LoRA" : data.type}: ${data.name}`;
      }
    } catch {
      // A useful source is still created when its display label cannot be enriched.
    }
  }
  if (source.type === "collection" && !source.label) {
    const collection = await readCollection(source.collectionId, config, sender);
    if (String(collection.type).toLocaleLowerCase() !== "image") {
      throw new Error(`Collection type ${collection.type || "unknown"} is not supported by the media feed`);
    }
    source.label = `Collection: ${collection.name || `#${source.collectionId}`}`;
  }
  const result = mergeSourceIntoFeed(feed, source);
  await saveConfig(config);
  return { ok: true, status: result.status, feedId: feed.id, feedName: feed.name };
}
