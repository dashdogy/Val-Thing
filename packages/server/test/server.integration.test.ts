import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionToServerMessage,
  RelayCompletionRequest,
  RelayResponsesRequest,
  ServerToExtensionMessage,
} from "@val-bridge/protocol";
import { PROTOCOL_VERSION } from "@val-bridge/protocol";
import OpenAI from "openai";
import WebSocket from "ws";
import { ValBridgeServer } from "../src/server.js";
import { UpdateChecker } from "../src/update-checker.js";

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
  clientApiKey = "";
  readonly relayRequests: RelayCompletionRequest[] = [];
  readonly responsesRequests: RelayResponsesRequest[] = [];
  readonly cancelledRequestIds: string[] = [];
  readonly heldRequestIds: string[] = [];
  reloadRequests = 0;
  private chatCounter = 0;

  constructor(
    readonly server: ValBridgeServer,
    readonly origin = EXTENSION_ORIGIN,
    readonly extensionId = EXTENSION_ID,
    readonly modelId = "val-test",
    readonly nativeResponses = true,
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
    assert.ok(!("clientApiKey" in body));
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
      this.clientApiKey = message.clientApiKey;
      this.send({
        type: "bridge.status",
        status: {
          extensionConnected: true,
          valSession: true,
          valSocket: true,
          compatible: true,
          nativeResponses: this.nativeResponses,
        },
      });
      return;
    }
    if (message.type === "bridge.ping") {
      this.send({ type: "bridge.pong", timestamp: message.timestamp });
      return;
    }
    if (message.type === "bridge.reload") {
      this.reloadRequests += 1;
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
              id: this.modelId,
              name: "Val Test",
              created: 1_700_000_000,
              owned_by: "rmit-val",
            },
          ],
        },
      });
      return;
    }
    if (message.request.kind === "responses") {
      const relay = message.request;
      this.responsesRequests.push(relay);
      const requestText = JSON.stringify(relay.body);
      if (requestText.includes("STREAM_ERROR")) {
        this.send({
          type: "relay.accepted",
          id: message.id,
          accepted: {},
        });
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
      if (requestText.includes("NATIVE_INCOMPLETE")) {
        this.send({
          type: "relay.accepted",
          id: message.id,
          accepted: {},
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.created",
            data: {
              type: "response.created",
              response: {
                id: "resp_incomplete",
                model: relay.model,
                object: "response",
                output: [],
              },
            },
          },
        });
        this.send({ type: "relay.done", id: message.id, result: {} });
        return;
      }
      if (requestText.includes("HOLD_NATIVE")) {
        this.send({
          type: "relay.accepted",
          id: message.id,
          accepted: {},
        });
        this.heldRequestIds.push(message.id);
        return;
      }
      if (requestText.includes("INVALID_NATIVE_EVENT")) {
        this.send({
          type: "relay.accepted",
          id: message.id,
          accepted: {},
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.completed\ninjected",
            data: {
              type: "response.completed",
              id: "resp_invalid_event",
              status: "completed",
              model: relay.model,
              output: [],
            },
          },
        });
        return;
      }
      const nativeId = `resp_native_${++this.chatCounter}`;
      if (requestText.includes("REASONING_SUMMARY")) {
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.created",
            data: {
              type: "response.created",
              response: {
                id: nativeId,
                model: relay.model,
                object: "response",
                output: [],
              },
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.in_progress",
            data: {
              type: "response.in_progress",
              response: {
                id: nativeId,
                model: relay.model,
                object: "response",
                output: [],
              },
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "rs_testreasoning",
                type: "reasoning",
                status: "in_progress",
                summary: [],
              },
              sequence_number: 2,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.reasoning_summary_part.added",
            data: {
              type: "response.reasoning_summary_part.added",
              item_id: "rs_testreasoning",
              output_index: 0,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
              sequence_number: 3,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.reasoning_summary_text.delta",
            data: {
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_testreasoning",
              output_index: 0,
              summary_index: 0,
              delta: "Inspect the constraints first.",
              sequence_number: 3,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.reasoning_summary_text.done",
            data: {
              type: "response.reasoning_summary_text.done",
              item_id: "rs_testreasoning",
              output_index: 0,
              summary_index: 0,
              sequence_number: 4,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.reasoning_summary_part.done",
            data: {
              type: "response.reasoning_summary_part.done",
              output_index: 0,
              item: {
                id: "rs_testreasoning",
                type: "reasoning",
                status: "completed",
                summary: [
                  {
                    text: "Inspect the constraints first.",
                    type: "summary_text",
                  },
                ],
              },
              sequence_number: 5,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.output_item.added",
            data: {
              type: "response.output_item.added",
              output_index: 1,
              item: {
                id: "msg_test1",
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
              },
              sequence_number: 6,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              item_id: "msg_test1",
              output_index: 1,
              content_index: 0,
              delta: "reasoned-answer",
              sequence_number: 7,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.completed",
            data: {
              type: "response.completed",
              id: nativeId,
              object: "response",
              status: "completed",
              model: relay.model,
              output: [
                {
                  id: "rs_testreasoning",
                  type: "reasoning",
                  status: "completed",
                  summary: [
                    {
                      text: "Inspect the constraints first.",
                      type: "summary_text",
                    },
                  ],
                },
                {
                  id: "msg_test1",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "reasoned-answer" }],
                },
              ],
              usage: {
                input_tokens: 20,
                output_tokens: 30,
                total_tokens: 50,
                output_tokens_details: { reasoning_tokens: 6 },
              },
            },
          },
        });
        this.send({ type: "relay.done", id: message.id, result: {} });
        return;
      }
      this.send({
        type: "relay.event",
        id: message.id,
        event: {
          kind: "sse",
          eventType: "response.created",
          data: {
            type: "response.created",
            response: {
              id: nativeId,
              model: relay.model,
              object: "response",
              output: [],
            },
          },
        },
      });
      this.send({
        type: "relay.event",
        id: message.id,
        event: {
          kind: "sse",
          eventType: "response.in_progress",
          data: {
            type: "response.in_progress",
            response: {
              id: nativeId,
              model: relay.model,
              object: "response",
              output: [],
            },
          },
        },
      });
      this.send({
        type: "relay.event",
        id: message.id,
        event: {
          kind: "sse",
          eventType: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "msg_testoutput",
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
            sequence_number: 2,
          },
        },
      });
      const isStream =
        requestText.includes("RESPONSES_STREAM") ||
        (!requestText.includes("STORE_THIS") &&
          !requestText.includes("CONTINUE"));
      const responseContent = requestText.includes("CONTINUE")
        ? "continued-ok"
        : "bridge-ok";
      if (isStream) {
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              item_id: "msg_testoutput",
              output_index: 0,
              content_index: 0,
              delta: responseContent.slice(0, 6),
              sequence_number: 3,
            },
          },
        });
        this.send({
          type: "relay.event",
          id: message.id,
          event: {
            kind: "sse",
            eventType: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              item_id: "msg_testoutput",
              output_index: 0,
              content_index: 0,
              delta: responseContent.slice(6),
              sequence_number: 4,
            },
          },
        });
      }
      this.send({
        type: "relay.event",
        id: message.id,
        event: {
          kind: "sse",
          eventType: "response.completed",
          data: {
            type: "response.completed",
            id: nativeId,
            object: "response",
            status: "completed",
            model: relay.model,
            output: [
              {
                id: "msg_testoutput",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: responseContent }],
              },
            ],
            usage: {
              input_tokens: 15,
              output_tokens: 20,
              total_tokens: 35,
            },
          },
        },
      });
      this.send({ type: "relay.done", id: message.id, result: {} });
      return;
    }
    const relay = message.request as RelayCompletionRequest;
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
    if (requestText.includes("HIDDEN_REASONING")) {
      this.emitHiddenReasoning(message.id, chatId);
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

  private emitHiddenReasoning(requestId: string, chatId?: string) {
    this.send({
      type: "relay.event",
      id: requestId,
      event: { kind: "delta", content: "private-answer" },
    });
    this.send({
      type: "relay.event",
      id: requestId,
      event: {
        kind: "usage",
        usage: {
          prompt_tokens: 5,
          completion_tokens: 8,
          total_tokens: 13,
          completion_tokens_details: { reasoning_tokens: 6 },
        },
      },
    });
    this.send({
      type: "relay.done",
      id: requestId,
      result: {
        ...(chatId ? { chatId } : {}),
        content: "private-answer",
        usage: {
          prompt_tokens: 5,
          completion_tokens: 8,
          total_tokens: 13,
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

function updateRelease(version: string) {
  return {
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    html_url: `https://github.com/dashdogy/Val-Thing/releases/tag/v${version}`,
    assets: [
      { name: "latest.json" },
      { name: `val-openai-local-bridge-${version}.zip` },
      { name: `val-openai-local-bridge-extension-${version}.zip` },
    ],
  };
}

function extensionControlFetch(
  server: ValBridgeServer,
  extension: FakeValExtension,
  path: string,
  init: RequestInit = {},
) {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${extension.bridgeSecret}`,
      origin: extension.origin,
      ...(init.headers ?? {}),
    },
  });
}

test("binds all IPv4 interfaces while keeping a loopback client URL", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-network-test-"),
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

  assert.equal(server.config.host, "0.0.0.0");
  assert.equal(server.address?.address, "0.0.0.0");
  assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 200);
});

test("an installed update asks the connected extension to reload once", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-reload-test-"),
  );
  const marker = join(configDirectory, "reload-extension");
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await writeFile(marker, "reload", "utf8");
  await server.listen();
  const extension = new FakeValExtension(server);
  await extension.pair();
  await extension.connect();

  t.after(async () => {
    extension.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  await waitFor(
    () => extension.reloadRequests === 1,
    "extension update reload",
  );
  await waitFor(async () => {
    try {
      await readFile(marker, "utf8");
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }, "extension update marker removal");
});

test("authenticated extension control configures OpenCode without returning secrets", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-opencode-test-"),
  );
  const openCodePath = join(configDirectory, "opencode.jsonc");
  const previousConfigPath = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG = openCodePath;
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(
    server,
    EXTENSION_ORIGIN,
    EXTENSION_ID,
    "openai-gpt-5.6-sol",
  );
  await extension.pair();
  await extension.connect();

  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCODE_CONFIG;
    } else {
      process.env.OPENCODE_CONFIG = previousConfigPath;
    }
    extension.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const unauthenticated = await fetch(
    `${server.baseUrl}/bridge/configure-opencode`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        origin: EXTENSION_ORIGIN,
      },
    },
  );
  assert.equal(unauthenticated.status, 401);

  const configured = await fetch(
    `${server.baseUrl}/bridge/configure-opencode`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${extension.bridgeSecret}`,
        origin: EXTENSION_ORIGIN,
      },
    },
  );
  assert.equal(configured.status, 200);
  const result = (await configured.json()) as Record<string, unknown>;
  assert.deepEqual(result, {
    configured: true,
    provider_id: "val",
    models_configured: 1,
    updated: true,
    backup_created: false,
  });
  assert.ok(!("client_api_key" in result));
  assert.ok(!("config_path" in result));

  const openCodeConfig = JSON.parse(await readFile(openCodePath, "utf8")) as {
    provider: {
      val: {
        options: { baseURL: string; apiKey: string };
        models: Record<string, unknown>;
      };
    };
  };
  assert.equal(
    openCodeConfig.provider.val.options.baseURL,
    `${server.baseUrl}/v1`,
  );
  assert.equal(
    openCodeConfig.provider.val.options.apiKey,
    server.secrets.get().clientApiKey,
  );
  assert.deepEqual(Object.keys(openCodeConfig.provider.val.models), [
    "openai-gpt-5.6-sol",
  ]);
});

test("periodic update control discovers releases and waits for active requests", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-update-test-"),
  );
  let shutdownRequests = 0;
  let updateFetches = 0;
  let delayedCheckStarted = false;
  let releaseDelayedCheck: (() => void) | undefined;
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      requestTimeoutMs: 2_000,
    },
    quiet: true,
    updateChecker: new UpdateChecker({
      fetcher: async () => {
        updateFetches += 1;
        if (updateFetches === 2) {
          delayedCheckStarted = true;
          await new Promise<void>((resolve) => {
            releaseDelayedCheck = resolve;
          });
        }
        return Response.json(updateRelease("9.9.9"));
      },
    }),
    onUpdateRequested: () => {
      shutdownRequests += 1;
    },
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

  const unauthenticated = await fetch(
    `${server.baseUrl}/bridge/update/status?current_version=0.1.9`,
  );
  assert.equal(unauthenticated.status, 401);

  const statusResponse = await extensionControlFetch(
    server,
    extension,
    "/bridge/update/status?current_version=0.1.9",
  );
  assert.equal(statusResponse.status, 200);
  const status = (await statusResponse.json()) as Record<string, unknown>;
  assert.equal(status.current_version, "0.1.9");
  assert.equal(status.latest_version, "9.9.9");
  assert.equal(status.update_available, true);
  assert.equal(
    status.release_url,
    "https://github.com/dashdogy/Val-Thing/releases/tag/v9.9.9",
  );

  const pendingCompletion = apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "HOLD_CONCURRENCY_UPDATE" }],
    }),
  });
  await waitFor(
    () => extension.heldRequestIds.length === 1,
    "active request before update",
  );

  const busy = await extensionControlFetch(
    server,
    extension,
    "/bridge/update/prepare",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_version: "0.1.9" }),
    },
  );
  assert.equal(busy.status, 409);
  assert.equal(
    ((await busy.json()) as { error: { code: string } }).error.code,
    "update_busy",
  );
  assert.equal(shutdownRequests, 0);

  extension.finishHeld(extension.heldRequestIds[0] ?? "");
  assert.equal((await pendingCompletion).status, 200);

  const racedPrepare = extensionControlFetch(
    server,
    extension,
    "/bridge/update/prepare",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_version: "0.1.9" }),
    },
  );
  await waitFor(() => delayedCheckStarted, "delayed update check");
  const requestDuringCheck = apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "HOLD_CONCURRENCY_UPDATE_RACE" }],
    }),
  });
  await waitFor(
    () => extension.heldRequestIds.length === 1,
    "request started during update check",
  );
  assert.ok(releaseDelayedCheck);
  releaseDelayedCheck();
  const racedBusy = await racedPrepare;
  assert.equal(racedBusy.status, 409);
  assert.equal(
    ((await racedBusy.json()) as { error: { code: string } }).error.code,
    "update_busy",
  );
  extension.finishHeld(extension.heldRequestIds[0] ?? "");
  assert.equal((await requestDuringCheck).status, 200);

  const prepared = await extensionControlFetch(
    server,
    extension,
    "/bridge/update/prepare",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_version: "0.1.9" }),
    },
  );
  assert.equal(prepared.status, 202);
  assert.deepEqual(await prepared.json(), {
    accepted: true,
    current_version: "0.1.9",
    latest_version: "9.9.9",
  });
  const whileRestarting = await apiFetch(server, "/v1/models");
  assert.equal(whileRestarting.status, 503);
  assert.equal(
    ((await whileRestarting.json()) as { error: { code: string } }).error.code,
    "bridge_updating",
  );
  await waitFor(() => shutdownRequests === 1, "update shutdown handoff");
});

test("uses the legacy Responses adapter until the extension advertises native support", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-legacy-responses-test-"),
  );
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory, requestTimeoutMs: 2_000 },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(
    server,
    EXTENSION_ORIGIN,
    EXTENSION_ID,
    "val-test",
    false,
  );
  await extension.pair();
  await extension.connect();

  t.after(async () => {
    extension.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const client = new OpenAI({
    apiKey: server.secrets.get().clientApiKey,
    baseURL: `${server.baseUrl}/v1`,
  });
  const stored = await client.responses.create({
    model: "val-test",
    input: "LEGACY_STORE",
    store: true,
  });
  const continued = await client.responses.create({
    model: "val-test",
    input: "CONTINUE",
    previous_response_id: stored.id,
  });

  assert.equal(stored.output_text, "bridge-ok");
  assert.equal(continued.output_text, "continued-ok");
  assert.equal(extension.responsesRequests.length, 0);
  assert.deepEqual(extension.relayRequests.at(-1)?.persistence, {
    mode: "stored",
    chatId: "val-chat-1",
    appendToExisting: true,
  });
});

test("native Responses can outlive the chat timeout and still cancel on disconnect", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-native-timeout-test-"),
  );
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      requestTimeoutMs: 40,
      responseTimeoutMs: 0,
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

  const controller = new AbortController();
  let settled = false;
  const requestOutcome = apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "HOLD_NATIVE",
    }),
    signal: controller.signal,
  }).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  void requestOutcome.then(() => {
    settled = true;
  });

  await waitFor(
    () => extension.heldRequestIds.length === 1,
    "held native Responses request",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false);

  controller.abort();
  const result = await requestOutcome;
  assert.ok("error" in result);
  await waitFor(
    () => extension.cancelledRequestIds.length === 1,
    "native Responses cancellation",
  );
});

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
  assert.equal(extension.clientApiKey, apiKey);
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

  const continuedResponse = await client.responses.create({
    model: "val-test",
    input: "CONTINUE",
    previous_response_id: storedResponse.id,
  });
  assert.equal(continuedResponse.status, "completed");
  const continuationRequest = extension.responsesRequests.find((request) =>
    JSON.stringify(request.body).includes("CONTINUE"),
  );
  assert.equal(
    continuationRequest?.body.previous_response_id,
    storedResponse.id,
  );
  assert.equal(continuationRequest?.body.store, true);

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
  assert.ok(
    extension.responsesRequests.some((req) => {
      const body = req.body as Record<string, unknown>;
      const reasoning = body.reasoning as Record<string, unknown>;
      return reasoning?.effort === "high" && reasoning?.summary === "detailed";
    }),
  );
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

  const hiddenReasoningResponse = await apiFetch(
    server,
    "/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "val-test",
        messages: [
          {
            role: "user",
            content: "HIDDEN_REASONING_PRIVATE_PROMPT",
          },
        ],
        reasoning_effort: "max",
        reasoning_summary: "detailed",
      }),
    },
  );
  assert.equal(hiddenReasoningResponse.status, 200);
  assert.equal(
    hiddenReasoningResponse.headers.get("x-val-reasoning-status"),
    "hidden",
  );
  assert.equal(
    hiddenReasoningResponse.headers.get("x-val-reasoning-tokens"),
    "6",
  );
  const hiddenReasoningBody = (await hiddenReasoningResponse.json()) as {
    val_reasoning?: Record<string, unknown>;
  };
  assert.deepEqual(hiddenReasoningBody.val_reasoning, {
    status: "hidden",
    reasoning_tokens: 6,
    tokens_reported: true,
    summary_available: false,
    requested_effort: "max",
    requested_summary: "detailed",
  });
  assert.equal(
    extension.relayRequests.at(-1)?.parameters?.reasoning_summary,
    "detailed",
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

  const incompleteResponse = await apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "NATIVE_INCOMPLETE",
      stream: true,
    }),
  });
  assert.equal(incompleteResponse.status, 200);
  const incompleteText = await incompleteResponse.text();
  assert.match(incompleteText, /"code":"invalid_upstream_response"/);

  const invalidEventResponse = await apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "INVALID_NATIVE_EVENT",
      stream: true,
    }),
  });
  assert.equal(invalidEventResponse.status, 200);
  const invalidEventText = await invalidEventResponse.text();
  assert.match(invalidEventText, /"code":"invalid_bridge_event"/);

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
  ) as {
    mappings: Array<{ responseId: string; nativeResponseId: string }>;
  };
  assert.ok(
    mappings.mappings.some(
      (mapping) =>
        mapping.responseId === storedResponse.id &&
        typeof mapping.nativeResponseId === "string",
    ),
  );
  assert.ok(
    mappings.mappings.some(
      (mapping) => mapping.responseId === continuedResponse.id,
    ),
  );
  assert.ok(
    !mappings.mappings.some(
      (mapping) => mapping.responseId === reasonedResponse.id,
    ),
  );
  assert.ok(!JSON.stringify(mappings).includes("STORE_THIS"));
  assert.ok(!JSON.stringify(mappings).includes("CONTINUE"));

  await waitFor(async () => {
    try {
      const log = await readFile(server.diagnostics.path, "utf8");
      return log.includes('"reasoning_status":"hidden"');
    } catch {
      return false;
    }
  }, "sanitized diagnostics");
  const diagnostics = await readFile(server.diagnostics.path, "utf8");
  assert.match(diagnostics, /"event":"generation"/);
  assert.match(diagnostics, /"endpoint":"responses"/);
  assert.match(diagnostics, /"requested_reasoning_effort":"max"/);
  assert.ok(!diagnostics.includes("HIDDEN_REASONING_PRIVATE_PROMPT"));
  assert.ok(!diagnostics.includes("private-answer"));
  assert.ok(!diagnostics.includes("Inspect the constraints first."));
  assert.ok(!diagnostics.includes(apiKey));
  assert.ok(!diagnostics.includes(extension.bridgeSecret));
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

  const missingOrigin = await fetch(`${server.baseUrl}/bridge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: server.pairingCode,
      extensionId: EXTENSION_ID,
      protocolVersion: PROTOCOL_VERSION,
    }),
  });
  assert.equal(missingOrigin.status, 400);
  assert.equal(
    ((await missingOrigin.json()) as { error: { code: string } }).error.code,
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
