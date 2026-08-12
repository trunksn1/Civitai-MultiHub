// Runtime release policy. The release builder replaces this module in store
// packages so marketplace builds can have a narrower host/content scope while
// the source and manual package retain the complete feature set.

export const DISTRIBUTION = Object.freeze({
  channel: "full",
  allowedCivitaiHosts: Object.freeze(["civitai.com", "civitai.red"]),
  allowedBrowsingLevels: Object.freeze([1, 2, 4, 8, 16]),
});

export const DEFAULT_CIVITAI_HOST = "civitai.com";
export const ALLOWED_CIVITAI_HOSTS = new Set(DISTRIBUTION.allowedCivitaiHosts);
export const ALLOWED_BROWSING_LEVELS = Object.freeze([
  ...DISTRIBUTION.allowedBrowsingLevels,
]);

export function isAllowedCivitaiHost(host) {
  return ALLOWED_CIVITAI_HOSTS.has(host);
}
