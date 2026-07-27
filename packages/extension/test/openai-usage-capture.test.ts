import assert from "node:assert/strict";
import test from "node:test";
import type { RelayOpenAIHttpRequest } from "@val-bridge/protocol";
import { bytesToBase64 } from "../src/openai-http-relay.js";
import {
  openAIHttpGeneration,
  OpenAIHttpUsageCapture,
} from "../src/openai-usage-capture.js";

const encoder = new TextEncoder();

function request(
  path: string,
  body: Record<string, unknown>,
  method: RelayOpenAIHttpRequest["method"] = "POST",
): RelayOpenAIHttpRequest {
  return {
    kind: "openai.http",
    method,
    path,
    body: {
      encoding: "base64",
      data: bytesToBase64(encoder.encode(JSON.stringify(body))),
    },
  };
}

test("identifies only token-generating Chat and Responses requests", () => {
  assert.deepEqual(
    openAIHttpGeneration(
      request("/v1/responses", {
        model: "openai-gpt-5.6-sol",
        stream: true,
      }),
    ),
    {
      model: "openai-gpt-5.6-sol",
      stream: true,
    },
  );
  assert.deepEqual(
    openAIHttpGeneration(request("/v1/chat/completions", { messages: [] })),
    { stream: false },
  );
  assert.equal(
    openAIHttpGeneration(request("/v1/embeddings", { model: "embedding" })),
    undefined,
  );
  assert.equal(
    openAIHttpGeneration(request("/v1/responses/resp_123", {}, "GET")),
    undefined,
  );
});

test("captures usage and reasoning disclosure from chunked Responses JSON", () => {
  const capture = new OpenAIHttpUsageCapture("application/json", 200);
  const bytes = encoder.encode(
    JSON.stringify({
      id: "resp_123",
      status: "completed",
      usage: {
        input_tokens: 18,
        output_tokens: 7,
        total_tokens: 25,
        output_tokens_details: { reasoning_tokens: 4 },
      },
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Checked constraints." }],
        },
      ],
    }),
  );
  capture.push(bytes.subarray(0, 13));
  capture.push(bytes.subarray(13, 71));
  capture.push(bytes.subarray(71));

  assert.deepEqual(capture.finish(), {
    usage: {
      input_tokens: 18,
      output_tokens: 7,
      total_tokens: 25,
      output_tokens_details: { reasoning_tokens: 4 },
    },
    reasoningSummaryAvailable: true,
    outcome: "completed",
  });
});

test("captures Chat streaming reasoning and terminal usage across boundaries", () => {
  const capture = new OpenAIHttpUsageCapture(
    "text/event-stream; charset=utf-8",
    200,
    true,
  );
  const stream = [
    'data: {"choices":[{"delta":{"reasoning_content":"Check ✓"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":5,"total_tokens":14,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const bytes = encoder.encode(stream);
  let offset = 0;
  for (const boundary of [1, 8, 31, 67, 111, bytes.length]) {
    capture.push(bytes.subarray(offset, boundary));
    offset = boundary;
  }

  assert.deepEqual(capture.finish(), {
    usage: {
      prompt_tokens: 9,
      completion_tokens: 5,
      total_tokens: 14,
      completion_tokens_details: { reasoning_tokens: 3 },
    },
    reasoningSummaryAvailable: true,
    outcome: "completed",
  });
});

test("recognizes upstream terminal failures without affecting relay parsing", () => {
  const capture = new OpenAIHttpUsageCapture("text/event-stream", 200, true);
  capture.push(
    encoder.encode(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    ),
  );
  assert.deepEqual(capture.finish(), {
    reasoningSummaryAvailable: false,
    outcome: "failed",
  });

  const malformed = new OpenAIHttpUsageCapture("application/json", 200);
  malformed.push(encoder.encode("{not json"));
  assert.deepEqual(malformed.finish(), {
    reasoningSummaryAvailable: false,
    outcome: "completed",
  });

  const rateLimited = new OpenAIHttpUsageCapture("application/json", 429);
  rateLimited.push(encoder.encode('{"error":{"message":"slow down"}}'));
  assert.deepEqual(rateLimited.finish(), {
    reasoningSummaryAvailable: false,
    outcome: "failed",
  });
});
