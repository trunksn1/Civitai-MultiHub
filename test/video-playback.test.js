import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_VISIBLE_VIDEO_VISIBILITY_THRESHOLD,
  FOCUSED_VIDEO_VISIBILITY_THRESHOLD,
  playbackVisibilityThreshold,
  selectVideosForPlayback,
} from "../extension/video-playback.js";

function video(dataset = {}) {
  return { isConnected: true, dataset: { ...dataset } };
}

test("focused playback keeps one most-visible video with the existing 25% threshold", () => {
  const left = video();
  const right = video();
  const belowThreshold = video();
  const selected = selectVideosForPlayback([
    [left, 0.5],
    [right, 0.75],
    [belowThreshold, 0.24],
  ], { canAutoplay: true });

  assert.equal(FOCUSED_VIDEO_VISIBILITY_THRESHOLD, 0.25);
  assert.equal(playbackVisibilityThreshold(false), 0.25);
  assert.deepEqual([...selected], [right]);
});

test("focused playback preserves DOM order when visibility scores tie", () => {
  const left = video();
  const right = video();
  const selected = selectVideosForPlayback([
    [left, 0.5],
    [right, 0.5],
  ], { canAutoplay: true });

  assert.deepEqual([...selected], [left]);
});

test("all-visible playback selects every unpaused video at 15% visibility", () => {
  const first = video();
  const second = video();
  const manuallyPaused = video({ manualPause: "true" });
  const belowThreshold = video();
  const selected = selectVideosForPlayback([
    [first, 0.15],
    [second, 0.8],
    [manuallyPaused, 0.9],
    [belowThreshold, 0.149],
  ], { playAllVisible: true, canAutoplay: true });

  assert.equal(ALL_VISIBLE_VIDEO_VISIBILITY_THRESHOLD, 0.15);
  assert.equal(playbackVisibilityThreshold(true), 0.15);
  assert.deepEqual([...selected], [first, second]);
});

test("manual playback remains available while autoplay is off but hidden documents stop all video", () => {
  const automatic = video();
  const manual = video({ manualPlay: "true" });
  const entries = [[automatic, 1], [manual, 0.5]];

  assert.deepEqual(
    [...selectVideosForPlayback(entries, { playAllVisible: true, canAutoplay: false })],
    [manual],
  );
  assert.equal(selectVideosForPlayback(entries, {
    playAllVisible: true,
    canAutoplay: true,
    documentHidden: true,
  }).size, 0);
});
