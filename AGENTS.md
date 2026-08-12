# Project workflow rules

## Store publication and GitHub releases

- When the user asks to upload or publish a new version to either the Chrome Web Store or Firefox Add-ons, treat that as a complete release workflow: verify the extension packages, commit the requested code and documentation changes with a meaningful message, push the current branch to this repository's configured GitHub remote, create the matching GitHub release with the generated store/full packages and checksums, and then continue with the store upload and listing documentation.
- Use the package matching each store (`chrome-store` for Chrome Web Store and `firefox-store` for Firefox Add-ons). Include the full/manual package in the GitHub release when it is generated for the same version.
- Do not publish to either store merely because the user asks to commit, push, or create a GitHub release. Store publication must be explicitly requested.
- A request limited to committing and pushing code must stop after the GitHub push (plus any explicitly requested release action) and must not upload packages or change Chrome Web Store or Firefox Add-ons listings.
