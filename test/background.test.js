import assert from "node:assert/strict";
import test from "node:test";

test("signed-in reaction routing preserves the reaction through the background bridge", async () => {
  const hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  const originalChrome = globalThis.chrome;
  const sent = [];
  globalThis.chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      id: "test-extension",
      lastError: null,
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener() {} },
    },
    tabs: {
      query(_query, callback) {
        callback([{
          id: 17,
          url: "https://civitai.com/images/123",
          active: true,
          lastAccessed: 1,
        }]);
      },
      sendMessage(tabId, message, options, callback) {
        sent.push({ tabId, message, options });
        callback({ ok: true, status: 200, payload: null });
      },
    },
    windows: {},
  };

  try {
    const { routeAccountRequest } = await import(
      `../extension/background.js?reaction-bridge-test=${Date.now()}`
    );
    const response = await routeAccountRequest({
      operation: "toggle-image-reaction",
      preferredHost: "civitai.com",
      imageId: 123,
      reaction: "Heart",
    }, { tab: null });

    assert.equal(response.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tabId, 17);
    assert.equal(sent[0].options.frameId, 0);
    assert.equal(sent[0].message.operation, "toggle-image-reaction");
    assert.equal(sent[0].message.imageId, 123);
    assert.equal(sent[0].message.reaction, "Heart");
  } finally {
    if (hadChrome) globalThis.chrome = originalChrome;
    else delete globalThis.chrome;
  }
});
