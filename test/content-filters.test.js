import test from "node:test";
import assert from "node:assert/strict";

import {
  generationContentSignals,
  isUnviewedNewImage,
  matchesGenerationFilters,
} from "../extension/content-filters.js";

test("generation signals distinguish prompt, resources, and other metadata", () => {
  assert.deepEqual(generationContentSignals({ meta: null }), {
    hasMetadata: false, hasPrompt: false, hasResources: false,
  });
  assert.deepEqual(generationContentSignals({ meta: { prompt: "Castle" } }), {
    hasMetadata: true, hasPrompt: true, hasResources: false,
  });
  assert.deepEqual(generationContentSignals({ meta: {}, modelVersionIdsManual: [3] }), {
    hasMetadata: true, hasPrompt: false, hasResources: true,
  });
  assert.deepEqual(generationContentSignals({
    hasPositivePrompt: true,
    _generationResources: [{ modelVersionId: 3 }],
  }), { hasMetadata: true, hasPrompt: true, hasResources: true });
});

test("generation filters implement metadata, prompt, resources, and complete choices", () => {
  const missing = { meta: null };
  const otherMetadata = { meta: { seed: 42 } };
  const promptOnly = { meta: { prompt: "Hello" } };
  const resourcesOnly = { meta: {}, modelVersionIds: [1] };
  const complete = { meta: { prompt: "Hello" }, modelVersionIds: [1] };

  assert.equal(matchesGenerationFilters(missing, { generationFilter: "no-metadata" }), false);
  assert.equal(matchesGenerationFilters(otherMetadata, { generationFilter: "no-metadata" }), true);
  assert.equal(matchesGenerationFilters(promptOnly, { generationFilter: "prompt" }), true);
  assert.equal(matchesGenerationFilters(resourcesOnly, { generationFilter: "prompt" }), false);
  assert.equal(matchesGenerationFilters(resourcesOnly, { generationFilter: "resources" }), true);
  assert.equal(matchesGenerationFilters(promptOnly, { generationFilter: "resources" }), false);
  assert.equal(matchesGenerationFilters(complete, { generationFilter: "complete-metadata" }), true);
  assert.equal(matchesGenerationFilters(promptOnly, { generationFilter: "complete-metadata" }), false);
});

test("new status is reserved for unviewed images newer than the previous visit", () => {
  const item = { id: 42, createdAt: "2026-07-16T10:00:00.000Z" };
  const threshold = "2026-07-15T10:00:00.000Z";
  assert.equal(isUnviewedNewImage(item, threshold, new Set()), true);
  assert.equal(isUnviewedNewImage(item, threshold, new Set([42])), false);
  assert.equal(isUnviewedNewImage(item, "2026-07-17T10:00:00.000Z", new Set()), false);
});
