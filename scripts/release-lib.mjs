import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION_DIR = join(ROOT, "extension");
export const DEFAULT_DIST_DIR = join(ROOT, "dist");

export const PACKAGE_FILES = Object.freeze([
  "action-state.js",
  "background.js",
  "civitai-api.js",
  "content.css",
  "content-filters.js",
  "content.js",
  "distribution.js",
  "feed.css",
  "feed.html",
  "feed.js",
  "icons/multihub-16.png",
  "icons/multihub-32.png",
  "icons/multihub-48.png",
  "icons/multihub-128.png",
  "manifest.json",
  "merge.js",
  "storage.js",
]);

const VARIANTS = Object.freeze({
  chrome: {
    id: "chrome-store",
    purpose: "Chrome Web Store policy-scoped candidate",
    browser: "chrome",
    channel: "chrome-web-store",
    allowedCivitaiHosts: ["civitai.com"],
    allowedBrowsingLevels: [1, 2],
  },
  firefox: {
    id: "firefox-store",
    purpose: "Firefox Add-ons policy-scoped candidate",
    browser: "firefox",
    channel: "firefox-addons",
    allowedCivitaiHosts: ["civitai.com"],
    allowedBrowsingLevels: [1, 2],
  },
  full: {
    id: "full",
    purpose: "Complete GitHub/manual-install package",
    browser: "chrome",
    channel: "full",
    allowedCivitaiHosts: ["civitai.com", "civitai.red"],
    allowedBrowsingLevels: [1, 2, 4, 8, 16],
  },
});

const FORBIDDEN_ENTRY_PARTS = Object.freeze([
  ".git",
  ".github",
  ".env",
  "node_modules",
  "test",
  "tests",
  "docs",
  "android",
  "scripts",
  "attachments",
]);

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}/i,
  /\b(?:api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i,
]);

const TEXT_EXTENSIONS = /\.(?:css|html|js|json|mjs|txt)$/i;

export function normalizeReleaseBytes(name, buffer) {
  if (!TEXT_EXTENSIONS.test(name)) return Buffer.from(buffer);
  return Buffer.from(buffer.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[n] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeEntry(path) {
  return path.split(sep).join("/");
}

function assertInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  if (path === "" || path === ".") return;
  if (path.startsWith(`..${sep}`) || path === ".." || resolve(path) === path) {
    throw new Error(`Refusing to operate outside ${parent}: ${child}`);
  }
}

function zipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(normalizeEntry(file.name), "utf8");
    const source = file.data;
    const compressed = deflateRawSync(source, { level: 9 });
    const crc = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12); // 1980-01-01 00:00:00, deterministic DOS date.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function inspectZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const sourceSize = buffer.readUInt32LE(offset + 22);
    const nameSize = buffer.readUInt16LE(offset + 26);
    const extraSize = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    const name = buffer.subarray(nameStart, nameStart + nameSize).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== sourceSize || crc32(data) !== expectedCrc) {
      throw new Error(`Corrupt ZIP entry: ${name}`);
    }
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    entries.set(name, data);
    offset = dataStart + compressedSize;
  }
  return entries;
}

async function listFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = normalizeEntry(join(prefix, entry.name));
    if (entry.isDirectory()) output.push(...(await listFiles(join(directory, entry.name), name)));
    else if (entry.isFile()) output.push(name);
  }
  return output.sort();
}

export function manifestForVariant(sourceManifest, variantName) {
  const variant = VARIANTS[variantName];
  if (!variant) throw new Error(`Unknown variant '${variantName}'`);
  const manifest = structuredClone(sourceManifest);
  const allowedPatterns = new Set(
    variant.allowedCivitaiHosts.map((host) => `https://${host}/*`),
  );
  manifest.host_permissions = (manifest.host_permissions || [])
    .filter((pattern) => allowedPatterns.has(pattern));
  for (const contentScript of manifest.content_scripts || []) {
    contentScript.matches = (contentScript.matches || [])
      .filter((pattern) => allowedPatterns.has(pattern));
  }
  for (const resource of manifest.web_accessible_resources || []) {
    resource.matches = (resource.matches || [])
      .filter((pattern) => allowedPatterns.has(pattern));
  }
  if (variant.browser === "firefox") {
    manifest.background = {
      scripts: [sourceManifest.background.service_worker],
      type: sourceManifest.background.type || "module",
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: "civitai-multihub@trunksn1.github.io",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: [
            "authenticationInfo",
            "personalCommunications",
            "websiteActivity",
            "websiteContent",
          ],
        },
      },
      gecko_android: {
        strict_min_version: "142.0",
      },
    };
  }
  return manifest;
}

export function distributionModuleForVariant(variantName) {
  const variant = VARIANTS[variantName];
  if (!variant) throw new Error(`Unknown variant '${variantName}'`);
  return `// Generated by scripts/build-release.mjs; do not edit this packaged copy.

export const DISTRIBUTION = Object.freeze({
  channel: ${JSON.stringify(variant.channel)},
  allowedCivitaiHosts: Object.freeze(${JSON.stringify(variant.allowedCivitaiHosts)}),
  allowedBrowsingLevels: Object.freeze(${JSON.stringify(variant.allowedBrowsingLevels)}),
});

export const DEFAULT_CIVITAI_HOST = "civitai.com";
export const ALLOWED_CIVITAI_HOSTS = new Set(DISTRIBUTION.allowedCivitaiHosts);
export const ALLOWED_BROWSING_LEVELS = Object.freeze([
  ...DISTRIBUTION.allowedBrowsingLevels,
]);

export function isAllowedCivitaiHost(host) {
  return ALLOWED_CIVITAI_HOSTS.has(host);
}
`;
}

function validateManifest(manifest, variant) {
  const failures = [];
  if (manifest.manifest_version !== 3) failures.push("manifest_version must be 3");
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || "")) failures.push("invalid version");
  if (!manifest.name || !manifest.description) failures.push("name and description are required");
  const requiredIcons = {
    16: "icons/multihub-16.png",
    32: "icons/multihub-32.png",
    48: "icons/multihub-48.png",
    128: "icons/multihub-128.png",
  };
  for (const [size, path] of Object.entries(requiredIcons)) {
    if (manifest.icons?.[size] !== path) failures.push(`missing ${size}px extension icon`);
    if (manifest.action?.default_icon?.[size] !== path) failures.push(`missing ${size}px action icon`);
  }

  const expectedHosts = variant.allowedCivitaiHosts.map((host) => `https://${host}/*`);
  const hosts = new Set(manifest.host_permissions || []);
  for (const host of expectedHosts) {
    if (!hosts.has(host)) failures.push(`${variant.id} is missing disclosed host ${host}`);
  }
  if (hosts.size !== expectedHosts.length) failures.push(`${variant.id} has an unexpected host permission`);

  const matches = new Set(manifest.content_scripts?.flatMap((script) => script.matches || []) || []);
  for (const host of expectedHosts) {
    if (!matches.has(host)) failures.push(`${variant.id} content script is missing ${host}`);
  }
  if (matches.size !== expectedHosts.length) failures.push(`${variant.id} has an unexpected content-script match`);
  if (variant.browser === "firefox") {
    if (manifest.background?.scripts?.[0] !== "background.js" || manifest.background.service_worker) {
      failures.push("Firefox must use the background event-page script");
    }
    if (!manifest.browser_specific_settings?.gecko?.id) failures.push("Firefox add-on ID is required");
    if (!manifest.browser_specific_settings?.gecko?.data_collection_permissions) {
      failures.push("Firefox data-collection declaration is required");
    }
    if (manifest.browser_specific_settings?.gecko_android?.strict_min_version !== "142.0") {
      failures.push("Firefox Android must require built-in data-consent support");
    }
  } else if (manifest.background?.service_worker !== "background.js") {
    failures.push(`${variant.id} must use the Chrome background service worker`);
  }
  if (failures.length) throw new Error(failures.join("; "));
}

async function packageFileBytes(name, manifest, variantName) {
  if (name === "manifest.json") {
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  if (name === "distribution.js") {
    return Buffer.from(distributionModuleForVariant(variantName), "utf8");
  }
  return normalizeReleaseBytes(name, await readFile(join(EXTENSION_DIR, name)));
}

function validateEntries(entries) {
  const names = [...entries.keys()].sort();
  const expected = [...PACKAGE_FILES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected package files. Expected ${expected.join(", ")}; got ${names.join(", ")}`);
  }
  if (!entries.has("manifest.json")) throw new Error("manifest.json must be at the ZIP root");

  for (const [name, data] of entries) {
    const parts = name.toLowerCase().split("/");
    if (parts.some((part) => FORBIDDEN_ENTRY_PARTS.includes(part))) {
      throw new Error(`Forbidden package path: ${name}`);
    }
    if (name.includes("..") || name.startsWith("/") || /^[a-z]:/i.test(name)) {
      throw new Error(`Unsafe package path: ${name}`);
    }
    const text = data.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) throw new Error(`Potential secret in ${name}: ${pattern}`);
    }
  }
}

export async function buildRelease({ variantName = "chrome", outputRoot = DEFAULT_DIST_DIR } = {}) {
  const variant = VARIANTS[variantName];
  if (!variant) throw new Error(`Unknown variant '${variantName}'. Use: ${Object.keys(VARIANTS).join(", ")}`);

  const sourceManifest = JSON.parse(await readFile(join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const manifest = manifestForVariant(sourceManifest, variantName);
  validateManifest(manifest, variant);
  const packageBase = `civitai-multihub-${variant.id}-v${manifest.version}`;
  const unpackedDir = join(outputRoot, variant.id, "unpacked");
  const zipPath = join(outputRoot, `${packageBase}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  const reportPath = join(outputRoot, `${packageBase}.json`);
  assertInside(outputRoot, unpackedDir);
  assertInside(outputRoot, zipPath);

  await rm(join(outputRoot, variant.id), { recursive: true, force: true });
  await mkdir(unpackedDir, { recursive: true });
  const files = [];
  for (const name of PACKAGE_FILES) {
    const source = join(EXTENSION_DIR, name);
    const destination = join(unpackedDir, name);
    await mkdir(dirname(destination), { recursive: true });
    const data = await packageFileBytes(name, manifest, variantName);
    await writeFile(destination, data);
    files.push({ name, data });
  }

  const zip = zipBuffer(files);
  const digest = sha256(zip);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(zipPath, zip);
  await writeFile(checksumPath, `${digest}  ${packageBase}.zip\n`, "utf8");

  const report = {
    schemaVersion: 2,
    variant: variant.id,
    purpose: variant.purpose,
    version: manifest.version,
    matureSubmission: false,
    contentRange: variant.allowedBrowsingLevels.join(","),
    hosts: manifest.host_permissions,
    zip: packageBase + ".zip",
    sha256: digest,
    files: PACKAGE_FILES,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, outputRoot, unpackedDir, zipPath, checksumPath, reportPath };
}

export async function verifyRelease({ variantName = "chrome", outputRoot = DEFAULT_DIST_DIR } = {}) {
  const variant = VARIANTS[variantName];
  if (!variant) throw new Error(`Unknown variant '${variantName}'`);
  const sourceManifest = JSON.parse(await readFile(join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const manifest = manifestForVariant(sourceManifest, variantName);
  const packageBase = `civitai-multihub-${variant.id}-v${manifest.version}`;
  const unpackedDir = join(outputRoot, variant.id, "unpacked");
  const zipPath = join(outputRoot, `${packageBase}.zip`);
  const reportPath = join(outputRoot, `${packageBase}.json`);
  const checksumPath = `${zipPath}.sha256`;

  validateManifest(manifest, variant);
  const zip = await readFile(zipPath);
  const entries = inspectZip(zip);
  validateEntries(entries);
  const unpackedFiles = await listFiles(unpackedDir);
  if (JSON.stringify(unpackedFiles) !== JSON.stringify([...PACKAGE_FILES].sort())) {
    throw new Error(`Unexpected unpacked files: ${unpackedFiles.join(", ")}`);
  }
  for (const name of PACKAGE_FILES) {
    const source = await packageFileBytes(name, manifest, variantName);
    const packaged = entries.get(name);
    if (!source.equals(packaged)) throw new Error(`Packaged file differs from source: ${name}`);
  }

  const digest = sha256(zip);
  const checksum = await readFile(checksumPath, "utf8");
  if (!checksum.startsWith(`${digest}  `)) throw new Error("SHA-256 checksum does not match ZIP");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.sha256 !== digest || report.variant !== variant.id) {
    throw new Error("Release report does not match ZIP");
  }
  const zipStat = await stat(zipPath);
  return { ...report, zipPath, bytes: zipStat.size };
}

export function variantNames() {
  return Object.keys(VARIANTS);
}
