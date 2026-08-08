# Security Policy

## Supported versions

MultiHub is currently a developer preview. Security fixes are applied to the latest version on the
default branch and to the next release package. Older unpacked copies should be updated manually.

## Reporting a vulnerability

Prefer GitHub's private vulnerability-reporting flow on the repository's **Security** tab. If that
option is unavailable, open a public issue containing only a brief request for a private contact
channel. Do not disclose exploit details or secrets in that issue.

Never include:

- A Civitai API key or authorization header.
- Browser extension storage or profile files.
- Private hub data or an unreviewed hub export.
- Civitai session cookies.
- Screenshots containing credentials or private account information.

A useful private report includes the affected version, browser version, reproduction steps,
impact, and any proposed mitigation. Revoke a key immediately if a report or screenshot may have
exposed it.

## API-key security model

MultiHub never embeds a user's API key in source code, release packages, or hub exports. The full
build keeps a key in session storage by default. A user can explicitly choose persistent storage,
which saves it unencrypted in the browser profile.

Browser extension storage is not a password manager. Protect the device, use a limited and
revocable Civitai key, grant only necessary scopes, and remove or revoke the key when it is no
longer needed. Encryption with a fixed key bundled in the extension would not provide meaningful
protection; a future encrypted option would require a user-held secret or suitable platform
facility.

## Network and privilege boundaries

- Runtime code is packaged with the extension; MultiHub does not download executable code.
- API traffic uses HTTPS Civitai endpoints.
- The content script is limited to configured Civitai hosts.
- Signed-in session access is limited to a fixed allowlist of operations, each with its input
  validated in the content script: reading collection metadata, reading collection media pages,
  listing writable collections, adding one selected image, reading the account's browsing level,
  reading one image's comments or generation data, and posting one comment or reply the user typed.
  Only adding to a collection and posting a comment write anything, and both are user-initiated. The
  extension does not expose an arbitrary authenticated request proxy.
- Session cookies are attached by the browser and are never read, copied, stored, or logged.
- Hub imports are normalized and bounded before being stored.
- Account writes require an explicit click and mutations are not automatically retried.
- API-key values must not be logged or included in error messages.

Some features rely on Civitai's internal tRPC procedures. Those interfaces are treated as
experimental dependencies and must fail without compromising stored data or unrelated feeds.

## Repository hygiene

Before committing or publishing a release:

1. Run the automated tests.
2. Inspect the staged diff for credentials and personal data.
3. Verify that generated packages contain no repository metadata, local notes, hub exports, keys,
   tokens, or browser profile files.
4. Publish checksums for downloadable release artifacts.

Do not commit `.env` files, API keys, tokens, signing keys, browser profiles, generated hub exports,
or store-upload private keys.
