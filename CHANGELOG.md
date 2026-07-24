# Changelog

All notable changes to Val OpenAI Local Bridge are documented here.

## 0.1.11 - 2026-07-25

- Raised the default and maximum companion concurrency to 16 simultaneous
  requests, the practical ceiling selected after live Val load testing.
- Persisted sanitized usage counters, token totals, reasoning-token totals, and
  OpenAI-equivalent cost estimates atomically in the companion configuration
  directory so statistics survive browser and companion restarts.
- Added authenticated usage synchronization between the extension and
  companion while keeping prompts, responses, models, identities, and secrets
  out of the usage file.
- Clarified the popup's saved usage totals and displayed the exact reasoning
  token count reported for the most recent request.

## 0.1.10 - 2026-07-24

- Changed configured relay timeouts into reasoning-activity deadlines: each
  genuine reasoning chunk refreshes the timer, while silent relays still time
  out and are cancelled upstream.

## 0.1.9 - 2026-07-24

- Routed `/v1/responses` through Val's native `/openai/v1/responses` endpoint,
  preserving encrypted reasoning items and `reasoning.context: "all_turns"` for
  stateful tool-call loops.
- Added capability-negotiated native Responses streaming while retaining the
  legacy adapter during rolling updates and for pre-native stored mappings.
- Removed the five-minute timeout ceiling for Responses requests; added a
  dedicated `VAL_BRIDGE_RESPONSE_TIMEOUT_MS` setting (default 0 = no timeout).
- Raised the maximum configurable request timeout to 30 minutes.
- Kept strict extension-origin pairing and hardened SSE parsing, cancellation,
  terminal-event validation, serialized continuation mappings, and sanitized
  usage accounting.

## 0.1.3 - 2026-07-24

- Fixed the macOS companion URL-handler bundle by declaring its required
  Launch Services role and removing a background-only flag that is valid only
  for Mach-O applications.
- Made handler registration self-repair on reinstall, startup, and automatic
  update so existing 0.1.2 installations recover without manual file edits.
- Made the popup retry the companion immediately after launch and avoid
  reporting expected offline WebSocket attempts as extension errors.
- Closed active sockets before an update-triggered extension reload to avoid
  stale-worker `Extension context invalidated` errors.

## 0.1.2 - 2026-07-24

- Added a popup button that launches the installed companion through a
  per-user OS protocol handler.
- Registered the launch handler on Windows, macOS, and Linux without adding a
  Chrome permission.
- Made the installed launcher visibly check GitHub Releases for an update
  before every companion startup, with offline fallback to the installed
  version.

## 0.1.1 - 2026-07-24

- Changed the companion's default bind address to `0.0.0.0`, allowing
  authenticated API clients on trusted local networks.
- Kept extension pairing and automatic OpenCode configuration on IPv4
  loopback.
- Added explicit LAN security guidance and acceptance coverage.
- Limited automatic OpenCode configuration to the OpenAI GPT-5.6 family,
  including 1,050,000-token context and 128,000-token output limits.
- Added encrypted reasoning-state settings to every GPT-5.6 `max` variant.
- Added session-only OpenAI API-equivalent cost estimates to extension usage
  statistics, including cached-token and long-context pricing adjustments.

## 0.1.0 - 2026-07-23

- Added a Manifest V3 Helium extension scoped to RMIT Val and IPv4 loopback.
- Added authenticated Chat Completions and Responses APIs through the Node companion.
- Added streaming, visible reasoning summaries, structured output, vision URLs, function calls, cancellation, and stored continuations.
- Added dynamic Val model discovery and OpenCode compatibility.
- Added session-only Val credential handling and one-time extension pairing.
- Added session-only token and request statistics to the extension popup.
- Added a masked reveal/copy control for the companion client API key.
- Added a popup action that safely configures OpenCode and backs up an existing config.
- Added deterministic extension ZIP packaging, store icons, checksums, and release documentation.
- Added a checksum-verified installer, updater, and launcher for Windows, macOS, and Linux.
- Added a single-command, cross-platform installer delivered through GitHub Releases and `npx`.
- Added GitHub Releases automation and a three-OS packaging test matrix.
