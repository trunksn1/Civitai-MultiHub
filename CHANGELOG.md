# Changelog

All notable changes to MultiHub will be documented here.

## 0.12.5 - 2026-08-19

### Changed

- Minor bug fixes.

## 0.12.4 - 2026-08-19

### Changed

- Minor bug fixes.

## 0.12.3 - 2026-08-13

### Fixed

- Corrected card attribution so checkpoint sources do not repeat the same checkpoint as both the
  source and the resolved resource.
- Kept creator names readable while shortening only long model/checkpoint attribution where card
  width is limited.
- Removed redundant source-type prefixes from collection, checkpoint, LoRA, and embedding labels.

## 0.12.2 - 2026-08-13

### Added

- Added a dedicated hub manager for defaults, renaming, multi-delete, and single- or multi-hub
  export/import.
- Added source aliases, enable/disable controls, bulk management, and copy/move actions with inline
  destination-hub creation.
- Added model-version choices from Civitai pages and preserved version display names in source rows.

### Changed

- Improved the placement and reliability of Add-to-MultiHub actions on creator, model, collection,
  and homepage sections.
- Restricted collection pickers to owned image collections and added explicit multi-select Save.

## 0.12.1 - 2026-08-12

### Added

- Added NEW markers, viewed-state filters, creator avatars, checkpoint attribution, generation
  signals, Remix availability, and always-visible reaction/Buzz controls to image cards.
- Added hub search, alphabetical hub selection, and inline named-hub creation to source pickers.
- Added source actions from creators, models, collections, generation resources, preview sources,
  commenter names, Featured Images, and public collection headings.

### Changed

- Reorganized the image preview around prompts, resources, generation details, collection actions,
  reactions, and comment threads.

## 0.11.2 - 2026-08-12

### Added

- Policy-scoped Chrome Web Store and Firefox Add-ons packages limited to `civitai.com` and
  PG/PG-13 browsing levels.
- Firefox MV3 event-page metadata and install-time data-collection declarations.
- Reproducible store-package verification and public store privacy-scope documentation.

## 0.11.1 - 2026-08-08

### Added

- Every comment in the image preview has a **Reply**, which posts into that comment's own child
  thread — where Civitai puts a reply, so it joins the discussion on the site too. Replying to a
  reply opens with a mention of the person being answered, as the site does inside a shared thread.

### Changed

- The note under the comments no longer says "Open on Civitai to reply", which was both a box in
  the way and, now that replying works here, wrong. It appears only when part of the thread is not
  shown, and a posted comment is confirmed by appearing rather than by a message.

## 0.11.0 - 2026-08-08

### Changed

- The browsing level is now Civitai's setting alone. MultiHub's own level picker is gone: the level
  is chosen on Civitai's control — the eye icon in the site header — and the panel mirrors it, the
  same way it already did for a level changed on the site. Everything `0.10.0` added to push a level
  from the panel back to the account (the write, its retries, the confirm-by-re-read step and the
  conflict resolver that decided which side won) has been removed with it. The write reached
  Civitai's database but never reliably reached the page the user was looking at, and one setting
  with two owners was the source of the reverts.
- The sidebar now states which levels are in force and where they came from, so an unexpectedly
  narrow or wide feed points at the setting that decides it.
- The standalone MultiHub tab follows the account's level too, not only the embedded panel.

### Fixed

- Civitai's browsing-level menu no longer opens *behind* the MultiHub panel. Their popover asks for
  `z-index: calc(var(--dialog-z-index) + 2)`, and that variable only exists while one of their own
  dialogs is open — everywhere else the declaration is invalid, so the menu fell back to no z-index
  at all and the panel covered it. The panel now supplies the value the site intends, while it is
  open, and lifts any site popover left without one.
- Image previews show comments and generation details without an API key. Both are now read through
  the signed-in Civitai tab, like collections already were, so a logged-in user sees what the site
  would show them. An API key remains a fallback for when no Civitai tab is open, and is still
  required to post a comment or a reaction.
- The image preview has a comment section again. It was hidden whenever the feed's own comment count
  for that image was zero, which is most images, so it looked as though the section had gone; it is
  now always present and says when there is nothing to show.
- The collection picker opens on top of the image preview instead of behind it. It shares the
  settings-overlay stacking level, which sits below the preview it is opened from.
- Comments, generation details, reactions, collection actions and model-version lookups now all
  follow the Civitai host being browsed. They used the stored link-domain preference, so an embedded
  `civitai.red` panel could ask `civitai.com` — which does not serve that media — for them.

### Added

- The comment section keeps the shape a discussion has on Civitai: replies are nested under the
  comment they answer, so a conversation is distinguishable from a run of unrelated remarks. Each
  entry carries the author's profile picture and name, the local time and its reaction count.
  Comment HTML is rebuilt from an allowlist rather than inserted as markup, mentions and links are
  preserved, and a profile picture rated above the levels being browsed is replaced by an initial.
- Leaving a comment needs no API key either. It is posted as the account signed in to the open
  Civitai tab, which is the same bar the site sets; the comment box appears whenever there is a
  session to post as. A key remains the fallback for a standalone tab with no Civitai page open.

### Removed

- The **Copy prompt** button in the image preview, which did not work.

## 0.10.0 - 2026-08-07

### Fixed

- Mature media is visible again on `civitai.red`. Every API request was hardcoded to
  `civitai.com`, which clamps responses to the SFW tier regardless of the requested browsing level,
  so R, X and XXX could never be returned no matter what the user selected. Feed, model, collection,
  comment, generation-detail and pagination requests now all follow the host being browsed.
- Media whose browsing level cannot be determined is shown instead of silently filtered out.
- The browsing level chosen on Civitai is now actually applied. Requests send Civitai's
  `browsingLevel` integer bitmask, which the API filters on exactly, instead of the legacy `nsfw`
  enum that could only say "up to this tier" and left the rest to client-side filtering — so an
  XXX-only selection now returns XXX only.
- The `showNsfw` master switch is honoured the way the site honours it
  (`showNsfw ? browsingLevel : PG`), read from `user.getSettings` because Civitai patches that
  immediately on change while the session lags behind its JWT refresh.
- The level is now inherited continuously, not only at load. Embedded in Civitai the panel is a live
  mirror of the site's setting: it re-reads while on screen, on panel open and on tab focus, so
  changing the level on Civitai updates the feed within seconds without reopening MultiHub, and the
  change refetches the hub. Previously an already-open panel kept the level it started with.
- The level can now be changed from the panel and is written back to the Civitai account, so the
  site's own image feed shows the same thing. Writes are pinned to the host being browsed and
  tagged with its Civitai colour, because the level is stored per domain. The boxes stay read-only
  only while Civitai's "show mature content" switch is off, since the site clamps to PG then.
- Setting a browsing level in the panel now sticks and reaches Civitai. The panel kept a second
  copy of the level taken from the session and chose between it and the stored selection with
  flags, so any read that failed — a timeout, a moment without a signed-in tab — quietly switched
  the panel back to the site's value and swallowed the click, which is why the sync only ever
  appeared to run from Civitai to MultiHub. There is now one source of truth that only the user and
  a level actually changed on Civitai write to.
- The level boxes are no longer disabled when the session cannot be read. A level set in the panel
  always governs the feed; the note says whether it also reached the account.
- A browsing-level write that returns a Cloudflare 504 is no longer treated as a plain failure.
  Civitai saves the level and only then awaits the session refresh that times out, so the change
  usually landed and only the acknowledgement was lost. The write is retried with backoff and, if it
  still fails, the account is re-read to see whether it took before an error is reported.
- A write that could not be confirmed no longer causes the next poll to undo the choice: the last
  level actually observed on the site is restored, so an unchanged site value is not mistaken for a
  change made there.
- A level chosen in the panel no longer snaps back to Civitai's. The poll could not tell "the site
  changed" from "the site has not caught up with the write yet", and took the site's value in both
  cases, so the site won every time. It now adopts the site's level only when it has actually
  changed there since the previous read, and a failed write is reported rather than rolled back —
  the last human decision wins on whichever side it was made.
- A level written from the panel now reaches the open Civitai page. The write updates Civitai's
  database, but the already-loaded page keeps the level in a client store hydrated at page load, so
  its own feed kept showing the old value until the tab was focused again. The write now nudges the
  focus/visibility listeners NextAuth and React Query refetch on, so the site re-reads the session
  by itself.
- The panel states the outcome of a write ("Saved to civitai.red", or why it failed) instead of
  leaving a silent revert as the only signal.
- When the level cannot be inherited the panel now says which reason applies instead of silently
  falling back to its own selection.
- Scrolling no longer stalls and snaps back up. The load sentinel reports intersection *changes*
  only, so a round that appended too few cards to push it out of view produced no further event and
  loading stopped with the reader already at the bottom; it is now re-armed while it stays in view.
- Re-ranking the feed under a reactions/comments sort no longer throws the reader back to the top:
  that rebuild now anchors on a visible card, and a lost anchor restores the previous position
  instead of leaving the grid clamped at zero.

### Changed

- MultiHub now inherits the browsing level the user chose on Civitai, read from their signed-in
  session on the host being browsed, instead of applying its own PG default. A level changed on
  Civitai propagates here; a narrower choice made afterwards in MultiHub is preserved.
- The browsing-level picker is no longer locked when embedded in `civitai.com`; it offers PG and
  PG-13 there and every level up to XXX on `civitai.red`, and states which host serves what.
- Public image-collection sources no longer require an API key when a signed-in Civitai tab is open.
- Collection metadata and media, the collection picker, and add-to-collection actions now use an
  open Civitai tab's signed-in session first, with a scoped API key retained as an optional fallback.

- Collection feeds now decode both SuperJSON and devalue tRPC responses during Civitai's staged
  serializer migration. Explicit feed refresh/retry also clears a stale disabled-capability state.

- Reworked the README around a two-minute Chrome installation path, five-step quick start,
  manual update/removal guidance, permissions, privacy, API-key scopes, and preview status.
- Corrected the privacy permission summary to match the manifest's two Civitai host permissions.

- Finalized the initial Store identity as **MultiHub for Civitai - Unofficial** version `0.9.0`.
- API keys now remain session-only by default.
- Added an explicit **Remember this API key on this device** option for the full build.
- Clarified that remembered keys are stored unencrypted in the browser profile.
- Documented the planned full, Chrome Store, and Firefox Store release variants.
- Revised the first Chrome submission to use the complete feature set with a Mature disclosure;
  a restricted package is now a fallback after specific reviewer feedback.
- Classified internal Civitai tRPC integrations as experimental dependencies pending platform
  confirmation.
- Added reproducible Chrome/GitHub release ZIPs, SHA-256 reports, and package verification tests.
- Added the MultiHub media-stream icon in 16, 32, 48, and 128 px extension/action sizes plus a
  1024 px store-assets master.
- Hardened experimental Civitai tRPC features with normalized authentication, permission,
  rate-limit, server, schema, and unsupported-procedure errors.
- Internal API failures now disable only the affected capability for the current page session;
  creator and model feeds remain usable.
- Reaction counts and selected states now update immediately and roll back if the single mutation
  request fails or cannot be confirmed.
- Feed responses now normalize irregular Civitai username values and retry temporary malformed
  successful responses without letting one item terminate its source stream.

### Security

- Unchecking the remember option removes the persistent key without ending the current session.
- Restricted signed-in collection access to four allowlisted operations routed through the existing
  Civitai content script; no cookie permission or cookie-value access was added.
- Removing a key clears both local and session extension storage.
- Added public privacy and security documentation.
- Removed unnecessary privileged access to the Civitai media CDN, narrowed public extension
  resources to `feed.html`, and restricted background messages to this extension's own senders.
- Added a shared page-ownership guard so separately installed MultiHub variants do not inject
  duplicate Civitai ribbons, overlays, or floating controls.
- Added regression checks ensuring user API keys never appear in surfaced error text.
- Handled source failures remain visible in MultiHub's retry panel without being registered as
  uncaught extension errors by Chrome.
