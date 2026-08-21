export const FOCUSED_VIDEO_VISIBILITY_THRESHOLD = 0.25;
export const ALL_VISIBLE_VIDEO_VISIBILITY_THRESHOLD = 0.15;

export function playbackVisibilityThreshold(playAllVisible) {
  return playAllVisible
    ? ALL_VISIBLE_VIDEO_VISIBILITY_THRESHOLD
    : FOCUSED_VIDEO_VISIBILITY_THRESHOLD;
}

export function selectVideosForPlayback(entries, {
  playAllVisible = false,
  canAutoplay = false,
  documentHidden = false,
} = {}) {
  if (documentHidden) return new Set();
  const threshold = playbackVisibilityThreshold(playAllVisible);
  const candidates = entries.filter(([video, ratio]) =>
    video.isConnected && ratio >= threshold
  );

  if (playAllVisible) {
    return new Set(candidates
      .filter(([video]) => video.dataset.manualPlay === "true"
        || (canAutoplay && video.dataset.manualPause !== "true"))
      .map(([video]) => video));
  }

  const manuallyStarted = candidates.find(([video]) => video.dataset.manualPlay === "true");
  const selected = manuallyStarted || candidates
    .filter(([video]) => video.dataset.manualPause !== "true")
    .sort((a, b) => b[1] - a[1])[0];
  if (!selected || (selected[0].dataset.manualPlay !== "true" && !canAutoplay)) return new Set();
  return new Set([selected[0]]);
}
