# Release guide

## Build the release

Use Node.js 24 or newer from a clean checkout:

```shell
npm ci
npm run release:friend
```

The command runs the full verification suite and writes:

```text
release/install.mjs
release/install.tgz
release/latest.json
release/SHA256SUMS.txt
release/val-openai-local-bridge-<version>.zip
release/val-openai-local-bridge-extension-<version>.zip
```

The portable ZIP contains the bundled companion, updater, launcher, and unpacked extension. Both installer forms select a conventional per-user directory on Windows, macOS, or Linux, verify the release before extraction, and register the per-user `val-openai-bridge://launch` handler used by the extension popup. `install.tgz` is a minimal npm package for the one-line install command.

## Verify the package

```shell
npm run verify:release
```

This starts the bundled companion on a temporary port and runs the actual installer and updater against a temporary mock of the GitHub Releases API. The CI workflow repeats the full release build on Windows, macOS, and Linux.

The update channel is GitHub Releases. No separate website or update service is involved.

## Versioning

Before a later release, update the version in:

- the root `package.json`;
- each workspace `package.json`; and
- `packages/extension/src/manifest.json`.

Add the release date and user-visible changes to `CHANGELOG.md`. The extension build fails if its package and manifest versions differ.

## Acceptance

Complete `docs/LIVE_ACCEPTANCE.md` against the exact release build. In particular, verify logout, cancellation, stored and stateless behavior, and the credential boundary.

## Publish

Pushing a version tag such as `v0.1.0` runs the release workflow. It rebuilds and verifies the artifacts, then creates the matching GitHub release. A friend needs Node.js 24 or newer and can install directly from the latest GitHub Release with one cross-platform command:

```shell
npx --yes https://github.com/dashdogy/Val-Thing/releases/latest/download/install.tgz
```

The attached `install.mjs` remains available for offline or manual handoff.

The extension's **Launch companion** button opens the registered operating-system handler. The generated launcher then checks the latest GitHub release before every startup, retains a working installed version when the update check is offline, and never copies local bridge credentials into release metadata.

Running the installer again is safe and repairs the per-user launch handler,
including an existing macOS installation, even when the current companion
version is already installed.
