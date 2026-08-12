import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRelease,
  inspectZip,
  normalizeReleaseBytes,
  PACKAGE_FILES,
  verifyRelease,
} from "../scripts/release-lib.mjs";

test("release text normalization makes Windows and Unix checkouts identical", () => {
  const windows = Buffer.from("first\r\nsecond\r\n", "utf8");
  const unix = Buffer.from("first\nsecond\n", "utf8");
  assert.deepEqual(normalizeReleaseBytes("content.js", windows), unix);
  assert.deepEqual(normalizeReleaseBytes("content.js", unix), unix);
});

test("Chrome release is a clean, complete, reproducible extension package", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "multihub-release-"));
  try {
    const first = await buildRelease({ variantName: "chrome", outputRoot });
    const firstZip = await readFile(first.zipPath);
    const firstEntries = inspectZip(firstZip);
    const verified = await verifyRelease({ variantName: "chrome", outputRoot });

    assert.deepEqual([...firstEntries.keys()].sort(), [...PACKAGE_FILES].sort());
    assert.ok(firstEntries.has("manifest.json"));
    assert.equal(verified.variant, "chrome-store");
    assert.equal(verified.matureSubmission, false);
    assert.equal(verified.contentRange, "1,2");
    assert.deepEqual(
      verified.hosts,
      ["https://civitai.com/*"],
    );
    const manifest = JSON.parse(firstEntries.get("manifest.json").toString("utf8"));
    const distribution = firstEntries.get("distribution.js").toString("utf8");
    assert.equal(manifest.name, "MultiHub for Civitai - Unofficial");
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://civitai.com/*"]);
    assert.deepEqual(manifest.web_accessible_resources[0].matches, ["https://civitai.com/*"]);
    assert.match(distribution, /channel: "chrome-web-store"/);
    assert.match(distribution, /allowedCivitaiHosts: Object\.freeze\(\["civitai\.com"\]\)/);
    assert.doesNotMatch(distribution, /civitai\.red/);
    // Pinning a literal here means every release bump fails this test; what
    // matters is that the package carries the version the source declares.
    const sourceManifest = JSON.parse(
      await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")
    );
    assert.equal(manifest.version, sourceManifest.version);
    assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
    assert.ok(manifest.description.length <= 132);
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.web_accessible_resources[0].resources, ["feed.html"]);
    assert.deepEqual(manifest.icons, {
      16: "icons/multihub-16.png",
      32: "icons/multihub-32.png",
      48: "icons/multihub-48.png",
      128: "icons/multihub-128.png",
    });
    for (const size of [16, 32, 48, 128]) {
      assert.ok(firstEntries.has(`icons/multihub-${size}.png`));
    }

    await buildRelease({ variantName: "chrome", outputRoot });
    const secondZip = await readFile(first.zipPath);
    assert.deepEqual(secondZip, firstZip, "identical source must produce an identical ZIP");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("full/manual package preserves the same complete extension files", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "multihub-full-release-"));
  try {
    const release = await buildRelease({ variantName: "full", outputRoot });
    const verified = await verifyRelease({ variantName: "full", outputRoot });
    assert.equal(release.variant, "full");
    assert.deepEqual(release.hosts, ["https://civitai.com/*", "https://civitai.red/*"]);
    assert.equal(release.contentRange, "1,2,4,8,16");
    assert.equal(verified.files.length, PACKAGE_FILES.length);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("source UI keeps the corrected hub picker and preview contracts", async () => {
  const [content, background, feedHtml, feedScript] = await Promise.all([
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.js", import.meta.url), "utf8"),
  ]);
  assert.match(content, /Add Featured Image Collection to MultiHub/);
  assert.match(content, /Add this collection to MultiHub/);
  assert.match(content, /Create a new hub/);
  assert.match(content, /Search existing hubs/);
  assert.match(background, /create-hub-with-source/);
  assert.ok(feedHtml.indexOf('id="lightbox-collect"') < feedHtml.indexOf('class="lightbox-action-bar"'));
  assert.match(feedHtml, /id="lightbox-buzz"[^>]+target="_blank"/);
  assert.match(feedScript, /"Prompt published", "", "P"/);
  assert.match(feedScript, /"Resources published", "", "R"/);
  assert.match(feedScript, /Add @\$\{profileUsername\} to a hub/);
});

test("Firefox release uses an MV3 event page and Mozilla signing metadata", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "multihub-firefox-release-"));
  try {
    const release = await buildRelease({ variantName: "firefox", outputRoot });
    const verified = await verifyRelease({ variantName: "firefox", outputRoot });
    const entries = inspectZip(await readFile(release.zipPath));
    const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));

    assert.equal(release.variant, "firefox-store");
    assert.deepEqual(manifest.host_permissions, ["https://civitai.com/*"]);
    assert.deepEqual(manifest.background, {
      scripts: ["background.js"],
      type: "module",
    });
    assert.equal(
      manifest.browser_specific_settings.gecko.id,
      "civitai-multihub@trunksn1.github.io",
    );
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
    assert.deepEqual(
      manifest.browser_specific_settings.gecko.data_collection_permissions,
      {
        required: [
          "authenticationInfo",
          "personalCommunications",
          "websiteActivity",
          "websiteContent",
        ],
      },
    );
    assert.equal(verified.files.length, PACKAGE_FILES.length);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
