# Release guide

## Build the extension package

Use Node.js 24 or newer from a clean checkout:

```powershell
npm ci
npm run release:extension
```

The command checks formatting, type-checks every workspace, runs the full test suite, builds the companion, creates a minified extension without source maps, validates the permission boundary, and writes:

```text
release\val-openai-local-bridge-extension-<version>.zip
release\val-openai-local-bridge-extension-<version>.zip.sha256
```

The ZIP is deterministic for an unchanged source tree and contains `manifest.json` at its root.

## Verify the package

```powershell
Get-FileHash .\release\val-openai-local-bridge-extension-0.1.0.zip -Algorithm SHA256
$testDirectory = Join-Path $env:TEMP "val-bridge-release-check"
Expand-Archive .\release\val-openai-local-bridge-extension-0.1.0.zip $testDirectory -Force
Get-ChildItem $testDirectory -Recurse
```

Confirm:

- the calculated hash matches the `.sha256` file;
- icons exist at 16, 32, 48, and 128 pixels;
- no `.ts` or `.map` files are present;
- `manifest.json` requests only `storage`, exact Val access, and IPv4 loopback access; and
- the unpacked directory loads without errors in Helium.

Remove the temporary verification directory after inspection.

## Versioning

Before a later release, update the version in:

- the root `package.json`;
- each workspace `package.json`; and
- `packages/extension/src/manifest.json`.

Add the release date and user-visible changes to `CHANGELOG.md`. The extension build fails if its package and manifest versions differ.

## Acceptance

Complete `docs/LIVE_ACCEPTANCE.md` against the exact release build. In particular, verify logout, cancellation, stored and stateless behavior, and the credential boundary.

## Distribution checklist

- Publish `docs/PRIVACY.md` at a stable HTTPS URL.
- Configure a monitored support contact.
- Prepare current screenshots and any required promotional assets.
- Copy the single-purpose statement, permission justifications, and data disclosures from `docs/STORE_LISTING.md`.
- Confirm that the selected public, unlisted, or private distribution mode is authorized for the RMIT account and use case.
- Upload the generated ZIP; do not ZIP the `dist` directory itself with an extra parent folder.

The Chrome Web Store upload and RMIT authorization steps require the publisher's accounts and are intentionally not automated.
