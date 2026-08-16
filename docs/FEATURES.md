# MultiHub feature guide

The complete, current feature guide is maintained in the main [README](../README.md#main-features).
This page is a compact overview.

## Personal hubs

Each hub has its own creators, models, LoRAs, selected model versions, public image collections,
filters, sort order, viewed history, and last-visit state. Hubs can be renamed, exported, imported,
copied, moved, selected as defaults, or managed in bulk.

## Combined feeds

MultiHub opens one or more streams for each enabled source, merges them into one feed, and
deduplicates media by Civitai image ID. Available orders include newest, oldest, reactions, and
comments, with time, media, shape, prompt, resource, metadata, creator, and viewed-state filters.

## Civitai integration

Creators, models, versions, and public image collections can be added directly from their Civitai
pages. MultiHub runs as an embedded panel below Civitai's header or in its own extension tab.

## Returning-user features

NEW markers identify unseen media added since the previous visit. Viewed filters, source controls,
aliases, post grouping, creator hiding, density settings, and independent hub state make recurring
feeds manageable.

## Image context and account actions

The image viewer can show prompts, generation data, resources, creator and checkpoint attribution,
comments, replies, reactions, and supported Civitai actions. Account-backed reads and writes use
the signed-in Civitai session when available; optional scoped API keys remain a fallback. Every
write requires an explicit user action.

## Privacy and distribution

MultiHub has no account, analytics, advertising, telemetry, data broker, or developer-operated
application server. The Chrome Store build is limited to `civitai.com` and its PG/PG-13 range. The
complete manual build can also support `civitai.red`; read the [privacy policy](../PRIVACY.md) and
[security policy](../SECURITY.md) before using that build.

For exact behavior, limitations, supported source formats, API-key scopes, and release packaging,
use the [README](../README.md).
