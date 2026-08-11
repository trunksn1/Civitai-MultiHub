# Privacy Policy

Last updated: 11 August 2026

## Overview

MultiHub for Civitai is an unofficial browser extension that builds user-configured media feeds
from Civitai. The project does not operate an analytics, advertising, account, or data-collection
server. Extension data stays in the user's browser except for requests that must be sent directly
to Civitai to provide the requested functionality.

The Chrome Web Store and Firefox Add-ons packages request access only to `civitai.com` and permit
only its PG/PG-13 browsing range. They do not request access to `civitai.red`. The complete GitHub
and manual-install package also supports `civitai.red` and its wider user-selected browsing range.
The data flows described below are otherwise the same unless a section says otherwise.

## Data stored in the browser

MultiHub uses browser extension storage for:

- Hub names, sources, source aliases, selected model versions, and enabled states.
- Feed sorting, filtering, density, video, grouping, and browsing-level preferences.
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
user selected on that Civitai host so the feed shows the same maturity range the site would. Only
adding to a collection and posting a comment write anything, and each needs an explicit click; the
browsing level is only ever read, never written. The browser attaches the session cookie to
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

An export leaves the browser only when the user chooses to save or share the generated file.

## Retention and deletion

Local hub data remains until the user changes it, clears the relevant setting, or uninstalls the
extension. Viewed history can be cleared per hub.

The **Remove API key** control clears both local and session extension copies and disables the
remember option. Uninstalling the extension removes its browser-managed extension storage.

Deleting local extension data cannot delete reactions, comments, or collection changes already
submitted to Civitai. Those must be managed through the user's Civitai account.

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
