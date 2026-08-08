# Contributing

Thanks for helping improve MultiHub for Civitai.

## Before opening an issue

- Check existing Issues and the latest Release notes.
- Include the MultiHub version, Chrome version, Civitai host, and reproducible steps.
- Remove usernames, API keys, authorization headers, browser storage, private hub data, and other
  personal information from logs or screenshots.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development

The extension has no runtime package dependencies. Load `extension/` directly with Chrome's
**Load unpacked** workflow.

Before submitting a pull request, run:

```powershell
npm test
npm run build:all
npm run verify:packages
```

Keep changes focused, document user-visible behavior in `CHANGELOG.md`, and update privacy or
security documentation whenever data flow, storage, permissions, or account actions change.

Browser integration must also be smoke-tested manually on the affected Civitai host. Never test a
write action against another person's content or account without permission.

## Pull requests

- Explain the problem and the chosen behavior.
- Add or update tests for non-visual logic.
- Avoid unrelated formatting or generated files.
- Do not commit release ZIPs, local plans, hub exports, credentials, Android sources, or assistant
  state.
