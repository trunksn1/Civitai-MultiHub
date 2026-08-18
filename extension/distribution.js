// Runtime release policy. The release builder replaces this module so each
// package records its distribution channel while retaining the complete
// Civitai host and browsing-level feature set.

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
