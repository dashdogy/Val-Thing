import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { access, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { URL } from "node:url";
import {
  PROTOCOL_VERSION,
  type PairRequest,
  type PairResponse,
  type RelayDoneResult,
  type RelayOpenAIHttpRequest,
} from "@val-bridge/protocol";
import { WebSocketServer } from "ws";
import { BridgeHub } from "./bridge-hub.js";
import { ChatAccumulator } from "./chat-accumulator.js";
import {
  createPairingCode,
  loadRuntimeConfig,
  SecretsStore,
  type RuntimeConfig,
} from "./config.js";
import { DiagnosticsLog } from "./diagnostics.js";
import {
  asOpenAIHttpError,
  OpenAIHttpError,
  openAIErrorBody,
} from "./errors.js";
import { MappingStore } from "./mapping-store.js";
import { valModelIdForOpenAI } from "./model-ids.js";
import {
  hostForNetworkScope,
  NetworkSettingsStore,
  networkScopeForHost,
  type NetworkScope,
} from "./network-settings.js";
import {
  chatRequestToRelay,
  parseChatCompletion,
  parseResponse,
  titleFromMessages,
  type ChatCompletionRequest,
  responseRequestToRelay,
  type ResponseRequest,
} from "./openai-schema.js";
import {
  decodeRelayChunk,
  parseJsonBuffer,
  readRawBody,
  relayHttpMethod,
  requestHeadersForRelay,
  responseHeadersForClient,
  validateOpenAIProxyPath,
} from "./openai-http-relay.js";
import {
  configureOpenCode,
  openAIModelCapabilities,
} from "./opencode-config.js";
import {
  reasoningDisclosure,
  reasoningSettingsFromParameters,
  reasoningSettingsFromResponse,
  type ReasoningDisclosure,
  usageTokenCounts,
} from "./reasoning-state.js";
import { ResponsesAdapter } from "./responses-adapter.js";
import { Semaphore } from "./semaphore.js";
import { UpdateChecker } from "./update-checker.js";
import { UsageStatsStore } from "./usage-stats-store.js";

type BridgeServerOptions = {
  config?: Partial<RuntimeConfig>;
  quiet?: boolean;
  updateChecker?: UpdateChecker;
  onUpdateRequested?: () => void;
};

const MAX_PAIRING_FAILURES = 10;
const CORS_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-stainless-arch",
  "x-stainless-custom-poll-interval",
  "x-stainless-helper-method",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-poll-helper",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
].join(", ");
const CORS_RESPONSE_HEADERS = [
  "content-disposition",
  "etag",
  "location",
  "openai-processing-ms",
  "openai-version",
  "retry-after",
  "retry-after-ms",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-should-retry",
  "x-val-chat-id",
  "x-val-reasoning-status",
  "x-val-reasoning-tokens",
  "x-val-reasoning-tokens-reported",
].join(", ");
const CHAT_BRIDGE_FIELDS = new Set([
  "audio",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "messages",
  "metadata",
  "modalities",
  "model",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "reasoning_effort",
  "reasoning_summary",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "verbosity",
]);
const CHAT_BRIDGE_ROLES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);
const CHAT_BRIDGE_CONTENT_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "image_url",
  "input_image",
]);

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function normalizeRemoteAddress(address: string) {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isLoopbackAddress(address: string) {
  const normalized = normalizeRemoteAddress(address);
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export function clientIpAllowed(
  remoteAddress: string,
  allowedClientIps: ReadonlySet<string>,
) {
  if (isLoopbackAddress(remoteAddress)) return true;
  return allowedClientIps.size === 0 || allowedClientIps.has(remoteAddress);
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function noContent(
  response: ServerResponse,
  headers: Record<string, string> = {},
) {
  response.writeHead(204, headers);
  response.end();
}

function pairingPageDocument(
  pairingCode: string,
  pairingExpiresAt: number,
  pairingCompleted: boolean,
) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((pairingExpiresAt - Date.now()) / 1_000),
  );
  const content = pairingCompleted
    ? `<p class="status success">Pairing completed.</p>
       <p>Return to the extension popup. It should connect automatically.</p>`
    : remainingSeconds === 0
      ? `<p class="status expired">This pairing code has expired.</p>
         <p>Restart the companion to generate a new code.</p>`
      : `<p>Enter this code in the extension popup:</p>
         <div class="code" aria-label="Pairing code">${pairingCode}</div>
         <p class="expires">Expires in ${remainingSeconds} seconds.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="refresh" content="5">
    <title>Val Bridge pairing</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10141c; color: #edf4ff; }
      main { width: min(32rem, calc(100% - 2rem)); box-sizing: border-box; padding: 2rem; border: 1px solid #324052; border-radius: 1rem; background: #18202b; box-shadow: 0 1.25rem 4rem #0008; text-align: center; }
      h1 { margin: 0 0 1rem; font-size: 1.5rem; }
      p { color: #bac8da; line-height: 1.5; }
      .code { margin: 1.25rem 0 .75rem; padding: 1rem; border-radius: .75rem; background: #0b1017; color: #8ed6ff; font: 700 2.5rem/1 ui-monospace, monospace; letter-spacing: .35em; text-indent: .35em; user-select: all; }
      .expires { font-size: .875rem; }
      .status { font-size: 1.125rem; font-weight: 700; }
      .success { color: #8ee6ad; }
      .expired { color: #ffb3b3; }
      footer { margin-top: 1.5rem; color: #8190a3; font-size: .75rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Val Bridge pairing</h1>
      ${content}
      <footer>Available only on this computer. This page is never cached.</footer>
    </main>
  </body>
</html>`;
}

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  return parseJsonBuffer(await readRawBody(request, limitBytes));
}

function bearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function chatNeedsHttpRelay(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => !CHAT_BRIDGE_FIELDS.has(key))) {
    return true;
  }
  if (value.n !== undefined && value.n !== 1) return true;
  if (value.audio !== undefined && value.audio !== null) return true;
  if (
    Array.isArray(value.modalities) &&
    value.modalities.some((modality) => modality !== "text")
  ) {
    return true;
  }
  if (
    Array.isArray(value.tools) &&
    value.tools.some((tool) => plainRecord(tool)?.type !== "function")
  ) {
    return true;
  }
  if (!Array.isArray(value.messages)) return false;
  return value.messages.some((rawMessage) => {
    const message = plainRecord(rawMessage);
    if (!message) return false;
    if (!CHAT_BRIDGE_ROLES.has(String(message.role))) return true;
    if (!Array.isArray(message.content)) return false;
    return message.content.some((rawPart) => {
      const part = plainRecord(rawPart);
      return part ? !CHAT_BRIDGE_CONTENT_TYPES.has(String(part.type)) : false;
    });
  });
}

function writeChatSse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeSseEvent(
  response: ServerResponse,
  eventType: string,
  data: unknown,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(eventType)) {
    throw new OpenAIHttpError(
      502,
      "invalid_bridge_event",
      "The extension returned an invalid Responses event type.",
      "api_connection_error",
    );
  }
  response.write(`event: ${eventType}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function reasoningHeaders(
  disclosure: ReasoningDisclosure,
): Record<string, string> {
  return {
    "x-val-reasoning-status": disclosure.status,
    "x-val-reasoning-tokens": String(disclosure.reasoning_tokens),
    "x-val-reasoning-tokens-reported": String(disclosure.tokens_reported),
  };
}

export class ValBridgeServer {
  readonly config: RuntimeConfig;
  readonly pairingCode: string;
  readonly pairingExpiresAt: number;
  readonly secrets: SecretsStore;
  readonly mappings: MappingStore;
  readonly hub: BridgeHub;
  readonly diagnostics: DiagnosticsLog;
  readonly updateChecker: UpdateChecker;
  readonly usageStats: UsageStatsStore;
  readonly networkSettings: NetworkSettingsStore;

  private readonly semaphore: Semaphore;
  private readonly httpServer;
  private readonly websocketServer;
  private heartbeat?: NodeJS.Timeout;
  private reloadWatcher?: NodeJS.Timeout;
  private pairingCompleted = false;
  private pairingFailures = 0;
  private activeApiRequests = 0;
  private restartShutdownScheduled = false;

  private constructor(
    config: RuntimeConfig,
    secrets: SecretsStore,
    mappings: MappingStore,
    diagnostics: DiagnosticsLog,
    updateChecker: UpdateChecker,
    usageStats: UsageStatsStore,
    networkSettings: NetworkSettingsStore,
    private readonly quiet: boolean,
    private readonly onUpdateRequested?: () => void,
  ) {
    this.config = config;
    this.secrets = secrets;
    this.mappings = mappings;
    this.diagnostics = diagnostics;
    this.updateChecker = updateChecker;
    this.usageStats = usageStats;
    this.networkSettings = networkSettings;
    this.pairingCode = createPairingCode();
    this.pairingExpiresAt = Date.now() + 5 * 60_000;
    this.hub = new BridgeHub(secrets, config.requestTimeoutMs, usageStats);
    this.semaphore = new Semaphore(config.maxConcurrency);

    this.httpServer = createServer((request, response) => {
      void this.route(request, response);
    });
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: config.bodyLimitBytes,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const origin = request.headers.origin ?? "";
      const originExtensionId = this.extensionIdFromOrigin(origin);
      if (url.pathname !== "/bridge/ws" || !originExtensionId) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.hub.attach(websocket, originExtensionId);
      });
    });
  }

  static async create(options: BridgeServerOptions = {}) {
    const initialConfig = loadRuntimeConfig(options.config);
    const networkSettings = await NetworkSettingsStore.open(
      initialConfig.configDirectory,
    );
    const persistedScope = networkSettings.get();
    const hasExplicitHost =
      options.config?.host !== undefined ||
      Boolean(process.env.VAL_BRIDGE_HOST?.trim());
    const config =
      persistedScope && !hasExplicitHost
        ? loadRuntimeConfig({
            ...options.config,
            host: hostForNetworkScope(persistedScope),
          })
        : initialConfig;
    const secrets = await SecretsStore.open(config.configDirectory);
    const mappings = await MappingStore.open(config.configDirectory);
    const diagnostics = new DiagnosticsLog(config.configDirectory);
    const updateChecker = options.updateChecker ?? new UpdateChecker();
    const usageStats = await UsageStatsStore.open(config.configDirectory);
    return new ValBridgeServer(
      config,
      secrets,
      mappings,
      diagnostics,
      updateChecker,
      usageStats,
      networkSettings,
      options.quiet ?? false,
      options.onUpdateRequested,
    );
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
    this.heartbeat = setInterval(() => this.hub.ping(), 20_000);
    this.heartbeat.unref();
    this.reloadWatcher = setInterval(() => {
      void this.reloadUpdatedExtension();
    }, 2_000);
    this.reloadWatcher.unref();
    void this.reloadUpdatedExtension();

    if (!this.quiet) {
      const port = this.address?.port ?? this.config.port;
      console.log(`Val OpenAI Bridge listening on ${this.config.host}:${port}`);
      console.log(`Local API: ${this.baseUrl}/v1`);
      if (this.config.host === "0.0.0.0") {
        console.log(`LAN API: http://<this-computer's-LAN-IP>:${port}/v1`);
      }
      console.log(
        `Extension pairing code: ${this.pairingCode} (expires in five minutes)`,
      );
      console.log(`Configuration: ${this.secrets.path}`);
      console.log(`Usage statistics: ${this.usageStats.path}`);
      console.log(`Sanitized diagnostics: ${this.diagnostics.path}`);
    }
    return this.address;
  }

  get address() {
    return this.httpServer.address() as AddressInfo | null;
  }

  get baseUrl() {
    const address = this.address;
    const port = address?.port ?? this.config.port;
    const clientHost =
      this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host;
    return `http://${clientHost}:${port}`;
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reloadWatcher) clearInterval(this.reloadWatcher);
    this.hub.close();
    for (const client of this.websocketServer.clients) {
      client.close(1001, "Companion shutting down");
    }
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    await this.usageStats.flush();
    await this.diagnostics.close();
  }

  private async reloadUpdatedExtension() {
    const marker = join(this.config.configDirectory, "reload-extension");
    try {
      await access(marker);
      if (this.hub.reloadExtension()) {
        await rm(marker, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Update markers are advisory. A later interval can retry.
      }
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const method = request.method ?? "GET";
      const corsHeaders = this.corsHeaders(request, url.pathname);

      if (method === "OPTIONS") {
        noContent(response, {
          ...corsHeaders,
          "access-control-allow-methods": CORS_METHODS,
          "access-control-allow-headers": CORS_REQUEST_HEADERS,
          "access-control-max-age": "600",
        });
        return;
      }

      if (method === "GET" && url.pathname === "/healthz") {
        const extension = this.hub.getStatus();
        json(
          response,
          200,
          {
            status: this.hub.hasReadyExtension() ? "ok" : "degraded",
            protocol_version: PROTOCOL_VERSION,
            network_scope: networkScopeForHost(this.config.host),
            client_ip_allowlist: this.config.allowedClientIps.size > 0,
            extension_connected: extension.extensionConnected,
            val_session: extension.valSession,
            val_socket: extension.valSocket,
            compatible: extension.compatible,
            active_requests: this.activeApiRequests,
            openai_sdk: {
              major: 6,
              http_passthrough: true,
              websocket_passthrough: false,
              body_limit_bytes: this.config.bodyLimitBytes,
            },
          },
          corsHeaders,
        );
        return;
      }

      if (method === "GET" && url.pathname === "/pairing") {
        this.handlePairingPage(request, response, url);
        return;
      }

      if (method === "POST" && url.pathname === "/bridge/pair") {
        await this.handlePair(request, response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/bridge/configure-opencode") {
        this.authenticateExtensionControl(request);
        await this.handleConfigureOpenCode(response, corsHeaders);
        return;
      }
      if (method === "GET" && url.pathname === "/bridge/update/status") {
        this.authenticateExtensionControl(request);
        await this.handleUpdateStatus(url, response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/bridge/update/prepare") {
        this.authenticateExtensionControl(request);
        await this.handlePrepareUpdate(request, response, corsHeaders);
        return;
      }
      if (
        method === "POST" &&
        url.pathname === "/bridge/security/rotate-client-key"
      ) {
        this.authenticateExtensionControl(request);
        await this.handleRotateClientKey(response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/bridge/usage/reset") {
        this.authenticateExtensionControl(request);
        await this.handleResetUsage(response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/bridge/network-scope") {
        this.authenticateExtensionControl(request);
        await this.handleNetworkScope(request, response, corsHeaders);
        return;
      }

      if (url.pathname.startsWith("/v1/")) {
        this.authenticateClient(request);
        if (this.restartShutdownScheduled) {
          throw new OpenAIHttpError(
            503,
            "bridge_updating",
            "The local Val bridge is restarting to apply an update.",
            "api_connection_error",
          );
        }
      }

      if (method === "GET" && url.pathname === "/v1/models") {
        await this.trackApiRequest(() =>
          this.handleModels(response, corsHeaders),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        await this.trackApiRequest(() =>
          this.handleChatCompletion(request, response, corsHeaders),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/v1/responses") {
        await this.trackApiRequest(() =>
          this.handleResponse(request, response, corsHeaders),
        );
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        await this.trackApiRequest(() =>
          this.handleOpenAIProxy(request, response, url, corsHeaders),
        );
        return;
      }
      throw new OpenAIHttpError(
        404,
        "not_found",
        "The requested route does not exist.",
      );
    } catch (rawError) {
      const error = asOpenAIHttpError(rawError);
      if (response.destroyed) return;
      if (response.headersSent) {
        if (!response.writableEnded) {
          writeChatSse(response, openAIErrorBody(error));
          response.write("data: [DONE]\n\n");
          response.end();
        }
        return;
      }
      json(response, error.status, openAIErrorBody(error));
    }
  }

  private handlePairingPage(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) {
    const remoteAddress = request.socket.remoteAddress ?? "";
    const hostname = url.hostname.toLowerCase();
    if (
      !isLoopbackAddress(remoteAddress) ||
      (hostname !== "127.0.0.1" &&
        hostname !== "localhost" &&
        hostname !== "[::1]") ||
      request.headers.origin
    ) {
      throw new OpenAIHttpError(
        403,
        "pairing_page_loopback_only",
        "The pairing page is available only as a local browser page.",
        "permission_error",
      );
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    response.end(
      pairingPageDocument(
        this.pairingCode,
        this.pairingExpiresAt,
        this.pairingCompleted,
      ),
    );
  }

  private corsHeaders(
    request: IncomingMessage,
    pathname: string,
  ): Record<string, string> {
    const origin = request.headers.origin;
    if (!origin) return {};
    const isExtensionPairing =
      pathname.startsWith("/bridge/") &&
      origin.startsWith("chrome-extension://");
    if (!isExtensionPairing && !this.config.corsOrigins.has(origin)) {
      throw new OpenAIHttpError(
        403,
        "origin_not_allowed",
        "This browser origin is not allowed to access the local bridge.",
        "permission_error",
      );
    }
    return {
      "access-control-allow-origin": origin,
      "access-control-expose-headers": CORS_RESPONSE_HEADERS,
      vary: "Origin",
    };
  }

  private authenticateClient(request: IncomingMessage) {
    const token = bearerToken(request);
    if (!token || !safeEqual(token, this.secrets.get().clientApiKey)) {
      throw new OpenAIHttpError(
        401,
        "invalid_api_key",
        "The local Val bridge API key is invalid.",
        "authentication_error",
      );
    }
    const remoteAddress = normalizeRemoteAddress(
      request.socket.remoteAddress ?? "",
    );
    if (!clientIpAllowed(remoteAddress, this.config.allowedClientIps)) {
      throw new OpenAIHttpError(
        403,
        "client_ip_not_allowed",
        "This client IP address is not allowed to access the bridge API.",
        "permission_error",
      );
    }
  }

  private authenticateExtensionControl(request: IncomingMessage) {
    const configured = this.secrets.get();
    const extensionId = this.extensionIdFromOrigin(
      request.headers.origin ?? "",
    );
    const token = bearerToken(request);
    if (
      !configured.extensionId ||
      extensionId !== configured.extensionId ||
      !token ||
      !safeEqual(token, configured.bridgeSecret)
    ) {
      throw new OpenAIHttpError(
        401,
        "invalid_bridge_authentication",
        "The extension control request is not authenticated.",
        "authentication_error",
      );
    }
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const body = (await readJsonBody(
      request,
      64 * 1024,
    )) as Partial<PairRequest>;
    const originExtensionId = this.extensionIdFromOrigin(
      request.headers.origin ?? "",
    );
    if (
      typeof body.code !== "string" ||
      typeof body.extensionId !== "string" ||
      body.protocolVersion !== PROTOCOL_VERSION ||
      !originExtensionId ||
      body.extensionId !== originExtensionId
    ) {
      throw new OpenAIHttpError(
        400,
        "invalid_pairing_request",
        "Invalid extension pairing request.",
      );
    }
    if (this.pairingCompleted) {
      throw new OpenAIHttpError(
        409,
        "pairing_already_completed",
        "This pairing code has already been used. Restart the companion to pair again.",
      );
    }
    if (Date.now() > this.pairingExpiresAt) {
      throw new OpenAIHttpError(
        401,
        "invalid_pairing_code",
        "The pairing code has expired. Restart the companion to generate a new code.",
        "authentication_error",
      );
    }
    if (this.pairingFailures >= MAX_PAIRING_FAILURES) {
      throw new OpenAIHttpError(
        429,
        "pairing_attempts_exceeded",
        "Too many invalid pairing attempts. Restart the companion to generate a new code.",
        "rate_limit_error",
      );
    }
    if (!safeEqual(body.code, this.pairingCode)) {
      this.pairingFailures += 1;
      throw new OpenAIHttpError(
        401,
        "invalid_pairing_code",
        "The pairing code is invalid.",
        "authentication_error",
      );
    }
    await this.secrets.authorizeExtension(body.extensionId);
    this.pairingCompleted = true;
    const result: PairResponse = {
      bridgeSecret: this.secrets.get().bridgeSecret,
      protocolVersion: PROTOCOL_VERSION,
    };
    json(response, 200, result, headers);
  }

  private extensionIdFromOrigin(origin: string) {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === "chrome-extension:" && parsed.hostname
        ? parsed.hostname
        : null;
    } catch {
      return null;
    }
  }

  private async handleConfigureOpenCode(
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const modelResult = await this.hub.execute({ kind: "models" });
    const result = await configureOpenCode({
      baseURL: `${this.baseUrl}/v1`,
      clientApiKey: this.secrets.get().clientApiKey,
      models: modelResult.models ?? [],
    });
    json(
      response,
      200,
      {
        configured: true,
        provider_id: result.providerId,
        models_configured: result.modelsConfigured,
        updated: result.updated,
        backup_created: Boolean(result.backupPath),
      },
      headers,
    );
  }

  private async handleRotateClientKey(
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    this.assertRestartIdle();
    const clientApiKey = await this.secrets.rotateClientApiKey();
    json(
      response,
      200,
      {
        rotated: true,
        client_api_key: clientApiKey,
      },
      headers,
    );
  }

  private async handleResetUsage(
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    this.assertRestartIdle();
    const stats = this.usageStats.reset();
    await this.usageStats.flush();
    json(response, 200, { reset: true, stats }, headers);
  }

  private async handleNetworkScope(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    this.assertRestartIdle();
    const body = (await readJsonBody(request, 8 * 1024)) as Record<
      string,
      unknown
    >;
    const scope = body.scope;
    if (scope !== "loopback" && scope !== "lan") {
      throw new OpenAIHttpError(
        400,
        "invalid_network_scope",
        "Network scope must be loopback or lan.",
        "invalid_request_error",
        "scope",
      );
    }
    const currentScope = networkScopeForHost(this.config.host);
    if (scope === currentScope) {
      json(
        response,
        200,
        {
          accepted: true,
          network_scope: scope,
          restart_required: false,
        },
        headers,
      );
      return;
    }

    await this.networkSettings.set(scope as NetworkScope);
    const restartScheduled = Boolean(this.onUpdateRequested);
    json(
      response,
      restartScheduled ? 202 : 200,
      {
        accepted: true,
        network_scope: scope,
        restart_required: true,
        restart_scheduled: restartScheduled,
      },
      headers,
    );
    if (restartScheduled) this.scheduleRestart();
  }

  private updateVersion(value: unknown) {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new OpenAIHttpError(
        400,
        "invalid_extension_version",
        "The extension version is invalid.",
        "invalid_request_error",
        "current_version",
      );
    }
    return value;
  }

  private async trackApiRequest<T>(action: () => Promise<T>) {
    this.activeApiRequests += 1;
    try {
      return await action();
    } finally {
      this.activeApiRequests -= 1;
    }
  }

  private assertRestartIdle() {
    if (this.activeApiRequests > 0 || this.semaphore.inUse > 0) {
      throw new OpenAIHttpError(
        409,
        "update_busy",
        "Wait for active API requests to finish before updating.",
      );
    }
  }

  private scheduleRestart() {
    this.restartShutdownScheduled = true;
    setTimeout(() => {
      try {
        this.onUpdateRequested?.();
      } catch {
        // The process-level shutdown handler owns restart failures.
      }
    }, 100).unref();
  }

  private async handleUpdateStatus(
    url: URL,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const currentVersion = this.updateVersion(
      url.searchParams.get("current_version"),
    );
    const status = await this.updateChecker.check(currentVersion);
    json(
      response,
      200,
      {
        current_version: status.currentVersion,
        checked_at: status.checkedAt,
        update_available: status.updateAvailable,
        ...(status.latestVersion
          ? { latest_version: status.latestVersion }
          : {}),
        ...(status.releaseUrl ? { release_url: status.releaseUrl } : {}),
        ...(status.error ? { error: status.error } : {}),
      },
      headers,
    );
  }

  private async handlePrepareUpdate(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    if (!this.onUpdateRequested) {
      throw new OpenAIHttpError(
        503,
        "update_restart_unavailable",
        "This companion was not launched by the installed updater.",
      );
    }
    if (this.restartShutdownScheduled) {
      throw new OpenAIHttpError(
        409,
        "update_already_started",
        "The update restart has already started.",
      );
    }
    this.assertRestartIdle();
    const body = (await readJsonBody(request, 16 * 1024)) as Record<
      string,
      unknown
    >;
    const currentVersion = this.updateVersion(body.current_version);
    const status = await this.updateChecker.check(currentVersion, {
      force: true,
    });
    if (status.error) {
      throw new OpenAIHttpError(503, "update_check_failed", status.error);
    }
    if (!status.updateAvailable || !status.latestVersion) {
      throw new OpenAIHttpError(
        409,
        "update_not_available",
        "No newer bridge release is available.",
      );
    }
    this.assertRestartIdle();

    json(
      response,
      202,
      {
        accepted: true,
        current_version: currentVersion,
        latest_version: status.latestVersion,
      },
      headers,
    );
    this.scheduleRestart();
  }

  private async handleOpenAIProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    headers: Record<string, string>,
  ) {
    const release = this.semaphore.acquire();
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const method = relayHttpMethod(request.method);
      const path = validateOpenAIProxyPath(url.pathname);
      const body = await readRawBody(request, this.config.bodyLimitBytes);
      const relayRequest: RelayOpenAIHttpRequest = {
        kind: "openai.http",
        method,
        path,
        ...(url.search ? { query: url.search } : {}),
        headers: requestHeadersForRelay(request.headers),
        ...(body.length > 0
          ? {
              body: {
                encoding: "base64",
                data: body.toString("base64"),
              } as const,
            }
          : {}),
      };
      await this.executeOpenAIProxy(
        relayRequest,
        response,
        headers,
        controller.signal,
      );
    } finally {
      release();
    }
  }

  private async executeOpenAIProxy(
    request: RelayOpenAIHttpRequest,
    response: ServerResponse,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) {
    let responseStarted = false;
    let responseHasNoBody = request.method === "HEAD";
    try {
      await this.hub.execute(
        request,
        {
          onEvent: (event) => {
            if (event.kind === "http.response") {
              if (
                responseStarted ||
                !Number.isInteger(event.status) ||
                event.status < 200 ||
                event.status > 599
              ) {
                throw new OpenAIHttpError(
                  502,
                  "invalid_upstream_response",
                  "The extension returned invalid HTTP response metadata.",
                  "api_connection_error",
                );
              }
              const upstreamHeaders = responseHeadersForClient(event.headers);
              responseHasNoBody ||=
                event.status === 204 || event.status === 304;
              response.writeHead(event.status, {
                ...upstreamHeaders,
                "cache-control": upstreamHeaders["cache-control"] ?? "no-store",
                "x-content-type-options": "nosniff",
                ...headers,
              });
              responseStarted = true;
              return;
            }
            if (event.kind === "http.chunk") {
              if (!responseStarted || event.encoding !== "base64") {
                throw new OpenAIHttpError(
                  502,
                  "invalid_upstream_response",
                  "The extension returned an HTTP body before its response metadata.",
                  "api_connection_error",
                );
              }
              const chunk = decodeRelayChunk(event.data);
              if (!responseHasNoBody && chunk.length > 0) {
                response.write(chunk);
              }
              return;
            }
            throw new OpenAIHttpError(
              502,
              "invalid_upstream_response",
              "The extension returned an event for the wrong relay type.",
              "api_connection_error",
            );
          },
        },
        signal,
        this.config.responseTimeoutMs,
      );
      if (!responseStarted) {
        throw new OpenAIHttpError(
          502,
          "invalid_upstream_response",
          "Val ended the HTTP relay without returning response metadata.",
          "api_connection_error",
        );
      }
      response.end();
    } catch (error) {
      if (responseStarted && !response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
      throw error;
    }
  }

  private async handleModels(
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const result = await this.hub.execute({ kind: "models" });
    const models = result.models ?? [];
    json(
      response,
      200,
      {
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: model.created ?? 0,
          owned_by: model.owned_by ?? "rmit-val",
          ...openAIModelCapabilities(model),
        })),
      },
      headers,
    );
  }

  private async handleChatCompletion(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const release = this.semaphore.acquire();
    const controller = new AbortController();
    const startedAt = Date.now();
    let body: ChatCompletionRequest | undefined;
    let accumulator: ChatAccumulator | undefined;
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let errorCode: string | undefined;
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const rawBody = await readRawBody(request, this.config.bodyLimitBytes);
      const rawPayload = parseJsonBuffer(rawBody);
      const rawRecord = plainRecord(rawPayload);
      if (rawRecord && chatNeedsHttpRelay(rawRecord)) {
        await this.executeOpenAIProxy(
          {
            kind: "openai.http",
            method: "POST",
            path: "/v1/chat/completions",
            headers: requestHeadersForRelay(request.headers),
            body: {
              encoding: "base64",
              data: rawBody.toString("base64"),
            },
          },
          response,
          headers,
          controller.signal,
        );
        outcome = "completed";
        return;
      }
      try {
        body = parseChatCompletion(rawPayload);
      } catch (error) {
        if (!rawRecord) throw error;
        await this.executeOpenAIProxy(
          {
            kind: "openai.http",
            method: "POST",
            path: "/v1/chat/completions",
            headers: requestHeadersForRelay(request.headers),
            body: {
              encoding: "base64",
              data: rawBody.toString("base64"),
            },
          },
          response,
          headers,
          controller.signal,
        );
        outcome = "completed";
        return;
      }
      const metadata = body.metadata as Record<string, unknown> | undefined;
      const requestedChatId =
        typeof metadata?.val_chat_id === "string"
          ? metadata.val_chat_id
          : undefined;
      const persistence =
        body.store || requestedChatId
          ? {
              mode: "stored" as const,
              ...(requestedChatId ? { chatId: requestedChatId } : {}),
              ...(requestedChatId ? { appendToExisting: true } : {}),
              title: titleFromMessages(body.messages as never),
            }
          : { mode: "temporary" as const };
      accumulator = new ChatAccumulator(body.model);
      const activeBody = body;
      const activeAccumulator = accumulator;
      let sseStarted = false;
      let acceptedChatId: string | undefined;

      const startSse = () => {
        if (sseStarted || !activeBody.stream) return;
        sseStarted = true;
        response.writeHead(200, {
          ...headers,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          "x-content-type-options": "nosniff",
          connection: "keep-alive",
          ...(acceptedChatId ? { "x-val-chat-id": acceptedChatId } : {}),
        });
      };

      const result = await this.hub.execute(
        chatRequestToRelay(body, persistence),
        {
          onAccepted: (accepted) => {
            acceptedChatId = accepted.chatId;
            startSse();
          },
          onEvent: (event) => {
            const chunks = activeAccumulator.consume(event);
            if (activeBody.stream && chunks.length > 0) {
              startSse();
              for (const chunk of chunks) writeChatSse(response, chunk);
            }
          },
        },
        controller.signal,
      );

      const chatId = result.chatId ?? acceptedChatId;
      const disclosure = reasoningDisclosure(
        accumulator.usage,
        accumulator.reasoning,
        reasoningSettingsFromParameters(
          body as unknown as Record<string, unknown>,
        ),
      );
      if (body.stream) {
        startSse();
        writeChatSse(response, {
          ...accumulator.finishChunk(
            body.stream_options?.include_usage ?? false,
          ),
          val_reasoning: disclosure,
        });
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        json(
          response,
          200,
          {
            ...accumulator.completion(),
            val_reasoning: disclosure,
          },
          {
            ...headers,
            ...reasoningHeaders(disclosure),
            ...(chatId ? { "x-val-chat-id": chatId } : {}),
          },
        );
      }
      outcome = "completed";
    } catch (rawError) {
      const normalized = asOpenAIHttpError(rawError);
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      errorCode = normalized.code;
      throw rawError;
    } finally {
      if (body && accumulator) {
        const disclosure = reasoningDisclosure(
          accumulator.usage,
          accumulator.reasoning,
          reasoningSettingsFromParameters(
            body as unknown as Record<string, unknown>,
          ),
        );
        this.diagnostics.recordGeneration({
          endpoint: "chat.completions",
          requestId: accumulator.id,
          model: body.model,
          stream: body.stream,
          outcome,
          durationMs: Date.now() - startedAt,
          usage: usageTokenCounts(accumulator.usage),
          reasoning: disclosure,
          toolCalls: accumulator.toolCalls.length,
          finishReason: accumulator.finishReason,
          ...(errorCode ? { errorCode } : {}),
        });
      }
      release();
    }
  }

  private async handleResponse(
    request: IncomingMessage,
    response: ServerResponse,
    headers: Record<string, string>,
  ) {
    const release = this.semaphore.acquire();
    const controller = new AbortController();
    const startedAt = Date.now();
    let bridgeResponseId: string | undefined;
    let completedPayload: Record<string, unknown> | undefined;
    let mappedNativeId: string | undefined;
    let body: ReturnType<typeof parseResponse> | undefined;
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let errorCode: string | undefined;
    let handledLegacy = false;
    let handledProxy = false;
    let terminalEvent:
      | "response.completed"
      | "response.failed"
      | "response.incomplete"
      | undefined;
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const rawBody = await readRawBody(request, this.config.bodyLimitBytes);
      const rawPayload = parseJsonBuffer(rawBody);
      const rawRecord = plainRecord(rawPayload);
      const rawPreviousResponseId =
        typeof rawRecord?.previous_response_id === "string"
          ? rawRecord.previous_response_id
          : undefined;
      const rawPrior = rawPreviousResponseId
        ? this.mappings.get(rawPreviousResponseId)
        : undefined;
      const hasSpecializedShape =
        typeof rawRecord?.model === "string" &&
        rawRecord.model.length > 0 &&
        (typeof rawRecord.input === "string" || Array.isArray(rawRecord.input));
      const needsLegacyMapping =
        rawPrior?.chatId !== undefined &&
        rawPrior.nativeResponseId === undefined;
      if (
        rawRecord &&
        !hasSpecializedShape &&
        !needsLegacyMapping &&
        this.hub.supportsNativeResponses()
      ) {
        handledProxy = true;
        await this.executeOpenAIProxy(
          {
            kind: "openai.http",
            method: "POST",
            path: "/v1/responses",
            headers: requestHeadersForRelay(request.headers),
            body: {
              encoding: "base64",
              data: rawBody.toString("base64"),
            },
          },
          response,
          headers,
          controller.signal,
        );
        outcome = "completed";
        return;
      }
      try {
        body = parseResponse(rawPayload);
      } catch (error) {
        if (!rawRecord || !this.hub.supportsNativeResponses()) throw error;
        handledProxy = true;
        await this.executeOpenAIProxy(
          {
            kind: "openai.http",
            method: "POST",
            path: "/v1/responses",
            headers: requestHeadersForRelay(request.headers),
            body: {
              encoding: "base64",
              data: rawBody.toString("base64"),
            },
          },
          response,
          headers,
          controller.signal,
        );
        outcome = "completed";
        return;
      }
      const prior = body.previous_response_id
        ? this.mappings.get(body.previous_response_id)
        : undefined;
      const nativePreviousResponseId =
        prior?.nativeResponseId ??
        (body.previous_response_id && this.hub.supportsNativeResponses()
          ? body.previous_response_id
          : undefined);
      if (body.previous_response_id && !prior && !nativePreviousResponseId) {
        throw new OpenAIHttpError(
          404,
          "invalid_previous_response_id",
          "The previous response ID is unknown or has expired.",
          "not_found_error",
          "previous_response_id",
        );
      }
      if (prior?.nativeResponseId && !this.hub.supportsNativeResponses()) {
        throw new OpenAIHttpError(
          503,
          "native_responses_unavailable",
          "Reload the updated extension before continuing this response.",
          "api_connection_error",
        );
      }
      if (body.background === true && !this.hub.supportsNativeResponses()) {
        throw new OpenAIHttpError(
          503,
          "native_responses_unavailable",
          "Background Responses require the native Val Responses relay.",
          "api_connection_error",
        );
      }
      if (
        body.background === true &&
        prior?.chatId &&
        !prior.nativeResponseId
      ) {
        throw new OpenAIHttpError(
          400,
          "unsupported_feature",
          "A background Response cannot continue a legacy Val chat mapping.",
          "invalid_request_error",
          "previous_response_id",
        );
      }
      if (prior?.chatId && !prior.nativeResponseId) {
        handledLegacy = true;
        await this.handleLegacyResponse(
          body,
          prior.chatId,
          response,
          headers,
          controller,
          startedAt,
        );
        return;
      }
      if (!prior && !this.hub.supportsNativeResponses()) {
        handledLegacy = true;
        await this.handleLegacyResponse(
          body,
          undefined,
          response,
          headers,
          controller,
          startedAt,
        );
        return;
      }

      bridgeResponseId = `resp_${randomUUID().replaceAll("-", "")}`;
      const relayBody = { ...body } as Record<string, unknown>;
      const valModelId = valModelIdForOpenAI(body.model);
      relayBody.model = valModelId;
      delete relayBody.previous_response_id;
      relayBody.store = body.store || Boolean(nativePreviousResponseId);
      if (nativePreviousResponseId) {
        relayBody.previous_response_id = nativePreviousResponseId;
      }

      if (body.background === true) {
        handledProxy = true;
        await this.executeOpenAIProxy(
          {
            kind: "openai.http",
            method: "POST",
            path: "/v1/responses",
            headers: requestHeadersForRelay(request.headers),
            body: {
              encoding: "base64",
              data: Buffer.from(JSON.stringify(relayBody)).toString("base64"),
            },
          },
          response,
          headers,
          controller.signal,
        );
        outcome = "completed";
        return;
      }

      const relayRequest = {
        kind: "responses" as const,
        model: valModelId,
        body: relayBody as import("@val-bridge/protocol").JsonObject,
        headers: requestHeadersForRelay(request.headers),
      };

      let sseStarted = false;
      let nextSequenceNumber = 0;
      const startSse = () => {
        if (sseStarted || !body!.stream) return;
        sseStarted = true;
        response.writeHead(200, {
          ...headers,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          "x-content-type-options": "nosniff",
          connection: "keep-alive",
        });
      };

      try {
        await this.hub.execute(
          relayRequest,
          {
            onAccepted: () => startSse(),
            onEvent: (event) => {
              if (event.kind !== "sse") return;
              const sequenceNumber = event.data.sequence_number;
              if (typeof sequenceNumber === "number") {
                nextSequenceNumber = Math.max(
                  nextSequenceNumber,
                  Math.floor(sequenceNumber) + 1,
                );
              }
              if (
                event.eventType === "response.completed" ||
                event.eventType === "response.failed" ||
                event.eventType === "response.incomplete"
              ) {
                terminalEvent = event.eventType;
                const eventPayload = event.data as Record<string, unknown>;
                completedPayload =
                  eventPayload.response &&
                  typeof eventPayload.response === "object" &&
                  !Array.isArray(eventPayload.response)
                    ? (eventPayload.response as Record<string, unknown>)
                    : eventPayload;
                mappedNativeId =
                  typeof completedPayload.id === "string"
                    ? completedPayload.id
                    : undefined;
                if (event.eventType !== "response.completed") {
                  const nativeError =
                    completedPayload.error &&
                    typeof completedPayload.error === "object" &&
                    !Array.isArray(completedPayload.error)
                      ? (completedPayload.error as Record<string, unknown>)
                      : undefined;
                  errorCode =
                    typeof nativeError?.code === "string"
                      ? nativeError.code
                      : event.eventType.replace("response.", "response_");
                }
              }
              if (body!.stream) {
                startSse();
                writeSseEvent(response, event.eventType, event.data);
              }
            },
          },
          controller.signal,
          this.config.responseTimeoutMs,
        );
        if (!terminalEvent || !completedPayload) {
          throw new OpenAIHttpError(
            502,
            "invalid_upstream_response",
            "Val ended the Responses relay without a terminal response.",
            "api_connection_error",
          );
        }
        if (
          terminalEvent === "response.completed" &&
          (body.store || nativePreviousResponseId) &&
          !mappedNativeId
        ) {
          throw new OpenAIHttpError(
            502,
            "invalid_upstream_response",
            "Val returned a stored response without an ID.",
            "api_connection_error",
          );
        }
        outcome =
          terminalEvent === "response.completed" ? "completed" : "failed";
      } catch (rawError) {
        const err = asOpenAIHttpError(rawError);
        outcome = controller.signal.aborted ? "cancelled" : "failed";
        errorCode = err.code;
        if (
          body.stream &&
          response.headersSent &&
          !response.writableEnded &&
          !response.destroyed
        ) {
          writeSseEvent(response, "error", {
            type: "error",
            sequence_number: nextSequenceNumber,
            code: err.code,
            message: err.message,
            param: err.param ?? null,
          });
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        throw err;
      }

      if (
        terminalEvent === "response.completed" &&
        mappedNativeId &&
        (body.store || nativePreviousResponseId)
      ) {
        await this.mappings.setNative(mappedNativeId, mappedNativeId);
      }

      if (body.stream) {
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        const disclosure = this.nativeReasoningDisclosure(
          body,
          completedPayload,
        );
        json(response, 200, completedPayload, {
          ...headers,
          ...reasoningHeaders(disclosure),
        });
      }
    } catch (rawError) {
      const error = asOpenAIHttpError(rawError);
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      errorCode = error.code;
      throw rawError;
    } finally {
      if (body && !handledLegacy && !handledProxy) {
        const output = Array.isArray(completedPayload?.output)
          ? completedPayload.output
          : [];
        const usage = completedPayload?.usage;
        this.diagnostics.recordGeneration({
          endpoint: "responses",
          requestId: bridgeResponseId ?? "unknown-response",
          model: body.model,
          stream: body.stream,
          outcome,
          durationMs: Date.now() - startedAt,
          usage: usageTokenCounts(usage),
          reasoning: this.nativeReasoningDisclosure(body, completedPayload),
          toolCalls: output.filter((rawItem) =>
            Boolean(
              rawItem &&
              typeof rawItem === "object" &&
              !Array.isArray(rawItem) &&
              (rawItem as Record<string, unknown>).type === "function_call",
            ),
          ).length,
          ...(errorCode ? { errorCode } : {}),
        });
      }
      release();
    }
  }

  private async handleLegacyResponse(
    body: ResponseRequest,
    legacyChatId: string | undefined,
    response: ServerResponse,
    headers: Record<string, string>,
    controller: AbortController,
    startedAt: number,
  ) {
    const accumulator = new ChatAccumulator(body.model);
    const adapter = new ResponsesAdapter(body, accumulator);
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let errorCode: string | undefined;
    let sseStarted = false;
    let initialEventsSent = false;
    let acceptedChatId: string | undefined;

    const startSse = () => {
      if (sseStarted || !body.stream) return;
      sseStarted = true;
      response.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        "x-content-type-options": "nosniff",
        connection: "keep-alive",
        ...(acceptedChatId || legacyChatId
          ? { "x-val-chat-id": acceptedChatId ?? legacyChatId }
          : {}),
      });
    };
    const writeInitialEvents = () => {
      if (!body.stream || initialEventsSent) return;
      initialEventsSent = true;
      startSse();
      for (const event of adapter.initialEvents()) {
        writeSseEvent(response, String(event.type), event);
      }
    };

    try {
      let result: RelayDoneResult;
      try {
        result = await this.hub.execute(
          responseRequestToRelay(
            body,
            legacyChatId
              ? {
                  mode: "stored",
                  chatId: legacyChatId,
                  appendToExisting: true,
                }
              : body.store
                ? {
                    mode: "stored",
                    title: titleFromMessages(
                      responseRequestToRelay(body, {
                        mode: "temporary",
                      }).messages,
                    ),
                  }
                : { mode: "temporary" },
          ),
          {
            onAccepted: (accepted) => {
              acceptedChatId = accepted.chatId;
              if (accepted.chatId) {
                body.metadata = {
                  ...(body.metadata ?? {}),
                  val_chat_id: accepted.chatId,
                };
              }
              writeInitialEvents();
            },
            onEvent: (event) => {
              const chunks = accumulator.consume(event);
              if (!body.stream) return;
              writeInitialEvents();
              for (const chunk of chunks) {
                for (const responseEvent of adapter.eventsFromChunk(chunk)) {
                  writeSseEvent(
                    response,
                    String(responseEvent.type),
                    responseEvent,
                  );
                }
              }
            },
          },
          controller.signal,
        );
      } catch (rawError) {
        const error = asOpenAIHttpError(rawError);
        outcome = controller.signal.aborted ? "cancelled" : "failed";
        errorCode = error.code;
        if (
          body.stream &&
          response.headersSent &&
          !response.writableEnded &&
          !response.destroyed
        ) {
          for (const event of adapter.errorEvents(error)) {
            writeSseEvent(response, String(event.type), event);
          }
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        throw error;
      }

      const chatId = result.chatId ?? acceptedChatId ?? legacyChatId;
      if (chatId) {
        body.metadata = {
          ...(body.metadata ?? {}),
          val_chat_id: chatId,
        };
      }
      if ((body.store || legacyChatId) && chatId) {
        await this.mappings.setChat(adapter.id, chatId);
      }

      if (body.stream) {
        writeInitialEvents();
        for (const event of adapter.finalEvents()) {
          writeSseEvent(response, String(event.type), event);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        const disclosure = reasoningDisclosure(
          accumulator.usage,
          accumulator.reasoning,
          reasoningSettingsFromResponse(body.reasoning),
        );
        json(response, 200, adapter.responseObject("completed"), {
          ...headers,
          ...reasoningHeaders(disclosure),
          ...(chatId ? { "x-val-chat-id": chatId } : {}),
        });
      }
      outcome = "completed";
    } catch (rawError) {
      const error = asOpenAIHttpError(rawError);
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      errorCode = error.code;
      throw rawError;
    } finally {
      const disclosure = reasoningDisclosure(
        accumulator.usage,
        accumulator.reasoning,
        reasoningSettingsFromResponse(body.reasoning),
      );
      this.diagnostics.recordGeneration({
        endpoint: "responses",
        requestId: accumulator.id,
        model: body.model,
        stream: body.stream,
        outcome,
        durationMs: Date.now() - startedAt,
        usage: usageTokenCounts(accumulator.usage),
        reasoning: disclosure,
        toolCalls: accumulator.toolCalls.length,
        finishReason: accumulator.finishReason,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  private nativeReasoningDisclosure(
    body: ResponseRequest,
    completedPayload: Record<string, unknown> | undefined,
  ) {
    const output = Array.isArray(completedPayload?.output)
      ? completedPayload.output
      : [];
    const summaryAvailable = output.some((rawItem) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        return false;
      }
      const item = rawItem as Record<string, unknown>;
      if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
        return false;
      }
      return item.summary.some((rawPart) => {
        if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
          return false;
        }
        const text = (rawPart as Record<string, unknown>).text;
        return typeof text === "string" && text.trim().length > 0;
      });
    });
    return reasoningDisclosure(
      completedPayload?.usage,
      summaryAvailable ? "available" : "",
      reasoningSettingsFromResponse(body.reasoning),
    );
  }
}
