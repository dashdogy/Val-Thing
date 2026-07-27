# Chrome Web Store listing copy

Use this as the disclosure and listing source of truth. Keep the dashboard answers consistent with `docs/PRIVACY.md`.

## Name

Val OpenAI Local Bridge

## Short description

Connects your signed-in RMIT Val session to an authenticated OpenAI-compatible API.

## Single purpose

Expose the user's signed-in RMIT Val chat session to authorized OpenAI-compatible clients through an authenticated user-operated companion.

## Detailed description

Val OpenAI Local Bridge lets local development tools use the models available
in your signed-in RMIT Val session through familiar Chat Completions, Responses,
and other OpenAI SDK v6 HTTP operations that Val exposes.

The extension:

- connects only to RMIT Val and an IPv4 loopback companion;
- keeps the RMIT bearer token inside the browser extension;
- supports streaming, tool calls, structured output, image and file inputs,
  visible Val reasoning summaries, cancellation, optional stored continuations,
  and transparent SDK v6 HTTP pass-through for capabilities exposed by Val;
- shows durable token and reasoning-token totals plus a dated OpenAI API-equivalent cost estimate without persisting message content or model identifiers;
- lets the user reset usage totals, rotate the client API key, and choose device-only or trusted-LAN access;
- checks periodically for signed release updates and presents an explicit update button;
- can launch the separately installed companion through a fixed local operating-system protocol URL; and
- includes no analytics, advertising, telemetry, or developer-operated service.

The separately installed Node 24 companion is required. Use remains subject to RMIT acceptable-use, academic-integrity, privacy, and rate-limit policies. This project is not endorsed by RMIT.

## Permission justifications

### `storage`

Stores the RMIT token and synchronized aggregate usage counters in
memory-backed session storage. Local extension storage retains the locally
generated bridge secret, companion URL, and sanitized update status.

Displays the companion's client API key behind a masked reveal/copy control after the local bridge authenticates; the key is not persisted by the extension.

Provides a user-triggered button that asks the local companion to merge the endpoint, API key, and OpenAI GPT-5.6 models into the user's OpenCode configuration with a backup.

Provides a user-triggered **Launch companion** button. It opens only the fixed `val-openai-bridge://launch` URL registered by the separately installed companion and sends no user data through that URL.

### `alarms`

Schedules release update checks at a fixed interval. The check sends only the
installed extension version and local bridge authentication to the companion;
the companion fetches public GitHub release metadata.

### `https://val.rmit.edu.au/*`

Reads the active Val session and communicates with Val's model, chat, task, and Socket.IO services. No other website is matched.

### `http://127.0.0.1/*`

Pairs with and maintains an authenticated connection to the user-operated companion. A wildcard port is needed because the loopback port is configurable. The extension rejects hostnames other than the literal IPv4 loopback address.

## User-data disclosure

Disclose authentication information and website content because the extension handles the Val session token and relays user chat content. State that:

- handling is required for the extension's single purpose;
- data is sent only to RMIT Val and the user's companion, whose authenticated API can be made available to trusted local-network clients;
- data is not sold, used for advertising, or used for unrelated purposes; and
- prompt and response bodies are not persistently stored by the companion.

Disclose that sanitized usage totals and bounded diagnostics persist locally,
and that diagnostics include request/model identifiers, outcomes, durations,
token counts, reasoning status/settings, tool-call counts, and error codes.

## Review instructions

The reviewer needs:

1. Node.js 24 or newer;
2. the companion source or release bundle and its startup command;
3. access to an authorized RMIT Val test account;
4. the five-minute pairing code shown in the companion console or local
   Windows pairing page; and
5. a benign Chat Completions test request.

If an authorized reviewer account cannot be provided, use a private or otherwise appropriately restricted distribution channel rather than submitting an untestable public listing.

## Assets still supplied in the dashboard

- At least one current popup screenshot.
- A 440 x 280 small promotional tile if the selected listing surface requires it.
- A stable HTTPS URL containing `docs/PRIVACY.md`.
- A monitored support contact.
