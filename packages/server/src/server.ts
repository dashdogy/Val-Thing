import { timingSafeEqual } from "node:crypto";
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
import {
  asOpenAIHttpError,
  OpenAIHttpError,
  openAIErrorBody,
} from "./errors.js";
import { MappingStore } from "./mapping-store.js";
import {
  chatRequestToRelay,
  parseChatCompletion,
  parseResponse,
  responseRequestToRelay,
  titleFromMessages,
} from "./openai-schema.js";
import { configureOpenCode } from "./opencode-config.js";
import { ResponsesAdapter } from "./responses-adapter.js";
import { Semaphore } from "./semaphore.js";

type BridgeServerOptions = {
  config?: Partial<RuntimeConfig>;
  quiet?: boolean;
};

const MAX_PAIRING_FAILURES = 10;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
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

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > limitBytes) {
      throw new OpenAIHttpError(
        413,
        "request_too_large",
        `Request bodies are limited to ${limitBytes} bytes.`,
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new OpenAIHttpError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

function bearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

function writeChatSse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeResponseSse(
  response: ServerResponse,
  event: Record<string, unknown>,
) {
  response.write(`event: ${String(event.type)}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export class ValBridgeServer {
  readonly config: RuntimeConfig;
  readonly pairingCode: string;
  readonly pairingExpiresAt: number;
  readonly secrets: SecretsStore;
  readonly mappings: MappingStore;
  readonly hub: BridgeHub;

  private readonly semaphore: Semaphore;
  private readonly httpServer;
  private readonly websocketServer;
  private heartbeat?: NodeJS.Timeout;
  private reloadWatcher?: NodeJS.Timeout;
  private pairingCompleted = false;
  private pairingFailures = 0;

  private constructor(
    config: RuntimeConfig,
    secrets: SecretsStore,
    mappings: MappingStore,
    private readonly quiet: boolean,
  ) {
    this.config = config;
    this.secrets = secrets;
    this.mappings = mappings;
    this.pairingCode = createPairingCode();
    this.pairingExpiresAt = Date.now() + 5 * 60_000;
    this.hub = new BridgeHub(secrets, config.requestTimeoutMs);
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
    const config = loadRuntimeConfig(options.config);
    const secrets = await SecretsStore.open(config.configDirectory);
    const mappings = await MappingStore.open(config.configDirectory);
    return new ValBridgeServer(
      config,
      secrets,
      mappings,
      options.quiet ?? false,
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
      console.log(`Val OpenAI Bridge listening at ${this.baseUrl}/v1`);
      console.log(
        `Extension pairing code: ${this.pairingCode} (expires in five minutes)`,
      );
      console.log(`Configuration: ${this.secrets.path}`);
    }
    return this.address;
  }

  get address() {
    return this.httpServer.address() as AddressInfo | null;
  }

  get baseUrl() {
    const address = this.address;
    const port = address?.port ?? this.config.port;
    return `http://${this.config.host}:${port}`;
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
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
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
            extension_connected: extension.extensionConnected,
            val_session: extension.valSession,
            val_socket: extension.valSocket,
            compatible: extension.compatible,
            active_requests: this.semaphore.inUse,
          },
          corsHeaders,
        );
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

      if (url.pathname.startsWith("/v1/")) {
        this.authenticateClient(request);
      }

      if (method === "GET" && url.pathname === "/v1/models") {
        await this.handleModels(response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        await this.handleChatCompletion(request, response, corsHeaders);
        return;
      }
      if (method === "POST" && url.pathname === "/v1/responses") {
        await this.handleResponse(request, response, corsHeaders);
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        throw new OpenAIHttpError(
          400,
          "unsupported_feature",
          `The endpoint ${method} ${url.pathname} is outside this Val chat/agent bridge.`,
        );
      }
      throw new OpenAIHttpError(
        404,
        "not_found",
        "The requested route does not exist.",
      );
    } catch (rawError) {
      const error = asOpenAIHttpError(rawError);
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
    if (
      typeof body.code !== "string" ||
      typeof body.extensionId !== "string" ||
      body.protocolVersion !== PROTOCOL_VERSION ||
      body.extensionId !==
        this.extensionIdFromOrigin(request.headers.origin ?? "")
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
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const body = parseChatCompletion(
        await readJsonBody(request, this.config.bodyLimitBytes),
      );
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
      const accumulator = new ChatAccumulator(body.model);
      let sseStarted = false;
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
            const chunks = accumulator.consume(event);
            if (body.stream && chunks.length > 0) {
              startSse();
              for (const chunk of chunks) writeChatSse(response, chunk);
            }
          },
        },
        controller.signal,
      );

      const chatId = result.chatId ?? acceptedChatId;
      if (body.stream) {
        startSse();
        writeChatSse(
          response,
          accumulator.finishChunk(body.stream_options?.include_usage ?? false),
        );
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        json(response, 200, accumulator.completion(), {
          ...headers,
          ...(chatId ? { "x-val-chat-id": chatId } : {}),
        });
      }
    } finally {
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
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const body = parseResponse(
        await readJsonBody(request, this.config.bodyLimitBytes),
      );
      const prior = body.previous_response_id
        ? this.mappings.get(body.previous_response_id)
        : undefined;
      if (body.previous_response_id && !prior) {
        throw new OpenAIHttpError(
          404,
          "invalid_previous_response_id",
          "The previous response ID is unknown or has expired.",
          "not_found_error",
          "previous_response_id",
        );
      }

      const persistence = prior
        ? {
            mode: "stored" as const,
            chatId: prior.chatId,
            appendToExisting: true,
          }
        : body.store
          ? {
              mode: "stored" as const,
              title: titleFromMessages(
                responseRequestToRelay(body, { mode: "temporary" }).messages,
              ),
            }
          : { mode: "temporary" as const };

      const accumulator = new ChatAccumulator(body.model);
      const adapter = new ResponsesAdapter(body, accumulator);
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
          ...(acceptedChatId ? { "x-val-chat-id": acceptedChatId } : {}),
        });
      };

      const writeInitialEvents = () => {
        if (!body.stream || initialEventsSent) return;
        initialEventsSent = true;
        startSse();
        for (const event of adapter.initialEvents())
          writeResponseSse(response, event);
      };

      let result: RelayDoneResult;
      try {
        result = await this.hub.execute(
          responseRequestToRelay(body, persistence),
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
                  writeResponseSse(response, responseEvent);
                }
              }
            },
          },
          controller.signal,
        );
      } catch (rawError) {
        const error = asOpenAIHttpError(rawError);
        if (body.stream && response.headersSent && !response.writableEnded) {
          for (const event of adapter.errorEvents(error)) {
            writeResponseSse(response, event);
          }
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        throw error;
      }

      const chatId = result.chatId ?? acceptedChatId;
      if (chatId) {
        body.metadata = {
          ...(body.metadata ?? {}),
          val_chat_id: chatId,
        };
      }
      if ((body.store || prior) && chatId) {
        await this.mappings.set(adapter.id, chatId);
      }

      if (body.stream) {
        writeInitialEvents();
        for (const event of adapter.finalEvents())
          writeResponseSse(response, event);
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        json(response, 200, adapter.responseObject("completed"), {
          ...headers,
          ...(chatId ? { "x-val-chat-id": chatId } : {}),
        });
      }
    } finally {
      release();
    }
  }
}
