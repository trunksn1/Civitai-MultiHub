# Privacy Policy

Last updated: 22 August 2026

## Overview

MultiHub for Civitai is an unofficial browser extension that builds user-configured media feeds
from Civitai. The project does not operate an analytics, advertising, account, or data-collection
server. Extension data stays in the user's browser except for requests that must be sent directly
to Civitai to provide the requested functionality.

Starting with version `0.12.4`, the Chrome Web Store, Firefox Add-ons, GitHub, and manual-install
packages request access to both `civitai.com` and `civitai.red`. The `.com` domain exposes its SFW
range; the `.red` domain can expose the wider browsing range selected in the user's Civitai account.
The currently published `0.12.3` marketplace packages remain limited to `civitai.com` until the
updated packages are submitted and approved. The data flows described below are otherwise the same.

## Data stored in the browser

MultiHub uses browser extension storage for:

- Hub names, sources, source aliases, selected model versions, and enabled states.
- Feed sorting, filtering, density, video, grouping, and browsing-level preferences, including
  optional Civitai.red content profiles that the user explicitly saves on a hub.
- Viewed-image identifiers and last-visit timestamps.
- The global hidden-creator list.
- Interface preferences and the preferred Civitai link domain.
- An optional Civitai API key, as described below.

MultiHub does not use browser sync storage. This information is not sent to the project developer.

## Signed-in Civitai session

When a Civitai tab is open, MultiHub can use that tab's existing signed-in session to read public
collection metadata and media, list writable collections, add an image after the user explicitly
chooses a collection, post a comment or reply the user typed and asked to post, read the comments (and the
replies to them) and generation details of an image the user opens, and read the browsing level the
user selected on that Civitai host so the feed shows the same maturity range the site would.

Content profiles are available only on `civitai.red`. If the user intentionally saves one on a hub,
selecting or opening that hub sends one content-settings mutation through the matching signed-in
Civitai.red tab before loading the feed. It sets the saved browsing-level bitmask and enables
Civitai's mature-content switch so that mask is effective. Civitai.com and hubs without a saved
profile only read and follow Civitai. MultiHub serializes hub-triggered writes,
does not blindly retry an ambiguous mutation, and reads the setting back for confirmation. Adding
to a collection, posting a comment, and applying a saved hub profile are the account-writing
operations. The browser attaches the session cookie to
same-origin Civitai requests. MultiHub does not request Chrome's cookie permission and does not
read, copy, store, export, or log the cookie value.

The browsing level is read from Civitai's own `/api/auth/session` endpoint on the host being
browsed. Only the numeric browsing-level bitmask is kept, in local extension storage, so the feed
still has a level to filter on when the session cannot be read; no other session field is stored.

## Optional Civitai API key

Creator and model feeds can be used without an API key. Public collection feeds, comment threads,
posting a comment and generation details can use an open, signed-in Civitai tab instead of an API
key. A user may provide a Civitai API key for reactions. The key also acts as a fallback for reading
collection feeds and comment threads, generation details, listing writable collections, adding an
image, and posting a comment when a signed-in Civitai tab is unavailable.

The full GitHub build provides two choices:

- **Use for this browser session:** the key is kept in `chrome.storage.session` and is cleared when
  the browser session ends.
- **Remember this API key on this device:** the key is also stored as a dedicated
  `chrome.storage.local` entry until the user removes it or uninstalls the extension.

Persistent extension storage is not an encrypted password vault. Someone or some software with
sufficient access to the browser profile or device may be able to retrieve a remembered key. Use
a limited, revocable key with only the scopes needed for the desired actions.

The key is separate from hub and settings objects. It is not included in hub exports, source
files, release packages, repository commits, or intentional application logs.

## Data sent to Civitai

To build feeds and perform user-requested actions, MultiHub sends HTTPS requests directly from the
browser to Civitai. Depending on the feature, those requests can include:

- Creator names, model IDs, model-version IDs, collection IDs, image IDs, and post IDs.
- Source autocomplete terms entered under Creators, Models, or Collections.
- Feed order, period, media, pagination, and browsing-level parameters.
- The optional API key in an HTTP authorization header.
- For session-backed collection reads and actions, the existing Civitai session credentials that
  the browser automatically attaches to same-origin requests; MultiHub cannot access their value.
- A reaction selected by the user.
- Comment text submitted by the user.
- The collection selected by the user when adding an image.

Account-changing requests require an explicit user action. MultiHub does not react, comment, or
modify a collection in the background. The collection list is requested only when the user opens
the collection picker.

Civitai and its media CDN necessarily receive ordinary network information such as the user's IP
address and request headers when serving API data, images, or videos. Their handling of that data
is governed by Civitai's own terms and privacy policy. The MultiHub project does not receive a copy
of those requests.

## Data sharing and sale

The project developer does not sell, rent, share, or use extension data for advertising, credit,
profiling, or analytics. MultiHub communicates only with the Civitai website/API and Civitai-hosted
media services required for its user-facing features.

MultiHub's use of information received from browser APIs adheres to the Chrome Web Store User Data
Policy, including the Limited Use requirements. Data is used only to provide or improve the
extension's single purpose and user-facing features; it is not transferred for unrelated purposes
or made available for human reading by the developer.

## Hub exports

A hub export contains the hub name, source definitions, aliases, selected model versions, and feed
preferences. It intentionally excludes:

- API keys.
- Global hidden creators.
- Viewed-image history.
- Last-visit state.
- Internal hub and source IDs.
- Saved per-hub Civitai.red profiles, unless the user explicitly chooses to include them in that
  export.

An export leaves the browser only when the user chooses to save or share the generated file.
When an import contains saved Civitai.red profiles, MultiHub asks whether to discard or keep them
before storing the imported hubs.

## Retention and deletion

Local hub data remains until the user changes it, clears the relevant setting, or uninstalls the
extension. Viewed history and intentionally saved Civitai.red profiles can be cleared per hub.

The **Remove API key** control clears both local and session extension copies and disables the
remember option. Uninstalling the extension removes its browser-managed extension storage.

Deleting local extension data cannot delete reactions, comments, collection changes, or the last
content-level setting already submitted to Civitai. Those must be managed through the user's
Civitai account. Clearing a hub's saved profile stops future automatic writes from that hub but does
not restore an earlier account setting.

## Permissions

The current full build requests browser extension storage and host access limited to Civitai's
`.com` and `.red` sites. Civitai-hosted media loads through ordinary image and video elements and
does not require a separate privileged media-host permission. MultiHub does not request general
browsing history, Chrome's cookie permission, or access to unrelated websites. Store-specific
packages will request only the hosts required by their feature policy.

## Security reports and questions

Do not include an API key, browser storage dump, private hub export, or other secret in a public
issue. Follow the private reporting guidance in [SECURITY.md](SECURITY.md).

Material privacy changes will be documented in this file and in the project changelog.
