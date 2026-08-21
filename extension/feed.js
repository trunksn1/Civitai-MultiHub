import {
  openSourceStreams, fetchStreamPage, resolveModel, thumbnailUrl, videoPlaybackUrl, videoPosterUrl,
  setCacheBuster,
  clearModelCache, resolveModelVersion, resolveCreatorProfile, resolveCollection,
  resolveImageGenerationData, resolveImageComments,
  toggleImageReaction,
  resolveWritableCollections, addImageToCollections,
  postComment,
  explainCivitaiError, resetCivitaiCapabilities,
  resolveAccountBrowsingLevels, maskFromLevels, userAvatarUrl, imageBuzzAmount,
  BROWSING_LEVEL_VALUES, BROWSING_LEVEL_LABELS,
} from "./civitai-api.js";
import { beginOptimisticReaction } from "./action-state.js";
import { getComparator, hasFrontier } from "./merge.js";
import {
  loadConfig, saveConfig, activeFeed, makeFeed,
  parseSourceInput, mergeSourceIntoFeed, exportFeed, exportFeeds, importFeeds,
  normalizeNewHubName,
  MAX_HUBS,
} from "./storage.js";
import {
  DISTRIBUTION,
  ALLOWED_CIVITAI_HOSTS,
  isAllowedCivitaiHost,
} from "./distribution.js";
import {
  generationContentSignals,
  isUnviewedNewImage,
  matchesGenerationFilters,
} from "./content-filters.js";
import {
  playbackVisibilityThreshold,
  selectVideosForPlayback,
} from "./video-playback.js";

const INITIAL_BATCH = 15;
const BATCH = 15; // reveal the prefetched second half, then continue in small steps
const STREAM_FETCH_CONCURRENCY = 6;
const LOAD_AHEAD_PX = 3200;
const SCROLL_IDLE_MS = 240;
const SCROLL_DIAGNOSTICS_KEY = "cmh-scroll-diagnostics-v1";
const MAX_SCROLL_DIAGNOSTICS = 240;
const pageParams = new URLSearchParams(location.search);
const requestedHost = pageParams.get("embedded") === "1" ? pageParams.get("host") : null;
const embeddedHost = isAllowedCivitaiHost(requestedHost)
  ? requestedHost : null;
const USE_IN_PAGE_DIALOGS = DISTRIBUTION.channel === "firefox-addons";
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
let previewedRunId = null;
let runController = null;
let feedRunApiSettings = null;
let sourceLinks = {}; // source label -> site path, for the links under each card
let sourceKinds = {}; // source label -> user | model | collection
let sourceModelTypes = {}; // model source label -> Checkpoint | LORA | TextualInversion | ...
let runErrors = []; // failed sources/streams for the current run, always shown
let selectedSourceIds = new Set();
let sourceManageMode = false;
let selectedHubIds = new Set();
const visitThresholds = new Map();
let previousVisitAt = null;
let viewedIdSet = new Set();
let viewedSaveTimer;
const versionMetadataQueue = [];
let accountBrowsingReason = null; // how the level was established, for the sidebar note
let browsingLevelRefreshPending = false;
let versionMetadataActive = 0;
const creatorProfileQueue = [];
let creatorProfileActive = 0;
let collectionPickerItem = null;
let collectionPickerCollections = [];
const pendingReactionActions = new Set();

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
let appDialogState = null;

function closeAppDialog(value) {
  if (!appDialogState) return;
  const { resolve, previousFocus } = appDialogState;
  appDialogState = null;
  $("app-dialog-overlay").hidden = true;
  $("app-dialog-choices").replaceChildren();
  if (previousFocus?.isConnected) previousFocus.focus();
  resolve(value);
}

function openAppDialog({
  mode = "notice",
  title,
  message = "",
  defaultValue = "",
  inputLabel = "Value",
  maxLength = 1000,
  choices = [],
  confirmLabel = "OK",
  cancelLabel = "Cancel",
}) {
  if (appDialogState) closeAppDialog(null);

  return new Promise((resolve) => {
    const overlay = $("app-dialog-overlay");
    const inputWrap = $("app-dialog-input-label");
    const input = $("app-dialog-input");
    const choiceList = $("app-dialog-choices");
    const confirmButton = $("app-dialog-confirm");
    const cancelButton = $("app-dialog-cancel");
    const canCancel = mode !== "notice";

    appDialogState = {
      mode,
      resolve,
      cancelValue: mode === "confirmation" ? false : null,
      previousFocus: document.activeElement,
    };
    $("app-dialog-title").textContent = title;
    $("app-dialog-message").textContent = message;
    $("app-dialog-input-caption").textContent = inputLabel;
    inputWrap.hidden = mode !== "text";
    input.value = String(defaultValue ?? "");
    input.maxLength = maxLength;
    input.required = false;
    choiceList.hidden = mode !== "choice";
    choiceList.replaceChildren();
    if (mode === "choice") {
      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "app-dialog-choice";
        button.textContent = choice.label;
        button.addEventListener("click", () => closeAppDialog(choice.value));
        choiceList.append(button);
      }
    }
    confirmButton.hidden = mode === "choice";
    confirmButton.textContent = confirmLabel;
    cancelButton.hidden = !canCancel;
    cancelButton.textContent = cancelLabel;
    overlay.hidden = false;
    requestAnimationFrame(() => {
      if (mode === "text") {
        input.focus();
        input.select();
      } else if (mode === "choice") {
        choiceList.querySelector("button")?.focus();
      } else {
        confirmButton.focus();
      }
    });
  });
}

function askText(title, message, defaultValue = "", options = {}) {
  const { nativeMessage = message, ...dialogOptions } = options;
  if (!USE_IN_PAGE_DIALOGS) return Promise.resolve(globalThis.prompt(nativeMessage, defaultValue));
  return openAppDialog({ mode: "text", title, message, defaultValue, ...dialogOptions });
}

function askConfirmation(title, message, options = {}) {
  if (!USE_IN_PAGE_DIALOGS) return Promise.resolve(globalThis.confirm(message));
  return openAppDialog({ mode: "confirmation", title, message, confirmLabel: "Confirm", ...options });
}

function showNotice(title, message, options = {}) {
  if (!USE_IN_PAGE_DIALOGS) {
    globalThis.alert(message);
    return Promise.resolve();
  }
  return openAppDialog({ mode: "notice", title, message, ...options });
}

function chooseFromList(title, message, choices, options = {}) {
  if (!USE_IN_PAGE_DIALOGS) {
    const answer = globalThis.prompt(options.nativeMessage || message, "1");
    const index = Number(answer) - 1;
    return Promise.resolve(Number.isInteger(index) ? choices[index]?.value || null : null);
  }
  return openAppDialog({ mode: "choice", title, message, choices });
}

function bindAppDialog() {
  $("app-dialog").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!appDialogState) return;
    closeAppDialog(appDialogState.mode === "text" ? $("app-dialog-input").value : true);
  });
  $("app-dialog-cancel").addEventListener("click", () => {
    if (appDialogState) closeAppDialog(appDialogState.cancelValue);
  });
  $("app-dialog-overlay").addEventListener("click", (event) => {
    if (event.target === $("app-dialog-overlay") && appDialogState?.mode !== "notice") {
      closeAppDialog(appDialogState.cancelValue);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!appDialogState) return;
    if (event.key === "Escape" && appDialogState.mode !== "notice") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeAppDialog(appDialogState.cancelValue);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...$("app-dialog").querySelectorAll(
      'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden])'
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
  }, true);
}

function showStartupError(error) {
  $("startup-error-detail").textContent = String(error?.message || error || "Unknown startup error").slice(0, 240);
  $("startup-error").hidden = false;
  console.error("MultiHub startup failed", error);
}

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
  if (changed) browsingLevelRefreshPending = true;
  renderBrowsingLevelNote();
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
  window.addEventListener("message", async (event) => {
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
  if (source.type === "collection") return cleanSourceTypePrefix(source.label) || `#${source.collectionId}`;
  return cleanSourceTypePrefix(source.label) || `Model #${source.modelId}`;
}

function originalSourceLabel(source) {
  if (source.type === "user") return `@${source.username}`;
  if (source.type === "collection") return cleanSourceTypePrefix(source.label) || `#${source.collectionId}`;
  return cleanSourceTypePrefix(source.label) || `Model #${source.modelId}`;
}

function cleanSourceTypePrefix(value) {
  return String(value || "").replace(
    /^(?:collection|checkpoint|lora|embedding|textual\s*inversion|model)\s*:\s*/i, ""
  ).trim();
}

function cardSourceLabel(value) {
  return cleanSourceTypePrefix(value) || String(value || "").trim();
}

function isCheckpointSource(label) {
  const type = String(sourceModelTypes[label] || "").toLocaleLowerCase();
  return type.includes("checkpoint")
    || (!type && /^checkpoint\s*:/i.test(String(label || "")));
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
  if (hub.id === feed().id && result.status !== "duplicate") startFeed({ reason: "source-hover-add" });
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
  createInput.maxLength = 30;
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
    opt.textContent = `${f.id === config.defaultFeedId ? "★ " : ""}${f.name}`;
    select.append(opt);
  }
  select.value = config.activeFeedId;
}

function updateHubManagerActions() {
  const count = selectedHubIds.size;
  $("hub-manager-rename").disabled = count !== 1;
  $("hub-manager-export").disabled = count === 0;
  $("hub-manager-delete").disabled = count === 0;
}

function renderHubManager() {
  const list = $("hub-manager-list");
  list.replaceChildren();
  for (const hub of sortedHubs()) {
    const row = document.createElement("div");
    row.className = "hub-manager-row";
    const selected = document.createElement("input");
    selected.type = "checkbox";
    selected.checked = selectedHubIds.has(hub.id);
    selected.setAttribute("aria-label", `Select ${hub.name}`);
    selected.addEventListener("change", () => {
      if (selected.checked) selectedHubIds.add(hub.id);
      else selectedHubIds.delete(hub.id);
      updateHubManagerActions();
    });
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "hub-manager-default";
    favorite.classList.toggle("active", hub.id === config.defaultFeedId);
    favorite.textContent = "★";
    favorite.title = hub.id === config.defaultFeedId
      ? "Clear the default hub" : `Open ${hub.name} by default`;
    favorite.setAttribute("aria-pressed", String(hub.id === config.defaultFeedId));
    favorite.addEventListener("click", async (event) => {
      event.preventDefault();
      config.defaultFeedId = hub.id === config.defaultFeedId ? null : hub.id;
      await saveConfig(config);
      renderHubs();
      renderHubManager();
      $("hub-manager-status").textContent = config.defaultFeedId
        ? `“${hub.name}” will open by default.` : "No default hub is set.";
    });
    const name = document.createElement("span");
    name.className = "hub-manager-name";
    name.textContent = hub.name;
    const meta = document.createElement("span");
    meta.className = "hub-manager-meta";
    meta.textContent = `${hub.sources.length} source${hub.sources.length === 1 ? "" : "s"}${
      hub.id === config.activeFeedId ? " · current" : ""
    }`;
    row.append(selected, favorite, name, meta);
    list.append(row);
  }
  updateHubManagerActions();
}

function openHubManager() {
  selectedHubIds = new Set();
  $("hub-manager-status").textContent = config.defaultFeedId
    ? "The starred hub opens whenever MultiHub is opened." : "Star a hub to make it the default.";
  renderHubManager();
  $("hub-manager-overlay").hidden = false;
}

function closeHubManager() {
  $("hub-manager-overlay").hidden = true;
  selectedHubIds = new Set();
}

function renderSources() {
  const list = $("source-list");
  list.textContent = "";
  $("sources-count").textContent = `(${feed().sources.length})`;
  const anyEnabled = feed().sources.some((source) => source.enabled !== false);
  $("source-toggle-all").textContent = anyEnabled ? "Disable all sources" : "Enable all sources";
  $("source-toggle-all").disabled = feed().sources.length === 0;
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
      startFeed({ reason: "source-toggle" });
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
    const onlyVersionId = source.versionIds?.length === 1 ? source.versionIds[0] : null;
    const onlyVersionName = onlyVersionId ? source.versionNames?.[onlyVersionId] : "";
    meta.textContent = onlyVersionName || (source.versionIds?.length
      ? `${source.versionIds.length} version${source.versionIds.length === 1 ? "" : "s"}`
      : "all versions");
    meta.title = onlyVersionName || meta.textContent;

    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "Options";
    edit.title = source.type === "model"
      ? "Alias, model versions, move or copy"
      : "Alias, move or copy";
    edit.addEventListener("click", () => editSource(source));

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.addEventListener("click", async () => {
      if (!await askConfirmation(
        "Remove source?",
        `Remove "${sourceLabel(source)}" from this hub?`,
        { confirmLabel: "Remove" }
      )) return;
      feed().sources = feed().sources.filter((s) => s.id !== source.id);
      await saveConfig(config);
      renderHubs();
      renderSources();
      startFeed({ reason: "source-remove" });
    });

    text.append(label);
    if (source.type === "model") text.append(meta);
    li.append(selected, enabled, text, edit, remove);
    list.append(li);
  }
  $("source-bulk").hidden = !sourceManageMode;
  $("source-manage").textContent = sourceManageMode ? "Done managing" : "Manage sources";
  updateBulkControls();
}

function updateBulkControls() {
  const hasSelection = selectedSourceIds.size > 0;
  for (const id of ["bulk-copy", "bulk-move", "bulk-remove", "bulk-deselect-all"]) {
    $(id).disabled = !hasSelection;
  }
  $("bulk-select-all").disabled = feed().sources.length === 0
    || selectedSourceIds.size === feed().sources.length;
}

async function chooseDestination(action) {
  const choices = config.feeds.filter((f) => f.id !== feed().id);
  if (choices.length === 0) {
    await showNotice("No destination hub", "Create another hub first.");
    return null;
  }
  return chooseFromList(
    `${action} sources`,
    `${action} the selected sources to which hub?`,
    choices.map((hub) => ({ label: hub.name, value: hub })),
    { nativeMessage: `${action} to which hub?\n${choices.map((f, i) => `${i + 1}. ${f.name}`).join("\n")}` }
  );
}

function copySourceTo(source, destination) {
  const { id, ...draft } = source;
  return mergeSourceIntoFeed(destination, draft);
}

let editingSourceId = null;
let sourceTransferMode = null;

function showSourceEditorError(message = "") {
  $("source-editor-error").textContent = message;
  $("source-editor-error").hidden = !message;
}

function sourceEditorDraft() {
  const source = feed().sources.find((candidate) => candidate.id === editingSourceId);
  if (!source) return null;
  const updated = { ...source };
  delete updated.nsfw;
  const alias = $("source-editor-alias").value.trim().slice(0, 80);
  if (alias) updated.alias = alias;
  else delete updated.alias;
  if (source.type === "model") {
    if ($("source-editor-version-mode").value === "all") delete updated.versionIds;
    else {
      const versionIds = [...$("source-editor-version-list").querySelectorAll("input:checked")]
        .map((input) => Number(input.value));
      if (versionIds.length === 0) {
        showSourceEditorError("Select at least one version, or choose All versions.");
        return null;
      }
      updated.versionIds = versionIds;
      updated.versionNames = Object.fromEntries(versionIds.map((versionId) => [
        versionId,
        source._availableVersionNames?.[versionId] || source.versionNames?.[versionId] || `Version ${versionId}`,
      ]));
    }
    if (!updated.versionIds) delete updated.versionNames;
    delete updated._availableVersionNames;
  }
  showSourceEditorError();
  return { source, updated };
}

function renderSourceTransferDestinations() {
  const list = $("source-transfer-destinations");
  list.replaceChildren();
  const destinations = sortedHubs().filter((hub) => hub.id !== feed().id);
  if (destinations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "There are no other hubs yet. Create one below.";
    list.append(empty);
    return;
  }
  for (const hub of destinations) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = hub.name;
    button.addEventListener("click", () => transferEditedSource(hub));
    list.append(button);
  }
}

function openSourceTransfer(mode) {
  sourceTransferMode = mode;
  $("source-transfer-title").textContent = `${mode === "move" ? "Move" : "Copy"} to which hub?`;
  $("source-transfer-panel").hidden = false;
  $("source-transfer-create").hidden = true;
  $("source-transfer-new-name").value = "";
  renderSourceTransferDestinations();
}

async function transferEditedSource(destination) {
  const draft = sourceEditorDraft();
  if (!draft || !sourceTransferMode) return false;
  copySourceTo(draft.updated, destination);
  if (sourceTransferMode === "move") {
    feed().sources = feed().sources.filter((candidate) => candidate.id !== draft.source.id);
  }
  await saveConfig(config);
  const action = sourceTransferMode === "move" ? "Moved" : "Copied";
  setStatus(`${action} ${sourceLabel(draft.updated)} to “${destination.name}”.`);
  selectedSourceIds.delete(draft.source.id);
  closeSourceEditor();
  renderHubs();
  renderSources();
  startFeed({ reason: "source-transfer" });
  return true;
}

async function editSource(source) {
  editingSourceId = source.id;
  sourceTransferMode = null;
  $("source-editor-title").textContent = `Options for ${sourceLabel(source)}`;
  $("source-editor-original").textContent = `Original: ${originalSourceLabel(source)}`;
  $("source-editor-alias").value = source.alias || "";
  showSourceEditorError();
  $("source-transfer-panel").hidden = true;
  $("source-transfer-create").hidden = true;
  $("source-editor-versions").hidden = source.type !== "model";
  $("source-editor-version-list").textContent = "";
  if (source.type === "model") {
    try {
      const model = await resolveModel(source.modelId, config.settings);
      $("source-editor-version-mode").value = source.versionIds?.length ? "selected" : "all";
      $("source-editor-version-list").hidden = !source.versionIds?.length;
      const selected = new Set(source.versionIds || []);
      const versionNames = {};
      for (const version of model.versions) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = version.id;
        checkbox.checked = selected.has(version.id);
        checkbox.dataset.versionName = version.name;
        versionNames[version.id] = version.name;
        label.append(checkbox, `${version.name} (${version.id})`);
        $("source-editor-version-list").append(label);
      }
      source._availableVersionNames = versionNames;
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
  sourceTransferMode = null;
}

// ---------- masonry grid ----------

const grid = $("grid");
let masonry, sentinel, emptyEl;
let columns = [];
let columnHeights = [];
let reusableMedia = new Map();
let lastGridScrollAt = -Infinity;
let lastForwardScrollInputAt = -Infinity;
let loadAheadFrame = null;
let gridGeometryFrame = null;
let gridGeometryBaseline = null;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const visibleVideos = new Map();

function loadScrollDiagnostics() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SCROLL_DIAGNOSTICS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_SCROLL_DIAGNOSTICS) : [];
  } catch {
    return [];
  }
}

let scrollDiagnostics = loadScrollDiagnostics();

function gridMetrics() {
  return {
    scrollTop: Math.round(grid.scrollTop),
    scrollHeight: Math.round(grid.scrollHeight),
    clientHeight: Math.round(grid.clientHeight),
    clientWidth: Math.round(grid.clientWidth),
    cards: grid.querySelectorAll(".card[data-image-id]").length,
    columns: columns.length,
    renderedCount,
    poolSize: pool.length,
    streamCount: streams.length,
    activeStreamCount: streams.filter((stream) => stream.nextUrl).length,
    runId,
    loadingRunId,
  };
}

function recordScrollDiagnostic(type, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    sinceLoadMs: Math.round(performance.now()),
    type,
    ...details,
    metrics: gridMetrics(),
  };
  scrollDiagnostics.push(entry);
  scrollDiagnostics = scrollDiagnostics.slice(-MAX_SCROLL_DIAGNOSTICS);
  try {
    sessionStorage.setItem(SCROLL_DIAGNOSTICS_KEY, JSON.stringify(scrollDiagnostics));
  } catch {
    // Diagnostics must never interfere with the feed itself.
  }
  return entry;
}

function resetScrollDiagnostics() {
  scrollDiagnostics = [];
  gridGeometryBaseline = gridMetrics();
  try {
    sessionStorage.removeItem(SCROLL_DIAGNOSTICS_KEY);
  } catch {
    // Diagnostics must never interfere with the feed itself.
  }
  recordScrollDiagnostic("diagnostics-reset");
}

function scrollDiagnosticsReport() {
  return JSON.stringify({
    report: "Civitai MultiHub scroll diagnostics",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    distribution: DISTRIBUTION.channel,
    browser: navigator.userAgent,
    embedded: Boolean(embeddedHost),
    current: gridMetrics(),
    events: scrollDiagnostics,
  }, null, 2);
}

async function copyScrollDiagnostics() {
  const output = $("scroll-diagnostics-output");
  const status = $("scroll-diagnostics-status");
  const report = scrollDiagnosticsReport();
  output.value = report;
  let copied = false;
  try {
    await navigator.clipboard.writeText(report);
    copied = true;
  } catch {
    output.hidden = false;
    output.focus();
    output.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
  }
  status.textContent = copied
    ? "Copied. Paste the report into the bug report or chat."
    : "Automatic copy was blocked. Select and copy the report below.";
  output.hidden = copied;
}

function checkGridGeometry(trigger) {
  const current = gridMetrics();
  const previous = gridGeometryBaseline;
  gridGeometryBaseline = current;
  if (!previous) return;
  const heightDrop = previous.scrollHeight - current.scrollHeight;
  const scrollTopDrop = previous.scrollTop - current.scrollTop;
  const dropThreshold = Math.max(240, previous.clientHeight * 0.25);
  if (heightDrop >= dropThreshold) {
    const entry = recordScrollDiagnostic("scroll-height-collapse", {
      trigger,
      heightDrop,
      scrollTopDrop,
      previous,
    });
    console.warn("MultiHub feed height collapsed", entry);
  } else if (scrollTopDrop >= Math.max(200, current.clientHeight * 0.35)
      && performance.now() - lastForwardScrollInputAt < 800) {
    const entry = recordScrollDiagnostic("forward-scroll-position-drop", {
      trigger,
      scrollTopDrop,
      previous,
    });
    console.warn("MultiHub feed moved backward during forward scrolling", entry);
  }
}

function scheduleGridGeometryCheck(trigger) {
  if (gridGeometryFrame !== null) return;
  gridGeometryFrame = requestAnimationFrame(() => {
    gridGeometryFrame = null;
    checkGridGeometry(trigger);
  });
}

const gridResizeObserver = new ResizeObserver(() => scheduleGridGeometryCheck("masonry-resize"));

function noteGridScrollActivity(event) {
  lastGridScrollAt = performance.now();
  if (event.type === "wheel" && event.deltaY > 0) lastForwardScrollInputAt = performance.now();
  scheduleGridGeometryCheck(event.type);
  if (loadAheadFrame !== null) return;
  loadAheadFrame = requestAnimationFrame(() => {
    loadAheadFrame = null;
    if (sentinelInView()) showMore();
  });
}

grid.addEventListener("scroll", noteGridScrollActivity, { passive: true });
grid.addEventListener("wheel", noteGridScrollActivity, { passive: true });
grid.addEventListener("touchmove", noteGridScrollActivity, { passive: true });

function gridScrollIsActive() {
  return performance.now() - lastGridScrollAt < SCROLL_IDLE_MS;
}

async function waitForGridScrollIdle(signal) {
  while (gridScrollIsActive()) {
    if (signal?.aborted) throw new DOMException("Feed run replaced", "AbortError");
    const remaining = Math.max(16, SCROLL_IDLE_MS - (performance.now() - lastGridScrollAt));
    await new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, remaining);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Feed run replaced", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function ensureVideoSource(video) {
  const source = video.dataset.videoSrc;
  if (source && video.getAttribute("src") !== source) video.src = source;
}

function syncVisibleVideoPlayback() {
  const playAllVisible = Boolean(config && feed().autoplayVideos
    && feed().autoplayAllVisibleVideos);
  const canAutoplay = config && feed().autoplayVideos && !reduceMotion.matches && !document.hidden;
  const selected = selectVideosForPlayback([...visibleVideos.entries()], {
    playAllVisible,
    canAutoplay,
    documentHidden: document.hidden,
  });
  for (const video of grid.querySelectorAll("video")) {
    if (!selected.has(video)) {
      video.pause();
      continue;
    }
    ensureVideoSource(video);
    video.play().catch(() => {});
  }
}

const mediaObserver = new IntersectionObserver((entries) => {
  const playAllVisible = Boolean(config && feed().autoplayVideos
    && feed().autoplayAllVisibleVideos);
  const playbackThreshold = playbackVisibilityThreshold(playAllVisible);
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      visibleVideos.delete(entry.target);
      entry.target.dataset.manualPlay = "false";
      entry.target.dataset.manualPause = "false";
      entry.target.pause();
    } else {
      visibleVideos.set(entry.target, entry.intersectionRatio);
      if (entry.intersectionRatio < playbackThreshold) {
        entry.target.dataset.manualPause = "false";
      }
    }
  }
  syncVisibleVideoPlayback();
}, { root: grid, threshold: [0, 0.15, 0.25, 0.5, 0.75, 1] });

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    for (const video of grid.querySelectorAll("video")) video.dataset.manualPlay = "false";
  }
  syncVisibleVideoPlayback();
});
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

function setupGrid({ preserveVideos = new Set(), reason = "unspecified" } = {}) {
  recordScrollDiagnostic("setup-grid-start", { reason });
  if (sentinel) observer.unobserve(sentinel);
  gridResizeObserver.disconnect();
  for (const video of grid.querySelectorAll("video")) {
    if (!preserveVideos.has(video)) video.pause();
  }
  mediaObserver.disconnect();
  visibleVideos.clear();
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
  gridResizeObserver.observe(masonry);
  checkGridGeometry(`setup-grid:${reason}`);
  recordScrollDiagnostic("setup-grid-end", { reason });
}

function observeCard(card) {
  const video = card.querySelector(":scope > a > video");
  if (video) mediaObserver.observe(video);
  viewedObserver.observe(card);
}

function captureReusableMedia() {
  const captured = new Map();
  const gridTop = grid.getBoundingClientRect().top;
  const cards = [...grid.querySelectorAll(".card[data-image-id]")]
    .sort((a, b) => Math.abs(a.getBoundingClientRect().top - gridTop)
      - Math.abs(b.getBoundingClientRect().top - gridTop));
  for (const card of cards) {
    const media = card.querySelector(":scope > a > img, :scope > a > video");
    if (media) captured.set(Number(card.dataset.imageId), media);
    if (captured.size >= 90) break;
  }
  for (const [id, media] of reusableMedia) {
    if (captured.size >= 90) break;
    if (!captured.has(id)) captured.set(id, media);
  }
  return captured;
}

function takeReusableMedia(item, tagName, source) {
  const media = reusableMedia.get(Number(item.id));
  if (!media || media.tagName !== tagName) return null;
  const previousSource = tagName === "VIDEO"
    ? media.dataset.videoSrc : media.getAttribute("src");
  if (previousSource !== source) return null;
  reusableMedia.delete(Number(item.id));
  return media;
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
  remix: [
    ["path", { d: "M4 20c3.5 0 5-1.5 5-5l8-8 3 3-8 8c-3.5 0-5 2-8 2Z" }],
    ["path", { d: "m15 5 4 4" }],
  ],
  prompt: [
    ["path", { d: "M5 4h14v16H5z" }],
    ["path", { d: "M8 8h8M8 12h8M8 16h5" }],
  ],
  resources: [
    ["circle", { cx: "8", cy: "8", r: "3" }],
    ["circle", { cx: "16", cy: "16", r: "3" }],
    ["path", { d: "m10 10 4 4" }],
  ],
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
  for (const [tag, attributes] of CARD_SIGNAL_ICONS[kind]) {
    const part = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value);
    icon.append(part);
  }
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
  // A checkpoint source is already the card's first fact. Repeating that same
  // checkpoint after the creator would add no information. Creator sources and
  // auxiliary sources (LoRA, embedding, collection, Featured) still show the
  // checkpoint actually used by the image as their other fact.
  if (modelSources.some(isCheckpointSource)) return null;
  const versionIds = [...new Set(item.modelVersionIds || [])].slice(0, 10);
  const labels = versionIds.length ? ["model"] : (item.baseModel ? [item.baseModel] : []);
  if (labels.length === 0) return null;

  const container = document.createElement("span");
  container.className = "made-with";
  labels.forEach((label, index) => {
    if (index > 0) container.append(" + ");
    const fallback = versionIds.length === 0 ? BASE_MODEL_LINKS[label] : null;
    const sourcePath = sourceLinks[label] || fallback?.path;
    if (!sourcePath) {
      container.append(cardSourceLabel(fallback?.label || label));
      return;
    }
    const modelLabel = cardSourceLabel(fallback?.label || label);
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
    const playbackSource = videoPlaybackUrl(item.url);
    media = takeReusableMedia(item, "VIDEO", playbackSource) || document.createElement("video");
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
    media.preload = "none";
    media.poster = videoPosterUrl(item.url);
    media.dataset.videoSrc = playbackSource;
    media.setAttribute("aria-label", `Video by ${item.username || "unknown creator"}`);
    videoPlay = document.createElement("span");
    videoPlay.className = "video-play";
    videoPlay.textContent = "▶";
    videoPlay.role = "button";
    videoPlay.tabIndex = 0;
    videoPlay.setAttribute("aria-label", "Play video");
    let controlTimer;
    const revealPlayingControl = () => {
      if (!videoPlay.classList.contains("is-playing")) return;
      videoPlay.classList.add("show-on-interaction");
      clearTimeout(controlTimer);
      controlTimer = setTimeout(() => videoPlay.classList.remove("show-on-interaction"), 650);
    };
    link.addEventListener("pointermove", revealPlayingControl);
    const toggleVideo = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (media.paused) {
        media.dataset.manualPause = "false";
        media.dataset.manualPlay = "true";
        ensureVideoSource(media);
        media.play().catch(() => {});
      } else {
        media.dataset.manualPlay = "false";
        media.dataset.manualPause = "true";
        media.pause();
      }
    };
    videoPlay.addEventListener("click", toggleVideo);
    videoPlay.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") toggleVideo(event);
    });
    media._cmhPlayControl = videoPlay;
    media._cmhRevealPlayControl = revealPlayingControl;
    if (media.dataset.playbackEventsBound !== "true") {
      media.dataset.playbackEventsBound = "true";
      media.addEventListener("play", () => {
        const control = media._cmhPlayControl;
        if (!control) return;
        control.textContent = "❚❚";
        control.classList.add("is-playing");
        control.setAttribute("aria-label", "Pause video");
        media._cmhRevealPlayControl?.();
      });
      media.addEventListener("pause", () => {
        const control = media._cmhPlayControl;
        if (!control) return;
        control.textContent = "▶";
        control.classList.remove("is-playing", "show-on-interaction");
        control.setAttribute("aria-label", "Play video");
      });
    }
    if (!media.paused) videoPlay.classList.add("is-playing");
  } else {
    const imageSource = thumbnailUrl(item.url);
    media = takeReusableMedia(item, "IMG", imageSource) || document.createElement("img");
    media.loading = "lazy";
    media.alt = `Image by ${item.username || "unknown creator"}`;
    if (media.getAttribute("src") !== imageSource) media.src = imageSource;
  }
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
    const displayLabel = cardSourceLabel(label);
    a.textContent = displayLabel;
    a.title = displayLabel;
    const sourcePath = sourceLinks[label] || "/";
    a.href = `https://${domain}${sourcePath}`;
    a.target = "_blank";
    a.rel = "noopener";
    const draft = sourceKinds[label] === "model"
      ? modelDraftFromPath(sourcePath, displayLabel)
      : sourceKinds[label] === "collection" ? collectionDraftFromPath(sourcePath, displayLabel) : null;
    if (draft) installSourceHoverMenu(a, [{ label: displayLabel, draft }]);
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
      if (!await askConfirmation(
        "Hide creator?",
        `Hide all work by @${item.username} in all hubs?`,
        { confirmLabel: "Hide creator" }
      )) return;
      config.settings.hiddenCreators = [...new Set([
        ...config.settings.hiddenCreators, item.username.toLocaleLowerCase(),
      ])].slice(0, 200);
      await saveConfig(config);
      renderHiddenCreators();
      syncFeedControls();
      applyLocalFilters({ reason: "card-hide-creator" });
    });
    stats.append(" · ", hideCreator);
  }

  if (displayedSources.length > 0) info.append(sourcesDiv);
  info.append(byline);
  if (infoSignals) info.append(infoSignals);
  info.append(stats);
  card.append(link, cardActions, info);
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
  collectionPickerCollections = [];
  $("collection-picker-overlay").hidden = false;
  $("collection-picker-list").textContent = "";
  $("collection-picker-save").disabled = true;
  // Account actions use the signed-in Civitai tab; an API key is only a fallback.
  $("collection-picker-status").textContent = "Loading collections…";
  try {
    collectionPickerCollections = (await resolveWritableCollections(
      effectiveApiSettings(), runController?.signal
    )).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, {
      sensitivity: "base", numeric: true,
    }));
    $("collection-picker-status").textContent = collectionPickerCollections.length
      ? "" : "No owned image collections were returned.";
    for (const collection of collectionPickerCollections) {
      const option = document.createElement("label");
      option.className = "collection-picker-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(collection.id);
      checkbox.addEventListener("change", () => {
        $("collection-picker-save").disabled = !$("collection-picker-list").querySelector("input:checked");
      });
      const name = document.createElement("span");
      name.textContent = collection.name;
      option.append(checkbox, name);
      $("collection-picker-list").append(option);
    }
  } catch (error) {
    $("collection-picker-status").textContent = explainCivitaiError(error, {
      action: "Collections", scope: "CollectionsRead access",
    });
  }
}

async function saveCollectionPicker() {
  if (!collectionPickerItem) return;
  const selectedIds = new Set([...$("collection-picker-list").querySelectorAll("input:checked")]
    .map((input) => Number(input.value)));
  const selected = collectionPickerCollections.filter((collection) => selectedIds.has(Number(collection.id)));
  if (selected.length === 0) return;
  const save = $("collection-picker-save");
  save.disabled = true;
  $("collection-picker-status").textContent = `Adding to ${selected.length} collection${selected.length === 1 ? "" : "s"}…`;
  try {
    await addImageToCollections(
      collectionPickerItem.id, selected, effectiveApiSettings(), runController?.signal
    );
    const item = collectionPickerItem;
    item._collected = true;
    $("collection-picker-overlay").hidden = true;
    collectionPickerItem = null;
    collectionPickerCollections = [];
    const message = `Added to ${selected.length} collection${selected.length === 1 ? "" : "s"}.`;
    if (!$("lightbox").hidden && Number($("lightbox").dataset.imageId) === Number(item.id)) {
      $("lightbox-action-status").textContent = message;
    } else setStatus(message);
  } catch (error) {
    $("collection-picker-status").textContent = explainCivitaiError(error, {
      action: "Adding the image to the selected collections",
      scope: "CollectionsWrite access",
      mutation: true,
    });
    save.disabled = false;
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
    const card = reusableCards.get(item.id) || makeCard(item);
    columns[shortest].append(card);
    observeCard(card);
    // Estimate card height by aspect ratio so columns stay balanced. Items
    // with missing dimensions count as square — a NaN here would poison
    // Math.min and crash rendering.
    const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : 1;
    columnHeights[shortest] += ratio + (feed().showCardDetails ? 0.2 : 0);
  }
}

function visibleCardAnchors() {
  const gridTop = grid.getBoundingClientRect().top;
  return [...grid.querySelectorAll(".card[data-image-id]")]
    .map((card) => ({ id: Number(card.dataset.imageId), offset: card.getBoundingClientRect().top - gridTop }))
    .filter((anchor) => anchor.offset >= -40)
    .sort((a, b) => a.offset - b.offset);
}

function rebuildRendered({
  preserveAnchor = false,
  reuseCards = true,
  reason = "unspecified",
} = {}) {
  recordScrollDiagnostic("rebuild-rendered-start", { reason, preserveAnchor, reuseCards });
  const scrollTop = grid.scrollTop;
  const anchors = preserveAnchor ? visibleCardAnchors() : [];
  const reusableCards = reuseCards
    ? new Map([...grid.querySelectorAll(".card[data-image-id]")]
      .map((card) => [Number(card.dataset.imageId), card]))
    : new Map();
  const items = pool.slice(0, renderedCount);
  const itemIds = new Set(items.map((item) => item.id));
  const anchor = anchors.find((candidate) => itemIds.has(candidate.id));
  for (const [id, card] of reusableCards) {
    if (itemIds.has(id) || reusableMedia.size >= 90) continue;
    const media = card.querySelector(":scope > a > img, :scope > a > video");
    if (media) reusableMedia.set(id, media);
  }
  const preserveVideos = new Set(
    [...reusableCards.entries()]
      .filter(([id]) => itemIds.has(id))
      .map(([, card]) => card.querySelector(":scope > a > video"))
      .filter(Boolean)
  );
  for (const media of reusableMedia.values()) {
    if (media.tagName === "VIDEO") preserveVideos.add(media);
  }
  renderedIds = new Set();
  setupGrid({ preserveVideos, reason: `rebuild:${reason}` });
  appendCards(items, reusableCards);
  // Media kept for cards that no longer belong to the rendered prefix remains
  // reusable, but it must not continue playing while detached from the feed.
  for (const media of reusableMedia.values()) {
    if (media.tagName !== "VIDEO") continue;
    media.dataset.manualPlay = "false";
    media.pause();
  }
  renderedIds = new Set(items.map((i) => i.id));
  renderedCount = items.length;
  if (!anchor) {
    grid.scrollTop = scrollTop;
    checkGridGeometry(`rebuild-rendered:${reason}`);
    recordScrollDiagnostic("rebuild-rendered-end", {
      reason,
      itemCount: items.length,
      anchorFound: false,
    });
    return;
  }
  const replacement = grid.querySelector(`.card[data-image-id="${anchor.id}"]`);
  // Emptying the grid clamps scrollTop to 0, so without a restore here a lost
  // anchor drops the reader back to the top of the feed.
  if (!replacement) {
    grid.scrollTop = scrollTop;
    checkGridGeometry(`rebuild-rendered:${reason}`);
    recordScrollDiagnostic("rebuild-rendered-end", {
      reason,
      itemCount: items.length,
      anchorFound: true,
      replacementFound: false,
    });
    return;
  }
  const gridTop = grid.getBoundingClientRect().top;
  grid.scrollTop += replacement.getBoundingClientRect().top - gridTop - anchor.offset;
  checkGridGeometry(`rebuild-rendered:${reason}`);
  recordScrollDiagnostic("rebuild-rendered-end", {
    reason,
    itemCount: items.length,
    anchorFound: true,
    replacementFound: true,
  });
}

function renderInitialPreview(run) {
  if (run !== runId || pool.length === 0) return;
  // Once the first cards are visible they are immutable for this run. Delayed
  // creators are merged into the pool and appended later; replacing the first
  // 15 on every response used to eject the visible card and clamp scroll to 0.
  if (previewedRunId === run) return;
  renderedCount = Math.min(INITIAL_BATCH, pool.length);
  rebuildRendered({ preserveAnchor: true, reuseCards: false, reason: "initial-preview" });
  previewedRunId = run;
  setStatus(`Showing ${renderedCount} while the remaining sources load…`);
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

function applyLocalFilters({ preserveAnchor = true, reason = "local-filter" } = {}) {
  const visibleTarget = Math.max(BATCH, renderedCount);
  rebuildPool();
  renderedCount = Math.min(visibleTarget, pool.length);
  rebuildRendered({ preserveAnchor, reason });
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

async function fetchMorePages(run, signal, { preview = false } = {}) {
  await mapConcurrent(streamsBlockingFrontier(), STREAM_FETCH_CONCURRENCY, async (stream) => {
    try {
      const items = await fetchStreamPage(stream, feedRunApiSettings || effectiveApiSettings(), signal);
      if (run === runId) {
        mergeFetchedItems(items);
        if (preview) renderInitialPreview(run);
      }
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
  return sentinel.getBoundingClientRect().top <= grid.getBoundingClientRect().bottom + LOAD_AHEAD_PX;
}

async function showMore(run = runId) {
  if (loadingRunId === run || run !== runId) return;
  loadingRunId = run;
  const signal = runController?.signal;
  const startedRendered = renderedCount;
  const startedPool = pool.length;
  recordScrollDiagnostic("show-more-start", { requestedRun: run });
  try {
    const target = renderedCount + BATCH;
    let rounds = 0;
    while (run === runId && safeLimit() < target && activeStreams().length > 0 && rounds < 5) {
      rounds += 1;
      setStatus(`Loading… (${pool.length} images fetched)${errorSuffix()}`);
      await fetchMorePages(run, signal);
    }
    if (run !== runId) return;

    // Reveal by filtering unrendered items rather than rebuilding cards already
    // on screen. Engagement pages can re-rank fetched items, but a stable reader
    // is more important than moving a playing video after every network page.
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
    checkGridGeometry("show-more-end");
    recordScrollDiagnostic("show-more-end", {
      requestedRun: run,
      runStillCurrent: run === runId,
      renderedAdded: renderedCount - startedRendered,
      poolAdded: pool.length - startedPool,
    });
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
  { root: grid, rootMargin: `${LOAD_AHEAD_PX}px 0px` }
);

async function startFeed({
  clearImmediately = false,
  refreshData = false,
  reason = "unspecified",
} = {}) {
  recordScrollDiagnostic("start-feed-request", { reason, clearImmediately, refreshData });
  const retainedView = !clearImmediately && masonry
    ? {
        count: grid.querySelectorAll(".card[data-image-id]").length,
        anchorIds: visibleCardAnchors().map(({ id }) => id),
      }
    : null;
  reusableMedia = captureReusableMedia();
  runController?.abort();
  cancelQueuedVersionMetadata();
  runController = new AbortController();
  const signal = runController.signal;
  const run = ++runId;
  recordScrollDiagnostic("start-feed-run", {
    reason,
    requestedRun: run,
    retainedCardCount: retainedView?.count || 0,
  });
  feedRunApiSettings = effectiveApiSettings();
  browsingLevelRefreshPending = false;
  renderBrowsingLevelNote();
  loadingRunId = run;
  previewedRunId = retainedView?.count ? run : null;
  streams = [];
  itemMap = new Map();
  pool = [];
  renderedCount = 0;
  renderedIds = new Set();
  sourceLinks = {};
  sourceKinds = {};
  sourceModelTypes = {};
  runErrors = [];
  renderErrors();
  clearModelCache();
  // Only the user's Refresh action bypasses Civitai's edge cache. Background
  // synchronization and ordinary settings changes keep stable request URLs.
  if (refreshData) setCacheBuster(`${Date.now()}`);
  if (clearImmediately || !masonry) {
    setupGrid({ reason: `start-feed-clear:${reason}` });
    showSkeletons();
    checkGridGeometry(`start-feed-skeletons:${reason}`);
  }

  const f = feed();
  viewedIdSet = new Set(f.viewedIds);
  document.body.classList.toggle("compact", f.density === "compact");
  document.body.classList.toggle("hide-card-details", !f.showCardDetails);
  if (!visitThresholds.has(f.id)) {
    visitThresholds.set(f.id, f.lastVisitedAt);
    f.lastVisitedAt = new Date().toISOString();
    saveConfig(config);
  }
  previousVisitAt = visitThresholds.get(f.id);
  const enabledSources = f.sources.filter((source) => source.enabled !== false);
  if (enabledSources.length === 0) {
    if (loadingRunId === run) loadingRunId = null;
    setupGrid({ reason: `start-feed-empty:${reason}` });
    emptyEl.hidden = false;
    emptyEl.textContent = f.sources.length === 0
      ? "Add a user, model, LoRA or public collection on the left — or browse civitai and use the “Add to MultiHub” button."
      : "All sources in this hub are disabled.";
    setStatus("");
    recordScrollDiagnostic("start-feed-end", { reason, requestedRun: run, emptySources: true });
    return;
  }

  setStatus("Opening sources…");
  try {
    await mapConcurrent(enabledSources, 2, async (source) => {
      try {
        const opened = await openSourceStreams(source, f, feedRunApiSettings, signal);
        if (run === runId) {
          streams.push(...opened);
          for (const s of opened) {
            sourceLinks[s.label] = s.href;
            sourceKinds[s.label] = source.type;
            if (source.type === "model") sourceModelTypes[s.label] = s.modelType || "";
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
    if (activeStreams().length > 0) await fetchMorePages(run, signal, { preview: true });
  } catch (error) {
    if (loadingRunId === run) loadingRunId = null;
    recordScrollDiagnostic("start-feed-error", {
      reason,
      requestedRun: run,
      errorName: error?.name || "Error",
    });
    throw error;
  }
  if (run !== runId) return;
  if (retainedView?.count) {
    // A refresh may finish while wheel/touch momentum is still moving through
    // the retained grid. Replacing it in that moment lets the browser apply the
    // remaining scroll to a briefly empty container and clamp it to the top.
    try {
      recordScrollDiagnostic("start-feed-waiting-for-scroll-idle", { reason, requestedRun: run });
      await waitForGridScrollIdle(signal);
    } catch (error) {
      if (error?.name === "AbortError") {
        if (loadingRunId === run) loadingRunId = null;
        return;
      }
      throw error;
    }
    if (run !== runId) return;
    const liveAnchorIds = visibleCardAnchors().map(({ id }) => id);
    const anchorIds = [...new Set([...liveAnchorIds, ...retainedView.anchorIds])];
    const anchorIndex = anchorIds.reduce((best, id) => {
      const index = pool.findIndex((item) => item.id === id);
      return index >= 0 && (best < 0 || index < best) ? index : best;
    }, -1);
    renderedCount = Math.min(
      pool.length,
      Math.max(INITIAL_BATCH, retainedView.count, anchorIndex + 1)
    );
    rebuildRendered({
      preserveAnchor: true,
      reuseCards: false,
      reason: `start-feed-reconcile:${reason}`,
    });
  } else {
    if (previewedRunId !== run) renderInitialPreview(run);
    if (previewedRunId !== run) setupGrid({ reason: `start-feed-no-preview:${reason}` });
  }
  if (loadingRunId === run) loadingRunId = null;
  await showMore(run);
  checkGridGeometry(`start-feed-end:${reason}`);
  recordScrollDiagnostic("start-feed-end", { reason, requestedRun: run, emptySources: false });
}

// Rebuild the masonry when the column count changes.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const previousColumns = columns.length;
    const nextColumns = columnCount();
    if (panelOnScreen() && previousColumns !== nextColumns) {
      recordScrollDiagnostic("column-count-change", { previousColumns, nextColumns });
      rebuildRendered({ preserveAnchor: true, reason: "column-resize" });
    }
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
  document.body.classList.toggle("compact", feed().density === "compact");
  const cardDetailsButton = $("card-details-toggle");
  const cardDetailsLabel = feed().showCardDetails
    ? "Hide creator and model info" : "Show creator and model info";
  cardDetailsButton.title = cardDetailsLabel;
  cardDetailsButton.setAttribute("aria-label", cardDetailsLabel);
  cardDetailsButton.setAttribute("aria-pressed", String(feed().showCardDetails));
  $("card-details-switch").checked = feed().showCardDetails;
  document.body.classList.toggle("hide-card-details", !feed().showCardDetails);
  $("autoplay-videos").checked = feed().autoplayVideos;
  $("autoplay-all-visible-videos").checked = feed().autoplayAllVisibleVideos;
  $("autoplay-all-visible-videos").disabled = !feed().autoplayVideos;
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
  if (browsingLevelRefreshPending) {
    note.textContent += " Refresh the feed when you want to apply the new level.";
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
      applyLocalFilters({ reason: "hidden-creator-restore" });
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
  startFeed({ clearImmediately: true, reason: "hub-switch" });
}

function bindHubs() {
  $("hub-select").addEventListener("change", (e) => switchHub(e.target.value));

  $("hub-new").addEventListener("click", async () => {
    if (config.feeds.length >= MAX_HUBS) {
      await showNotice("Hub limit reached", `MultiHub supports at most ${MAX_HUBS} hubs.`);
      return;
    }
    const name = await askText(
      "Create a new hub",
      "Choose a name for this hub.",
      `Hub ${config.feeds.length + 1}`,
      {
        inputLabel: "Hub name", maxLength: 30, confirmLabel: "Create hub",
        nativeMessage: "Name for the new hub:",
      }
    );
    if (name === null) return;
    let f;
    try {
      f = makeFeed(name);
    } catch (error) {
      await showNotice("Could not create hub", error.message);
      return;
    }
    config.feeds.push(f);
    await switchHub(f.id);
  });
  $("hub-manage").addEventListener("click", openHubManager);
  $("hub-manager-close").addEventListener("click", closeHubManager);
  $("hub-manager-overlay").addEventListener("click", (event) => {
    if (event.target === $("hub-manager-overlay")) closeHubManager();
  });
  $("hub-manager-new").addEventListener("click", async () => {
    if (config.feeds.length >= MAX_HUBS) {
      $("hub-manager-status").textContent = `MultiHub supports at most ${MAX_HUBS} hubs.`;
      return;
    }
    const name = await askText(
      "Create a new hub",
      "Choose a name for this hub.",
      `Hub ${config.feeds.length + 1}`,
      {
        inputLabel: "Hub name", maxLength: 30, confirmLabel: "Create hub",
        nativeMessage: "Name for the new hub:",
      }
    );
    if (name === null) return;
    let hub;
    try {
      hub = makeFeed(name);
    } catch (error) {
      $("hub-manager-status").textContent = error.message;
      return;
    }
    config.feeds.push(hub);
    await switchHub(hub.id);
    renderHubManager();
  });
  $("hub-manager-rename").addEventListener("click", async () => {
    if (selectedHubIds.size !== 1) return;
    const hub = config.feeds.find((candidate) => selectedHubIds.has(candidate.id));
    if (!hub) return;
    const name = await askText(
      "Rename hub",
      `Choose a new name for “${hub.name}”.`,
      hub.name,
      {
        inputLabel: "Hub name", maxLength: 30, confirmLabel: "Rename",
        nativeMessage: "New name for this hub:",
      }
    );
    if (name === null) return;
    try {
      hub.name = normalizeNewHubName(name);
    } catch (error) {
      $("hub-manager-status").textContent = error.message;
      return;
    }
    await saveConfig(config);
    renderHubs();
    renderHubManager();
  });
  $("hub-manager-export").addEventListener("click", () => {
    const selected = config.feeds.filter((hub) => selectedHubIds.has(hub.id));
    if (selected.length > 0) exportFeeds(selected);
  });
  $("hub-manager-delete").addEventListener("click", async () => {
    const selected = config.feeds.filter((hub) => selectedHubIds.has(hub.id));
    if (selected.length === 0) return;
    if (!await askConfirmation(
      "Delete selected hubs?",
      `Delete ${selected.length} selected hub${selected.length === 1 ? "" : "s"} and all of their sources?`,
      { confirmLabel: "Delete" }
    )) return;
    const removedIds = new Set(selected.map((hub) => hub.id));
    config.feeds = config.feeds.filter((hub) => !removedIds.has(hub.id));
    if (config.feeds.length === 0) config.feeds.push(makeFeed("My hub"));
    if (removedIds.has(config.defaultFeedId)) config.defaultFeedId = null;
    if (!config.feeds.some((hub) => hub.id === config.activeFeedId)) {
      config.activeFeedId = config.defaultFeedId || config.feeds[0].id;
    }
    selectedHubIds = new Set();
    await saveConfig(config);
    renderHubs();
    renderHubManager();
    renderSources();
    syncFeedControls();
    startFeed({ clearImmediately: true, reason: "hub-manager-delete" });
  });
  $("hub-manager-import").addEventListener("click", () => $("hub-manager-import-file").click());
  $("hub-manager-import-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await importHubsFromFile(file, true);
    event.target.value = "";
  });
}

function bindSettings() {
  $("link-domain").value = effectiveLinkDomain();
  $("link-domain").disabled = Boolean(embeddedHost);
  $("link-domain").title = embeddedHost
    ? `Embedded MultiHub links stay on ${embeddedHost}` : "Choose where Civitai links open";
  syncFeedControls();

  $("reset-scroll-diagnostics").addEventListener("click", () => {
    resetScrollDiagnostics();
    $("scroll-diagnostics-output").hidden = true;
    $("scroll-diagnostics-status").textContent = "Reset. Reproduce the jump, then copy the diagnostics.";
  });
  $("copy-scroll-diagnostics").addEventListener("click", copyScrollDiagnostics);

  $("global-sort").addEventListener("change", async (e) => {
    feed().globalSort = e.target.value;
    await saveConfig(config);
    startFeed({ reason: "sort-change" });
  });
  $("period").addEventListener("change", async (e) => {
    feed().period = e.target.value;
    await saveConfig(config);
    startFeed({ reason: "period-change" });
  });
  for (const [id, property] of [
    ["media-type", "mediaType"],
    ["aspect-ratio", "aspectRatio"],
    ["generation-filter", "generationFilter"],
  ]) {
    $(id).addEventListener("change", async (e) => {
      feed()[property] = e.target.value;
      await saveConfig(config);
      applyLocalFilters({ reason: `${property}-change` });
    });
  }
  $("density").addEventListener("change", async (e) => {
    feed().density = e.target.value;
    document.body.classList.toggle("compact", feed().density === "compact");
    await saveConfig(config);
    rebuildRendered({ preserveAnchor: true, reason: "density-change" });
  });
  const setCardDetailsVisibility = async (showCardDetails) => {
    feed().showCardDetails = showCardDetails;
    await saveConfig(config);
    syncFeedControls();
    rebuildRendered({ preserveAnchor: true, reason: "card-details-change" });
  };
  $("card-details-toggle").addEventListener("click", async () => {
    await setCardDetailsVisibility(!feed().showCardDetails);
  });
  $("card-details-switch").addEventListener("change", async (event) => {
    await setCardDetailsVisibility(event.target.checked);
  });
  $("autoplay-videos").addEventListener("change", async (e) => {
    feed().autoplayVideos = e.target.checked;
    await saveConfig(config);
    syncFeedControls();
    syncVisibleVideoPlayback();
  });
  $("autoplay-all-visible-videos").addEventListener("change", async (e) => {
    feed().autoplayAllVisibleVideos = e.target.checked;
    await saveConfig(config);
    syncVisibleVideoPlayback();
  });
  $("hide-viewed").addEventListener("change", async (e) => {
    feed().hideViewed = e.target.checked;
    await saveConfig(config);
    applyLocalFilters({ reason: "hide-viewed-change" });
  });
  $("clear-viewed").addEventListener("click", async () => {
    if (!await askConfirmation(
      "Clear viewed history?",
      "Clear viewed-image history for this hub?",
      { confirmLabel: "Clear history" }
    )) return;
    feed().viewedIds = [];
    viewedIdSet = new Set();
    await saveConfig(config);
    applyLocalFilters({ reason: "clear-viewed-history" });
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
    applyLocalFilters({ reason: "hidden-creator-add" });
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
    startFeed({ reason: "link-domain-change" });
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
    startFeed({ refreshData: true, reason: "manual-refresh" });
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
        const versions = await askText(
          "Choose model versions",
          `Enter comma-separated version IDs or “all”.\n\n${versionHelp}`,
          draft.versionIds?.join(", ") || "all",
          {
            inputLabel: "Version IDs", maxLength: 1000, confirmLabel: "Use versions",
            nativeMessage: `Choose model versions now. Enter comma-separated IDs or "all":\n${versionHelp}`,
          }
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
    startFeed({ reason: "source-add" });
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
    startFeed({ reason: "api-key-remove" });
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
    sidebarResizeTimer = setTimeout(() => rebuildRendered({
      preserveAnchor: true,
      reason: "sidebar-resize",
    }), 220);
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
    applyLocalFilters({ reason: "group-posts-change" });
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
    const destination = await chooseDestination(move ? "Move" : "Copy");
    if (!destination) return;
    const selected = feed().sources.filter((source) => selectedSourceIds.has(source.id));
    for (const source of selected) copySourceTo(source, destination);
    if (move) feed().sources = feed().sources.filter((source) => !selectedSourceIds.has(source.id));
    selectedSourceIds = new Set();
    await saveConfig(config);
    renderHubs();
    renderSources();
    startFeed({ reason: move ? "bulk-source-move" : "bulk-source-copy" });
  }
  $("source-manage").addEventListener("click", () => {
    sourceManageMode = !sourceManageMode;
    if (!sourceManageMode) selectedSourceIds = new Set();
    renderSources();
  });
  $("source-toggle-all").addEventListener("click", async () => {
    const enable = !feed().sources.some((source) => source.enabled !== false);
    for (const source of feed().sources) source.enabled = enable;
    await saveConfig(config);
    renderSources();
    startFeed({ reason: "bulk-source-toggle" });
  });
  $("bulk-select-all").addEventListener("click", () => {
    selectedSourceIds = new Set(feed().sources.map((source) => source.id));
    renderSources();
  });
  $("bulk-deselect-all").addEventListener("click", () => {
    selectedSourceIds = new Set();
    renderSources();
  });
  $("bulk-copy").addEventListener("click", () => transferSelected(false));
  $("bulk-move").addEventListener("click", () => transferSelected(true));
  $("bulk-remove").addEventListener("click", async () => {
    const count = selectedSourceIds.size;
    if (!count || !await askConfirmation(
      "Remove selected sources?",
      `Remove ${count} selected source${count === 1 ? "" : "s"} from this hub?`,
      { confirmLabel: "Remove" }
    )) return;
    feed().sources = feed().sources.filter((source) => !selectedSourceIds.has(source.id));
    selectedSourceIds = new Set();
    await saveConfig(config);
    renderHubs();
    renderSources();
    startFeed({ reason: "bulk-source-remove" });
  });
}

async function importHubsFromFile(file, keepManagerOpen = false) {
  try {
    const imported = importFeeds(await file.text());
    if (config.feeds.length + imported.length > MAX_HUBS) {
      throw new Error(`Import would exceed the ${MAX_HUBS}-hub limit`);
    }
    config.feeds.push(...imported);
    await switchHub(imported[imported.length - 1].id);
    const sourceCount = imported.reduce((total, hub) => total + hub.sources.length, 0);
    setStatus(`Imported ${imported.length} hub${imported.length === 1 ? "" : "s"} (${sourceCount} sources).`);
    if (keepManagerOpen) {
      $("hub-manager-status").textContent = `Imported ${imported.length} hub${imported.length === 1 ? "" : "s"}.`;
      renderHubManager();
    }
  } catch (error) {
    const message = `Import failed: ${error.message}`;
    setStatus(message);
    if (keepManagerOpen) $("hub-manager-status").textContent = message;
  }
}

function bindShare() {
  $("export").addEventListener("click", () => exportFeed(feed()));
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await importHubsFromFile(file);
    e.target.value = "";
  });
}

function sourceFetchSignature(source) {
  const identity = { type: source.type, enabled: source.enabled !== false };
  if (source.type === "user") identity.username = source.username;
  else if (source.type === "model") {
    identity.modelId = source.modelId;
    identity.versionIds = source.versionIds || [];
  } else if (source.type === "collection") identity.collectionId = source.collectionId;
  return identity;
}

function feedFetchSignature(candidate) {
  const current = activeFeed(candidate);
  const scope = embeddedHost || "standalone";
  return JSON.stringify({
    activeFeedId: candidate.activeFeedId,
    // Labels, aliases, cached version names and source IDs do not change a
    // request. Excluding them prevents a storage normalization pass from
    // restarting a feed that the reader is already scrolling through.
    sources: current.sources.map(sourceFetchSignature),
    globalSort: current.globalSort,
    period: current.period,
    linkDomain: embeddedHost || candidate.settings.linkDomain,
    apiKey: candidate.settings.apiKey,
    maxVersionsPerModel: candidate.settings.maxVersionsPerModel,
    browsingLevels: candidate.settings.browsingLevelsByDomain?.[scope] || [],
  });
}

function feedDisplaySignature(candidate) {
  const current = activeFeed(candidate);
  return JSON.stringify({
    activeFeedId: candidate.activeFeedId,
    mediaType: current.mediaType,
    generationFilter: current.generationFilter,
    hideViewed: current.hideViewed,
    aspectRatio: current.aspectRatio,
    density: current.density,
    showCardDetails: current.showCardDetails,
    groupPosts: current.groupPosts,
    hiddenCreators: candidate.settings.hiddenCreators,
  });
}

function feedPlaybackSignature(candidate) {
  const current = activeFeed(candidate);
  return JSON.stringify({
    activeFeedId: candidate.activeFeedId,
    autoplayVideos: current.autoplayVideos,
    autoplayAllVisibleVideos: current.autoplayAllVisibleVideos,
  });
}

// Sources can be added from Civitai pages while this panel is open. Storage
// changes are precise enough to synchronize directly; a generic focus reload
// used to turn ordinary tab switching into a destructive full feed restart.
chrome.storage.onChanged.addListener((changes, area) => {
  const relevantLocal = area === "local" && (
    changes.feeds || changes.settings || changes.activeFeedId || changes.defaultFeedId || changes.apiKey
  );
  const relevantSession = area === "session" && changes.apiKey;
  if (!relevantLocal && !relevantSession) return;
  const changedKeys = Object.keys(changes).sort();
  recordScrollDiagnostic("storage-change", { area, changedKeys });
  reloadFromStorage({ area, changedKeys }).catch((error) => {
    recordScrollDiagnostic("storage-reload-error", {
      area,
      changedKeys,
      errorName: error?.name || "Error",
    });
  });
});

async function reloadFromStorage({ area = "unknown", changedKeys = [] } = {}) {
  if (!config) return;
  recordScrollDiagnostic("storage-reload-start", { area, changedKeys });
  const fresh = await loadConfig();
  const feedsChanged = JSON.stringify(fresh.feeds) !== JSON.stringify(config.feeds);
  const activeFeedChanged = fresh.activeFeedId !== config.activeFeedId;
  const defaultFeedChanged = fresh.defaultFeedId !== config.defaultFeedId;
  const settingsChanged = JSON.stringify(fresh.settings) !== JSON.stringify(config.settings);
  const fetchChanged = feedFetchSignature(fresh) !== feedFetchSignature(config);
  const displayChanged = feedDisplaySignature(fresh) !== feedDisplaySignature(config);
  const playbackChanged = feedPlaybackSignature(fresh) !== feedPlaybackSignature(config);
  if (!feedsChanged && !activeFeedChanged && !defaultFeedChanged && !settingsChanged) {
    recordScrollDiagnostic("storage-reload-result", {
      area,
      changedKeys,
      outcome: "no-config-difference",
    });
    return;
  }
  const apiKeyChanged = fresh.settings.apiKey !== config.settings.apiKey;
  recordScrollDiagnostic("storage-reload-result", {
    area,
    changedKeys,
    outcome: fetchChanged ? "refetch" : displayChanged ? "local-rebuild"
      : playbackChanged ? "playback-update" : "controls-only",
    feedsChanged,
    activeFeedChanged,
    defaultFeedChanged,
    settingsChanged,
    fetchChanged,
    displayChanged,
    playbackChanged,
    apiKeyChanged,
  });
  config = fresh;
  if (apiKeyChanged) resetCivitaiCapabilities();
  if (feedsChanged || activeFeedChanged || defaultFeedChanged) renderHubs();
  if (feedsChanged || activeFeedChanged) renderSources();
  syncFeedControls();
  if (fetchChanged) startFeed({ reason: "storage-fetch-signature" });
  else if (displayChanged) applyLocalFilters({
    preserveAnchor: true,
    reason: "storage-display-signature",
  });
  else if (playbackChanged) syncVisibleVideoPlayback();
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
    startFeed({ refreshData: true, reason: "retry-errors" });
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
    collectionPickerCollections = [];
  };
  $("collection-picker-close").addEventListener("click", closePicker);
  $("collection-picker-save").addEventListener("click", saveCollectionPicker);
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
  $("source-editor-copy").addEventListener("click", () => openSourceTransfer("copy"));
  $("source-editor-move").addEventListener("click", () => openSourceTransfer("move"));
  $("source-transfer-create-toggle").addEventListener("click", () => {
    $("source-transfer-create").hidden = !$("source-transfer-create").hidden;
    if (!$("source-transfer-create").hidden) $("source-transfer-new-name").focus();
  });
  $("source-transfer-new-name").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("source-transfer-create-confirm").click();
  });
  $("source-transfer-create-confirm").addEventListener("click", async () => {
    if (config.feeds.length >= MAX_HUBS) {
      showSourceEditorError(`MultiHub supports at most ${MAX_HUBS} hubs.`);
      return;
    }
    let destination;
    try {
      destination = makeFeed($("source-transfer-new-name").value);
    } catch (error) {
      showSourceEditorError(error.message);
      return;
    }
    config.feeds.push(destination);
    if (!await transferEditedSource(destination)) {
      config.feeds = config.feeds.filter((hub) => hub.id !== destination.id);
    }
  });
  $("source-editor-version-mode").addEventListener("change", (event) => {
    $("source-editor-version-list").hidden = event.target.value === "all";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("source-editor-overlay").hidden) closeSourceEditor();
  });
  $("source-editor").addEventListener("submit", async (event) => {
    event.preventDefault();
    const draft = sourceEditorDraft();
    if (!draft) return;
    delete draft.source.alias;
    delete draft.source.versionIds;
    delete draft.source.versionNames;
    delete draft.source._availableVersionNames;
    Object.assign(draft.source, draft.updated);
    await saveConfig(config);
    selectedSourceIds.delete(draft.source.id);
    closeSourceEditor();
    renderHubs();
    renderSources();
    startFeed({ reason: "source-edit" });
  });
}

(async function init() {
  try {
    bindAppDialog();
    config = await loadConfig();
    if (config.defaultFeedId && config.feeds.some((hub) => hub.id === config.defaultFeedId)) {
      config.activeFeedId = config.defaultFeedId;
    }

    // Render stored state before binding the rest of the UI. If a later setup
    // step fails, Firefox users still see their hubs and a useful startup error
    // instead of an unexplained blank selector.
    renderHubs();
    renderSources();
    await saveConfig(config); // persist migration to the multi-hub format
    bindHubs();
    bindPanels();
    bindLightbox();
    bindSourceEditor();
    bindSettings();
    bindAddSource();
    bindBulkSources();
    bindShare();
    recordScrollDiagnostic("diagnostics-session-start", {
      recoveredEventCount: scrollDiagnostics.length,
    });
    gridGeometryBaseline = gridMetrics();
    startFeed({ reason: "initial-load" });
    // Best-effort and asynchronous: the feed starts on the stored levels. If
    // Civitai reports a change, advertise it without replacing a feed that the
    // reader may already have scrolled through; Refresh applies it explicitly.
    syncBrowsingLevelsFromCivitai().then((changed) => {
      if (changed) browsingLevelRefreshPending = true;
      renderBrowsingLevelNote();
      watchCivitaiBrowsingLevel();
    }).catch((error) => console.warn("Could not sync Civitai browsing levels", error));
  } catch (error) {
    showStartupError(error);
  }
})();
