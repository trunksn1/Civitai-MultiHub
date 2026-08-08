// Injected on civitai.com / civitai.red.
//
// 1. Inserts a "MultiHub" item into civitai's top ribbon (Home, Images,
//    Videos, Models, …) by cloning an existing ribbon link so it inherits the
//    site's own styling. Civitai is a React app, so the ribbon is re-rendered
//    on navigation — a debounced observer re-injects when the item disappears. If
//    the ribbon can't be found (site redesign), a floating button is the fallback.
// 2. On model/LoRA, creator and collection pages, shows a floating "Add to MultiHub"
//    button that always asks which hub to add to.
// 3. Proxies explicitly allowlisted read operations — collections, the browsing
//    level, image comments and generation data — through the current Civitai
//    origin. This lets Chrome attach the site's existing session cookies without
//    exposing those cookies to the extension, so a signed-in user sees what the
//    site would show them without pasting an API key.
// 4. Keeps Civitai's own popovers above the panel while it is open, because
//    settings such as the browsing level are changed on the site's controls.

(() => {
// Store and manually installed variants have different extension IDs but share the Civitai page.
// Claim the page synchronously so only one variant injects persistent UI. If a stale owner marker
// remains without any MultiHub UI, this instance safely reclaims it.
const pageRoot = document.documentElement;
const existingUi = document.querySelector("#cmh-overlay, #cmh-widget, #cmh-nav-item");
if (existingUi) return;
pageRoot.setAttribute("data-cmh-extension-owner", chrome.runtime.id);

// ---------- page detection ----------

function pageSource() {
  let m = location.pathname.match(/^\/models\/(\d+)/);
  if (m) {
    const versionId = new URLSearchParams(location.search).get("modelVersionId");
    return { type: "model", modelId: Number(m[1]), versionId: versionId ? Number(versionId) : null };
  }
  m = location.pathname.match(/^\/user\/([^/?#]+)/);
  if (m) return { type: "user", username: decodeURIComponent(m[1]) };
  m = location.pathname.match(/^\/collections\/(\d+)/);
  if (m) return { type: "collection", collectionId: Number(m[1]) };
  return null;
}

function sourceCaption(source) {
  if (source.type === "model") return "this model";
  if (source.type === "collection") return "this collection";
  return `@${source.username}`;
}

// ---------- ribbon injection ----------

const RIBBON_PATHS = new Set([
  "/", "/home", "/images", "/videos", "/models", "/posts", "/articles",
  "/tools", "/collections", "/bounties", "/events", "/shop", "/auctions", "/challenges",
]);
let ribbonContainer = null;
const boundRibbonContainers = new WeakSet();

const overlay = document.createElement("div");
overlay.id = "cmh-overlay";
overlay.hidden = true;
document.documentElement.append(overlay);

function positionOverlay() {
  if (overlay.hidden) return;
  const bottom = ribbonContainer?.getBoundingClientRect().bottom;
  overlay.style.top = `${Math.max(0, Math.round(bottom || 0))}px`;
}

function closeOverlay() {
  overlay.hidden = true;
  document.documentElement.removeAttribute("data-cmh-panel");
  stopLiftingSitePopovers();
  document.getElementById("cmh-nav-item")?.classList.remove("cmh-active");
}

function toggleOverlay(container) {
  if (window.innerWidth < 720) {
    chrome.runtime.sendMessage({ type: "open-feed" });
    return;
  }
  ribbonContainer = container || ribbonContainer;
  if (!overlay.querySelector("iframe")) {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL(
      `feed.html?embedded=1&host=${encodeURIComponent(location.hostname)}`
    );
    frame.title = "MultiHub for Civitai feed";
    overlay.append(frame);
  }
  overlay.hidden = !overlay.hidden;
  document.getElementById("cmh-nav-item")?.classList.toggle("cmh-active", !overlay.hidden);
  positionOverlay();
  if (overlay.hidden) {
    closeOverlay();
    return;
  }
  // Civitai's own controls have to stay usable over the panel — the browsing
  // level is set there, not here.
  document.documentElement.setAttribute("data-cmh-panel", "open");
  startLiftingSitePopovers();
  // The panel mirrors this site's content setting; tell it to re-read on open so
  // a level changed while it was collapsed applies straight away.
  overlay.querySelector("iframe")?.contentWindow?.postMessage({ type: "cmh-panel-shown" }, "*");
}

// ---------- keeping Civitai's own menus above the panel ----------
//
// The browsing level is Civitai's setting, so it is changed on Civitai's control
// while the panel is open. That menu is a Mantine popover asking for
// `z-index: calc(var(--dialog-z-index) + 2)`, and that variable only exists while
// one of their dialogs is open: everywhere else the declaration is invalid, the
// dropdown falls back to `z-index: auto`, and the panel (z-index 90) covers it.
// content.css supplies the value they meant while the panel is open, which is
// enough on its own. This is the belt to that pair of braces: any site popover
// that ends up with no z-index at all is given one above the panel. Only
// elements the site left at `auto` are touched, so nothing it stacked
// deliberately is reordered.
// The value Civitai's own popovers ask for, and which the panel's 90 sits below.
const SITE_POPOVER_Z_INDEX = 302;
const SITE_POPOVER_SELECTOR = [
  ".mantine-Popover-dropdown", ".mantine-Menu-dropdown", ".mantine-HoverCard-dropdown",
  "[role='dialog']", "[role='menu']", "[role='tooltip']", "[role='listbox']",
].join(",");
let popoverObserver = null;

function liftSitePopover(element) {
  if (!(element instanceof Element) || element.closest("#cmh-overlay, #cmh-widget")) return;
  const style = getComputedStyle(element);
  if (style.position === "static" || style.zIndex !== "auto") return;
  element.style.setProperty("z-index", String(SITE_POPOVER_Z_INDEX), "important");
}

function liftSitePopovers(root) {
  if (!(root instanceof Element)) return;
  if (root.matches(SITE_POPOVER_SELECTOR)) liftSitePopover(root);
  for (const element of root.querySelectorAll(SITE_POPOVER_SELECTOR)) liftSitePopover(element);
}

function startLiftingSitePopovers() {
  if (popoverObserver) return;
  liftSitePopovers(document.body);
  popoverObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) liftSitePopovers(node);
    }
  });
  // Portalled menus are appended straight to <body>, so watching its direct
  // children keeps this off the hot path of an infinite-scrolling feed.
  popoverObserver.observe(document.body, { childList: true });
}

function stopLiftingSitePopovers() {
  popoverObserver?.disconnect();
  popoverObserver = null;
}

// Find the horizontal category nav by looking for a container whose children
// hold several links to the known ribbon destinations.
function findRibbon() {
  const groups = new Map(); // container -> anchors
  for (const a of document.querySelectorAll("a[href]")) {
    const path = (a.getAttribute("href") || "").split(/[?#]/)[0];
    if (!RIBBON_PATHS.has(path)) continue;
    for (const container of [a.parentElement, a.parentElement?.parentElement]) {
      if (!container) continue;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(a);
    }
  }
  let best = null;
  for (const [container, anchors] of groups) {
    const unique = new Set(anchors.map((a) => a.getAttribute("href")));
    if (unique.size >= 3 && (!best || unique.size > best.size)) {
      best = { container, anchors, size: unique.size };
    }
  }
  return best;
}

function ensureNavButton() {
  if (document.getElementById("cmh-nav-item")) return true;
  const ribbon = findRibbon();
  if (!ribbon) return false;
  ribbonContainer = ribbon.container;
  if (!boundRibbonContainers.has(ribbon.container)) {
    boundRibbonContainers.add(ribbon.container);
    ribbon.container.addEventListener("click", (event) => {
      const control = event.target.closest?.("a, button");
      if (!control || control.closest("#cmh-nav-item")) return;
      closeOverlay();
    }, true);
  }

  // Clone a non-active ribbon link so the MultiHub item inherits site styles.
  const sample =
    ribbon.anchors.find((a) => (a.getAttribute("href") || "").split(/[?#]/)[0] !== location.pathname) ||
    ribbon.anchors[0];
  // The clonable unit is the container's direct child that holds the sample.
  let unit = sample;
  while (unit.parentElement && unit.parentElement !== ribbon.container) unit = unit.parentElement;

  const clone = unit.cloneNode(true);
  for (const element of [clone, ...clone.querySelectorAll("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("aria-controls");
    element.removeAttribute("aria-describedby");
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("data-")) element.removeAttribute(attribute.name);
    }
  }
  const link = clone.matches("a") ? clone : clone.querySelector("a") || clone;
  clone.id = "cmh-nav-item";
  clone.dataset.cmhControl = "navigation";
  clone.classList.toggle("cmh-active", !overlay.hidden);

  // Replace the label with "MultiHub" and the icon with our glyph.
  const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
  let textNode = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent.trim()) textNode = n;
  }
  if (textNode) textNode.textContent = "MultiHub";
  else link.append("MultiHub");
  const svg = link.querySelector("svg");
  if (svg) {
    const glyph = document.createElement("span");
    glyph.textContent = "🧩";
    glyph.style.lineHeight = "1";
    svg.replaceWith(glyph);
  }
  link.removeAttribute("href");
  link.removeAttribute("data-active");
  link.style.cursor = "pointer";
  clone.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleOverlay(ribbon.container);
  });

  ribbon.container.append(clone);
  return true;
}

// ---------- floating widget (add button + fallback opener) ----------

const widget = document.createElement("div");
widget.id = "cmh-widget";

const openBtn = document.createElement("button");
openBtn.className = "cmh-btn";
openBtn.textContent = "MultiHub";
openBtn.title = "Open your MultiHub for Civitai feed";
openBtn.hidden = true; // only shown if ribbon injection fails
openBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-feed" }));

const addBtn = document.createElement("button");
addBtn.className = "cmh-btn cmh-add";
addBtn.addEventListener("click", onAddClick);

const hubMenu = document.createElement("div");
hubMenu.className = "cmh-menu";
hubMenu.hidden = true;

widget.append(hubMenu, addBtn, openBtn);
document.documentElement.append(widget);

function onAddClick() {
  const source = pageSource();
  if (!source) return;
  if (!hubMenu.hidden) {
    closeHubMenu();
    return;
  }
  clearTimeout(resultTimer);
  addBtn.textContent = `+ Add ${sourceCaption(source)} to MultiHub`;
  chrome.runtime.sendMessage({ type: "get-hubs" }, (res) => {
    if (chrome.runtime.lastError || !res) return showResult("Error — reload the page");
    if (source.type === "model" && source.versionId) {
      showScopeMenu(res.hubs, source);
    } else {
      showHubMenu(res.hubs, {
        type: source.type,
        modelId: source.modelId,
        username: source.username,
        collectionId: source.collectionId,
      });
    }
    hubMenu.hidden = false;
  });
}

function menuTitle(text) {
  const title = document.createElement("div");
  title.className = "cmh-menu-title";
  title.textContent = text;
  return title;
}

function closeHubMenu() {
  hubMenu.hidden = true;
  hubMenu.replaceChildren();
}

function menuHeader(text) {
  const header = document.createElement("div");
  header.className = "cmh-menu-header";
  const close = document.createElement("button");
  close.className = "cmh-menu-close";
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close Add to MultiHub menu");
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeHubMenu();
    updateWidget();
  });
  header.append(menuTitle(text), close);
  return header;
}

function menuItem(text, onClick) {
  const item = document.createElement("button");
  item.className = "cmh-menu-item";
  item.textContent = text;
  item.addEventListener("click", onClick);
  return item;
}

// A model page with a version selected: ask whether to follow the whole model
// or only that version, then ask which hub.
function showScopeMenu(hubs, source) {
  hubMenu.textContent = "";
  hubMenu.append(
    menuHeader("Which versions?"),
    menuItem("All versions", () =>
      showHubMenu(hubs, { type: "model", modelId: source.modelId }, () => showScopeMenu(hubs, source))
    ),
    menuItem("Only the selected version", () =>
      showHubMenu(
        hubs,
        { type: "model", modelId: source.modelId, versionIds: [source.versionId] },
        () => showScopeMenu(hubs, source)
      )
    )
  );
}

function showHubMenu(hubs, source, onBack = null) {
  hubMenu.textContent = "";
  hubMenu.append(menuHeader("Add to which hub?"));
  if (onBack) hubMenu.append(menuItem("← Back", onBack));
  for (const hub of hubs) {
    hubMenu.append(
      menuItem(hub.name, () => {
        closeHubMenu();
        addTo(source, hub.id);
      })
    );
  }
}

function addTo(source, feedId) {
  chrome.runtime.sendMessage({ type: "add-source", feedId, source }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      showResult(`Failed: ${res?.error || chrome.runtime.lastError?.message || "unknown"}`);
    } else if (res.status === "duplicate") {
      showResult(`Already in "${res.feedName}"`);
    } else if (res.status === "merged") {
      showResult(`Updated in "${res.feedName}" ✓`);
    } else {
      showResult(`Added to "${res.feedName}" ✓`);
    }
  });
}

let resultTimer;
function showResult(text) {
  closeHubMenu();
  addBtn.textContent = text;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(updateWidget, 2500);
}

function updateWidget() {
  const source = pageSource();
  closeHubMenu();
  if (source) {
    addBtn.hidden = false;
    addBtn.textContent = `+ Add ${sourceCaption(source)} to MultiHub`;
  } else {
    addBtn.hidden = true;
  }
}

// ---------- signed-in Civitai collection bridge ----------

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const COLLECTION_SORTS = new Set(["Newest", "Oldest", "Most Reactions", "Most Comments"]);
const COLLECTION_PERIODS = new Set(["AllTime", "Year", "Month", "Week", "Day"]);
// Civitai keeps replies in a child thread hanging off the parent comment, so the
// same procedure reads both: `image` for an image's own comments, `comment` for
// the replies to one of them.
const COMMENT_ENTITY_TYPES = new Set(["image", "comment"]);
const COMMENT_LIMIT_MAX = 50;
const COMMENT_LENGTH_MAX = 10000;

function prepareTrpcGet(procedure, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  return {
    procedure: `${procedure}?input=${encoded}`,
    request: {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
  };
}

function normalizeCollectionPageInput(value) {
  const collectionId = positiveId(value?.collectionId);
  const limit = Number(value?.limit);
  const browsingLevel = Number(value?.browsingLevel);
  if (!collectionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !COLLECTION_SORTS.has(value?.sort) || !COLLECTION_PERIODS.has(value?.period) ||
      !Number.isSafeInteger(browsingLevel) || browsingLevel < 1 || browsingLevel > 31) {
    return null;
  }
  const input = {
    collectionId, limit, sort: value.sort, period: value.period, browsingLevel,
    includeBaseModel: value.includeBaseModel === true,
  };
  if (value.cursor !== undefined && value.cursor !== null) {
    const validCursor = (typeof value.cursor === "string" && value.cursor.length <= 1000) ||
      (typeof value.cursor === "number" && Number.isSafeInteger(value.cursor));
    if (!validCursor) return null;
    input.cursor = value.cursor;
  }
  return input;
}

// The browsing level the user picked on this Civitai host, read from their own
// signed-in session so MultiHub shows exactly what the site would show them.
// It is a bitmask over PG=1, PG-13=2, R=4, X=8, XXX=16.
//
// Civitai's own client (CivitaiSessionProvider) builds the effective level from
// two places: `browsingLevel` comes from the NextAuth session, while `showNsfw`
// is preferred from the user.getSettings tRPC cache because that one is patched
// immediately on change and the session lags behind the JWT refresh. Both are
// read here for the same reason, and the raw payloads are returned so the feed
// can decode tRPC's two serializer formats with its existing decoder.
async function readJson(url) {
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, status: response.status, body: await response.json() };
  } catch {
    return { ok: false, code: "network" };
  }
}

async function readBrowsingLevel() {
  const settingsInput = encodeURIComponent(JSON.stringify({ json: null }));
  const [session, settings] = await Promise.all([
    readJson("/api/auth/session"),
    readJson(`/api/trpc/user.getSettings?input=${settingsInput}`),
  ]);
  if (!session.ok && !settings.ok) {
    return { ok: false, status: session.status, code: session.code };
  }
  const user = session.body?.user;
  const level = Number(user?.browsingLevel);
  return {
    ok: true,
    status: 200,
    payload: {
      host: location.hostname,
      signedIn: Boolean(user),
      browsingLevel: Number.isSafeInteger(level) && level > 0 ? level : null,
      sessionShowNsfw: typeof user?.showNsfw === "boolean" ? user.showNsfw : null,
      settingsPayload: settings.ok ? settings.body : null,
    },
  };
}

async function handleAccountRequest(message) {
  let procedure;
  let request;

  if (message.operation === "get-browsing-level") {
    return readBrowsingLevel();
  }

  if (message.operation === "get-image-generation-data") {
    // Prompt, resources and sampler settings for one image. Civitai serves these
    // to the signed-in session on the page, which is why the panel no longer
    // needs an API key to show them.
    const imageId = positiveId(message.imageId);
    if (!imageId) return { ok: false, code: "invalid-request" };
    ({ procedure, request } = prepareTrpcGet("image.getGenerationData", { id: imageId }));
  } else if (message.operation === "get-comments") {
    const entityId = positiveId(message.entityId);
    const entityType = COMMENT_ENTITY_TYPES.has(message.entityType) ? message.entityType : null;
    const limit = Number(message.limit);
    if (!entityId || !entityType ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > COMMENT_LIMIT_MAX) {
      return { ok: false, code: "invalid-request" };
    }
    ({ procedure, request } = prepareTrpcGet("commentv2.getInfinite", {
      entityId, entityType, limit, hidden: false,
    }));
  } else if (message.operation === "post-comment") {
    // The one comment the user typed and asked to post, sent as their own
    // account on the page they are looking at. The content is passed through
    // exactly as typed — Civitai's editor accepts HTML, and its own sanitizer,
    // not this one, decides what survives.
    const entityId = positiveId(message.entityId);
    const entityType = COMMENT_ENTITY_TYPES.has(message.entityType) ? message.entityType : null;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!entityId || !entityType || !content || content.length > COMMENT_LENGTH_MAX) {
      return { ok: false, code: "invalid-request" };
    }
    procedure = "commentv2.upsert";
    request = {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ json: { entityId, entityType, content } }),
    };
  } else if (message.operation === "list-writable-collections") {
    ({ procedure, request } = prepareTrpcGet(
      "collection.getAllUser",
      { permissions: ["ADD", "ADD_REVIEW"] }
    ));
  } else if (message.operation === "get-collection") {
    const collectionId = positiveId(message.collectionId);
    if (!collectionId) return { ok: false, code: "invalid-request" };
    ({ procedure, request } = prepareTrpcGet("collection.getById", { id: collectionId }));
  } else if (message.operation === "get-collection-page") {
    const input = normalizeCollectionPageInput(message.collectionInput);
    if (!input) return { ok: false, code: "invalid-request" };
    ({ procedure, request } = prepareTrpcGet("image.getInfinite", input));
  } else if (message.operation === "add-image-to-collection") {
    procedure = "collection.saveItem";
    const imageId = positiveId(message.imageId);
    const collectionId = positiveId(message.collection?.id);
    const userId = positiveId(message.collection?.userId);
    const read = String(message.collection?.read || "");
    if (!imageId || !collectionId || !userId || !/^[A-Za-z_]{1,32}$/.test(read)) {
      return { ok: false, code: "invalid-request" };
    }
    request = {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        json: {
          type: "Image",
          imageId,
          collections: [{ collectionId, userId, read, tagId: null }],
        },
      }),
    };
  } else {
    return { ok: false, code: "unsupported-operation" };
  }

  try {
    const response = await fetch(`/api/trpc/${procedure}`, request);
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, status: response.status, code: "invalid-response" };
      }
    }
    const trpcStatus = Number(payload?.error?.json?.data?.httpStatus);
    const ok = response.ok && !payload?.error;
    return { ok, status: trpcStatus || response.status, payload };
  } catch {
    return { ok: false, code: "network" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "civitai-account-request" || sender.id !== chrome.runtime.id) {
    return;
  }
  handleAccountRequest(message).then(sendResponse);
  return true;
});

// ---------- SPA navigation observer ----------

let lastHref = location.href;
let scanTimer;

function scanPage() {
  openBtn.hidden = ensureNavButton();
  positionOverlay();
  if (location.href !== lastHref) {
    closeOverlay();
    lastHref = location.href;
    clearTimeout(resultTimer);
    updateWidget();
  }
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanPage, 150);
}

const pageObserver = new MutationObserver((records) => {
  if (!document.getElementById("cmh-nav-item")) {
    scheduleScan();
    return;
  }
  const navRemoved = records.some((record) => [...record.removedNodes].some((node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node.id === "cmh-nav-item" || node.querySelector?.("#cmh-nav-item"))
  ));
  if (navRemoved) scheduleScan();
});
pageObserver.observe(document.documentElement, { childList: true, subtree: true });

for (const method of ["pushState", "replaceState"]) {
  const original = history[method];
  history[method] = function (...args) {
    const result = original.apply(this, args);
    scheduleScan();
    return result;
  };
}
window.addEventListener("popstate", scheduleScan);
window.addEventListener("resize", positionOverlay);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlay.hidden) closeOverlay();
});
updateWidget();
scanPage();
})();
