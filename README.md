# Val Thing

A small local bridge experiment for personal development workflows.

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
