# Firefox Add-ons source build instructions

This source archive reproduces the submitted Firefox Add-ons package for
MultiHub for Civitai version 0.13.0.

## Environment

- Operating system: Windows, macOS, or Linux.
- Node.js: 22.20.0.
- npm: 10.9.3 (included with the tested Node.js installation).
- No third-party npm packages, global packages, browser SDKs, or environment
  variables are required.

Install Node.js 22.20.0 from the official Node.js distribution, then confirm:

```text
node --version
npm --version
```

The expected values are `v22.20.0` and `10.9.3`.

## Build the submitted package

1. Extract this source archive, preserving its directory structure.
2. Open a terminal in the extracted directory (the directory containing
   `package.json`).
3. Run:

```text
npm run build:firefox
```

No `npm install` step is needed because the build uses only Node.js built-in
modules.

The command creates the exact submitted package at:

```text
dist/civitai-multihub-firefox-store-v0.13.0.zip
```

Expected SHA-256:

```text
e18cf12f46b282555b1ad6042578b084b2f79835156bda87e41a65cae165eb53
```

The build copies the allow-listed source files, generates the Firefox-specific
`manifest.json` and `distribution.js`, creates a deterministic ZIP, and runs
the package verifier. It does not download dependencies, minify, bundle,
transpile, concatenate, or obfuscate application code.

## Optional verification

The build command already verifies the Firefox package. To build and verify all
project variants, run:

```text
npm run build:all
npm run verify:packages
```
