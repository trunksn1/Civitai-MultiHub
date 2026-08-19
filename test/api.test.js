import test from "node:test";
import assert from "node:assert/strict";

import {
  clearModelCache, resolveModel, resolveCreatorProfile, resolveCollection,
  openSourceStreams, fetchStreamPage,
  resolveImageGenerationData, resolveImageComments,
  toggleImageReaction, resolveWritableCollections, addImageToCollection, addImageToCollections,
  postComment, resolveAccountBrowsingLevels, userAvatarUrl, imageBuzzAmount,
  thumbnailUrl, videoPlaybackUrl, videoPosterUrl,
  CIVITAI_CAPABILITIES, getCivitaiCapabilityState, resetCivitaiCapabilities,
  explainCivitaiError,
} from "../extension/civitai-api.js";

test("Buzz donations are normalized as a read-only non-negative count", () => {
  assert.equal(imageBuzzAmount({ stats: { tippedAmountCountAllTime: 125.9 } }), 125);
  assert.equal(imageBuzzAmount({ stats: { tippedAmountCount: 7 } }), 7);
  assert.equal(imageBuzzAmount({ stats: { tippedAmountCountAllTime: -2 } }), 0);
  assert.equal(imageBuzzAmount({ stats: {} }), 0);
});

test("creator profiles provide and cache the avatar omitted by REST image feeds", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  const key = "d22de7f7-ba00-4354-b912-8241d75be9a3";
  globalThis.fetch = async (url) => {
    requested.push(decodeURIComponent(url));
    return {
      ok: true,
      json: async () => ({ result: { data: { json: {
        id: 7, username: "Alice", profilePicture: { url: key },
      } } } }),
    };
  };
  try {
    clearModelCache();
    const first = await resolveCreatorProfile("Alice", { linkDomain: "civitai.com" });
    const second = await resolveCreatorProfile("alice", { linkDomain: "civitai.com" });
    assert.equal(first.profilePicture.url, key);
    assert.equal(second.id, 7);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /user\.getCreator/);
    assert.match(requested[0], /"username":"Alice"/);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

function devalueFixture(root) {
  const values = [];
  const seen = new Map();

  function flatten(value) {
    if (value === undefined) return -1;
    if (typeof value === "number") {
      if (Number.isNaN(value)) return -3;
      if (value === Infinity) return -4;
      if (value === -Infinity) return -5;
      if (Object.is(value, -0)) return -6;
    }
    const known = value && typeof value === "object" ? seen.get(value) : undefined;
    if (known !== undefined) return known;
    const index = values.length;
    if (typeof value === "bigint") {
      values.push(["BigInt", String(value)]);
    } else if (value instanceof Date) {
      values.push(["Date", value.toISOString()]);
    } else if (!value || typeof value !== "object") {
      values.push(value);
    } else {
      seen.set(value, index);
      values.push(null);
      values[index] = Array.isArray(value)
        ? value.map(flatten)
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, flatten(item)]));
    }
    return index;
  }

  flatten(root);
  return JSON.stringify(values);
}

test("public image collections resolve and paginate as first-class sources", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push(decodeURIComponent(url));
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes("collection.getById")) return {
      ok: true,
      json: async () => ({ result: { data: { json: {
        collection: { id: 5205910, name: "Highly creative", type: "Image" },
      } } } }),
    };
    return {
      ok: true,
      json: async () => ({ result: { data: { json: {
        nextCursor: "next-page",
        items: [{
          id: 10, url: "collection-storage-key", name: "painting.png", type: "image",
          width: 800, height: 1200, createdAt: "2026-07-12T10:00:00.000Z",
          nsfwLevel: 2, user: { username: "Alice" }, modelVersionIdsManual: [77],
          stats: {
            likeCountAllTime: 8, heartCountAllTime: 3, commentCountAllTime: 2,
            tippedAmountCountAllTime: 125,
          },
        }],
      } } } }),
    };
  };
  try {
    clearModelCache();
    const settings = { browsingLevel: 3 };
    const collection = await resolveCollection(5205910, settings);
    assert.equal(collection.name, "Highly creative");
    const [stream] = await openSourceStreams(
      { type: "collection", collectionId: 5205910 },
      { globalSort: "newest", period: "AllTime" }, settings
    );
    assert.equal(stream.label, "Collection: Highly creative");
    assert.equal(stream.modelType, undefined);
    const items = await fetchStreamPage(stream, settings);
    assert.equal(items[0].username, "Alice");
    assert.equal(items[0].url,
      "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/collection-storage-key/original=true/painting.jpeg");
    assert.equal(items[0].stats.likeCount, 8);
    assert.equal(items[0].stats.commentCount, 2);
    assert.equal(items[0].stats.tippedAmountCount, 125);
    assert.deepEqual(items[0].modelVersionIds, [77]);
    assert.match(decodeURIComponent(stream.nextUrl), /"cursor":"next-page"/);
    assert.match(requested.find((url) => url.includes("image.getInfinite")), /"collectionId":5205910/);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("collection reads decode Civitai devalue responses through the signed-in session", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("The direct API transport should not be used");
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.operation === "get-collection") {
          callback({
            ok: true,
            status: 200,
            payload: { result: { data: devalueFixture({
              collection: { id: 5205910, name: "Highly creative", type: "Image" },
            }) } },
          });
          return;
        }
        callback({
          ok: true,
          status: 200,
          payload: { result: { data: devalueFixture({
            nextCursor: 9007199254740993n,
            items: [{
              id: 10,
              url: "collection-storage-key",
              name: "painting.png",
              type: "image",
              width: 800,
              height: 1200,
              createdAt: new Date("2026-07-12T10:00:00.000Z"),
              nsfwLevel: 2,
              user: { username: "Alice" },
              stats: { likeCountAllTime: 8 },
            }],
          }) } },
        });
      },
    },
  };
  try {
    clearModelCache();
    const settings = { browsingLevel: 3, linkDomain: "civitai.red" };
    const [stream] = await openSourceStreams(
      { type: "collection", collectionId: 5205910 },
      { globalSort: "newest", period: "AllTime" },
      settings
    );
    const items = await fetchStreamPage(stream, settings);
    assert.equal(fetchCalls, 0);
    assert.equal(items[0].username, "Alice");
    assert.equal(items[0].createdAt, "2026-07-12T10:00:00.000Z");
    assert.match(decodeURIComponent(stream.nextUrl), /"cursor":"9007199254740993"/);
    assert.deepEqual(messages.map((message) => message.operation), [
      "get-collection",
      "get-collection-page",
    ]);
    assert.equal(messages[0].collectionId, 5205910);
    assert.equal(messages[0].preferredHost, "civitai.red");
    assert.equal(messages[1].collectionInput.collectionId, 5205910);
    assert.equal(messages[1].collectionInput.limit, 30);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
    clearModelCache();
  }
});

test("resolveModel propagates cancellation without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(
        new DOMException("The operation was aborted", "AbortError")
      ), { once: true });
    });
  };
  try {
    clearModelCache();
    const controller = new AbortController();
    const pending = resolveModel(123, {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

// With no extension runtime present the session request cannot be made, which is
// the same position the panel is in when no Civitai tab is open: it falls back to
// a direct API call, using the key when there is one.
test("resolveImageGenerationData unwraps Civitai's read-only tRPC response", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    assert.equal(options.headers.Authorization, "Bearer test-key");
    return {
      ok: true,
      json: async () => ({
        result: { data: { json: { meta: { prompt: "hello" }, resources: [{ modelName: "Test" }] } } },
      }),
    };
  };
  try {
    clearModelCache();
    const data = await resolveImageGenerationData(123, { apiKey: "test-key" });
    assert.equal(data.meta.prompt, "hello");
    assert.equal(data.resources[0].modelName, "Test");
    assert.match(requestedUrl, /image\.getGenerationData/);
    assert.match(decodeURIComponent(requestedUrl), /"id":123/);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("resolveImageComments reads a thread, then the replies to each comment", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push(decodeURIComponent(String(url)));
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const replyPage = String(url).includes(encodeURIComponent('"entityType":"comment"'));
    return {
      ok: true,
      json: async () => ({
        result: { data: { json: { comments: replyPage
          ? [{ id: 99, content: "Yes", user: { username: "Bob" } }]
          : [{ id: 7, content: "Hello", user: { username: "Alice" } }] } } },
      }),
    };
  };
  try {
    clearModelCache();
    const data = await resolveImageComments(456, { apiKey: "test-key" });
    assert.equal(data.comments[0].user.username, "Alice");
    assert.equal(data.comments[0].replies[0].user.username, "Bob");
    assert.ok(requested.every((url) => url.includes("commentv2.getInfinite")), requested.join(" "));
    // The image's own thread first, then the child thread of its one comment.
    assert.match(requested[0], /"entityId":456,"entityType":"image","limit":8/);
    assert.match(requested[1], /"entityId":7,"entityType":"comment","limit":10/);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("toggleImageReaction sends one authenticated mutation without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.match(url, /reaction\.toggle$/);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer scoped-key");
    assert.deepEqual(JSON.parse(options.body), {
      json: { entityId: 789, entityType: "image", reaction: "Heart" },
    });
    return { ok: true, text: async () => "" };
  };
  try {
    await toggleImageReaction(789, "Heart", { apiKey: "scoped-key" });
    assert.equal(calls, 1);
    assert.throws(() => toggleImageReaction(789, "Invalid", { apiKey: "scoped-key" }), /Unsupported/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reactions prefer the signed-in Civitai website session without an API key", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback({ ok: true, status: 200, payload: null });
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("The API-key transport must not run for a signed-in reaction");
  };
  try {
    await toggleImageReaction(321, "Like", { linkDomain: "civitai.com" });
    assert.deepEqual(messages, [{
      type: "civitai-account-request",
      operation: "toggle-image-reaction",
      preferredHost: "civitai.com",
      imageId: 321,
      reaction: "Like",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
  }
});

test("feed videos use a lightweight poster and a resized transcoded playback URL", () => {
  const original = "https://image.civitai.com/x/id/original=true/clip.webm";
  assert.equal(thumbnailUrl(original), "https://image.civitai.com/x/id/width=450/clip.webm");
  assert.equal(
    videoPlaybackUrl(original),
    "https://image.civitai.com/x/id/transcode=true,width=450/clip.mp4"
  );
  assert.equal(
    videoPosterUrl(original),
    "https://image.civitai.com/x/id/anim=false,transcode=true,width=450,original=false,optimized=true/clip.jpeg"
  );
});

test("collection account actions prefer the signed-in Civitai session without an API key", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("The API-key transport should not be used");
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.operation === "list-writable-collections") {
          callback({
            ok: true, status: 200,
            payload: { result: { data: { json: [
              { id: 12, name: "Favorites", userId: 3, read: "Public", isOwner: true },
              { id: 13, name: "Contributed", userId: 4, read: "Public", isOwner: false },
            ] } } },
          });
        } else {
          callback({ ok: true, status: 200, payload: null });
        }
      },
    },
  };
  try {
    clearModelCache();
    const settings = { linkDomain: "civitai.red" };
    const collections = await resolveWritableCollections(settings);
    assert.deepEqual(collections.map((collection) => collection.name), ["Favorites"]);
    await addImageToCollections(999, [collections[0], {
      id: 14, name: "Second", userId: 3, read: "Private", isOwner: true,
    }], settings);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(messages[0], {
      type: "civitai-account-request",
      operation: "list-writable-collections",
      preferredHost: "civitai.red",
    });
    assert.deepEqual(messages[1], {
      type: "civitai-account-request",
      operation: "add-image-to-collection",
      preferredHost: "civitai.red",
      imageId: 999,
      collections: [
        { id: 12, userId: 3, read: "Public" },
        { id: 14, userId: 3, read: "Private" },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
    clearModelCache();
  }
});

test("collection account actions explain when neither a signed-in tab nor API key is available", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  delete globalThis.chrome;
  try {
    clearModelCache();
    let error;
    try {
      await resolveWritableCollections({});
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, "session-unavailable");
    const message = explainCivitaiError(error, { action: "Collections" });
    assert.match(message, /signed-in Civitai tab/);
    assert.doesNotMatch(message, /invalid or expired/);
  } finally {
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
    clearModelCache();
  }
});

test("collection account actions fall back to a scoped API key when no Civitai tab is open", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("collection.getAllUser")) return {
      ok: true,
      json: async () => ({ result: { data: { json: [{
        id: 12, name: "Favorites", userId: 3, read: "Public", isOwner: true,
      }] } } }),
    };
    return { ok: true, text: async () => "" };
  };
  try {
    clearModelCache();
    const collections = await resolveWritableCollections({ apiKey: "collection-key" });
    assert.equal(collections[0].name, "Favorites");
    await addImageToCollection(999, collections[0], { apiKey: "collection-key" });
    assert.equal(requests.length, 2);
    assert.match(requests[1].url, /collection\.saveItem$/);
    assert.deepEqual(JSON.parse(requests[1].options.body).json.collections[0], {
      collectionId: 12, userId: 3, read: "Public", tagId: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("a comment is posted as the signed-in tab's own account", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback({
          ok: true, status: 200,
          payload: { result: { data: { json: { id: 42, content: "Nice image" } } } },
        });
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("the signed-in tab must be used before any direct API call");
  };
  try {
    // No API key: being signed in to Civitai is the whole requirement, as on the site.
    const comment = await postComment("image", 321, " Nice image ", { linkDomain: "civitai.red" });
    assert.equal(comment.id, 42);
    assert.deepEqual(messages[0], {
      type: "civitai-account-request",
      operation: "post-comment",
      preferredHost: "civitai.red",
      entityId: 321,
      entityType: "image",
      content: "Nice image", // trimmed before it leaves the panel
    });

    // A reply is the same mutation aimed at the comment's own child thread.
    await postComment("comment", 2274461, "Thanks!", { linkDomain: "civitai.red" });
    assert.equal(messages[1].entityType, "comment");
    assert.equal(messages[1].entityId, 2274461);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
  }
});

test("posting falls back to a SocialWrite mutation and unwraps the comment", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /commentv2\.upsert$/);
    assert.deepEqual(JSON.parse(options.body), {
      json: { entityId: 321, entityType: "image", content: "Nice image" },
    });
    return {
      ok: true,
      text: async () => JSON.stringify({ result: { data: { json: { id: 7, content: "Nice image" } } } }),
    };
  };
  try {
    const comment = await postComment("image", 321, " Nice image ", { apiKey: "social-key" });
    assert.equal(comment.id, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("stream pages normalize non-string usernames before feed filtering", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [
        { id: 1, username: { username: "NestedUser" }, stats: {} },
        { id: 2, username: 12345, user: { username: "FallbackUser" }, stats: {} },
        { id: 3, username: { id: 99 }, stats: {} },
      ],
      metadata: {},
    }),
  });
  try {
    const stream = { nextUrl: "https://civitai.com/api/v1/images?username=test", label: "test" };
    const items = await fetchStreamPage(stream, {});
    assert.deepEqual(items.map((item) => item.username), ["NestedUser", "FallbackUser", null]);
  } finally { globalThis.fetch = originalFetch; }
});

test("stream pages retry a temporary malformed successful response", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => requested.length === 1
        ? { temporary: "upstream response" }
        : { items: [{ id: 4, username: "Recovered", stats: {} }], metadata: {} },
    };
  };
  try {
    const stream = { nextUrl: "https://civitai.com/api/v1/images?username=test", label: "test" };
    const items = await fetchStreamPage(stream, {});
    assert.equal(items[0].username, "Recovered");
    assert.equal(requested.length, 2);
    assert.match(requested[1], /_cmh_retry=1/);
  } finally { globalThis.fetch = originalFetch; }
});

test("API errors expose status without leaking the API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "denied" });
  try {
    resetCivitaiCapabilities();
    await assert.rejects(
      toggleImageReaction(1, "Like", { apiKey: "do-not-leak-this-secret" }),
      (error) => {
        assert.equal(error.code, "permission");
        assert.equal(error.status, 403);
        const explanation = explainCivitaiError(error, {
          action: "Reaction", scope: "SocialWrite access", mutation: true,
        });
        assert.match(explanation, /SocialWrite/);
        assert.doesNotMatch(explanation, /do-not-leak/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetCivitaiCapabilities();
  }
});

test("an unsupported endpoint disables only its capability until reset", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 404, text: async () => "missing" };
  };
  try {
    resetCivitaiCapabilities();
    await assert.rejects(toggleImageReaction(2, "Heart", { apiKey: "key" }), { code: "unsupported" });
    assert.equal(getCivitaiCapabilityState(CIVITAI_CAPABILITIES.reactions).available, false);
    assert.equal(getCivitaiCapabilityState(CIVITAI_CAPABILITIES.comments).available, true);
    await assert.rejects(toggleImageReaction(2, "Heart", { apiKey: "key" }), {
      code: "capability-disabled",
    });
    assert.equal(calls, 1);
    resetCivitaiCapabilities();
    await assert.rejects(toggleImageReaction(2, "Heart", { apiKey: "key" }), { code: "unsupported" });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetCivitaiCapabilities();
  }
});

test("unexpected comment data disables previews without disabling reactions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ result: { data: { json: { unexpected: true } } } }),
  });
  try {
    clearModelCache();
    resetCivitaiCapabilities();
    await assert.rejects(resolveImageComments(808, { apiKey: "key" }), { code: "invalid-response" });
    assert.equal(getCivitaiCapabilityState(CIVITAI_CAPABILITIES.commentPreview).available, false);
    assert.equal(getCivitaiCapabilityState(CIVITAI_CAPABILITIES.reactions).available, true);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
    resetCivitaiCapabilities();
  }
});

test("failed mutations are not retried and report an unconfirmed outcome", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => "temporary" };
  };
  try {
    resetCivitaiCapabilities();
    await assert.rejects(
      postComment("image", 12, "Hello", { apiKey: "key" }),
      (error) => {
        assert.match(explainCivitaiError(error, {
          action: "Posting the comment", mutation: true,
        }), /not confirmed/);
        return true;
      }
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetCivitaiCapabilities();
  }
});

test("mature feeds are requested from civitai.red instead of the SFW host", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      json: async () => ({
        items: [{ id: 1, url: "https://image.civitai.com/a/original=true/a.jpeg", browsingLevel: 16 }],
        // Civitai echoes the requested host; a cross-host cursor must not slip through.
        metadata: { nextPage: "https://civitai.com/api/v1/images?cursor=2" },
      }),
    };
  };
  try {
    clearModelCache();
    const settings = { linkDomain: "civitai.red", browsingLevel: 16 };
    const [stream] = await openSourceStreams(
      { type: "user", username: "alice" },
      { globalSort: "newest", period: "AllTime" },
      settings
    );
    assert.match(stream.nextUrl, /^https:\/\/civitai\.red\/api\/v1\/images\?/);
    // An exact bitmask, so an XXX-only selection returns XXX only.
    assert.match(stream.nextUrl, /browsingLevel=16/);
    assert.doesNotMatch(stream.nextUrl, /nsfw=/);
    await fetchStreamPage(stream, settings);
    assert.equal(stream.nextUrl, "https://civitai.red/api/v1/images?cursor=2");
    assert.ok(requested.every((url) => url.startsWith("https://civitai.red/")), requested.join(" "));
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("model and collection reads follow the browsed host", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      json: async () => (String(url).includes("/api/v1/models/")
        ? { name: "Model", type: "LORA", modelVersions: [{ id: 7, name: "v1" }] }
        : { result: { data: { json: { collection: { id: 5, name: "C", type: "Image" } } } } }),
    };
  };
  try {
    clearModelCache();
    const settings = { linkDomain: "civitai.red" };
    const [modelStream] = await openSourceStreams(
      { type: "model", modelId: 42 },
      { globalSort: "newest", period: "AllTime" },
      settings
    );
    assert.equal(modelStream.modelType, "LORA");
    await resolveCollection(5, settings);
    assert.ok(requested.every((url) => url.startsWith("https://civitai.red/")), requested.join(" "));
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCache();
  }
});

test("the browsing level is inherited from the signed-in Civitai session", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const messages = [];
  const reply = { current: null };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback(reply.current);
      },
    },
  };
  const red = { linkDomain: "civitai.red" };
  try {
    // Only XXX selected on civitai.red must not widen to every level.
    reply.current = { ok: true, status: 200, payload: {
      signedIn: true, browsingLevel: 16, sessionShowNsfw: true, settingsPayload: null,
    } };
    assert.deepEqual(await resolveAccountBrowsingLevels(red), { levels: [16], reason: "inherited" });
    assert.equal(messages[0].operation, "get-browsing-level");
    assert.equal(messages[0].preferredHost, "civitai.red");

    // A non-contiguous account selection is carried over exactly.
    reply.current = { ok: true, status: 200, payload: {
      signedIn: true, browsingLevel: 1 | 4 | 16, sessionShowNsfw: true, settingsPayload: null,
    } };
    assert.deepEqual(
      (await resolveAccountBrowsingLevels(red)).levels, [1, 4, 16]
    );

    // Civitai computes the effective level as `showNsfw ? browsingLevel : PG`,
    // and getSettings is the fresher source for that switch than the session.
    reply.current = { ok: true, status: 200, payload: {
      signedIn: true,
      browsingLevel: 31,
      sessionShowNsfw: true,
      settingsPayload: { result: { data: { json: { showNsfw: false } } } },
    } };
    assert.deepEqual(
      await resolveAccountBrowsingLevels(red), { levels: [1], reason: "nsfw-disabled" }
    );

    // Each failure is distinguishable so the panel can say why it is not synced.
    reply.current = { ok: true, status: 200, payload: { signedIn: false } };
    assert.deepEqual(
      await resolveAccountBrowsingLevels(red), { levels: null, reason: "signed-out" }
    );
    reply.current = { ok: true, status: 200, payload: { signedIn: true, browsingLevel: null } };
    assert.deepEqual(
      await resolveAccountBrowsingLevels(red), { levels: null, reason: "no-level-in-session" }
    );
    reply.current = { ok: false, code: "network" };
    assert.deepEqual(
      await resolveAccountBrowsingLevels(red), { levels: null, reason: "unreachable" }
    );
  } finally {
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
  }
});

// Civitai's own control is the only place the browsing level is set, so there is
// no write path left to test — only the read above.

test("comment avatars resolve Civitai media keys and refuse foreign hosts", () => {
  const key = "d22de7f7-ba00-4354-b912-8241d75be9a3";
  assert.equal(
    userAvatarUrl({ profilePicture: { url: key } }, 96),
    `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/width=96/avatar.jpeg`
  );
  // The profile picture wins over the legacy account image.
  assert.match(userAvatarUrl({ profilePicture: { url: key }, image: "https://image.civitai.com/x" }), /width=96/);
  // An avatar URL is another user's input, so only Civitai's own media host is
  // requested from this page; anything else falls back to initials.
  assert.equal(userAvatarUrl({ image: "https://image.civitai.com/abc.jpeg" }), "https://image.civitai.com/abc.jpeg");
  assert.equal(userAvatarUrl({ image: "https://tracker.example/pixel.gif" }), null);
  assert.equal(userAvatarUrl({ image: "http://image.civitai.com/abc.jpeg" }), null);
  assert.equal(userAvatarUrl({ image: "javascript:alert(1)" }), null);
  assert.equal(userAvatarUrl({ profilePicture: { url: "../../etc/passwd" } }), null);
  assert.equal(userAvatarUrl({}), null);
  assert.equal(userAvatarUrl(null), null);
});

test("comments and generation data are read through the signed-in tab, not a key", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  // A thread with one answered comment and one nobody replied to.
  const threads = {
    "image:11": [{ id: 101, content: "Hi" }, { id: 102, content: "Alone" }],
    "comment:101": [{ id: 201, content: "Reply" }],
    "comment:102": [],
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        const json = message.operation === "get-comments"
          ? { comments: threads[`${message.entityType}:${message.entityId}`] }
          : { meta: { prompt: "p" }, resources: [] };
        callback({ ok: true, status: 200, payload: { result: { data: { json } } } });
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("the signed-in tab must be used before any direct API call");
  };
  const red = { linkDomain: "civitai.red" }; // no apiKey
  try {
    clearModelCache();
    const { comments } = await resolveImageComments(11, red);
    assert.deepEqual(comments.map((comment) => comment.content), ["Hi", "Alone"]);
    // Replies are attached to the comment they answer, and a comment with none
    // is reported as having none rather than as unknown.
    assert.deepEqual(comments[0].replies.map((reply) => reply.content), ["Reply"]);
    assert.deepEqual(comments[1].replies, []);
    assert.equal((await resolveImageGenerationData(12, red)).meta.prompt, "p");

    // The image's own thread is read first, then one reply page per comment.
    assert.deepEqual(messages.map((message) => message.operation),
      ["get-comments", "get-comments", "get-comments", "get-image-generation-data"]);
    assert.deepEqual(messages.slice(0, 3).map((message) => [message.entityType, message.entityId]),
      [["image", 11], ["comment", 101], ["comment", 102]]);
    assert.equal(messages[3].imageId, 12);
    assert.ok(messages.every((message) => message.preferredHost === "civitai.red"));
  } finally {
    globalThis.fetch = originalFetch;
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
    clearModelCache();
  }
});
