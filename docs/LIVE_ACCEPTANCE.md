# Live Helium acceptance

Use a benign test prompt and inspect both the API result and Val's visible chat
history.

## Setup

- [ ] `npm run check` passes.
- [ ] Start the companion with `npm start`.
- [ ] Load `packages\extension\dist` as an unpacked Helium extension.
- [ ] Pair with the companion's current six-digit code.
- [ ] Open signed-in Val once.
- [ ] The popup shows **Connected**, **Signed in**, and **Ready**.
- [ ] Stop the companion, press **Launch companion**, approve the browser's external-app prompt if shown, and confirm the installed launcher opens.
- [ ] The launcher checks for a GitHub release update before the companion starts; an offline update failure still starts the installed version.
- [ ] Once connected, the popup changes the launch button to **Companion running**.
- [ ] The client API key is masked by default; **Show** reveals it and **Copy** matches the companion configuration.
- [ ] **Configure OpenCode** preserves unrelated providers and settings, exports only OpenAI GPT-5.6 models, and creates a backup before changing an existing config.
- [ ] Each configured GPT-5.6 model reports a 1,050,000-token context limit and 128,000-token output limit.
- [ ] Every configured `max` variant includes `reasoningEffort: "max"`, `reasoningSummary: "auto"`, and `include: ["reasoning.encrypted_content"]`.
- [ ] `GET /healthz` returns `status: "ok"` without identity values.
- [ ] Authenticated `GET /v1/models` returns Val's current model list.

## Local-network access

- [ ] The companion reports that it is listening on `0.0.0.0:8787`.
- [ ] From another device on a trusted local network, authenticated
      `GET http://<host-LAN-IP>:8787/v1/models` succeeds.
- [ ] The same LAN request without the client API key returns
      `invalid_api_key`.
- [ ] Browser requests from an unconfigured origin receive
      `origin_not_allowed`.

## Stateless generation

- [ ] Record the current visible Val history.
- [ ] Send a Chat Completions request with `store` absent or `false`.
- [ ] Confirm streaming and non-streaming output are OpenAI-shaped.
- [ ] Confirm the popup updates its token totals and labelled OpenAI API-equivalent USD estimate.
- [ ] Confirm no new visible Val conversation was created.

## Stored generation and continuation

- [ ] Send a request with `store: true`.
- [ ] Confirm exactly one visible Val conversation is created and marked as
      bridge-owned in its metadata.
- [ ] Record the `x-val-chat-id` header or Responses `id`.
- [ ] Continue with `metadata.val_chat_id` or `previous_response_id`.
- [ ] Confirm the same Val conversation is updated, not duplicated.
- [ ] Attempting to target a non-bridge Val chat returns `chat_not_owned`.

## Failure paths

- [ ] Invalid client key returns `invalid_api_key`.
- [ ] Closing Helium or the extension reports `extension_unavailable`.
- [ ] Logging out of Val reports `val_session_unavailable`.
- [ ] An expired Val session clears the session-only token.
- [ ] Interrupting an SSE client cancels the accepted Val task.
- [ ] Stopping the companion closes the bridge cleanly.
- [ ] Unsupported `/v1/*` endpoints return `unsupported_feature`.

## Credential boundary

- [ ] `%LOCALAPPDATA%\ValOpenAIBridge\config.json` contains local bridge
      credentials but no RMIT bearer token.
- [ ] `response-mappings.json` contains IDs and timestamps, not message bodies.
- [ ] `chrome.storage.local` contains the bridge secret and companion URL only.
- [ ] The client API key is absent from persistent extension storage.
- [ ] The key appears in OpenCode's config only after the user presses **Configure OpenCode**.
- [ ] `chrome.storage.session` may contain the Val token and aggregate usage
      statistics while Helium is running, but no message bodies or model IDs.
- [ ] Companion logs and HTTP traffic never contain the RMIT bearer token.

## Release artifact

- [ ] `npm run release:extension` passes from a clean install.
- [ ] The ZIP contains `manifest.json` at its root and no source maps.
- [ ] The ZIP contains 16, 32, 48, and 128 pixel PNG icons.
- [ ] The manifest requests only `storage`, exact Val access, and IPv4 loopback access.
- [ ] The SHA-256 digest matches the generated `.sha256` file.
