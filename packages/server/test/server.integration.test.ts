import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionToServerMessage,
  RelayCompletionRequest,
  ServerToExtensionMessage,
} from "@val-bridge/protocol";
import { PROTOCOL_VERSION } from "@val-bridge/protocol";
import OpenAI from "openai";
import WebSocket from "ws";
import { ValBridgeServer } from "../src/server.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

class FakeValExtension {
  socket?: WebSocket;
  bridgeSecret = "";
  readonly relayRequests: RelayCompletionRequest[] = [];
  readonly cancelledRequestIds: string[] = [];
  readonly heldRequestIds: string[] = [];
  private chatCounter = 0;

  constructor(
    readonly server: ValBridgeServer,
    readonly origin = EXTENSION_ORIGIN,
    readonly extensionId = EXTENSION_ID,
  ) {}

  async pair() {
    const response = await fetch(`${this.server.baseUrl}/bridge/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: this.origin,
      },
      body: JSON.stringify({
        code: this.server.pairingCode,
        extensionId: this.extensionId,
        protocolVersion: PROTOCOL_VERSION,
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      bridgeSecret: string;
      protocolVersion: number;
    };
    this.bridgeSecret = body.bridgeSecret;
    assert.equal(body.protocolVersion, PROTOCOL_VERSION);
  }

  async connect() {
    assert.ok(this.bridgeSecret, "pair() must run before connect()");
    const socket = new WebSocket(
      `${this.server.baseUrl.replace("http://", "ws://")}/bridge/ws`,
      { origin: this.origin },
    );
    this.socket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerToExtensionMessage;
      this.handleMessage(message);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    this.send({
      type: "bridge.auth",
      protocolVersion: PROTOCOL_VERSION,
      extensionId: this.extensionId,
      secret: this.bridgeSecret,
    });
    await waitFor(async () => {
      const health = await fetch(`${this.server.baseUrl}/healthz`);
      const body = (await health.json()) as { status?: string };
      return body.status === "ok";
    }, "authenticated extension status");
  }

  close() {
    this.socket?.close(1000, "test disconnect");
  }

  finishHeld(requestId: string, content = "released") {
    this.send({
      type: "relay.event",
      id: requestId,
      event: { kind: "delta", content },
    });
    this.send({
      type: "relay.done",
      id: requestId,
      result: { content },
    });
    const index = this.heldRequestIds.indexOf(requestId);
    if (index >= 0) this.heldRequestIds.splice(index, 1);
  }

  private handleMessage(message: ServerToExtensionMessage) {
    if (message.type === "bridge.authenticated") {
      this.send({
        type: "bridge.status",
        status: {
          extensionConnected: true,
          valSession: true,
          valSocket: true,
          compatible: true,
        },
      });
      return;
    }
    if (message.type === "bridge.ping") {
      this.send({ type: "bridge.pong", timestamp: message.timestamp });
      return;
    }
    if (message.type === "relay.cancel") {
      this.cancelledRequestIds.push(message.id);
      return;
    }
    if (message.type !== "relay.request") return;

    if (message.request.kind === "models") {
      this.send({
        type: "relay.done",
        id: message.id,
        result: {
          models: [
            {
              id: "val-test",
              name: "Val Test",
              created: 1_700_000_000,
              owned_by: "rmit-val",
            },
          ],
        },
      });
      return;
    }

    const relay = message.request;
    this.relayRequests.push(relay);
    const requestText = JSON.stringify(relay.messages);
    const stored = relay.persistence.mode === "stored";
    const chatId =
      stored && relay.persistence.chatId
        ? relay.persistence.chatId
        : stored
          ? `val-chat-${++this.chatCounter}`
          : undefined;
    this.send({
      type: "relay.accepted",
      id: message.id,
      accepted: {
        taskId: `task-${message.id}`,
        ...(chatId ? { chatId } : {}),
        messageId: `message-${message.id}`,
      },
    });

    if (requestText.includes("HOLD_CONCURRENCY")) {
      this.heldRequestIds.push(message.id);
      return;
    }
    if (requestText.includes("HOLD_CANCEL")) {
      this.heldRequestIds.push(message.id);
      this.send({
        type: "relay.event",
        id: message.id,
        event: { kind: "delta", content: "started" },
      });
      return;
    }
    if (requestText.includes("STREAM_ERROR")) {
      this.send({
        type: "relay.error",
        id: message.id,
        error: {
          code: "val_upstream_error",
          message: "Val rejected the streamed request.",
          status: 400,
        },
      });
      return;
    }
    if (requestText.includes("REASONING_SUMMARY")) {
      this.emitReasoningSummary(message.id, chatId);
      return;
    }
    if (requestText.includes("CALL_TOOL")) {
      this.emitToolCall(message.id, chatId);
      return;
    }

    const content = requestText.includes("CONTINUE")
      ? "continued-ok"
      : "bridge-ok";
    this.send({
      type: "relay.event",
      id: message.id,
      event: { kind: "delta", content: content.slice(0, 6) },
    });
    this.send({
      type: "relay.event",
      id: message.id,
      event: { kind: "replace", content },
    });
    this.send({
      type: "relay.event",
      id: message.id,
      event: {
        kind: "usage",
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
        },
      },
    });
    this.send({
      type: "relay.done",
      id: message.id,
      result: {
        ...(chatId ? { chatId } : {}),
        content,
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          total_tokens: 10,
        },
      },
    });
  }

  private emitReasoningSummary(requestId: string, chatId?: string) {
    for (const reasoningContent of ["Inspect the ", "constraints first."]) {
      this.send({
        type: "relay.event",
        id: requestId,
        event: {
          kind: "openai",
          data: {
            choices: [
              {
                index: 0,
                delta: { reasoning_content: reasoningContent },
                finish_reason: null,
              },
            ],
          },
        },
      });
    }
    this.send({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "openai",
        data: {
          choices: [
            {
              index: 0,
              delta: { content: "reasoned-answer" },
              finish_reason: null,
            },
          ],
        },
      },
    });
    this.send({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "usage",
        usage: {
          prompt_tokens: 8,
          completion_tokens: 9,
          total_tokens: 17,
          completion_tokens_details: { reasoning_tokens: 6 },
        },
      },
    });
    this.send({
      type: "relay.done",
      id: requestId,
      result: {
        ...(chatId ? { chatId } : {}),
        content: "reasoned-answer",
        usage: {
          prompt_tokens: 8,
          completion_tokens: 9,
          total_tokens: 17,
          completion_tokens_details: { reasoning_tokens: 6 },
        },
      },
    });
  }

  private emitToolCall(requestId: string, chatId?: string) {
    this.send({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "openai",
        data: {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_weather",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      },
    });
    this.send({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "openai",
        data: {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"Melbourne"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 4,
            total_tokens: 13,
          },
        },
      },
    });
    this.send({
      type: "relay.done",
      id: requestId,
      result: {
        ...(chatId ? { chatId } : {}),
        toolCalls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Melbourne"}',
            },
          },
        ],
      },
    });
  }

  private send(message: ExtensionToServerMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

function apiFetch(
  server: ValBridgeServer,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${server.secrets.get().clientApiKey}`,
      ...(init.headers ?? {}),
    },
  });
}

function pairingFetch(
  server: ValBridgeServer,
  code: string,
  extensionId = EXTENSION_ID,
  origin = EXTENSION_ORIGIN,
) {
  return fetch(`${server.baseUrl}/bridge/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({
      code,
      extensionId,
      protocolVersion: PROTOCOL_VERSION,
    }),
  });
}

test("companion contract works through the official OpenAI JavaScript SDK", async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), "val-bridge-test-"));
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      requestTimeoutMs: 2_000,
    },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(server);
  await extension.pair();
  await extension.connect();

  t.after(async () => {
    extension.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const apiKey = server.secrets.get().clientApiKey;
  const client = new OpenAI({
    apiKey,
    baseURL: `${server.baseUrl}/v1`,
  });

  const unauthenticated = await fetch(`${server.baseUrl}/v1/models`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    ((await unauthenticated.json()) as { error: { code: string } }).error.code,
    "invalid_api_key",
  );

  const healthResponse = await fetch(`${server.baseUrl}/healthz`);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  assert.equal(health.status, "ok");
  assert.equal(health.extension_connected, true);
  assert.equal(health.val_session, true);
  assert.ok(!("client_api_key" in health));
  assert.ok(!("extension_id" in health));

  const models = await client.models.list();
  assert.deepEqual(
    models.data.map((model) => model.id),
    ["val-test"],
  );

  const completion = await client.chat.completions.create({
    model: "val-test",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "STRUCTURED_VISION" },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,AAAA",
              detail: "low",
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  });
  assert.equal(completion.choices[0]?.message.content, "bridge-ok");
  assert.equal(completion.usage?.total_tokens, 10);

  const stream = await client.chat.completions.create({
    model: "val-test",
    messages: [{ role: "user", content: "STREAM" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  let streamedText = "";
  let streamSawUsage = false;
  for await (const chunk of stream) {
    streamedText += chunk.choices[0]?.delta.content ?? "";
    if (chunk.usage?.total_tokens === 10) streamSawUsage = true;
  }
  assert.equal(streamedText, "bridge-ok");
  assert.equal(streamSawUsage, true);

  const toolCompletion = await client.chat.completions.create({
    model: "val-test",
    messages: [{ role: "user", content: "CALL_TOOL" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  });
  const toolCall = toolCompletion.choices[0]?.message.tool_calls?.[0];
  assert.equal(toolCall?.function.name, "get_weather");
  assert.equal(toolCall?.function.arguments, '{"city":"Melbourne"}');

  const toolResult = await client.chat.completions.create({
    model: "val-test",
    messages: [
      { role: "user", content: "CALL_TOOL" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Melbourne"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_weather",
        content: '{"temperature":20}',
      },
      { role: "user", content: "Summarise the tool result." },
    ],
  });
  assert.equal(
    toolResult.choices[0]?.message.tool_calls?.[0]?.id,
    "call_weather",
  );

  const storedResponse = await client.responses.create({
    model: "val-test",
    input: "STORE_THIS",
    store: true,
  });
  assert.equal(storedResponse.status, "completed");
  assert.equal(storedResponse.output[0]?.type, "message");
  assert.equal(storedResponse.metadata?.val_chat_id, "val-chat-1");

  const continuedResponse = await client.responses.create({
    model: "val-test",
    input: "CONTINUE",
    previous_response_id: storedResponse.id,
  });
  assert.equal(continuedResponse.status, "completed");
  const continuationRelay = extension.relayRequests.at(-1);
  assert.deepEqual(continuationRelay?.persistence, {
    mode: "stored",
    chatId: "val-chat-1",
    appendToExisting: true,
  });

  const responseStream = await client.responses.create({
    model: "val-test",
    input: "RESPONSES_STREAM",
    stream: true,
  });
  const responseEventTypes: string[] = [];
  let responseDelta = "";
  for await (const event of responseStream) {
    responseEventTypes.push(event.type);
    if (event.type === "response.output_text.delta") {
      responseDelta += event.delta;
    }
  }
  assert.equal(responseDelta, "bridge-ok");
  assert.equal(responseEventTypes[0], "response.created");
  assert.equal(responseEventTypes.at(-1), "response.completed");

  const reasonedResponse = await client.responses.create({
    model: "val-test",
    input: "REASONING_SUMMARY",
    reasoning: { effort: "high", summary: "detailed" },
  });
  const reasonedOutput = reasonedResponse.output as Array<{
    type: string;
    summary?: Array<{ type: string; text: string }>;
  }>;
  assert.equal(reasonedOutput[0]?.type, "reasoning");
  assert.deepEqual(reasonedOutput[0]?.summary, [
    { type: "summary_text", text: "Inspect the constraints first." },
  ]);
  assert.equal(reasonedOutput[1]?.type, "message");
  assert.equal(reasonedResponse.output_text, "reasoned-answer");
  assert.equal(
    reasonedResponse.usage?.output_tokens_details?.reasoning_tokens,
    6,
  );

  const reasoningStream = await client.responses.create({
    model: "val-test",
    input: "REASONING_SUMMARY",
    reasoning: { effort: "high", summary: "detailed" },
    stream: true,
  });
  const reasoningEventTypes: string[] = [];
  let reasoningDelta = "";
  let reasoningAnswer = "";
  for await (const event of reasoningStream) {
    reasoningEventTypes.push(event.type);
    if (event.type === "response.reasoning_summary_text.delta") {
      reasoningDelta += event.delta;
    }
    if (event.type === "response.output_text.delta") {
      reasoningAnswer += event.delta;
    }
  }
  assert.equal(reasoningDelta, "Inspect the constraints first.");
  assert.equal(reasoningAnswer, "reasoned-answer");
  assert.ok(
    reasoningEventTypes.includes("response.reasoning_summary_part.added"),
  );
  assert.ok(
    reasoningEventTypes.includes("response.reasoning_summary_text.done"),
  );
  assert.ok(
    reasoningEventTypes.includes("response.reasoning_summary_part.done"),
  );

  const streamedErrorResponse = await apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "STREAM_ERROR",
      stream: true,
    }),
  });
  assert.equal(streamedErrorResponse.status, 200);
  const streamedErrorText = await streamedErrorResponse.text();
  const streamedError = streamedErrorText
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    )
    .find((event) => event.type === "error");
  assert.equal(streamedError?.code, "val_upstream_error");
  assert.equal(typeof streamedError?.sequence_number, "number");
  assert.equal(streamedError?.message, "Val rejected the streamed request.");

  const unsupported = await apiFetch(server, "/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "val-test", input: "hello" }),
  });
  assert.equal(unsupported.status, 400);
  assert.equal(
    ((await unsupported.json()) as { error: { code: string } }).error.code,
    "unsupported_feature",
  );

  const deniedOrigin = await apiFetch(server, "/v1/models", {
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);

  const mappings = JSON.parse(
    await readFile(join(configDirectory, "response-mappings.json"), "utf8"),
  ) as { mappings: Array<{ responseId: string; chatId: string }> };
  assert.ok(
    mappings.mappings.some(
      (mapping) =>
        mapping.responseId === storedResponse.id &&
        mapping.chatId === "val-chat-1",
    ),
  );
  assert.ok(!JSON.stringify(mappings).includes("STORE_THIS"));
  assert.ok(!JSON.stringify(mappings).includes("CONTINUE"));
});

test("limits concurrency, cancels interrupted streams, and reports disconnection", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-flow-test-"),
  );
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      maxConcurrency: 4,
      requestTimeoutMs: 2_000,
    },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(server);
  await extension.pair();
  await extension.connect();

  t.after(async () => {
    extension.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const pendingResponses = Array.from({ length: 4 }, (_, index) =>
    apiFetch(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "val-test",
        messages: [{ role: "user", content: `HOLD_CONCURRENCY_${index}` }],
      }),
    }),
  );
  await waitFor(
    () => extension.heldRequestIds.length === 4,
    "four concurrent requests",
  );

  const limited = await apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "fifth" }],
    }),
  });
  assert.equal(limited.status, 429);
  assert.equal(
    ((await limited.json()) as { error: { code: string } }).error.code,
    "concurrency_limit_exceeded",
  );

  for (const requestId of [...extension.heldRequestIds]) {
    extension.finishHeld(requestId);
  }
  const released = await Promise.all(pendingResponses);
  assert.ok(released.every((response) => response.status === 200));

  const cancelledStream = await apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "HOLD_CANCEL" }],
      stream: true,
    }),
  });
  assert.equal(cancelledStream.status, 200);
  const reader = cancelledStream.body?.getReader();
  assert.ok(reader);
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  await reader.cancel();
  await waitFor(
    () => extension.cancelledRequestIds.length === 1,
    "relay cancellation after client disconnect",
  );

  extension.close();
  await waitFor(async () => {
    const health = (await (
      await fetch(`${server.baseUrl}/healthz`)
    ).json()) as { extension_connected?: boolean };
    return health.extension_connected === false;
  }, "extension disconnection");
  const unavailable = await apiFetch(server, "/v1/models");
  assert.equal(unavailable.status, 503);
  assert.equal(
    ((await unavailable.json()) as { error: { code: string } }).error.code,
    "extension_unavailable",
  );

  await extension.connect();
  const reconnected = await apiFetch(server, "/v1/models");
  assert.equal(reconnected.status, 200);
});

test("pairing rejects a claimed extension ID that does not match Origin", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-pair-test-"),
  );
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const response = await fetch(`${server.baseUrl}/bridge/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: EXTENSION_ORIGIN,
    },
    body: JSON.stringify({
      code: server.pairingCode,
      extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      protocolVersion: PROTOCOL_VERSION,
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "invalid_pairing_request",
  );
});

test("pairing codes are single-use", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-pair-once-"),
  );
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const first = await pairingFetch(server, server.pairingCode);
  assert.equal(first.status, 200);
  await first.json();

  const replay = await pairingFetch(server, server.pairingCode);
  assert.equal(replay.status, 409);
  assert.equal(
    ((await replay.json()) as { error: { code: string } }).error.code,
    "pairing_already_completed",
  );
});

test("pairing locks after repeated invalid codes", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-pair-limit-"),
  );
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const invalidCode = ((Number(server.pairingCode) + 1) % 1_000_000)
    .toString()
    .padStart(6, "0");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const invalid = await pairingFetch(server, invalidCode);
    assert.equal(invalid.status, 401);
    await invalid.json();
  }

  const locked = await pairingFetch(server, server.pairingCode);
  assert.equal(locked.status, 429);
  assert.equal(
    ((await locked.json()) as { error: { code: string } }).error.code,
    "pairing_attempts_exceeded",
  );
});
