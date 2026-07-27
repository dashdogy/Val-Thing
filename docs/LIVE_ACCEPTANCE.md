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
- [ ] On Windows, the launcher opens `http://127.0.0.1:<port>/pairing`, the
      page shows only the current six-digit code, and cross-origin or
      non-loopback requests cannot read it.
- [ ] On macOS, the launch opens Terminal and runs the companion without adding an extension error; repeating the installer repairs an existing URL handler.
- [ ] The launcher checks for a GitHub release update before the companion starts; an offline update failure still starts the installed version.
- [ ] Once connected, the popup changes the launch button to **Companion running**.
- [ ] The client API key is masked by default; **Show** reveals it and **Copy** matches the companion configuration.
- [ ] **Rotate** invalidates the old API key, displays the new one only after
      authentication, and OpenCode works again after reconfiguration.
- [ ] **Configure OpenCode** preserves unrelated providers and settings, exports only OpenAI GPT-5.6 models, and creates a backup before changing an existing config.
- [ ] Each configured GPT-5.6 model reports limits supplied by Val model
      metadata when present, otherwise a 1,050,000-token context limit and
      128,000-token output fallback.
- [ ] GPT-5.6 models without explicit Val effort metadata include `none`, `low`,
      `medium`, `high`, `xhigh`, and `max`; explicit Val restrictions win.
- [ ] Every configured `max` variant includes `reasoningEffort: "max"`, `reasoningSummary: "auto"`, and `include: ["reasoning.encrypted_content"]`.
- [ ] `pro-*` variants appear only when Val model metadata exposes
      `reasoning.mode: "pro"`, and OpenCode sends `reasoning.mode`, explicit
      prompt-cache options, text verbosity, and encrypted reasoning state.
- [ ] `GET /healthz` returns `status: "ok"` without identity values.
- [ ] Authenticated `GET /v1/models` returns Val's current model list.

## Local-network access

- [ ] The popup reports **Trusted LAN** and the companion listens on
      `0.0.0.0:8787`.
- [ ] From another device on a trusted local network, authenticated
      `GET http://<host-LAN-IP>:8787/v1/models` succeeds.
- [ ] The same LAN request without the client API key returns
      `invalid_api_key`.
- [ ] Browser requests from an unconfigured origin receive
      `origin_not_allowed`.
- [ ] With `VAL_BRIDGE_ALLOWED_CLIENT_IPS` set, an unlisted LAN address
      receives `client_ip_not_allowed` while loopback still works.
- [ ] **Use this device only** restarts the installed companion on
      `127.0.0.1`; **Enable trusted LAN** cleanly switches it back.

## Stateless generation

- [ ] Record the current visible Val history.
- [ ] Send a Chat Completions request with `store` absent or `false`.
- [ ] Confirm streaming and non-streaming output are OpenAI-shaped.
- [ ] Confirm the popup updates its token totals and labelled OpenAI API-equivalent USD estimate.
- [ ] Restart Helium and the companion and confirm saved usage totals return.
- [ ] **Reset usage totals** clears both popup and `usage-stats.json` totals;
      a delayed stale synchronization does not restore them.
- [ ] Confirm no new visible Val conversation was created.

## Stored generation and continuation

- [ ] Send a request with `store: true`.
- [ ] Confirm exactly one visible Val conversation is created and marked as
      bridge-owned in its metadata.
- [ ] Record the `x-val-chat-id` header or Responses `id`.
- [ ] Continue with `metadata.val_chat_id` or `previous_response_id`.
- [ ] Confirm the same Val conversation is updated, not duplicated.
- [ ] Attempting to target a non-bridge Val chat returns `chat_not_owned`.

## OpenAI JavaScript SDK v6

- [ ] Use the current `openai` v6 client against the companion `baseURL`.
- [ ] Verify `responses.create`, structured `responses.parse`, and
      `responses.stream`.
- [ ] Verify background create, retrieve, resumed streaming, cancel, and delete.
- [ ] Verify `responses.inputTokens.count`, `responses.inputItems.list`, and
      `responses.compact`.
- [ ] Verify prompt-template requests without a local `model` or `input`
      validation failure.
- [ ] Verify model retrieval, multipart file upload, file listing/retrieval,
      binary content download, and deletion if Val exposes those endpoints.
- [ ] Verify Chat Completions automatic tool execution through
      `chat.completions.runTools`.
- [ ] Verify advanced Chat Completions and Responses requests routed through
      the generic relay still update aggregate token, reasoning-token, and
      cost totals.
- [ ] Probe additional SDK HTTP resources one family at a time. The bridge must
      preserve Val's status, safe response headers, binary body, pagination,
      and OpenAI error envelope without claiming an unsupported capability.
- [ ] Confirm request bodies over 10 MiB receive `request_too_large`.

## Failure paths

- [ ] Invalid client key returns `invalid_api_key`.
- [ ] Closing Helium or the extension reports `extension_unavailable`.
- [ ] Logging out of Val reports `val_session_unavailable`.
- [ ] An expired Val session clears the session-only token.
- [ ] Interrupting an SSE client cancels the accepted Val task.
- [ ] Cancel during model lookup, session/socket preparation, and stored-chat
      preparation; none of those requests is accepted by Val afterward.
- [ ] Interrupting a generic SDK request cancels the extension fetch.
- [ ] Stopping the companion closes the bridge cleanly.
- [ ] An SDK endpoint not exposed by Val returns Val's OpenAI-shaped error
      unchanged; it is not fabricated as supported by the companion.

## Credential boundary

- [ ] `%LOCALAPPDATA%\ValOpenAIBridge\config.json` contains local bridge
      credentials but no RMIT bearer token.
- [ ] `response-mappings.json` contains IDs and timestamps, not message bodies.
- [ ] `chrome.storage.local` contains the bridge secret and companion URL only.
- [ ] The client API key is absent from persistent extension storage.
- [ ] `usage-stats.json` contains only aggregate counters and timestamps.
- [ ] `network-settings.json` contains only the selected network mode.
- [ ] `diagnostics.jsonl` and its optional `.1` rotation contain no prompt,
      response, Val token, client API key, or bridge secret.
- [ ] The key appears in OpenCode's config only after the user presses **Configure OpenCode**.
- [ ] `chrome.storage.session` may contain the Val token and aggregate usage
      statistics while Helium is running, but no message bodies or model IDs.
- [ ] `chrome.storage.local` may also contain sanitized update status, but no
      client API key or Val token.
- [ ] Companion logs and HTTP traffic never contain the RMIT bearer token.
- [ ] Multipart uploads and binary downloads are relayed in memory and are not
      written to companion configuration, mappings, usage, or diagnostics.

## Release artifact

- [ ] `npm run release:extension` passes from a clean install.
- [ ] The ZIP contains `manifest.json` at its root and no source maps.
- [ ] The ZIP contains 16, 32, 48, and 128 pixel PNG icons.
- [ ] The manifest requests only `storage`, exact Val access, and IPv4 loopback access.
- [ ] The SHA-256 digest matches the generated `.sha256` file.
- [ ] An injected update failure after extension, launcher, metadata, or
      reload-marker activation leaves the prior installation fully usable.
