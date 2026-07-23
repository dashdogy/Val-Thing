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
release/latest.json
release/SHA256SUMS.txt
release/val-openai-local-bridge-<version>.zip
release/val-openai-local-bridge-extension-<version>.zip
```

The portable ZIP contains the bundled companion, updater, launcher, and unpacked extension. The standalone installer selects a conventional per-user directory on Windows, macOS, or Linux and verifies the release before extraction.

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

Pushing a version tag such as `v0.1.0` runs the release workflow. It rebuilds and verifies the artifacts, then creates the matching GitHub release. A friend needs Node.js 24 or newer and can run the attached installer with:

```shell
node install.mjs
```

The generated launchers check the latest GitHub release on startup, retain a working installed version when the update check is offline, and never copy local bridge credentials into release metadata.
