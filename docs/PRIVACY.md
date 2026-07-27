# Privacy policy

Effective: 27 July 2026

Val OpenAI Local Bridge has one purpose: connect a user's signed-in RMIT Val chat session to OpenAI-compatible applications running on the same computer or a trusted local network.

## Data handled

The extension and companion process:

- the RMIT Val session token needed to make requests as the signed-in user;
- prompts, responses, tool definitions and results, uploaded/downloaded file
  content, model metadata, usage metadata, and generated Val chat IDs sent
  through the local API;
- a locally generated extension bridge secret and client API key; and
- response-ID-to-Val-chat-ID mappings for stored conversation continuation.

The extension does not include analytics, advertising, telemetry, or developer-operated network services. The developer does not receive or sell this data.

## Where data goes

The extension communicates only with:

- `https://val.rmit.edu.au`, as necessary to provide its single purpose; and
- the Node companion through IPv4 loopback (`http://127.0.0.1`).

When the user presses **Launch companion**, the extension opens the fixed `val-openai-bridge://launch` operating-system protocol URL. The URL contains no user data, credentials, prompts, model names, or identifiers. The per-user handler installed with the companion starts the local launcher.

The companion initially listens on all IPv4 interfaces (`0.0.0.0`). The popup
can switch it between **Trusted LAN** and **This device only**, and the chosen
mode is retained for later launches. An optional exact-IP allowlist can further
restrict LAN clients. `/v1/*` requests always require the locally generated
client API key, browser CORS remains restricted to explicitly configured
origins, and the RMIT bearer token remains inside the extension.

For OpenAI SDK endpoints that Val exposes, the companion relays the method,
path, query, safe SDK headers, and in-memory request/response bytes through the
authenticated extension connection. It never forwards the companion client API
key, cookies, browser origin headers, or the RMIT bearer token across the wrong
credential boundary.

The companion API uses unencrypted HTTP. Users should keep its API key private
and use LAN mode only on a trusted network protected by a host firewall or
private VPN. Prompts and responses cross that network when a remote client uses
the API. RMIT's own terms and privacy practices apply to information processed
by Val.

The installed launcher checks the project's GitHub Releases metadata whenever it starts the companion and may download a newer checksum-verified release. This update request does not include the RMIT token, bridge secrets, API key, prompts, responses, or Val identity data. If the check fails, the installed version starts instead.

## Storage and retention

- The Val session token is stored only in memory-backed `chrome.storage.session`. It is removed when the user signs out and is cleared when the extension is disabled, reloaded, updated, or the browser restarts.
- Aggregate request counts, token counts, reasoning-token counts, and OpenAI
  API-equivalent cost estimates are stored in `chrome.storage.session` while
  the browser is running and in the companion's `usage-stats.json` so totals
  survive restarts. These statistics contain no prompt or response bodies,
  identities, credentials, or model identifiers.
- `chrome.storage.local` stores the companion URL, locally generated bridge
  secret, and sanitized extension-update status such as version numbers and
  check time.
- The companion sends the client API key only after the extension authenticates. The extension holds it in service-worker and popup memory for the masked reveal/copy control and does not persist it.
- The companion stores its client API key, bridge secret, paired extension ID,
  selected network mode, usage totals, and at most 1,000
  response-to-Val-chat mappings under the user's local application-data
  directory.
- The companion writes a sanitized `diagnostics.jsonl` containing timestamps,
  request and model identifiers, endpoints, outcomes, durations, token counts,
  reasoning settings/status, tool-call counts, and error codes. It is bounded
  to 1 MiB plus one rotated `.1` file. It contains no prompt or response text,
  Val token, bridge secret, or client API key.
- The companion does not persist prompt or response bodies.
- If the user presses **Configure OpenCode**, the companion writes its local loopback endpoint, client API key, and OpenAI GPT-5.6 model metadata to the user's global OpenCode config. It creates a timestamped backup before changing an existing file.
- A request with `store: true` may create a Val conversation in the user's RMIT Val account. The user controls that history through Val.

## Permissions

- `storage` protects the session token in memory-backed extension storage and retains the local pairing secret and companion URL.
- `alarms` schedules periodic update checks while the browser is running.
- Access to `https://val.rmit.edu.au/*` is required to read the signed-in session, retrieve models, submit chat requests, receive chat events, and update bridge-owned conversations.
- Access to `http://127.0.0.1/*` is required to pair with and connect to the local companion. The extension rejects non-loopback companion URLs.

## User controls

The popup can:

- reset all persisted usage and cost totals;
- rotate the client API key, immediately invalidating the old key; and
- change between device-only and trusted-LAN access.

Users can also unpair, remove the extension, remove the `val` provider from
their OpenCode config, and remove stored Val chats through Val. The default
installed data directory is:

- `%LOCALAPPDATA%\ValOpenAIBridge` on Windows;
- `~/Library/Application Support/ValOpenAIBridge` on macOS; or
- `${XDG_DATA_HOME:-~/.local/share}/val-openai-bridge` on Linux.

Deleting that directory removes companion credentials, mappings, diagnostics,
network settings, installed runtime files, and usage totals. Removing the
extension clears its session and local extension storage.

Do not post credentials or private chat data in a public support request.
Security reports should use the repository's private vulnerability-reporting
channel when available, with the fallback described in `SECURITY.md`.

## Policy changes

Material changes will be described in the release notes and reflected by a new effective date.
