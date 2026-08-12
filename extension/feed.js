import {
  openSourceStreams, fetchStreamPage, resolveModel, thumbnailUrl, setCacheBuster,
  clearModelCache, resolveModelVersion, resolveCreatorProfile, resolveCollection,
  resolveImageGenerationData, resolveImageComments,
  toggleImageReaction,
  resolveWritableCollections, addImageToCollection,
  postComment,
  explainCivitaiError, resetCivitaiCapabilities,
  resolveAccountBrowsingLevels, maskFromLevels, userAvatarUrl, imageBuzzAmount,
  BROWSING_LEVEL_VALUES, BROWSING_LEVEL_LABELS,
} from "./civitai-api.js";
import { beginOptimisticReaction } from "./action-state.js";
import { getComparator, hasFrontier } from "./merge.js";
import {
  loadConfig, saveConfig, activeFeed, makeFeed,
  parseSourceInput, mergeSourceIntoFeed, exportFeed, importFeed,
  MAX_HUBS,
} from "./storage.js";
import {
  ALLOWED_CIVITAI_HOSTS,
  isAllowedCivitaiHost,
} from "./distribution.js";
import {
  generationContentSignals,
  isUnviewedNewImage,
  matchesGenerationFilters,
} from "./content-filters.js";

const BATCH = 30; // images revealed per scroll step
const pageParams = new URLSearchParams(location.search);
const requestedHost = pageParams.get("embedded") === "1" ? pageParams.get("host") : null;
const embeddedHost = isAllowedCivitaiHost(requestedHost)
  ? requestedHost : null;
const BASE_MODEL_LINKS = {
  OpenAI: {
    label: "ChatGPT Images 2.0",
    path: "/models/2563220/chatgpt-images-20?modelVersionId=2880272",
  },
  "Nano Banana": {
    label: "Google's Nano Banana",
    path: "/models/1903424/googles-nano-banana?modelVersionId=2725610",
  },
};

let config;

// Feed state. `runId` cancels in-flight work when the hub changes or the feed
// is refreshed.
let runId = 0;
let streams = [];
let itemMap = new Map(); // image id -> incrementally merged item
let pool = []; // filtered and globally sorted items
let renderedCount = 0;
let renderedIds = new Set();
let loadingRunId = null;
let runController = null;
let sourceLinks = {}; // source label -> site path, for the links under each card
let sourceKinds = {}; // source label -> user | model | collection
let runErrors = []; // failed sources/streams for the current run, always shown
let selectedSourceIds = new Set();
let sourceManageMode = false;
const visitThresholds = new Map();
let previousVisitAt = null;
let viewedIdSet = new Set();
let viewedSaveTimer;
const versionMetadataQueue = [];
let accountBrowsingReason = null; // how the level was established, for the sidebar note
let versionMetadataActive = 0;
const creatorProfileQueue = [];
let creatorProfileActive = 0;
let collectionPickerItem = null;
const pendingReactionActions = new Set();

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

for (const option of [...$("link-domain").options]) {
  if (!ALLOWED_CIVITAI_HOSTS.has(option.value)) option.remove();
}

function queuedModelVersion(versionId) {
  return new Promise((resolve, reject) => {
    versionMetadataQueue.push({ versionId, resolve, reject, signal: runController?.signal });
    pumpVersionMetadata();
  });
}

function pumpVersionMetadata() {
  while (versionMetadataActive < 2 && versionMetadataQueue.length > 0) {
    const job = versionMetadataQueue.shift();
    versionMetadataActive += 1;
    resolveModelVersion(job.versionId, effectiveApiSettings(), job.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        versionMetadataActive -= 1;
        pumpVersionMetadata();
      });
  }
}

function cancelQueuedVersionMetadata() {
  const error = new DOMException("Feed run replaced", "AbortError");
  while (versionMetadataQueue.length > 0) versionMetadataQueue.shift().reject(error);
  while (creatorProfileQueue.length > 0) creatorProfileQueue.shift().reject(error);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function reactionActionId(item, name) {
  return `${item.id}:${name}`;
}

function syncCardReaction(item, name, icon, statKey) {
  const pending = pendingReactionActions.has(reactionActionId(item, name));
  for (const button of grid.querySelectorAll(
    `.card[data-image-id="${item.id}"] button[data-reaction="${name}"]`
  )) {
    button.textContent = `${icon} ${Number(item.stats?.[statKey]) || 0}`;
    button.classList.toggle("active", item._sessionReactions?.has(name));
    button.disabled = pending;
  }
}

function renderErrors() {
  const errors = [...new Set(runErrors)];
  $("error-panel").hidden = errors.length === 0;
  $("error-count").textContent = `${errors.length} source${errors.length === 1 ? "" : "s"} failed`;
  $("error-list").replaceChildren(...errors.map((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    return item;
  }));
}

function feed() {
  return activeFeed(config);
}

function effectiveLinkDomain() {
  return embeddedHost || config.settings.linkDomain;
}

// Which stored browsing selection applies: the embedding Civitai host when the
// panel is embedded, otherwise the standalone tab's own choice.
function browsingScope() {
  return embeddedHost || "standalone";
}

// civitai.com serves only the SFW tier, so levels above PG-13 are not offered
// there. civitai.red serves everything and nothing is withheld from it.
function availableBrowsingLevels() {
  return effectiveLinkDomain() === "civitai.red"
    ? [...BROWSING_LEVEL_VALUES] : BROWSING_LEVEL_VALUES.filter((level) => level <= 2);
}

// The browsing level belongs to Civitai. It is set on the site's own control —
// the eye icon in its header — and this panel mirrors whatever that says. The
// stored selection is only a cache of the last level read from the account, so
// the feed has something to filter on before the first read completes and while
// no signed-in tab is open. MultiHub used to offer its own picker and write the
// level back, which the already-loaded site page never picked up reliably.
function selectedBrowsingLevels() {
  const available = availableBrowsingLevels();
  const stored = config.settings.browsingLevelsByDomain?.[browsingScope()] || [];
  const levels = stored.map(Number).filter((level) => available.includes(level));
  return levels.length > 0 ? levels : available;
}

// The only writer of that cache. Returns whether it actually changed.
async function setBrowsingLevels(levels) {
  const available = availableBrowsingLevels();
  const next = [...new Set(levels.map(Number))]
    .filter((level) => available.includes(level)).sort((a, b) => a - b);
  if (next.length === 0) return false;
  if (maskFromLevels(next) === maskFromLevels(selectedBrowsingLevels())) return false;
  config.settings.browsingLevelsByDomain[browsingScope()] = next;
  await saveConfig(config);
  return true;
}

// Read the level from Civitai and adopt it. Nothing else decides it, so there is
// no conflict to resolve: a read that succeeds wins, and one that fails leaves
// the last known level in place. Returns whether the feed's levels changed,
// which is what decides a refetch.
async function syncBrowsingLevelsFromCivitai() {
  let result;
  try {
    result = await resolveAccountBrowsingLevels(effectiveApiSettings());
  } catch {
    result = { levels: null, reason: "unreachable" };
  }
  accountBrowsingReason = result.reason;
  if (!result.levels) return false;
  return setBrowsingLevels(result.levels);
}

// A level changed on Civitai has to reach an already-open panel, so the setting
// is re-read on a timer and whenever the tab is looked at again. The request is
// a same-origin read inside the Civitai tab, so polling it is cheap; it pauses
// entirely while the tab is in the background.
const BROWSING_LEVEL_POLL_MS = 5000;
let browsingLevelPollTimer = null;

// Embedded, this page is an iframe whose document stays "visible" while the
// overlay is collapsed, because Page Visibility tracks the tab and not CSS. A
// zero-height body is the reliable signal that the panel is not on screen.
function panelOnScreen() {
  return !document.hidden && document.body.getBoundingClientRect().height > 0;
}

async function refreshBrowsingLevels({ force = false } = {}) {
  if (!force && !panelOnScreen()) return;
  const changed = await syncBrowsingLevelsFromCivitai();
  renderBrowsingLevelNote();
  if (changed) startFeed();
}

function watchCivitaiBrowsingLevel() {
  const stop = () => {
    clearInterval(browsingLevelPollTimer);
    browsingLevelPollTimer = null;
  };
  const start = () => {
    if (browsingLevelPollTimer) return;
    browsingLevelPollTimer = setInterval(refreshBrowsingLevels, BROWSING_LEVEL_POLL_MS);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return stop();
    start();
    refreshBrowsingLevels();
  });
  window.addEventListener("focus", () => refreshBrowsingLevels());
  // The embedding page announces the panel opening so a level changed while it
  // was collapsed is applied immediately rather than on the next tick.
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "cmh-panel-shown") return;
    refreshBrowsingLevels({ force: true });
  });
  if (!document.hidden) start();
}

function effectiveApiSettings() {
  // linkDomain doubles as the API host: mature media exists only on civitai.red.
  return {
    ...config.settings,
    linkDomain: effectiveLinkDomain(),
    browsingLevel: maskFromLevels(selectedBrowsingLevels()),
  };
}

function sourceLabel(source) {
  if (source.alias) return source.alias;
  if (source.type === "user") return `@${source.username}`;
  if (source.type === "collection") return source.label || `Collection #${source.collectionId}`;
  return source.label || `Model #${source.modelId}`;
}

function originalSourceLabel(source) {
  if (source.type === "user") return `@${source.username}`;
  if (source.type === "collection") return source.label || `Collection #${source.collectionId}`;
  return source.label || `Model #${source.modelId}`;
}

function sourceGroup(source) {
  if (source.type === "user") return "Users";
  if (source.type === "collection") return "Collections";
  const label = (source.label || "").toLocaleLowerCase();
  if (label.includes("lora")) return "LoRAs";
  if (label.includes("embedding") || label.includes("textual")) return "Embeddings";
  if (label.includes("checkpoint")) return "Checkpoints";
  return "Models";
}

function queuedCreatorProfile(username) {
  return new Promise((resolve, reject) => {
    creatorProfileQueue.push({ username, resolve, reject, signal: runController?.signal });
    pumpCreatorProfiles();
  });
}

function pumpCreatorProfiles() {
  while (creatorProfileActive < 3 && creatorProfileQueue.length > 0) {
    const job = creatorProfileQueue.shift();
    creatorProfileActive += 1;
    resolveCreatorProfile(job.username, effectiveApiSettings(), job.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        creatorProfileActive -= 1;
        pumpCreatorProfiles();
      });
  }
}

function modelDraftFromPath(path, label = "") {
  const match = String(path || "").match(/\/models\/(\d+)/i);
  if (!match) return null;
  const draft = { type: "model", modelId: Number(match[1]) };
  if (label) draft.label = label;
  const versionMatch = String(path).match(/[?&]modelVersionId=(\d+)/i);
  if (versionMatch) draft.versionIds = [Number(versionMatch[1])];
  return draft;
}

function collectionDraftFromPath(path, label = "") {
  const match = String(path || "").match(/\/collections\/(\d+)/i);
  if (!match) return null;
  return { type: "collection", collectionId: Number(match[1]), ...(label ? { label } : {}) };
}

function sourceDraftKey(draft) {
  if (draft.type === "user") return `user:${draft.username.toLocaleLowerCase()}`;
  if (draft.type === "collection") return `collection:${draft.collectionId}`;
  return `model:${draft.modelId}:${(draft.versionIds || []).join(",")}`;
}

function uniqueSourceOptions(options) {
  const seen = new Set();
  return options.filter(({ draft }) => {
    if (!draft) return false;
    const key = sourceDraftKey(draft);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function itemSourceOptions(item) {
  const options = [];
  if (item.username) {
    options.push({
      label: `@${item.username}`,
      draft: { type: "user", username: item.username },
    });
  }
  for (const label of item._sources || []) {
    const path = sourceLinks[label] || "";
    const draft = sourceKinds[label] === "model"
      ? modelDraftFromPath(path, label)
      : sourceKinds[label] === "collection" ? collectionDraftFromPath(path, label) : null;
    if (draft) options.push({ label, draft });
  }
  for (const resource of item._generationResources || []) {
    if (!Number.isSafeInteger(Number(resource?.modelId))) continue;
    const label = resource.modelName || resource.name || `Model #${resource.modelId}`;
    options.push({
      label,
      draft: { type: "model", modelId: Number(resource.modelId), label },
    });
  }
  const unresolved = [...new Set(item.modelVersionIds || [])]
    .filter((versionId) => Number.isSafeInteger(Number(versionId)) && Number(versionId) > 0)
    .slice(0, 10);
  const resolved = await Promise.allSettled(unresolved.map((versionId) => queuedModelVersion(versionId)));
  for (const result of resolved) {
    if (result.status !== "fulfilled" || !result.value?.modelId) continue;
    const label = result.value.name || `Model #${result.value.modelId}`;
    options.push({
      label,
      draft: { type: "model", modelId: Number(result.value.modelId), label },
    });
  }
  return uniqueSourceOptions(options).slice(0, 12);
}

const sourceHoverMenu = document.createElement("div");
sourceHoverMenu.className = "source-hover-menu";
sourceHoverMenu.hidden = true;
sourceHoverMenu.setAttribute("role", "menu");
document.body.append(sourceHoverMenu);
let sourceHoverTarget = null;
let sourceHoverCloseTimer = null;
let sourceHoverRequest = 0;

function closeSourceHoverMenu() {
  clearTimeout(sourceHoverCloseTimer);
  sourceHoverMenu.hidden = true;
  sourceHoverMenu.replaceChildren();
  sourceHoverTarget = null;
  sourceHoverRequest += 1;
}

function scheduleSourceHoverClose() {
  clearTimeout(sourceHoverCloseTimer);
  sourceHoverCloseTimer = setTimeout(closeSourceHoverMenu, 220);
}

function positionSourceHoverMenu(target) {
  const rect = target.getBoundingClientRect();
  sourceHoverMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`;
  sourceHoverMenu.style.top = `${Math.min(innerHeight - 12, rect.bottom + 5)}px`;
  requestAnimationFrame(() => {
    if (sourceHoverMenu.hidden) return;
    const menuRect = sourceHoverMenu.getBoundingClientRect();
    if (menuRect.bottom > innerHeight - 8) {
      sourceHoverMenu.style.top = `${Math.max(8, rect.top - menuRect.height - 5)}px`;
    }
  });
}

async function addSourceFromHover(draft, hub) {
  const result = mergeSourceIntoFeed(hub, draft);
  await saveConfig(config);
  renderHubs();
  if (hub.id === feed().id) renderSources();
  const message = result.status === "duplicate"
    ? `${sourceLabel(draft)} is already in “${hub.name}”.`
    : result.status === "merged"
      ? `${sourceLabel(draft)} was updated in “${hub.name}”.`
      : `${sourceLabel(draft)} was added to “${hub.name}”.`;
  setStatus(message);
  closeSourceHoverMenu();
  if (hub.id === feed().id && result.status !== "duplicate") startFeed();
}

function sortedHubs() {
  return [...config.feeds].sort((a, b) => a.name.localeCompare(b.name, undefined, {
    sensitivity: "base", numeric: true,
  }));
}

function sourceHoverDivider(text) {
  const divider = document.createElement("div");
  divider.className = "source-hover-divider";
  divider.textContent = text;
  return divider;
}

function renderSourceHubChoices(draft, label, options, target) {
  sourceHoverMenu.replaceChildren();
  const header = document.createElement("div");
  header.className = "source-hover-header";
  if (options.length > 1) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "‹";
    back.title = "Choose another source";
    back.addEventListener("click", () => renderSourceChoices(options, target));
    header.append(back);
  }
  const title = document.createElement("strong");
  title.textContent = label;
  header.append(title);
  sourceHoverMenu.append(header);

  const create = document.createElement("button");
  create.type = "button";
  create.className = "source-hover-item source-hover-create";
  create.textContent = "＋ Create a new hub";
  const createForm = document.createElement("form");
  createForm.className = "source-hover-create-form";
  createForm.hidden = true;
  const createInput = document.createElement("input");
  createInput.type = "text";
  createInput.maxLength = 80;
  createInput.required = true;
  createInput.placeholder = "New hub name";
  createInput.addEventListener("input", () => createInput.setCustomValidity(""));
  const createSubmit = document.createElement("button");
  createSubmit.type = "submit";
  createSubmit.textContent = "Create and add";
  createForm.append(createInput, createSubmit);
  create.addEventListener("click", () => {
    create.hidden = true;
    createForm.hidden = false;
    createInput.focus();
  });
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (config.feeds.length >= MAX_HUBS) {
      createInput.setCustomValidity(`MultiHub supports at most ${MAX_HUBS} hubs`);
      return createInput.reportValidity();
    }
    try {
      const hub = makeFeed(createInput.value);
      config.feeds.push(hub);
      createInput.disabled = true;
      createSubmit.disabled = true;
      try {
        await addSourceFromHover(draft, hub);
      } catch (error) {
        config.feeds = config.feeds.filter((candidate) => candidate.id !== hub.id);
        throw error;
      }
    } catch (error) {
      createInput.disabled = false;
      createSubmit.disabled = false;
      createInput.setCustomValidity(error.message || "Could not create the hub");
      createInput.reportValidity();
    }
  });
  sourceHoverMenu.append(create, createForm, sourceHoverDivider("Existing hubs"));

  const search = document.createElement("input");
  search.className = "source-hover-search";
  search.type = "search";
  search.placeholder = "Search hubs…";
  search.setAttribute("aria-label", "Search existing hubs");
  const list = document.createElement("div");
  list.className = "source-hover-hub-list";
  const hubs = sortedHubs();
  const draw = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = hubs.filter((hub) => hub.name.toLocaleLowerCase().includes(query));
    list.replaceChildren(...visible.map((hub) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "source-hover-item";
      button.textContent = `＋ ${hub.name}`;
      button.addEventListener("click", () => addSourceFromHover(draft, hub));
      return button;
    }));
    if (visible.length === 0) {
      const empty = document.createElement("span");
      empty.className = "source-hover-empty";
      empty.textContent = "No matching hub.";
      list.append(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
  sourceHoverMenu.append(search, list);
}

function renderSourceChoices(options, target) {
  sourceHoverMenu.replaceChildren();
  const title = document.createElement("strong");
  title.className = "source-hover-title";
  title.textContent = "Add which source?";
  sourceHoverMenu.append(title);
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "source-hover-item";
    button.textContent = option.label;
    button.addEventListener("click", () =>
      renderSourceHubChoices(option.draft, option.label, options, target)
    );
    sourceHoverMenu.append(button);
  }
}

async function showSourceHoverMenu(target, optionLoader) {
  clearTimeout(sourceHoverCloseTimer);
  const request = ++sourceHoverRequest;
  sourceHoverTarget = target;
  sourceHoverMenu.hidden = false;
  sourceHoverMenu.textContent = "Loading sources…";
  positionSourceHoverMenu(target);
  const loaded = typeof optionLoader === "function" ? await optionLoader() : optionLoader;
  if (request !== sourceHoverRequest || sourceHoverTarget !== target) return;
  const options = uniqueSourceOptions(Array.isArray(loaded) ? loaded : []);
  if (options.length === 0) {
    sourceHoverMenu.textContent = "No addable source found.";
  } else if (options.length === 1) {
    renderSourceHubChoices(options[0].draft, options[0].label, options, target);
  } else {
    renderSourceChoices(options, target);
  }
  positionSourceHoverMenu(target);
}

function installSourceHoverMenu(target, optionLoader) {
  if (!target || !optionLoader) return;
  target.classList.add("source-hover-target");
  target.setAttribute("aria-haspopup", "menu");
  target.addEventListener("pointerenter", () => showSourceHoverMenu(target, optionLoader));
  target.addEventListener("pointerleave", scheduleSourceHoverClose);
  target.addEventListener("focus", () => showSourceHoverMenu(target, optionLoader));
  target.addEventListener("blur", scheduleSourceHoverClose);
}

sourceHoverMenu.addEventListener("pointerenter", () => clearTimeout(sourceHoverCloseTimer));
sourceHoverMenu.addEventListener("pointerleave", scheduleSourceHoverClose);
document.addEventListener("pointerdown", (event) => {
  if (!sourceHoverMenu.hidden && !sourceHoverMenu.contains(event.target)
      && event.target !== sourceHoverTarget) closeSourceHoverMenu();
});

// ---------- sidebar rendering ----------

function renderHubs() {
  const select = $("hub-select");
  select.textContent = "";
  for (const f of config.feeds) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = `${f.name} (${f.sources.length})`;
    select.append(opt);
  }
  select.value = config.activeFeedId;
}

function renderSources() {
  const list = $("source-list");
  list.textContent = "";
  $("sources-count").textContent = `(${feed().sources.length})`;
  const order = ["Users", "Collections", "Checkpoints", "LoRAs", "Embeddings", "Models"];
  const sources = [...feed().sources].sort((a, b) => {
    const groupOrder = order.indexOf(sourceGroup(a)) - order.indexOf(sourceGroup(b));
    return groupOrder || sourceLabel(a).localeCompare(sourceLabel(b), undefined, { sensitivity: "base" });
  });
  let currentGroup = null;
  for (const source of sources) {
    const group = sourceGroup(source);
    if (group !== currentGroup) {
      currentGroup = group;
      const heading = document.createElement("li");
      heading.className = "source-group";
      heading.textContent = group;
      list.append(heading);
    }
    const li = document.createElement("li");
    if (source.enabled === false) li.classList.add("disabled");

    const selected = document.createElement("input");
    selected.type = "checkbox";
    selected.className = "select-source";
    selected.hidden = !sourceManageMode;
    selected.checked = selectedSourceIds.has(source.id);
    selected.title = "Select for bulk actions";
    selected.addEventListener("change", () => {
      if (selected.checked) selectedSourceIds.add(source.id);
      else selectedSourceIds.delete(source.id);
      updateBulkControls();
    });

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "toggle-source";
    enabled.checked = source.enabled !== false;
    enabled.title = enabled.checked ? "Disable without deleting" : "Enable source";
    enabled.setAttribute("aria-label", `${enabled.checked ? "Disable" : "Enable"} ${sourceLabel(source)}`);
    enabled.addEventListener("change", async () => {
      source.enabled = enabled.checked;
      await saveConfig(config);
      renderSources();
      startFeed();
    });

    const text = document.createElement("div");
    text.className = "source-text";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = sourceLabel(source);
    label.title = source.alias
      ? `${source.alias} (original: ${originalSourceLabel(source)})`
      : label.textContent;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = source.type === "user"
      ? "user"
      : source.type === "collection"
        ? "public image collection"
        : source.versionIds?.length
          ? `${source.versionIds.length} version${source.versionIds.length > 1 ? "s" : ""}`
          : "all versions";

    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.title = source.type === "model"
      ? "Alias, model versions, move or copy"
      : "Alias, move or copy";
    edit.addEventListener("click", () => editSource(source));

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove "${sourceLabel(source)}" from this hub?`)) return;
      feed().sources = feed().sources.filter((s) => s.id !== source.id);
      await saveConfig(config);
      renderHubs();
      renderSources();
      startFeed();
    });

    text.append(label, meta);
    li.append(selected, enabled, text, edit, remove);
    list.append(li);
  }
  $("source-bulk").hidden = !sourceManageMode;
  $("source-manage").textContent = sourceManageMode ? "Done managing" : "Manage sources";
  updateBulkControls();
}

function updateBulkControls() {
  const hasSelection = selectedSourceIds.size > 0;
  for (const id of ["bulk-enable", "bulk-disable", "bulk-copy", "bulk-move", "bulk-remove", "bulk-deselect-all"]) {
    $(id).disabled = !hasSelection;
  }
  $("bulk-select-all").disabled = feed().sources.length === 0
    || selectedSourceIds.size === feed().sources.length;
}

function chooseDestination(action) {
  const choices = config.feeds.filter((f) => f.id !== feed().id);
  if (choices.length === 0) {
    alert("Create another hub first.");
    return null;
  }
  const answer = prompt(
    `${action} to which hub?\n${choices.map((f, i) => `${i + 1}. ${f.name}`).join("\n")}`,
    "1"
  );
  const index = Number(answer) - 1;
  return Number.isInteger(index) ? choices[index] || null : null;
}

function copySourceTo(source, destination) {
  const { id, ...draft } = source;
  return mergeSourceIntoFeed(destination, draft);
}

let editingSourceId = null;

async function editSource(source) {
  editingSourceId = source.id;
  $("source-editor-title").textContent = `Edit ${sourceLabel(source)}`;
  $("source-editor-original").textContent = `Original: ${originalSourceLabel(source)}`;
  $("source-editor-alias").value = source.alias || "";
  $("source-editor-error").hidden = true;
  const destinations = config.feeds.filter((hub) => hub.id !== feed().id);
  $("source-editor-destination").replaceChildren(...destinations.map((hub) => {
    const option = document.createElement("option");
    option.value = hub.id;
    option.textContent = hub.name;
    return option;
  }));
  $("source-editor-transfer").value = "none";
  $("source-editor-destination-label").hidden = true;
  $("source-editor-versions").hidden = source.type !== "model";
  $("source-editor-version-list").textContent = "";
  if (source.type === "model") {
    try {
      const model = await resolveModel(source.modelId, config.settings);
      $("source-editor-version-mode").value = source.versionIds?.length ? "selected" : "all";
      $("source-editor-version-list").hidden = !source.versionIds?.length;
      const selected = new Set(source.versionIds || []);
      for (const version of model.versions) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = version.id;
        checkbox.checked = selected.has(version.id);
        label.append(checkbox, `${version.name} (${version.id})`);
        $("source-editor-version-list").append(label);
      }
    } catch (error) {
      $("source-editor-error").textContent = `Could not load versions: ${error.message}`;
      $("source-editor-error").hidden = false;
    }
  }
  $("source-editor-overlay").hidden = false;
  $("source-editor-alias").focus();
}

function closeSourceEditor() {
  $("source-editor-overlay").hidden = true;
  editingSourceId = null;
}

// ---------- masonry grid ----------

const grid = $("grid");
let masonry, sentinel, emptyEl;
let columns = [];
let columnHeights = [];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const mediaObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (reduceMotion.matches || !feed().autoplayVideos || !entry.isIntersecting) entry.target.pause();
    else entry.target.play().catch(() => {});
  }
}, { root: grid, rootMargin: "300px" });
function saveViewedHistorySoon() {
  feed().viewedIds = [...viewedIdSet].slice(-3000);
  viewedIdSet = new Set(feed().viewedIds);
  clearTimeout(viewedSaveTimer);
  viewedSaveTimer = setTimeout(() => saveConfig(config), 350);
}

function markCardViewed(card) {
  const id = Number(card?.dataset.imageId);
  if (!id) return;
  if (!viewedIdSet.has(id)) {
    viewedIdSet.add(id);
    saveViewedHistorySoon();
  }
  card.classList.remove("is-new");
  card.querySelector(".new-badge")?.remove();
  viewedObserver.unobserve(card);
}

const viewedObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.dataset.viewExposed = "true";
      continue;
    }
    if (entry.target.dataset.viewExposed === "true") markCardViewed(entry.target);
  }
}, { root: grid, threshold: 0 });

function columnCount() {
  return Math.max(1, Math.floor(grid.clientWidth / (feed().density === "compact" ? 260 : 340)));
}

function setupGrid() {
  if (sentinel) observer.unobserve(sentinel);
  mediaObserver.disconnect();
  viewedObserver.disconnect();
  grid.textContent = "";
  emptyEl = document.createElement("p");
  emptyEl.className = "empty";
  emptyEl.hidden = true;

  masonry = document.createElement("div");
  masonry.className = "masonry";
  columns = Array.from({ length: columnCount() }, () => {
    const col = document.createElement("div");
    col.className = "col";
    masonry.append(col);
    return col;
  });
  columnHeights = columns.map(() => 0);

  sentinel = document.createElement("div");
  sentinel.className = "sentinel";
  observer.observe(sentinel);

  grid.append(emptyEl, masonry, sentinel);
}

function showSkeletons() {
  for (const column of columns) {
    for (let i = 0; i < 2; i += 1) {
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton-card";
      column.append(skeleton);
    }
  }
}

const CARD_SIGNAL_ICONS = {
  remix: '<path d="M4 20c3.5 0 5-1.5 5-5l8-8 3 3-8 8c-3.5 0-5 2-8 2Z"/><path d="m15 5 4 4"/>',
  prompt: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  resources: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="m10 10 4 4"/>',
};

function makeCardInfoBadge(kind, label, href = "", shortLabel = label) {
  const badge = document.createElement(href ? "a" : "span");
  badge.className = `card-info-badge ${kind}`;
  badge.title = label;
  badge.setAttribute("aria-label", label);
  if (href) {
    badge.href = href;
    badge.target = "_blank";
    badge.rel = "noopener";
  }
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = CARD_SIGNAL_ICONS[kind];
  const text = document.createElement("span");
  text.textContent = shortLabel;
  badge.append(icon, text);
  return badge;
}

function remixUrl(item) {
  return `https://${effectiveLinkDomain()}/images/${item.id}?cmh-remix=1`;
}

function makeCardInfoSignals(item) {
  const { hasPrompt, hasResources } = generationContentSignals(item);
  const row = document.createElement("div");
  row.className = "card-info-signals";
  const canRemix = ["image", "video", "audio"].includes(item.type || "image")
    && (typeof item.hasPositivePrompt === "boolean" ? item.hasPositivePrompt : hasPrompt);
  if (canRemix) row.append(makeCardInfoBadge("remix", "Remix", remixUrl(item)));
  if (hasPrompt) row.append(makeCardInfoBadge("prompt", "Prompt published", "", "P"));
  if (hasResources) row.append(makeCardInfoBadge("resources", "Resources published", "", "R"));
  return row.childElementCount > 0 ? row : null;
}

function syncCardInfoSignals(item) {
  for (const card of grid.querySelectorAll(`.card[data-image-id="${item.id}"]`)) {
    const info = card.querySelector(".info");
    if (!info) continue;
    const current = info.querySelector(".card-info-signals");
    const replacement = makeCardInfoSignals(item);
    if (current && replacement) current.replaceWith(replacement);
    else if (current) current.remove();
    else if (replacement) info.querySelector(".stats")?.before(replacement);
  }
}

function makeBuzzBadge(item) {
  const amount = imageBuzzAmount(item);
  const badge = document.createElement("a");
  badge.className = "buzz-badge";
  badge.href = `https://${effectiveLinkDomain()}/images/${item.id}`;
  badge.target = "_blank";
  badge.rel = "noopener";
  badge.textContent = `⚡ ${amount.toLocaleString("en-US")}`;
  badge.title = `${amount.toLocaleString("en-US")} Buzz donated · open on Civitai to donate`;
  badge.setAttribute("aria-label", badge.title);
  return badge;
}

function creatorAvatar(item) {
  const avatar = document.createElement("span");
  avatar.className = "creator-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const level = Number(item.user?.profilePicture?.nsfwLevel) || 0;
  const allowed = level === 0 || (maskFromLevels(selectedBrowsingLevels()) & level) === level;
  const url = allowed ? userAvatarUrl(item.user, 64) : null;
  const fallback = () => {
    avatar.replaceChildren((item.username || "?").slice(0, 1).toLocaleUpperCase());
  };
  const showImage = (source) => {
    if (!source) return false;
    const image = document.createElement("img");
    image.src = source;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", fallback, { once: true });
    avatar.replaceChildren(image);
    return true;
  };
  if (!showImage(url)) {
    fallback();
    if (item.username) {
      queuedCreatorProfile(item.username).then((user) => {
        if (!avatar.isConnected || !user) return;
        item.user = { ...(item.user || {}), ...user };
        const profileLevel = Number(item.user?.profilePicture?.nsfwLevel) || 0;
        const profileAllowed = profileLevel === 0
          || (maskFromLevels(selectedBrowsingLevels()) & profileLevel) === profileLevel;
        if (profileAllowed) showImage(userAvatarUrl(item.user, 64));
      }).catch(() => {});
    }
  }
  return avatar;
}

function createCardModelAttribution(item, modelSources, domain) {
  const checkpointSource = modelSources.find((label) =>
    label.toLocaleLowerCase().includes("checkpoint")
  );
  const versionIds = checkpointSource
    ? [] : [...new Set(item.modelVersionIds || [])].slice(0, 10);
  const labels = checkpointSource
    ? [checkpointSource] : (versionIds.length ? ["model"] : (item.baseModel ? [item.baseModel] : []));
  if (labels.length === 0) return null;

  const container = document.createElement("span");
  container.className = "made-with";
  labels.forEach((label, index) => {
    if (index > 0) container.append(" + ");
    const fallback = versionIds.length === 0 ? BASE_MODEL_LINKS[label] : null;
    const sourcePath = sourceLinks[label] || fallback?.path;
    if (!sourcePath) {
      container.append(fallback?.label || label);
      return;
    }
    const modelLabel = fallback?.label || label;
    const modelLink = document.createElement("a");
    modelLink.textContent = modelLabel;
    modelLink.href = `https://${domain}${sourcePath}`;
    modelLink.target = "_blank";
    modelLink.rel = "noopener";
    if (fallback) modelLink.title = `Mapped from Civitai baseModel: ${label}`;
    const draft = modelDraftFromPath(sourcePath, modelLabel);
    if (draft) installSourceHoverMenu(modelLink, [{ label: modelLabel, draft }]);
    container.append(modelLink);
  });

  if (versionIds.length > 0) {
    Promise.allSettled(versionIds.map((versionId) =>
      queuedModelVersion(versionId).then((version) => ({ versionId, version }))
    )).then((results) => {
      if (!container.isConnected) return;
      const resources = results.filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      const selected = resources.find(({ version }) =>
        String(version.type || "").toLocaleLowerCase() === "checkpoint"
      ) || resources.find(({ version }) => {
        const type = String(version.type || "").toLocaleLowerCase();
        return !type.includes("lora") && !type.includes("embedding") && !type.includes("textual");
      }) || resources[0];
      if (!selected?.version.modelId) return;
      const { versionId, version } = selected;
      const modelLink = document.createElement("a");
      modelLink.textContent = version.name;
      modelLink.href = `https://${domain}/models/${version.modelId}?modelVersionId=${versionId}`;
      modelLink.target = "_blank";
      modelLink.rel = "noopener";
      modelLink.title = version.versionName && version.versionName !== version.name
        ? `Version: ${version.versionName}` : version.name;
      installSourceHoverMenu(modelLink, [{
        label: version.name,
        draft: { type: "model", modelId: Number(version.modelId), label: version.name },
      }]);
      container.replaceChildren(modelLink);
    }).catch(() => {});
  }
  return container;
}

function makeCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.imageId = item.id;
  if (isUnviewedNewImage(item, previousVisitAt, viewedIdSet)) {
    card.classList.add("is-new");
  }

  const link = document.createElement("a");
  link.href = `https://${effectiveLinkDomain()}/images/${item.id}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openLightbox(item.id);
    markCardViewed(card);
  });
  if (card.classList.contains("is-new")) {
    const badge = document.createElement("span");
    badge.className = "new-badge";
    badge.textContent = "NEW";
    link.append(badge);
  }
  if (item._groupItems?.length > 1) {
    const count = document.createElement("span");
    count.className = "post-count-badge";
    count.textContent = `${item._groupItems.length} images`;
    link.append(count);
  }

  // The images API also returns videos (type: "video").
  let media;
  let videoPlay;
  if (item.type === "video") {
    media = document.createElement("video");
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
    media.preload = "metadata";
    media.setAttribute("aria-label", `Video by ${item.username || "unknown creator"}`);
    mediaObserver.observe(media);
    videoPlay = document.createElement("span");
    videoPlay.className = "video-play";
    videoPlay.textContent = "▶";
    videoPlay.role = "button";
    videoPlay.tabIndex = 0;
    videoPlay.setAttribute("aria-label", "Play video");
    const toggleVideo = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (media.paused) media.play().catch(() => {});
      else media.pause();
    };
    videoPlay.addEventListener("click", toggleVideo);
    videoPlay.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") toggleVideo(event);
    });
    media.addEventListener("play", () => {
      videoPlay.textContent = "❚❚";
      videoPlay.setAttribute("aria-label", "Pause video");
    });
    media.addEventListener("pause", () => {
      videoPlay.textContent = "▶";
      videoPlay.setAttribute("aria-label", "Play video");
    });
  } else {
    media = document.createElement("img");
    media.loading = "lazy";
    media.alt = `Image by ${item.username || "unknown creator"}`;
  }
  media.src = thumbnailUrl(item.url);
  if (item.width > 0 && item.height > 0) {
    media.style.aspectRatio = `${item.width} / ${item.height}`;
  }
  link.append(media);
  if (videoPlay) link.append(videoPlay);

  const cardActions = document.createElement("div");
  cardActions.className = "card-actions";
  const reactionDefs = [["Like", "👍", "likeCount"], ["Heart", "❤", "heartCount"],
    ["Laugh", "😂", "laughCount"], ["Cry", "😢", "cryCount"]];
  if (!(item._sessionReactions instanceof Set)) item._sessionReactions = new Set();
  for (const [name, icon, key] of reactionDefs) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.reaction = name;
    button.classList.toggle("active", item._sessionReactions.has(name));
    button.textContent = `${icon} ${Number(item.stats?.[key]) || 0}`;
    button.addEventListener("click", async () => {
      if (!config.settings.apiKey) return window.open(link.href, "_blank", "noopener");
      const actionId = reactionActionId(item, name);
      if (pendingReactionActions.has(actionId)) return;
      pendingReactionActions.add(actionId);
      const optimistic = beginOptimisticReaction(item, name, key);
      let actionMessage = `Sending ${name.toLocaleLowerCase()} reaction…`;
      syncCardReaction(item, name, icon, key);
      if (Number($("lightbox").dataset.imageId) === item.id && !$("lightbox").hidden) {
        renderLightboxReactions(item, link.href);
        $("lightbox-action-status").textContent = `Sending ${name.toLocaleLowerCase()} reaction…`;
      }
      try {
        await toggleImageReaction(item.id, name, effectiveApiSettings(), runController?.signal);
        optimistic.commit();
        actionMessage = optimistic.removing ? `${name} removed.` : `${name} added.`;
        setStatus(actionMessage);
      } catch (error) {
        optimistic.rollback();
        actionMessage = explainCivitaiError(error, {
          action: "Reaction", scope: "SocialWrite access", mutation: true,
        });
        setStatus(actionMessage);
      } finally {
        pendingReactionActions.delete(actionId);
        syncCardReaction(item, name, icon, key);
        if (Number($("lightbox").dataset.imageId) === item.id && !$("lightbox").hidden) {
          renderLightboxReactions(item, link.href);
          $("lightbox-action-status").textContent = actionMessage;
        }
      }
    });
    cardActions.append(button);
  }
  cardActions.append(makeBuzzBadge(item));
  const collect = document.createElement("button");
  collect.type = "button"; collect.className = "collect"; collect.textContent = "＋"; collect.title = "Add to collection";
  collect.addEventListener("click", () => openCollectionPicker(item));
  cardActions.append(collect);

  const info = document.createElement("div");
  info.className = "info";
  const infoSignals = makeCardInfoSignals(item);
  const domain = effectiveLinkDomain();

  const sourcesDiv = document.createElement("div");
  sourcesDiv.className = "sources";
  const modelSources = item._sources.filter((label) => sourceKinds[label] === "model");
  const displayedSources = item._sources.filter((label) => sourceKinds[label] !== "user");
  displayedSources.forEach((label, i) => {
    if (i > 0) sourcesDiv.append(" + ");
    const a = document.createElement("a");
    a.textContent = label;
    const sourcePath = sourceLinks[label] || "/";
    a.href = `https://${domain}${sourcePath}`;
    a.target = "_blank";
    a.rel = "noopener";
    const draft = sourceKinds[label] === "model"
      ? modelDraftFromPath(sourcePath, label)
      : sourceKinds[label] === "collection" ? collectionDraftFromPath(sourcePath, label) : null;
    if (draft) installSourceHoverMenu(a, [{ label, draft }]);
    sourcesDiv.append(a);
  });

  const byline = document.createElement("div");
  byline.className = "creator-line";
  const userLink = document.createElement("a");
  userLink.className = "user";
  userLink.textContent = item.username || "?";
  if (item.username) {
    userLink.href = `https://${domain}/user/${encodeURIComponent(item.username)}`;
    userLink.target = "_blank";
    userLink.rel = "noopener";
    installSourceHoverMenu(userLink, [{
      label: `@${item.username}`,
      draft: { type: "user", username: item.username },
    }]);
  }
  byline.append(creatorAvatar(item), "by ", userLink);
  const modelAttribution = createCardModelAttribution(item, modelSources, domain);
  if (modelAttribution) byline.append(" with ", modelAttribution);

  const s = item.stats || {};
  const reactions = (s.likeCount || 0) + (s.heartCount || 0) + (s.laughCount || 0) + (s.cryCount || 0);
  const stats = document.createElement("div");
  stats.className = "stats";
  stats.textContent = `❤ ${reactions} · 💬 ${s.commentCount || 0}`;

  if (item.username) {
    const hideCreator = document.createElement("button");
    hideCreator.className = "hide-creator";
    hideCreator.textContent = "Hide creator";
    hideCreator.title = `Hide @${item.username} in every hub`;
    hideCreator.addEventListener("click", async () => {
      if (!confirm(`Hide all work by @${item.username} in all hubs?`)) return;
      config.settings.hiddenCreators = [...new Set([
        ...config.settings.hiddenCreators, item.username.toLocaleLowerCase(),
      ])].slice(0, 200);
      await saveConfig(config);
      renderHiddenCreators();
      syncFeedControls();
      applyLocalFilters();
    });
    stats.append(" · ", hideCreator);
  }

  if (displayedSources.length > 0) info.append(sourcesDiv);
  info.append(byline);
  if (infoSignals) info.append(infoSignals);
  info.append(stats);
  card.append(link, cardActions, info);
  viewedObserver.observe(card);
  return card;
}

function lightboxItem() {
  return lightboxSequence().find((item) => item.id === Number($("lightbox").dataset.imageId));
}

function lightboxSequence() {
  return pool.flatMap((item) => item._groupItems?.length ? item._groupItems : [item]);
}

function appendLightboxMeta(label, value) {
  if (value === null || value === undefined || value === "") return;
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = String(value);
  $("lightbox-meta").append(term, detail);
}

function renderLightboxTitle(item) {
  $("lightbox-title").textContent = "";
  if (!item.username) {
    $("lightbox-title").textContent = "Image details";
    return;
  }
  const author = document.createElement("a");
  author.textContent = `@${item.username}`;
  author.href = `https://${effectiveLinkDomain()}/user/${encodeURIComponent(item.username)}`;
  author.target = "_blank";
  author.rel = "noopener";
  author.title = `Open @${item.username}'s Civitai profile`;
  installSourceHoverMenu(author, [{
    label: `@${item.username}`,
    draft: { type: "user", username: item.username },
  }]);
  $("lightbox-title").append(author);
}

function renderLightboxReactions(item, imageUrl) {
  const stats = item.stats || {};
  const reactions = [
    ["Like", "👍", "likeCount"], ["Heart", "❤", "heartCount"],
    ["Laugh", "😂", "laughCount"], ["Cry", "😢", "cryCount"],
  ];
  $("lightbox-reactions").textContent = "";
  $("lightbox-action-status").textContent = "";
  if (!config.settings.apiKey) {
    const link = document.createElement("a");
    link.href = imageUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = reactions.filter(([, , key]) => Number(stats[key]) > 0)
      .map(([, icon, key]) => `${icon} ${stats[key]}`).join("   ") || "React on Civitai ↗";
    link.title = "Open on Civitai to react";
    $("lightbox-reactions").append(link);
    return;
  }
  if (!(item._sessionReactions instanceof Set)) item._sessionReactions = new Set();
  for (const [name, icon, key] of reactions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.reaction = name;
    button.classList.toggle("active", item._sessionReactions.has(name));
    button.textContent = `${icon} ${Number(stats[key]) || 0}`;
    button.title = `${name} · click to toggle this reaction`;
    button.disabled = pendingReactionActions.has(reactionActionId(item, name));
    button.addEventListener("click", async () => {
      const actionId = reactionActionId(item, name);
      if (pendingReactionActions.has(actionId)) return;
      pendingReactionActions.add(actionId);
      const optimistic = beginOptimisticReaction(item, name, key);
      renderLightboxReactions(item, imageUrl);
      for (const control of $("lightbox-reactions").querySelectorAll("button")) control.disabled = true;
      $("lightbox-action-status").textContent = `Sending ${name.toLocaleLowerCase()} reaction…`;
      try {
        await toggleImageReaction(item.id, name, effectiveApiSettings(), runController?.signal);
        optimistic.commit();
      } catch (error) {
        optimistic.rollback();
        $("lightbox-action-status").textContent = explainCivitaiError(error, {
          action: "Reaction", scope: "SocialWrite access", mutation: true,
        });
      } finally {
        pendingReactionActions.delete(actionId);
        syncCardReaction(item, name, icon, key);
        const message = $("lightbox-action-status").textContent;
        renderLightboxReactions(item, imageUrl);
        $("lightbox-action-status").textContent = message || (optimistic.removing
          ? `${name} removed.` : `${name} added.`);
      }
    });
    $("lightbox-reactions").append(button);
  }
}

async function openCollectionPicker(item) {
  collectionPickerItem = item;
  $("collection-picker-overlay").hidden = false;
  $("collection-picker-list").textContent = "";
  // Account actions use the signed-in Civitai tab; an API key is only a fallback.
  $("collection-picker-status").textContent = "Loading collections…";
  try {
    const collections = await resolveWritableCollections(effectiveApiSettings(), runController?.signal);
    $("collection-picker-status").textContent = collections.length ? "" : "No writable collections were returned.";
    for (const collection of collections) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = collection.name;
      button.addEventListener("click", async () => {
        button.disabled = true;
        $("collection-picker-status").textContent = `Adding to ${collection.name}…`;
        try {
          await addImageToCollection(collectionPickerItem.id, collection, effectiveApiSettings(), runController?.signal);
          collectionPickerItem._collected = true;
          $("collection-picker-status").textContent = `Added to ${collection.name}.`;
        } catch (error) {
          $("collection-picker-status").textContent = explainCivitaiError(error, {
            action: "Adding the image to the collection",
            scope: "CollectionsWrite access",
            mutation: true,
          });
        }
        button.disabled = false;
      });
      $("collection-picker-list").append(button);
    }
  } catch (error) {
    $("collection-picker-status").textContent = explainCivitaiError(error, {
      action: "Collections", scope: "CollectionsRead access",
    });
  }
}

function renderLightboxResources(resources) {
  $("lightbox-resources").textContent = "";
  $("lightbox-resources-section").hidden = resources.length === 0;
  const typePriority = (resource) => {
    const type = String(resource.modelType || "").toLocaleLowerCase();
    if (type.includes("checkpoint")) return 0;
    if (type.includes("lora")) return 1;
    if (type.includes("embedding") || type.includes("textualinversion")) return 2;
    return 3;
  };
  const ordered = [...resources].sort((a, b) => typePriority(a) - typePriority(b));
  for (const resource of ordered) {
    const versionId = resource.versionId || resource.modelVersionId;
    const item = document.createElement("li");
    const main = document.createElement("div");
    main.className = "lightbox-resource-main";
    const name = document.createElement(resource.modelId ? "a" : "span");
    name.textContent = resource.modelName || resource.name || `Model version ${versionId || "?"}`;
    if (resource.modelId) {
      name.href = `https://${effectiveLinkDomain()}/models/${resource.modelId}`
        + (versionId ? `?modelVersionId=${versionId}` : "");
      name.target = "_blank";
      name.rel = "noopener";
      installSourceHoverMenu(name, [{
        label: name.textContent,
        draft: {
          type: "model", modelId: Number(resource.modelId), label: name.textContent,
        },
      }]);
    } else if (versionId) {
      queuedModelVersion(versionId).then((version) => {
        if (!name.isConnected || !version?.modelId) return;
        const link = document.createElement("a");
        link.textContent = name.textContent;
        link.href = `https://${effectiveLinkDomain()}/models/${version.modelId}?modelVersionId=${versionId}`;
        link.target = "_blank";
        link.rel = "noopener";
        installSourceHoverMenu(link, [{
          label: version.name || name.textContent,
          draft: {
            type: "model", modelId: Number(version.modelId), label: version.name || name.textContent,
          },
        }]);
        name.replaceWith(link);
      }).catch(() => {});
    }
    const details = document.createElement("span");
    details.className = "lightbox-resource-meta";
    details.textContent = [resource.versionName, resource.modelType]
      .filter(Boolean).join(" · ");
    main.append(name);
    if (details.textContent) main.append(details);
    item.append(main);
    const isLora = String(resource.modelType || "").toLocaleLowerCase().includes("lora");
    if (isLora && resource.strength !== null && resource.strength !== undefined) {
      const strength = document.createElement("span");
      strength.className = "lightbox-resource-strength";
      strength.textContent = resource.strength;
      strength.title = `LoRA strength ${resource.strength}`;
      item.append(strength);
    }
    $("lightbox-resources").append(item);
  }
}

// Comment bodies arrive as Civitai's editor HTML. None of it is ever assigned as
// markup: the source is parsed into an inert document and a new tree is built
// from an allowlist, so a comment cannot script this extension page. Anything not
// on the list contributes its text and nothing else.
const COMMENT_BLOCK_TAGS = new Set(["P", "DIV", "BLOCKQUOTE", "LI", "PRE", "H1", "H2", "H3", "H4"]);
const COMMENT_INLINE_TAGS = new Set(["STRONG", "B", "EM", "I", "U", "S", "CODE", "SPAN"]);

function commentMentionLink(node) {
  const label = String(node.getAttribute("data-label") || node.textContent || "").replace(/^@/, "");
  if (!label) return null;
  const link = document.createElement("a");
  link.className = "comment-mention";
  link.textContent = `@${label}`;
  link.href = `https://${effectiveLinkDomain()}/user/${encodeURIComponent(label)}`;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

function appendCommentNodes(target, source) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.textContent);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.tagName === "BR") {
      target.append(document.createElement("br"));
      continue;
    }
    if (node.dataset?.type === "mention") {
      const mention = commentMentionLink(node);
      if (mention) target.append(mention);
      else appendCommentNodes(target, node);
      continue;
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener nofollow";
        appendCommentNodes(link, node);
        target.append(link);
        continue;
      }
      appendCommentNodes(target, node);
      continue;
    }
    if (node.tagName === "UL" || node.tagName === "OL") {
      const list = document.createElement(node.tagName.toLowerCase());
      appendCommentNodes(list, node);
      target.append(list);
      continue;
    }
    if (COMMENT_BLOCK_TAGS.has(node.tagName) || COMMENT_INLINE_TAGS.has(node.tagName)) {
      const element = document.createElement(
        COMMENT_BLOCK_TAGS.has(node.tagName)
          ? (node.tagName === "LI" ? "li" : "p")
          : node.tagName.toLowerCase()
      );
      appendCommentNodes(element, node);
      target.append(element);
      continue;
    }
    // Every other container contributes its contents and nothing else — an
    // <img>, <iframe> or <script> leaves only whatever text it wrapped.
    appendCommentNodes(target, node);
  }
}

function commentBody(html) {
  const body = document.createElement("div");
  body.className = "comment-body";
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  appendCommentNodes(body, parsed.body);
  if (!body.textContent.trim()) body.textContent = "(empty comment)";
  return body;
}

// A profile picture is shown only when its own maturity rating is within the
// levels the account is browsing at, the way the site withholds one.
function commentAvatar(user) {
  const level = Number(user?.profilePicture?.nsfwLevel) || 0;
  const allowed = level === 0 || (maskFromLevels(selectedBrowsingLevels()) & level) === level;
  const url = allowed ? userAvatarUrl(user, 96) : null;
  const username = user?.username || "Civitai user";
  if (url) {
    const image = document.createElement("img");
    image.className = "comment-avatar";
    image.src = url;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = "comment-avatar comment-avatar-initial";
  fallback.textContent = username.slice(0, 1).toLocaleUpperCase();
  fallback.setAttribute("aria-hidden", "true");
  return fallback;
}

// Civitai's editor stores a comment as HTML, and a mention as a span carrying the
// mentioned account's id — which is what turns a reply into a notification rather
// than a name in text. Typed text is escaped into paragraphs; the mention is the
// only markup this builds, from a numeric id and the username in the payload.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function commentHtml(text, mention = null) {
  const userId = Number(mention?.userId);
  const name = mention?.username ? escapeHtml(mention.username) : "";
  // Without a usable account id the span would not resolve to anyone, so the
  // reply is addressed in plain text instead of with a mention that notifies
  // nobody.
  const opening = !name ? ""
    : Number.isSafeInteger(userId) && userId > 0
      ? `<span data-type="mention" data-id="mention:${userId}" data-label="${name}">@${name}</span> `
      : `@${name} `;
  const paragraphs = String(text).trim().split(/\n{2,}/).map((block) =>
    escapeHtml(block).replaceAll("\n", "<br />")
  );
  return paragraphs.map((block, index) =>
    `<p>${index === 0 ? opening : ""}${block}</p>`).join("");
}

// Which comment has its reply box open, kept outside the render so it survives
// the redraw that follows every post.
let commentReplyTarget = null; // { rootId, commentId, username, userId }

function commentReplyForm(item, comment, rootId) {
  const form = document.createElement("form");
  form.className = "comment-reply-form";
  const input = document.createElement("textarea");
  input.rows = 2;
  input.maxLength = 10000;
  input.required = true;
  input.placeholder = `Reply to @${comment.user?.username || "this comment"}…`;
  const actions = document.createElement("div");
  actions.className = "comment-reply-actions";
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Reply";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    commentReplyTarget = null;
    renderLightboxComments(item, `https://${effectiveLinkDomain()}/images/${item.id}`);
  });
  const status = document.createElement("p");
  status.className = "comment-reply-status";
  actions.append(send, cancel);
  form.append(input, actions, status);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    status.textContent = "Posting reply…";
    // A reply always joins the thread of the top-level comment; replying to a
    // reply mentions its author, which is how the site addresses one person
    // inside a shared thread.
    const mention = comment.id === rootId
      ? null : { userId: comment.user?.id, username: comment.user?.username };
    try {
      const saved = await postComment(
        "comment", rootId, commentHtml(text, mention), effectiveApiSettings(), runController?.signal
      );
      const root = (item._comments || []).find((candidate) => candidate.id === rootId);
      if (root) {
        if (!Array.isArray(root.replies)) root.replies = [];
        root.replies.push({
          content: commentHtml(text, mention),
          createdAt: new Date().toISOString(),
          user: { username: "You" },
          ...(saved && typeof saved === "object" ? saved : {}),
        });
      }
      if (item.stats) item.stats.commentCount = (Number(item.stats.commentCount) || 0) + 1;
      commentReplyTarget = null;
      renderLightboxComments(item, `https://${effectiveLinkDomain()}/images/${item.id}`);
    } catch (error) {
      status.textContent = explainCivitaiError(error, {
        action: "Posting the reply", scope: "SocialWrite access", mutation: true,
      });
      send.disabled = false;
    }
  });
  return form;
}

function commentEntry(item, comment, { reply = false, rootId = null } = {}) {
  const row = document.createElement("li");
  row.className = reply ? "lightbox-comment reply" : "lightbox-comment";
  const profileUsername = typeof comment.user?.username === "string"
    ? comment.user.username.trim() : "";
  const username = profileUsername || "Civitai user";
  const thread = rootId ?? comment.id;

  const head = document.createElement("div");
  head.className = "comment-head";
  const author = document.createElement(profileUsername ? "a" : "span");
  author.className = "comment-author";
  author.textContent = `@${username}`;
  if (profileUsername) {
    author.href = `https://${effectiveLinkDomain()}/user/${encodeURIComponent(profileUsername)}`;
    author.target = "_blank";
    author.rel = "noopener";
    author.title = `Add @${profileUsername} to a hub or open the Civitai profile`;
    installSourceHoverMenu(author, [{
      label: `@${profileUsername}`,
      draft: { type: "user", username: profileUsername },
    }]);
  }
  const meta = document.createElement("span");
  meta.className = "lightbox-comment-meta";
  meta.textContent = comment.createdAt ? new Date(comment.createdAt).toLocaleString() : "";
  head.append(commentAvatar(comment.user), author, meta);
  const reactions = Number(comment.reactionCount) || 0;
  if (reactions > 0) {
    const badge = document.createElement("span");
    badge.className = "comment-reactions";
    badge.textContent = `♥ ${reactions}`;
    badge.title = `${reactions} reaction${reactions === 1 ? "" : "s"} on Civitai`;
    head.append(badge);
  }

  if (canPostComment() && Number.isSafeInteger(Number(thread))) {
    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.className = "comment-reply-toggle";
    replyButton.textContent = "Reply";
    replyButton.title = `Reply to @${username} on Civitai`;
    replyButton.addEventListener("click", () => {
      commentReplyTarget = commentReplyTarget?.commentId === comment.id
        ? null : { rootId: thread, commentId: comment.id };
      renderLightboxComments(item, `https://${effectiveLinkDomain()}/images/${item.id}`);
    });
    head.append(replyButton);
  }

  row.append(head, commentBody(comment.content));
  if (commentReplyTarget?.commentId === comment.id) {
    row.append(commentReplyForm(item, comment, thread));
  }

  const replies = Array.isArray(comment.replies) ? comment.replies : [];
  if (replies.length > 0) {
    const list = document.createElement("ul");
    list.className = "comment-replies";
    for (const child of replies) {
      list.append(commentEntry(item, child, { reply: true, rootId: thread }));
    }
    row.append(list);
  }
  return row;
}

// Posting rides on the signed-in Civitai tab, so the form is offered whenever
// there is a session to post as. The browsing-level read already establishes
// that: it only reports a level for an account that is signed in on this host.
// An API key still stands in for a standalone tab with no Civitai page open.
function canPostComment() {
  return Boolean(config.settings.apiKey)
    || ["inherited", "nsfw-disabled"].includes(accountBrowsingReason);
}

function renderLightboxComments(item, imageUrl) {
  const known = Number(item.stats?.commentCount);
  const count = Number.isFinite(known) ? known : null;
  // A count the feed reports as exactly zero is trusted, so opening an image
  // without comments costs no request.
  if (count === 0) item._commentsAttempted = true;
  // The section is always present. It used to be hidden whenever the feed's own
  // comment count was zero, which is what made it look as though images had no
  // comment section at all.
  $("lightbox-comments-section").hidden = false;
  const canPost = canPostComment();
  $("lightbox-comment-form").hidden = !canPost;

  const comments = Array.isArray(item._comments) ? item._comments : [];
  const shown = comments.reduce(
    (total, comment) => total + 1 + (Array.isArray(comment.replies) ? comment.replies.length : 0), 0
  );
  $("lightbox-comments-title").textContent = count ? `Comments (${count})` : "Comments";
  $("lightbox-comments").replaceChildren(...comments.map((comment) => commentEntry(item, comment)));

  $("lightbox-comments-status").hidden = false;
  if (item._commentsError) {
    $("lightbox-comments-status").textContent = item._commentsError;
  } else if (shown > 0) {
    // Nothing to say about a thread that is fully shown: the note only earns its
    // space when part of the discussion is missing.
    const truncated = Boolean(count && count > shown);
    $("lightbox-comments-status").hidden = !truncated;
    $("lightbox-comments-status").textContent = truncated
      ? `Showing ${shown} of ${count} — the rest is on Civitai.` : "";
  } else if (item._commentsAttempted) {
    $("lightbox-comments-status").textContent = count
      ? "Comments could not be returned for this image."
      : canPost ? "No comments yet — leave the first one." : "No comments yet.";
  } else {
    $("lightbox-comments-status").textContent = "Loading comments from Civitai…";
  }

  // Read through the signed-in Civitai tab, so no API key is needed to see what
  // the site itself would show.
  if (!item._commentsAttempted) {
    item._commentsAttempted = true;
    const redraw = () => {
      if (Number($("lightbox").dataset.imageId) !== item.id || $("lightbox").hidden) return;
      renderLightboxComments(item, imageUrl);
    };
    resolveImageComments(item.id, effectiveApiSettings(), runController?.signal).then((data) => {
      item._comments = Array.isArray(data?.comments) ? data.comments : [];
      redraw();
    }).catch((error) => {
      item._comments = [];
      item._commentsError = explainCivitaiError(error, {
        action: "Loading the comments", scope: "MediaRead access",
      });
      redraw();
    });
  }
}

function openLightbox(imageId) {
  const sequence = lightboxSequence();
  const item = sequence.find((candidate) => candidate.id === imageId);
  if (!item) return;
  // A reply box belongs to the image it was opened on.
  if (Number($("lightbox").dataset.imageId) !== item.id) commentReplyTarget = null;
  $("lightbox").dataset.imageId = item.id;
  $("lightbox-media").textContent = "";
  const media = document.createElement(item.type === "video" ? "video" : "img");
  media.src = item.url;
  media.title = "Open this image on Civitai";
  if (item.type !== "video") media.addEventListener("click", () => window.open(
    `https://${config.settings.linkDomain}/images/${item.id}`, "_blank", "noopener"
  ));
  if (item.type === "video") {
    media.controls = true;
    media.autoplay = true;
    media.loop = true;
  }
  const sourceButton = document.createElement("button");
  sourceButton.type = "button";
  sourceButton.className = "preview-source-button";
  sourceButton.textContent = "＋ Sources";
  sourceButton.title = "Add this image's creator, models or collection to a hub";
  installSourceHoverMenu(sourceButton, () => itemSourceOptions(item));
  $("lightbox-media").append(media, sourceButton);
  const imageUrl = `https://${effectiveLinkDomain()}/images/${item.id}`;
  renderLightboxTitle(item);
  $("lightbox-byline").textContent = `Posted ${new Date(item.createdAt).toLocaleString()}`;
  renderLightboxReactions(item, imageUrl);
  const buzzAmount = imageBuzzAmount(item);
  $("lightbox-buzz").textContent = `⚡ ${buzzAmount.toLocaleString("en-US")}`;
  $("lightbox-buzz").href = imageUrl;
  $("lightbox-buzz").title = `${buzzAmount.toLocaleString("en-US")} Buzz donated · open on Civitai to donate`;
  $("lightbox-buzz").setAttribute("aria-label", $("lightbox-buzz").title);
  $("lightbox-collect").onclick = () => openCollectionPicker(item);
  const meta = item._generationMeta && typeof item._generationMeta === "object"
    ? item._generationMeta : (item.meta && typeof item.meta === "object" ? item.meta : {});
  const generationResources = Array.isArray(item._generationResources) ? item._generationResources : [];
  renderLightboxResources(generationResources);
  const prompt = meta.prompt || "";
  const negative = meta.negativePrompt || meta.negative_prompt || "";
  $("lightbox-prompt-section").hidden = !prompt;
  $("lightbox-prompt").textContent = prompt;
  $("lightbox-negative-section").hidden = !negative;
  $("lightbox-negative").textContent = negative;
  const ignored = new Set([
    "prompt", "negativePrompt", "negative_prompt", "resources", "additionalResources",
    "civitaiResources",
  ]);
  const entries = Object.entries(meta).filter(([key, value]) =>
    !ignored.has(key) && value !== null && value !== undefined && value !== ""
      && typeof value !== "object"
  ).slice(0, 18);
  const hasGenerationData = Boolean(prompt || negative || entries.length > 0 || generationResources.length > 0);
  $("lightbox-generation-note").hidden = hasGenerationData;
  $("lightbox-generation-note").textContent = hasGenerationData ? "" : item._generationAttempted
    ? "Civitai did not return prompt, resources or generation parameters for this image."
    : "Loading generation details from Civitai…";
  $("lightbox-meta").textContent = "";
  for (const [key, value] of entries) {
    appendLightboxMeta(key, value);
  }
  $("lightbox-meta-section").hidden = entries.length === 0;
  renderLightboxComments(item, imageUrl);
  $("lightbox-open").href = imageUrl;
  const index = sequence.indexOf(item);
  $("lightbox-prev").disabled = index <= 0;
  $("lightbox-next").disabled = index < 0 || index >= sequence.length - 1;
  $("lightbox").hidden = false;
  $("lightbox-close").focus();
  // The v1 feed drops these for most images; the signed-in session on the open
  // Civitai tab returns them, so this no longer waits on an API key.
  if (!item._generationAttempted) {
    item._generationAttempted = true;
    resolveImageGenerationData(item.id, effectiveApiSettings(), runController?.signal)
      .then((data) => {
        item._generationMeta = data?.meta || null;
        item._generationResources = Array.isArray(data?.resources) ? data.resources : [];
        item.modelVersionIds = [...new Set([
          ...(item.modelVersionIds || []),
          ...item._generationResources.map((resource) =>
            Number(resource?.modelVersionId || resource?.versionId)
          ).filter((id) => Number.isSafeInteger(id) && id > 0),
        ])];
        syncCardInfoSignals(item);
        if (Number($("lightbox").dataset.imageId) === item.id && !$("lightbox").hidden) openLightbox(item.id);
      })
      .catch((error) => {
        if (Number($("lightbox").dataset.imageId) !== item.id || $("lightbox").hidden) return;
        $("lightbox-generation-note").hidden = false;
        $("lightbox-generation-note").textContent = explainCivitaiError(error, {
          action: "Generation details", scope: "MediaRead access",
        });
      });
  }
}

function closeLightbox() {
  $("lightbox").hidden = true;
  $("lightbox-media").textContent = "";
}

function moveLightbox(direction) {
  const sequence = lightboxSequence();
  const item = lightboxItem();
  const index = item ? sequence.indexOf(item) : -1;
  const next = sequence[index + direction];
  if (next) openLightbox(next.id);
}

function appendCards(items, reusableCards = new Map()) {
  for (const item of items) {
    if (renderedIds.has(item.id)) continue;
    renderedIds.add(item.id);
    const shortest = Math.max(0, columnHeights.indexOf(Math.min(...columnHeights)));
    columns[shortest].append(reusableCards.get(item.id) || makeCard(item));
    // Estimate card height by aspect ratio so columns stay balanced. Items
    // with missing dimensions count as square — a NaN here would poison
    // Math.min and crash rendering.
    const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : 1;
    columnHeights[shortest] += ratio + 0.2;
  }
}

function visibleCardAnchors() {
  const gridTop = grid.getBoundingClientRect().top;
  return [...grid.querySelectorAll(".card[data-image-id]")]
    .map((card) => ({ id: Number(card.dataset.imageId), offset: card.getBoundingClientRect().top - gridTop }))
    .filter((anchor) => anchor.offset >= -40)
    .sort((a, b) => a.offset - b.offset);
}

function rebuildRendered({ preserveAnchor = false } = {}) {
  const scrollTop = grid.scrollTop;
  const anchors = preserveAnchor ? visibleCardAnchors() : [];
  const reusableCards = new Map([...grid.querySelectorAll(".card[data-image-id]")]
    .map((card) => [Number(card.dataset.imageId), card]));
  const items = pool.slice(0, renderedCount);
  const itemIds = new Set(items.map((item) => item.id));
  const anchor = anchors.find((candidate) => itemIds.has(candidate.id));
  renderedIds = new Set();
  setupGrid();
  appendCards(items, reusableCards);
  renderedIds = new Set(items.map((i) => i.id));
  renderedCount = items.length;
  if (!anchor) {
    grid.scrollTop = scrollTop;
    return;
  }
  const replacement = grid.querySelector(`.card[data-image-id="${anchor.id}"]`);
  // Emptying the grid clamps scrollTop to 0, so without a restore here a lost
  // anchor drops the reader back to the top of the feed.
  if (!replacement) {
    grid.scrollTop = scrollTop;
    return;
  }
  const gridTop = grid.getBoundingClientRect().top;
  grid.scrollTop += replacement.getBoundingClientRect().top - gridTop - anchor.offset;
}

// ---------- infinite loading ----------

function activeStreams() {
  return streams.filter((s) => s.nextUrl);
}

// The REST feed reports an exact numeric browsingLevel; the legacy nsfwLevel
// string is only a coarse fallback (its "X" covers both X and XXX). When neither
// pins the level down the item is shown — the host already decides what it will
// serve, and guessing here would hide media the user asked to see.
const NSFW_LABEL_LEVELS = { None: 1, Soft: 2, Mature: 4, X: 8 };

function itemBrowsingLevel(item) {
  const level = Number(item.browsingLevel);
  if (BROWSING_LEVEL_VALUES.includes(level)) return level;
  return NSFW_LABEL_LEVELS[item.nsfwLevel] ?? null;
}

function matchesFeedFilters(item) {
  const f = feed();
  const itemLevel = itemBrowsingLevel(item);
  if (itemLevel !== null && !selectedBrowsingLevels().includes(itemLevel)) return false;
  if (f.mediaType !== "all" && item.type !== f.mediaType) return false;
  if (!matchesGenerationFilters(item, f)) return false;
  if (f.hideViewed && viewedIdSet.has(item.id)) return false;
  if (typeof item.username === "string"
      && config.settings.hiddenCreators.includes(item.username.toLocaleLowerCase())) return false;
  if (f.aspectRatio !== "all" && item.width > 0 && item.height > 0) {
    const ratio = item.width / item.height;
    if (f.aspectRatio === "portrait" && ratio >= 0.9) return false;
    if (f.aspectRatio === "landscape" && ratio <= 1.1) return false;
    if (f.aspectRatio === "square" && (ratio < 0.9 || ratio > 1.1)) return false;
  }
  return true;
}

function rebuildPool() {
  const sorted = [...itemMap.values()].filter(matchesFeedFilters).sort(getComparator(feed().globalSort));
  if (!feed().groupPosts) {
    pool = sorted;
    return;
  }
  const groups = new Map();
  pool = [];
  for (const item of sorted) {
    const key = item.postId ? `post:${item.postId}` : `image:${item.id}`;
    const existing = groups.get(key);
    if (existing) existing._groupItems.push(item);
    else {
      const representative = { ...item, _groupItems: [item] };
      groups.set(key, representative);
      pool.push(representative);
    }
  }
}

function applyLocalFilters({ preserveAnchor = true } = {}) {
  const visibleTarget = Math.max(BATCH, renderedCount);
  rebuildPool();
  renderedCount = Math.min(visibleTarget, pool.length);
  rebuildRendered({ preserveAnchor });
  const exhausted = activeStreams().length === 0;
  emptyEl.hidden = !(pool.length === 0 && exhausted);
  if (!emptyEl.hidden) emptyEl.textContent = "No fetched images match the current local filters.";
  setStatus(`${renderedCount} of ${pool.length} matching images · ${streams.length} streams`);
}

function mergeFetchedItems(items) {
  for (const item of items) {
    const existing = itemMap.get(item.id);
    if (existing) {
      if (item._source && !existing._sources.includes(item._source)) existing._sources.push(item._source);
    } else {
      itemMap.set(item.id, { ...item, _sources: item._source ? [item._source] : [] });
    }
  }
  rebuildPool();
}

// How far into the sorted pool we can render without risking that a page not
// yet fetched contains an item that belongs earlier. Only date sorts give
// this guarantee; for reaction/comment sorts we render whatever is fetched.
function safeLimit() {
  const globalSort = feed().globalSort;
  const active = activeStreams();
  if (active.length === 0) return pool.length;
  if (!hasFrontier(globalSort)) return pool.length;
  const cmp = getComparator(globalSort);
  const frontiers = active.map((s) => s.lastItem).filter(Boolean);
  if (frontiers.length < active.length) return 0; // some stream not fetched yet
  let n = 0;
  outer: for (const item of pool) {
    for (const frontier of frontiers) {
      if (cmp(item, frontier) > 0) break outer; // item ranks after a frontier
    }
    n += 1;
  }
  return n;
}

async function mapConcurrent(list, n, fn) {
  const queue = [...list];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length > 0) await fn(queue.shift());
    })
  );
}

function streamsBlockingFrontier() {
  const active = activeStreams();
  if (active.length === 0 || !hasFrontier(feed().globalSort)) return active;
  const missing = active.filter((stream) => !stream.lastItem);
  if (missing.length > 0) return missing;
  const cmp = getComparator(feed().globalSort);
  let bestFrontier = active[0].lastItem;
  for (const stream of active.slice(1)) {
    if (cmp(stream.lastItem, bestFrontier) < 0) bestFrontier = stream.lastItem;
  }
  return active.filter((stream) => cmp(stream.lastItem, bestFrontier) === 0);
}

async function fetchMorePages(run, signal) {
  await mapConcurrent(streamsBlockingFrontier(), 2, async (stream) => {
    try {
      const items = await fetchStreamPage(stream, effectiveApiSettings(), signal);
      if (run === runId) mergeFetchedItems(items);
    } catch (err) {
      if (err.name === "AbortError") return;
      stream.nextUrl = null;
      console.warn("MultiHub stream failed:", stream.label, err);
      if (run === runId) {
        runErrors.push(`${stream.label} (${err.message})`);
        renderErrors();
      }
    }
  });
}

function errorSuffix() {
  return runErrors.length > 0 ? ` — ⚠ failed: ${[...new Set(runErrors)].join("; ")}` : "";
}

// The sentinel only reports intersection *changes*. When a round appends fewer
// cards than it takes to push the sentinel back out of its 1200px margin — the
// common case with several sources, where the merge frontier releases only a
// handful of items at a time — no further event ever arrives and loading stalls
// with the reader already at the bottom, which reads as the feed refusing to go
// any further. Re-arm manually while the sentinel is still in view and the last
// round actually made progress.
function sentinelInView() {
  if (!sentinel) return false;
  return sentinel.getBoundingClientRect().top <= grid.getBoundingClientRect().bottom + 1200;
}

async function showMore(run = runId) {
  if (loadingRunId === run || run !== runId) return;
  loadingRunId = run;
  const signal = runController?.signal;
  const startedRendered = renderedCount;
  const startedPool = pool.length;
  try {
    const target = renderedCount + BATCH;
    let rounds = 0;
    while (run === runId && safeLimit() < target && activeStreams().length > 0 && rounds < 5) {
      rounds += 1;
      setStatus(`Loading… (${pool.length} images fetched)${errorSuffix()}`);
      await fetchMorePages(run, signal);
    }
    if (run !== runId) return;

    // Civitai's engagement pages use a hidden score that can reveal an item
    // with a higher visible count on a later page. Rebuild the fetched prefix
    // so the cards on screen agree with our raw-count comparator. Anchor it to
    // a visible card: a raw scrollTop restore lands somewhere else once the
    // re-ranked cards change column and the reader is thrown back up the feed.
    if (!hasFrontier(feed().globalSort) && renderedCount > 0) {
      rebuildRendered({ preserveAnchor: true });
    }

    // Reveal by filtering unrendered items rather than slicing by index: for
    // reaction sorts a later fetch can re-rank the pool, and an index slice
    // would silently skip items that moved above the rendered prefix.
    const limit = Math.min(target, safeLimit());
    const unrendered = pool.slice(0, limit).filter((i) => !renderedIds.has(i.id));
    appendCards(unrendered.slice(0, Math.max(0, target - renderedCount)));
    renderedCount = renderedIds.size;

    const exhausted = activeStreams().length === 0;
    const newCount = pool.filter((item) =>
      isUnviewedNewImage(item, previousVisitAt, viewedIdSet)
    ).length;
    emptyEl.hidden = !(renderedCount === 0 && exhausted);
    if (!emptyEl.hidden) {
      emptyEl.textContent = feed().sources.length === 0
        ? "Add a user, model, LoRA or public collection on the left — or browse civitai and use the “Add to MultiHub” button."
        : "No images found for the current sources and filters.";
    }
    setStatus(
      `${renderedCount} of ${pool.length} images · ${streams.length} streams` +
        `${newCount ? ` · ${newCount} new since last visit` : ""}` +
        `${exhausted ? " · end of feed" : ""}${errorSuffix()}`
    );
  } finally {
    if (loadingRunId === run) loadingRunId = null;
  }
  const progressed = renderedCount > startedRendered || pool.length > startedPool;
  const moreToShow = renderedCount < pool.length || activeStreams().length > 0;
  if (run === runId && progressed && moreToShow && sentinelInView()) {
    requestAnimationFrame(() => showMore(run));
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) showMore();
  },
  { root: grid, rootMargin: "1200px" }
);

async function startFeed({ clearImmediately = false } = {}) {
  runController?.abort();
  cancelQueuedVersionMetadata();
  runController = new AbortController();
  const signal = runController.signal;
  const run = ++runId;
  streams = [];
  itemMap = new Map();
  pool = [];
  renderedCount = 0;
  renderedIds = new Set();
  sourceLinks = {};
  sourceKinds = {};
  runErrors = [];
  renderErrors();
  clearModelCache();
  setCacheBuster(`${Date.now()}`); // fresh token per (re)start → bypass edge cache
  if (clearImmediately || !masonry) {
    setupGrid();
    showSkeletons();
  }

  const f = feed();
  viewedIdSet = new Set(f.viewedIds);
  document.body.classList.toggle("compact", f.density === "compact");
  if (!visitThresholds.has(f.id)) {
    visitThresholds.set(f.id, f.lastVisitedAt);
    f.lastVisitedAt = new Date().toISOString();
    saveConfig(config);
  }
  previousVisitAt = visitThresholds.get(f.id);
  const enabledSources = f.sources.filter((source) => source.enabled !== false);
  if (enabledSources.length === 0) {
    setupGrid();
    emptyEl.hidden = false;
    emptyEl.textContent = f.sources.length === 0
      ? "Add a user, model, LoRA or public collection on the left — or browse civitai and use the “Add to MultiHub” button."
      : "All sources in this hub are disabled.";
    setStatus("");
    return;
  }

  setStatus("Opening sources…");
  await mapConcurrent(enabledSources, 2, async (source) => {
    try {
      const opened = await openSourceStreams(source, f, effectiveApiSettings(), signal);
      if (run === runId) {
        streams.push(...opened);
        for (const s of opened) {
          sourceLinks[s.label] = s.href;
          sourceKinds[s.label] = source.type;
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      console.warn("MultiHub source failed:", sourceLabel(source), err);
      if (run === runId) {
        runErrors.push(`${sourceLabel(source)} (${err.message})`);
        renderErrors();
      }
    }
  });
  if (run !== runId) return;
  if (activeStreams().length > 0) await fetchMorePages(run, signal);
  if (run !== runId) return;
  setupGrid();
  const initialLimit = Math.min(BATCH, safeLimit());
  appendCards(pool.slice(0, initialLimit));
  renderedCount = renderedIds.size;
  await showMore(run);
}

// Rebuild the masonry when the column count changes.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (columns.length !== columnCount()) rebuildRendered();
  }, 200);
});

// ---------- controls ----------

function syncFeedControls() {
  $("global-sort").value = feed().globalSort;
  $("period").value = feed().period;
  $("media-type").value = feed().mediaType;
  $("aspect-ratio").value = feed().aspectRatio;
  $("generation-filter").value = feed().generationFilter;
  $("density").value = feed().density;
  $("autoplay-videos").checked = feed().autoplayVideos;
  $("hide-viewed").checked = feed().hideViewed;
  $("group-posts").checked = feed().groupPosts;
  $("api-key").value = config.settings.apiKey;
  $("remember-api-key").checked = config.settings.rememberApiKey === true;
  renderBrowsingLevelNote();
  renderHiddenCreators();
}

const SYNC_FAILURE_NOTES = {
  "no-tab": "no open Civitai tab on that host — refresh it after installing",
  "signed-out": "you are not signed in there",
  "no-level-in-session": "Civitai did not report a level for your account",
  unreachable: "Civitai could not be reached",
};

// The panel has no control of its own for this: it reports which levels are in
// force, and where they came from, so a feed that looks over- or under-filtered
// points at the setting that decides it.
function renderBrowsingLevelNote() {
  const host = effectiveLinkDomain();
  const shown = selectedBrowsingLevels().map((level) => BROWSING_LEVEL_LABELS[level]).join(", ");
  const note = $("browsing-note");
  if (accountBrowsingReason === null) {
    // The first read is still in flight; the cached level is what the feed uses.
    note.textContent = `Showing ${shown} — reading your browsing level from ${host}…`;
  } else if (accountBrowsingReason === "inherited") {
    note.textContent = `Showing ${shown} — your browsing level on ${host}. Change it there.`;
  } else if (accountBrowsingReason === "nsfw-disabled") {
    note.textContent = `Showing ${shown} — mature content is switched off in your ${host} settings.`;
  } else {
    note.textContent = `Showing ${shown} — your ${host} browsing level could not be read (${
      SYNC_FAILURE_NOTES[accountBrowsingReason] || "the setting could not be read"
    }), so the last known one applies.`;
  }
  note.title = `Set the browsing level on ${host}; MultiHub follows it.`;
}

function renderHiddenCreators() {
  const list = $("hidden-creators-list");
  list.textContent = "";
  for (const username of config.settings.hiddenCreators) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `@${username}`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.title = `Show @${username} again in every hub`;
    restore.addEventListener("click", async () => {
      config.settings.hiddenCreators = config.settings.hiddenCreators.filter((name) => name !== username);
      await saveConfig(config);
      renderHiddenCreators();
      applyLocalFilters();
    });
    item.append(label, restore);
    list.append(item);
  }
  $("hidden-creators-empty").hidden = config.settings.hiddenCreators.length > 0;
}

async function switchHub(feedId) {
  selectedSourceIds = new Set();
  sourceManageMode = false;
  config.activeFeedId = feedId;
  await saveConfig(config);
  renderHubs();
  renderSources();
  syncFeedControls();
  startFeed({ clearImmediately: true });
}

function bindHubs() {
  $("hub-select").addEventListener("change", (e) => switchHub(e.target.value));

  $("hub-new").addEventListener("click", async () => {
    const name = prompt("Name for the new hub:", `Hub ${config.feeds.length + 1}`);
    if (!name) return;
    const f = makeFeed(name.trim());
    config.feeds.push(f);
    await switchHub(f.id);
  });

  $("hub-rename").addEventListener("click", async () => {
    const name = prompt("New name for this hub:", feed().name);
    if (!name) return;
    feed().name = name.trim();
    await saveConfig(config);
    renderHubs();
  });

  $("hub-delete").addEventListener("click", async () => {
    const f = feed();
    if (!confirm(`Delete hub "${f.name}" and its ${f.sources.length} sources?`)) return;
    config.feeds = config.feeds.filter((x) => x.id !== f.id);
    if (config.feeds.length === 0) config.feeds.push(makeFeed("My hub"));
    await switchHub(config.feeds[0].id);
  });
}

function bindSettings() {
  $("link-domain").value = effectiveLinkDomain();
  $("link-domain").disabled = Boolean(embeddedHost);
  $("link-domain").title = embeddedHost
    ? `Embedded MultiHub links stay on ${embeddedHost}` : "Choose where Civitai links open";
  syncFeedControls();

  $("global-sort").addEventListener("change", async (e) => {
    feed().globalSort = e.target.value;
    await saveConfig(config);
    startFeed();
  });
  $("period").addEventListener("change", async (e) => {
    feed().period = e.target.value;
    await saveConfig(config);
    startFeed();
  });
  for (const [id, property] of [
    ["media-type", "mediaType"],
    ["aspect-ratio", "aspectRatio"],
    ["generation-filter", "generationFilter"],
  ]) {
    $(id).addEventListener("change", async (e) => {
      feed()[property] = e.target.value;
      await saveConfig(config);
      applyLocalFilters();
    });
  }
  $("density").addEventListener("change", async (e) => {
    feed().density = e.target.value;
    document.body.classList.toggle("compact", feed().density === "compact");
    await saveConfig(config);
    rebuildRendered();
  });
  $("autoplay-videos").addEventListener("change", async (e) => {
    feed().autoplayVideos = e.target.checked;
    await saveConfig(config);
    for (const video of grid.querySelectorAll("video")) {
      if (!feed().autoplayVideos) video.pause();
      mediaObserver.unobserve(video);
      mediaObserver.observe(video);
    }
  });
  $("hide-viewed").addEventListener("change", async (e) => {
    feed().hideViewed = e.target.checked;
    await saveConfig(config);
    applyLocalFilters();
  });
  $("clear-viewed").addEventListener("click", async () => {
    if (!confirm("Clear viewed-image history for this hub?")) return;
    feed().viewedIds = [];
    viewedIdSet = new Set();
    await saveConfig(config);
    applyLocalFilters();
  });
  $("hidden-creator-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("hidden-creator-input").value.trim().replace(/^@/, "").toLocaleLowerCase();
    if (!username) return;
    config.settings.hiddenCreators = [...new Set([
      ...config.settings.hiddenCreators, username,
    ])].slice(0, 200);
    $("hidden-creator-input").value = "";
    await saveConfig(config);
    renderHiddenCreators();
    applyLocalFilters();
  });
  $("link-domain").addEventListener("change", async (e) => {
    if (embeddedHost) {
      e.target.value = embeddedHost;
      return;
    }
    // The domain is also the API host, so switching it changes which browsing
    // levels exist and where every request goes: re-inherit and refetch.
    config.settings.linkDomain = e.target.value;
    await saveConfig(config);
    clearModelCache();
    await syncBrowsingLevelsFromCivitai();
    renderBrowsingLevelNote();
    startFeed();
  });
  $("api-key").addEventListener("change", async (e) => {
    config.settings.apiKey = e.target.value.trim();
    clearModelCache();
    resetCivitaiCapabilities();
    await saveConfig(config);
  });
  $("remember-api-key").addEventListener("change", async (e) => {
    config.settings.rememberApiKey = e.target.checked;
    await saveConfig(config);
    setStatus(e.target.checked
      ? "API key will be stored unencrypted in this browser profile."
      : "API key is now kept only for this browser session.");
  });
  $("refresh").addEventListener("click", () => {
    resetCivitaiCapabilities();
    startFeed();
  });
}

function bindAddSource() {
  $("add-source-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const draft = parseSourceInput($("source-input").value);
    if (!draft) {
      setStatus("Could not parse that input — use a username, model id, or Civitai user/model/collection URL.");
      return;
    }
    if (draft.type === "model") {
      try {
        setStatus(`Resolving model ${draft.modelId}…`);
        const model = await resolveModel(draft.modelId, config.settings);
        draft.label = `${model.type === "LORA" ? "LoRA" : model.type}: ${model.name}`;
        const versionHelp = model.versions.map((version) => `${version.id}: ${version.name}`).join("\n");
        const versions = prompt(
          `Choose model versions now. Enter comma-separated IDs or "all":\n${versionHelp}`,
          draft.versionIds?.join(", ") || "all"
        );
        if (versions === null) return;
        if (versions.trim().toLocaleLowerCase() === "all" || !versions.trim()) delete draft.versionIds;
        else {
          const ids = [...new Set(versions.split(",").map((id) => Number(id.trim()))
            .filter((id) => Number.isSafeInteger(id) && id > 0))];
          if (ids.length === 0) {
            setStatus("No valid model-version IDs were entered.");
            return;
          }
          draft.versionIds = ids;
        }
      } catch (err) {
        setStatus(`Could not find model ${draft.modelId}: ${err.message}`);
        return;
      }
    }
    if (draft.type === "collection") {
      try {
        setStatus(`Resolving collection ${draft.collectionId}…`);
        const collection = await resolveCollection(draft.collectionId, config.settings);
        if (String(collection.type).toLocaleLowerCase() !== "image") {
          setStatus(`Collection ${draft.collectionId} contains ${collection.type || "unsupported"} items, not images.`);
          return;
        }
        draft.label = `Collection: ${collection.name || `#${draft.collectionId}`}`;
      } catch (err) {
        setStatus(`Could not open collection ${draft.collectionId}: ${err.message}`);
        return;
      }
    }
    const result = mergeSourceIntoFeed(feed(), draft);
    if (result.status === "duplicate") {
      setStatus(`${sourceLabel(draft)} is already in this hub.`);
      return;
    }
    await saveConfig(config);
    $("source-input").value = "";
    renderHubs();
    renderSources();
    startFeed();
  });
  $("remove-api-key").addEventListener("click", async () => {
    config.settings.apiKey = "";
    config.settings.rememberApiKey = false;
    $("api-key").value = "";
    $("remember-api-key").checked = false;
    clearModelCache();
    resetCivitaiCapabilities();
    await saveConfig(config);
    setStatus("API key removed from local and session extension storage.");
    startFeed();
  });
}

function bindPanels() {
  let sidebarResizeTimer;
  const showSettingsPanel = (name) => {
    const general = name === "general";
    $("settings-panel-general").hidden = !general;
    $("settings-panel-hidden").hidden = general;
    $("settings-tab-general").classList.toggle("active", general);
    $("settings-tab-hidden").classList.toggle("active", !general);
    $("settings-tab-general").setAttribute("aria-selected", String(general));
    $("settings-tab-hidden").setAttribute("aria-selected", String(!general));
  };
  const closeSettings = () => {
    $("settings-overlay").hidden = true;
    $("settings-toggle").setAttribute("aria-expanded", "false");
    $("settings-toggle").focus();
  };
  const setSidebarCollapsed = (collapsed) => {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    $("sidebar-toggle").textContent = collapsed ? "›" : "‹";
    $("sidebar-toggle").title = collapsed ? "Show sidebar" : "Hide sidebar";
    $("sidebar-toggle").setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
    $("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    localStorage.setItem("cmh-sidebar-collapsed", String(collapsed));
    clearTimeout(sidebarResizeTimer);
    sidebarResizeTimer = setTimeout(() => rebuildRendered({ preserveAnchor: true }), 220);
  };
  setSidebarCollapsed(localStorage.getItem("cmh-sidebar-collapsed") === "true");
  $("sidebar-toggle").addEventListener("click", () => {
    setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  });
  $("settings-toggle").addEventListener("click", () => {
    showSettingsPanel("general");
    $("settings-overlay").hidden = false;
    $("settings-toggle").setAttribute("aria-expanded", "true");
    $("settings-close").focus();
  });
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-tab-general").addEventListener("click", () => showSettingsPanel("general"));
  $("settings-tab-hidden").addEventListener("click", () => {
    showSettingsPanel("hidden");
    renderHiddenCreators();
  });
  $("settings-overlay").addEventListener("click", (event) => {
    if (event.target === $("settings-overlay")) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if ($("settings-overlay").hidden) return;
    if (event.key === "Escape") return closeSettings();
    if (event.key !== "Tab") return;
    const focusable = [...$("advanced-settings").querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
    )].filter((element) => !element.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  $("group-posts").addEventListener("change", async (e) => {
    feed().groupPosts = e.target.checked;
    await saveConfig(config);
    applyLocalFilters();
  });
  $("sources-toggle").addEventListener("click", () => {
    const expanded = $("sources-toggle").getAttribute("aria-expanded") !== "true";
    $("sources-toggle").setAttribute("aria-expanded", String(expanded));
    $("sources-panel").hidden = !expanded;
  });
}

function bindBulkSources() {
  async function transferSelected(move) {
    if (selectedSourceIds.size === 0) return;
    const destination = chooseDestination(move ? "Move" : "Copy");
    if (!destination) return;
    const selected = feed().sources.filter((source) => selectedSourceIds.has(source.id));
    for (const source of selected) copySourceTo(source, destination);
    if (move) feed().sources = feed().sources.filter((source) => !selectedSourceIds.has(source.id));
    selectedSourceIds = new Set();
    await saveConfig(config);
    renderHubs();
    renderSources();
    startFeed();
  }
  $("source-manage").addEventListener("click", () => {
    sourceManageMode = !sourceManageMode;
    if (!sourceManageMode) selectedSourceIds = new Set();
    renderSources();
  });
  $("bulk-select-all").addEventListener("click", () => {
    selectedSourceIds = new Set(feed().sources.map((source) => source.id));
    renderSources();
  });
  $("bulk-deselect-all").addEventListener("click", () => {
    selectedSourceIds = new Set();
    renderSources();
  });
  async function setSelectedEnabled(enabled) {
    if (selectedSourceIds.size === 0) return;
    for (const source of feed().sources) {
      if (selectedSourceIds.has(source.id)) source.enabled = enabled;
    }
    await saveConfig(config);
    renderSources();
    startFeed();
  }
  $("bulk-enable").addEventListener("click", () => setSelectedEnabled(true));
  $("bulk-disable").addEventListener("click", () => setSelectedEnabled(false));
  $("bulk-copy").addEventListener("click", () => transferSelected(false));
  $("bulk-move").addEventListener("click", () => transferSelected(true));
  $("bulk-remove").addEventListener("click", async () => {
    const count = selectedSourceIds.size;
    if (!count || !confirm(`Remove ${count} selected source${count === 1 ? "" : "s"} from this hub?`)) return;
    feed().sources = feed().sources.filter((source) => !selectedSourceIds.has(source.id));
    selectedSourceIds = new Set();
    await saveConfig(config);
    renderHubs();
    renderSources();
    startFeed();
  });
}

function bindShare() {
  $("export").addEventListener("click", () => exportFeed(feed()));
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = importFeed(await file.text());
      config.feeds.push(imported);
      await switchHub(imported.id);
      setStatus(`Imported hub "${imported.name}" (${imported.sources.length} sources).`);
    } catch (err) {
      setStatus(`Import failed: ${err.message}`);
    }
    e.target.value = "";
  });
}

// Sources can be added from civitai pages while this tab is open; keep in sync.
chrome.storage.onChanged.addListener((changes, area) => {
  const relevantLocal = area === "local" && (changes.feeds || changes.settings || changes.activeFeedId || changes.apiKey);
  const relevantSession = area === "session" && changes.apiKey;
  if ((!relevantLocal && !relevantSession) || document.hasFocus()) return;
  reloadFromStorage();
});
window.addEventListener("focus", reloadFromStorage);

async function reloadFromStorage() {
  if (!config) return;
  const fresh = await loadConfig();
  const feedsChanged = JSON.stringify(fresh.feeds) !== JSON.stringify(config.feeds)
    || fresh.activeFeedId !== config.activeFeedId;
  const settingsChanged = JSON.stringify(fresh.settings) !== JSON.stringify(config.settings);
  if (!feedsChanged && !settingsChanged) return;
  const requiresRefetch = ["apiKey", "maxVersionsPerModel"]
    .some((key) => fresh.settings[key] !== config.settings[key]);
  const apiKeyChanged = fresh.settings.apiKey !== config.settings.apiKey;
  const browsingLevelsChanged = JSON.stringify(fresh.settings.browsingLevelsByDomain)
    !== JSON.stringify(config.settings.browsingLevelsByDomain);
  config = fresh;
  if (apiKeyChanged) resetCivitaiCapabilities();
  renderHubs();
  renderSources();
  syncFeedControls();
  if (feedsChanged || requiresRefetch || browsingLevelsChanged) startFeed();
  else {
    applyLocalFilters();
    rebuildRendered();
  }
}

function bindLightbox() {
  $("lightbox-close").addEventListener("click", closeLightbox);
  $("lightbox-prev").addEventListener("click", () => moveLightbox(-1));
  $("lightbox-next").addEventListener("click", () => moveLightbox(1));
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if ($("lightbox").hidden) return;
    if (event.key === "Escape") closeLightbox();
    else if (event.key === "ArrowLeft") moveLightbox(-1);
    else if (event.key === "ArrowRight") moveLightbox(1);
  });
  $("retry-errors").addEventListener("click", () => {
    resetCivitaiCapabilities();
    startFeed();
  });
  $("lightbox-comment-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const item = lightboxItem();
    const input = $("lightbox-comment-input");
    const button = event.currentTarget.querySelector('button[type="submit"]');
    if (!item || !input.value.trim()) return;
    button.disabled = true;
    $("lightbox-comments-status").hidden = false;
    $("lightbox-comments-status").textContent = "Posting comment…";
    try {
      const saved = await postComment(
        "image", item.id, commentHtml(input.value), effectiveApiSettings(), runController?.signal
      );
      if (!Array.isArray(item._comments)) item._comments = [];
      item._comments.push({
        content: commentHtml(input.value),
        createdAt: new Date().toISOString(),
        user: { username: "You" },
        ...(saved && typeof saved === "object" ? saved : {}),
        replies: [],
      });
      item._commentsAttempted = true;
      item._commentsError = "";
      if (!item.stats) item.stats = {};
      item.stats.commentCount = (Number(item.stats.commentCount) || 0) + 1;
      input.value = "";
      // The comment appearing in the thread is the confirmation.
      renderLightboxComments(item, `https://${effectiveLinkDomain()}/images/${item.id}`);
    } catch (error) {
      $("lightbox-comments-status").hidden = false;
      $("lightbox-comments-status").textContent = explainCivitaiError(error, {
        action: "Posting the comment", scope: "SocialWrite access", mutation: true,
      });
    }
    button.disabled = false;
  });
  const closePicker = () => {
    $("collection-picker-overlay").hidden = true;
    collectionPickerItem = null;
  };
  $("collection-picker-close").addEventListener("click", closePicker);
  $("collection-picker-overlay").addEventListener("click", (event) => {
    if (event.target === $("collection-picker-overlay")) closePicker();
  });
}

function bindSourceEditor() {
  $("source-editor-close").addEventListener("click", closeSourceEditor);
  $("source-editor-cancel").addEventListener("click", closeSourceEditor);
  $("source-editor-overlay").addEventListener("click", (event) => {
    if (event.target === $("source-editor-overlay")) closeSourceEditor();
  });
  $("source-editor-transfer").addEventListener("change", (event) => {
    $("source-editor-destination-label").hidden = event.target.value === "none";
  });
  $("source-editor-version-mode").addEventListener("change", (event) => {
    $("source-editor-version-list").hidden = event.target.value === "all";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("source-editor-overlay").hidden) closeSourceEditor();
  });
  $("source-editor").addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = feed().sources.find((candidate) => candidate.id === editingSourceId);
    if (!source) return closeSourceEditor();
    const updated = { ...source };
    delete updated.nsfw; // migrate legacy per-source maximums to unified browsing levels
    const alias = $("source-editor-alias").value.trim().slice(0, 80);
    if (alias) updated.alias = alias;
    else delete updated.alias;
    if (source.type === "model") {
      if ($("source-editor-version-mode").value === "all") delete updated.versionIds;
      else {
        const versionIds = [...$("source-editor-version-list").querySelectorAll("input:checked")]
          .map((input) => Number(input.value));
        if (versionIds.length === 0) {
          $("source-editor-error").textContent = "Select at least one version, or choose All versions.";
          $("source-editor-error").hidden = false;
          return;
        }
        updated.versionIds = versionIds;
      }
    }
    const transfer = $("source-editor-transfer").value;
    const destination = transfer === "none"
      ? null : config.feeds.find((hub) => hub.id === $("source-editor-destination").value);
    if (transfer !== "none" && !destination) {
      $("source-editor-error").textContent = "Choose a destination hub.";
      $("source-editor-error").hidden = false;
      return;
    }
    if (destination) copySourceTo(updated, destination);
    if (transfer === "move") feed().sources = feed().sources.filter((candidate) => candidate.id !== source.id);
    else {
      delete source.alias;
      delete source.versionIds;
      Object.assign(source, updated);
    }
    await saveConfig(config);
    selectedSourceIds.delete(source.id);
    closeSourceEditor();
    renderHubs();
    renderSources();
    startFeed();
  });
}

(async function init() {
  config = await loadConfig();
  await saveConfig(config); // persist migration to the multi-hub format
  bindHubs();
  bindPanels();
  bindLightbox();
  bindSourceEditor();
  bindSettings();
  bindAddSource();
  bindBulkSources();
  bindShare();
  renderHubs();
  renderSources();
  startFeed();
  // Best-effort and asynchronous: the feed starts on the stored levels and
  // restarts only if Civitai reports a different maturity setting.
  syncBrowsingLevelsFromCivitai().then((changed) => {
    renderBrowsingLevelNote();
    if (changed) startFeed();
    watchCivitaiBrowsingLevel();
  });
})();
