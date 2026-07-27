# Val Thing

A small local bridge experiment for personal development workflows.

The project contains:

- a Chromium extension;
- a local Node.js companion; and
- shared protocol code.

## Development

Requires Node.js 24 or newer.

```shell
npm ci
npm run build
npm start
```

Run the project checks with:

```shell
npm run check
```

An installed OpenCode binary can be checked against the local API contract with:

```shell
npm run verify:opencode
```

The bridge follows current OpenAI JavaScript SDK v6 request and response shapes
for capabilities exposed by the upstream service.

The companion writes bounded, sanitized local diagnostics and aggregate usage
totals. Diagnostics include request/model identifiers, outcomes, durations,
and token counters, never prompts, responses, or credentials.

Packaged builds are published through the repository's Releases page.
Installed builds periodically check for a newer release and offer an in-app
update when one is available. OpenCode settings refresh automatically after an
installed bridge update.

```shell
npx --yes --allow-remote=all https://github.com/dashdogy/Val-Thing/releases/latest/download/install.tgz
```

The first companion launch uses trusted-LAN mode. Its popup can switch to
device-only access, rotate the API key, and reset saved usage totals. LAN
traffic is authenticated but not encrypted, so keep the key private.

Use only with services and accounts you are authorized to access, and follow the applicable policies and terms.
