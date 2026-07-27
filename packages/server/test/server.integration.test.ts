import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionToServerMessage,
  RelayCompletionRequest,
  RelayOpenAIHttpRequest,
  RelayResponsesRequest,
  ServerToExtensionMessage,
  UsageStatsSnapshot,
} from "@val-bridge/protocol";
import { PROTOCOL_VERSION } from "@val-bridge/protocol";
import OpenAI, { toFile } from "openai";
import { zodFunction, zodTextFormat } from "openai/helpers/zod";
import WebSocket from "ws";
import { z } from "zod";
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
  readonly httpRequests: RelayOpenAIHttpRequest[] = [];
  readonly cancelledRequestIds: string[] = [];
  readonly heldRequestIds: string[] = [];
  authenticatedUsageStats?: UsageStatsSnapshot;
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

  sendUsageStats(stats: UsageStatsSnapshot) {
    this.send({ type: "bridge.usage", stats });
  }

  private handleMessage(message: ServerToExtensionMessage) {
    if (message.type === "bridge.authenticated") {
      this.clientApiKey = message.clientApiKey;
      this.authenticatedUsageStats = message.usageStats;
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
    if (message.request.kind === "openai.http") {
      this.httpRequests.push(message.request);
      this.handleHttpRequest(message.id, message.request);
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
      if (requestText.includes("REFRESH_REASONING_TIMEOUT")) {
        this.send({
          type: "relay.accepted",
          id: message.id,
          accepted: {},
        });
        const nativeId = `resp_native_${++this.chatCounter}`;
        for (const [index, delay] of [40, 90, 140].entries()) {
          setTimeout(() => {
            this.send({
              type: "relay.event",
              id: message.id,
              event: {
                kind: "sse",
                eventType:
                  index === 0
                    ? "message"
                    : "response.reasoning_summary_text.delta",
                data: {
                  type: "response.reasoning_summary_text.delta",
                  item_id: "rs_timeout_refresh",
                  output_index: 0,
                  summary_index: 0,
                  delta: `reasoning-${index + 1}`,
                  sequence_number: index,
                },
              },
            });
          }, delay);
        }
        setTimeout(() => {
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
                output: [],
              },
            },
          });
          this.send({ type: "relay.done", id: message.id, result: {} });
        }, 180);
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
      this.send({
        type: "relay.event",
        id: message.id,
        event: {
          kind: "sse",
          eventType: "response.content_part.added",
          data: {
            type: "response.content_part.added",
            item_id: "msg_testoutput",
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: [],
              logprobs: [],
            },
            sequence_number: 3,
          },
        },
      });
      const isStream =
        requestText.includes("RESPONSES_STREAM") ||
        (!requestText.includes("STORE_THIS") &&
          !requestText.includes("CONTINUE"));
      const responseContent = requestText.includes("CONTINUE")
        ? "continued-ok"
        : requestText.includes("SDK_PARSE")
          ? '{"answer":"parsed-ok"}'
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
              sequence_number: 4,
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
              sequence_number: 5,
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
            response: {
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
            sequence_number: 6,
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
    if (requestText.includes("REFRESH_CHAT_REASONING_TIMEOUT")) {
      for (const [index, delay] of [40, 90, 140].entries()) {
        setTimeout(() => {
          this.send({
            type: "relay.event",
            id: message.id,
            event: {
              kind: "openai",
              data: {
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: `reasoning-${index + 1}` },
                    finish_reason: null,
                  },
                ],
              },
            },
          });
        }, delay);
      }
      setTimeout(() => {
        this.send({
          type: "relay.event",
          id: message.id,
          event: { kind: "delta", content: "chat-timeout-refreshed" },
        });
        this.send({
          type: "relay.done",
          id: message.id,
          result: {
            ...(chatId ? { chatId } : {}),
            content: "chat-timeout-refreshed",
          },
        });
      }, 180);
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
    if (
      requestText.includes("CALL_TOOL") ||
      (requestText.includes("SDK_RUN_TOOL") &&
        !requestText.includes('"role":"tool"'))
    ) {
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

  private handleHttpRequest(
    requestId: string,
    request: RelayOpenAIHttpRequest,
  ) {
    const body = request.body
      ? Buffer.from(request.body.data, request.body.encoding)
      : Buffer.alloc(0);
    const respond = (
      status: number,
      value: unknown,
      headers: Record<string, string> = {},
    ) => {
      const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(
            typeof value === "string" ? value : JSON.stringify(value),
            "utf8",
          );
      this.send({
        type: "relay.event",
        id: requestId,
        event: {
          kind: "http.response",
          status,
          headers: {
            "content-type": Buffer.isBuffer(value)
              ? "application/octet-stream"
              : "application/json",
            "x-request-id": `req_${requestId}`,
            ...headers,
          },
        },
      });
      const midpoint = Math.max(1, Math.floor(bytes.length / 2));
      for (const chunk of [
        bytes.subarray(0, midpoint),
        bytes.subarray(midpoint),
      ]) {
        if (chunk.length === 0) continue;
        this.send({
          type: "relay.event",
          id: requestId,
          event: {
            kind: "http.chunk",
            encoding: "base64",
            data: chunk.toString("base64"),
          },
        });
      }
      this.send({ type: "relay.done", id: requestId, result: {} });
    };
    const error = (status: number, code: string, message: string) =>
      respond(status, {
        error: {
          code,
          message,
          param: null,
          type: "invalid_request_error",
        },
      });
    const responseObject = (
      id: string,
      status: "queued" | "completed" | "cancelled",
      outputText = "",
    ) => ({
      id,
      object: "response",
      created_at: 1_700_000_000,
      status,
      background: true,
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      max_tool_calls: null,
      model: this.modelId,
      output:
        status === "completed"
          ? [
              {
                id: "msg_background",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: outputText,
                    annotations: [],
                    logprobs: [],
                  },
                ],
              },
            ]
          : [],
      parallel_tool_calls: true,
      previous_response_id: null,
      prompt_cache_key: null,
      prompt_cache_retention: null,
      reasoning: { effort: null, summary: null },
      safety_identifier: null,
      service_tier: "default",
      store: true,
      temperature: 1,
      text: { format: { type: "text" }, verbosity: "medium" },
      tool_choice: "auto",
      tools: [],
      top_logprobs: 0,
      top_p: 1,
      truncation: "disabled",
      usage:
        status === "completed"
          ? {
              input_tokens: 12,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 1 },
              total_tokens: 16,
            }
          : null,
      metadata: {},
    });

    this.send({
      type: "relay.accepted",
      id: requestId,
      accepted: {},
    });

    if (request.method === "GET" && request.path === "/v1/models/val-test") {
      respond(
        200,
        {
          id: this.modelId,
          object: "model",
          created: 1_700_000_000,
          owned_by: "rmit-val",
        },
        {
          "retry-after-ms": "250",
          "x-should-retry": "false",
        },
      );
      return;
    }
    if (request.method === "GET" && request.path === "/v1/batches/hold") {
      this.heldRequestIds.push(requestId);
      return;
    }
    if (request.method === "POST" && request.path === "/v1/chat/completions") {
      const parsed = JSON.parse(body.toString("utf8")) as {
        model?: string;
        messages?: unknown;
        tools?: Array<{ type?: string }>;
      };
      assert.equal(parsed.model, this.modelId);
      if (!JSON.stringify(parsed.messages).includes("NULLABLE_CHAT_V6")) {
        assert.equal(parsed.tools?.[0]?.type, "custom");
      }
      respond(200, {
        id: "chatcmpl_native_v6",
        object: "chat.completion",
        created: 1_700_000_000,
        model: this.modelId,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: "native-chat-ok",
              refusal: null,
              annotations: [],
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
        },
      });
      return;
    }
    if (request.method === "POST" && request.path === "/v1/responses") {
      const parsed = JSON.parse(body.toString("utf8")) as {
        background?: boolean;
        input?: string;
        prompt?: { id?: string };
      };
      if (parsed.background === true) {
        respond(200, responseObject("resp_background", "queued"));
      } else if (parsed.input === "NULLABLE_V6") {
        respond(
          200,
          responseObject("resp_nullable", "completed", "nullable-ok"),
        );
      } else {
        assert.equal(parsed.prompt?.id, "pmpt_sdk_v6");
        respond(200, responseObject("resp_prompt", "completed", "prompt-ok"));
      }
      return;
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/responses/resp_background" &&
      request.query?.includes("stream=true")
    ) {
      const completed = responseObject(
        "resp_background",
        "completed",
        "background-ok",
      );
      respond(
        200,
        [
          "event: response.completed",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: completed,
            sequence_number: 0,
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/responses/resp_background"
    ) {
      respond(
        200,
        responseObject("resp_background", "completed", "background-ok"),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/responses/resp_background/cancel"
    ) {
      respond(200, responseObject("resp_background", "cancelled"));
      return;
    }
    if (
      request.method === "DELETE" &&
      request.path === "/v1/responses/resp_background"
    ) {
      respond(200, {
        id: "resp_background",
        object: "response.deleted",
        deleted: true,
      });
      return;
    }
    if (
      request.method === "POST" &&
      request.path === "/v1/responses/input_tokens"
    ) {
      respond(200, { object: "response.input_tokens", input_tokens: 42 });
      return;
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/responses/resp_background/input_items"
    ) {
      respond(200, {
        object: "list",
        data: [
          {
            id: "msg_input",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "background" }],
          },
        ],
        first_id: "msg_input",
        last_id: "msg_input",
        has_more: false,
      });
      return;
    }
    if (request.method === "POST" && request.path === "/v1/responses/compact") {
      respond(200, {
        id: "resp_compacted",
        object: "response.compaction",
        created_at: 1_700_000_000,
        output: [
          {
            id: "cmp_test",
            type: "compaction",
            encrypted_content: "encrypted-compaction-state",
          },
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      });
      return;
    }
    if (request.method === "POST" && request.path === "/v1/files") {
      assert.match(
        request.headers["content-type"] ?? "",
        /^multipart\/form-data;\s*boundary=/i,
      );
      assert.match(body.toString("utf8"), /filename="sample\.txt"/);
      assert.match(body.toString("utf8"), /hello from sdk v6/);
      respond(200, {
        id: "file_123",
        object: "file",
        bytes: 17,
        created_at: 1_700_000_000,
        filename: "sample.txt",
        purpose: "assistants",
        status: "processed",
        status_details: null,
      });
      return;
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/files/file_123/content"
    ) {
      respond(200, Buffer.from([0x66, 0x69, 0x6c, 0x65, 0x00, 0xff]), {
        "content-disposition": 'attachment; filename="sample.bin"',
      });
      return;
    }
    if (request.method === "GET" && request.path === "/v1/files/file_123") {
      respond(200, {
        id: "file_123",
        object: "file",
        bytes: 17,
        created_at: 1_700_000_000,
        filename: "sample.txt",
        purpose: "assistants",
        status: "processed",
        status_details: null,
      });
      return;
    }
    if (request.method === "GET" && request.path === "/v1/files") {
      respond(200, {
        object: "list",
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
      });
      return;
    }
    if (request.method === "DELETE" && request.path === "/v1/files/file_123") {
      respond(200, { id: "file_123", object: "file", deleted: true });
      return;
    }

    error(
      404,
      "unsupported_feature",
      `${request.method} ${request.path} is not available in this test Val.`,
    );
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

test("extension security controls rotate keys, reset usage, and persist network scope", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-security-controls-test-"),
  );
  let server = await ValBridgeServer.create({
    config: { host: "0.0.0.0", port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(server);
  await extension.pair();
  await extension.connect();
  let closed = false;

  t.after(async () => {
    extension.close();
    if (!closed) await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  const initialHealth = (await (
    await fetch(`${server.baseUrl}/healthz`)
  ).json()) as Record<string, unknown>;
  assert.equal(initialHealth.network_scope, "lan");
  assert.equal(initialHealth.client_ip_allowlist, false);

  const previousKey = server.secrets.get().clientApiKey;
  const rotatedResponse = await extensionControlFetch(
    server,
    extension,
    "/bridge/security/rotate-client-key",
    { method: "POST" },
  );
  assert.equal(rotatedResponse.status, 200);
  const rotated = (await rotatedResponse.json()) as {
    rotated: boolean;
    client_api_key: string;
  };
  assert.equal(rotated.rotated, true);
  assert.match(rotated.client_api_key, /^val-local-/);
  assert.notEqual(rotated.client_api_key, previousKey);

  const oldKeyResponse = await fetch(`${server.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${previousKey}` },
  });
  assert.equal(oldKeyResponse.status, 401);
  assert.equal((await apiFetch(server, "/v1/models")).status, 200);

  const stats: UsageStatsSnapshot = {
    startedAt: 100,
    lastUpdatedAt: 200,
    requests: 1,
    completedRequests: 1,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
    reasoningMeteredRequests: 1,
    reasoningSummaryRequests: 1,
    hiddenReasoningRequests: 0,
    pricedRequests: 1,
    estimatedOpenAICostNanodollars: 1_000,
  };
  extension.sendUsageStats(stats);
  await waitFor(
    () => server.usageStats.snapshot()?.totalTokens === 15,
    "usage before reset",
  );
  const resetResponse = await extensionControlFetch(
    server,
    extension,
    "/bridge/usage/reset",
    { method: "POST" },
  );
  assert.equal(resetResponse.status, 200);
  const reset = (await resetResponse.json()) as {
    reset: boolean;
    stats: UsageStatsSnapshot;
  };
  assert.equal(reset.reset, true);
  assert.equal(reset.stats.totalTokens, 0);
  assert.equal(server.usageStats.snapshot()?.requests, 0);

  const scopeResponse = await extensionControlFetch(
    server,
    extension,
    "/bridge/network-scope",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "loopback" }),
    },
  );
  assert.equal(scopeResponse.status, 200);
  assert.deepEqual(await scopeResponse.json(), {
    accepted: true,
    network_scope: "loopback",
    restart_required: true,
    restart_scheduled: false,
  });

  extension.close();
  await server.close();
  closed = true;
  server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  closed = false;
  assert.equal(server.config.host, "127.0.0.1");
  assert.equal(server.secrets.get().clientApiKey, rotated.client_api_key);
  assert.equal(server.usageStats.snapshot()?.requests, 0);
  assert.equal(typeof server.usageStats.snapshot()?.resetAt, "number");
  const restoredHealth = (await (
    await fetch(`${server.baseUrl}/healthz`)
  ).json()) as Record<string, unknown>;
  assert.equal(restoredHealth.network_scope, "loopback");
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

test("reasoning chunks refresh the configured relay timeout", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-reasoning-timeout-test-"),
  );
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      requestTimeoutMs: 500,
      responseTimeoutMs: 80,
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

  const refreshed = await apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "REFRESH_REASONING_TIMEOUT",
    }),
  });
  assert.equal(refreshed.status, 200);
  assert.equal(
    ((await refreshed.json()) as Record<string, unknown>).status,
    "completed",
  );

  const chatRefreshed = await apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "REFRESH_CHAT_REASONING_TIMEOUT" }],
    }),
  });
  assert.equal(chatRefreshed.status, 200);
  assert.equal(
    (
      (await chatRefreshed.json()) as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "chat-timeout-refreshed",
  );

  const silent = await apiFetch(server, "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      input: "HOLD_NATIVE",
    }),
  });
  assert.equal(silent.status, 504);
  assert.equal(
    ((await silent.json()) as { error: { code: string } }).error.code,
    "upstream_timeout",
  );
  await waitFor(
    () => extension.cancelledRequestIds.length === 1,
    "silent native Responses timeout cancellation",
  );
});

test("companion contract works through the official OpenAI JavaScript SDK", async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), "val-bridge-test-"));
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      requestTimeoutMs: 2_000,
      corsOrigins: new Set(["https://sdk-client.example"]),
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
  assert.deepEqual(health.openai_sdk, {
    major: 6,
    http_passthrough: true,
    websocket_passthrough: false,
    body_limit_bytes: 10 * 1024 * 1024,
  });

  const sdkPreflight = await fetch(`${server.baseUrl}/v1/files/file_123`, {
    method: "OPTIONS",
    headers: {
      origin: "https://sdk-client.example",
      "access-control-request-method": "DELETE",
      "access-control-request-headers":
        "authorization, content-type, x-stainless-helper-method",
    },
  });
  assert.equal(sdkPreflight.status, 204);
  assert.match(
    sdkPreflight.headers.get("access-control-allow-methods") ?? "",
    /DELETE/,
  );
  assert.match(
    sdkPreflight.headers.get("access-control-allow-headers") ?? "",
    /x-stainless-helper-method/,
  );
  assert.match(
    sdkPreflight.headers.get("access-control-expose-headers") ?? "",
    /x-request-id/,
  );
  assert.match(
    sdkPreflight.headers.get("access-control-expose-headers") ?? "",
    /retry-after-ms/,
  );
  assert.match(
    sdkPreflight.headers.get("access-control-expose-headers") ?? "",
    /x-should-retry/,
  );

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

  const customToolCompletion = await client.chat.completions.create({
    model: "val-test",
    messages: [{ role: "user", content: "Use the custom grammar tool." }],
    tools: [
      {
        type: "custom",
        custom: {
          name: "code",
          description: "Return a code fragment.",
          format: { type: "text" },
        },
      },
    ],
  });
  assert.equal(
    customToolCompletion.choices[0]?.message.content,
    "native-chat-ok",
  );
  assert.ok(
    extension.httpRequests.some(
      (request) =>
        request.method === "POST" && request.path === "/v1/chat/completions",
    ),
  );

  const nullableChatCompletion = await client.chat.completions.create({
    model: "val-test",
    messages: [{ role: "user", content: "NULLABLE_CHAT_V6" }],
    n: null,
    store: null,
  });
  assert.equal(
    nullableChatCompletion.choices[0]?.message.content,
    "native-chat-ok",
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

  const v6Response = await client.responses.create(
    {
      model: "val-test",
      input: "SDK_V6_FIELDS",
      include: ["reasoning.encrypted_content"],
      context_management: [{ type: "compaction", compact_threshold: 900_000 }],
      prompt_cache_key: "sdk-v6-fields",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      reasoning: {
        context: "all_turns",
        effort: "max",
        mode: "pro",
        summary: "auto",
      },
      safety_identifier: "hashed-test-user",
      text: { format: { type: "text" }, verbosity: "high" },
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value.",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
          strict: true,
          allowed_callers: ["direct", "programmatic"],
        },
        {
          type: "apply_patch",
          allowed_callers: ["direct", "programmatic"],
        },
      ],
      tool_choice: "auto",
    },
    { headers: { "OpenAI-Beta": "responses_multi_agent=v1" } },
  );
  assert.equal(v6Response.status, "completed");
  const v6Relay = extension.responsesRequests.find((request) =>
    JSON.stringify(request.body).includes("SDK_V6_FIELDS"),
  );
  assert.deepEqual(v6Relay?.body.reasoning, {
    context: "all_turns",
    effort: "max",
    mode: "pro",
    summary: "auto",
  });
  assert.deepEqual(v6Relay?.body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(v6Relay?.body.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assert.equal(v6Relay?.body.text?.verbosity, "high");
  assert.equal(v6Relay?.headers?.["openai-beta"], "responses_multi_agent=v1");
  assert.equal(v6Relay?.headers?.authorization, undefined);

  const parsedResponse = await client.responses.parse({
    model: "val-test",
    input: "SDK_PARSE",
    text: {
      format: zodTextFormat(z.object({ answer: z.string() }), "bridge_answer"),
    },
  });
  assert.deepEqual(parsedResponse.output_parsed, { answer: "parsed-ok" });

  const responseRunner = client.responses.stream({
    model: "val-test",
    input: "RESPONSES_STREAM_HELPER",
  });
  const helperEvents: string[] = [];
  for await (const event of responseRunner) helperEvents.push(event.type);
  const helperFinal = await responseRunner.finalResponse();
  assert.equal(helperFinal.output_text, "bridge-ok");
  assert.equal(helperEvents.at(-1), "response.completed");

  let toolRunnerCity = "";
  const toolRunner = client.chat.completions.runTools({
    model: "val-test",
    messages: [{ role: "user", content: "SDK_RUN_TOOL" }],
    tools: [
      zodFunction({
        name: "get_weather",
        description: "Return the weather for a city.",
        parameters: z.object({ city: z.string() }),
        function: ({ city }) => {
          toolRunnerCity = city;
          return { temperature: 20 };
        },
      }),
    ],
  });
  assert.equal(await toolRunner.finalContent(), "bridge-ok");
  assert.equal(toolRunnerCity, "Melbourne");

  const promptResponse = await client.responses.create({
    prompt: { id: "pmpt_sdk_v6", variables: { topic: "bridges" } },
  });
  assert.equal(promptResponse.output_text, "prompt-ok");
  assert.ok(
    extension.httpRequests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/v1/responses" &&
        Buffer.from(request.body?.data ?? "", "base64")
          .toString("utf8")
          .includes("pmpt_sdk_v6"),
    ),
  );

  const nullableResponse = await client.responses.create({
    model: "val-test",
    input: "NULLABLE_V6",
    instructions: null,
    max_output_tokens: null,
    store: null,
  });
  assert.equal(nullableResponse.output_text, "nullable-ok");

  const {
    data: retrievedModel,
    response: retrievedModelResponse,
    request_id: retrievedModelRequestId,
  } = await client.models.retrieve("val-test").withResponse();
  assert.equal(retrievedModel.id, "val-test");
  assert.match(retrievedModelRequestId ?? "", /^req_/);
  assert.equal(
    (retrievedModel as { _request_id?: string })._request_id,
    retrievedModelRequestId,
  );
  assert.equal(retrievedModelResponse.headers.get("retry-after-ms"), "250");
  assert.equal(retrievedModelResponse.headers.get("x-should-retry"), "false");

  const backgroundResponse = await client.responses.create({
    model: "val-test",
    input: "BACKGROUND_V6",
    background: true,
    store: true,
  });
  assert.equal(backgroundResponse.id, "resp_background");
  assert.equal(backgroundResponse.status, "queued");

  const retrievedResponse = await client.responses.retrieve(
    backgroundResponse.id,
  );
  assert.equal(retrievedResponse.status, "completed");
  assert.equal(retrievedResponse.output_text, "background-ok");

  const retrievedResponseStream = await client.responses.retrieve(
    backgroundResponse.id,
    { stream: true },
  );
  const retrievedEventTypes: string[] = [];
  for await (const event of retrievedResponseStream) {
    retrievedEventTypes.push(event.type);
  }
  assert.deepEqual(retrievedEventTypes, ["response.completed"]);

  const inputItems = await client.responses.inputItems.list(
    backgroundResponse.id,
    { order: "asc" },
  );
  assert.equal(inputItems.data[0]?.type, "message");

  const inputTokens = await client.responses.inputTokens.count({
    model: "val-test",
    input: "count these tokens",
  });
  assert.equal(inputTokens.input_tokens, 42);

  const compacted = await client.responses.compact({
    model: "val-test",
    input: "compact this conversation",
    prompt_cache_key: "sdk-v6-contract",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  });
  assert.equal(compacted.object, "response.compaction");
  assert.equal(compacted.output.at(-1)?.type, "compaction");

  const cancelledResponse = await client.responses.cancel(
    backgroundResponse.id,
  );
  assert.equal(cancelledResponse.status, "cancelled");
  await client.responses.delete(backgroundResponse.id);

  const uploaded = await client.files.create({
    file: await toFile(Buffer.from("hello from sdk v6", "utf8"), "sample.txt"),
    purpose: "assistants",
  });
  assert.equal(uploaded.id, "file_123");
  assert.equal(
    (await client.files.retrieve(uploaded.id)).filename,
    "sample.txt",
  );
  assert.equal((await client.files.list()).data.length, 0);
  const fileContent = await client.files.content(uploaded.id);
  assert.deepEqual(
    Buffer.from(await fileContent.arrayBuffer()),
    Buffer.from([0x66, 0x69, 0x6c, 0x65, 0x00, 0xff]),
  );
  assert.equal((await client.files.delete(uploaded.id)).deleted, true);

  const genericAbort = new AbortController();
  const heldBatch = client.batches.retrieve("hold", {
    signal: genericAbort.signal,
  });
  await waitFor(
    () =>
      extension.httpRequests.some(
        (request) =>
          request.method === "GET" && request.path === "/v1/batches/hold",
      ),
    "generic SDK request acceptance",
  );
  genericAbort.abort();
  await assert.rejects(heldBatch, /aborted/i);
  await waitFor(
    () => extension.cancelledRequestIds.length > 0,
    "generic SDK request cancellation",
  );

  const relayedBackgroundRequest = extension.httpRequests.find(
    (request) => request.method === "POST" && request.path === "/v1/responses",
  );
  assert.ok(relayedBackgroundRequest);
  assert.equal(
    relayedBackgroundRequest.headers.authorization,
    undefined,
    "the local client API key must never be forwarded to Val",
  );
  assert.ok(
    extension.httpRequests.some(
      (request) =>
        request.path === "/v1/responses/resp_background" &&
        request.query?.includes("stream=true"),
    ),
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
  assert.equal(unsupported.status, 404);
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

test("persists sanitized extension usage and restores it on authentication", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-usage-sync-test-"),
  );
  const server = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await server.listen();
  const extension = new FakeValExtension(server);
  await extension.pair();
  await extension.connect();

  let reopened: ValBridgeServer | undefined;
  let restoredExtension: FakeValExtension | undefined;
  t.after(async () => {
    extension.close();
    restoredExtension?.close();
    await reopened?.close();
    await server.close();
    await rm(configDirectory, { recursive: true, force: true });
  });

  assert.equal(extension.authenticatedUsageStats, undefined);
  const stats: UsageStatsSnapshot = {
    startedAt: 100,
    lastUpdatedAt: 200,
    requests: 2,
    completedRequests: 2,
    failedRequests: 0,
    cancelledRequests: 0,
    meteredRequests: 2,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    reasoningTokens: 3,
    reasoningMeteredRequests: 2,
    reasoningSummaryRequests: 1,
    hiddenReasoningRequests: 1,
    pricedRequests: 2,
    estimatedOpenAICostNanodollars: 1_000,
    lastRequestTokens: 8,
    lastReasoningTokens: 2,
    lastReasoningTokensReported: true,
    lastReasoningStatus: "summary",
  };
  extension.sendUsageStats(stats);
  await waitFor(
    () => server.usageStats.snapshot()?.totalTokens === 15,
    "usage statistics persistence",
  );
  await server.usageStats.flush();

  const persisted = await readFile(
    join(configDirectory, "usage-stats.json"),
    "utf8",
  );
  assert.ok(!persisted.includes("messages"));
  assert.ok(!persisted.includes("model"));

  reopened = await ValBridgeServer.create({
    config: { port: 0, configDirectory },
    quiet: true,
  });
  await reopened.listen();
  restoredExtension = new FakeValExtension(reopened);
  restoredExtension.bridgeSecret = reopened.secrets.get().bridgeSecret;
  await restoredExtension.connect();
  assert.deepEqual(restoredExtension.authenticatedUsageStats, stats);
});

test("limits concurrency, cancels interrupted streams, and reports disconnection", async (t) => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "val-bridge-flow-test-"),
  );
  const server = await ValBridgeServer.create({
    config: {
      port: 0,
      configDirectory,
      maxConcurrency: 16,
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

  const pendingResponses = Array.from({ length: 16 }, (_, index) =>
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
    () => extension.heldRequestIds.length === 16,
    "16 concurrent requests",
  );

  const limited = await apiFetch(server, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "val-test",
      messages: [{ role: "user", content: "seventeenth" }],
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
