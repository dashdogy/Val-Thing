# Val OpenAI Local Bridge

A local, authenticated OpenAI-compatible API for the signed-in
[RMIT Val](https://val.rmit.edu.au) web session in Helium.

The project has three npm workspaces:

- `@val-bridge/extension`: a Chromium Manifest V3 extension for Helium
- `@val-bridge/server`: a Node 24 loopback companion
- `@val-bridge/protocol`: shared relay messages and OpenAI/Val types

The companion binds only to `127.0.0.1`. The RMIT bearer token stays in the
extension's memory-backed `chrome.storage.session`; it is never persisted to
`chrome.storage.local` or sent to the companion.

## Requirements

- Node.js 24 or newer
- Helium with current Manifest V3 and `chrome.storage.session` support
- A signed-in Val session at `https://val.rmit.edu.au`

## Install and pair

From this directory:

```powershell
npm install
npm run build
npm start
```

The companion prints:

- the API base URL
- a client API key for `/v1/*`
- a six-digit extension pairing code that expires after five minutes
- the local configuration path

In Helium:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select
   `packages\extension\dist`.
4. Open Val once and sign in.
5. Open the **Val OpenAI Local Bridge** extension popup.
6. Enter the pairing code printed by the companion.

The popup shows separate companion, Val session, chat relay, and compatibility
states. A green `ON` badge means the bridge is ready.

Restarting the companion creates a fresh five-minute pairing code but preserves
the generated secrets. Each code can be used once and locks after ten invalid
attempts. Pairing is only needed again if the extension is unpaired, reinstalled
with a different extension ID, or the companion configuration is replaced;
restart the companion to generate a new code.

## Use with the OpenAI JavaScript SDK

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.VAL_BRIDGE_API_KEY,
  baseURL: "http://127.0.0.1:8787/v1",
});

const models = await client.models.list();

const completion = await client.chat.completions.create({
  model: models.data[0].id,
  messages: [{ role: "user", content: "Reply in one sentence." }],
});

console.log(completion.choices[0].message.content);
```

Streaming Chat Completions:

```js
const stream = await client.chat.completions.create({
  model: models.data[0].id,
  messages: [{ role: "user", content: "Explain this incrementally." }],
  stream: true,
  stream_options: { include_usage: true },
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? "");
}
```

Responses and stored continuation:

```js
const first = await client.responses.create({
  model: models.data[0].id,
  input: "Start a stored conversation.",
  store: true,
});

const next = await client.responses.create({
  model: models.data[0].id,
  input: "Continue from the previous answer.",
  previous_response_id: first.id,
});
```

## Use with OpenCode

Configure the custom provider with `npm: "@ai-sdk/openai"` so OpenCode uses
the bridge's Responses endpoint. Mark reasoning-capable models with
`"reasoning": true`. In OpenCode Desktop, also enable **Settings → General →
Show reasoning summaries**; OpenCode keeps this display option off by default.

Val thinking returned by the bridge then appears as a native OpenCode reasoning
part instead of being mixed into the assistant answer. Models and prompts that
do not return a visible Val reasoning summary still show only the final answer.

## Endpoints

### `GET /healthz`

No API key is required. It reports only companion, extension, Val-session,
Socket.IO, compatibility, protocol, and active-request state. It contains no
identity or secret values.

### `GET /v1/models`

Requires `Authorization: Bearer <client-key>`. Models are fetched dynamically
from Val and returned as an OpenAI model list.

### `POST /v1/chat/completions`

Supports:

- streaming and non-streaming output
- system, developer, user, assistant, and tool messages
- text plus remote or data image URLs
- sampling parameters and stop sequences
- JSON object and JSON-schema response formats
- function definitions, tool choices, tool-call deltas, and tool results
- Val's user-visible thinking text as the compatible `reasoning_content` field
- usage fields

Val's chat wrapper normally resolves only tools registered in Val and may add
persona tools such as knowledge or chat search. For OpenAI clients, the bridge
registers the supplied function schemas as a request-scoped client tool server,
disables Val's built-in tool capability metadata, and asks Val to invoke only
those client functions. The extension approves only permission requests that
belong to that exact bridge tool server and name one of the supplied functions.
It intercepts the matching execution request, cancels the accepted Val task, and
returns a standard OpenAI tool call so the API client executes it locally.

Val's indirect function envelope remains a compatibility fallback when native
client functions are unavailable. Tool-bearing upstream turns are buffered
until the function decision is complete; ordinary text-only turns still stream
as they arrive. Internal Val tool markup is rejected instead of being returned
as assistant text. If an optional indirect tool call is accompanied by a
completed prose answer, the prose answer wins; required or explicitly selected
client tool calls still win.

`store` absent or `false` uses Val's temporary `local` chat. To create a
bridge-owned visible Val chat, set `store: true`. The response includes an
`x-val-chat-id` header. To append with Chat Completions, send:

```json
{
  "store": true,
  "metadata": {
    "val_chat_id": "the-prior-x-val-chat-id"
  }
}
```

The bridge checks the Val chat's ownership marker and refuses to overwrite a
chat it did not create.

### `POST /v1/responses`

Supports string input, message items, function-call items, function-call
outputs, instructions, non-streaming Response objects, and the standard
Responses SSE lifecycle/text/tool/completion events.

When Val returns user-visible thinking text, the bridge exposes it as a
`reasoning` output item with `summary_text`. Streaming clients receive the
standard `response.reasoning_summary_*` lifecycle and delta events. The bridge
recognizes Val/Open WebUI reasoning fields, explicit reasoning status records,
and streamed `<think>` or `<details type="reasoning">` containers without
mixing them into the final assistant text. It does not expose private model
chain-of-thought that Val itself does not return.

With `store: true`, the companion records only:

```text
OpenAI response ID -> Val chat ID
```

It does not store prompts or response bodies. Continue using
`previous_response_id`.

Other `/v1/*` endpoints, including audio, speech, image generation, embeddings,
files, batches, and fine-tuning, return an OpenAI `unsupported_feature` error.

## Runtime configuration

Environment variables:

| Variable                        | Default                          | Constraint                    |
| ------------------------------- | -------------------------------- | ----------------------------- |
| `VAL_BRIDGE_PORT`               | `8787`                           | `1` to `65535`                |
| `VAL_BRIDGE_MAX_CONCURRENCY`    | `4`                              | `1` to `32`                   |
| `VAL_BRIDGE_REQUEST_TIMEOUT_MS` | `300000`                         | At most five minutes          |
| `VAL_BRIDGE_CONFIG_DIR`         | `%LOCALAPPDATA%\ValOpenAIBridge` | Local path                    |
| `VAL_BRIDGE_CORS_ORIGINS`       | empty                            | Comma-separated exact origins |

The host is intentionally fixed at `127.0.0.1`; a non-loopback host is rejected.
Browser CORS is denied unless its exact origin is configured. Native SDK and
command-line requests normally send no `Origin` header and are unaffected.

The first run creates:

- `config.json`: separate client API and extension bridge secrets, plus the
  currently paired extension ID
- `response-mappings.json`: response-to-Val-chat continuation mappings only

Treat the client API key like any other local credential. The companion does not
log request or response bodies.

## Relay behavior

- Every Val completion uses a unique assistant message ID and the current
  Socket.IO session ID.
- Socket events are correlated by session, chat, and message IDs.
- Prompts are submitted once and are never retried after Val assigns a task.
- Disconnecting a client sends cancellation to the accepted Val task.
- Replacements, text and reasoning deltas, tool deltas, usage, completion,
  errors, and rate limits are normalized to OpenAI shapes.
- Permission requests are auto-approved only for request-scoped bridge client
  tools whose names were supplied by the API caller. All other interactive Val
  approvals and inputs are rejected.
- The companion allows four active generations, 10 MiB request bodies, and a
  maximum five-minute generation time by default.

## Development and verification

```powershell
npm run check
```

The tests cover validation, Chat/Responses translation, SSE event boundaries,
prefix replacements, usage, split tool-call deltas, Val history construction,
OpenAI errors, authentication, pairing-origin checks, concurrency, interrupted
stream cancellation, extension disconnection/reconnection, stored mappings,
and official OpenAI JavaScript SDK contracts.

See [docs/LIVE_ACCEPTANCE.md](docs/LIVE_ACCEPTANCE.md) for the signed-in Helium
acceptance checklist.

## Release

```powershell
npm run release:extension
```

This creates a production ZIP and SHA-256 file under `release\`. Release builds
are minified, omit source maps, validate the narrow permission boundary, and
include 16, 32, 48, and 128 pixel store icons.

Before distribution, follow [the release guide](docs/RELEASE.md), publish the
[privacy policy](docs/PRIVACY.md) at a stable HTTPS URL, and use the prepared
[store listing disclosures](docs/STORE_LISTING.md).

## Policy boundary

This adapter uses your authenticated RMIT account. Its use remains subject to
RMIT acceptable-use, academic-integrity, privacy, and rate-limit policies. It is
not an authentication bypass and is not endorsed by RMIT.
