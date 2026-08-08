# MultiHub feature guide

## Hubs and sources

A hub is an independent feed configuration. It has its own sources, sorting, filters, display
preferences, viewed history, and last-visit state. Sources can be copied or moved between hubs.

Supported source types:

- Civitai creator username or creator URL.
- Model or LoRA ID/URL, optionally limited to selected versions.
- Public image-collection ID/URL.

When the extension is open on a Civitai creator, model, or collection page, the injected MultiHub
control can add that page directly to a selected hub.

## Feed behavior

Every source is fetched independently, then the media are merged and deduplicated by Civitai image
ID. A single card records every source that matched it. The merged feed supports newest, oldest,
reaction, and comment ordering; time-period, media-type, creator, viewed-state, and browsing-level
filters; post grouping; and multiple density modes.

Refreshes and hub changes cancel obsolete work. Temporary network and upstream errors are shown per
source so one failed source does not erase successful results from the other sources.

## Image preview and account actions

Opening an image can show generation metadata, model resources, comments, replies, author details,
and links back to Civitai. The following actions are available when Civitai grants the corresponding
permission:

- React to an image.
- Add an image to a writable collection.
- Post a comment.
- Reply inside a comment thread.

Every write requires an explicit click. Mutations are not retried automatically because a lost
response does not prove that the write failed.

## Signed-in Civitai session

An open Civitai tab can provide session-backed access without exposing its cookie. The content
script accepts only a fixed operation allowlist and validates IDs, enums, limits, text length, and
collection fields before sending same-origin requests. The browser attaches the session cookie;
MultiHub cannot read its value.

The optional API key is used for reactions and as a fallback for supported operations when the
signed-in tab is unavailable. Hub exports never contain the key.

## Browsing levels and hosts

Civitai's browsing level is a bitmask over PG, PG-13, R, X, and XXX. MultiHub reads the effective
setting from the host being browsed and sends that exact selection with feed requests. The setting
is controlled only by Civitai; MultiHub does not write it.

`civitai.com` serves the narrower range supported by that host. `civitai.red` can serve the full
configured range, including mature user-generated content. Feed requests, pagination, previews,
and account actions remain pinned to the host being used.

## Local data and export

Hub configuration and interface state are stored in the local Chrome profile and are not synced to
the developer. A hub export contains source definitions and feed preferences, but excludes API
keys, global hidden creators, viewed history, last-visit state, and internal identifiers.

See [PRIVACY.md](../PRIVACY.md) for the complete data flow.

## Current limitations

- Unpacked installations update manually.
- Optional features that use internal Civitai tRPC procedures may break when Civitai changes them.
- There is no complete public API for generating a hub automatically from all account follows.
- Large source sets are constrained by Civitai pagination and rate limits.
- The browser integration needs real Chrome smoke tests in addition to Node unit tests.
