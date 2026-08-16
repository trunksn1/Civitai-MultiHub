// Injected on civitai.com / civitai.red.
//
// 1. Inserts a "MultiHub" item into civitai's top ribbon (Home, Images,
//    Videos, Models, …) by cloning an existing ribbon link so it inherits the
//    site's own styling. Civitai is a React app, so the ribbon is re-rendered
//    on navigation — a debounced observer re-injects when the item disappears. If
//    the ribbon can't be found (site redesign), a floating button is the fallback.
// 2. On model/LoRA, creator and collection pages, places an "Add to MultiHub"
//    button beside the page's own header actions. It always asks which hub to add to.
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

const pageModelInfoCache = new Map();

function modelKindLabel(type) {
  const normalized = String(type || "").replace(/[\s_-]+/g, "").toLocaleUpperCase();
  if (normalized === "LORA") return "LoRA";
  if (normalized === "TEXTUALINVERSION" || normalized === "EMBEDDING") return "Embedding";
  if (normalized.includes("CHECKPOINT")) return "Checkpoint";
  return "Model";
}

async function loadPageModelInfo(modelId) {
  if (pageModelInfoCache.has(modelId)) return pageModelInfoCache.get(modelId);
  const pending = fetch(`/api/v1/models/${modelId}`).then(async (response) => {
    if (!response.ok) throw new Error(`Model metadata returned HTTP ${response.status}`);
    const data = await response.json();
    return {
      kind: modelKindLabel(data.type),
      versions: (Array.isArray(data.modelVersions) ? data.modelVersions : [])
        .map((version) => ({ id: Number(version.id), name: String(version.name || "").trim() }))
        .filter((version) => Number.isSafeInteger(version.id) && version.id > 0),
    };
  }).catch((error) => {
    pageModelInfoCache.delete(modelId);
    throw error;
  });
  pageModelInfoCache.set(modelId, pending);
  return pending;
}

function selectedPageVersionId(info, source) {
  if (Number.isSafeInteger(source.versionId) && source.versionId > 0) return source.versionId;
  const exactName = new Map(info.versions.map((version) => [version.name.toLocaleLowerCase(), version.id]));
  const candidates = [...document.querySelectorAll('button, a, [role="tab"], [role="button"]')]
    .filter(isVisibleElement).map((element) => {
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      const id = exactName.get(text.toLocaleLowerCase());
      if (!id) return null;
      const href = element.getAttribute("href") || element.closest("a[href]")?.getAttribute("href") || "";
      const hrefVersion = Number(new URL(href || location.href, location.origin).searchParams.get("modelVersionId"));
      const selected = element.getAttribute("aria-selected") === "true"
        || element.getAttribute("aria-current") === "true"
        || element.dataset.active === "true"
        || /(?:^|\s)(?:active|selected)(?:\s|$)/i.test(String(element.className || ""));
      const rgb = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) || [];
      const colorScore = rgb.length === 3 ? Math.max(...rgb) - Math.min(...rgb) : 0;
      return {
        id: Number.isSafeInteger(hrefVersion) && hrefVersion > 0 ? hrefVersion : id,
        score: selected ? 1000 : colorScore,
      };
    }).filter(Boolean);
  const styled = [...candidates].sort((a, b) => b.score - a.score)[0];
  return (styled?.score >= 20 ? styled.id : null)
    || candidates[0]?.id || info.versions[0]?.id || null;
}

function selectedPageVersion(info, source) {
  const id = selectedPageVersionId(info, source);
  const version = info.versions.find((candidate) => candidate.id === id);
  return id ? { id, name: version?.name || `Version ${id}` } : null;
}

async function enrichedPageModelSource(source) {
  if (source.type !== "model") return source;
  const info = await loadPageModelInfo(source.modelId);
  const version = selectedPageVersion(info, source);
  return {
    ...source,
    modelKind: info.kind,
    versionCount: info.versions.length,
    versionId: version?.id || null,
    versionName: version?.name || "",
  };
}

function sourceCaption(source) {
  if (source.type === "model") return `this ${String(source.modelKind || "model").toLocaleLowerCase()}`;
  if (source.type === "collection") return "this collection";
  return `@${source.username}`;
}

function pageActionLabel(source) {
  return source.type === "model"
    ? `Add ${source.modelKind || "Model"} to MultiHub`
    : `+ Add ${sourceCaption(source)} to MultiHub`;
}

function labelPageAction(source) {
  const title = `Add ${sourceCaption(source)} to MultiHub`;
  addBtn.textContent = pageActionLabel(source);
  addBtn.title = title;
  addBtn.setAttribute("aria-label", title);
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

// ---------- page add action + floating fallback opener ----------

const widget = document.createElement("div");
widget.id = "cmh-widget";

const openBtn = document.createElement("button");
openBtn.className = "cmh-btn";
openBtn.type = "button";
openBtn.textContent = "MultiHub";
openBtn.title = "Open your MultiHub for Civitai feed";
openBtn.hidden = true; // only shown if ribbon injection fails
openBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-feed" }));

const addBtn = document.createElement("button");
addBtn.className = "cmh-btn cmh-add";
addBtn.type = "button";
addBtn.addEventListener("click", onAddClick);

const pageAction = document.createElement("div");
pageAction.id = "cmh-page-action";
pageAction.hidden = true;

const hubMenu = document.createElement("div");
hubMenu.className = "cmh-menu cmh-page-menu";
hubMenu.hidden = true;

pageAction.append(hubMenu, addBtn);
widget.append(openBtn);
document.documentElement.append(widget);

async function onAddClick(event) {
  event.preventDefault();
  event.stopPropagation();
  let source = pageSource();
  if (!source) return;
  if (!hubMenu.hidden) {
    closeHubMenu();
    return;
  }
  clearTimeout(resultTimer);
  if (source.type === "model") {
    try {
      source = await enrichedPageModelSource(source);
    } catch {
      // If Civitai's public metadata is unavailable, adding all versions still works.
    }
  }
  labelPageAction(source);
  chrome.runtime.sendMessage({ type: "get-hubs" }, (res) => {
    if (chrome.runtime.lastError || !res) return showResult("Error — reload the page");
    if (source.type === "model" && source.versionId
        && (source.versionCount === undefined || source.versionCount > 1)) {
      showScopeMenu(res.hubs, source);
    } else {
      showHubMenu(res.hubs, {
        type: source.type,
        modelId: source.modelId,
        username: source.username,
        collectionId: source.collectionId,
      });
    }
    openPageHubMenu();
  });
}

function openPageHubMenu() {
  document.documentElement.append(hubMenu);
  hubMenu.hidden = false;
  positionPageHubMenu();
}

function positionPageHubMenu() {
  requestAnimationFrame(() => {
    if (hubMenu.hidden || !hubMenu.isConnected || !addBtn.isConnected) return;
    hubMenu.style.removeProperty("top");
    hubMenu.style.removeProperty("left");
    const anchor = addBtn.getBoundingClientRect();
    const rect = hubMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8));
    const below = anchor.bottom + 8;
    const above = anchor.top - rect.height - 8;
    const top = below + rect.height <= innerHeight - 8 || above < 8 ? below : above;
    hubMenu.style.left = `${Math.round(left)}px`;
    hubMenu.style.top = `${Math.round(Math.max(8, top))}px`;
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
  hubMenu.style.removeProperty("top");
  hubMenu.style.removeProperty("left");
  if (pageAction.isConnected) pageAction.prepend(hubMenu);
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
  item.type = "button";
  item.textContent = text;
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return item;
}

function runtimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError?.message;
      resolve(error ? { ok: false, error } : response || { ok: false, error: "No response" });
    });
  });
}

function sortedHubChoices(hubs) {
  return [...(Array.isArray(hubs) ? hubs : [])].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      sensitivity: "base", numeric: true,
    })
  );
}

function menuDivider(label) {
  const divider = document.createElement("div");
  divider.className = "cmh-menu-divider";
  divider.textContent = label;
  return divider;
}

function renderHubPicker(container, { hubs, source, onBack = null, onSelect, onCreate }) {
  const controls = document.createElement("div");
  controls.className = "cmh-hub-picker-controls";
  if (onBack) {
    const back = menuItem("← Back", onBack);
    back.classList.add("cmh-menu-back");
    controls.append(back);
  }

  const createButton = menuItem("＋ Create a new hub", () => {
    createButton.hidden = true;
    createForm.hidden = false;
    createInput.focus();
  });
  createButton.classList.add("cmh-menu-create");

  const createForm = document.createElement("form");
  createForm.className = "cmh-create-hub-form";
  createForm.hidden = true;
  const createInput = document.createElement("input");
  createInput.type = "text";
  createInput.maxLength = 30;
  createInput.placeholder = "New hub name";
  createInput.setAttribute("aria-label", "New hub name");
  createInput.required = true;
  createInput.addEventListener("input", () => createInput.setCustomValidity(""));
  const createActions = document.createElement("div");
  createActions.className = "cmh-create-hub-actions";
  const createSubmit = document.createElement("button");
  createSubmit.type = "submit";
  createSubmit.textContent = "Create and add";
  const createCancel = document.createElement("button");
  createCancel.type = "button";
  createCancel.textContent = "Cancel";
  createCancel.addEventListener("click", () => {
    createForm.hidden = true;
    createButton.hidden = false;
    createInput.value = "";
    createInput.setCustomValidity("");
  });
  createActions.append(createSubmit, createCancel);
  createForm.append(createInput, createActions);
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = createInput.value.trim();
    if (!name) return createInput.reportValidity();
    createInput.setCustomValidity("");
    createInput.disabled = true;
    createSubmit.disabled = true;
    createSubmit.textContent = "Creating…";
    const response = await onCreate(name, source);
    if (!response?.ok) {
      createInput.disabled = false;
      createSubmit.disabled = false;
      createSubmit.textContent = "Create and add";
      createInput.setCustomValidity(response?.error || "Could not create the hub");
      createInput.reportValidity();
    }
  });
  controls.append(createButton, createForm);

  const search = document.createElement("input");
  search.className = "cmh-hub-search";
  search.type = "search";
  search.placeholder = "Search hubs…";
  search.setAttribute("aria-label", "Search existing hubs");
  const list = document.createElement("div");
  list.className = "cmh-hub-list";
  const ordered = sortedHubChoices(hubs);
  const draw = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = ordered.filter((hub) =>
      String(hub.name || "").toLocaleLowerCase().includes(query)
    );
    list.replaceChildren(...filtered.map((hub) =>
      menuItem(hub.name, () => onSelect(hub, source))
    ));
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cmh-section-note";
      empty.textContent = query ? "No matching hub." : "No existing hub.";
      list.append(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
  container.append(controls, menuDivider("Existing hubs"), search, list);
}

// Multi-version model pages ask whether to follow the whole model or only the
// version currently shown, then ask which hub. Single-version models skip this step.
function showScopeMenu(hubs, source) {
  hubMenu.textContent = "";
  hubMenu.append(
    menuHeader("Which versions?"),
    menuItem("All versions", () =>
      showHubMenu(hubs, { type: "model", modelId: source.modelId }, () => showScopeMenu(hubs, source))
    ),
    menuItem("Only the current version", () =>
      showHubMenu(
        hubs,
        {
          type: "model",
          modelId: source.modelId,
          versionIds: [source.versionId],
          versionNames: { [source.versionId]: source.versionName },
        },
        () => showScopeMenu(hubs, source)
      )
    )
  );
  positionPageHubMenu();
}

function showHubMenu(hubs, source, onBack = null) {
  hubMenu.textContent = "";
  hubMenu.append(menuHeader("Add to which hub?"));
  renderHubPicker(hubMenu, {
    hubs, source, onBack,
    onSelect: (hub) => {
      closeHubMenu();
      addTo(source, hub.id);
    },
    onCreate: async (name) => {
      const response = await runtimeMessage({ type: "create-hub-with-source", name, source });
      if (response?.ok) showAddResult(response);
      return response;
    },
  });
  positionPageHubMenu();
}

function addTo(source, feedId) {
  chrome.runtime.sendMessage({ type: "add-source", feedId, source }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      showResult(`Failed: ${res?.error || chrome.runtime.lastError?.message || "unknown"}`);
    } else {
      showAddResult(res);
    }
  });
}

function showAddResult(res) {
  if (res.status === "duplicate") showResult(`Already in "${res.feedName}"`);
  else if (res.status === "merged") showResult(`Updated in "${res.feedName}" ✓`);
  else showResult(`Added to "${res.feedName}" ✓`);
}

let resultTimer;
function showResult(text) {
  closeHubMenu();
  addBtn.textContent = text;
  clearTimeout(resultTimer);
  resultTimer = setTimeout(updateWidget, 2500);
}

let pageActionHost = null;

function isVisibleElement(element) {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function clearPageActionPlacement() {
  pageActionHost?.classList.remove("cmh-page-action-host", "cmh-model-action-host");
  pageActionHost = null;
  delete pageAction.dataset.cmhPlacement;
  pageAction.remove();
}

function followControls() {
  return [...document.querySelectorAll("button, [role='button']")].filter((element) => {
    if (!isVisibleElement(element) || element.closest("#cmh-page-action")) return false;
    const label = (element.textContent || "").replace(/\s+/g, " ").trim();
    return /^\+?\s*(?:follow|unfollow)$/i.test(label);
  });
}

function findCreatorFollowControl() {
  return followControls().sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.width - aRect.width || aRect.top - bRect.top;
  })[0] || null;
}

function findCollectionFollowControl() {
  const heading = [...document.querySelectorAll("h1")].find(isVisibleElement);
  const headingRect = heading?.getBoundingClientRect();
  return followControls().sort((a, b) => {
    if (!headingRect) return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    const distance = (element) => {
      const rect = element.getBoundingClientRect();
      return Math.abs(rect.top - headingRect.top) + Math.abs(rect.right - headingRect.right) * 0.05;
    };
    return distance(a) - distance(b);
  })[0] || null;
}

function findCollectionActionRow(follow) {
  let candidate = follow.parentElement;
  let best = candidate;
  for (let depth = 0; candidate && depth < 5; depth += 1, candidate = candidate.parentElement) {
    const rect = candidate.getBoundingClientRect();
    if (rect.height > 80 || rect.width > 360) break;
    const controls = [...candidate.querySelectorAll("button, [role='button']")]
      .filter(isVisibleElement);
    if (controls.length >= 2) best = candidate;
  }
  return best;
}

function controlLabel(element) {
  return [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function findModelHeaderActionGroup() {
  const heading = [...document.querySelectorAll("h1")].find(isVisibleElement);
  if (!heading) return null;
  const headingRect = heading.getBoundingClientRect();
  const controls = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter((element) => {
      if (!isVisibleElement(element) || element.closest("#cmh-page-action")) return false;
      const rect = element.getBoundingClientRect();
      const sameHeaderRow = rect.bottom >= headingRect.top - 16
        && rect.top <= headingRect.bottom + 20;
      return sameHeaderRow && rect.left > headingRect.right + 8;
    });
  const info = controls.find((element) => /\b(?:info|information|model details)\b/i.test(controlLabel(element)))
    || controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return !String(element.textContent || "").trim() && element.querySelector("svg")
        && rect.width <= 56 && rect.height <= 56;
    }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
  if (!info) return null;

  let group = info;
  for (let node = info.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 280 || rect.height > 72) break;
    const containedControls = [...node.querySelectorAll('button, a, [role="button"]')]
      .filter(isVisibleElement);
    if (containedControls.length >= 2) group = node;
  }
  return group;
}

function findModelSidebarActionRow() {
  const heading = [...document.querySelectorAll("h1")].find(isVisibleElement);
  if (!heading) return null;
  const headingRect = heading.getBoundingClientRect();
  const candidates = [...document.querySelectorAll("div, section")].map((element) => {
    if (!isVisibleElement(element) || element.closest("#cmh-page-action")) return null;
    const rect = element.getBoundingClientRect();
    if (rect.top < headingRect.bottom + 60 || rect.left < innerWidth * 0.45
        || rect.width < 220 || rect.width > 520 || rect.height < 36 || rect.height > 90) return null;
    const controls = [...element.querySelectorAll('button, a, [role="button"]')]
      .filter(isVisibleElement);
    if (controls.length < 5 || controls.length > 10) return null;
    return { element, rect, controls };
  }).filter(Boolean);
  candidates.sort((a, b) =>
    Math.abs(a.controls.length - 7) - Math.abs(b.controls.length - 7)
      || a.rect.height - b.rect.height || a.rect.top - b.rect.top
  );
  return candidates[0]?.element || null;
}

function placePageAction(source) {
  clearPageActionPlacement();

  if (source.type === "user") {
    const follow = findCreatorFollowControl();
    if (!follow?.parentElement) return false;
    follow.insertAdjacentElement("beforebegin", pageAction);
    pageAction.dataset.cmhPlacement = "creator";
    return true;
  }

  if (source.type === "collection") {
    const follow = findCollectionFollowControl();
    if (!follow) return false;
    pageActionHost = findCollectionActionRow(follow);
    if (!pageActionHost) return false;
    pageActionHost.classList.add("cmh-page-action-host");
    pageActionHost.append(pageAction);
    pageAction.dataset.cmhPlacement = "collection";
    return true;
  }

  if (source.type === "model") {
    const actionRow = findModelSidebarActionRow();
    if (actionRow) {
      pageActionHost = actionRow;
      pageActionHost.classList.add("cmh-model-action-host");
      pageActionHost.append(pageAction);
    } else {
      const actionGroup = findModelHeaderActionGroup();
      if (!actionGroup?.parentElement) return false;
      actionGroup.insertAdjacentElement("beforebegin", pageAction);
    }
    pageAction.dataset.cmhPlacement = "model";
    return true;
  }

  return false;
}

function updateWidget() {
  const source = pageSource();
  closeHubMenu();
  if (source && placePageAction(source)) {
    pageAction.hidden = false;
    labelPageAction(source);
    if (source.type === "model") {
      loadPageModelInfo(source.modelId).then((info) => {
        const current = pageSource();
        if (current?.type === "model" && current.modelId === source.modelId) {
          labelPageAction({ ...source, modelKind: info.kind });
        }
      }).catch(() => {});
    }
  } else {
    clearPageActionPlacement();
    pageAction.hidden = true;
  }
}

// ---------- homepage section add actions ----------

const sectionActionHeadings = new WeakSet();
const sectionActionMenus = new WeakMap();
let openSectionAction = null;

function sectionMenu(action) {
  return sectionActionMenus.get(action);
}

function closeSectionMenu(action = openSectionAction) {
  if (!action) return;
  const menu = sectionMenu(action);
  if (!menu) return;
  menu.hidden = true;
  menu.style.removeProperty("top");
  menu.style.removeProperty("left");
  if (action.isConnected) action.append(menu);
  else menu.remove();
  if (openSectionAction === action) openSectionAction = null;
}

function openSectionMenu(action) {
  if (openSectionAction && openSectionAction !== action) closeSectionMenu(openSectionAction);
  const menu = sectionMenu(action);
  document.documentElement.append(menu);
  menu.hidden = false;
  openSectionAction = action;
  positionSectionMenu(action);
}

function positionSectionMenu(action) {
  const menu = sectionMenu(action);
  const button = action.querySelector(".cmh-section-add");
  if (!menu || menu.hidden || !button?.isConnected) return;
  const anchor = button.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8));
  const below = anchor.bottom + 7;
  const above = anchor.top - rect.height - 7;
  const top = below + rect.height <= innerHeight - 8 || above < 8 ? below : above;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
}

function isHomePage() {
  return location.pathname === "/" || location.pathname === "/home";
}

function sourceFromHref(href, label = "") {
  let url;
  try {
    url = new URL(href, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  let match = url.pathname.match(/^\/collections\/(\d+)/i);
  if (match) return {
    label: label || `Collection #${match[1]}`,
    source: { type: "collection", collectionId: Number(match[1]) },
  };
  match = url.pathname.match(/^\/models\/(\d+)/i);
  if (match) {
    const source = { type: "model", modelId: Number(match[1]) };
    const versionId = Number(url.searchParams.get("modelVersionId"));
    if (Number.isSafeInteger(versionId) && versionId > 0) source.versionIds = [versionId];
    return { label: label || `Model #${match[1]}`, source };
  }
  match = url.pathname.match(/^\/user\/([^/?#]+)/i);
  if (match) {
    const username = decodeURIComponent(match[1]);
    return { label: `@${username}`, source: { type: "user", username } };
  }
  return null;
}

function sectionContainer(heading) {
  let fallback = heading.parentElement;
  for (let node = heading.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
    const imageLinks = node.querySelectorAll('a[href*="/images/"]').length;
    const sourceLinks = node.querySelectorAll(
      'a[href*="/user/"], a[href*="/models/"], a[href*="/collections/"]'
    ).length;
    if (sourceLinks > 0) fallback = node;
    if (imageLinks >= 2 && sourceLinks > 0) return node;
  }
  return fallback;
}

function collectionOptionNearHeading(heading, title) {
  for (let node = heading.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
    const links = [...node.querySelectorAll('a[href*="/collections/"]')];
    const direct = links.map((link) => sourceFromHref(link.href, `Collection: ${title}`)).find(Boolean);
    if (direct) return direct;
    const viewCollection = [...node.querySelectorAll('a[href]')].find((link) =>
      /^view collection$/i.test((link.textContent || "").replace(/\s+/g, " ").trim())
    );
    if (viewCollection) {
      const option = sourceFromHref(viewCollection.href, `Collection: ${title}`);
      if (option) return option;
    }
  }
  return null;
}

function collectionOptionFromPageData(title) {
  const wanted = String(title || "").toLocaleLowerCase();
  if (!wanted) return null;
  const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value) : null;
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    let root;
    try {
      root = JSON.parse(script.textContent || "");
    } catch {
      continue;
    }
    const queue = [root];
    let visited = 0;
    while (queue.length && visited < 100000) {
      const value = queue.pop();
      visited += 1;
      if (!value || typeof value !== "object") continue;
      if (!Array.isArray(value)) {
        const metadataTitle = String(value.metadata?.title || "").toLocaleLowerCase();
        const collectionTitle = String(value.collection?.name || "").toLocaleLowerCase();
        const id = metadataTitle === wanted
          ? positive(value.collection?.id ?? value.metadata?.collection?.id)
          : collectionTitle === wanted
            ? positive(value.collection?.id) : null;
        if (id) return {
          label: `Collection: ${title}`,
          source: { type: "collection", collectionId: id },
        };
      }
      queue.push(...(Array.isArray(value) ? value : Object.values(value)));
    }
  }
  return null;
}

function sectionSourceOptions(heading) {
  const title = heading.dataset.cmhSectionTitle
    || (heading.textContent || "").replace(/\s+/g, " ").trim();
  const container = sectionContainer(heading);
  const options = [];
  const directCollection = collectionOptionNearHeading(heading, title)
    || collectionOptionFromPageData(title) || [
    heading.closest('a[href*="/collections/"]'),
    heading.querySelector('a[href*="/collections/"]'),
    ...container.querySelectorAll('a[href*="/collections/"]'),
  ].filter(Boolean).map((link) => sourceFromHref(link.href, `Collection: ${title}`)).find(Boolean);
  if (directCollection) return [directCollection];

  for (const link of container.querySelectorAll(
    'a[href*="/user/"], a[href*="/models/"], a[href*="/collections/"]'
  )) {
    const text = (link.textContent || "").replace(/\s+/g, " ").trim();
    const option = sourceFromHref(link.href, text);
    if (option) options.push(option);
  }
  const seen = new Set();
  return options.filter(({ source }) => {
    const key = source.type === "user" ? `u:${source.username.toLocaleLowerCase()}`
      : source.type === "model" ? `m:${source.modelId}:${(source.versionIds || []).join(",")}`
        : `c:${source.collectionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function setSectionResult(action, text) {
  const button = action.querySelector(".cmh-section-add");
  button.textContent = text;
  clearTimeout(action._resultTimer);
  action._resultTimer = setTimeout(() => {
    button.textContent = button.dataset.defaultLabel;
  }, 2200);
}

function addSectionSource(action, source, hub) {
  chrome.runtime.sendMessage({ type: "add-source", feedId: hub.id, source }, (res) => {
    closeSectionMenu(action);
    if (chrome.runtime.lastError || !res || !res.ok) {
      setSectionResult(action, "!");
    } else if (res.status === "duplicate") {
      setSectionResult(action, "=");
    } else {
      setSectionResult(action, "✓");
    }
  });
}

async function createSectionHub(action, source, name) {
  const response = await runtimeMessage({ type: "create-hub-with-source", name, source });
  if (!response?.ok) return response;
  closeSectionMenu(action);
  setSectionResult(action, `Added to ${response.feedName} ✓`);
  return response;
}

function renderSectionHubChoices(action, option, options, hubs) {
  const menu = sectionMenu(action);
  menu.replaceChildren(menuTitle(option.label));
  renderHubPicker(menu, {
    hubs,
    source: option.source,
    onBack: options.length > 1
      ? () => renderSectionSourceChoices(action, options, hubs) : null,
    onSelect: (hub) => addSectionSource(action, option.source, hub),
    onCreate: (name) => createSectionHub(action, option.source, name),
  });
  positionSectionMenu(action);
}

function renderSectionSourceChoices(action, options, hubs) {
  const menu = sectionMenu(action);
  menu.replaceChildren(menuTitle("Add which source?"));
  if (options.length === 0) {
    const note = document.createElement("div");
    note.className = "cmh-section-note";
    note.textContent = "No creator, model or collection link is visible in this section yet.";
    menu.append(note);
    return;
  }
  for (const option of options) {
    menu.append(menuItem(option.label, () => renderSectionHubChoices(action, option, options, hubs)));
  }
  positionSectionMenu(action);
}

function createSectionAction(heading) {
  heading.dataset.cmhSectionTitle = (heading.textContent || "").replace(/\s+/g, " ").trim();
  const action = document.createElement("span");
  action.className = "cmh-section-action";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cmh-section-add";
  const featured = /^featured images$/i.test(heading.dataset.cmhSectionTitle);
  button.dataset.defaultLabel = featured
    ? "Add Featured to MultiHub"
    : "Add this collection to MultiHub";
  button.textContent = button.dataset.defaultLabel;
  button.title = featured
    ? "Add a source from the Featured Images collection to MultiHub"
    : "Add this public collection to MultiHub";
  button.setAttribute("aria-label", button.title);
  const menu = document.createElement("div");
  menu.className = "cmh-menu cmh-section-menu";
  menu.hidden = true;
  sectionActionMenus.set(action, menu);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!menu.hidden) {
      closeSectionMenu(action);
      return;
    }
    const loading = document.createElement("div");
    loading.className = "cmh-section-note";
    loading.textContent = "Loading hubs…";
    menu.replaceChildren(loading);
    openSectionMenu(action);
    await new Promise(requestAnimationFrame);
    if (!action.isConnected || openSectionAction !== action) return;
    const options = sectionSourceOptions(heading);
    const res = await runtimeMessage({ type: "get-hubs" });
    if (!action.isConnected || openSectionAction !== action) return;
    if (!res?.hubs) {
      const error = document.createElement("div");
      error.className = "cmh-section-note";
      error.textContent = "Could not load your hubs. Reload this Civitai tab and try again.";
      menu.replaceChildren(error);
      positionSectionMenu(action);
      return;
    }
    if (options.length === 1) renderSectionHubChoices(action, options[0], options, res.hubs);
    else renderSectionSourceChoices(action, options, res.hubs);
    positionSectionMenu(action);
  });
  action.append(button, menu);
  heading.append(action);
  return action;
}

function syncHomepageSectionActions() {
  if (!isHomePage()) return;
  for (const heading of document.querySelectorAll("h1, h2, h3, h4")) {
    if (!isVisibleElement(heading) || sectionActionHeadings.has(heading)) continue;
    const text = (heading.textContent || "").replace(/\s+/g, " ").trim();
    const container = sectionContainer(heading);
    const containerText = (container?.textContent || "").replace(/\s+/g, " ");
    const publicCollection = /curated collection/i.test(containerText)
      && Boolean(container?.querySelector('a[href*="/collections/"]'));
    if (!/^featured images$/i.test(text) && !publicCollection) continue;
    sectionActionHeadings.add(heading);
    createSectionAction(heading);
  }
}

// A Remix badge in MultiHub opens the canonical Civitai image page with this
// one-shot marker. Once Civitai has rendered its native Remix control, activate
// that control and remove the marker so SPA rerenders cannot trigger it twice.
let remixActivationStarted = false;
function activateRequestedRemix() {
  const requested = new URLSearchParams(location.search).get("cmh-remix") === "1";
  if (!requested || remixActivationStarted || !/^\/images\/\d+/.test(location.pathname)) return;
  const control = [...document.querySelectorAll('button, a, [role="button"]')].find((element) => {
    if (!isVisibleElement(element) || element.closest("#cmh-widget, #cmh-page-action, #cmh-overlay")) return false;
    const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`.trim();
    return /^remix\b/i.test(label);
  });
  if (!control) return;
  remixActivationStarted = true;
  const url = new URL(location.href);
  url.searchParams.delete("cmh-remix");
  history.replaceState(history.state, "", url);
  control.click();
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
      { permissions: ["ADD", "ADD_REVIEW"], type: "Image" }
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
    const requestedCollections = Array.isArray(message.collections)
      ? message.collections : [message.collection];
    const collections = requestedCollections.slice(0, 50).map((collection) => ({
      collectionId: positiveId(collection?.id),
      userId: positiveId(collection?.userId),
      read: String(collection?.read || ""),
      tagId: null,
    }));
    if (!imageId || requestedCollections.length === 0 || requestedCollections.length > 50
        || collections.some(({ collectionId, userId, read }) =>
          !collectionId || !userId || !/^[A-Za-z_]{1,32}$/.test(read))) {
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
          collections,
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
    closeSectionMenu();
    closeOverlay();
    lastHref = location.href;
    remixActivationStarted = false;
    clearTimeout(resultTimer);
    updateWidget();
  } else if (pageSource() && !pageAction.isConnected) {
    // React can render the route before its header controls. Retry only while
    // the semantic page anchor is absent, and again if a rerender removes it.
    updateWidget();
  } else if (pageSource()?.type === "model"
      && !pageActionHost?.classList.contains("cmh-model-action-host")
      && findModelSidebarActionRow()) {
    // The right-side action card often arrives after the title. Move the
    // control into that card as soon as its native action row is available.
    updateWidget();
  }
  syncHomepageSectionActions();
  activateRequestedRemix();
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanPage, 150);
}

const pageObserver = new MutationObserver((records) => {
  const addedHeading = records.some((record) => [...record.addedNodes].some((node) =>
    node.nodeType === Node.ELEMENT_NODE
      && (node.matches?.("h1, h2, h3, h4") || node.querySelector?.("h1, h2, h3, h4"))
  ));
  if ((isHomePage() && addedHeading)
      || new URLSearchParams(location.search).get("cmh-remix") === "1") {
    scheduleScan();
  }
  if (pageSource() && !pageAction.isConnected) {
    scheduleScan();
    return;
  }
  const addedControls = records.some((record) => [...record.addedNodes].some((node) =>
    node.nodeType === Node.ELEMENT_NODE
      && (node.matches?.("button, [role='button']") || node.querySelector?.("button, [role='button']"))
  ));
  if (pageSource()?.type === "model" && addedControls
      && !pageActionHost?.classList.contains("cmh-model-action-host")) {
    scheduleScan();
  }
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
window.addEventListener("resize", () => {
  positionOverlay();
  if (!hubMenu.hidden) positionPageHubMenu();
  if (openSectionAction) positionSectionMenu(openSectionAction);
});
window.addEventListener("scroll", () => {
  if (!hubMenu.hidden) positionPageHubMenu();
  if (openSectionAction) positionSectionMenu(openSectionAction);
}, true);
document.addEventListener("click", (event) => {
  if (!hubMenu.hidden && !pageAction.contains(event.target) && !hubMenu.contains(event.target)) {
    closeHubMenu();
  }
  if (!openSectionAction) return;
  const menu = sectionMenu(openSectionAction);
  if (!openSectionAction.contains(event.target) && !menu?.contains(event.target)) closeSectionMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !hubMenu.hidden) closeHubMenu();
  if (event.key === "Escape" && openSectionAction) closeSectionMenu();
  if (event.key === "Escape" && !overlay.hidden) closeOverlay();
});
updateWidget();
scanPage();
})();
