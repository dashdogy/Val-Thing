# Privacy policy

Effective: 23 July 2026

Val OpenAI Local Bridge has one purpose: connect a user's signed-in RMIT Val chat session to OpenAI-compatible applications running on the same computer.

## Data handled

The extension and companion process:

- the RMIT Val session token needed to make requests as the signed-in user;
- prompts, responses, tool definitions and results, model metadata, usage metadata, and generated Val chat IDs sent through the local API;
- a locally generated extension bridge secret and client API key; and
- response-ID-to-Val-chat-ID mappings for stored conversation continuation.

The extension does not include analytics, advertising, telemetry, or developer-operated network services. The developer does not receive or sell this data.

## Where data goes

The extension communicates only with:

- `https://val.rmit.edu.au`, as necessary to provide its single purpose; and
- the Node companion at an IPv4 loopback address (`http://127.0.0.1`).

The companion binds only to IPv4 loopback. Prompts and responses remain between the user's local applications, the local companion, the extension, and RMIT Val. RMIT's own terms and privacy practices apply to information processed by Val.

## Storage and retention

- The Val session token is stored only in memory-backed `chrome.storage.session`. It is removed when the user signs out and is cleared when the extension is disabled, reloaded, updated, or the browser restarts.
- `chrome.storage.local` stores only the companion URL and locally generated bridge secret.
- The companion sends the client API key only after the extension authenticates. The extension holds it in service-worker and popup memory for the masked reveal/copy control and does not persist it.
- The companion stores its client API key, bridge secret, paired extension ID, and at most 1,000 response-to-Val-chat mappings under the user's local application-data directory.
- The companion does not persist prompt or response bodies.
- A request with `store: true` may create a Val conversation in the user's RMIT Val account. The user controls that history through Val.

## Permissions

- `storage` protects the session token in memory-backed extension storage and retains the local pairing secret and companion URL.
- Access to `https://val.rmit.edu.au/*` is required to read the signed-in session, retrieve models, submit chat requests, receive chat events, and update bridge-owned conversations.
- Access to `http://127.0.0.1/*` is required to pair with and connect to the local companion. The extension rejects non-loopback companion URLs.

## User controls

Users can unpair through the extension popup, remove the extension, delete `%LOCALAPPDATA%\ValOpenAIBridge`, and remove stored Val chats through Val. Removing the extension clears its session and local extension storage.

Questions or deletion requests should be sent through the support contact published with the extension's distribution page.

## Policy changes

Material changes will be described in the release notes and reflected by a new effective date.
