# Install MultiHub

## Recommended: Chrome Web Store

Ordinary Chrome users should install
[MultiHub for Civitai - Unofficial from the Chrome Web Store](https://chromewebstore.google.com/detail/multihub-for-civitai-unof/nojkmfegfgplbclepjlnkmdcmngeahbj).
Store installations update automatically.

1. Open the Store listing.
2. Select **Add to Chrome**, then approve Chrome's permission prompt.
3. Refresh any `civitai.com` tab that was already open.
4. Optionally pin MultiHub from Chrome's extensions menu. Its toolbar icon opens the standalone
   feed.

The Store build is limited to `civitai.com` and its PG/PG-13 range. It does not request access to
`civitai.red`.

## Manual installation for development or security review

Use the manual package only when auditing the extension, developing it, or deliberately installing
the complete `.com` + `.red` build. Manually installed copies do not update automatically.

1. Open the [latest GitHub Release](https://github.com/trunksn1/Civitai-MultiHub/releases/latest).
2. Download `civitai-multihub-full-v0.12.3.zip` and its `.sha256` file from **Assets**. Do not use
   GitHub's automatic source archives.
3. Verify the checksum if desired:

   ```powershell
   Get-FileHash .\civitai-multihub-full-v0.12.3.zip -Algorithm SHA256
   ```

4. Extract the ZIP to a permanent folder and confirm that `manifest.json` is directly inside it.
5. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
6. Select the extracted folder containing `manifest.json` and refresh open Civitai tabs.

To install directly from repository source, download or clone the repository and point **Load
unpacked** at its `extension` subdirectory, not the repository root.

## Update or remove a manual installation

To update, export important hubs, replace the files in the existing extension folder, select
**Reload** on `chrome://extensions`, and refresh open Civitai tabs. Keeping the same folder path
prevents Chrome from treating the update as a separate installation.

To remove MultiHub, export hubs you want to retain and remove the extension from Chrome's extension
manager. Removing it deletes browser-managed MultiHub storage but cannot undo reactions, comments,
or collection changes already submitted to Civitai.

See the main [README](../README.md) for quick-start, permissions, privacy, API-key, and
troubleshooting details.
