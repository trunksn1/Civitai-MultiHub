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
    assert.equal(verified.matureSubmission, true);
    assert.equal(verified.contentRange, "1,2,4,8,16");
    assert.deepEqual(
      verified.hosts,
      ["https://civitai.com/*", "https://civitai.red/*"],
    );
    const manifest = JSON.parse(firstEntries.get("manifest.json").toString("utf8"));
    const distribution = firstEntries.get("distribution.js").toString("utf8");
    assert.equal(manifest.name, "MultiHub for Civitai - Unofficial");
    assert.deepEqual(manifest.content_scripts[0].matches, [
      "https://civitai.com/*",
      "https://civitai.red/*",
    ]);
    assert.deepEqual(manifest.web_accessible_resources[0].matches, [
      "https://civitai.com/*",
      "https://civitai.red/*",
    ]);
    assert.match(distribution, /channel: "chrome-web-store"/);
    assert.match(
      distribution,
      /allowedCivitaiHosts: Object\.freeze\(\["civitai\.com","civitai\.red"\]\)/,
    );
    assert.match(
      distribution,
      /allowedBrowsingLevels: Object\.freeze\(\[1,2,4,8,16\]\)/,
    );
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
  const [content, contentCss, background, feedHtml, feedScript, feedCss] = await Promise.all([
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/content.css", import.meta.url), "utf8"),
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.css", import.meta.url), "utf8"),
  ]);
  assert.match(content, /Add Featured to MultiHub/);
  assert.match(content, /Add this collection to MultiHub/);
  assert.match(content, /Create a new hub/);
  assert.match(content, /Search existing hubs/);
  assert.match(content, /findModelActionCard/);
  assert.match(content, /findModelCreateActionCard/);
  assert.match(content, /findCompactModelActionCard/);
  assert.match(content, /querySelectorAll\('\[data-with-border="true"\]'\)/);
  assert.match(content, /controls\.length < 5 \|\| controls\.length > 12/);
  assert.match(content, /findModelCreateActionCard\(\) \|\| findCompactModelActionCard\(\)/);
  assert.match(content, /findCreatorLastActionAnchor/);
  assert.match(content, /actionCard\.append\(pageAction\)/);
  assert.match(content, /lastActionAnchor\.insertAdjacentElement\("afterend", pageAction\)/);
  assert.match(content, /tip\|chat\|visit\\s\+shop/);
  assert.match(content, /pageActionPlacementIsCurrent/);
  assert.match(content, /window\.addEventListener\("resize", \(\) => \{[\s\S]+scheduleScan\(\)/);
  assert.doesNotMatch(content, /findModelHeaderActionGroup|findModelSidebarActionRow/);
  assert.doesNotMatch(content, /follow\.insertAdjacentElement\("beforebegin"/);
  assert.match(content, /versionCount > 1/);
  assert.doesNotMatch(content, /cmh-widget|Open your MultiHub for Civitai feed/);
  assert.match(content, /message\.operation === "toggle-image-reaction"/);
  assert.match(content, /Only the current version/);
  assert.match(content, /versionNames: \{ \[source\.versionId\]: source\.versionName \}/);
  assert.match(content, /Add \$\{source\.modelKind \|\| "Model"\} to MultiHub/);
  assert.match(content, /document\.documentElement\.append\(menu\)/);
  assert.match(content, /Loading hubs…/);
  assert.match(content, /openPageHubMenu/);
  assert.match(content, /innerWidth - rect\.width - 8/);
  assert.match(contentCss, /position:\s*fixed;\s*\n\s*z-index:\s*2147483646/);
  assert.match(contentCss, /#cmh-page-action\[data-cmh-placement="model"\][\s\S]+width:\s*100%/);
  assert.match(background, /create-hub-with-source/);
  assert.match(background, /"toggle-image-reaction"/);
  assert.match(background, /reaction: message\.reaction/);
  assert.match(feedHtml, /civitai\.com\/models\/2563220/);
  assert.match(feedHtml, /modelVersionId=…/);
  assert.match(feedHtml, /Name, such as <code>Jenescript<\/code>/);
  assert.match(feedHtml, /Copy to another hub/);
  assert.match(feedHtml, /Move to another hub/);
  assert.match(feedHtml, /Create a new hub/);
  assert.doesNotMatch(feedHtml, /bulk-enable|bulk-disable|Local display name|After saving/);
  assert.match(feedScript, /edit\.textContent = "Options"/);
  assert.match(feedScript, /cleanSourceTypePrefix/);
  assert.match(feedScript, /if \(source\.type === "model"\) text\.append\(meta\)/);
  assert.match(feedScript, /source\.versionNames\?\.\[onlyVersionId\]/);
  assert.match(feedScript, /if \(modelSources\.some\(isCheckpointSource\)\) return null/);
  assert.match(feedScript, /cardSourceLabel\(label\)/);
  assert.match(feedScript, /sourceModelTypes\[s\.label\] = s\.modelType/);
  assert.match(feedCss, /creator-line \.user[\s\S]+white-space:\s*normal/);
  assert.match(feedCss, /creator-line \.made-with[\s\S]+text-overflow:\s*ellipsis/);
  assert.ok(feedHtml.indexOf('id="lightbox-collect"') < feedHtml.indexOf('class="lightbox-action-bar"'));
  assert.match(feedHtml, /id="lightbox-buzz"[^>]+target="_blank"/);
  assert.match(feedScript, /"Prompt published", "", "P"/);
  assert.match(feedScript, /"Resources published", "", "R"/);
  assert.match(feedScript, /Add @\$\{profileUsername\} to a hub/);
  assert.match(feedHtml, /id="card-details-toggle"/);
  assert.ok(feedHtml.indexOf('id="card-details-toggle"') < feedHtml.indexOf('id="settings-toggle"'));
  assert.equal(feedHtml.match(/id="card-details-toggle"/g)?.length, 1);
  assert.match(feedHtml, /id="card-details-toggle"[\s\S]+<rect x="4" y="4" width="16" height="6"/);
  assert.doesNotMatch(feedHtml, /card-details-glyph" aria-hidden="true">i</);
  assert.match(feedHtml, /id="card-details-switch"[^>]+role="switch"/);
  assert.match(feedHtml, /Creator and model info/);
  assert.match(feedScript, /cardDetailsButton\.setAttribute\("aria-pressed", String\(feed\(\)\.showCardDetails\)\)/);
  assert.match(feedScript, /\$\("card-details-switch"\)\.checked = feed\(\)\.showCardDetails/);
  assert.match(feedScript, /setCardDetailsVisibility\(event\.target\.checked\)/);
  assert.match(feedCss, /\.card-details-icon\[aria-pressed="true"\][\s\S]+background:\s*rgba\(34,139,230,\.12\)/);
  assert.match(feedCss, /\.feed-option-switch input:checked\s*\{\s*background:\s*#228be6/);
  assert.match(feedScript, /const INITIAL_BATCH = 15/);
  assert.match(feedScript, /const STREAM_FETCH_CONCURRENCY = 6/);
  assert.match(feedScript, /const LOAD_AHEAD_PX = 3200/);
  assert.match(feedScript, /await waitForGridScrollIdle\(signal\)/);
  assert.match(feedScript, /media\.preload = "none"/);
  assert.match(feedHtml, /id="autoplay-all-visible-videos"/);
  assert.match(feedHtml, /at least 15% visible/);
  assert.match(feedScript, /autoplayAllVisibleVideos/);
  assert.match(feedScript, /feed\(\)\.autoplayVideos[\s\S]+feed\(\)\.autoplayAllVisibleVideos/);
  assert.match(feedScript, /threshold: \[0, 0\.15, 0\.25, 0\.5, 0\.75, 1\]/);
  assert.match(feedScript, /if \(previewedRunId === run\) return/);
  assert.match(feedScript, /startFeed\(\{ refreshData: true, reason: "manual-refresh" \}\)/);
  assert.doesNotMatch(feedScript, /if \(changed\) startFeed\(\)/);
  assert.doesNotMatch(feedScript, /setCacheBuster\(`\$\{Date\.now\(\)\}`\); \/\/ fresh token per/);
  assert.doesNotMatch(feedScript, /window\.addEventListener\("focus", reloadFromStorage\)/);
  assert.doesNotMatch(feedScript, /!config\.settings\.apiKey\) return window\.open/);
  assert.match(feedCss, /overscroll-behavior-y:\s*contain/);
  assert.match(feedCss, /overflow-anchor:\s*none/);
  assert.match(feedHtml, /id="copy-scroll-diagnostics"/);
  assert.match(feedHtml, /id="reset-scroll-diagnostics"/);
  assert.match(feedHtml, /class="feed-diagnostics" hidden/);
  assert.match(feedScript, /const SCROLL_DIAGNOSTICS_KEY = "cmh-scroll-diagnostics-v1"/);
  assert.match(feedScript, /recordScrollDiagnostic\("scroll-height-collapse"/);
  assert.match(feedScript, /startFeed\(\{ reason: "storage-fetch-signature" \}\)/);
  assert.match(feedScript, /sources: current\.sources\.map\(sourceFetchSignature\)/);
  assert.match(feedScript, /reason: "column-resize"/);
});

test("Firefox embedded feed interactions stay inside the extension page", async () => {
  const [feedHtml, feedScript, feedCss] = await Promise.all([
    readFile(new URL("../extension/feed.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/feed.css", import.meta.url), "utf8"),
  ]);

  assert.match(feedScript, /USE_IN_PAGE_DIALOGS = DISTRIBUTION\.channel === "firefox-addons"/);
  assert.match(feedScript, /if \(!USE_IN_PAGE_DIALOGS\)[\s\S]+globalThis\.prompt/);
  assert.match(feedScript, /if \(!USE_IN_PAGE_DIALOGS\)[\s\S]+globalThis\.confirm/);
  assert.match(feedScript, /if \(!USE_IN_PAGE_DIALOGS\) \{\s*globalThis\.alert/);
  assert.match(feedHtml, /id="app-dialog-overlay"/);
  assert.match(feedHtml, /id="app-dialog-input"/);
  assert.match(feedHtml, /id="app-dialog-choices"/);
  assert.match(feedHtml, /id="startup-error"[^>]+role="alert"/);
  assert.match(feedScript, /function askText\(/);
  assert.match(feedScript, /function askConfirmation\(/);
  assert.match(feedScript, /function chooseFromList\(/);
  assert.match(feedScript, /const destination = await chooseDestination\(/);
  assert.match(feedScript, /renderHubs\(\);[\s\S]+await saveConfig\(config\)/);
  assert.match(feedScript, /catch \(error\) \{\s*showStartupError\(error\)/);
  assert.match(feedCss, /\.app-dialog-overlay\s*\{[^}]*z-index:\s*2400/);
});

test("Firefox release uses an MV3 event page and Mozilla signing metadata", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "multihub-firefox-release-"));
  try {
    const release = await buildRelease({ variantName: "firefox", outputRoot });
    const verified = await verifyRelease({ variantName: "firefox", outputRoot });
    const entries = inspectZip(await readFile(release.zipPath));
    const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
    const distribution = entries.get("distribution.js").toString("utf8");

    assert.equal(release.variant, "firefox-store");
    assert.equal(verified.matureSubmission, true);
    assert.equal(verified.contentRange, "1,2,4,8,16");
    assert.deepEqual(manifest.host_permissions, [
      "https://civitai.com/*",
      "https://civitai.red/*",
    ]);
    assert.deepEqual(manifest.content_scripts[0].matches, [
      "https://civitai.com/*",
      "https://civitai.red/*",
    ]);
    assert.deepEqual(manifest.web_accessible_resources[0].matches, [
      "https://civitai.com/*",
      "https://civitai.red/*",
    ]);
    assert.match(distribution, /channel: "firefox-addons"/);
    assert.match(
      distribution,
      /allowedCivitaiHosts: Object\.freeze\(\["civitai\.com","civitai\.red"\]\)/,
    );
    assert.match(
      distribution,
      /allowedBrowsingLevels: Object\.freeze\(\[1,2,4,8,16\]\)/,
    );
    assert.deepEqual(manifest.background, {
      scripts: ["background.js"],
      type: "module",
    });
    assert.equal(
      manifest.browser_specific_settings.gecko.id,
      "civitai-multihub@trunksn1.github.io",
    );
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
    assert.deepEqual(manifest.browser_specific_settings.gecko_android, {
      strict_min_version: "142.0",
    });
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
