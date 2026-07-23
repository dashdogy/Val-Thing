import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIHttpError } from "../src/errors.js";
import {
  chatRequestToRelay,
  parseChatCompletion,
  parseResponse,
  responseRequestToRelay,
} from "../src/openai-schema.js";

test("validates and translates Chat Completions fields without dropping compatible options", () => {
  const body = parseChatCompletion({
    model: "val-model",
    messages: [
      { role: "system", content: "Be concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "low" },
          },
        ],
      },
    ],
    temperature: 0.3,
    top_p: 0.8,
    stop: ["END"],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object" },
      },
    },
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
    tool_choice: "auto",
  });

  const relay = chatRequestToRelay(body, { mode: "temporary" });
  assert.equal(relay.model, "val-model");
  assert.deepEqual(relay.parameters, {
    temperature: 0.3,
    top_p: 0.8,
    stop: ["END"],
  });
  assert.equal(relay.tools?.[0]?.function.name, "lookup");
  assert.equal(relay.persistence.mode, "temporary");
  assert.equal((relay.responseFormat as { type?: string }).type, "json_schema");
});

test("returns OpenAI-shaped validation errors for unsupported modalities and content", () => {
  assert.throws(
    () =>
      parseChatCompletion({
        model: "val-model",
        messages: [{ role: "user", content: "hello" }],
        modalities: ["text", "audio"],
      }),
    (error: unknown) =>
      error instanceof OpenAIHttpError &&
      error.code === "unsupported_feature" &&
      error.param === "modalities",
  );

  assert.throws(
    () =>
      parseChatCompletion({
        model: "val-model",
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: "..." } }],
          },
        ],
      }),
    (error: unknown) =>
      error instanceof OpenAIHttpError && error.code === "unsupported_feature",
  );

  assert.throws(
    () =>
      parseChatCompletion({
        model: "val-model",
        messages: [{ role: "user", content: "hello" }],
        n: 2,
      }),
    (error: unknown) =>
      error instanceof OpenAIHttpError &&
      error.code === "unsupported_feature" &&
      error.param === "n",
  );
});

test("translates Responses instructions, messages, calls, and call outputs", () => {
  const body = parseResponse({
    model: "val-model",
    instructions: "Follow the tool contract.",
    store: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Find the room." },
          {
            type: "input_image",
            image_url: "https://example.test/map.png",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "room_lookup",
        arguments: '{"building":"80"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"room":"80.04.01"}',
      },
    ],
    tools: [
      {
        type: "function",
        name: "room_lookup",
        parameters: {
          type: "object",
          properties: { building: { type: "string" } },
        },
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "room",
        schema: { type: "object" },
      },
    },
    max_output_tokens: 120,
    reasoning: { effort: "high" },
  });

  const relay = responseRequestToRelay(body, {
    mode: "stored",
    chatId: "val-chat-1",
    appendToExisting: true,
  });
  assert.deepEqual(
    relay.messages.map((message) => message.role),
    ["developer", "user", "assistant", "tool"],
  );
  assert.equal(
    relay.messages[2]?.tool_calls?.[0]?.function.name,
    "room_lookup",
  );
  assert.equal(relay.messages[3]?.tool_call_id, "call_1");
  assert.equal(relay.tools?.[0]?.function.name, "room_lookup");
  assert.equal(relay.parameters?.max_completion_tokens, 120);
  assert.equal(relay.parameters?.reasoning_effort, "high");
  assert.equal(relay.persistence.mode, "stored");
});

test("maps string Responses reasoning directly to Val reasoning effort", () => {
  const relay = responseRequestToRelay(
    parseResponse({
      model: "val-model",
      input: "Think briefly.",
      reasoning: "low",
    }),
    { mode: "temporary" },
  );

  assert.equal(relay.parameters?.reasoning_effort, "low");
  assert.equal("reasoning" in (relay.parameters ?? {}), false);
});

test("groups parallel Responses function calls before their tool outputs", () => {
  const relay = responseRequestToRelay(
    parseResponse({
      model: "val-model",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the repository." }],
        },
        {
          type: "reasoning",
          encrypted_content: "opaque-prior-reasoning",
        },
        {
          type: "function_call",
          call_id: "call_glob",
          name: "glob",
          arguments: '{"pattern":"**/*"}',
        },
        {
          type: "function_call",
          call_id: "call_read",
          name: "read",
          arguments: '{"filePath":"package.json"}',
        },
        {
          type: "function_call_output",
          call_id: "call_glob",
          output: "package.json",
        },
        {
          type: "function_call_output",
          call_id: "call_read",
          output: '{"name":"bridge"}',
        },
      ],
    }),
    { mode: "temporary" },
  );

  assert.deepEqual(
    relay.messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.deepEqual(
    relay.messages[1]?.tool_calls?.map((toolCall) => toolCall.id),
    ["call_glob", "call_read"],
  );
  assert.deepEqual(
    relay.messages.slice(2).map((message) => message.tool_call_id),
    ["call_glob", "call_read"],
  );
});

test("rejects Responses file IDs and non-function tools", () => {
  assert.throws(
    () =>
      responseRequestToRelay(
        parseResponse({
          model: "val-model",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", file_id: "file_123" }],
            },
          ],
        }),
        { mode: "temporary" },
      ),
    (error: unknown) =>
      error instanceof OpenAIHttpError && error.code === "unsupported_feature",
  );

  assert.throws(
    () =>
      responseRequestToRelay(
        parseResponse({
          model: "val-model",
          input: "hello",
          tools: [{ type: "web_search_preview" }],
        }),
        { mode: "temporary" },
      ),
    (error: unknown) =>
      error instanceof OpenAIHttpError && error.code === "unsupported_feature",
  );
});
