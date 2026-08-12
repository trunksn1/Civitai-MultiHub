import test from "node:test";
import assert from "node:assert/strict";

import {
  importFeed,
  loadConfig,
  makeFeed,
  mergeSourceIntoFeed,
  normalizeNewHubName,
  normalizeConfig,
  parseSourceInput,
  persistentConfig,
  saveConfig,
} from "../extension/storage.js";

test("new hub names are trimmed and bounded before persistence", () => {
  assert.equal(normalizeNewHubName("  Landscapes  "), "Landscapes");
  assert.equal(makeFeed("  Landscapes  ").name, "Landscapes");
  assert.throws(() => normalizeNewHubName("   "), /between 1 and 80/);
  assert.throws(() => normalizeNewHubName("x".repeat(81)), /between 1 and 80/);
});

test("parseSourceInput recognizes supported forms and rejects malformed input", () => {
  assert.deepEqual(parseSourceInput("https://civitai.com/models/42?modelVersionId=7"), {
    type: "model", modelId: 42, versionIds: [7],
  });
  assert.deepEqual(parseSourceInput("https://civitai.red/collections/5205910"), {
    type: "collection", collectionId: 5205910,
  });
  assert.equal(parseSourceInput("not a username"), null);
  assert.equal(parseSourceInput("https://civitai.green/models/42"), null);
  assert.equal(parseSourceInput("@not a username!"), null);
  assert.deepEqual(parseSourceInput("@Valid.User"), { type: "user", username: "Valid.User" });
  assert.equal(parseSourceInput(null), null);
});

test("mergeSourceIntoFeed canonicalizes users and merges model versions", () => {
  const feed = { sources: [] };
  assert.equal(mergeSourceIntoFeed(feed, { type: "user", username: " Alice " }).status, "added");
  assert.equal(mergeSourceIntoFeed(feed, { type: "user", username: "alice" }).status, "duplicate");
  assert.equal(mergeSourceIntoFeed(feed, {
    type: "model", modelId: 12, versionIds: [1],
  }).status, "added");
  assert.equal(mergeSourceIntoFeed(feed, {
    type: "model", modelId: 12, versionIds: [2],
  }).status, "merged");
  assert.deepEqual(feed.sources[1].versionIds, [1, 2]);
  assert.equal(mergeSourceIntoFeed(feed, {
    type: "collection", collectionId: 5205910, label: "Collection: Highly creative",
  }).status, "added");
  assert.equal(mergeSourceIntoFeed(feed, {
    type: "collection", collectionId: 5205910,
  }).status, "duplicate");
});

test("normalizeConfig repairs stored values and deduplicates sources", () => {
  const config = normalizeConfig({
    settings: { linkDomain: "evil.example", maxVersionsPerModel: 999 },
    feeds: [{
      id: "hub", name: " Test ", globalSort: "bad", period: "bad",
      hiddenCreators: ["BlockedUser"],
      sources: [
        { type: "user", username: "Alice" },
        { type: "user", username: "alice" },
        { type: "model", modelId: -1 },
      ],
    }],
    activeFeedId: "missing",
  });
  assert.equal(config.settings.linkDomain, "civitai.com");
  assert.equal(config.settings.maxVersionsPerModel, 50);
  assert.deepEqual(config.settings.hiddenCreators, ["blockeduser"]);
  // civitai.red is the mature host, so nothing is withheld by default there.
  assert.deepEqual(config.settings.browsingLevelsByDomain["civitai.red"], [1, 2, 4, 8, 16]);
  assert.deepEqual(config.settings.browsingLevelsByDomain["civitai.com"], [1, 2]);
  assert.deepEqual(config.settings.browsingLevelsByDomain.standalone, [1, 2]);
  assert.equal(config.feeds[0].globalSort, "newest");
  assert.equal(config.feeds[0].period, "AllTime");
  assert.equal(config.feeds[0].generationFilter, "all");
  assert.equal(config.feeds[0].sources.length, 1);
  assert.equal(config.activeFeedId, "hub");
});

test("API keys are excluded from normalized hub/settings configuration", () => {
  const config = normalizeConfig({
    settings: { apiKey: "must-never-persist" },
    feeds: [{ id: "hub", name: "Test", sources: [] }],
    activeFeedId: "hub",
  });
  assert.equal(config.settings.apiKey, "");
  config.settings.apiKey = "runtime-only";
  const stored = persistentConfig(config);
  assert.equal("apiKey" in stored.settings, false);
  assert.doesNotMatch(JSON.stringify(stored), /runtime-only/);
});

function fakeStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const selected = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in data) selected[key] = data[key];
      }
      return selected;
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}

test("saveConfig keeps keys session-only unless persistence is explicitly selected", async () => {
  const local = fakeStorageArea();
  const session = fakeStorageArea();
  globalThis.chrome = { storage: { local, session } };
  const config = normalizeConfig({ feeds: [{ id: "hub", name: "Test", sources: [] }] });

  config.settings.apiKey = "session-key";
  await saveConfig(config);
  assert.equal(session.data.apiKey, "session-key");
  assert.equal(local.data.apiKey, undefined);

  config.settings.rememberApiKey = true;
  await saveConfig(config);
  assert.equal(local.data.apiKey, "session-key");
  assert.equal(local.data.settings.rememberApiKey, true);

  config.settings.rememberApiKey = false;
  await saveConfig(config);
  assert.equal(local.data.apiKey, undefined);
  assert.equal(session.data.apiKey, "session-key");

  config.settings.apiKey = "";
  await saveConfig(config);
  assert.equal(local.data.apiKey, undefined);
  assert.equal(session.data.apiKey, undefined);
  delete globalThis.chrome;
});

test("loadConfig preserves an existing persistent-key choice without putting it in settings", async () => {
  const local = fakeStorageArea({
    apiKey: "existing-persistent-key",
    settings: { linkDomain: "civitai.com" },
    feeds: [{ id: "hub", name: "Test", sources: [] }],
    activeFeedId: "hub",
  });
  const session = fakeStorageArea();
  globalThis.chrome = { storage: { local, session } };

  const config = await loadConfig();
  assert.equal(config.settings.apiKey, "existing-persistent-key");
  assert.equal(config.settings.rememberApiKey, true);
  assert.equal("apiKey" in local.data.settings, false);
  delete globalThis.chrome;
});

test("importFeed strictly validates enums, ids, and version lists", () => {
  const base = { name: "Shared", globalSort: "newest", period: "AllTime", sources: [] };
  assert.equal(importFeed(JSON.stringify({ format: "CMH1", feed: base })).name, "Shared");
  assert.throws(() => importFeed(JSON.stringify({
    format: "CMH1", feed: { ...base, globalSort: "surprise" },
  })), /sort/);
  assert.throws(() => importFeed(JSON.stringify({
    format: "CMH1",
    feed: { ...base, sources: [{ type: "model", modelId: 2, versionIds: [1, 1] }] },
  })), /versionIds/);
  const imported = importFeed(JSON.stringify({
    format: "CMH1",
    feed: { ...base, sources: [{ id: "shared-source-id", type: "user", username: "Alice" }] },
  }));
  assert.notEqual(imported.sources[0].id, "shared-source-id");
});
